import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS } from "../src/config/crm";
import { expectedText, itemName } from "../src/mapping";
import type { Ctx, Env, FieldSpec, HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * LEAVING "No Activity - 未跟进" WHEN THE CARD IS WORKED (no-activity.ts, NO_ACTIVITY_RELEASE).
 *
 * The report (John, 2026-10-09): Elaine moved Ivan's Lifecycle to 10.Other and Lead Status to In Progress
 * on 5 Oct, and the card sat in "No Activity" until hiffer dragged it out on 9 Oct. Driven through the real
 * syncMondayItem / syncHubspotRecord with HubSpot and monday mocked, so every claim is proven by the presence
 * or absence of an actual move_item_to_group.
 *
 * And the other half, which matters as much: the Worker still never moves a card for any other reason --
 * not an ordinary edit, not a value that merely sits there, not a card in any other group.
 */

const NO_ACTIVITY = "group_mm7cj2yx";
const ACTIVE = "topics";

const LIFECYCLE: Record<string, string> = {
  lead: "1.NEW", "1029059095": "6.Not in contact/Pending further contact", opportunity: "7.Intention to purchase",
  "1135842429": "10.Other",
};
const LEAD: Record<string, string> = {
  NEW: "New", IN_PROGRESS: "In Progress", OPEN_DEAL: "Open Deal", ATTEMPTED_TO_CONTACT: "Attempted to Contact",
};

const MOD = "2026-10-05T08:00:00Z";
const NEWER = "2026-10-05T08:17:40Z";
const PUSHED = "2026-10-05T08:17:46Z";
const PRE = "2026-09-10T06:42:36Z";
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(), getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(), gql: vi.fn(),
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
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
}));
const ensure = vi.hoisted(() => ({ ensureCardForRecord: vi.fn() }));

vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", () => ({ ...hubspot, OwnershipError: class extends Error {} }));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ensure);

const { syncMondayItem, syncHubspotRecord, resetCtxCache } = await import("../src/sync");
const { isWorkedLabel, workedColumns, noActivityReleaseOn, releaseWorkedCard } = await import("../src/no-activity");

const base = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const on = { ...base, NO_ACTIVITY_RELEASE: "true" } as unknown as Env;
const off = base as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  monday.getUsersByEmail.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  monday.moveItem.mockResolvedValue(undefined);
  monday.findItemByColumn.mockResolvedValue([]);
  hubspot.getOwners.mockResolvedValue({});
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.patchRecord.mockResolvedValue(PUSHED);
  hubspot.claimOwnership.mockResolvedValue(PUSHED);
  hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, object: string, prop: string) =>
    object !== "contacts" ? {} : prop === "lifecyclestage" ? LIFECYCLE : prop === "hs_lead_status" ? LEAD : {});
  assoc.reverseAssociations.mockResolvedValue(undefined);
  registry.lookupCard.mockResolvedValue(null);
});

const f = (spec: ObjectSpec, hs: string): FieldSpec => spec.fields.find(y => y.hs === hs)!;
const life = f(CRM_CONTACTS, "lifecyclestage");
const lead = f(CRM_CONTACTS, "hs_lead_status");
const job = f(CRM_CONTACTS, "jobtitle");

/** Ivan, 2856378306, as HubSpot held her before Elaine's edit. */
const pavlina = (over: Record<string, string> = {}): HsRecord => ({
  id: "551203987421",
  properties: { firstname: "Ivan", lastname: "", lifecyclestage: "lead", hs_lead_status: "", jobtitle: "Buyer",
    createdate: PRE, lastmodifieddate: MOD, ...over },
});

function card(rec: HsRecord, text: Record<string, string> = {}, group = NO_ACTIVITY): MondayItem {
  const ctx = { labels: { lifecycleStage: LIFECYCLE, leadStatus: LEAD }, ownersById: {}, mondayUsersByEmail: {} } as unknown as Ctx;
  const cv: MondayItem["column_values"] = [
    { id: CRM_CONTACTS.idCol, text: rec.id }, { id: CRM_CONTACTS.syncStateCol, text: MOD },
  ];
  for (const fs of CRM_CONTACTS.fields) {
    if (fs.type === "people") continue;
    const t = expectedText(fs, rec.properties[fs.hs], ctx);
    if (t !== null) cv.push({ id: fs.col, text: t, ...(fs.type === "status" ? { status_index: t ? 1 : null } : {}) });
  }
  for (const [col, t] of Object.entries(text)) {
    const hit = cv.find(c => c.id === col);
    if (hit) { hit.text = t; if ("status_index" in hit) hit.status_index = t ? 1 : null; } else cv.push({ id: col, text: t });
  }
  return { id: "2856378306", name: itemName(rec, CRM_CONTACTS), created_at: PRE, updated_at: MOD, group: { id: group }, column_values: cv };
}

const moved = () => monday.moveItem.mock.calls.map(c => ({ board: c[1], item: c[2], to: c[3] }));

/** A person's monday edit of `cols`, as the webhook delivers it (or an automation's, with byAutomation). */
async function personEdit(env: Env, rec: HsRecord, item: MondayItem, cols: string[], byAutomation = false) {
  monday.getItem.mockResolvedValue(item);
  hubspot.getRecord.mockResolvedValue(rec);
  return syncMondayItem(env, CRM_CONTACTS.boardId, item.id, live, { left: 30 }, false, false,
    { cols, ...(byAutomation ? { byAutomation: true } : {}) });
}

/** A HubSpot change arriving by webhook, for a card monday last synced at MOD (`force`: the /resync repair). */
async function hubspotChange(env: Env, before: HsRecord, now: HsRecord, group = NO_ACTIVITY, force = false) {
  monday.findItemByColumn.mockResolvedValue([card(before, {}, group)]);
  hubspot.getRecord.mockResolvedValue(now);
  return syncHubspotRecord(env, CRM_CONTACTS, now.id, live, { left: 30 }, undefined, force);
}

// ===================================================================================================
describe("what counts as worked", () => {
  it("Lifecycle: any stage but 1.NEW; Lead Status: any status but New; empty never", () => {
    expect(isWorkedLabel(CRM_CONTACTS, life.col, "1.NEW")).toBe(false);
    expect(isWorkedLabel(CRM_CONTACTS, life.col, "")).toBe(false);
    expect(isWorkedLabel(CRM_CONTACTS, life.col, "10.Other")).toBe(true);
    expect(isWorkedLabel(CRM_CONTACTS, life.col, "6.Not in contact/Pending further contact")).toBe(true);
    expect(isWorkedLabel(CRM_CONTACTS, lead.col, "New")).toBe(false);
    expect(isWorkedLabel(CRM_CONTACTS, lead.col, null)).toBe(false);
    expect(isWorkedLabel(CRM_CONTACTS, lead.col, "Attempted to Contact")).toBe(true);
  });

  it("no other column ever counts, and no other spec has the rule", () => {
    expect(isWorkedLabel(CRM_CONTACTS, job.col, "anything")).toBe(false);
    expect(isWorkedLabel(CRM_ACCOUNTS, life.col, "10.Other")).toBe(false);
    expect(CRM_ACCOUNTS.leaveWhenWorked).toBeUndefined();
  });

  it("workedColumns keeps only worked changes, once each", () => {
    expect(workedColumns(CRM_CONTACTS, [
      { col: life.col, label: "1.NEW" }, { col: lead.col, label: "In Progress" },
      { col: job.col, label: "CEO" }, { col: lead.col, label: "In Progress" },
    ])).toEqual([lead.col]);
  });

  it("the switch: only the literal \"true\", only on the CRM Worker", () => {
    expect(noActivityReleaseOn({ ENABLE_CRM: "true", NO_ACTIVITY_RELEASE: "true" })).toBe(true);
    for (const v of ["TRUE", "1", "", " true", undefined])
      expect(noActivityReleaseOn({ ENABLE_CRM: "true", NO_ACTIVITY_RELEASE: v })).toBe(false);
    expect(noActivityReleaseOn({ NO_ACTIVITY_RELEASE: "true" })).toBe(false);
  });

  it("the rule names the live groups and labels", () => {
    expect(CRM_CONTACTS.leaveWhenWorked).toEqual({ from: NO_ACTIVITY, to: ACTIVE,
      notWorked: { color_mm70k2wk: ["1.NEW"], color_mm6zb4tc: ["New"] } });
  });
});

// ===================================================================================================
describe("worked in monday: a person's edit", () => {
  it("Ivan: Lifecycle 1.NEW -> 10.Other on a card in No Activity moves it to Active Contacts", async () => {
    const rec = pavlina();
    await personEdit(on, rec, card(rec, { [life.col]: "10.Other" }), [life.col]);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ lifecyclestage: "1135842429" });
    expect(moved()).toEqual([{ board: CRM_CONTACTS.boardId, item: "2856378306", to: ACTIVE }]);
  });

  it("setting a Lead Status moves it", async () => {
    const rec = pavlina();
    await personEdit(on, rec, card(rec, { [lead.col]: "In Progress" }), [lead.col]);
    expect(moved()).toHaveLength(1);
  });

  it("but not a Lead Status of New, nor a Lifecycle put back to 1.NEW", async () => {
    let rec = pavlina({ hs_lead_status: "IN_PROGRESS" });
    await personEdit(on, rec, card(rec, { [lead.col]: "New" }), [lead.col]);
    rec = pavlina({ lifecyclestage: "opportunity" });
    await personEdit(on, rec, card(rec, { [life.col]: "1.NEW" }), [life.col]);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("an edit that did not land (refused: the record is the WM Worker's) does not move it", async () => {
    const rec = pavlina({ sync_owner: "wm" });
    await personEdit(on, rec, card(rec, { [life.col]: "10.Other" }), [life.col]);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("an ordinary edit (Job Title) on a card in No Activity leaves it there", async () => {
    const rec = pavlina();
    await personEdit(on, rec, card(rec, { [job.col]: "CEO" }), [job.col]);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a worked value that only SITS on the card (put back by the nightly sweep) is left alone", async () => {
    const rec = pavlina({ hs_lead_status: "OPEN_DEAL" });
    await personEdit(on, rec, card(rec, { [job.col]: "CEO" }), [job.col]);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a card in any other group is never moved", async () => {
    const rec = pavlina();
    await personEdit(on, rec, card(rec, { [life.col]: "10.Other" }, ACTIVE), [life.col]);
    await personEdit(on, rec, card(rec, { [life.col]: "10.Other" }, "new_group95562"), [life.col]);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("switch off: the edit lands, the card stays (today's behaviour exactly)", async () => {
    const rec = pavlina();
    await personEdit(off, rec, card(rec, { [life.col]: "10.Other" }), [life.col]);
    expect(hubspot.patchRecord).toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  /**
   * AN AUTOMATION IS NOT WORK. The board's #08 sets Lead Status to In Progress when Last Activity Date moves --
   * which a customer's own reply does. Its edit lands on a CRM-owned record (automations may write those), and
   * must still leave the card where it is: the inbound reply is the reason a follow-up is owed.
   */
  it("an automation's Lead Status edit lands in HubSpot but does not move the card", async () => {
    const rec = pavlina({ sync_owner: "crm" });
    await personEdit(on, rec, card(rec, { [lead.col]: "In Progress" }), [lead.col], true);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ hs_lead_status: "IN_PROGRESS" });
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a person's Job Title edit that brings HubSpot's newer Lifecycle across DOES move it (HubSpot was worked)", async () => {
    const now = pavlina({ lifecyclestage: "opportunity", lastmodifieddate: NEWER });
    await personEdit(on, now, card(pavlina(), { [job.col]: "CEO" }), [job.col]);
    expect(hubspot.patchRecord.mock.calls[0][3]).toEqual({ jobtitle: "CEO" });
    expect(moved()).toEqual([{ board: CRM_CONTACTS.boardId, item: "2856378306", to: ACTIVE }]);
  });
});

// ===================================================================================================
describe("worked in HubSpot: a change brought across", () => {
  it("Lifecycle moved off lead in HubSpot (a deal was created: opportunity) moves the card", async () => {
    await hubspotChange(on, pavlina(), pavlina({ lifecyclestage: "opportunity", lastmodifieddate: NEWER }));
    expect(monday.updateItem).toHaveBeenCalled();
    expect(moved()).toEqual([{ board: CRM_CONTACTS.boardId, item: "2856378306", to: ACTIVE }]);
  });

  it("a Lead Status set in HubSpot moves the card", async () => {
    await hubspotChange(on, pavlina(), pavlina({ hs_lead_status: "ATTEMPTED_TO_CONTACT", lastmodifieddate: NEWER }));
    expect(moved()).toHaveLength(1);
  });

  it("an unrelated HubSpot change (Job Title) updates the card where it is", async () => {
    await hubspotChange(on, pavlina(), pavlina({ jobtitle: "Head of Buying", lastmodifieddate: NEWER }));
    expect(monday.updateItem).toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a card in Active Contacts is never moved", async () => {
    await hubspotChange(on, pavlina(), pavlina({ lifecyclestage: "opportunity", lastmodifieddate: NEWER }), ACTIVE);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("switch off: the change is applied and the card stays", async () => {
    await hubspotChange(off, pavlina(), pavlina({ lifecyclestage: "opportunity", lastmodifieddate: NEWER }));
    expect(monday.updateItem).toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  /** An operator's forced repair (/resync, refresh-forward.mjs) corrects stale cells; it is not work, and it
   *  promises to move no card. */
  it("the forced repair corrects the stale stage and leaves the card where it is", async () => {
    await hubspotChange(on, pavlina(), pavlina({ lifecyclestage: "opportunity", lastmodifieddate: NEWER }), NO_ACTIVITY, true);
    expect(monday.updateItem).toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });
});

// ===================================================================================================
describe("releaseWorkedCard, on its own", () => {
  it("reads the card's group when the caller does not know it, and moves only from No Activity", async () => {
    monday.gql.mockResolvedValueOnce({ items: [{ group: { id: NO_ACTIVITY } }] });
    expect(await releaseWorkedCard(on, CRM_CONTACTS, "1", undefined, "test", live)).toBe(true);
    monday.gql.mockResolvedValueOnce({ items: [{ group: { id: ACTIVE } }] });
    expect(await releaseWorkedCard(on, CRM_CONTACTS, "2", undefined, "test", live)).toBe(false);
    expect(moved()).toEqual([{ board: CRM_CONTACTS.boardId, item: "1", to: ACTIVE }]);
  });

  it("never throws: a failed move is a log line and the card stays", async () => {
    monday.moveItem.mockRejectedValueOnce(new Error("monday 500"));
    await expect(releaseWorkedCard(on, CRM_CONTACTS, "1", NO_ACTIVITY, "test", live)).resolves.toBe(false);
    monday.gql.mockRejectedValueOnce(new Error("read failed"));
    await expect(releaseWorkedCard(on, CRM_CONTACTS, "1", undefined, "test", live)).resolves.toBe(false);
  });

  it("a spec without the rule, or the switch off: nothing is read or moved", async () => {
    expect(await releaseWorkedCard(on, CRM_ACCOUNTS, "1", undefined, "test", live)).toBe(false);
    expect(await releaseWorkedCard(off, CRM_CONTACTS, "1", undefined, "test", live)).toBe(false);
    expect(monday.gql).not.toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });
});
