import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import type { Env, HsRecord, MondayItem, RunOpts } from "../src/types";

/**
 * A REFUSED RELATION EDIT SNAPS BACK AT ONCE (G2, 2026-09-28).
 *
 * Before this, a refused relation push (the record belongs to WM, the edit was too big, HubSpot said
 * no) only logged. The person's cell kept showing a link HubSpot did not have -- or lacked one it did --
 * until some later HubSpot event happened to run the forward pass, which could be days. The cell looked
 * saved and was not, the exact failure the field path already heals.
 *
 * Now the cell is rewritten from HubSpot's CURRENT set immediately, through a path that deliberately
 * skips two forward-pass guards: clearsFromEmpty (an empty HubSpot set must be able to empty the cell --
 * otherwise a refused FIRST link could never be undone) and shrinksFreshCard (a refused edit on a young
 * card is still refused). Both guards exist to protect against a lagging or partial READ racing a
 * create; here the trigger is a known refusal, not an inference, so they have nothing to protect. The
 * truncation guard is kept: a partial read must never drive a full-replacement write, refusal or not.
 */

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
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);
vi.mock("../src/ensure-card", () => ({
  ensureCardForRecord: vi.fn(async () => ({ status: "refused" })), cardIdOf: vi.fn(() => null),
}));

const { reverseAssociations } = await import("../src/associations");
const { ensureCardForRecord } = await import("../src/ensure-card");

const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const COL = "contact_account";
const OLD = "2026-01-22T06:46:54Z";
const cardAt = (created: string): MondayItem => ({ id: "5001", name: "Omar Ruth", created_at: created,
  updated_at: "", group: { id: "topics" }, column_values: [] as never });
const item = cardAt(OLD);
const rec = (p: Record<string, string> = {}): HsRecord =>
  ({ id: "394787683005", properties: { createdate: OLD, ...p } });
const HS_OF: Record<string, string> = { "7001": "31125660999", "7002": "40000000002" };

beforeEach(() => {
  vi.clearAllMocks();
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? ""])));
  monday.findItemIdsByColumn.mockImplementation(async (_e: unknown, _b: string, _c: string, ids: string[]) =>
    Object.fromEntries(Object.entries(HS_OF).filter(([, h]) => ids.includes(h)).map(([c, h]) => [h, c])));
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, "active"])));
  monday.setColumns.mockResolvedValue(undefined);
  hs.getAllAssociatedIds.mockResolvedValue({ ids: [], truncated: false });
  hs.putAssociation.mockResolvedValue(undefined);
  hs.deleteAssociation.mockResolvedValue(true);
  hs.claimOwnership.mockResolvedValue("2026-09-28T09:00:00Z");
});

const relationWrites = (col = COL) => monday.setColumns.mock.calls.filter(c => col in (c[3] as object));
const rewrittenTo = (ids: number[], col = COL, board = CRM_CONTACTS.boardId, itemId = "5001") =>
  expect(relationWrites(col)).toEqual([[env, board, itemId, { [col]: { item_ids: ids } }, live]]);
const edit = (r: HsRecord, diff: { linked?: string[]; unlinked?: string[] }, it: MondayItem = item) =>
  reverseAssociations(env, CRM_CONTACTS, r, it, live, { left: 30 }, {
    onlyCols: new Set([COL]), basis: "human-edit",
    unlinked: { [COL]: diff.unlinked ?? [] }, linked: { [COL]: diff.linked ?? [] },
  });

describe("refused -> the cell is rewritten from HubSpot immediately", () => {
  it.each(["wm", "hold"])("an ADD refused by ownership (sync_owner=%s) -> rewritten to HubSpot's set", async (stamp) => {
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999"], truncated: false });
    await edit(rec({ sync_owner: stamp }), { linked: ["7002"] });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    rewrittenTo([7001]);
  });

  it("...INCLUDING to the empty set: a refused FIRST link is undone (clearsFromEmpty is bypassed)", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: [], truncated: false });
    await edit(rec({ sync_owner: "wm" }), { linked: ["7002"] });
    rewrittenTo([]);
  });

  it("...and on a card created seconds ago (shrinksFreshCard is bypassed)", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999"], truncated: false });
    await edit(rec({ sync_owner: "wm" }), { linked: ["7002"] }, cardAt(new Date().toISOString()));
    rewrittenTo([7001]);
  });

  it("an UNLINK refused by ownership -> the removed link is put back", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999", "40000000002"], truncated: false });
    await edit(rec({ sync_owner: "wm" }), { unlinked: ["7002"] });
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
    rewrittenTo([7001, 7002]);
  });

  it("the truncation guard still holds: a partial HubSpot read writes nothing, even on a refusal", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999"], truncated: true });
    await edit(rec({ sync_owner: "wm" }), { linked: ["7002"] });
    expect(relationWrites()).toEqual([]);
  });

  it("the cell already matching HubSpot costs no write", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999"], truncated: false });
    await edit(rec({ sync_owner: "wm" }), { linked: ["7002"] });
    expect(relationWrites()).toEqual([]);
  });
});

describe("HubSpot REJECTED the write -> the cell is rewritten too", () => {
  it("a 4xx on the PUT", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7002"]);
    hs.getAllAssociatedIds
      .mockResolvedValueOnce({ ids: ["31125660999"], truncated: false })   // the already-associated check
      .mockResolvedValueOnce({ ids: ["31125660999"], truncated: false });  // the snap-back read
    hs.putAssociation.mockRejectedValue(new Error("hubspot PUT /crm/v4/...: 400 invalid association"));
    await edit(rec(), { linked: ["7002"] });
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
    rewrittenTo([7001]);
  });

  it("a 4xx on the DELETE", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999", "40000000002"], truncated: false });
    hs.deleteAssociation.mockRejectedValue(new Error("hubspot DELETE ...: 403 forbidden"));
    await edit(rec(), { unlinked: ["7002"] });
    rewrittenTo([7001, 7002]);
  });
});

describe("success -> nothing is rewritten", () => {
  it("a pushed add leaves the cell alone (the associationChange webhook refreshes it)", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7002"]);
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999"], truncated: false });
    await edit(rec(), { linked: ["7002"] });
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
    expect(relationWrites()).toEqual([]);
  });

  it("a pushed unlink leaves the cell alone", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    await edit(rec(), { unlinked: ["7002"] });
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
    expect(relationWrites()).toEqual([]);
  });

  it("an edit that changed nothing costs no read and no write", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001"]);
    await edit(rec(), {});
    expect(hs.getAllAssociatedIds).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------ large cells
/**
 * THE SNAP-BACK UNDOES THE DIFF, NOT THE CELL. The first version rewrote the whole cell from HubSpot's
 * set, resolving every id to a card through findItemIdsByColumn -- which returns at most 100. On an
 * Account with 150 contacts, one refused add wrote 130 cards and stripped 20 real links from it (and,
 * through the pairing, from 20 Contact cards), which the 100-capped forward pass could never repair.
 */
describe("a refused edit on a cell with more than 100 links", () => {
  const MANY = Array.from({ length: 150 }, (_, i) => String(9000 + i));        // monday cards
  const hsOfMany = (c: string) => String(60000000000 + Number(c));
  beforeEach(() => {
    monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? (MANY.includes(id) ? hsOfMany(id) : "")])));
    // The real helper's cap: never more than 100 cards back, however many ids are asked for.
    monday.findItemIdsByColumn.mockImplementation(async (_e: unknown, _b: string, _c: string, ids: string[]) =>
      Object.fromEntries(MANY.filter(c => ids.includes(hsOfMany(c))).slice(0, 100).map(c => [hsOfMany(c), c])));
    hs.getAllAssociatedIds.mockResolvedValue({ ids: MANY.map(hsOfMany), truncated: false });
  });

  it("one refused add -> only the added card leaves; all 150 real links stay", async () => {
    monday.getLinkedItemIds.mockResolvedValue([...MANY, "7002"]);
    await edit(rec({ sync_owner: "wm" }), { linked: ["7002"] });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    rewrittenTo(MANY.map(Number));
    expect(monday.findItemIdsByColumn).not.toHaveBeenCalled();
    expect(ensureCardForRecord).not.toHaveBeenCalled();
  });

  it("with no usable before-value the whole cell would be rewritten -> refused unless EVERY id resolves", async () => {
    monday.getLinkedItemIds.mockResolvedValue([...MANY, "7002"]);
    await reverseAssociations(env, CRM_CONTACTS, rec({ sync_owner: "wm" }), item, live, { left: 30 }, {
      onlyCols: new Set([COL]), basis: "human-edit", unlinked: { [COL]: [] } });   // `linked` absent
    expect(relationWrites()).toEqual([]);                                         // 100 of 150 resolved: kept
  });
});

describe("the snap-back never creates or re-links a card that no longer exists", () => {
  it("a removed card that has since been DELETED is not put back (restore owns it)", async () => {
    monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, id === "7002" ? "deleted" : "active"])));
    hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999", "40000000002"], truncated: false });
    // Refused for another reason (an add over nothing HubSpot has, on a wm record), with 7002 removed too.
    monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? (id === "7003" ? "40000000003" : "")])));
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7003"]);
    await edit(rec({ sync_owner: "wm" }), { linked: ["7003"], unlinked: ["7002"] });
    rewrittenTo([7001]);
    expect(ensureCardForRecord).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------ budget before claim
/**
 * THE BUDGET IS CHECKED BEFORE THE CLAIM. A claim is itself a HubSpot write; claiming with nothing left
 * for the association would make the record CRM's with nothing written.
 */
describe("the budget is checked before ownership is claimed", () => {
  const push = (left: number) => reverseAssociations(env, CRM_CONTACTS, rec(), item, live, { left }, {
    onlyCols: new Set([COL]), basis: "human-edit", linked: { [COL]: ["7002"] }, unlinked: { [COL]: [] } });
  beforeEach(() => { monday.getLinkedItemIds.mockResolvedValue(["7002"]); });

  it("budget 1 on a record that needs claiming -> no claim, no PUT, and the add is undone", async () => {
    await push(1);
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(hs.putAssociation).not.toHaveBeenCalled();
    rewrittenTo([]);
  });

  it("budget 2 covers the claim and the PUT (the control)", async () => {
    await push(2);
    expect(hs.claimOwnership).toHaveBeenCalledTimes(1);
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
  });

  it("budget 1 on a record CRM already owns needs no claim -> the PUT goes", async () => {
    await reverseAssociations(env, CRM_CONTACTS, rec({ sync_owner: "crm" }), item, live, { left: 1 }, {
      onlyCols: new Set([COL]), basis: "human-edit", linked: { [COL]: ["7002"] }, unlinked: { [COL]: [] } });
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(hs.putAssociation).toHaveBeenCalledTimes(1);
  });
});

describe("the snap-back is scoped to the column that was refused", () => {
  /** Deals carry three relations. A refusal on the Contacts cell must not rewrite the Accounts or Line
   *  Items cells, which the person did not touch and which the forward pass owns. */
  it("only the edited Deals relation is rewritten", async () => {
    const dealItem: MondayItem = { ...item, id: "6001" };
    monday.getLinkedItemIds.mockResolvedValue(["5555"]);
    monday.getItemsColumnText.mockResolvedValue({ "5555": "123" });
    monday.findItemIdsByColumn.mockResolvedValue({});
    await reverseAssociations(env, CRM_DEALS, { id: "900", properties: { createdate: OLD, sync_owner: "wm" } },
      dealItem, live, { left: 30 }, { onlyCols: new Set(["deal_contact"]), basis: "human-edit",
        linked: { deal_contact: ["5555"] }, unlinked: { deal_contact: [] } });
    expect(hs.putAssociation).not.toHaveBeenCalled();
    const cols = monday.setColumns.mock.calls.flatMap(c => Object.keys(c[3] as object));
    expect(cols).toEqual(["deal_contact"]);
  });
});
