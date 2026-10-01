import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import type { Env, HsRecord, MondayItem, RunOpts } from "../src/types";

/**
 * UNLINKING A RECORD IN MONDAY NOW REACHES HUBSPOT.
 *
 * Association reverse was additive-only: a rep who removed a Company from a Contact's
 * "Accounts / Companies" cell saw it re-linked by the next forward pass. The reason was sound -- inferring
 * an unlink from a card READ is unsafe, because a lagging or failed read looks exactly like "everything
 * removed" -- and it is still honoured: nothing here infers from a read.
 *
 * An unlink needs three independent agreements:
 *   1. monday's own webhook says the person removed that card (previousValue -> value);
 *   2. the current card read agrees it is gone (so a quick re-link wins);
 *   3. no other card still in the cell points at the same HubSpot record (duplicates keep the link).
 *
 * The payload shapes below are the ones observed on the live CRM boards' activity log, 2026-09-23.
 */

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), deleteAssociation: vi.fn(), getAssociatedIds: vi.fn(), getRecordsByIds: vi.fn(),
  getRecord: vi.fn(), patchLineItem: vi.fn(), createLineItem: vi.fn(), propertiesForSpec: vi.fn(() => []),
  claimOwnership: vi.fn(), getAssociatedPage: vi.fn(), getAssociatedVia: vi.fn(), getAllAssociatedIds: vi.fn(),
  putAssociationTypes: vi.fn(),
}));
const monday = vi.hoisted(() => ({
  getLinkedItemIds: vi.fn(), getItemsColumnText: vi.fn(), findItemIdsByColumn: vi.fn(),
  createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), getItem: vi.fn(),
  getParentItemId: vi.fn(), getSubitems: vi.fn(), setColumns: vi.fn(), updateItem: vi.fn(),
  getItemStates: vi.fn(),
}));
vi.mock("../src/hubspot", () => ({ ...hs, OwnershipError: class extends Error {} }));
vi.mock("../src/monday", () => monday);

const { reverseAssociations } = await import("../src/associations");
const { unlinkedCardIds } = await import("../src/webhooks");

const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const COL = "contact_account";                      // Contacts -> Accounts / Companies
const item: MondayItem = { id: "C1", name: "Omar Ruth", created_at: "", updated_at: "", group: { id: "topics" },
  column_values: [{ id: COL, text: "linked" }] as never };
const rec = (p: Record<string, string> = {}): HsRecord =>
  ({ id: "394787683005", properties: { createdate: "2026-01-22T06:46:54Z", ...p } });

// Card -> HubSpot company id, as the Accounts board's HubSpot ID column holds them.
const HS_OF: Record<string, string> = { A1: "31125660999", A2: "40000000002", DUP: "31125660999" };

beforeEach(() => {
  vi.clearAllMocks();
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, HS_OF[id] ?? ""])));
  hs.getAssociatedIds.mockResolvedValue(["31125660999", "40000000002"]);
  hs.getAllAssociatedIds.mockResolvedValue({ ids: ["31125660999", "40000000002"], truncated: false });
  // Every removed card is still a live card: a person unlinked it (G4 -- a DELETED card never unlinks;
  // that case is association-deleted-card.test.ts).
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, "active"])));
  monday.findItemIdsByColumn.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  hs.putAssociation.mockResolvedValue(undefined);
  hs.deleteAssociation.mockResolvedValue(true);
  hs.claimOwnership.mockResolvedValue("2026-09-23T09:00:00Z");
});

const run = (r: HsRecord, unlinked: string[]) =>
  reverseAssociations(env, CRM_CONTACTS, r, item, live, { left: 30 },
    { onlyCols: new Set([COL]), basis: "human-edit", unlinked: { [COL]: unlinked }, linked: { [COL]: [] } });

describe("reading monday's before/after", () => {
  const ev = (previousValue: unknown, value: unknown) => ({ previousValue, value });
  const L = (...ids: number[]) => ({ linkedPulseIds: ids.map(linkedPulseId => ({ linkedPulseId })) });

  it("one of two links removed", () =>
    expect(unlinkedCardIds(ev(L(2861833338, 2861854148), { ...L(2861833338), changed_at: "x" })))
      .toEqual(["2861854148"]));

  it("the last link removed, sent as {} (seen live)", () =>
    expect(unlinkedCardIds(ev(L(2861840860), {}))).toEqual(["2861840860"]));

  it("the last link removed, sent as {changed_at} with no linkedPulseIds key (seen live)", () =>
    expect(unlinkedCardIds(ev(L(2855674277), { changed_at: "2026-09-20T08:40:35.689Z" }))).toEqual(["2855674277"]));

  it("a link ADDED removes nothing", () =>
    expect(unlinkedCardIds(ev({}, L(2862546533)))).toEqual([]));

  it("JSON-string values are read the same", () =>
    expect(unlinkedCardIds(ev(JSON.stringify(L(1, 2)), JSON.stringify(L(1))))).toEqual(["2"]));

  it("no previousValue in the event -> nothing is provable, nothing removed", () =>
    expect(unlinkedCardIds({ value: {} })).toEqual([]));

  it.each([["garbage", "not json"], ["a number", 42], ["a malformed list", { linkedPulseIds: "x" }]])(
    "an unreadable side (%s) removes nothing", (_l, bad) => {
      expect(unlinkedCardIds(ev(bad, {}))).toEqual([]);
      expect(unlinkedCardIds(ev(L(1), bad))).toEqual([]);
    });
});

describe("an unlink in monday removes the HubSpot association", () => {
  it("the person removed A2 and the read agrees -> A2's association is deleted", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["A1"]);
    await run(rec(), ["A2"]);
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(1);
    expect(hs.deleteAssociation).toHaveBeenCalledWith(env, "contacts", "394787683005", "companies",
      "40000000002", live, CRM_CONTACTS, expect.objectContaining({ allowed: true }));
  });

  it("removing the LAST link works too", async () => {
    monday.getLinkedItemIds.mockResolvedValue([]);
    await run(rec(), ["A1"]);
    expect(hs.deleteAssociation).toHaveBeenCalledWith(env, "contacts", "394787683005", "companies",
      "31125660999", live, CRM_CONTACTS, expect.anything());
  });

  it("claims an older unclaimed record on the person's edit, like any other column", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["A1"]);
    await run(rec(), ["A2"]);
    expect(hs.claimOwnership).toHaveBeenCalledWith(env, CRM_CONTACTS, expect.anything(), live, "human-edit");
  });
});

describe("the three agreements -- any one missing, nothing is deleted", () => {
  it("(2) the card is linked again by the time we read it -> kept", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["A1", "A2"]);
    await run(rec(), ["A2"]);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it("(3) another card in the cell is the SAME HubSpot company (a duplicate card) -> kept", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["DUP"]);   // DUP and A1 both map to 31125660999
    await run(rec(), ["A1"]);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it("(1) no unlink in the event -> nothing is deleted, whatever the cell shows", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["A1"]);
    await reverseAssociations(env, CRM_CONTACTS, rec(), item, live, { left: 30 },
      { onlyCols: new Set([COL]), basis: "human-edit", linked: { [COL]: [] } });
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it("a removed card with no HubSpot id deletes nothing", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["A1"]);
    await run(rec(), ["NO_ID"]);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });
});

describe("a bulk removal in one edit is refused", () => {
  /** Unproven whether monday caps the link list in a webhook; a capped list would look like a mass
   *  unlink. More than MAX_UNLINKS_PER_EDIT in one event is refused -- and since 2026-09-28 the cell is
   *  snapped straight back from HubSpot (association-heal.test.ts), so nothing is lost either side. */
  it("more than the bound -> nothing deleted", async () => {
    const { MAX_UNLINKS_PER_EDIT } = await import("../src/associations");
    const many = Array.from({ length: MAX_UNLINKS_PER_EDIT + 1 }, (_, i) => `X${i}`);
    for (const id of many) HS_OF[id] = String(50000000000 + many.indexOf(id));
    monday.getLinkedItemIds.mockResolvedValue([]);
    await run(rec(), many);
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });

  it("exactly the bound -> all deleted", async () => {
    const { MAX_UNLINKS_PER_EDIT } = await import("../src/associations");
    const some = Array.from({ length: MAX_UNLINKS_PER_EDIT }, (_, i) => `Y${i}`);
    for (const id of some) HS_OF[id] = String(60000000000 + some.indexOf(id));
    monday.getLinkedItemIds.mockResolvedValue([]);
    await run(rec(), some);
    expect(hs.deleteAssociation).toHaveBeenCalledTimes(MAX_UNLINKS_PER_EDIT);
  });
});

describe("ownership still governs an unlink", () => {
  it.each(["wm", "hold"])("sync_owner=%s -> refused, nothing deleted", async (stamp) => {
    monday.getLinkedItemIds.mockResolvedValue(["A1"]);
    await run(rec({ sync_owner: stamp }), ["A2"]);
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(hs.deleteAssociation).not.toHaveBeenCalled();
  });
});
