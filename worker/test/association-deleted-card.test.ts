import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS, CRM_LINE_ITEMS, CRM_SPECS } from "../src/config/crm";
import type { Env, HsRecord, MondayEdit, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * A DELETED CARD NEVER DELETES AN ASSOCIATION (G4, 2026-09-28).
 *
 * board_relation columns are PAIRED. When a rep deletes (or archives) a Contact card, monday removes it
 * from the Account card's `account_contact` cell as well, and reports that as an ordinary relation
 * change on the ACCOUNT -- previousValue holds the dead card, value does not, and the event is
 * attributed to the rep who deleted. Read naively that is "the person unlinked this contact", and the
 * unlink path would delete the HubSpot association -- while restoreDeletedCard is busy bringing the very
 * same card back from HubSpot, because a monday delete must never delete anything in HubSpot.
 *
 * The same holds for every pair, and one of them costs money: removing a line item from its deal's
 * Line Items cell detaches it in HubSpot and CHANGES THE DEAL AMOUNT. So before any association is
 * deleted, every removed card's own state is read, and only an ACTIVE card can unlink. Unknown state
 * (the id did not come back) is treated as not active -- fail closed, the cost is a missed unlink.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), putAssociationTypes: vi.fn(), deleteAssociation: vi.fn(),
  getAssociatedIds: vi.fn(), getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(),
  getRecord: vi.fn(), getRecordsByIds: vi.fn(async () => []), propertiesForSpec: vi.fn(() => []),
  patchLineItem: vi.fn(), createLineItem: vi.fn(), claimOwnership: vi.fn(),
}));
const monday = vi.hoisted(() => ({
  getLinkedItemIds: vi.fn(), getItemsColumnText: vi.fn(), findItemIdsByColumn: vi.fn(), getItemStates: vi.fn(),
  setColumns: vi.fn(), createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), getItem: vi.fn(),
  getParentItemId: vi.fn(), getSubitems: vi.fn(), updateItem: vi.fn(),
}));
const captured = vi.hoisted(() => ({ edits: [] as any[], restores: [] as any[] }));
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);
vi.mock("../src/ensure-card", () => ({
  ensureCardForRecord: vi.fn(async () => ({ status: "refused" })), cardIdOf: vi.fn(() => null),
}));
vi.mock("../src/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync")>()),
  syncMondayItem: vi.fn(async (_e: any, board: string, itemId: string, _o: any, _b: any, _a: any, _s: any, edit: any) => {
    captured.edits.push({ board, itemId, edit }); return "ok";
  }),
}));
vi.mock("../src/restore-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/restore-card")>()),
  restoreDeletedCard: vi.fn(async (_e: any, spec: ObjectSpec, itemId: string) => {
    captured.restores.push({ board: spec.boardId, itemId }); return "restoring";
  }),
}));
vi.mock("../src/actor-label", () => ({
  actorLabel: async () => "user=test", isIntegrationActor: async () => false,
  isAutomationActor: (u: string) => /^-\d+$/.test(String(u)),
}));

const { reverseAssociations, MAX_UNLINKS_PER_EDIT } = await import("../src/associations");
const { handleMonday } = await import("../src/webhooks");
const { ensureCardForRecord } = await import("../src/ensure-card");

const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const OLD = "2026-01-22T06:46:54Z";
const PERSON = 102444897;
const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;

// Every card this suite touches, and the HubSpot id its board's id column holds.
const BULK = ["7101", "7102", "7103", "7104", "7105", "7106"];           // one more than MAX_UNLINKS_PER_EDIT
const HS_OF: Record<string, string> = { "7001": "31125660999", "7002": "40000000002",
  ...Object.fromEntries(BULK.map(c => [c, `5000000${c}`])) };
let STATE: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
  captured.edits = []; captured.restores = []; waits.length = 0;
  STATE = { "7001": "active", "7002": "active" };
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? ""])));
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.filter(id => STATE[id]).map(id => [id, STATE[id]])));
  monday.findItemIdsByColumn.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  monday.getLinkedItemIds.mockResolvedValue(["7001"]);            // 7002 has left the cell
  hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999", "40000000002"], truncated: false });
  hs.deleteAssociation.mockResolvedValue(true);
  hs.claimOwnership.mockResolvedValue("2026-09-28T09:00:00Z");
});

const rec = (id: string): HsRecord => ({ id, properties: { createdate: OLD } });
const itemOf = (id: string): MondayItem =>
  ({ id, name: "x", created_at: OLD, updated_at: "", group: { id: "topics" }, column_values: [] as never });
const unlink = (spec: ObjectSpec, col: string, removed: string[]) =>
  reverseAssociations(env, spec, rec("900"), itemOf("5001"), live, { left: 30 },
    { onlyCols: new Set([col]), basis: "human-edit", unlinked: { [col]: removed }, linked: { [col]: [] } });

// The relation pairs whose unlink reaches HubSpot, spec by spec.
const PAIRS: [string, ObjectSpec, string][] = [
  ["Contacts -> Accounts", CRM_CONTACTS, "contact_account"],
  ["Accounts -> Contacts", CRM_ACCOUNTS, "account_contact"],
  ["Deals -> Contacts", CRM_DEALS, "deal_contact"],
  ["Deals -> Accounts", CRM_DEALS, "board_relation_mm76wp4e"],
  ["Deals -> Line Items (changes the deal amount)", CRM_DEALS, "board_relation_mm76btmt"],
  ["Line Items -> Deal (changes the deal amount)", CRM_LINE_ITEMS, "board_relation_mm76w9y5"],
];

describe("a removed card that is not active never deletes an association", () => {
  it.each(PAIRS)("%s: the removed card was DELETED -> no deleteAssociation", async (_l, spec, col) => {
    STATE["7002"] = "deleted";
    await unlink(spec, col, ["7002"]);
    expect(monday.getItemStates).toHaveBeenCalledWith(env, ["7002"]);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it.each(PAIRS)("%s: the removed card was ARCHIVED -> no deleteAssociation", async (_l, spec, col) => {
    STATE["7002"] = "archived";
    await unlink(spec, col, ["7002"]);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it.each(PAIRS)("%s: the card's state did not come back -> fail closed, nothing deleted", async (_l, spec, col) => {
    delete STATE["7002"];
    await unlink(spec, col, ["7002"]);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it.each(PAIRS)("%s: an ACTIVE card the person unlinked IS deleted (the control)", async (_l, spec, col) => {
    await unlink(spec, col, ["7002"]);
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
    expect(hs.deleteAssociation.mock.calls[0][4]).toBe("40000000002");
  });

  it("a mixed edit: the deleted card is kept, the active one unlinks", async () => {
    STATE["7001"] = "deleted";
    monday.getLinkedItemIds.mockResolvedValue([]);
    await unlink(CRM_CONTACTS, "contact_account", ["7001", "7002"]);
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
    expect(hs.deleteAssociation.mock.calls[0][4]).toBe("40000000002");
  });

  it("a deleted card is not a refusal: the cell is not rewritten (restore owns putting it back)", async () => {
    STATE["7002"] = "deleted";
    await unlink(CRM_CONTACTS, "contact_account", ["7002"]);
    expect(monday.setColumns).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------ bulk deletes
/**
 * A BULK DELETE IS NOT A REFUSAL. A person deleting six contacts off one Account produces six removals
 * that coalesce into one run. When the cap was judged BEFORE the state read, that run was "six links
 * removed in one edit": refused, and snapped back -- creating cards on demand for the very ids
 * restoreDeletedCard was busy re-creating. The state is now read first, and the cap and budget judge
 * only the cards that still exist.
 */
describe("a bulk delete over the cap: the states are read first", () => {
  const bulkUnlink = (removed: string[], budget = 30, largest?: number) =>
    reverseAssociations(env, CRM_ACCOUNTS, rec("900"), itemOf("5001"), live, { left: budget },
      { onlyCols: new Set(["account_contact"]), basis: "human-edit",
        unlinked: { account_contact: removed }, linked: { account_contact: [] },
        ...(largest ? { largestEvent: { account_contact: { added: 0, removed: largest } } } : {}) });

  beforeEach(() => {
    for (const c of BULK) STATE[c] = "deleted";
    hs.getAllAssociatedIds.mockResolvedValue({ ids: Object.values(HS_OF), truncated: false });
  });

  it(`${BULK.length} deleted cards (> ${MAX_UNLINKS_PER_EDIT}) -> no delete, no rewrite, no card created`, async () => {
    expect(BULK.length).toBeGreaterThan(MAX_UNLINKS_PER_EDIT);
    await bulkUnlink(BULK);
    expect(monday.getItemStates).toHaveBeenCalledWith(env, BULK);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
    expect(ensureCardForRecord).not.toHaveBeenCalled();
    expect(hs.claimOwnership).not.toHaveBeenCalled();
  });

  it("...and the same with the budget already spent: still not a refusal", async () => {
    await bulkUnlink(BULK, 0);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
  });

  it("five deleted and one ACTIVE card in one click -> the active one unlinks (the cap counts live cards)", async () => {
    STATE["7106"] = "active";
    await bulkUnlink(BULK, 30, BULK.length);
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
    expect(hs.deleteAssociation.mock.calls[0][4]).toBe(HS_OF["7106"]);
    expect(monday.setColumns).not.toHaveBeenCalled();
  });

  it("six ACTIVE cards removed in one click is still over the cap -> refused and undone (the control)", async () => {
    for (const c of BULK) STATE[c] = "active";
    await bulkUnlink(BULK, 30, BULK.length);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    const writes = monday.setColumns.mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0][3]).toEqual({ account_contact: { item_ids: [7001, ...BULK.map(Number)] } });
    expect(ensureCardForRecord).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------ the derived cell
/**
 * G4 ON THE DERIVED P&S "Accounts/Companies" CELL. Deleting an Account removes it from the derived cell
 * of every line item it showed on, one event per line item. None of those is an edit of the line item,
 * so none may be refused or snapped back (one snap-back per line item, each racing restore).
 */
describe("the derived P&S Accounts cell: a deleted Account is not an edit", () => {
  const PS = "board_relation_mm7cz3v8";
  const on = { ...env, PS_ACCOUNT_REVERSE: "true" } as unknown as Env;
  const derived = (e: Env, removed: string[]) =>
    reverseAssociations(e, CRM_LINE_ITEMS, rec("9956357489"), itemOf("5001"), live, { left: 30 },
      { onlyCols: new Set([PS]), basis: "human-edit", unlinked: { [PS]: removed }, linked: { [PS]: [] } });

  beforeEach(() => {
    hs.getAssociatedVia.mockResolvedValue({ ids: ["40000000002"], truncated: false });
    monday.getLinkedItemIds.mockResolvedValue([]);
  });

  it.each([["flag off", env], ["flag on", on]])("%s: no refusal, no snap-back, no card, no HubSpot write", async (_l, e) => {
    STATE["7002"] = "deleted";
    await derived(e, ["7002"]);
    expect(monday.getItemStates).toHaveBeenCalledWith(e, ["7002"]);
    expect(monday.setColumns).not.toHaveBeenCalled();
    expect(ensureCardForRecord).not.toHaveBeenCalled();
    expect(hs.getAssociatedVia).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it("an ACTIVE Account a person removed is still refused and put back (the control)", async () => {
    await derived(on, ["7002"]);
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(monday.setColumns.mock.calls).toEqual([[on, CRM_LINE_ITEMS.boardId, "5001", { [PS]: { item_ids: [7002] } }, live]]);
  });
});

// ------------------------------------------------------------------------------ the whole sequence
/**
 * THE restoreOnDelete SEQUENCE, end to end through the webhook. All four CRM specs opt into restore,
 * so a deletion on any board produces the two events below: the deletion itself on the card's own
 * board (-> restoreDeletedCard), and the paired relation change on the card it was linked to.
 */
describe("the restoreOnDelete sequence never unlinks in HubSpot", () => {
  it("every CRM spec opts into restore-on-delete", () => {
    for (const s of CRM_SPECS) expect(s.restoreOnDelete).toBe(true);
  });

  const post = (event: Record<string, unknown>) => handleMonday(new Request("https://w/webhooks/monday",
    { method: "POST", body: JSON.stringify({ event }) }), env, ectx);
  const L = (...ids: number[]) => ({ linkedPulseIds: ids.map(linkedPulseId => ({ linkedPulseId })) });

  // [label, the deleted card's spec, the spec of the card it was linked to, that card's relation column]
  const SEQ: [string, ObjectSpec, ObjectSpec, string][] = [
    ["a Contact deleted, seen from its Account", CRM_CONTACTS, CRM_ACCOUNTS, "account_contact"],
    ["an Account deleted, seen from its Contact", CRM_ACCOUNTS, CRM_CONTACTS, "contact_account"],
    ["a Line Item deleted, seen from its Deal", CRM_LINE_ITEMS, CRM_DEALS, "board_relation_mm76btmt"],
    ["a Deal deleted, seen from its Line Item", CRM_DEALS, CRM_LINE_ITEMS, "board_relation_mm76w9y5"],
  ];

  it.each(SEQ)("%s: the card is restored, and the paired unlink deletes nothing", async (_l, deleted, other, col) => {
    STATE["7002"] = "deleted";
    // 1. the deletion on the card's own board
    await post({ boardId: deleted.boardId, pulseId: 7002, type: "delete_pulse", userId: PERSON });
    // 2. monday's paired removal on the other card, attributed to the same person
    await post({ boardId: other.boardId, pulseId: 5001, type: "update_column_value", columnId: col,
      userId: PERSON, previousValue: L(7001, 7002), value: L(7001) });
    await Promise.all(waits);

    expect(captured.restores).toEqual([{ board: deleted.boardId, itemId: "7002" }]);
    expect(captured.edits).toHaveLength(1);
    const edit: MondayEdit = captured.edits[0].edit;
    expect(edit.unlinked).toEqual({ [col]: ["7002"] });

    // Feed the webhook's own edit to the real reverse pass, as syncMondayItem does.
    await reverseAssociations(env, other, rec("900"), itemOf("5001"), live, { left: 30 },
      { onlyCols: new Set(edit.cols), basis: "human-edit", unlinked: edit.unlinked, linked: edit.linked, actor: edit.actor });
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});
