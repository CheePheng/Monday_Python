import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";
import type { Env, HsRecord, MondayItem, RunOpts } from "../src/types";

/**
 * P&S "ACCOUNTS / COMPANIES": FILL THE DEAL'S COMPANY IF IT HAS NONE (A1, 2026-09-28).
 *
 * The cell is DERIVED -- line item -> its deal -> the deal's companies -- because HubSpot defines no
 * line_item <-> company association at all (`/crm/v4/associations/line_items/companies/labels` returns
 * [] both ways). So a rep picking an Account on a Products & Services card has no line-item association
 * to create. There is exactly one HubSpot edit it can honestly mean, and only in one situation: the
 * line item's single deal has NO company yet, and the rep is saying which one it is.
 *
 * In that situation, behind PS_ACCOUNT_REVERSE, the DEAL is associated to that company with HubSpot's
 * Primary label (typeId 5). Ownership is decided on the DEAL, since that is the record being written.
 * The deal's associationChange webhook then refreshes every line item's derived cell.
 *
 * Every other case is refused and the cell snaps back to the derived set: a deal that already has a
 * company (re-pointing it belongs on the Deal, where the person can see every line it would move),
 * a cleared cell, several Accounts, a line item on no deal or on two, a refusal, a HubSpot error, or
 * the flag off. No path ever calls a line_items -> companies endpoint.
 */

const hs = vi.hoisted(() => ({
  putAssociation: vi.fn(), putAssociationTypes: vi.fn(), deleteAssociation: vi.fn(),
  getAssociatedIds: vi.fn(), getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(),
  getRecord: vi.fn(), getRecordsByIds: vi.fn(async () => []), propertiesForSpec: vi.fn(() => ["sync_owner", "createdate"]),
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
const { recordRelationEvent, drainRelationEvents, relationEditKey } = await import("../src/relation-edit");

const COL = "board_relation_mm7cz3v8";                               // P&S "Accounts/Companies" (derived)
const LI = "9956357489", DEAL = "58512345678", ACME = "31125660999", GLOBEX = "40000000002";
const CARD: Record<string, string> = { "7001": ACME, "7002": GLOBEX };
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const on = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z", PS_ACCOUNT_REVERSE: "true" } as unknown as Env;
const off = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" } as unknown as Env;
const item: MondayItem = { id: "5001", name: "Intercom x5", created_at: "2026-01-22T06:46:54Z", updated_at: "",
  group: { id: "topics" }, column_values: [] as never };
/** The deals spec as THIS deployment resolves it (specByObject re-derives the cutover from env), matched
 *  on identity rather than on the static CRM_DEALS object. */
const DEALS_SPEC = expect.objectContaining({ object: "deals", boardId: CRM_DEALS.boardId });
const liRec: HsRecord ={ id: LI, properties: { createdate: "2026-01-22T06:46:54Z", sync_owner: "crm" } };

let dealsOfLi: string[] = [DEAL];
let companiesOfDeal: string[] = [];
let derived: string[] = [];
let dealRec: HsRecord | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // A G3 test leaves a removal pending on the person queue; it must not supersede the next test's fill.
  drainRelationEvents(relationEditKey(item.id, COL, "person"));
  dealsOfLi = [DEAL]; companiesOfDeal = []; derived = [];
  dealRec = { id: DEAL, properties: { createdate: "2026-01-22T06:46:54Z" } };   // unstamped: a person may claim
  monday.getItemsColumnText.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, CARD[id] ?? ""])));
  monday.findItemIdsByColumn.mockImplementation(async (_e: unknown, _b: string, _c: string, ids: string[]) =>
    Object.fromEntries(Object.entries(CARD).filter(([, h]) => ids.includes(h)).map(([c, h]) => [h, c])));
  monday.getItemStates.mockImplementation(async (_e: unknown, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, "active"])));
  monday.getLinkedItemIds.mockResolvedValue(["7001"]);
  monday.setColumns.mockResolvedValue(undefined);
  hs.getAllAssociatedIds.mockImplementation(async (_e: unknown, from: string, _id: string, to: string) => {
    if (from === "line_items" && to === "deals") return { ids: dealsOfLi, truncated: false };
    if (from === "deals" && to === "companies") return { ids: companiesOfDeal, truncated: false };
    throw new Error(`unexpected association read ${from} -> ${to}`);
  });
  hs.getAssociatedVia.mockImplementation(async () => ({ ids: derived, truncated: false }));
  hs.getRecord.mockImplementation(async (_e: unknown, object: string, id: string) =>
    object === "deals" && id === DEAL ? dealRec : null);
  hs.claimOwnership.mockResolvedValue("2026-09-28T09:00:00Z");
  hs.putAssociationTypes.mockResolvedValue(undefined);
});

const edit = (env: Env, diff: { linked?: string[]; unlinked?: string[] }) =>
  reverseAssociations(env, CRM_LINE_ITEMS, liRec, item, live, { left: 30 }, {
    onlyCols: new Set([COL]), basis: "human-edit",
    unlinked: { [COL]: diff.unlinked ?? [] },
    ...(diff.linked ? { linked: { [COL]: diff.linked } } : {}),
  });

const snaps = () => monday.setColumns.mock.calls.filter(c => COL in (c[3] as object));
const snappedTo = (ids: number[]) =>
  expect(snaps()).toEqual([[expect.anything(), CRM_LINE_ITEMS.boardId, "5001",
    { [COL]: { item_ids: ids } }, live]]);
const noHubspotWrite = () => {
  expect(hs.putAssociationTypes).not.toHaveBeenCalled();
  expect(hs.putAssociation).not.toHaveBeenCalled();
  expect(hs.deleteAssociation).not.toHaveBeenCalled();
  expect(hs.claimOwnership).not.toHaveBeenCalled();
};
/** No write helper is EVER handed the line_items <-> companies pair, in either order. */
const neverLineItemCompany = () => {
  for (const f of [hs.putAssociation, hs.putAssociationTypes, hs.deleteAssociation])
    for (const c of f.mock.calls as unknown[][]) {
      const pair = [c[1], c[3]].sort().join("|");
      expect(pair).not.toBe("companies|line_items");
    }
};

describe("flag off (the shipped default)", () => {
  it("no HubSpot write, and the cell snaps back to the derived set", async () => {
    derived = [];
    await edit(off, { linked: ["7001"] });
    noHubspotWrite();
    snappedTo([]);
  });
});

describe("flag on: the one case that writes", () => {
  it("a deal with NO company gets one labelled deal -> company PUT, typeId 5 (Primary)", async () => {
    await edit(on, { linked: ["7001"] });
    expect(hs.putAssociationTypes).toHaveBeenCalledTimes(1);
    expect(hs.putAssociationTypes).toHaveBeenCalledWith(on, "deals", DEAL, "companies", ACME,
      [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }], live, DEALS_SPEC,
      expect.objectContaining({ allowed: true, forId: DEAL }));
    neverLineItemCompany();
  });

  it("ownership is decided on the DEAL, with a person's human-edit claim -- never on the line item", async () => {
    await edit(on, { linked: ["7001"] });
    expect(hs.claimOwnership).toHaveBeenCalledTimes(1);
    expect(hs.claimOwnership).toHaveBeenCalledWith(on, DEALS_SPEC,
      expect.objectContaining({ id: DEAL }), live, "human-edit");
  });

  it("success leaves the cell alone: the deal's associationChange webhook refreshes it", async () => {
    await edit(on, { linked: ["7001"] });
    expect(snaps()).toEqual([]);
  });

  it("the plain default-type PUT is never used for this", async () => {
    await edit(on, { linked: ["7001"] });
    expect(hs.putAssociation).not.toHaveBeenCalled();
  });
});

describe("flag on: every other case is refused and snapped back", () => {
  it("the deal ALREADY has a company -> refused (re-pointing belongs on the Deal)", async () => {
    companiesOfDeal = [GLOBEX]; derived = [GLOBEX];
    monday.getLinkedItemIds.mockResolvedValue(["7002", "7001"]);
    await edit(on, { linked: ["7001"] });
    noHubspotWrite(); snappedTo([7002]);
  });

  it("the cell was CLEARED -> refused", async () => {
    companiesOfDeal = [GLOBEX]; derived = [GLOBEX];
    monday.getLinkedItemIds.mockResolvedValue([]);
    await edit(on, { linked: [], unlinked: ["7002"] });
    noHubspotWrite(); snappedTo([7002]);
  });

  it("TWO Accounts added at once -> refused", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7001", "7002"]);
    await edit(on, { linked: ["7001", "7002"] });
    noHubspotWrite(); snappedTo([]);
  });

  it("one Account swapped for another -> refused", async () => {
    await edit(on, { linked: ["7001"], unlinked: ["7002"] });
    noHubspotWrite(); snappedTo([]);
  });

  it("the line item is on NO deal -> refused", async () => {
    dealsOfLi = [];
    await edit(on, { linked: ["7001"] });
    noHubspotWrite(); snappedTo([]);
  });

  it("the line item is on TWO deals -> refused", async () => {
    dealsOfLi = [DEAL, "58500000000"];
    await edit(on, { linked: ["7001"] });
    noHubspotWrite(); snappedTo([]);
  });

  it.each(["wm", "hold"])("the deal is not CRM's to write (sync_owner=%s) -> refused", async (stamp) => {
    dealRec = { id: DEAL, properties: { createdate: "2026-01-22T06:46:54Z", sync_owner: stamp } };
    await edit(on, { linked: ["7001"] });
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    snappedTo([]);
  });

  it("HubSpot rejects the PUT -> snapped back", async () => {
    hs.putAssociationTypes.mockRejectedValue(new Error("hubspot PUT ...: 400 bad association"));
    await edit(on, { linked: ["7001"] });
    snappedTo([]);
  });

  it("the Account card has no HubSpot id -> refused", async () => {
    monday.getLinkedItemIds.mockResolvedValue(["7999"]);
    await edit(on, { linked: ["7999"] });
    noHubspotWrite(); snappedTo([]);
  });

  it("no usable before-value -> refused", async () => {
    await edit(on, {});
    noHubspotWrite(); snappedTo([]);
  });

  it("a truncated deal read -> refused", async () => {
    hs.getAllAssociatedIds.mockResolvedValue({ ids: [], truncated: true });
    await edit(on, { linked: ["7001"] });
    noHubspotWrite(); snappedTo([]);
  });

  it("the snap-back reads the DERIVED set (line item -> deal -> Primary company)", async () => {
    companiesOfDeal = [GLOBEX]; derived = [GLOBEX];
    await edit(on, { linked: ["7001"] });
    expect(hs.getAssociatedVia).toHaveBeenCalledWith(on, "line_items", LI, "deals", "companies", true);
  });

  it("across every refusal, nothing ever touches a line_items <-> companies endpoint", async () => {
    for (const d of [{ linked: ["7001", "7002"] }, { linked: [], unlinked: ["7001"] }, {}]) await edit(on, d);
    neverLineItemCompany();
    const reads = (hs.getAllAssociatedIds.mock.calls as unknown[][]).map(c => [c[1], c[3]].sort().join("|"));
    expect(reads).not.toContain("companies|line_items");
  });
});

// ------------------------------------------------------------------------------ races
/**
 * G3 ON THE DERIVED CELL: the Account added and removed again while the pass reads. Without the re-check
 * the PUT went out, the trailing run refused the removal, and its snap-back re-showed the company the
 * person had just taken off -- a removed link re-created in HubSpot AND in monday.
 */
describe("add-then-remove on the P&S Accounts cell: a late fill never re-creates a removed link", () => {
  const removeDuring = () =>
    recordRelationEvent(relationEditKey(item.id, COL, "person"), { added: [], removed: ["7001"] });
  it("removed while the deal was being read -> no claim, no PUT, no snap-back", async () => {
    hs.getRecord.mockImplementation(async () => { removeDuring(); return dealRec; });
    await edit(on, { linked: ["7001"] });
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(snaps()).toEqual([]);
  });

  it("removed while ownership was being claimed -> no PUT", async () => {
    hs.claimOwnership.mockImplementation(async () => { removeDuring(); return "2026-09-28T09:00:00Z"; });
    await edit(on, { linked: ["7001"] });
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
  });

  it("the trailing run that carries the removal writes nothing and puts nothing back", async () => {
    hs.getRecord.mockImplementation(async () => { removeDuring(); return dealRec; });
    await edit(on, { linked: ["7001"] });
    const trailing = drainRelationEvents(relationEditKey(item.id, COL, "person"));
    expect(trailing.removed).toEqual(["7001"]);
    monday.getLinkedItemIds.mockResolvedValue([]);                        // the person's cell: empty again
    await edit(on, { linked: trailing.added, unlinked: trailing.removed });
    noHubspotWrite();
    expect(snaps()).toEqual([]);                                           // derived set is still empty
  });
});

/**
 * TWO LINE ITEMS OF ONE COMPANY-LESS DEAL, FILLED AT ONCE. Both would read "no company" and both PUT
 * Primary -- two companies on the deal, or a moved label: the re-point A1 exists to forbid.
 */
describe("two fills racing on one deal", () => {
  it("the second, while the first is deciding, is refused and snapped back; one PUT in total", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    hs.getRecord.mockImplementationOnce(async () => { await gate; return dealRec; });
    monday.getLinkedItemIds.mockImplementation(async (_e: unknown, id: string) => id === "5002" ? ["7002"] : ["7001"]);
    const first = edit(on, { linked: ["7001"] });
    await new Promise(r => setTimeout(r, 0));
    const other: MondayItem = { ...item, id: "5002" };
    await reverseAssociations(on, CRM_LINE_ITEMS, { id: "9956357490", properties: liRec.properties }, other, live,
      { left: 30 }, { onlyCols: new Set([COL]), basis: "human-edit", unlinked: { [COL]: [] }, linked: { [COL]: ["7002"] } });
    release();
    await first;
    expect(hs.putAssociationTypes).toHaveBeenCalledTimes(1);
    expect(hs.putAssociationTypes.mock.calls[0][4]).toBe(ACME);
    expect(monday.setColumns.mock.calls.map(c => c[2])).toEqual(["5002"]);
  });

  it("the deal gains a company between the first read and the PUT -> no PUT, snapped back", async () => {
    let reads = 0;
    hs.getAllAssociatedIds.mockImplementation(async (_e: unknown, from: string, _id: string, to: string) => {
      if (from === "line_items" && to === "deals") return { ids: dealsOfLi, truncated: false };
      reads++;
      return { ids: reads === 1 ? [] : [GLOBEX], truncated: false };
    });
    derived = [GLOBEX];
    await edit(on, { linked: ["7001"] });
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(snaps()).toHaveLength(1);
  });
});

describe("the budget is checked before the deal is claimed", () => {
  const fill = (left: number) => reverseAssociations(on, CRM_LINE_ITEMS, liRec, item, live, { left }, {
    onlyCols: new Set([COL]), basis: "human-edit", unlinked: { [COL]: [] }, linked: { [COL]: ["7001"] } });

  it("budget 1 on a deal that needs claiming -> no claim, no PUT, snapped back", async () => {
    await fill(1);
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    snappedTo([]);
  });

  it("budget 1 on a deal CRM already owns -> the PUT goes, nothing claimed", async () => {
    dealRec = { id: DEAL, properties: { createdate: "2026-01-22T06:46:54Z", sync_owner: "crm" } };
    await fill(1);
    expect(hs.claimOwnership).not.toHaveBeenCalled();
    expect(hs.putAssociationTypes).toHaveBeenCalledTimes(1);
  });
});

describe("the derived entry is still reached only through the dispatch", () => {
  it("an edit of the P&S Deal cell never reaches the derived Account path", async () => {
    await reverseAssociations(on, CRM_LINE_ITEMS, liRec, item, live, { left: 30 }, {
      onlyCols: new Set(["board_relation_mm76w9y5"]), basis: "human-edit",
      linked: { board_relation_mm76w9y5: [] }, unlinked: { board_relation_mm76w9y5: [] } });
    expect(hs.putAssociationTypes).not.toHaveBeenCalled();
    expect(hs.getAssociatedVia).not.toHaveBeenCalled();
  });

  it("the Accounts board is the one whose HubSpot id column resolves the picked card", async () => {
    await edit(on, { linked: ["7001"] });
    expect(monday.getItemsColumnText).toHaveBeenCalledWith(on, ["7001"], CRM_ACCOUNTS.idCol);
  });
});

// ------------------------------------------------------------------------------ the HTTP helper
/** putAssociationTypes against the REAL hubspot module, fetch stubbed: the path, the body, and that
 *  the ownership assert and the line_items/companies refusal both fire before any request. */
describe("putAssociationTypes", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const real = () => vi.importActual<typeof import("../src/hubspot")>("../src/hubspot");
  const PRIMARY = [{ associationCategory: "HUBSPOT_DEFINED" as const, associationTypeId: 5 }];

  it("PUTs the labelled v4 association with the types as the body", async () => {
    const { putAssociationTypes } = await real();
    await putAssociationTypes(on, "deals", DEAL, "companies", ACME, PRIMARY, live, CRM_DEALS,
      { allowed: true, reason: "stamped crm", forId: DEAL });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.hubapi.com/crm/v4/objects/deals/${DEAL}/associations/companies/${ACME}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual(PRIMARY);
  });

  it("assertMayWrite runs FIRST: a refused auth sends nothing", async () => {
    const { putAssociationTypes } = await real();
    await expect(putAssociationTypes(on, "deals", DEAL, "companies", ACME, PRIMARY, live, CRM_DEALS,
      { allowed: false, reason: "owned by wm", forId: DEAL })).rejects.toThrow(/owned by wm/);
    await expect(putAssociationTypes(on, "deals", DEAL, "companies", ACME, PRIMARY, live, CRM_DEALS,
      undefined)).rejects.toThrow(/requires a WriteAuth/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses line_items <-> companies in either direction, before any request", async () => {
    const { putAssociationTypes } = await real();
    const auth = { allowed: true, reason: "x", forId: LI };
    await expect(putAssociationTypes(on, "line_items", LI, "companies", ACME, PRIMARY, live, CRM_LINE_ITEMS, auth))
      .rejects.toThrow(/line_items/);
    await expect(putAssociationTypes(on, "companies", ACME, "line_items", LI, PRIMARY, live, CRM_ACCOUNTS,
      { ...auth, forId: ACME })).rejects.toThrow(/line_items/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-run sends nothing, but still asserts first", async () => {
    const { putAssociationTypes } = await real();
    await putAssociationTypes(on, "deals", DEAL, "companies", ACME, PRIMARY,
      { ...live, dryRun: true }, CRM_DEALS, { allowed: true, reason: "x", forId: DEAL });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(putAssociationTypes(on, "deals", DEAL, "companies", ACME, PRIMARY,
      { ...live, dryRun: true }, CRM_DEALS, undefined)).rejects.toThrow();
  });
});
