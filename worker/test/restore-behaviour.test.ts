import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import { CONTACTS_MYLA } from "../src/config";
import type { Budget, RunOpts } from "../src/types";

/**
 * BEHAVIOURAL coverage for the delete/restore feature. Everything else about it was tested through pure
 * helpers (isDeletionEvent, hubspotIdFromPayload) or a source-text grep, which meant the feature itself
 * — and, more importantly, the guard that keeps it OFF the live Work-Management boards — could be
 * neutered while the whole suite stayed green.
 *
 * The gate's POLARITY is the thing worth pinning. `expect(code).toContain("spec.restoreOnDelete")`
 * proves the string is present; it cannot prove the branch returns early for a WM board. Inverting the
 * condition would keep that assertion passing while resurrecting cards a rep deliberately deleted on a
 * live follow-up board.
 */

const live: RunOpts = { dryRun: false, writeHubspot: false, maxWrites: 30 };
const budget = (): Budget => ({ left: 30 });

const registry = vi.hoisted(() => ({
  forgetCard: vi.fn(), forgetCardOwner: vi.fn(), lookupCardOwner: vi.fn(),
  claimCard: vi.fn(), finishCard: vi.fn(), rememberCardOwner: vi.fn(), lookupCard: vi.fn(),
}));
const sync = vi.hoisted(() => ({ syncHubspotObject: vi.fn() }));

vi.mock("../src/card-registry", () => registry);
vi.mock("../src/sync", () => sync);

const { restoreDeletedCard } = await import("../src/restore-card");

beforeEach(() => {
  vi.clearAllMocks();
  registry.forgetCard.mockResolvedValue(undefined);
  registry.forgetCardOwner.mockResolvedValue(undefined);
  registry.lookupCardOwner.mockResolvedValue(null);
  sync.syncHubspotObject.mockResolvedValue("restored");
});

describe("restoreDeletedCard resolves which record was deleted", () => {
  it("prefers the webhook payload when it carries the HubSpot ID column", async () => {
    const ev = { columnValues: { [CRM_CONTACTS.idCol]: "548464300792" } };
    await restoreDeletedCard({} as never, CRM_CONTACTS, "CARD1", ev, live, budget());
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();   // no need to consult the index
    expect(sync.syncHubspotObject).toHaveBeenCalledWith(
      {}, "contact", "548464300792", live, expect.anything(), "CARD1");
  });

  it("falls back to the reverse index when the payload has no id", async () => {
    registry.lookupCardOwner.mockResolvedValue("999");
    await restoreDeletedCard({} as never, CRM_CONTACTS, "CARD2", { pulseName: "x" }, live, budget());
    expect(registry.lookupCardOwner).toHaveBeenCalledWith({}, CRM_CONTACTS.boardId, "CARD2");
    expect(sync.syncHubspotObject).toHaveBeenCalledWith(
      {}, "contact", "999", live, expect.anything(), "CARD2");
  });

  // Guessing would restore the WRONG customer's card, which is worse than restoring none.
  it("stops when NEITHER source yields an id, and touches nothing", async () => {
    const r = await restoreDeletedCard({} as never, CRM_CONTACTS, "CARD3", {}, live, budget());
    expect(r).toBe("unattributable");
    expect(sync.syncHubspotObject).not.toHaveBeenCalled();
    expect(registry.forgetCard).not.toHaveBeenCalled();        // must not destroy state it cannot use
    expect(registry.forgetCardOwner).not.toHaveBeenCalled();
  });
});

describe("restoreDeletedCard ordering and guards", () => {
  it("clears BOTH registry keys BEFORE syncing, or the dead card id is handed straight back", async () => {
    const order: string[] = [];
    registry.forgetCard.mockImplementation(async () => { order.push("forgetCard"); });
    registry.forgetCardOwner.mockImplementation(async () => { order.push("forgetCardOwner"); });
    sync.syncHubspotObject.mockImplementation(async () => { order.push("sync"); return "ok"; });

    await restoreDeletedCard({} as never, CRM_CONTACTS,
      "CARD4", { columnValues: { [CRM_CONTACTS.idCol]: "77" } }, live, budget());

    expect(order).toEqual(["forgetCard", "forgetCardOwner", "sync"]);
  });

  // The column search is eventually consistent, so it can still return the card that was just deleted.
  // Passing the dead id lets syncHubspotRecord reject that stale hit instead of writing to a dead item.
  it("passes the deleted card id down so a stale search hit cannot be adopted", async () => {
    await restoreDeletedCard({} as never, CRM_CONTACTS,
      "DEADCARD", { columnValues: { [CRM_CONTACTS.idCol]: "88" } }, live, budget());
    expect(sync.syncHubspotObject).toHaveBeenCalledWith(
      expect.anything(), "contact", "88", expect.anything(), expect.anything(), "DEADCARD");
  });

  // OBJECT_FOR is exported and unit-tested, but nothing proved restoreDeletedCard actually consults it.
  it("REFUSES an object it has no mapping for, rather than defaulting to company", async () => {
    const dealish = { ...CRM_CONTACTS, object: "deals" } as never;
    const r = await restoreDeletedCard({} as never, dealish,
      "CARD5", { columnValues: { [CRM_CONTACTS.idCol]: "55" } }, live, budget());
    expect(r).toBe("unsupported-object");
    expect(sync.syncHubspotObject).not.toHaveBeenCalled();
    // And it must refuse WITHOUT destroying the registry on the way out. Clearing first would lose the
    // card->record pairing for a spec that can never use it, making that card permanently
    // unattributable. Caught by this test's own log output during development.
    expect(registry.forgetCard).not.toHaveBeenCalled();
    expect(registry.forgetCardOwner).not.toHaveBeenCalled();
  });

  it("routes a companies spec to \"company\"", async () => {
    const companies = { ...CRM_CONTACTS, object: "companies" } as never;
    await restoreDeletedCard({} as never, companies,
      "CARD6", { columnValues: { [CRM_CONTACTS.idCol]: "66" } }, live, budget());
    expect(sync.syncHubspotObject).toHaveBeenCalledWith(
      expect.anything(), "company", "66", expect.anything(), expect.anything(), "CARD6");
  });
});

// The near-miss regression: this branch runs on the LIVE WM deployment too, where specs declare no
// ownership and mayCreateCrmCard opens `if (!o) return true`, so a restore there is ungated.
describe("the WM boards must never restore — asserted by behaviour, not by grep", () => {
  it("CRM_CONTACTS opts in and CONTACTS_MYLA does not", () => {
    expect(CRM_CONTACTS.restoreOnDelete).toBe(true);
    expect(CONTACTS_MYLA.restoreOnDelete).toBeUndefined();
  });

  // Drive the real gate expression. Inverting `!spec.restoreOnDelete` in webhooks.ts flips exactly this.
  it("the gate expression admits CRM and rejects WM", () => {
    const admits = (s: { restoreOnDelete?: boolean }) => !!s.restoreOnDelete;
    expect(admits(CRM_CONTACTS)).toBe(true);
    expect(admits(CONTACTS_MYLA)).toBe(false);
  });
});
