import { describe, it, expect } from "vitest";
// .mjs because the historical-import scripts run under plain Node, outside the Worker tsconfig —
// the same reason scripts/read-source.mjs is imported by the structural tests.
import {
  planContactLinks, WRITE, ALREADY_CORRECT, CAPPED, NO_ACCOUNT_CARD,
} from "../scripts/relation-plan.mjs";

/**
 * THE PROJECTED-LINK COUNTER, and the three defects it shipped with.
 *
 * monday's board_relation columns are PAIRED: every contact -> account link also grows the ACCOUNT's
 * cell, and the cell stops accepting links at ~751 (measured on HubSpot company 37258070678, whose
 * card took 751). The relations pass therefore projects each account's cell size and refuses to ADD
 * beyond a 740 ceiling.
 *
 * The first version of that projection was written inline in backfill-crm.mjs and had three bugs that
 * only a 94,000-record production pass would have surfaced. Each test below names one.
 */

const acct = (pairs: [string, string][]) => new Map(pairs.map(([hs, item]) => [hs, [item]]));
const CEILING = 740;

describe("defect 1 — an already-linked association must not be charged twice", () => {
  /**
   * THE EXACT REGRESSION CASE. The up-front read of the Accounts board already counts every existing
   * link, so charging one again during the contact scan counts it twice.
   *
   * MEASURED AGAINST THE OLD LOGIC: an account holding 600 links, scanned across its own already-
   * linked contacts, is refused from contact **#141** onward — 600 + 140 = 740. It does NOT run away
   * to 1,200: the guard refuses before it increments, so the projection plateaus exactly ON the
   * ceiling and then rejects everything. That makes the symptom quieter and worse — the counter looks
   * plausible while every genuinely new link to a large account is silently skipped. The bug punishes
   * precisely the accounts the ceiling was raised from 200 to 740 to rescue.
   */
  it("600 existing links + 500 already-linked contacts scanned == still 600", () => {
    const counts = new Map([["A1", 600]]);
    const accounts = acct([["hs1", "A1"]]);

    for (let i = 0; i < 500; i++) {
      const plan = planContactLinks({
        companyIds: ["hs1"],
        linked: ["A1"],                       // this contact is ALREADY linked to the account
        counts, accounts, ceiling: CEILING,
      });
      expect(plan.outcome).toBe(ALREADY_CORRECT);
      expect(plan.capped).toEqual([]);
    }

    expect(counts.get("A1")).toBe(600);       // the old logic reached 740 and then refused everything
  });

  it("then 10 genuinely new links take it to 610, rather than being refused", () => {
    const counts = new Map([["A1", 600]]);
    const accounts = acct([["hs1", "A1"]]);

    for (let i = 0; i < 500; i++)
      planContactLinks({ companyIds: ["hs1"], linked: ["A1"], counts, accounts, ceiling: CEILING });
    for (let i = 0; i < 10; i++) {
      const plan = planContactLinks({
        companyIds: ["hs1"], linked: [], counts, accounts, ceiling: CEILING,
      });
      expect(plan.outcome).toBe(WRITE);
      expect(plan.want).toEqual(["A1"]);
    }

    expect(counts.get("A1")).toBe(610);
  });

  /** The charge must also not happen on the ALREADY_CORRECT path, where no write is queued at all. */
  it("charges nothing when no write will be queued", () => {
    const counts = new Map([["A1", 5]]);
    const plan = planContactLinks({
      companyIds: ["hs1"], linked: ["A1"], counts, accounts: acct([["hs1", "A1"]]), ceiling: CEILING,
    });
    expect(plan.outcome).toBe(ALREADY_CORRECT);
    expect(counts.get("A1")).toBe(5);
  });
});

describe("defect 2 — a capped account must be RETAINED, never dropped", () => {
  /**
   * THE DATA-LOSS ONE, and the reason the pass was stopped mid-run rather than left to finish.
   *
   * The write is change_multiple_column_values with `item_ids`, which REPLACES the relation cell
   * rather than appending to it. Dropping a capped account out of `want` therefore does not "skip"
   * it — it DELETES an existing, valid relation as soon as the contact needs any other link.
   *
   * MEASURED 2026-09-11: exactly two Accounts cards are at or above 740 — 2855677250 holding 750
   * links and 2855584566 holding 745 — so every multi-company contact of those two was exposed.
   * (An earlier note here said "2,007 and 1,581 contacts". Both figures were wrong for this purpose:
   * they were HubSpot association counts rather than monday cell sizes, and the 1,581 one was
   * fake.com, a company this project deleted the same day.)
   *
   * The ceiling exists to stop us ADDING to a full cell. It must never remove from one.
   */
  it("keeps the existing link to a full account while adding a new one elsewhere", () => {
    const counts = new Map([["BIG", 751], ["SMALL", 3]]);
    const accounts = acct([["hsBig", "BIG"], ["hsSmall", "SMALL"]]);

    const plan = planContactLinks({
      companyIds: ["hsBig", "hsSmall"],
      linked: ["BIG"],                        // already linked to the full account
      counts, accounts, ceiling: CEILING,
    });

    expect(plan.outcome).toBe(WRITE);
    expect(plan.want).toContain("BIG");       // ← was absent, which deleted the link
    expect(plan.want).toContain("SMALL");
    expect(plan.capped).toEqual([]);          // retention is not a cap event
    expect(counts.get("BIG")).toBe(751);      // retained, not re-charged
    expect(counts.get("SMALL")).toBe(4);
  });

  it("still refuses to ADD a new link to a full account", () => {
    const counts = new Map([["BIG", 740]]);
    const plan = planContactLinks({
      companyIds: ["hsBig"], linked: [], counts, accounts: acct([["hsBig", "BIG"]]), ceiling: CEILING,
    });
    expect(plan.outcome).toBe(CAPPED);
    expect(plan.capped).toEqual(["hsBig"]);
    expect(plan.want).toEqual([]);
    expect(counts.get("BIG")).toBe(740);
  });

  /** A contact whose ONLY company is full is left unlinked — but reported as capped, not as a
   *  missing Accounts card, because those two mean opposite things operationally. */
  it("distinguishes 'account is full' from 'account has no card'", () => {
    const full = planContactLinks({
      companyIds: ["hsBig"], linked: [],
      counts: new Map([["BIG", 999]]), accounts: acct([["hsBig", "BIG"]]), ceiling: CEILING,
    });
    expect(full.outcome).toBe(CAPPED);

    const noCard = planContactLinks({
      companyIds: ["hsGhost"], linked: [],
      counts: new Map(), accounts: acct([]), ceiling: CEILING,
    });
    expect(noCard.outcome).toBe(NO_ACCOUNT_CARD);
    expect(noCard.missing).toEqual(["hsGhost"]);
  });
});

describe("defect 3 — THE BACKFILL MUST NEVER REMOVE A RELATION", () => {
  /**
   * THE AGREED PROJECT RULE is that removing a Contact -> Company relation requires positive user
   * intent. A bulk pass over 94,000 cards is the exact opposite of per-record intent, and the write
   * monday offers is a full replacement, so a `want` built purely from HubSpot's current associations
   * deletes every link HubSpot does not presently assert.
   *
   * THE ADVISOR'S EXACT SCENARIO. It is not an edge case: 320 of the 27,824 Accounts cards carry no
   * HubSpot ID, and `want` is resolved through an index keyed by that column, so a link to one of
   * those cards can never appear in `want` — structurally, on every contact that holds one.
   */
  it("preserves Account B when HubSpot associates only A", () => {
    const counts = new Map([["A", 10], ["B", 20]]);
    const accounts = acct([["hsA", "A"]]);   // B is NOT in the index: no HubSpot ID, manual link

    const plan = planContactLinks({
      companyIds: ["hsA"],                   // HubSpot says A only
      linked: ["A", "B"],                    // monday says A and B
      counts, accounts, ceiling: CEILING,
    });

    expect(plan.want).toContain("B");        // ← the whole point
    expect(plan.want).toContain("A");
    expect(plan.outcome).toBe(ALREADY_CORRECT);   // nothing to ADD, so nothing to write
    expect(plan.extra).toEqual(["B"]);            // reported, so the divergence is known
    expect(counts.get("B")).toBe(20);             // untouched, not decremented
  });

  /** The same contact, but now genuinely missing a HubSpot link. The write must ADD C and still carry
   *  B, because `want` is what the cell will CONTAIN, not what to append. */
  it("carries the manual link through a write that adds a new one", () => {
    const counts = new Map([["A", 10], ["B", 20], ["C", 30]]);
    const accounts = acct([["hsA", "A"], ["hsC", "C"]]);

    const plan = planContactLinks({
      companyIds: ["hsA", "hsC"], linked: ["A", "B"], counts, accounts, ceiling: CEILING,
    });

    expect(plan.outcome).toBe(WRITE);
    expect(plan.want.slice().sort()).toEqual(["A", "B", "C"]);
    expect(plan.added).toEqual(["C"]);
    expect(plan.extra).toEqual(["B"]);
    expect(counts.get("B")).toBe(20);        // never charged, never released
    expect(counts.get("C")).toBe(31);        // only the genuine addition moves
  });

  /** A HubSpot association that really was removed is ALSO preserved. That is deliberate: this pass
   *  cannot tell "the rep left the company" from "a salesperson linked this by hand", and guessing
   *  wrong in the destructive direction is unrecoverable. Reconciliation is a separate, audited pass. */
  it("preserves a link whose HubSpot association was genuinely removed, and says so", () => {
    const counts = new Map([["A1", 10], ["A2", 20]]);
    const accounts = acct([["hs1", "A1"], ["hs2", "A2"]]);

    const plan = planContactLinks({
      companyIds: ["hs1"], linked: ["A1", "A2"], counts, accounts, ceiling: CEILING,
    });

    expect(plan.want.slice().sort()).toEqual(["A1", "A2"]);
    expect(plan.outcome).toBe(ALREADY_CORRECT);
    expect(plan.extra).toEqual(["A2"]);
    expect(counts.get("A2")).toBe(20);
  });

  /** No input can make `want` smaller than the cell it replaces. Asserted as a property rather than
   *  by example, because this is the invariant that makes the pass safe to run on 94,000 cards. */
  it("never returns a `want` that drops any existing link", () => {
    const cases = [
      { companyIds: [] as string[], linked: ["A", "B"] },
      { companyIds: ["hsGhost"], linked: ["A"] },
      { companyIds: ["hsA"], linked: ["A", "B", "C"] },
      { companyIds: ["hsBig"], linked: ["BIG", "X"] },
      { companyIds: ["hsA", "hsBig"], linked: ["B"] },
    ];
    for (const c of cases) {
      const plan = planContactLinks({
        ...c,
        counts: new Map([["BIG", 999], ["A", 1], ["B", 1], ["C", 1], ["X", 1]]),
        accounts: acct([["hsA", "A"], ["hsBig", "BIG"]]),
        ceiling: CEILING,
      });
      for (const had of c.linked) expect(plan.want).toContain(had);
      expect(plan.want.length).toBeGreaterThanOrEqual(c.linked.length);
    }
  });
});

describe("the ceiling boundary is inclusive on refusal", () => {
  it("739 accepts one more and lands exactly on 740", () => {
    const counts = new Map([["A1", 739]]);
    const plan = planContactLinks({
      companyIds: ["hs1"], linked: [], counts, accounts: acct([["hs1", "A1"]]), ceiling: CEILING,
    });
    expect(plan.outcome).toBe(WRITE);
    expect(counts.get("A1")).toBe(740);
  });

  it("740 refuses, so our writes never push a cell past the ceiling", () => {
    const counts = new Map([["A1", 740]]);
    const plan = planContactLinks({
      companyIds: ["hs1"], linked: [], counts, accounts: acct([["hs1", "A1"]]), ceiling: CEILING,
    });
    expect(plan.outcome).toBe(CAPPED);
    expect(counts.get("A1")).toBe(740);
  });

  /**
   * THE CEILING PARAMETER MUST ACTUALLY BE USED. Every other test in this file passes 740, which is
   * also the production default — so a hardcoded `>= 740` in place of `>= ceiling` would leave the
   * whole suite green while silently ignoring --relation-cap. One test at a different value is what
   * makes the parameter's existence observable.
   */
  it("honours a ceiling that is not the production default", () => {
    const counts = new Map([["A1", 9]]);
    const accounts = acct([["hs1", "A1"]]);

    const refused = planContactLinks({
      companyIds: ["hs1"], linked: [], counts, accounts, ceiling: 9,
    });
    expect(refused.outcome).toBe(CAPPED);
    expect(counts.get("A1")).toBe(9);

    const allowed = planContactLinks({
      companyIds: ["hs1"], linked: [], counts, accounts, ceiling: 10,
    });
    expect(allowed.outcome).toBe(WRITE);
    expect(counts.get("A1")).toBe(10);
  });

  /** An account absent from the counts map has never been read as holding anything, so it is empty,
   *  not unknown-and-therefore-refused. Treating "missing" as full would skip real links. */
  it("treats an unread account as empty rather than as full", () => {
    const counts = new Map();
    const plan = planContactLinks({
      companyIds: ["hs1"], linked: [], counts, accounts: acct([["hs1", "A1"]]), ceiling: CEILING,
    });
    expect(plan.outcome).toBe(WRITE);
    expect(counts.get("A1")).toBe(1);
  });
});

describe("multi-company contacts and partial existing sets", () => {
  /** The case the advisor asked about specifically: a partially-correct cell must charge only the
   *  genuinely new member, not the whole set. */
  it("charges only the new member of a partially correct set", () => {
    const counts = new Map([["A1", 100], ["A2", 200], ["A3", 300]]);
    const accounts = acct([["hs1", "A1"], ["hs2", "A2"], ["hs3", "A3"]]);

    const plan = planContactLinks({
      companyIds: ["hs1", "hs2", "hs3"],
      linked: ["A1", "A2"],                   // two of three already linked
      counts, accounts, ceiling: CEILING,
    });

    expect(plan.outcome).toBe(WRITE);
    expect(plan.want.sort()).toEqual(["A1", "A2", "A3"]);
    expect(counts.get("A1")).toBe(100);
    expect(counts.get("A2")).toBe(200);
    expect(counts.get("A3")).toBe(301);       // only this one is new
  });

  it("is order-insensitive when deciding a set is already correct", () => {
    const counts = new Map([["A1", 1], ["A2", 2]]);
    const plan = planContactLinks({
      companyIds: ["hs2", "hs1"], linked: ["A1", "A2"],
      counts, accounts: acct([["hs1", "A1"], ["hs2", "A2"]]), ceiling: CEILING,
    });
    expect(plan.outcome).toBe(ALREADY_CORRECT);
    expect(counts.get("A1")).toBe(1);
    expect(counts.get("A2")).toBe(2);
  });

  /** HubSpot returning the same company twice must not double-charge it, and must not put a duplicate
   *  in `want` — a duplicate would also break the already-correct comparison. */
  it("deduplicates repeated company ids", () => {
    const counts = new Map([["A1", 10]]);
    const plan = planContactLinks({
      companyIds: ["hs1", "hs1"], linked: [],
      counts, accounts: acct([["hs1", "A1"]]), ceiling: CEILING,
    });
    expect(plan.want).toEqual(["A1"]);
    expect(counts.get("A1")).toBe(11);
  });

  it("tolerates numeric ids on either side", () => {
    const counts = new Map([["A1", 0]]);
    const plan = planContactLinks({
      companyIds: [123 as unknown as string], linked: [],
      counts, accounts: new Map([["123", ["A1"]]]), ceiling: CEILING,
    });
    expect(plan.outcome).toBe(WRITE);
    expect(plan.want).toEqual(["A1"]);
  });
});

describe("the aggregate the pass actually reports", () => {
  /**
   * End-to-end over one oversized account, asserting the number the advisor wants in the report: how
   * many contacts are left unlinked SOLELY because monday's cell is full. With the double-count bug
   * this figure was inflated by phantom skips; with the retention bug it was accompanied by silent
   * deletions.
   */
  it("an account at 738 takes exactly 2 more links and caps the rest", () => {
    const counts = new Map([["A1", 738]]);
    const accounts = acct([["hs1", "A1"]]);
    let written = 0, capped = 0;

    for (let i = 0; i < 50; i++) {
      const plan = planContactLinks({
        companyIds: ["hs1"], linked: [], counts, accounts, ceiling: CEILING,
      });
      if (plan.outcome === WRITE) written++;
      if (plan.outcome === CAPPED) capped++;
    }

    expect(written).toBe(2);
    expect(capped).toBe(48);
    expect(counts.get("A1")).toBe(740);
  });
});
