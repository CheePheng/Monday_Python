import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Budget, Env, ObjectSpec, RunOpts } from "../src/types";

/**
 * DELETING AN ITEM-ASSOCIATION ORPHAN MUST TOUCH NOTHING.
 *
 * monday's CRM "Item association" feature created ~1,301 Accounts cards from email sender domains:
 * a name, a domain, and nothing else — no HubSpot id, no link, no Sync State. Retiring them is the
 * cleanup we are heading towards, and the Accounts spec has `restoreOnDelete: true`, so every
 * deletion runs restoreDeletedCard.
 *
 * Before deleting even ONE, the blast radius has to be proven, not reasoned about. The rule the whole
 * project rests on is that a monday deletion may never delete or alter a HubSpot record, and an
 * orphan deletion must additionally not resurrect a card or create anything.
 */

const registry = vi.hoisted(() => ({
  forgetCard: vi.fn(), forgetCardOwner: vi.fn(),
  lookupCardOwner: vi.fn(async () => null as string | null),
}));
const sync = vi.hoisted(() => ({ syncHubspotObject: vi.fn(async () => "restored") }));

vi.mock("../src/card-registry", () => registry);
vi.mock("../src/sync", () => sync);

const { restoreDeletedCard } = await import("../src/restore-card");

const ACCOUNTS = { object: "companies", boardId: "5028000496", idCol: "text_mm6tsnwx",
  restoreOnDelete: true } as unknown as ObjectSpec;

const env = {} as Env;
const opts = {} as RunOpts;
let budget: Budget;

beforeEach(() => { vi.clearAllMocks(); budget = { left: 30 }; registry.lookupCardOwner.mockResolvedValue(null); });

/** A deletion event for a card that never carried a HubSpot id — the orphan shape. */
const orphanEvent = {
  type: "delete_pulse", pulseId: 2855140556,
  itemName: "Vml",
  columnValues: { company_domain: { url: "https://vml.com", text: "vml.com" } },
};

describe("an Item-Association orphan is deleted", () => {
  it("is unattributable, and writes nothing anywhere", async () => {
    const r = await restoreDeletedCard(env, ACCOUNTS, "2855140556", orphanEvent, opts, budget);

    expect(r).toBe("unattributable");
    // the three things that could reach HubSpot or recreate a card
    expect(sync.syncHubspotObject).not.toHaveBeenCalled();
    expect(registry.forgetCard).not.toHaveBeenCalled();
    expect(registry.forgetCardOwner).not.toHaveBeenCalled();
  });

  it("does not consume any of the write budget", async () => {
    await restoreDeletedCard(env, ACCOUNTS, "2855140556", orphanEvent, opts, budget);
    expect(budget.left).toBe(30);
  });

  it("stays a no-op even when the payload carries a domain and a name", async () => {
    // the orphan's ONLY data is exactly this; none of it may be treated as an identity
    const r = await restoreDeletedCard(env, ACCOUNTS, "2855140556",
      { ...orphanEvent, itemName: "Chinastars",
        columnValues: { company_domain: { text: "chinastars.com.cn" } } }, opts, budget);
    expect(r).toBe("unattributable");
    expect(sync.syncHubspotObject).not.toHaveBeenCalled();
  });

  /**
   * The one way an orphan deletion could still act: a registry entry pairing the dead card with some
   * HubSpot id. Our code never created these cards, so none should exist — but if one did, the
   * deletion would restore rather than no-op, and a canary must avoid such a card.
   */
  it("WOULD restore if a registry entry existed — so a canary must confirm there is none", async () => {
    registry.lookupCardOwner.mockResolvedValue("346420839123");
    await restoreDeletedCard(env, ACCOUNTS, "2855140556", orphanEvent, opts, budget);
    expect(sync.syncHubspotObject).toHaveBeenCalled();      // documents the exception, not an endorsement
  });
});

describe("the rule that monday may never delete HubSpot", () => {
  it("a HubSpot-backed Company deletion RESTORES the card and issues no HubSpot delete", async () => {
    const ev = { type: "delete_pulse", pulseId: 2858208517,
      columnValues: { text_mm6tsnwx: { value: "346420839123" } } };
    const r = await restoreDeletedCard(env, ACCOUNTS, "2858208517", ev, opts, budget);

    expect(r).toBe("restored");
    expect(sync.syncHubspotObject).toHaveBeenCalledWith(
      env, "company", "346420839123", opts, budget, "2858208517");
    // the restore path clears the stale pairing; it never deletes or patches the HubSpot record
    expect(registry.forgetCard).toHaveBeenCalled();
  });

  it("nothing in the deletion path can reach a HubSpot delete or patch", async () => {
    await restoreDeletedCard(env, ACCOUNTS, "2858208517",
      { type: "delete_pulse", columnValues: { text_mm6tsnwx: { value: "346420839123" } } }, opts, budget);
    // syncHubspotObject is the ONLY outbound call, and it is the read-and-recreate path
    const calls = sync.syncHubspotObject.mock.calls as unknown as any[][];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("company");   // OBJECT_FOR maps the spec name to the singular
  });
});
