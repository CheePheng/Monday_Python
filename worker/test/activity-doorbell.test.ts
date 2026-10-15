import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { readCode, readScript, listSources, readFixture } from "../scripts/read-source.mjs";
import {
  classifyDoorbell, workflowColumnUses, filterCovers, RECIPE_ANY, RECIPE_TYPED, LAD_COL, BELL_COL, DOORBELL_COL,
  BELL_WORKFLOW_ID,
} from "../scripts/check-activity-doorbell.mjs";
import { ALL_SPECS } from "../src/config";
import { CRM_SPECS, CRM_CONTACTS } from "../src/config/crm";

/**
 * THE ACTIVITY DOORBELL, after 2026-09-30.
 *
 * monday has no webhook for a timeline entry, so a rep's native Note or Call reaches HubSpot only when
 * something wakes the Worker for that card. #09/#10 did it by stamping Last Activity Date -- for OUR
 * entries too. Now both are off and workflow 1940472437 stamps a hidden "Activity bell (sync)" column
 * instead, which the Worker never writes. What these pin: the bell wakes the timeline read whoever wrote it, a second ring
 * mid-read is not lost, nothing of ours can write the bell, the Worker's second doorbell (a person
 * touching a Contacts card), and the read-only preflight for the new model.
 */

const actor = vi.hoisted(() => ({
  isIntegrationActor: vi.fn(), isAutomationActor: (id: string) => /^-\d+$/.test(id),
  actorLabel: vi.fn(async () => "actor=x"),
}));
const act = vi.hoisted(() => ({ syncMondayTimeline: vi.fn(async () => "action=done") }));
const sync = vi.hoisted(() => ({
  syncMondayItem: vi.fn(async () => "ok"), syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(),
  getCtxCached: vi.fn(),
}));
vi.mock("../src/actor-label", () => actor);
vi.mock("../src/sync", () => sync);
vi.mock("../src/activity-sync", async (orig) => ({ ...(await orig<any>()), syncMondayTimeline: act.syncMondayTimeline }));

const { ringOnPersonEdit, handleMonday, ACTIVITY_BELL_COL, ACTIVITY_WAKE_COLS, LAST_ACTIVITY_DATE_COL } =
  await import("../src/webhooks");
const env = {} as Env;
const crm = { ENABLE_CRM: "true", ENABLE_ACTIVITY_SYNC: "true" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  actor.isIntegrationActor.mockReset().mockImplementation(async (_e: Env, id: string) => id === "999");
  act.syncMondayTimeline.mockReset().mockResolvedValue("action=done");
});

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
/** Fire one monday column event; resolves when the handler has answered (NOT when its work is done). */
const ring = (col: string, userId: string | number, item = "2855736188", board = CRM_CONTACTS.boardId, e = crm) =>
  handleMonday(new Request("https://w/webhooks/monday", { method: "POST", body: JSON.stringify({ event: {
    boardId: Number(board), pulseId: Number(item), type: "update_column_value", columnId: col, userId,
    value: { date: "2026-09-30" }, previousValue: { date: "2026-09-29" } } }) }), e, ectx);
const settle = async () => { await Promise.all(waits.splice(0)); };

describe("the Activity bell (date_mm7pw446)", () => {
  it("is one of the wake-up columns, beside Last Activity Date (kept for safety)", () => {
    expect(ACTIVITY_BELL_COL).toBe("date_mm7pw446");
    expect([...ACTIVITY_WAKE_COLS].sort()).toEqual([LAST_ACTIVITY_DATE_COL, ACTIVITY_BELL_COL].sort());
    // The preflight and the Worker must name the same columns.
    expect(BELL_COL).toBe(ACTIVITY_BELL_COL);
    expect(DOORBELL_COL).toBe(ACTIVITY_BELL_COL);
    expect(LAD_COL).toBe(LAST_ACTIVITY_DATE_COL);
    expect(CRM_CONTACTS.fields.find(f => f.hs === "notes_last_updated")?.col).toBe(LAD_COL);
  });

  it.each([
    ["the automation user", -4],
    ["the automation's owner (a person)", 104231431],
    ["our own token (never happens, and would still ring)", 999],
  ])("a bell change written by %s reads that card's timeline", async (_who, user) => {
    const res = await ring(ACTIVITY_BELL_COL, user);
    await settle();
    expect(res.status).toBe(200);
    expect(act.syncMondayTimeline).toHaveBeenCalledTimes(1);   // the bell branch only -- no person-doorbell double
    expect(act.syncMondayTimeline).toHaveBeenCalledWith(crm, "2855736188");
    expect(sync.syncMondayItem).not.toHaveBeenCalled();        // a trigger, never data to reconcile
  });

  it("Last Activity Date still rings, whoever wrote it", async () => {
    await ring(LAST_ACTIVITY_DATE_COL, -4);
    await settle();
    expect(act.syncMondayTimeline).toHaveBeenCalledTimes(1);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
  });

  it("a ring DURING a read is not lost: one trailing re-read, however many rang", async () => {
    let finish!: () => void;
    act.syncMondayTimeline.mockImplementationOnce(() => new Promise<string>(res => { finish = () => res("action=done"); }));
    await ring(ACTIVITY_BELL_COL, -4, "71");
    await new Promise(r => setTimeout(r, 5));
    await ring(ACTIVITY_BELL_COL, -4, "71");            // a second note, logged while the first is pushed
    await ring(ACTIVITY_BELL_COL, -4, "71");            // and a third: still ONE more read
    finish();
    await settle();
    expect(act.syncMondayTimeline).toHaveBeenCalledTimes(2);
  });

  it("is ignored with the activity kill switch off", async () => {
    await ring(ACTIVITY_BELL_COL, -4, "1", CRM_CONTACTS.boardId, { ENABLE_CRM: "true" } as unknown as Env);
    await settle();
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  it("wakes nothing on another board", async () => {
    await ring(ACTIVITY_BELL_COL, -4, "1", "5028000496");   // CRM Accounts
    await settle();
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  /**
   * THE WORKER NEVER WRITES THE BELL. If it did, every HubSpot-side update would ring it and every ring
   * would be ours. Two structural halves: no spec (CRM or Work Management) maps or stamps it, and no
   * source file but webhooks.ts even names it.
   */
  it("no spec maps, stamps or links the bell column", () => {
    const text = JSON.stringify([...CRM_SPECS, ...ALL_SPECS]);
    expect(text).not.toContain(ACTIVITY_BELL_COL);
  });

  it("no source file's CODE but webhooks.ts names it (comments may explain it)", () => {
    const naming = listSources().filter(f => readCode(f).includes("date_mm7pw446"));
    expect(naming).toEqual(["webhooks.ts"]);
    // ...and there only as the constant: nothing hands it to a write.
    const code = readCode("webhooks.ts");
    expect(code.match(/ACTIVITY_BELL_COL/g)?.length).toBe(2);   // its declaration and the wake set
  });

  it("structurally: the bell branch coalesces latest-wins and has no actor check", () => {
    const code = readCode("webhooks.ts");
    const at = code.indexOf("if (ACTIVITY_WAKE_COLS.has(columnId) && spec.boardId === CRM_CONTACTS.boardId)");
    expect(at).toBeGreaterThan(0);
    const branch = code.slice(at, code.indexOf('return new Response("ok");\n  }', at));
    expect(branch).toContain("coalesceLatest(`tl-bell:${itemId}`, () => syncMondayTimeline(env, itemId), { rerunAfterError: true })");
    expect(branch).not.toMatch(/isAutomationActor|isIntegrationActor/);
  });
});

describe("the person doorbell (webhooks.ts ringOnPersonEdit)", () => {
  it("a PERSON's edit on a card reads that card's timeline", async () => {
    await ringOnPersonEdit(env, "2855736188", "104231431");
    expect(act.syncMondayTimeline).toHaveBeenCalledWith(env, "2855736188");
  });

  it("our own token's echo does not ring -- it would ring on every HubSpot-side update", async () => {
    await ringOnPersonEdit(env, "1", "999");
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  it("an automation does not ring, and neither does an unattributed event", async () => {
    await ringOnPersonEdit(env, "1", "-4");
    await ringOnPersonEdit(env, "1", "");
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  it("a burst of edits on one card reads its timeline once", async () => {
    let finish!: () => void;
    act.syncMondayTimeline.mockImplementationOnce(() => new Promise<string>(res => { finish = () => res("x"); }));
    const a = ringOnPersonEdit(env, "7", "104231431");
    const b = ringOnPersonEdit(env, "7", "104231431");
    await new Promise(r => setTimeout(r, 5));
    finish();
    await Promise.all([a, b]);
    expect(act.syncMondayTimeline).toHaveBeenCalledTimes(1);
  });

  it("a person's edit of an ordinary column rings it, through the real handler", async () => {
    await ring("text_mm6tnbhq", 104231431);
    await settle();
    expect(act.syncMondayTimeline).toHaveBeenCalledTimes(1);
  });

  it("structurally: CRM Contacts only, behind the activity kill switch, detached, not for a wake-up column", () => {
    const code = readCode("webhooks.ts");
    const at = code.indexOf("ectx.waitUntil(ringOnPersonEdit(");
    expect(at).toBeGreaterThan(0);
    const guard = code.slice(code.lastIndexOf("if (", at), at);
    expect(guard).toContain("spec.boardId === CRM_CONTACTS.boardId");
    expect(guard).toContain("!ACTIVITY_WAKE_COLS.has(columnId)");
    expect(guard).toContain("activitySyncEnabled(env)");
    // ...and before the create_update branch returns, so a posted update rings too.
    expect(at).toBeLessThan(code.indexOf('if (type === "create_update")'));
  });
});

describe("scripts/check-activity-doorbell.mjs -- the preflight (bell on, Last Activity Date left alone)", () => {
  const writes = (col: string) => ({ "2": { columnId: { columnId: col } } });
  const typed = (title: string, value: any, col = BELL_COL, active = true) => ({ id: 1, active, recipeId: RECIPE_TYPED,
    config: { "1": { activityType: { title, value } }, ...writes(col) } });
  const anyE = (col = BELL_COL, active = true) => ({ id: 2, active, recipeId: RECIPE_ANY, config: writes(col) });

  it("the target state -- #10 on the bell, #09 off -- is PASS (exit 0)", () => {
    const v = classifyDoorbell([anyE(BELL_COL), typed("Any activity", { type: "any" }, LAD_COL, false)]);
    expect(v.verdict).toBe("OK");
    expect(v.exitCode).toBe(0);
    expect(v.rows.map(r => r.kind).sort()).toEqual(["bell", "off"]);
  });

  it("ANY active automation writing Last Activity Date FAILS (exit 3), bell or no bell: marketing stays off", () => {
    expect(classifyDoorbell([anyE(LAD_COL)]).verdict).toBe("LAD-WRITER");
    expect(classifyDoorbell([anyE(BELL_COL), typed("Note", { type: "note" }, LAD_COL)]).exitCode).toBe(3);
    // Even a restricted #09 -- the old "healthy" state -- now fails: the date is HubSpot's.
    expect(classifyDoorbell([typed("Note", { type: "note" }, LAD_COL)]).verdict).toBe("LAD-WRITER");
    // An automation of some other recipe that writes it fails too.
    expect(classifyDoorbell([anyE(BELL_COL), { id: 5, active: true, recipeId: 123, config: writes(LAD_COL) }]).verdict)
      .toBe("LAD-WRITER");
  });

  it("nothing active on the bell is NO-BELL (exit 2) -- today's state until #10 is re-pointed", () => {
    const v = classifyDoorbell([typed("Any activity", { type: "any" }, LAD_COL, false), anyE(LAD_COL, false)]);
    expect(v.verdict).toBe("NO-BELL");
    expect(v.exitCode).toBe(2);
    expect(classifyDoorbell([anyE(BELL_COL, false)]).verdict).toBe("NO-BELL");
  });

  it("a #09-recipe bell counts, says which types it covers, and FAILS (exit 5) when Call summary is missing", () => {
    const v = classifyDoorbell([typed("Note", { type: "note" }, BELL_COL)]);
    expect(v.verdict).toBe("BELL-PARTIAL");
    expect(v.exitCode).toBe(5);
    expect(v.rows[0].why).toContain("Note");
    expect(v.rows[0].why).toContain("Call summary");
    expect(classifyDoorbell([typed("Any activity", { type: "any", name: "Any activity" }, BELL_COL)]).verdict).toBe("OK");
  });

  it("a multi-action recipe writing Last Activity Date in block 3 is still a writer (every block but the trigger's)", () => {
    const v = classifyDoorbell([anyE(BELL_COL),
      { id: 11, active: true, recipeId: 555, config: { "1": { boardId: 1 }, "2": { columnId: "date_other" }, "3": { columnId: LAD_COL } } }]);
    expect(v.verdict).toBe("LAD-WRITER");
    // ...but a column named only in the trigger block is not a write.
    expect(classifyDoorbell([anyE(BELL_COL),
      { id: 12, active: true, recipeId: 555, config: { "1": { columnId: LAD_COL }, "2": { columnId: "date_other" } } }]).verdict).toBe("OK");
  });

  it("more automations than the pages read is INCOMPLETE (exit 4): a writer may be unread, marketing stays off", () => {
    const v = classifyDoorbell([anyE(BELL_COL)], [], { complete: false });
    expect(v.verdict).toBe("INCOMPLETE");
    expect(v.exitCode).toBe(4);
    expect(classifyDoorbell([anyE(LAD_COL)], [], { complete: false }).verdict).toBe("LAD-WRITER");   // still outranks
  });

  it("a bell written by some other trigger is surfaced for a human, never counted", () => {
    const v = classifyDoorbell([{ id: 7, active: true, recipeId: 999, config: writes(BELL_COL) }]);
    expect(v.rows[0].kind).toBe("review");
    expect(v.verdict).toBe("NO-BELL");
  });

  it("an automation that writes some OTHER column is neither", () =>
    expect(classifyDoorbell([anyE("date_other")]).rows).toEqual([]));

  it("a workflow mentioning Last Activity Date in no block it can resolve fails closed", () => {
    const v = classifyDoorbell([anyE(BELL_COL)], [{ id: 9, active: true, description: "x",
      workflow_blocks: [{ title: "When activity created" }], workflow_variables: [{ config: { value: LAD_COL } }] }]);
    expect(v.verdict).toBe("LAD-WRITER");
    expect(v.rows.find(r => r.id === 9)?.why).toMatch(/fail closed/);
  });

  it("a workflow that only mentions the bell (no block writes it) is shown but never makes a PASS", () => {
    const v = classifyDoorbell([], [{ id: 9, active: true, workflow_blocks: [{ title: "When activity created" }],
      workflow_variables: [{ config: { value: BELL_COL } }] }]);
    expect(v.rows[0].kind).toBe("review");
    expect(v.verdict).toBe("NO-BELL");
  });

  it("filterCovers: Note AND Call summary, or Any activity; an unstated filter is not assumed to cover", () => {
    expect(filterCovers("Any activity").ok).toBe(true);
    expect(filterCovers("Note, Call summary").ok).toBe(true);
    expect(filterCovers("Note")).toMatchObject({ ok: false, missing: ["Call summary"] });
    expect(filterCovers("").ok).toBe(false);
  });

  it("pages board_automations with its cursor", () => {
    const code = readScript("check-activity-doorbell.mjs");
    expect(code).toMatch(/board_automations\(board_ids: \$b, limit: 100, cursor: \$c\)/);
    expect(code).toContain("complete: !cursor");
  });

  it("is read-only: a query, never a mutation", () => {
    const code = readScript("check-activity-doorbell.mjs");
    expect(code).not.toMatch(/\bmutation\s*[({]/);
    expect(code).toContain("board_automations");
  });
});

/**
 * THE LIVE BOARD, 2026-09-30 (board_automations on Contacts 5028000495, read-only; icons dropped and the
 * e-mail recipients redacted). The text-search classifier got it wrong both ways: the bell (a WORKFLOW)
 * was NO-BELL, and the reminders that only READ Last Activity Date made it LAD-WRITER.
 */
describe("check-activity-doorbell.mjs on the live automations' real shapes", () => {
  const live = readFixture("contacts-automations-2026-09-30.json");
  const REMINDERS = ["1940356394", "1940356403", "1940356127"];   // #03 #04 #05
  const ON_08 = "1940358044", ON_06 = "1940357873";
  const withActive = (ids: string[]) => live.items.map((w: any) => ids.includes(String(w.id)) ? { ...w, active: true } : w);

  it("resolves each block's column through workflow_variables, by role", () => {
    const bell = live.items.find((w: any) => String(w.id) === BELL_WORKFLOW_ID);
    expect(workflowColumnUses(bell)).toEqual([expect.objectContaining({ role: "action", title: "Set date", col: BELL_COL })]);
    const r03 = live.items.find((w: any) => String(w.id) === "1940356394");
    const lad = workflowColumnUses(r03).filter((u: any) => u.col === LAD_COL);
    expect(lad).toEqual([expect.objectContaining({ role: "condition", title: "If column is empty" })]);
    const w08 = live.items.find((w: any) => String(w.id) === ON_08);
    expect(workflowColumnUses(w08).filter((u: any) => u.col === LAD_COL)).toEqual([expect.objectContaining({ role: "trigger" })]);
    const w06 = live.items.find((w: any) => String(w.id) === ON_06);
    expect(workflowColumnUses(w06).filter((u: any) => u.col === LAD_COL)).toEqual([expect.objectContaining({ role: "action", title: "Set date" })]);
  });

  it("as it is today: the live bell IS counted, and its Note-only filter FAILS as BELL-PARTIAL (not NO-BELL)", () => {
    const v = classifyDoorbell(live.legacy, live.items);
    const bell = v.rows.find(r => String(r.id) === BELL_WORKFLOW_ID)!;
    expect(bell.kind).toBe("bell");
    expect(bell.filter).toBe("Note");
    expect(bell.why).toContain("Call summary");
    expect(v.verdict).toBe("BELL-PARTIAL");
    expect(v.exitCode).toBe(5);
    // #09 and #10 are listed as off; neither counts.
    expect(v.rows.filter(r => r.kind === "off").map(r => String(r.id)).sort()).toEqual(["38839624", "38841239"]);
    expect(v.warnings.join(" ")).toMatch(/UNVERIFIED/);
  });

  it("the reminders #03/#04/#05 and #08 switched on only READ Last Activity Date: no LAD-WRITER", () => {
    const v = classifyDoorbell(live.legacy, withActive([...REMINDERS, ON_08]));
    expect(v.verdict).not.toBe("LAD-WRITER");
    expect(v.rows.filter(r => r.kind === "lad-reader").map(r => String(r.id)).sort()).toEqual([...REMINDERS, ON_08].sort());
  });

  it("#06 switched on ('Set date' on Last Activity Date) IS a writer: marketing stays off", () => {
    const v = classifyDoorbell(live.legacy, withActive([ON_06]));
    expect(v.verdict).toBe("LAD-WRITER");
    expect(v.rows.find(r => String(r.id) === ON_06)?.kind).toBe("lad-writer");
  });

  it("the bell widened to Any activity is PASS, with the automation-quota note", () => {
    const items = live.items.map((w: any) => String(w.id) === BELL_WORKFLOW_ID
      ? { ...w, description: String(w.description).replace("Activity type: Note", "Activity type: Any activity") } : w);
    const v = classifyDoorbell(live.legacy, items);
    expect(v.verdict).toBe("OK");
    expect(v.warnings.join(" ")).toMatch(/quota/);
  });

  it("the bell switched off is NO-BELL", () => {
    const items = live.items.map((w: any) => String(w.id) === BELL_WORKFLOW_ID ? { ...w, active: false } : w);
    expect(classifyDoorbell(live.legacy, items).verdict).toBe("NO-BELL");
  });
});
