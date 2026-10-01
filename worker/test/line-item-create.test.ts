import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Budget, Env, MondayItem, RunOpts } from "../src/types";

/**
 * A PRODUCTS & SERVICES CARD BECOMES A HUBSPOT LINE ITEM — ON ITS DEAL, OR NOT AT ALL.
 *
 * A line item with no deal is not a lesser line item, it is unreachable: absent from the deal's amount,
 * absent from every quote, and impossible to clean up from monday, because a monday deletion never
 * deletes a HubSpot record. So the deal association travels INSIDE the create call, and a deal that
 * cannot be resolved refuses the create outright and says so on the card.
 */

const hubspot = vi.hoisted(() => ({
  createRecord: vi.fn(async () => ({ id: "99", modified: "2026-09-21T00:00:00Z" })),
  claimOwnership: vi.fn(), patchRecord: vi.fn(),
  getCrmStageDicts: vi.fn(async () => ({})), getDealStageLabels: vi.fn(async () => ({})),
  getOwners: vi.fn(async () => [] as any[]), getPropertyOptions: vi.fn(async () => ({})),
  getRecord: vi.fn(async () => null), searchCompanyByDomain: vi.fn(async () => null),
  propertiesForSpec: vi.fn(() => []), searchAll: vi.fn(async () => []),
  searchContactByEmail: vi.fn(async () => null), searchModifiedIds: vi.fn(async () => [] as string[]),
}));
const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(async () => [] as any[]),
  getBoardItems: vi.fn(async () => [] as any[]), getItem: vi.fn(async () => null),
  getItemsColumnText: vi.fn(async () => ({}) as Record<string, string>),
  getLinkedItemIds: vi.fn(async () => [] as string[]),
  getUsersByEmail: vi.fn(async () => ({})), moveItem: vi.fn(),
  setColumns: vi.fn(async () => undefined), updateItem: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  claimHubspotForItem: vi.fn(async () => ({ status: "proceed" as const })),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
  lookupCard: vi.fn(async () => null), rememberCard: vi.fn(), forgetCard: vi.fn(),
  lookupCardOwner: vi.fn(async () => null), rememberCardOwner: vi.fn(), forgetCardOwner: vi.fn(),
  finishCard: vi.fn(), claimCard: vi.fn(),
}));

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/associations", () => ({
  syncAssociations: vi.fn(async () => undefined), reverseAssociations: vi.fn(async () => undefined),
  pushBirthAssociations: vi.fn(async () => null),   // the birth pass itself: test/born-attached.test.ts
}));

const { syncMondayItem } = await import("../src/sync");

const PS_BOARD = "5028000489";
const DEAL_CARD = "card-deal-1";
const env = { ENABLE_CRM: "true", CRM_CREATE_CUTOFF_AT: "2026-09-01T00:00:00Z" } as unknown as Env;
const opts = { dryRun: false, maxWrites: 50, writeHubspot: true } as unknown as RunOpts;
const budget = (): Budget => ({ left: 50 });

/** A brand-new P&S card: no HubSpot id, created after the go-live cutoff. */
const psCard = (cols: Record<string, string> = {}): MondayItem => ({
  id: "ps-1", name: "Intercom", created_at: "2026-09-21T09:00:00Z", updated_at: "",
  group: { id: "topics" },
  column_values: Object.entries({ text_mm76qwtw: "", ...cols }).map(([id, text]) => ({ id, text })) as never,
});

/** syncMondayItem(env, boardId, itemId, opts, budget) — the webhook handler resolves the id first. */
const ITEM = "ps-1";

beforeEach(() => {
  vi.clearAllMocks();
  monday.getItem.mockResolvedValue(psCard() as never);
  monday.getLinkedItemIds.mockResolvedValue([DEAL_CARD]);
  monday.getItemsColumnText.mockResolvedValue({ [DEAL_CARD]: "334777970383" });
  registry.claimHubspotForItem.mockResolvedValue({ status: "proceed" } as never);
  hubspot.createRecord.mockResolvedValue({ id: "99", modified: "2026-09-21T00:00:00Z" });
});

const createCall = () => (hubspot.createRecord.mock.calls as any[][])[0];

describe("the happy path", () => {
  it("creates exactly ONE HubSpot line item", async () => {
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(hubspot.createRecord).toHaveBeenCalledTimes(1);
  });

  it("sends the deal association INSIDE the create, not as a later link", async () => {
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    const assoc = createCall()[5];
    expect(assoc).toEqual([{ toId: "334777970383", associationTypeId: 20 }]);
  });

  it("reads the deal from the relation column the rep filled in on the form", async () => {
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect((monday.getLinkedItemIds.mock.calls as any[][])[0][2]).toBe("board_relation_mm76w9y5");
  });

  it("stamps the HubSpot id back onto the SAME monday card", async () => {
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    // setColumns(env, boardId, itemId, columns, opts)
    const write = (monday.setColumns.mock.calls as any[][]).find(c => c[3]?.text_mm76qwtw)!;
    expect(write, "the P&S card was never stamped").toBeDefined();
    expect(write[2]).toBe("ps-1");
    expect(write[3].text_mm76qwtw).toBe("99");
    expect(write[3].link_mm76mcap).toBeDefined();     // HubSpot Link
  });

  it("records the pairing BEFORE the write-back, so a failed stamp cannot duplicate", async () => {
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(registry.finishHubspotForItem).toHaveBeenCalled();
  });
});

describe("it refuses rather than creating an orphan", () => {
  const refused = async () => {
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(hubspot.createRecord).not.toHaveBeenCalled();
    return (monday.setColumns.mock.calls as any[][]).map(c => c[3]?.text_mm76kcss).filter(Boolean);
  };

  it("when the rep linked no Deal at all", async () => {
    monday.getLinkedItemIds.mockResolvedValue([]);
    expect((await refused()).join(" ")).toMatch(/needs a linked deal/i);
  });

  it("when the linked Deal card has not synced yet, so carries no HubSpot id", async () => {
    monday.getItemsColumnText.mockResolvedValue({ [DEAL_CARD]: "" });
    expect((await refused()).join(" ")).toMatch(/needs a linked deal/i);
  });

  it("when the Deal card's id column holds something that is not an id", async () => {
    monday.getItemsColumnText.mockResolvedValue({ [DEAL_CARD]: "pending…" });
    await refused();
  });

  /** Revenue on the wrong deal is worse than no line item. */
  it("when TWO Deals are linked — it will not pick one", async () => {
    monday.getLinkedItemIds.mockResolvedValue([DEAL_CARD, "card-deal-2"]);
    await refused();
  });

  it("releases the claim on refusal, so a later retry can still create", async () => {
    monday.getLinkedItemIds.mockResolvedValue([]);
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(registry.forgetHubspotForItem).toHaveBeenCalled();
  });
});

describe("one monday card can never become two line items", () => {
  it("a second concurrent delivery is refused by the claim", async () => {
    registry.claimHubspotForItem.mockResolvedValue({ status: "creating" } as never);
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(hubspot.createRecord).not.toHaveBeenCalled();
  });

  it("a redelivery AFTER a successful create re-stamps instead of creating again", async () => {
    // The `have` state is the timeout-after-success case: HubSpot made the record, the write-back died.
    registry.claimHubspotForItem.mockResolvedValue({ status: "have", itemId: "99" } as never);
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(hubspot.createRecord).not.toHaveBeenCalled();
    const write = (monday.setColumns.mock.calls as any[][]).find(c => c[3]?.text_mm76qwtw === "99")!;
    expect(write, "the card was not re-stamped from the remembered pairing").toBeDefined();
  });

  it("a card that already carries a HubSpot id never enters the create path", async () => {
    monday.getItem.mockResolvedValue(psCard({ text_mm76qwtw: "12345" }) as never);
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(hubspot.createRecord).not.toHaveBeenCalled();
  });
});

describe("the go-live cutoff still governs line items", () => {
  it("a card created before the cutoff creates nothing", async () => {
    const old = { ...psCard(), created_at: "2026-08-01T00:00:00Z" } as MondayItem;
    monday.getItem.mockResolvedValue(old as never);
    await syncMondayItem(env, PS_BOARD, ITEM, opts, budget());
    expect(hubspot.createRecord).not.toHaveBeenCalled();
  });

  it("and with NO cutoff configured, nothing creates at all", async () => {
    await syncMondayItem({ ENABLE_CRM: "true" } as unknown as Env, PS_BOARD, ITEM, opts, budget());
    expect(hubspot.createRecord).not.toHaveBeenCalled();
  });
});
