import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";
import { buildUpdatePayload, columnEditPatch, fieldDiffs } from "../src/reconcile";
import { expectedText, itemName } from "../src/mapping";
import type { Ctx, Env, FieldSpec, HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * TWO-WAY BY COLUMN: the reports from the floor on 2026-09-23, as tests.
 *
 *   "Lifecycle Stage: I change it in monday from NEW to something else and it goes back to NEW."
 *   "Sales User doesn't update."
 *   "I edited a contact in No Activity and it moved to another group."
 *
 * Three mechanisms, all proven against live data before any code changed:
 *   1. OWNERSHIP. The CRM Worker could only claim a record created after CRM_CUTOVER_AT; ~96% of the
 *      portal predates it, so every edit on an older card was refused and the forward pass wrote HubSpot's
 *      old value back. Contact 393729042116 (Elaine Rivera): sync_owner null, created 2026-01-22.
 *   2. RECORD-LEVEL REVERSE. The engine pushed EVERY reversible column that differed, not the one edited.
 *      Fixing (1) alone would have turned every stale monday cell into a HubSpot overwrite: contact
 *      394787683005 (Omar Ruth) had HubSpot Sales User = Elaine Rivera (changed in HubSpot 05:01Z),
 *      monday still showed Myla, and the next unrelated edit would have reverted HubSpot to Myla.
 *   3. GROUP MOVES. Every reconcile moved the card back to "topics" (Active Contacts).
 *
 * Driven through the real syncMondayItem -> reconcileRecord, with HubSpot and monday mocked, so every
 * claim below is proven by the PRESENCE or ABSENCE of an actual API call.
 */

// ------------------------------------------------------------------------------------------ fixtures

const LIFECYCLE: Record<string, string> = {
  lead: "1.NEW", marketingqualifiedlead: "2.Information error or incomplete/Send email for promotion",
  "1028988526": "3.Competitors", "1029060900": "5.No intention", opportunity: "7.Intention to purchase",
  customer: "8.The customer generating the transaction",
};

// monday users <-> HubSpot owners, by email, exactly as buildCtx assembles them.
const MYLA = { owner: "1739141284", monday: "102443183", email: "mylamestiola@dkmeco.com" };
const ELAINE = { owner: "165857269", monday: "102444897", email: "elainerivera@dkmeco.com" };
const ALDRIN = { owner: "81301483", monday: "102444898", email: "aldrinbautista@dkmeco.com" };
const NOBODY = { monday: "999999", email: "contractor@elsewhere.example" };   // a monday user with no HubSpot seat

const MOD = "2026-09-20T02:00:00Z";       // HubSpot lastmodifieddate the card was last synced to
const NEWER = "2026-09-23T05:01:05Z";     // a HubSpot change the card has not seen
const PUSHED = "2026-09-23T09:00:00Z";    // what a PATCH returns
const PRE = "2026-01-22T06:46:54Z";       // created long before any cutover
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(), getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(),
}));
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
  getOwners: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(), patchRecord: vi.fn(),
  searchCompanyByDomain: vi.fn(), propertiesForSpec: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({
  reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
}));
const ensure = vi.hoisted(() => ({ ensureCardForRecord: vi.fn() }));

vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", () => ({ ...hubspot, OwnershipError: class extends Error {} }));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ensure);

const { syncMondayItem, syncHubspotRecord, resetCtxCache } = await import("../src/sync");

const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  // getCtxCached keeps a ctx for 60 s per isolate: a test that builds its own owner/user map would
  // otherwise hand it to whichever test runs next.
  resetCtxCache();
  monday.getUsersByEmail.mockResolvedValue({
    [MYLA.email]: MYLA.monday, [ELAINE.email]: ELAINE.monday, [ALDRIN.email]: ALDRIN.monday,
    [NOBODY.email]: NOBODY.monday,
  });
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  monday.moveItem.mockResolvedValue(undefined);
  monday.findItemByColumn.mockResolvedValue([]);
  hubspot.getOwners.mockResolvedValue({
    [MYLA.owner]: { email: MYLA.email, name: "Myla Mestiola" },
    [ELAINE.owner]: { email: ELAINE.email, name: "Elaine Rivera" },
    [ALDRIN.owner]: { email: ALDRIN.email, name: "John Aldrin Bautista" },
  });
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.patchRecord.mockResolvedValue(PUSHED);
  hubspot.claimOwnership.mockResolvedValue(PUSHED);
  hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, object: string, prop: string) =>
    object === "contacts" && prop === "lifecyclestage" ? LIFECYCLE : {});
  assoc.reverseAssociations.mockResolvedValue(undefined);
  registry.lookupCard.mockResolvedValue(null);
});

const f = (spec: ObjectSpec, hs: string): FieldSpec => {
  const x = spec.fields.find(y => y.hs === hs && (y.type !== "dropdown" || !spec.fields.some(z => z.hs === hs && z.type === "people")));
  if (!x) throw new Error(`no field ${hs} on ${spec.object}`);
  return x;
};
const peopleCol = (spec: ObjectSpec, hs: string) => spec.fields.find(y => y.hs === hs && y.type === "people")!.col;

/** Omar Ruth, 394787683005, as HubSpot held her on 2026-09-23 after the 05:01Z Sales User change. */
const meheRec = (over: Record<string, string> = {}): HsRecord => ({
  id: "394787683005",
  properties: {
    firstname: "Omar", lastname: "Ruth", email: "mhzjey@kepsla.com", jobtitle: "Buyer",
    lifecyclestage: "lead", hubspot_owner_id: MYLA.owner, sales_user: ELAINE.owner,
    createdate: PRE, lastmodifieddate: NEWER, ...over,
  },
});

/**
 * The card the monday board actually showed: built from HubSpot's state at `syncedFrom`, stamped with
 * that timestamp, then overridden cell by cell. People cells are set by monday user id, as monday stores
 * them.
 */
function card(spec: ObjectSpec, syncedFrom: HsRecord, stamp: string,
    text: Record<string, string> = {}, people: Record<string, string[]> = {}, group = "topics"): MondayItem {
  const ctx = { labels: { lifecycleStage: LIFECYCLE }, ownersById: {}, mondayUsersByEmail: {} } as unknown as Ctx;
  const cv: MondayItem["column_values"] = [
    { id: spec.idCol, text: syncedFrom.id },
    { id: spec.syncStateCol, text: stamp },
  ];
  for (const fs of spec.fields) {
    if (fs.type === "people") continue;
    const t = expectedText(fs, syncedFrom.properties[fs.hs], ctx);
    if (t !== null) cv.push({ id: fs.col, text: t });
  }
  for (const [col, t] of Object.entries(text)) {
    const hit = cv.find(c => c.id === col);
    if (hit) hit.text = t; else cv.push({ id: col, text: t });
  }
  for (const [col, ids] of Object.entries(people))
    cv.push({ id: col, text: ids.length ? "someone" : "", persons_and_teams: ids.map(id => ({ id, kind: "person" })) });
  return { id: "CARD", name: itemName(syncedFrom, spec), created_at: PRE, updated_at: MOD, group: { id: group }, column_values: cv };
}

async function edit(spec: ObjectSpec, rec: HsRecord, item: MondayItem, cols: string[], name = false) {
  monday.getItem.mockResolvedValue(item);
  hubspot.getRecord.mockResolvedValue(rec);
  return syncMondayItem(env, spec.boardId, item.id, live, { left: 30 }, false, false, { cols, name });
}

// ------------------------------------------------------------------------------------------------
// 1. The Lifecycle Stage report, end to end.
// ------------------------------------------------------------------------------------------------

describe("Lifecycle Stage edited on an older, unclaimed card", () => {
  const life = f(CRM_CONTACTS, "lifecyclestage");

  it("claims the record for CRM on the basis of the person's edit, then writes the stage", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    const out = await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, { [life.col]: "7.Intention to purchase" }), [life.col]);

    expect(hubspot.claimOwnership).toHaveBeenCalledWith(env, expect.anything(),
      expect.objectContaining({ id: "394787683005" }), live, "human-edit");
    expect(hubspot.patchRecord).toHaveBeenCalledWith(env, expect.anything(), "394787683005",
      { lifecyclestage: "opportunity" }, live, expect.objectContaining({ allowed: true }));
    expect(out).toContain("updated-hubspot");
  });

  it("and does NOT snap the card back to 1.NEW", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, { [life.col]: "5.No intention" }), [life.col]);
    const writes = [...monday.setColumns.mock.calls, ...monday.updateItem.mock.calls]
      .map(c => (c.length === 5 ? c[3] : c[4]) as Record<string, unknown>);
    for (const cv of writes) expect(cv).not.toHaveProperty(life.col);
  });

  it("every one of the stages round-trips to its internal value", async () => {
    for (const [value, label] of Object.entries(LIFECYCLE)) {
      vi.clearAllMocks();
      hubspot.patchRecord.mockResolvedValue(PUSHED); hubspot.claimOwnership.mockResolvedValue(PUSHED);
      monday.setColumns.mockResolvedValue(undefined); monday.updateItem.mockResolvedValue(undefined);
      monday.getUsersByEmail.mockResolvedValue({}); hubspot.getOwners.mockResolvedValue({});
      hubspot.propertiesForSpec.mockReturnValue([]);
      hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
      hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, o: string, p: string) =>
        o === "contacts" && p === "lifecyclestage" ? LIFECYCLE : {});
      const rec = meheRec({ lastmodifieddate: MOD, lifecyclestage: value === "lead" ? "customer" : "lead" });
      await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, { [life.col]: label }), [life.col]);
      expect(hubspot.patchRecord.mock.calls[0]?.[3]).toEqual({ lifecyclestage: value });
    }
  });
});

// ------------------------------------------------------------------------------------------------
// 2. The stale-overwrite that fixing ownership alone would have caused. Omar Ruth, verbatim.
// ------------------------------------------------------------------------------------------------

describe("a stale monday cell is never pushed by an unrelated edit", () => {
  const job = f(CRM_CONTACTS, "jobtitle");
  const salesUser = peopleCol(CRM_CONTACTS, "sales_user");

  it("editing Job Title sends ONLY jobtitle, never the stale Sales User", async () => {
    const before = meheRec({ sales_user: MYLA.owner, lastmodifieddate: MOD });   // what monday last saw
    const now = meheRec();                                                     // HubSpot: Elaine, newer
    const item = card(CRM_CONTACTS, before, MOD, { [job.col]: "Head of Procurement" },
      { [salesUser]: [MYLA.monday] });
    await edit(CRM_CONTACTS, now, item, [job.col]);

    expect(hubspot.patchRecord).toHaveBeenCalledTimes(1);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ jobtitle: "Head of Procurement" });
    expect(hubspot.patchRecord.mock.calls[0][3]).not.toHaveProperty("sales_user");
  });

  it("and HubSpot's newer Sales User is applied to monday in the same pass", async () => {
    const before = meheRec({ sales_user: MYLA.owner, lastmodifieddate: MOD });
    const item = card(CRM_CONTACTS, before, MOD, { [job.col]: "Head of Procurement" },
      { [salesUser]: [MYLA.monday] });
    await edit(CRM_CONTACTS, meheRec(), item, [job.col]);

    const cv = (monday.setColumns.mock.calls[0]?.[3] ?? monday.updateItem.mock.calls[0]?.[4]) as Record<string, any>;
    expect(cv[salesUser]).toEqual({ personsAndTeams: [{ id: Number(ELAINE.monday), kind: "person" }] });
    // Stamped past BOTH HubSpot's change and the push, so neither is buried.
    expect(cv[CRM_CONTACTS.syncStateCol]).toBe(PUSHED);
  });

  it("a HubSpot-originated sync forwards the stale cell and writes nothing to HubSpot", async () => {
    const before = meheRec({ sales_user: MYLA.owner, lastmodifieddate: MOD });
    monday.findItemByColumn.mockResolvedValue([card(CRM_CONTACTS, before, MOD, {}, { [salesUser]: [MYLA.monday] })]);
    hubspot.getRecord.mockResolvedValue(meheRec());
    await syncHubspotRecord(env, CRM_CONTACTS, "394787683005", live, { left: 30 });

    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    const cv = monday.updateItem.mock.calls[0][4] as Record<string, any>;
    expect(cv[salesUser]).toEqual({ personsAndTeams: [{ id: Number(ELAINE.monday), kind: "person" }] });
  });

  /** HubSpot unchanged since the card was synced => any difference is monday-side (a pending push). */
  it("a HubSpot-originated sync with nothing new in HubSpot leaves monday alone", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    monday.findItemByColumn.mockResolvedValue([card(CRM_CONTACTS, rec, MOD, { [job.col]: "typed a second ago" })]);
    hubspot.getRecord.mockResolvedValue(rec);
    await syncHubspotRecord(env, CRM_CONTACTS, "394787683005", live, { left: 30 });

    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
  });

  /**
   * THE REPAIR CASE. The old engine stamped cards without applying a filled People cell's change, so a
   * card can hold Sync State == HubSpot's lastmodifieddate while its Sales User cell is stale. The rule
   * above then reads the stale cell as a pending monday edit and never heals it. /resync passes
   * forceForward for records an operator chose; nothing else does.
   */
  it("forceForward heals a stale cell that Sync State says is current -- monday only", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });                       // HubSpot: Elaine, NOT newer
    monday.findItemByColumn.mockResolvedValue([card(CRM_CONTACTS, rec, MOD, {}, { [salesUser]: [MYLA.monday] })]);
    hubspot.getRecord.mockResolvedValue(rec);

    await syncHubspotRecord(env, CRM_CONTACTS, "394787683005", live, { left: 30 });
    expect(monday.updateItem).not.toHaveBeenCalled();                    // the ordinary rule: blind to it

    await syncHubspotRecord(env, CRM_CONTACTS, "394787683005", live, { left: 30 }, undefined, true);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    const cv = (monday.updateItem.mock.calls[0]?.[4] ?? monday.setColumns.mock.calls[0]?.[3]) as Record<string, any>;
    expect(cv[salesUser]).toEqual({ personsAndTeams: [{ id: Number(ELAINE.monday), kind: "person" }] });
  });

  it("forceForward on a card already in line writes nothing", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    monday.findItemByColumn.mockResolvedValue([card(CRM_CONTACTS, rec, MOD, {},
      { [salesUser]: [ELAINE.monday], [peopleCol(CRM_CONTACTS, "hubspot_owner_id")]: [MYLA.monday] })]);
    hubspot.getRecord.mockResolvedValue(rec);
    await syncHubspotRecord(env, CRM_CONTACTS, "394787683005", live, { left: 30 }, undefined, true);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.updateItem).not.toHaveBeenCalled();
    const writes = monday.setColumns.mock.calls.map(c => c[3] as Record<string, unknown>);
    for (const w of writes) expect(w).not.toHaveProperty(salesUser);
  });

  it("forceForward clears a Sales User whose HubSpot owner has no monday seat", async () => {
    const rec = meheRec({ lastmodifieddate: MOD, sales_user: "55555" });   // owner with no monday user
    monday.findItemByColumn.mockResolvedValue([card(CRM_CONTACTS, rec, MOD, {}, { [salesUser]: [MYLA.monday] })]);
    hubspot.getRecord.mockResolvedValue(rec);
    await syncHubspotRecord(env, CRM_CONTACTS, "394787683005", live, { left: 30 }, undefined, true);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    const cv = (monday.updateItem.mock.calls[0]?.[4] ?? monday.setColumns.mock.calls[0]?.[3]) as Record<string, any>;
    expect(cv[salesUser]).toEqual({ personsAndTeams: [] });
  });
});

// ------------------------------------------------------------------------------------------------
// 3. Sales User and owner, the people columns.
// ------------------------------------------------------------------------------------------------

describe("people columns", () => {
  const owner = peopleCol(CRM_CONTACTS, "hubspot_owner_id");

  it("changing the Contact owner sends that person's HubSpot owner id", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, {}, { [owner]: [ALDRIN.monday] }), [owner]);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ hubspot_owner_id: ALDRIN.owner });
  });

  it("removing the owner clears it in HubSpot", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, {}, { [owner]: [] }), [owner]);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ hubspot_owner_id: "" });
  });

  /**
   * THE SEATLESS OWNER. Since 2026-09-23 an owner with no monday seat shows as an EMPTY cell, so an
   * event on that empty cell (a picker opened and closed; someone added then removed) says nothing
   * about the owner. It must not erase the assignment in HubSpot, nor claim the record.
   */
  it("an empty cell for a SEATLESS HubSpot owner is not a clear: nothing is sent, nothing claimed", async () => {
    const salesUser = peopleCol(CRM_CONTACTS, "sales_user");
    const rec = meheRec({ lastmodifieddate: MOD, sales_user: "465759285" });   // joan zhang: no monday seat
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, {}, { [salesUser]: [] }), [salesUser]);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
  });

  it("but emptying the cell of an owner monday CAN show still clears it", async () => {
    const salesUser = peopleCol(CRM_CONTACTS, "sales_user");
    const rec = meheRec({ lastmodifieddate: MOD });                             // sales_user: Elaine
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, {}, { [salesUser]: [] }), [salesUser]);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ sales_user: "" });
  });

  it("a person with no HubSpot user is refused, not guessed, and the cell heals", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, {}, { [owner]: [NOBODY.monday] }), [owner]);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    const cv = monday.setColumns.mock.calls[0][3] as Record<string, any>;
    expect(cv[owner]).toEqual({ personsAndTeams: [{ id: Number(MYLA.monday), kind: "person" }] });
  });

  it("choosing the person HubSpot already holds sends nothing", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, {}, { [owner]: [MYLA.monday] }), [owner]);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();   // an edit that changes nothing claims nothing
  });
});

/**
 * THE FORWARD SIDE OF PEOPLE COLUMNS -- the actual reason "Sales User doesn't update".
 *
 * The record-level diff only filled an EMPTY People cell. A filled one never noticed HubSpot change.
 */
describe("a People cell follows HubSpot, not just when empty", () => {
  const owner = peopleCol(CRM_CONTACTS, "hubspot_owner_id");
  const salesUser = peopleCol(CRM_CONTACTS, "sales_user");
  const ctx = {
    labels: {}, ownersById: {
      [MYLA.owner]: { email: MYLA.email }, [ELAINE.owner]: { email: ELAINE.email }, [ALDRIN.owner]: { email: ALDRIN.email },
    },
    mondayUsersByEmail: { [MYLA.email]: MYLA.monday, [ELAINE.email]: ELAINE.monday, [ALDRIN.email]: ALDRIN.monday },
    mondayEmailByUserId: {}, ownerIdByEmail: {},
  } as unknown as Ctx;
  const peopleDiffs = (rec: HsRecord, item: MondayItem, spec: ObjectSpec) =>
    fieldDiffs(rec, item, spec, ctx).filter(d => d.f?.type === "people");

  it("a filled cell holding the wrong person is corrected (Omar Ruth: Myla -> Elaine)", () => {
    const rec = meheRec();
    const item = card(CRM_CONTACTS, rec, MOD, {}, { [salesUser]: [MYLA.monday], [owner]: [MYLA.monday] });
    const d = peopleDiffs(rec, item, CRM_CONTACTS);
    expect(d.map(x => x.f!.col)).toEqual([salesUser]);
  });

  it("a SECOND person in an owner cell is removed, even when the first one is right", () => {
    // Elaine Rivera's card, 2026-09-23: Contact owner showed John Aldrin AND a second person.
    const rec = meheRec({ hubspot_owner_id: ALDRIN.owner });
    const item = card(CRM_CONTACTS, rec, MOD, {}, { [owner]: [ALDRIN.monday, MYLA.monday], [salesUser]: [ELAINE.monday] });
    const d = peopleDiffs(rec, item, CRM_CONTACTS);
    expect(d.map(x => x.f!.col)).toEqual([owner]);
    expect(buildUpdatePayload(d, rec, CRM_CONTACTS, ctx)[owner])
      .toEqual({ personsAndTeams: [{ id: Number(ALDRIN.monday), kind: "person" }] });
  });

  it("an owner with no monday seat EMPTIES the cell instead of leaving someone else there", () => {
    const rec = meheRec({ sales_user: "55555555" });   // a HubSpot owner nobody can map to monday
    const item = card(CRM_CONTACTS, rec, MOD, {}, { [salesUser]: [MYLA.monday], [owner]: [MYLA.monday] });
    const d = peopleDiffs(rec, item, CRM_CONTACTS);
    expect(d).toHaveLength(1);
    expect(d[0].peopleClear).toBe(true);
    expect(buildUpdatePayload(d, rec, CRM_CONTACTS, ctx)[salesUser]).toEqual({ personsAndTeams: [] });
  });

  it("an exact match raises nothing, so there is no rewrite loop", () => {
    const rec = meheRec();
    const item = card(CRM_CONTACTS, rec, MOD, {}, { [salesUser]: [ELAINE.monday], [owner]: [MYLA.monday] });
    expect(peopleDiffs(rec, item, CRM_CONTACTS)).toEqual([]);
  });

  /** The record-level engine must be untouched: there, this diff could reach buildReversePatch and
   *  send a stale owner to HubSpot (the 2026-08-28 incident). */
  it("the Work-Management specs keep the old behaviour exactly", async () => {
    const { CONTACTS_MYLA } = await import("../src/config");
    expect(CONTACTS_MYLA.columnLevelReverse).toBeFalsy();
    const wmOwner = CONTACTS_MYLA.fields.find(x => x.hs === "hubspot_owner_id" && x.type === "people")!;
    const rec: HsRecord = { id: "1", properties: { hubspot_owner_id: ELAINE.owner } };
    const item: MondayItem = { id: "C", name: "x", created_at: PRE, updated_at: MOD, group: { id: "g" },
      column_values: [{ id: wmOwner.col, text: "Myla", persons_and_teams: [{ id: MYLA.monday, kind: "person" }] }] };
    const d = fieldDiffs(rec, item, CONTACTS_MYLA, ctx).filter(x => x.f?.col === wmOwner.col);
    expect(d).toEqual([]);   // appReverse + passive reconcile: still no diff, as before
  });
});

// ------------------------------------------------------------------------------------------------
// 4. Ownership: explicit stamps are still final.
// ------------------------------------------------------------------------------------------------

describe("an explicit stamp is never overridden by a person's edit", () => {
  const job = f(CRM_CONTACTS, "jobtitle");

  it.each(["wm", "hold"])("sync_owner=%s: refused, no claim, the edited cell heals", async (stamp) => {
    const rec = meheRec({ sync_owner: stamp, lastmodifieddate: MOD });
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, { [job.col]: "Changed" }), [job.col]);
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.setColumns.mock.calls[0][3]).toEqual({ [job.col]: "Buyer" });
  });

  it("an already-crm record is written with no second claim", async () => {
    const rec = meheRec({ sync_owner: "crm", lastmodifieddate: MOD });
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, { [job.col]: "Changed" }), [job.col]);
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(hubspot.patchRecord).toHaveBeenCalledTimes(1);
  });

  it("our own token's echo never claims or writes, even naming a column", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    monday.getItem.mockResolvedValue(card(CRM_CONTACTS, rec, MOD, { [job.col]: "Changed" }));
    hubspot.getRecord.mockResolvedValue(rec);
    await syncMondayItem(env, CRM_CONTACTS.boardId, "CARD", live, { left: 30 }, false, true, { cols: [job.col] });
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
  });
});

/**
 * AUTOMATIONS AND AMBIGUOUS PEOPLE: two ways a claim-on-edit could go wrong in bulk.
 */
describe("a monday automation's edit, and a person who maps to several owners", () => {
  const job = f(CRM_CONTACTS, "jobtitle");
  const owner = peopleCol(CRM_CONTACTS, "hubspot_owner_id");

  const automationEdit = (r: HsRecord, item: MondayItem, cols: string[]) => {
    monday.getItem.mockResolvedValue(item);
    hubspot.getRecord.mockResolvedValue(r);
    return syncMondayItem(env, CRM_CONTACTS.boardId, item.id, live, { left: 30 }, false, false,
      { cols, byAutomation: true });
  };

  /** A bulk repair rewriting Last Activity Date would fire #06/#08 on thousands of cards. If an
   *  automation could claim, one monday-side repair would become thousands of HubSpot claims. */
  it("an automation can NOT claim an unclaimed record; its value is healed back", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    await automationEdit(rec, card(CRM_CONTACTS, rec, MOD, { [job.col]: "set by automation" }), [job.col]);
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.setColumns.mock.calls[0][3]).toEqual({ [job.col]: "Buyer" });
  });

  it("but it DOES reach HubSpot on a record CRM already owns", async () => {
    const rec = meheRec({ sync_owner: "crm", lastmodifieddate: MOD });
    await automationEdit(rec, card(CRM_CONTACTS, rec, MOD, { [job.col]: "set by automation" }), [job.col]);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ jobtitle: "set by automation" });
  });

  it("isAutomationActor recognises monday's negative pseudo-users and nothing else", async () => {
    const { isAutomationActor } = await import("../src/actor-label");
    expect(isAutomationActor("-4")).toBe(true);
    expect(isAutomationActor("-1")).toBe(true);
    for (const id of ["104231431", "104118038", "", "4", "-", "abc"]) expect(isAutomationActor(id)).toBe(false);
  });

  /** Nine HubSpot owners share idaliang@dkmeco.com. Picking one would be a guess. */
  it("a person whose email belongs to several HubSpot owners is refused, not guessed", async () => {
    hubspot.getOwners.mockResolvedValue({
      [MYLA.owner]: { email: MYLA.email, name: "Myla Mestiola" },
      "900000001": { email: ALDRIN.email, name: "华南销售" },    // two owners, one email
      "900000002": { email: ALDRIN.email, name: "华北销售" },
    });
    const rec = meheRec({ lastmodifieddate: MOD });
    const { buildCtx } = await import("../src/sync");
    const ctx = await buildCtx(env);
    expect(ctx.ownerIdByEmail[ALDRIN.email]).toBeUndefined();   // shared -> removed, not guessed
    expect(ctx.ownerIdByEmail[MYLA.email]).toBe(MYLA.owner);    // unique -> kept
    // And at the column level, via the helper that reads that map:
    const ctx2 = {
      labels: {}, ownersById: {}, mondayUsersByEmail: {},
      mondayEmailByUserId: { [ALDRIN.monday]: ALDRIN.email }, ownerIdByEmail: {},   // ambiguous -> absent
    } as unknown as Ctx;
    const r = columnEditPatch(rec, card(CRM_CONTACTS, rec, MOD, {}, { [owner]: [ALDRIN.monday] }), CRM_CONTACTS, ctx2,
      { cols: [owner] });
    expect(r.patch).toEqual({});
    expect(r.refusals.join()).toMatch(/no HubSpot user/);
  });
});

// ------------------------------------------------------------------------------------------------
// 5. Groups: the Worker never moves a card.
// ------------------------------------------------------------------------------------------------

describe("the Worker never moves a card between groups", () => {
  const NO_ACTIVITY = "group_mm7cj2yx";   // "No Activity - 未跟进" on the CRM Contacts board

  it("a HubSpot change to a card in 'No Activity' updates it where it is", async () => {
    const before = meheRec({ lastmodifieddate: MOD, jobtitle: "Old" });
    monday.findItemByColumn.mockResolvedValue([card(CRM_CONTACTS, before, MOD, {}, {}, NO_ACTIVITY)]);
    hubspot.getRecord.mockResolvedValue(meheRec());
    await syncHubspotRecord(env, CRM_CONTACTS, "394787683005", live, { left: 30 });
    expect(monday.updateItem).toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a person's edit to a card in 'No Activity' leaves it there", async () => {
    const rec = meheRec({ lastmodifieddate: MOD });
    const job = f(CRM_CONTACTS, "jobtitle");
    await edit(CRM_CONTACTS, rec, card(CRM_CONTACTS, rec, MOD, { [job.col]: "X" }, {}, NO_ACTIVITY), [job.col]);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it.each([CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS])("$object board: placement only", (spec) => {
    expect(spec.groupBy).toMatchObject({ singleGroup: "topics", placeOnly: true });
    expect(spec.columnLevelReverse).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// 6. columnEditPatch in isolation: exactly what was edited.
// ------------------------------------------------------------------------------------------------

describe("columnEditPatch", () => {
  const ctx = {
    labels: { lifecycleStage: LIFECYCLE }, ownersById: {}, mondayUsersByEmail: {},
    mondayEmailByUserId: { [MYLA.monday]: MYLA.email }, ownerIdByEmail: { [MYLA.email]: MYLA.owner },
  } as unknown as Ctx;
  const rec = meheRec();
  const job = f(CRM_CONTACTS, "jobtitle");
  const life = f(CRM_CONTACTS, "lifecyclestage");

  it("ignores every column that was not edited, however different", () => {
    const item = card(CRM_CONTACTS, rec, MOD, { [job.col]: "A", [life.col]: "5.No intention" });
    expect(columnEditPatch(rec, item, CRM_CONTACTS, ctx, { cols: [job.col] }).patch).toEqual({ jobtitle: "A" });
  });

  it("refuses an unknown label rather than inventing a value", () => {
    const item = card(CRM_CONTACTS, rec, MOD, { [life.col]: "Something Typed" });
    const r = columnEditPatch(rec, item, CRM_CONTACTS, ctx, { cols: [life.col] });
    expect(r.patch).toEqual({});
    expect(r.heal.map(x => x.hs)).toEqual(["lifecyclestage"]);
  });

  it("refuses a one-way column and asks for it to be healed", () => {
    const oneWay = CRM_CONTACTS.fields.find(x => x.oneWay)!;
    const item = card(CRM_CONTACTS, rec, MOD, { [oneWay.col]: "2020-01-01" });
    const r = columnEditPatch(rec, item, CRM_CONTACTS, ctx, { cols: [oneWay.col] });
    expect(r.patch).toEqual({});
    expect(r.heal).toContain(oneWay);
  });

  it("an emptied cell clears only when HubSpot holds a value", () => {
    const item = card(CRM_CONTACTS, rec, MOD, { [job.col]: "" });
    expect(columnEditPatch(rec, item, CRM_CONTACTS, ctx, { cols: [job.col] }).patch).toEqual({ jobtitle: "" });
    const blank = meheRec({ jobtitle: "" });
    expect(columnEditPatch(blank, card(CRM_CONTACTS, blank, MOD, { [job.col]: "" }), CRM_CONTACTS, ctx,
      { cols: [job.col] }).patch).toEqual({});
  });
});

// ------------------------------------------------------------------------------------------------
// 7. The webhook hands the engine exactly the column monday named.
// ------------------------------------------------------------------------------------------------

describe("coalesceLatest: the latest edit wins", () => {
  it("an edit arriving mid-sync triggers exactly one more run, which sees the latest state", async () => {
    const { coalesceLatest } = await import("../src/webhooks");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const run = async () => { calls++; if (calls === 1) await gate; };
    const a = coalesceLatest("k", run);
    const b = coalesceLatest("k", run);   // mid-flight
    const c = coalesceLatest("k", run);   // mid-flight again -- still ONE trailing run
    release();
    await Promise.all([a, b, c]);
    expect(calls).toBe(2);
  });

  it("rerunAfterError: a run that throws still honours the pending re-run; rejects only if the LAST run failed", async () => {
    const { coalesceLatest } = await import("../src/webhooks");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const run = async () => { calls++; if (calls === 1) { await gate; throw new Error("transient"); } };
    const a = coalesceLatest("e1", run, { rerunAfterError: true });
    const b = coalesceLatest("e1", run, { rerunAfterError: true });
    release();
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(calls).toBe(2);
    // Both runs fail: the caller sees the rejection.
    await expect(coalesceLatest("e2", async () => { throw new Error("down"); }, { rerunAfterError: true }))
      .rejects.toThrow("down");
  });

  it("without the option (the md:* column queues) a throw still stops the queue, as before", async () => {
    const { coalesceLatest } = await import("../src/webhooks");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const run = async () => { calls++; if (calls === 1) { await gate; throw new Error("x"); } };
    const a = coalesceLatest("m1", run);
    const b = coalesceLatest("m1", run);
    release();
    await expect(a).rejects.toThrow("x");
    await expect(b).rejects.toThrow("x");
    expect(calls).toBe(1);
  });

  it("different keys never wait for each other", async () => {
    const { coalesceLatest } = await import("../src/webhooks");
    let n = 0;
    await Promise.all([coalesceLatest("x", async () => { n++; }), coalesceLatest("y", async () => { n++; })]);
    expect(n).toBe(2);
  });
});
