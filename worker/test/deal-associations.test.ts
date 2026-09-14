import { describe, it, expect } from "vitest";
import { sameSet, clearsFromEmpty, resolvedAllIds, shrinksFreshCard } from "../src/associations";
import { readCode } from "../scripts/read-source.mjs";

/**
 * ASSOCIATION PRESERVATION — the second of the two genuinely dangerous behaviours in the Deals phase,
 * and the one with an irreversible failure mode.
 *
 * MEASURED on portal 39939588 (scripts/measure-deal-associations.mjs, 2026-09-14):
 *
 *   Deal -> Companies   8,466 of 8,653 have one, 540 have TWO, max 2, 8,462 carry a `Primary` label
 *   Deal -> Contacts    3,449 of 8,653 have one, 314 have more than one, max 9, NO LABELS AT ALL
 *   Deal -> Line Items  6,347 of 8,653 have one, 2,527 have MORE than one, max 12
 *
 * Those numbers settle the design and these tests pin it:
 *
 *   - Every association is linked. Nothing is selected and nothing is discarded. The maxima are 2, 9
 *     and 12 against relation cells that hold ~750 elsewhere on this account, so no platform
 *     constraint forces a choice and no business one was stated.
 *   - monday never removes a HubSpot association. Displaying fewer links is not evidence that the
 *     others are wrong — which is the rule the Contacts phase spent five rounds of defects learning.
 *   - Multiple Line Items are the NORM, not an edge case: 29% of deals. Any design that shows one per
 *     deal silently discards data on nearly a third of the board.
 */

describe("the measured shape the design rests on", () => {
  /**
   * Guards against a future "just take the first one" simplification by writing the reason down as an
   * executable fact: with 540 two-company deals and 2,527 multi-line-item deals, selecting one is not
   * a tidy-up, it is data loss at a known scale.
   */
  const MEASURED = {
    companies: { withAny: 8466, withMulti: 540, max: 2, primaryLabelled: 8462 },
    contacts: { withAny: 3449, withMulti: 314, max: 9, primaryLabelled: 0 },
    lineItems: { withAny: 6347, withMulti: 2527, max: 12 },
  };

  it("no direction comes close to monday's relation-cell limit, so linking all is free", () => {
    for (const d of Object.values(MEASURED)) expect(d.max).toBeLessThan(50);
  });

  it("selecting one company would discard a second on 540 deals", () => {
    expect(MEASURED.companies.withMulti).toBeGreaterThan(0);
  });

  it("selecting one line item would discard data on 29% of deals", () => {
    const pct = MEASURED.lineItems.withMulti / 8653;
    expect(pct).toBeGreaterThan(0.25);
  });

  /** `Primary` exists on companies and is genuinely populated — 8,462 of the 8,466 deals that have a
   *  company — so a Primary Account field has real data behind it rather than being empty in
   *  production. Only 4 deals need the deterministic fallback. */
  it("Primary is populated on companies, so a Primary Account field is not empty in practice", () => {
    expect(MEASURED.companies.primaryLabelled).toBeGreaterThan(MEASURED.companies.withAny - 10);
  });

  /**
   * CONTACTS CARRY NO LABELS AT ALL. "Prefer the Primary contact" is not merely unpopulated here, it
   * is impossible — so any single-selection rule for contacts would have to key on something
   * arbitrary, and "the first result the API returns" is not stable across calls. Linking all removes
   * the need for a rule entirely.
   */
  it("contacts have no Primary label, so no non-arbitrary single-selection rule exists", () => {
    expect(MEASURED.contacts.primaryLabelled).toBe(0);
  });
});

describe("monday never removes a HubSpot association", () => {
  /**
   * The reverse association path is additive by construction — it only ever ADDS. This asserts that
   * in the source, because the property is the absence of a call rather than the presence of one, and
   * absence is invisible to a behavioural test.
   */
  it("reverseAssociations contains no HubSpot association delete", () => {
    const code = readCode("associations.ts");
    const fn = code.slice(code.indexOf("export async function reverseAssociations"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    expect(body).not.toMatch(/deleteAssociation|archiveAssociation|method:\s*["']DELETE["']/);
  });

  /** The forward path's existing guards, which the Deals specs inherit. Each one is a case where a
   *  SHRINKING link set is our blind spot rather than a user's removal. */
  it("an empty HubSpot read never clears existing monday links", () => {
    expect(clearsFromEmpty(["c1", "c2"], [])).toBe(true);
  });

  it("a partial resolution never clears links", () => {
    expect(resolvedAllIds(["h1", "h2"], ["c1"])).toBe(false);
  });

  it("a seconds-old card losing a link is held, not shrunk", () => {
    const now = Date.parse("2026-09-14T12:00:00Z");
    expect(shrinksFreshCard(new Date(now - 5000).toISOString(), ["cA"], ["cA", "cB"], now)).toBe(true);
  });

  it("an identical set is a no-op rather than a rewrite", () => {
    expect(sameSet(["1", "2"], ["2", "1"])).toBe(true);
  });
});

/**
 * THE GAP CARRIED FORWARD FROM THE CONTACTS PHASE, restated here because the Deals relations inherit
 * the same write path and the same hole.
 *
 * For a link to a target card carrying NO HubSpot ID, none of the four guards above holds: the sets
 * differ, HubSpot's set is not empty, the card is not fresh, and every id HubSpot returned did
 * resolve. So the full-replacement write proceeds and a hand-made link is deleted. Measured on the
 * Accounts board: 490 of 28,030 cards carry no HubSpot ID.
 *
 * This test pins today's behaviour so the Deals work cannot silently depend on it being safe. It is
 * NOT approval — the fix changes the live Work-Management Worker and needs sign-off. When the fifth
 * guard lands, THIS TEST SHOULD FAIL and be rewritten.
 */
describe("KNOWN GAP inherited by Deals: an id-less target can still be unlinked", () => {
  it("none of the four guards holds for a target with no HubSpot ID", () => {
    const now = Date.parse("2026-09-14T12:00:00Z");
    const established = new Date(now - 3600_000).toISOString();
    const current = ["cardA", "cardManual"];   // cardManual carries no HubSpot ID
    const want = ["cardA"];
    const ids = ["hsA"];

    expect(sameSet(current, want)).toBe(false);
    expect(clearsFromEmpty(current, want)).toBe(false);
    expect(shrinksFreshCard(established, want, current, now)).toBe(false);
    expect(resolvedAllIds(ids, want)).toBe(true);      // every returned id DID resolve
  });
});
