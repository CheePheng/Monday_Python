import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";
import { CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import { readWranglerConfig, readWmConfig } from "../scripts/read-wrangler.mjs";
import { PIPELINES, EXPECTED_TARGETS } from "./fixtures/deal-pipelines";

/**
 * STAGE_COARSE_REVERSE, AT THE WEBHOOK: the gate the flag actually is.
 *
 * The Deals board's native Stage (`deal_stage`) stays `oneWay` in the spec. What the flag changes is only
 * which of its events the webhook lets through: with it off, none (today's behaviour, byte for byte);
 * with it on, a PERSON's -- never automation 31010016's "Stage = New" on every new card, never our own
 * token's echo. And a person's edits of the two stage columns share one queue per card, so the coarse
 * and the exact stage are never sent by two runs racing each other.
 *
 * The sync is mocked: these prove what reaches it, and with which edit. test/coarse-stage-reverse.test.ts
 * drives the same events through the real sync to HubSpot.
 */

const PERSON = "104231430";
const ASK_ADA = "104118038";                 // this Worker's own monday token user
const actor = vi.hoisted(() => ({
  isIntegrationActor: vi.fn(async (_e: unknown, id: string) => !id || id === "104118038"),
  isAutomationActor: (id: string) => /^-\d+$/.test(String(id ?? "").trim()),
  actorLabel: vi.fn(async () => "actor=x"),
}));
const sync = vi.hoisted(() => ({
  syncMondayItem: vi.fn(async (..._a: unknown[]) => "ok"), syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(),
  getCtxCached: vi.fn(),
}));
vi.mock("../src/actor-label", () => actor);
vi.mock("../src/sync", () => sync);
const registry = vi.hoisted(() => ({ noteCreateWindowEdit: vi.fn(async () => undefined) }));
vi.mock("../src/card-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/card-registry")>()), ...registry,
}));

const { handleMonday, coarseStageCols } = await import("../src/webhooks");
const { getCrmStageDicts, coarseTargetsFor } = await import("../src/hubspot");

const COARSE = "deal_stage";
const EXACT = "dropdown_mm7624zd";
const AMOUNT = "deal_value";
const ITEM = 7001;

const base = { ENABLE_CRM: "true" } as unknown as Env;
const ON = { ...base, STAGE_COARSE_REVERSE: "true" } as unknown as Env;

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const settle = async () => { await Promise.allSettled(waits.splice(0)); };

let logs: string[];
const logged = (re: RegExp) => logs.some(l => re.test(l));

/** One monday webhook, returned as soon as handleMonday answers (the sync runs in waitUntil). */
const post = (env: Env, columnId: string, userId: string | number | undefined, board = CRM_DEALS.boardId) =>
  handleMonday(new Request("https://w/webhooks/monday", { method: "POST",
    body: JSON.stringify({ event: { boardId: Number(board), pulseId: ITEM, type: "update_column_value", columnId,
      ...(userId === undefined ? {} : { userId }), value: { label: { index: 1 } }, previousValue: null } }) }), env, ectx);
const fire = async (...a: Parameters<typeof post>) => { await post(...a); await settle(); };
/** Let a run the webhook just scheduled reach the sync (it awaits the actor lookup first). */
const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** The edit and the self-origin flag of each syncMondayItem call, in order. */
const calls = () => sync.syncMondayItem.mock.calls.map(c => ({ selfOrigin: c[6], edit: c[7] as { cols: string[]; byAutomation?: boolean } | undefined, actor: c[8] }));

/** Hold the next syncMondayItem call until released: a run in flight. */
function holdNextSync(fail = false) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { release = r; });
  sync.syncMondayItem.mockImplementationOnce(async () => {
    enter(); await gate;
    if (fail) throw new Error("monday 500");
    return "ok";
  });
  return { entered, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncMondayItem.mockImplementation(async () => "ok");
  waits.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("flag OFF: every event on the coarse Stage is ignored, exactly as before", () => {
  it.each([["absent", base], ["\"false\"", { ...base, STAGE_COARSE_REVERSE: "false" }],
    ["\"TRUE\"", { ...base, STAGE_COARSE_REVERSE: "TRUE" }], ["\"1\"", { ...base, STAGE_COARSE_REVERSE: "1" }]])(
    "STAGE_COARSE_REVERSE %s", async (_n, env) => {
      for (const who of [PERSON, -4, ASK_ADA]) await fire(env as Env, COARSE, who);
      expect(sync.syncMondayItem).not.toHaveBeenCalled();
      expect(actor.isIntegrationActor).not.toHaveBeenCalled();   // not even the actor is looked up
      expect(logs.filter(l => /col=deal_stage action=ignored reason="bookkeeping\/one-way column"/.test(l))).toHaveLength(3);
    });

  it("and the exact HubSpot Stage keeps its own queue, as before", async () => {
    const h = holdNextSync();
    await post(base, EXACT, PERSON);
    await h.entered;
    await post(base, EXACT, PERSON);
    expect(logged(/action=coalesced-rerun key=md:7001:dropdown_mm7624zd /)).toBe(true);
    h.release(); await settle();
  });
});

describe("flag ON: only a PERSON's edit of the coarse Stage goes on", () => {
  it("a person's edit reaches the sync as an edit of that column", async () => {
    await fire(ON, COARSE, PERSON);
    const [c] = calls();
    expect(calls()).toHaveLength(1);
    expect(c.edit).toEqual({ cols: [COARSE] });
    expect(c.selfOrigin).toBe(false);
    expect(c.actor).toEqual({ id: PERSON, byAutomation: false });
  });

  /** 31010016 sets Stage = New on every new card -- the cards this Worker makes from HubSpot deals too. */
  it("an automation's (-4) is dropped before any sync, even on a record CRM owns", async () => {
    await fire(ON, COARSE, -4);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    expect(logged(/col=deal_stage user=-4 action=ignored reason="the coarse Stage, edited by an automation/)).toBe(true);
  });

  it("our own token's echo is dropped", async () => {
    await fire(ON, COARSE, ASK_ADA);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    expect(logged(/action=ignored reason="the coarse Stage, edited by our own token/)).toBe(true);
  });

  it("an event with no user is treated as ours (fails closed)", async () => {
    await fire(ON, COARSE, undefined);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
  });

  /**
   * CREATE_WINDOW_REPLAY: such an event never reaches a claim, so a create window could not see it -- and a
   * person's queued edit of this column would then be replayed carrying 31010016's New as theirs. So it is
   * NOTED for the row (a no-op for a row with no create window open), and still dropped.
   */
  it.each([["an automation's", -4, "automation"], ["our own token's", ASK_ADA, "integration"]])(
    "with CREATE_WINDOW_REPLAY on too, %s is noted for the row's create window, and still dropped",
    async (_n, who, cls) => {
      const both = { ...ON, CREATE_WINDOW_REPLAY: "true" } as unknown as Env;
      await fire(both, COARSE, who);
      expect(sync.syncMondayItem).not.toHaveBeenCalled();
      expect(registry.noteCreateWindowEdit).toHaveBeenCalledWith(both, CRM_DEALS.boardId, String(ITEM),
        { cols: [COARSE], actorClass: cls, actor: String(who), at: expect.any(Number) });
    });

  it("without CREATE_WINDOW_REPLAY nothing is noted", async () => {
    for (const who of [-4, ASK_ADA]) await fire(ON, COARSE, who);
    expect(registry.noteCreateWindowEdit).not.toHaveBeenCalled();
  });

  it("other one-way Deals columns are still ignored", async () => {
    await fire(ON, "date_mm7dgxym", PERSON);                  // Created date
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    expect(logged(/col=date_mm7dgxym action=ignored reason="bookkeeping\/one-way column"/)).toBe(true);
  });

  it("a board without a coarse Stage is untouched: Contacts' one-way columns are still ignored", async () => {
    await fire(ON, "date_mm6z33nk", PERSON, CRM_CONTACTS.boardId);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    expect(coarseStageCols(ON, CRM_CONTACTS)).toBeNull();
  });
});

describe("flag ON: a person's stage edits share ONE queue per card", () => {
  it("the coarse and the exact stage are serialised, and the trailing run carries every column edited meanwhile", async () => {
    const h = holdNextSync();
    await post(ON, COARSE, PERSON);                           // run 1, in flight
    await h.entered;
    await post(ON, EXACT, PERSON);                            // both arrive while it runs...
    await post(ON, COARSE, PERSON);
    await tick();
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(1);     // ...and do not start a second, racing run
    expect(logged(/action=coalesced-rerun key=md:7001:~stage /)).toBe(true);
    h.release(); await settle();
    expect(calls().map(c => c.edit?.cols)).toEqual([[COARSE], [EXACT, COARSE]]);
  });

  it("an exact-stage edit alone is sent exactly as before, only through the shared queue", async () => {
    await fire(ON, EXACT, PERSON);
    expect(calls()[0].edit).toEqual({ cols: [EXACT] });
  });

  it("an automation's edit of the exact stage keeps its own queue (never mistaken for a person's)", async () => {
    const h = holdNextSync();
    await post(ON, COARSE, PERSON);
    await h.entered;
    await post(ON, EXACT, -4);                                // its own run, not a re-run of the person's
    await tick();
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(2);
    expect(calls()[1].edit).toEqual({ cols: [EXACT], byAutomation: true });
    h.release(); await settle();
    expect(calls()).toHaveLength(2);
  });

  it("other columns keep their own queue", async () => {
    const h = holdNextSync();
    await post(ON, COARSE, PERSON);
    await h.entered;
    await post(ON, AMOUNT, PERSON);
    await tick();
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(2);
    expect(calls()[1].edit).toEqual({ cols: [AMOUNT] });
    h.release(); await settle();
  });

  it("a run that throws loses what arrived meanwhile (as every md:* queue does), and it does not ride along later", async () => {
    const h = holdNextSync(true);
    await post(ON, COARSE, PERSON);
    await h.entered;
    await post(ON, EXACT, PERSON);                            // queued behind a run that is about to fail
    h.release(); await settle();
    expect(logged(/item=7001 action=error reason="Error: monday 500"/)).toBe(true);
    await fire(ON, COARSE, PERSON);                           // a later, separate edit
    expect(calls().map(c => c.edit?.cols)).toEqual([[COARSE], [COARSE]]);
  });
});

describe("the flag and its config", () => {
  it("only the literal \"true\" arms it, and only on a spec with a coarse Stage", () => {
    expect(coarseStageCols(ON, CRM_DEALS)).toEqual({ coarse: COARSE, exact: EXACT });
    for (const v of [undefined, "false", "TRUE", "1", ""])
      expect(coarseStageCols({ ...base, STAGE_COARSE_REVERSE: v } as unknown as Env, CRM_DEALS)).toBeNull();
    expect(coarseStageCols(ON, CRM_CONTACTS)).toBeNull();
  });

  it("the CRM Worker ships it OFF, and the WM config does not arm it", () => {
    expect(((readWranglerConfig().vars ?? {}) as Record<string, string>).STAGE_COARSE_REVERSE).toBe("false");
    expect(((readWmConfig().vars ?? {}) as Record<string, string>).STAGE_COARSE_REVERSE).not.toBe("true");
  });

  /** The production path: buildCtx's labels.crmCoarseStage IS getCrmStageDicts' `coarse`, so the targets
   *  the reverse reads must be registered by getCrmStageDicts itself, not only by the pure builder. */
  it("getCrmStageDicts registers the coarse targets beside the dictionary it returns", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: PIPELINES }), { status: 200 })));
    const d = await getCrmStageDicts({ HUBSPOT_ACCESS_TOKEN: "test" } as unknown as Env);
    expect(coarseTargetsFor(d.coarse)).toEqual(EXPECTED_TARGETS);
    expect(d.stages.closedwon).toBe("Sales / Closed Won");
    expect(d.pipelineByStage.closedwon).toBe("default");
    expect(d.coarse.closedwon).toBe("Won");
  });
});
