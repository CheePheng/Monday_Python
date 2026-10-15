import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS } from "../src/config/crm";
import type { Env, HsRecord, MondayItem, RunOpts } from "../src/types";

/**
 * A RELATION EDIT PUSHES ONLY WHAT THE PERSON ADDED (G1, 2026-09-28).
 *
 * The reverse pass used to read the WHOLE relation cell and PUT every linked card HubSpot did not
 * already have. A cell that had drifted from HubSpot (a link removed in HubSpot that the forward pass
 * had not yet caught up with, a card linked by an old import) was therefore re-asserted the moment a
 * person touched the cell for any reason -- a stale link resurrected in HubSpot by an unrelated click.
 *
 * Now the add side is built the same way the unlink side always was: from monday's own
 * previousValue -> value in the webhook, never from a card read. A card that was already in the cell
 * before the edit is never pushed. An event without a usable before-value pushes nothing and the cell
 * is rewritten from HubSpot (G2), rather than falling back to the whole cell.
 */

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), putAssociationTypes: vi.fn(), deleteAssociation: vi.fn(),
  getAssociatedIds: vi.fn(), getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(),
  getRecord: vi.fn(), getRecordsByIds: vi.fn(async () => []), propertiesForSpec: vi.fn(() => []),
  patchLineItem: vi.fn(), createLineItem: vi.fn(), claimOwnership: vi.fn(),
  // syncMondayItem's own needs, for the plumbing tests at the bottom
  createRecord: vi.fn(), getCrmStageDicts: vi.fn(), getDealStageLabels: vi.fn(), getOwners: vi.fn(),
  getPropertyOptions: vi.fn(), patchRecord: vi.fn(), searchCompanyByDomain: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const monday = vi.hoisted(() => ({
  getLinkedItemIds: vi.fn(), getItemsColumnText: vi.fn(), findItemIdsByColumn: vi.fn(), getItemStates: vi.fn(),
  setColumns: vi.fn(), createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), getItem: vi.fn(),
  getParentItemId: vi.fn(), getSubitems: vi.fn(), updateItem: vi.fn(), findItemByColumn: vi.fn(),
  getBoardItems: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(),
}));
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);
vi.mock("../src/ensure-card", () => ({
  ensureCardForRecord: vi.fn(async () => ({ status: "refused" })), cardIdOf: vi.fn(() => null),
}));
vi.mock("../src/card-registry", () => ({
  lookupCard: vi.fn(async () => null), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
}));

const { reverseAssociations, MAX_LINKS_PER_EDIT } = await import("../src/associations");
const { linkedCardIds, unlinkedCardIds } = await import("../src/webhooks");
const { syncMondayItem } = await import("../src/sync");

const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const COL = "contact_account";                                   // Contacts -> Accounts / Companies
const item: MondayItem = { id: "5001", name: "Omar Ruth", created_at: "2026-01-22T06:46:54Z",
  updated_at: "", group: { id: "topics" }, column_values: [{ id: CRM_CONTACTS.idCol, text: "394787683005" }] as never };
const rec = (p: Record<string, string> = {}): HsRecord =>
  ({ id: "394787683005", properties: { createdate: "2026-01-22T06:46:54Z", ...p } });

// Accounts cards -> HubSpot company ids, as the Accounts board's HubSpot ID column holds them.
const HS_OF: Record<string, string> = { "7001": "31125660999", "7002": "40000000002", "7003": "40000000003" };
const CARD_OF = (ids: string[]) => Object.fromEntries(Object.entries(HS_OF).filter(([, h]) => ids.includes(h)).map(([c, h]) => [h, c]));
const L = (...ids: number[]) => ({ linkedPulseIds: ids.map(linkedPulseId => ({ linkedPulseId })) });

beforeEach(() => {
  vi.clearAllMocks();
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? ""])));
  monday.findItemIdsByColumn.mockImplementation(async (_e: unknown, _b: string, _c: string, ids: string[]) => CARD_OF(ids));
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, "active"])));
  monday.setColumns.mockResolvedValue(undefined);
  hs.getAllAssociatedIds.mockResolvedValue({ ids: [], truncated: false });
  hs.putAssociation.mockResolvedValue(undefined);
  hs.deleteAssociation.mockResolvedValue(true);
  hs.claimOwnership.mockResolvedValue("2026-09-28T09:00:00Z");
});

const relationWrites = () => monday.setColumns.mock.calls.filter(c => COL in (c[3] as object));
const edit = (r: HsRecord, diff: { linked?: string[]; unlinked?: string[] }, extra: Record<string, unknown> = {}) =>
  reverseAssociations(env, CRM_CONTACTS, r, item, live, { left: 30 }, {
    onlyCols: new Set([COL]), basis: "human-edit",
    unlinked: { [COL]: diff.unlinked ?? [] },
    ...(diff.linked ? { linked: { [COL]: diff.linked } } : {}),
    ...extra,
  });

// ------------------------------------------------------------------------------ reading the diff
describe("linkedCardIds -- what the person ADDED, from monday's own before/after", () => {
  const ev = (previousValue: unknown, value: unknown) => ({ previousValue, value });

  it("the first link, previousValue sent as {} (seen live)", () =>
    expect(linkedCardIds(ev({}, L(2862546533)))).toEqual(["2862546533"]));

  it("the first link, previousValue sent as {changed_at} with no linkedPulseIds key (seen live)", () =>
    expect(linkedCardIds(ev({ changed_at: "2026-09-20T08:40:35.689Z" }, L(7)))).toEqual(["7"]));

  it("one added beside an existing one: only the new card", () =>
    expect(linkedCardIds(ev(L(1), { ...L(1, 2), changed_at: "x" }))).toEqual(["2"]));

  it("JSON-string values are read the same", () =>
    expect(linkedCardIds(ev(JSON.stringify(L(1)), JSON.stringify(L(1, 2))))).toEqual(["2"]));

  it("a removal adds nothing (and is still an unlink)", () => {
    expect(linkedCardIds(ev(L(1, 2), L(1)))).toEqual([]);
    expect(unlinkedCardIds(ev(L(1, 2), L(1)))).toEqual(["2"]);
  });

  it("NO previousValue -> null: 'cannot tell', which is not the same as 'added nothing'", () =>
    expect(linkedCardIds({ value: L(1) })).toBeNull());

  /** Never seen live (an empty cell arrives as {} or {changed_at}), so its meaning is an assumption.
   *  Reading it as "empty before" would turn the whole cell into adds -- the push G1 forbids. So the add
   *  side reads it as "cannot tell" (refuse + snap back); the unlink side as "removed nothing". */
  it.each([["null", null], ["the string 'null'", "null"]])(
    "previousValue %s -> the add side cannot tell (null), the unlink side removed nothing", (_l, prev) => {
      expect(linkedCardIds(ev(prev, L(1, 2, 3)))).toBeNull();
      expect(unlinkedCardIds(ev(prev, L(1, 2, 3)))).toEqual([]);
    });

  it.each([["garbage", "not json"], ["a number", 42], ["a malformed list", { linkedPulseIds: "x" }]])(
    "an unreadable side (%s) -> null", (_l, bad) => {
      expect(linkedCardIds(ev(bad, L(1)))).toBeNull();
      expect(linkedCardIds(ev(L(1), bad))).toBeNull();
    });
});

// ------------------------------------------------------------------------------ G1 behaviour
describe("only the added card reaches HubSpot", () => {
  it("STALE cell + one add -> exactly one PUT, for the added card only", async () => {
    // The cell shows 7001 (stale: HubSpot no longer has it) and the person just added 7002.
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7002"]);
    await edit(rec(), { linked: ["7002"] });
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).toHaveBeenCalledWith(env, "contacts", "394787683005", "companies",
      "40000000002", live, CRM_CONTACTS, expect.objectContaining({ allowed: true }));
  });

  it("a stale link is never pushed by an edit that only REMOVED something", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["40000000002"], truncated: false });
    await edit(rec(), { linked: [], unlinked: ["7002"] });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
  });

  it("an added card HubSpot already has -> no PUT, no claim, and nothing is rewritten", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["40000000002"], truncated: false });
    await edit(rec(), { linked: ["7002"] });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(relationWrites()).toEqual([]);
  });

  it("'already associated' is judged on the PAGED read, never the 100-capped one", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7002"]);
    await edit(rec(), { linked: ["7002"] });
    expect(hs.getAllAssociatedIds).toHaveBeenCalledWith(env, "contacts", "394787683005", "companies");
    expect(hs.getAssociatedIds).not.toHaveBeenCalled();
  });

  it("a TRUNCATED association read refuses the push (and a truncated snap-back writes nothing)", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["1"], truncated: true });
    await edit(rec(), { linked: ["7002"] });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(relationWrites()).toEqual([]);
  });

  it("an added card with no HubSpot id yet pushes nothing", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["9999"]);
    await edit(rec(), { linked: ["9999"] });
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});

describe("the cap on adds per edit", () => {
  it(`exactly MAX_LINKS_PER_EDIT (${MAX_LINKS_PER_EDIT}) adds -> all pushed`, async () => {
    const some = Array.from({ length: MAX_LINKS_PER_EDIT }, (_, i) => String(8100 + i));
    for (const c of some) HS_OF[c] = String(60000000000 + Number(c));
    monday.getLinkedItemIds.mockResolvedValue(some);
    await edit(rec(), { linked: some });
    expect(hs.putAssociation).toHaveBeenCalledTimes(MAX_LINKS_PER_EDIT);
  });

  it("one more than the cap -> nothing pushed, and the cell is rewritten from HubSpot", async () => {
    const many = Array.from({ length: MAX_LINKS_PER_EDIT + 1 }, (_, i) => String(8200 + i));
    for (const c of many) HS_OF[c] = String(70000000000 + Number(c));
    monday.getLinkedItemIds.mockResolvedValue(["7001", ...many]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999"], truncated: false });
    await edit(rec(), { linked: many });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(relationWrites()).toEqual([[env, CRM_CONTACTS.boardId, "5001", { [COL]: { item_ids: [7001] } }, live]]);
  });
});

describe("no usable before-value -> refuse and snap back, never fall back to the whole cell", () => {
  it("no PUT, even for a card HubSpot is missing, and the cell is rewritten to HubSpot's set", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999"], truncated: false });
    await edit(rec(), {});                                             // linked absent = cannot tell
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(relationWrites()).toEqual([[env, CRM_CONTACTS.boardId, "5001", { [COL]: { item_ids: [7001] } }, live]]);
  });
});

describe("an automation's relation edit never pushes", () => {
  it("zero HubSpot writes, zero claims, and no rewrite of the cell", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7002"]);
    await edit(rec(), { linked: ["7002"], unlinked: ["7001"] }, { byAutomation: true });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(relationWrites()).toEqual([]);
  });
});

// ------------------------------------------------------------------------------ the plumbing
/**
 * Driven through the real syncMondayItem, so the linked/unlinked diff, the self-origin flag and the
 * automation flag are proven to arrive where they are enforced -- not merely to be enforced when a
 * test hands them over directly.
 */
describe("syncMondayItem carries the diff through, and self-origin / automation write nothing", () => {
  const card: MondayItem = { ...item, column_values: [
    { id: CRM_CONTACTS.idCol, text: "394787683005" }, { id: CRM_CONTACTS.syncStateCol, text: "2026-09-20T02:00:00Z" },
  ] as never };
  beforeEach(() => {
    monday.getItem.mockResolvedValue(card);
    monday.getUsersByEmail.mockResolvedValue({});
    monday.findItemByColumn.mockResolvedValue([]);
    monday.getLinkedItemIds.mockResolvedValue(["7002"]);
    hs.getRecord.mockResolvedValue(rec({ lastmodifieddate: "2026-09-20T02:00:00Z" }));
    hs.getOwners.mockResolvedValue({});
    hs.getPropertyOptions.mockResolvedValue({});
    hs.getDealStageLabels.mockResolvedValue({});
    hs.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  });
  const hubspotWrites = () => [...hs.putAssociation.mock.calls, ...hs.deleteAssociation.mock.calls,
    ...hs.putAssociationTypes.mock.calls, ...hs.patchRecord.mock.calls, ...hs.claimOwnership.mock.calls];
  const theEdit = { cols: [COL], linked: { [COL]: ["7002"] }, unlinked: { [COL]: [] } };

  it("a PERSON's add is pushed (the positive control)", async () => {
    await syncMondayItem(env, CRM_CONTACTS.boardId, "5001", live, { left: 30 }, false, false, theEdit);
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
  });

  it("our own token's event (self-origin) -> zero HubSpot writes", async () => {
    await syncMondayItem(env, CRM_CONTACTS.boardId, "5001", live, { left: 30 }, false, true, theEdit);
    expect(hubspotWrites()).toEqual([]);
  });

  it("an automation's event (userId -4) -> zero HubSpot writes", async () => {
    await syncMondayItem(env, CRM_CONTACTS.boardId, "5001", live, { left: 30 }, false, false,
      { ...theEdit, byAutomation: true });
    expect(hubspotWrites()).toEqual([]);
  });

  const acct: MondayItem = { ...card, column_values: [{ id: CRM_ACCOUNTS.idCol, text: "31125660999" }] as never };
  const acctRec = { id: "31125660999", properties: { createdate: "2026-01-22T06:46:54Z" } };

  it("the Accounts side, as a PERSON: stale cell + one add -> exactly one PUT, for the added contact only", async () => {
    monday.getItem.mockResolvedValue(acct);
    hs.getRecord.mockResolvedValue(acctRec);
    // The cell shows 7001 (stale: HubSpot no longer links it) and the person just added 7003.
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7003"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: [], truncated: false });
    await syncMondayItem(env, CRM_ACCOUNTS.boardId, "5001", live, { left: 30 }, false, false,
      { cols: ["account_contact"], linked: { account_contact: ["7003"] }, unlinked: { account_contact: [] } });
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).toHaveBeenCalledWith(env, "companies", "31125660999", "contacts",
      "40000000003", live, expect.objectContaining({ object: "companies" }), expect.objectContaining({ allowed: true }));
  });

  it("the Accounts side, as our own token (self-origin) -> zero HubSpot writes", async () => {
    monday.getItem.mockResolvedValue(acct);
    hs.getRecord.mockResolvedValue(acctRec);
    await syncMondayItem(env, CRM_ACCOUNTS.boardId, "5001", live, { left: 30 }, false, true,
      { cols: ["account_contact"], linked: { account_contact: ["7003"] } });
    expect(hubspotWrites()).toEqual([]);
  });
});
