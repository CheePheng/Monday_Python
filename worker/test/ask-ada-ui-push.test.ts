import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import { expectedText, itemName } from "../src/mapping";
import type { Ctx, Env, HsRecord, MondayItem } from "../src/types";

/**
 * ASK_ADA_UI_EDITS END TO END: a person logged in as the token user changes Lifecycle Stage in the
 * monday UI, and the webhook -> ui-actor -> the REAL syncMondayItem -> reconcileRecord path claims the
 * record on the person's edit and PATCHes HubSpot. The same event proven an API write (the Worker's own)
 * pushes nothing, and with the flag off nothing is looked up and nothing is pushed -- today's behaviour.
 *
 * Only monday and HubSpot are mocked (plus actor resolution's whoAmI, which lives in monday.ts), so each
 * claim is proven by the presence or absence of an actual API call.
 */

const ASK_ADA = "104118038";
const LIFECYCLE: Record<string, string> = {
  lead: "1.NEW", opportunity: "7.Intention to purchase", customer: "8.The customer generating the transaction",
};
const MOD = "2026-09-20T02:00:00Z";
const PUSHED = "2026-10-01T02:11:45Z";
const PRE = "2026-01-22T06:46:54Z";

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(), getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(),
  gql: vi.fn(), whoAmI: vi.fn(), getUserById: vi.fn(),
}));
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
  getOwners: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(), patchRecord: vi.fn(),
  searchCompanyByDomain: vi.fn(), propertiesForSpec: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({ reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn() }));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(), noteCreateWindowEdit: vi.fn(),
}));
vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", () => ({ ...hubspot, OwnershipError: class extends Error {} }));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ({ ensureCardForRecord: vi.fn() }));

const { handleMonday } = await import("../src/webhooks");
const { resetCtxCache } = await import("../src/sync");
const { resetUiActorCache, uiActorTiming } = await import("../src/ui-actor");

const LIFE = CRM_CONTACTS.fields.find(f => f.hs === "lifecyclestage")!;
const ITEM = "2866357137";
const label = (index: number, text: string) => ({ post_id: null, label: { is_done: false, index, style: {}, text } });

const rec: HsRecord = { id: "394787683005", properties: {
  firstname: "Paul", lastname: "Dunn", email: "paul@example.com", lifecyclestage: "lead",
  createdate: PRE, lastmodifieddate: MOD } };

/** The card as synced from `rec` at MOD, with the person's new Lifecycle Stage on it. */
function card(): MondayItem {
  const ctx = { labels: { lifecycleStage: LIFECYCLE }, ownersById: {}, mondayUsersByEmail: {} } as unknown as Ctx;
  const cv: MondayItem["column_values"] = [{ id: CRM_CONTACTS.idCol, text: rec.id }, { id: CRM_CONTACTS.syncStateCol, text: MOD }];
  for (const fs of CRM_CONTACTS.fields) {
    if (fs.type === "people") continue;
    const t = expectedText(fs, rec.properties[fs.hs], ctx);
    if (t !== null) cv.push({ id: fs.col, text: t });
  }
  cv.find(c => c.id === LIFE.col)!.text = "7.Intention to purchase";
  return { id: ITEM, name: itemName(rec, CRM_CONTACTS), created_at: PRE, updated_at: MOD, group: { id: "topics" }, column_values: cv };
}

const EV = { boardId: Number(CRM_CONTACTS.boardId), pulseId: Number(ITEM), type: "update_column_value",
  columnId: LIFE.col, userId: Number(ASK_ADA), changedAt: 1790820702.3, triggerTime: "2026-10-01T02:11:42.512Z",
  value: label(7, "7.Intention to purchase"), previousValue: label(1, "1.NEW") };
/** The log row of that change; `ms` = its created_at (default: exactly the event's changedAt). */
const row = (uuid: string | null, ms = EV.changedAt * 1000) => ({ event: "update_column_value", user_id: ASK_ADA,
  created_at: String(Math.round(ms * 1e4)),
  data: JSON.stringify({ pulse_id: Number(ITEM), column_id: LIFE.col, action_record_uuid: uuid,
    value: label(7, "7.Intention to purchase"), previous_value: label(1, "1.NEW") }) });

const env = (flag?: string) => ({ ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z", DRY_RUN: "false",
  WRITE_HUBSPOT: "true", ...(flag === undefined ? {} : { ASK_ADA_UI_EDITS: flag }) } as unknown as Env);

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const post = (e: Env, ev: unknown) => handleMonday(new Request("https://w/webhooks/monday", { method: "POST",
  body: JSON.stringify({ event: ev }) }), e, ectx);
const drain = async () => { while (waits.length) await Promise.allSettled(waits.splice(0)); };
const fire = async (e: Env) => {
  const res = await post(e, EV);
  await drain();
  return res;
};
let logs: string[];
const logCalls = () => monday.gql.mock.calls.filter(c => String(c[1]).includes("activity_logs"));

let logRows: unknown[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  resetUiActorCache();
  Object.assign(uiActorTiming, { backoffMs: [0, 0], settleMs: 0 });
  waits.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  monday.whoAmI.mockResolvedValue(ASK_ADA);
  monday.getUserById.mockResolvedValue({ name: "ask ada", email: "ask@ada.example" });
  monday.gql.mockImplementation(async (_e: unknown, q: string) => {
    if (!q.includes("activity_logs")) throw new Error("unexpected monday query");
    return { boards: [{ activity_logs: logRows }] };
  });
  monday.getUsersByEmail.mockResolvedValue({});
  monday.getItem.mockResolvedValue(card());
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  monday.moveItem.mockResolvedValue(undefined);
  monday.findItemByColumn.mockResolvedValue([]);
  hubspot.getOwners.mockResolvedValue({});
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.getRecord.mockResolvedValue(rec);
  hubspot.patchRecord.mockResolvedValue(PUSHED);
  hubspot.claimOwnership.mockResolvedValue(PUSHED);
  hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, o: string, p: string) =>
    o === "contacts" && p === "lifecyclestage" ? LIFECYCLE : {});
  assoc.reverseAssociations.mockResolvedValue(undefined);
  registry.lookupCard.mockResolvedValue(null);
});

describe("a person working as ask ada changes Lifecycle Stage in the monday UI", () => {
  it("flag on + a UI row: claimed on the person's edit (human-edit) and PATCHed to HubSpot", async () => {
    logRows = [row("a671fcec-f9e9-415f-9f52-42364cfdfeb6")];
    const res = await fire(env("true"));
    expect(res.status).toBe(200);
    expect(hubspot.claimOwnership).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ id: rec.id }), expect.objectContaining({ writeHubspot: true }), "human-edit");
    expect(hubspot.patchRecord).toHaveBeenCalledWith(expect.anything(), expect.anything(), rec.id,
      { lifecyclestage: "opportunity" }, expect.objectContaining({ writeHubspot: true }), expect.objectContaining({ allowed: true }));
    expect(logs.some(l => /action=ui-actor class=person/.test(l))).toBe(true);
    expect(logs.some(l => /\[actor\].*who="ask ada \(UI\)"/.test(l))).toBe(true);
    expect(logs.some(l => /action=self-origin/.test(l))).toBe(false);
    expect(logCalls()).toHaveLength(1);
  });

  it("flag on + an API row (the Worker's own write): forward only, nothing written to HubSpot", async () => {
    logRows = [row(null)];
    await fire(env("true"));
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(logs.some(l => /action=self-origin/.test(l))).toBe(true);
  });

  it("flag on + only an OLDER UI row of the same change (this write's own row still lagging): nothing written", async () => {
    // The stale-forward shape seen live on card 2869494680: our write repeats a transition a person made
    // as ask ada 44 s earlier. Matching that old row would PATCH the card's value under a human-edit claim.
    logRows = [row("uuid-of-the-earlier-click", EV.changedAt * 1000 - 44_000)];
    await fire(env("true"));
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(logs.some(l => /action=self-origin/.test(l))).toBe(true);
    expect(logCalls()).toHaveLength(3);
  });

  it("flag on + the log never shows the row: fail closed, nothing written to HubSpot", async () => {
    logRows = [];
    await fire(env("true"));
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(logCalls()).toHaveLength(3);
  });

  it.each([[undefined], ["false"], ["true"]])(
    "flag %s: a REAL person's edit landing while our echo of that column is being classified is PATCHed (R2-A)", async (flag) => {
      // settleMs scaled to 300 ms (production 6,000). t=0: the Worker writes Lifecycle Stage (an API row);
      // t=50 ms: a real person sets it on the same card. Flag on, the echo's lookup used to hold the cell's
      // md:* queue, and the person's edit was re-run as the echo's self-origin closure: never PATCHed.
      Object.assign(uiActorTiming, { settleMs: 300 });
      const e = env(flag);
      const echo = { ...EV, changedAt: Date.now() / 1000, value: label(1, "1.NEW"), previousValue: label(7, "7.Intention to purchase") };
      logRows = [{ event: "update_column_value", user_id: ASK_ADA, created_at: String(Math.round(echo.changedAt * 1e7)),
        data: JSON.stringify({ pulse_id: Number(ITEM), column_id: LIFE.col, action_record_uuid: null,
          value: echo.value, previous_value: echo.previousValue }) }];
      await post(e, echo);
      await new Promise(r => setTimeout(r, 50));
      await post(e, { ...echo, userId: 104231430, changedAt: Date.now() / 1000, value: label(7, "7.Intention to purchase"),
        previousValue: label(1, "1.NEW") });
      await drain();
      expect(hubspot.patchRecord).toHaveBeenCalledTimes(1);
      expect(hubspot.patchRecord).toHaveBeenCalledWith(expect.anything(), expect.anything(), rec.id,
        { lifecyclestage: "opportunity" }, expect.anything(), expect.anything());
      expect(logs.some(l => /coalesced-rerun/.test(l))).toBe(false);
    });

  it("flag on: an ask ada UI link, then a colleague's unlink of that card 50 ms later -- the add is never pushed last (R2-B)", async () => {
    Object.assign(uiActorTiming, { settleMs: 300 });
    const REL = "contact_account";
    const add = { boardId: EV.boardId, pulseId: EV.pulseId, type: "update_column_value", columnId: REL, userId: Number(ASK_ADA),
      changedAt: Date.now() / 1000, value: { linkedPulseIds: [{ linkedPulseId: 9 }] }, previousValue: {} };
    logRows = [{ event: "update_column_value", user_id: ASK_ADA, created_at: String(Math.round(add.changedAt * 1e7)),
      data: JSON.stringify({ pulse_id: Number(ITEM), column_id: REL, action_record_uuid: "uuid-ui-link",
        value: add.value, previous_value: { linkedPulseIds: [] } }) }];
    const e = env("true");
    await post(e, add);
    await new Promise(r => setTimeout(r, 50));
    await post(e, { ...add, userId: 104231430, changedAt: Date.now() / 1000, value: {},
      previousValue: { linkedPulseIds: [{ linkedPulseId: 9 }] } });
    await drain();
    const passes = assoc.reverseAssociations.mock.calls.map(c => {
      const s = c[6] as { linked?: Record<string, string[]>; unlinked?: Record<string, string[]> };
      return `+[${s?.linked?.[REL] ?? "?"}] -[${s?.unlinked?.[REL] ?? ""}]`;
    });
    // Two real persons in the same order give exactly this: the add, then the removal that undoes it.
    expect(passes).toEqual(["+[9] -[]", "+[] -[9]"]);
  });

  it.each([[undefined], ["false"]])("flag %s: no lookup and no push -- today's behaviour", async (flag) => {
    logRows = [row("a671fcec-f9e9-415f-9f52-42364cfdfeb6")];
    await fire(env(flag));
    expect(monday.gql).not.toHaveBeenCalled();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(logs.some(l => /action=self-origin/.test(l))).toBe(true);
  });
});
