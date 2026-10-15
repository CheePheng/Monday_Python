import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PIPELINES } from "./fixtures/deal-pipelines";
import type { FieldSpec, ObjectSpec } from "../src/types";

/**
 * STALE_FORWARD_RETRY: SIBLING CELLS -- two monday cells that feed ONE HubSpot property (config/crm.ts, enumerated in
 * card-watch.ts siblingKeysOf):
 *   - Deals: the coarse Stage `deal_stage` (while STAGE_COARSE_REVERSE) and HubSpot Stage `dropdown_mm7624zd` both write
 *     `dealstage` -- and every stage push sends its `pipeline` with it (stagePipelinePairing), beside the Pipeline cell
 *     `dropdown_mm76s7kk`;
 *   - Accounts: the item name (nameReverse) and the Name column `text_mm6t1q4h` both write `name`.
 * The final verification's blocker (FV-D1, FV-DB1, FV-S1, replayed here through the real engine): a mark's retry of one
 * cell did not count this card's OWN newer push from the other cell as a later change of the property, sent the older
 * edit over it, and its push then wrote the other cell over on monday -- the newer edit lost on both sides. Now a sibling's
 * push is a later change by the time of the EDIT it carried (PushRec.a), a newer sibling edit still on its way defers the
 * older one, and the newest edit ends on both sides. FV-D2, FV-DB2 and FV-S2 (STALE_FORWARD_RETRY off, live) are the
 * controls: they end on the newer edit as before.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
const monday = vi.hoisted(() => ({
  createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), findItemIdsByColumn: vi.fn(),
  getBoardItems: vi.fn(), getItem: vi.fn(), getItemFresh: vi.fn(), getItemStates: vi.fn(), getItemsColumnText: vi.fn(),
  getLinkedCell: vi.fn(), getLinkedItemIds: vi.fn(), getParentItemId: vi.fn(), getSubitems: vi.fn(), getUserById: vi.fn(),
  getUsersByEmail: vi.fn(), gql: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(), updateColumns: vi.fn(), updateItem: vi.fn(),
  whoAmI: vi.fn(),
}));
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
  getOwners: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(), getRecordWithHistory: vi.fn(),
  getPropertyHistory: vi.fn(), patchRecord: vi.fn(), searchCompanyByDomain: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(), createNote: vi.fn(), getAssociatedIds: vi.fn(),
  getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(), putAssociation: vi.fn(),
  deleteAssociation: vi.fn(), getRecordsByIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({
  reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(), pushBirthAssociations: vi.fn(),
  reverseSubitemEdit: vi.fn(), convergeRelationCell: vi.fn(),
}));
vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", async (orig) => ({ ...(await orig<typeof import("../src/hubspot")>()), ...hubspot }));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/ensure-card", () => ({ ensureCardForRecord: vi.fn(), cardIdOf: vi.fn() }));

const W_ = await import("./fixtures/stale-forward-world");
const {
  ASK_ADA, REP, makeWorld, setWorld, installWorld, setEnv, as, live, clock, rep, cell, hold, reach, mondayEdit, mondayWebhook,
  settleAll, eventValue, advance, fireWatch, drain, watchState, logged, PASS,
} = W_;
const w = () => W_.w;
const pushes = () => W_.pushes(hubspot as never);
const trail = () => w().trail.join("\n");
const { specByObject } = await import("../src/config");
const { retryMarkedEdits } = await import("../src/sync");
const { crmStageDictsOf } = await import("../src/hubspot");
const { resetPairedEchoes } = await import("../src/relation-edit");
const { uiActorTiming } = await import("../src/ui-actor");

const DICTS = crmStageDictsOf(PIPELINES as never);
const COARSE = "deal_stage", EXACT = "dropdown_mm7624zd", PIPE = "dropdown_mm76s7kk";
const ENVC = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };
const field = (spec: ObjectSpec, hs: string): FieldSpec => spec.fields.find(f => f.hs === hs)!;
const S0 = "2026-07-18T12:46:01.914Z";
/** 2026-10-09 at `hh:mm:ss` or `hh:mm:ss.sss`, as ISO. */
const T = (hms: string) => `2026-10-09T${hms}${hms.includes(".") ? "" : ".000"}Z`;
const timing = { ...uiActorTiming };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(T("08:00:00"));
  vi.clearAllMocks();
  installWorld(monday as never, hubspot as never);
  resetPairedEchoes();
  Object.assign(uiActorTiming, { settleMs: 0, backoffMs: [0, 0] });
  setEnv({ STAGE_COARSE_REVERSE: "true" });
  hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
  assoc.syncAssociations.mockResolvedValue(undefined);
  assoc.reverseAssociations.mockResolvedValue(undefined);
  assoc.convergeRelationCell.mockResolvedValue("matched");
});
afterEach((c) => { W_.debugDump(c.task.name); Object.assign(uiActorTiming, timing); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Every monday write of the pass named `pass` fails (its run throws after whatever it sent to HubSpot). */
function loseWritesOf(pass: string): void {
  for (const fn of ["setColumns", "updateColumns", "updateItem"] as const) {
    const real = monday[fn].getMockImplementation()!;
    monday[fn].mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === pass) throw new Error(`monday 500: ${pass}'s write is lost`);
      return (real as any)(env, ...rest);
    });
  }
}
/** The NEXT monday write of the pass named `pass` fails, once (a rate-limit death after its PATCH). */
function loseNextWriteOf(pass: string): void {
  let armed = true;
  for (const fn of ["setColumns", "updateColumns", "updateItem"] as const) {
    const real = monday[fn].getMockImplementation()!;
    monday[fn].mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (armed && PASS(env) === pass) { armed = false; throw new Error(`monday 500: ${pass}'s write is lost`); }
      return (real as any)(env, ...rest);
    });
  }
}
/** How a person's run dies: before its PATCH (its HubSpot read fails), or after it (its monday write is lost) -- or not. */
type Death = "before-patch" | "after-patch" | "lives";
function dies(pass: string, how: Death, mod: string): void {
  if (how === "before-patch") w().failGetRecord = pass;
  else if (how === "after-patch") { w().mods.push(mod); loseWritesOf(pass); }
  else w().mods.push(mod);
}
/** Time passes: leases end, retries and converges run (spare PATCH times for whatever a wrong retry would send). */
async function later(): Promise<void> {
  w().failGetRecord = undefined;
  w().mods.push(T("09:01:05"), T("09:01:06"), T("09:01:30"), T("09:01:31"), T("09:02:10"), T("09:02:11"), T("09:05:00"),
    T("09:05:01"));
  for (const t of ["09:01:01", "09:01:21", "09:01:40", "09:02:05", "09:02:30", "09:04:00", "09:06:00", "09:10:00", "09:20:00",
    "09:40:00"])
    await advance(T(t));
}

// ===================================================================================================================
// THE DEALS STAGE PAIR
// ===================================================================================================================
function deal(stage: string, synced: string) {
  const ww = setWorld(makeWorld(specByObject(ENVC, "deals")!, { hsId: "9001", itemId: "5551", created: "2026-09-01T00:00:00.000Z",
    synced, group: "topics", labels: LABELS,
    props: { dealname: "Acme renewal", dealstage: stage, pipeline: DICTS.pipelineByStage[stage], amount: "1000",
      hs_v2_date_entered_current_stage: "2026-09-01T00:00:00.000Z" } }));
  ww.onPatch = (patch, mod) => { if (patch.dealstage) w().hs.properties.hs_v2_date_entered_current_stage = mod; };
  return ww;
}
/** A rep's two Stage clicks, twenty seconds apart, each run dying as told. */
async function twoStageClicks(o: { retry: boolean; first: [string, string, Death]; second: [string, string, Death] }) {
  setEnv({ STALE_FORWARD_RETRY: o.retry ? "true" : "false" });
  deal("presentationscheduled", "2026-09-29T02:00:00.000Z");
  for (const [i, [col, label, how]] of [o.first, o.second].entries()) {
    const at = i === 0 ? "09:00:00" : "09:00:20";
    clock(T(at));
    const prev = eventValue(col); rep(col, label);
    dies(`CLICK${i + 1}`, how, T(i === 0 ? "09:00:01" : "09:00:21"));
    await settleAll(await mondayWebhook(`CLICK${i + 1}`, col, prev, REP));
    w().failGetRecord = undefined;
  }
  await later();
  return { hs: w().hs.properties.dealstage, coarse: cell(COARSE), exact: cell(EXACT), sent: pushes().map(p => p.dealstage) };
}

describe("[S1] Deals: Stage and HubSpot Stage both feed dealstage", () => {
  const WON: [string, string, Death] = [COARSE, "Won", "before-patch"];
  const SENT = () => [EXACT, DICTS.stages.contractsent, "after-patch"] as [string, string, Death];

  it("FV-D1 RETRY on: Stage = Won (run dead before its PATCH), then HubSpot Stage = Contract Sent (PATCHed, run dead): Contract Sent on both sides", async () => {
    const r = await twoStageClicks({ retry: true, first: WON, second: SENT() });
    expect(r.sent, "closedwon is never sent over the newer Contract Sent\n" + trail()).toEqual(["contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(r.coarse, "the coarse Stage converges to the newer stage's bucket").toBe("Negotiation");
    expect(logged(new RegExp(`cols=${COARSE} action=edit-retry-superseded reason="this card's own push`)), trail()).toBe(true);
  });

  it("FV-D2 RETRY off (live): the same two clicks end on Contract Sent", async () => {
    const r = await twoStageClicks({ retry: false, first: WON, second: SENT() });
    expect(r.sent, trail()).toEqual(["contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(r.coarse).toBe("Negotiation");
  });

  it("FV-DB1 RETRY on: both runs dead AFTER their PATCHes -- closedwon is sent once (by its own run), never again", async () => {
    const r = await twoStageClicks({ retry: true, first: [COARSE, "Won", "after-patch"], second: SENT() });
    expect(r.sent, trail()).toEqual(["closedwon", "contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(r.coarse).toBe("Negotiation");
  });

  it("both runs dead BEFORE their PATCHes, RETRY on: the older Stage waits for the newer HubSpot Stage, then gives way to it", async () => {
    const r = await twoStageClicks({ retry: true, first: WON, second: [EXACT, DICTS.stages.contractsent, "before-patch"] });
    expect(r.sent, "closedwon is never sent\n" + trail()).toEqual(["contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(r.coarse).toBe("Negotiation");
    expect(logged(new RegExp(`cols=${COARSE} action=edit-retry-deferred reason="a newer edit of the same HubSpot property`)))
      .toBe(true);
  });

  it("FV-DB2 RETRY off (live): the same, ending on Contract Sent", async () => {
    const r = await twoStageClicks({ retry: false, first: [COARSE, "Won", "after-patch"], second: SENT() });
    expect(r.sent, trail()).toEqual(["closedwon", "contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.coarse).toBe("Negotiation");
  });

  it("the other order, RETRY on: HubSpot Stage = Contract Sent, then Stage = Won (both PATCHed, both runs dead): Won on both sides", async () => {
    const r = await twoStageClicks({ retry: true, first: [EXACT, DICTS.stages.contractsent, "after-patch"],
      second: [COARSE, "Won", "after-patch"] });
    expect(r.sent, "the older Contract Sent is never re-sent over the newer closedwon\n" + trail()).toEqual(["contractsent", "closedwon"]);
    expect(r.hs).toBe("closedwon");
    expect(r.coarse).toBe("Won");
    expect(r.exact, "HubSpot Stage converges to the newer edit").toBe(DICTS.stages.closedwon);
  });

  it("the other order, RETRY off (live): Won on both sides", async () => {
    const r = await twoStageClicks({ retry: false, first: [EXACT, DICTS.stages.contractsent, "after-patch"],
      second: [COARSE, "Won", "after-patch"] });
    expect(r.sent, trail()).toEqual(["contractsent", "closedwon"]);
    expect(r.hs).toBe("closedwon");
    expect(r.exact).toBe(DICTS.stages.closedwon);
  });

  it("the Pipeline cell's older edit is never re-sent over a HubSpot Stage push that wrote the pipeline after it", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("presentationscheduled", "2026-09-29T02:00:00.000Z");
    const sfMaint = Object.keys(DICTS.pipelines).find(p => p !== "default" && DICTS.pipelines[p])!;
    clock(T("09:00:00"));
    let prev = eventValue(PIPE); rep(PIPE, DICTS.pipelines[sfMaint]);
    dies("CLICK1", "before-patch", "");
    await settleAll(await mondayWebhook("CLICK1", PIPE, prev, REP));
    w().failGetRecord = undefined;
    clock(T("09:00:20"));
    prev = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    dies("CLICK2", "after-patch", T("09:00:21"));
    await settleAll(await mondayWebhook("CLICK2", EXACT, prev, REP));
    await later();
    expect(pushes(), "only the HubSpot Stage push, with its own pipeline\n" + trail())
      .toEqual([{ dealstage: "contractsent", pipeline: "default" }]);
    expect(w().hs.properties.pipeline).toBe("default");
    expect(cell(PIPE), "the Pipeline cell converges to the later push's pipeline").toBe(DICTS.pipelines.default);
  });

  it("a stage's retry is given up for a later change of its PIPELINE alone (sent with every stage): never moved back", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("presentationscheduled", "2026-09-29T02:00:00.000Z");
    const sfMaint = Object.keys(DICTS.pipelines).find(p => p !== "default" && DICTS.pipelines[p])!;
    clock(T("09:00:00"));
    const prev = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    dies("CLICK1", "before-patch", "");
    await settleAll(await mondayWebhook("CLICK1", EXACT, prev, REP));
    clock(T("09:00:30")); W_.hubspotSets("pipeline", sfMaint, T("09:00:30"), "INTEGRATION", "99999");   // another app, after the edit
    await later();
    expect(pushes(), "the stage edit never sends its (older) pipeline back over the later one\n" + trail()).toEqual([]);
    expect(w().hs.properties.pipeline).toBe(sfMaint);
    expect(logged(new RegExp(`cols=${EXACT} action=edit-retry-superseded reason="HubSpot changed it after the edit`))).toBe(true);
  });

  it("the Stage pair's own rule stands (the exact stage wins): Stage = Won clicked while an older HubSpot Stage edit is pending is refused when made; that edit's retry ends both cells on it", async () => {
    const r = await twoStageClicks({ retry: true, first: [EXACT, DICTS.stages.contractsent, "before-patch"],
      second: [COARSE, "Won", "lives"] });
    expect(logged(/action=refused reason="dealstage via deal_stage: HubSpot Stage shows/), trail()).toBe(true);
    expect(r.sent, trail()).toEqual(["contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(r.coarse, "consistent on the card: the refused Won converges").toBe("Negotiation");
  });

  it.each([true, false])("Stage = Won (run dead), then HubSpot Stage = Contract Sent (its run LIVES), RETRY %s: Contract Sent on both sides",
    async (retry) => {
      setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
      deal("presentationscheduled", "2026-09-29T02:00:00.000Z");
      clock(T("09:00:00"));
      let prev = eventValue(COARSE); rep(COARSE, "Won");
      dies("CLICK1", "before-patch", "");
      await settleAll(await mondayWebhook("CLICK1", COARSE, prev, REP));
      w().failGetRecord = undefined;
      clock(T("09:00:20"));
      prev = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
      w().mods.push(T("09:00:21"));
      await settleAll(await mondayWebhook("CLICK2", EXACT, prev, REP));      // pushed, and its own card write lands
      await later();
      expect(pushes().map(p => p.dealstage), trail()).toEqual(["contractsent"]);
      expect(w().hs.properties.dealstage).toBe("contractsent");
      expect(cell(EXACT)).toBe(DICTS.stages.contractsent);
      expect(cell(COARSE), "converged, though this pass's own stamp left HubSpot no newer than Sync State").toBe("Negotiation");
    });
});

// ===================================================================================================================
// THE ACCOUNTS NAME PAIR
// ===================================================================================================================
const companies = () => specByObject(ENVC, "companies")!;
const NAME_COL = () => field(companies(), "name").col;
function company() {
  return setWorld(makeWorld(companies(), { hsId: "7001", itemId: "2857007001", created: "2026-07-18T12:40:00.000Z", synced: S0,
    props: { name: "Acme", domain: "acme.com" } }));
}
async function rename(pass: string, name: string, how: Death | "lives", mod: string): Promise<void> {
  w().trail.push(`${W_.now().slice(11, 23)} REP        rename: ${JSON.stringify(w().card.name)} -> ${JSON.stringify(name)}`);
  w().card.name = name; w().card.updated_at = W_.now();
  if (how !== "lives") dies(pass, how, mod); else w().mods.push(mod);
  await settleAll(await mondayWebhook(pass, "", {}, REP, { type: "update_name" }));
  w().failGetRecord = undefined;
}
async function nameColumn(pass: string, value: string, how: Death | "lives", mod: string): Promise<void> {
  const prev = eventValue(NAME_COL()); rep(NAME_COL(), value);
  if (how !== "lives") dies(pass, how, mod); else w().mods.push(mod);
  await settleAll(await mondayWebhook(pass, NAME_COL(), prev, REP));
  w().failGetRecord = undefined;
}
const names = () => ({ hs: w().hs.properties.name, item: w().card.name, col: cell(NAME_COL()), sent: pushes().map(p => p.name) });

describe("[S2] Accounts: the item name and the Name column both feed name", () => {
  it("FV-S1 RETRY on: a rename (run dead before its PATCH), then a Name-column edit (PATCHed, run dead): the newer name on both sides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    clock(T("09:00:20")); await nameColumn("NAMECOL", "Acme Holdings", "after-patch", T("09:00:21"));
    await later();
    const r = names();
    expect(r.sent, "the older rename is never sent over the newer Name-column push\n" + trail()).toEqual(["Acme Holdings"]);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item, "the item name converges to the newer edit").toBe("Acme Holdings");
  });

  it("FV-S2 RETRY off (live): the same two edits end on the newer name", async () => {
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    clock(T("09:00:20")); await nameColumn("NAMECOL", "Acme Holdings", "after-patch", T("09:00:21"));
    await later();
    const r = names();
    expect(r.sent, trail()).toEqual(["Acme Holdings"]);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
  });

  it("the other order, RETRY on: a Name-column edit (run dead before its PATCH), then a rename (PATCHed, run dead): the rename on both sides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await nameColumn("NAMECOL", "Acme Holdings", "before-patch", "");
    clock(T("09:00:20")); await rename("RENAME", "Acme Group", "after-patch", T("09:00:21"));
    await later();
    const r = names();
    expect(r.sent, "the older Name-column edit is never sent over the newer rename\n" + trail()).toEqual(["Acme Group"]);
    expect(r.hs).toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col, "the Name column converges to the newer edit").toBe("Acme Group");
  });

  it("the other order, RETRY off (live): the rename on both sides", async () => {
    company();
    clock(T("09:00:00")); await nameColumn("NAMECOL", "Acme Holdings", "before-patch", "");
    clock(T("09:00:20")); await rename("RENAME", "Acme Group", "after-patch", T("09:00:21"));
    await later();
    const r = names();
    expect(r.sent, trail()).toEqual(["Acme Group"]);
    expect(r.hs).toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });

  it("both runs dead BEFORE their PATCHes and retried in ONE pass (the alarm late): only the newer edit is sent", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    clock(T("09:00:20")); await nameColumn("NAMECOL", "Acme Holdings", "before-patch", "");
    w().mods.push(T("09:02:01"), T("09:02:02"), T("09:02:03"), T("09:05:00"), T("09:05:01"));
    clock(T("09:02:00"));                                                   // both leases long over when the alarm fires
    expect(await fireWatch(true), "the watch's alarm").toBe(true);
    await drain();
    for (const t of ["09:03:00", "09:04:10", "09:06:00", "09:10:00", "09:20:00", "09:40:00"]) await advance(T(t));
    const r = names();
    expect(r.sent, "the older rename is never sent -- not even first\n" + trail()).toEqual(["Acme Holdings"]);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
  });
});

// ===================================================================================================================
// HOW A SIBLING PUSH IS DATED, AND WHAT A PUSH MAY WRITE ON THE CARD
// ===================================================================================================================
/** Wait until a pass started inside a webhook's waitUntil reaches a hold. */
async function reachIn(g: { reached: Promise<void> }, waits: Promise<unknown>[], what: string): Promise<void> {
  await Promise.race([g.reached, Promise.allSettled(waits).then(() => { throw new Error(`${what} was never reached`); })]);
}
/** The watch's alarm fires at `hms` (a lease ended) and its retry is run BY HAND as pass RTRY, held at `op`. */
async function retryHeldAt(hms: string, op: "hs" | "patch"): Promise<{ run: Promise<string>; release: () => void }> {
  clock(T(hms));
  expect(await fireWatch(), "the lease ended: the alarm fires").toBe(true);
  expect(W_.spilled.some(s => s.watch?.kind === "retry"), "a retry was queued").toBe(true);
  W_.spilled.length = 0;
  const g = hold("RTRY", op);
  const run = retryMarkedEdits(as("RTRY"), w().spec.boardId, w().card.id, live, { left: 30 });
  await reach(g, run, `the retry's ${op}`);
  return { run, release: g.release };
}

describe("[S3] a sibling push dated by the EDIT it carried; a push never writes over another edit of the property", () => {
  it("[LOW] a retried OLDER rename is not 'the later edit' to the rescue: a newer Name-column edit misread as our echo is rescued", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    clock(T("09:00:20")); rep(NAME_COL(), "Acme Holdings", { userId: ASK_ADA, uuid: true });   // a person working as ask ada...
    await mondayEdit("SELF", [NAME_COL()], { selfOrigin: true });           // ...misread as our echo: no mark, never pushed
    loseNextWriteOf("QUEUE");                                               // the rename's retry dies at its card write
    await later();
    const r = names();
    expect(r.sent, "the misread newer edit is rescued and sent, after the older rename's retry\n" + trail())
      .toEqual(["Acme Group", "Acme Holdings"]);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item, "the newer edit ends on both sides").toBe("Acme Holdings");
    expect(logged(/action=rescue-declined reason="HubSpot holds this card's later push/), "never read as a later sibling").toBe(false);
  });

  it("a slower run of the OLDER edit lands after the newer one was made: dated by its edit, the newer edit is still sent and kept", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    const g = hold("NAMECOL", "patch");                                     // its run read the card; its PATCH stalls
    w().mods.push(T("09:00:30"));
    const waits = await mondayWebhook("NAMECOL", NAME_COL(), prev, REP);
    await reachIn(g, waits, "the Name column's PATCH");
    clock(T("09:00:20")); await rename("RENAME", "Acme Group", "before-patch", "");   // the newer edit; its run dies
    clock(T("09:00:30")); g.release(); await settleAll(waits);              // the older edit lands now
    expect(w().card.name, "its push's consequence leaves the item name: the rename is on its way (its mark)").toBe("Acme Group");
    await later();
    const r = names();
    expect(r.sent, trail()).toEqual(["Acme Holdings", "Acme Group"]);
    expect(r.hs).toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col, "the Name column converges to the newer rename").toBe("Acme Group");
  });

  it("...and when that slower run then dies at its card write (never resolving): its push is still dated by its edit when recorded", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    const g = hold("NAMECOL", "patch");
    w().mods.push(T("09:00:30"));
    loseWritesOf("NAMECOL");                                                // after its PATCH, its run dies
    const waits = await mondayWebhook("NAMECOL", NAME_COL(), prev, REP);
    await reachIn(g, waits, "the Name column's PATCH");
    clock(T("09:00:20")); await rename("RENAME", "Acme Group", "before-patch", "");
    clock(T("09:00:30")); g.release(); await settleAll(waits);
    expect((await watchState())?.pushes?.find(p => p.prop === "name")?.a, "dated by its 09:00:00 edit, not its 09:00:30 send")
      .toBe(Date.parse(T("09:00:00")));
    await later();
    const r = names();
    expect(r.sent, trail()).toEqual(["Acme Holdings", "Acme Group"]);
    expect(r.hs, "the newer rename ends on both sides").toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });

  it("an edit whose webhook came after its value's push was recorded still dates that push: an older rename is never sent over it", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Ltd");       // S1
    const g = hold("S1", "card");                                           // its run stalls before it reads the card
    w().mods.push(T("09:00:03"));
    const waits = await mondayWebhook("S1", NAME_COL(), prev, REP);
    await reachIn(g, waits, "S1's card read");
    clock(T("09:00:01")); await rename("RENAME", "Acme Group", "before-patch", "");   // the rename; its run dies
    clock(T("09:00:02"));
    const prev2 = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings"); // S2 -- its webhook is late
    clock(T("09:00:03")); g.release(); await settleAll(waits);              // S1's run reads S2 and pushes it
    clock(T("09:00:05"));
    await settleAll(await mondayWebhook("S2", NAME_COL(), prev2, REP, { changedAt: Date.parse(T("09:00:02")) }));
    await later();
    const r = names();
    expect(r.sent, "the 09:00:01 rename is never sent over the 09:00:02 Name-column value\n" + trail()).toEqual(["Acme Holdings"]);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
  });

  it("a newer Name-column edit already on the card when the retry reads it (its webhook late) is never written over by the retry", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    clock(T("09:01:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");  // its webhook is late
    w().mods.push(T("09:01:02"));
    await advance(T("09:01:01"));                                           // the rename's retry sends it
    expect(names().sent).toEqual(["Acme Group"]);
    expect(cell(NAME_COL()), "the retry's push leaves the Name column: HubSpot never had that value").toBe("Acme Holdings");
    clock(T("09:01:05")); w().mods.push(T("09:01:06"));
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP, { changedAt: Date.parse(T("09:01:00")) }));
    await later();
    const r = names();
    expect(r.sent, trail()).toEqual(["Acme Group", "Acme Holdings"]);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
  });

  it("...and when that edit's push lands between the retry's last look and its PATCH, the rescue re-sends it (HubSpot's order)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    clock(T("09:01:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");  // on the card before the retry reads it
    const r0 = await retryHeldAt("09:01:01", "patch");                     // past its last look, before its PATCH
    clock(T("09:01:02")); w().mods.push(T("09:01:02"));
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP, { changedAt: Date.parse(T("09:01:00")) }));
    expect(w().hs.properties.name).toBe("Acme Holdings");
    clock(T("09:01:03")); w().mods.push(T("09:01:03"));
    r0.release(); await r0.run;                                             // the older rename lands last
    expect(w().hs.properties.name, "no compare-and-set: the older value landed last").toBe("Acme Group");
    expect(cell(NAME_COL()), "but the Name column is left as the person set it").toBe("Acme Holdings");
    await later();
    const r = names();
    // In the order the PATCHes were CALLED: the retry's (held, landing last), the newer edit's own, the rescue's re-send.
    expect(r.sent, trail()).toEqual(["Acme Group", "Acme Holdings", "Acme Holdings"]);
    expect(logged(/col=text_mm6t1q4h action=rescue-declined/), "never declined as 'sent once'").toBe(false);
    expect(r.hs, "re-sent: the newer edit ends on both sides").toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
  });

  it("a Name-column edit made while the retry's PATCH is in flight (its push landing first) is re-sent, and never written over", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    const r0 = await retryHeldAt("09:01:01", "patch");
    clock(T("09:01:02"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    w().mods.push(T("09:01:02"));
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP)); // its own run PATCHes first
    clock(T("09:01:03")); w().mods.push(T("09:01:03"));
    r0.release(); await r0.run;
    expect(logged(new RegExp(`cols=${NAME_COL()} action=edit-retry-raced`)), trail()).toBe(true);
    expect(cell(NAME_COL()), "held: the retry's push does not write over it").toBe("Acme Holdings");
    clock(T("09:01:05")); w().mods.push(T("09:01:05"));
    await drain();                                                          // the re-send it queued
    expect(w().hs.properties.name, "healed at once\n" + trail()).toBe("Acme Holdings");
    await later();
    const r = names();
    expect(r.hs).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
  });

  it("a RENAME made while the Name column's retry PATCH is in flight (its push landing first) is re-sent, and the item name never written over", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await nameColumn("NAMECOL", "Acme Holdings", "before-patch", "");
    const r0 = await retryHeldAt("09:01:01", "patch");
    clock(T("09:01:02")); await rename("RENAME", "Acme Group", "lives", T("09:01:02"));   // its own run PATCHes first
    clock(T("09:01:03")); w().mods.push(T("09:01:03"));
    r0.release(); await r0.run;
    expect(logged(/cols=~name action=edit-retry-raced/), trail()).toBe(true);
    expect(w().card.name, "held: the retry's push does not write over the rename").toBe("Acme Group");
    clock(T("09:01:05")); w().mods.push(T("09:01:05"));
    await drain();
    expect(w().hs.properties.name, "healed at once\n" + trail()).toBe("Acme Group");
    await later();
    const r = names();
    expect(r.hs).toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });

  it("a retry's push is dated by the edit it re-sent even when its mark ran out while the PATCH was in flight", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    w().historyFails = true;                                                // HubSpot unreadable: each try is refunded
    for (const t of ["09:01:01", "09:02:01", "09:03:01", "09:04:01", "09:05:01", "09:06:01", "09:07:01", "09:08:01"]) await advance(T(t));
    w().historyFails = false;
    const r0 = await retryHeldAt("09:09:01", "patch");                     // its last try before the TTL
    clock(T("09:10:00"));
    expect(await fireWatch(), "the TTL").toBe(true);
    expect((await watchState())?.marks["~name"], "given up while its PATCH is in flight").toBeUndefined();
    W_.spilled.length = 0;
    clock(T("09:10:01"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    w().mods.push(T("09:10:01"));
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP)); // the newer edit's own push lands first
    clock(T("09:10:02")); w().mods.push(T("09:10:02"));
    r0.release(); await r0.run;                                             // the 09:00 rename lands last
    expect((await watchState())?.pushes?.find(p => p.value === "Acme Group")?.a, "dated by its 09:00:00 edit")
      .toBe(Date.parse(T("09:00:00")));
    w().mods.push(T("09:10:06"), T("09:10:07"), T("09:12:00"), T("09:12:01"));
    for (const t of ["09:10:05", "09:11:10", "09:14:00", "09:20:00", "09:40:00"]) await advance(T(t));
    expect(w().hs.properties.name, "the newer edit ends on both sides\n" + trail()).toBe("Acme Holdings");
    expect(cell(NAME_COL())).toBe("Acme Holdings");
    expect(w().card.name).toBe("Acme Holdings");
  });

  it("a Name-column edit made after the retry read the card, its run still in flight: the older rename is not sent at all", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00")); await rename("RENAME", "Acme Group", "before-patch", "");
    const r0 = await retryHeldAt("09:01:01", "hs");                        // after its card read, before its last look
    clock(T("09:01:02"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    const atHs = hold("NAMECOL", "hs");
    const waits = await mondayWebhook("NAMECOL", NAME_COL(), prev, REP);   // marked; its run held before its PATCH
    await reachIn(atHs, waits, "the Name column's run");
    clock(T("09:01:03")); w().mods.push(T("09:01:03"));
    r0.release(); await r0.run;
    const byRetry = names().sent;
    const deferred = logged(/cols=~name action=edit-retry-deferred/);
    clock(T("09:01:04")); atHs.release(); await settleAll(waits);           // the newer edit's own run sends it
    expect(byRetry, "the stale rename never reaches HubSpot\n" + trail()).toEqual([]);
    expect(deferred).toBe(true);
    await later();
    const r = names();
    expect(r.sent, trail()).toEqual(["Acme Holdings"]);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
  });
});

// ===================================================================================================================
// THE PATIENT LINK READ'S HOLD ON THE SINGLE DEFERRED QUEUE
// ===================================================================================================================
describe("[S4] a retry's patient log read is bounded by its wave's allowance (Budget.patientMs)", () => {
  it("two retries in one wave: the first waits out monday's rate limit, the second -- the allowance spent -- reads once", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    const calls: { retries: unknown; waits: unknown }[] = [];
    const orig = monday.gql.getMockImplementation()!;
    monday.gql.mockImplementation(async (env: unknown, query: string, vars: Record<string, unknown>, retries?: unknown, waits?: unknown) => {
      if (query.includes("activity_logs")) {
        calls.push({ retries, waits });
        if (retries === undefined) clock(new Date(Date.now() + 118_000).toISOString());   // gql waited out the rate limit
      }
      return orig(env, query, vars, retries, waits);
    });
    const wave = { left: 30 } as { left: number; patientMs?: number };     // ONE budget, as a deferred wave hands it out
    clock(T("09:00:00")); await nameColumn("EDIT1", "Acme Holdings", "before-patch", "");
    clock(T("09:01:01")); w().mods.push(T("09:03:00"));
    expect(await fireWatch()).toBe(true); W_.spilled.length = 0;
    await retryMarkedEdits(as("WAVE"), w().spec.boardId, w().card.id, live, wave);
    expect(w().hs.properties.name).toBe("Acme Holdings");
    expect(wave.patientMs, "what the first read waited is spent").toBe(120_000 - 118_000);
    clock(T("09:04:00")); await nameColumn("EDIT2", "Acme Corp", "before-patch", "");
    clock(T("09:05:01")); w().mods.push(T("09:05:02"));
    expect(await fireWatch()).toBe(true); W_.spilled.length = 0;
    await retryMarkedEdits(as("WAVE"), w().spec.boardId, w().card.id, live, wave);
    expect(calls, trail()).toEqual([{ retries: undefined, waits: undefined }, { retries: 1, waits: 0 }]);
    expect(logged(/action=link-read-impatient/)).toBe(true);
    expect(w().hs.properties.name, "the impatient read answered: sent").toBe("Acme Corp");
  });

  it("a patient read waits no longer than what its run has left (not PATIENT_LOG_TIMEOUT_MS): then it reads as refused", async () => {
    vi.useRealTimers();                                                     // re-installed WITH timers this time
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    clock(T("09:00:00"));
    company();
    const { lastCellChanges, PATIENT_LOG_TIMEOUT_MS } = await import("../src/ui-actor");
    monday.gql.mockImplementation(() => new Promise(() => {}));            // monday holds the read (rate-limit waits)
    let answer: unknown = "pending";
    void lastCellChanges(as("WAVE"), companies(), w().card.id, [companies().idCol], Date.now(), { patient: true, timeoutMs: 20_000 })
      .then(r => { answer = r; });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(answer, "still waiting within its allowance").toBe("pending");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(answer, "cut off at its allowance: no answer is a refusal").toBeNull();
    expect(PATIENT_LOG_TIMEOUT_MS).toBeGreaterThan(20_000);
  });
});
