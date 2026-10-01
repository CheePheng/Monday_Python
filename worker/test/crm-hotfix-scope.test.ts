import { describe, it, expect } from "vitest";
import { readCode } from "../scripts/read-source.mjs";
import { specsFor, ALL_SPECS } from "../src/config";
import { mayCreateCrmCard } from "../src/ownership";
import { CRM_SPECS } from "../src/config/crm";
import type { HsRecord } from "../src/types";

/**
 * WHY THE LIFECYCLE HOTFIX COULD SHIP ON TOP OF IN-FLIGHT WM WORK.
 *
 * The Lifecycle Stage fix had to reach production quickly — reps' edits were being erased. But the tree
 * it shipped from also carried the unfinished symmetric-ownership work for the Work-Management Worker,
 * and the deployed CRM baseline was never committed, so there was no clean revision to branch a minimal
 * build from.
 *
 * Rather than hand-revert six files into a production deploy — which risks introducing a NEW fault while
 * avoiding a hypothetical one — the claim was made precise and tested: on the CRM deployment
 * (ENABLE_CRM=true), every one of those deltas is unreachable. This file is that proof, kept so the
 * reasoning is auditable rather than remembered.
 */

const crm = { ENABLE_CRM: "true" } as { ENABLE_CRM?: string };
const rec = (props: Record<string, string>): HsRecord => ({ id: "1", properties: props });

describe("the WM ownership work cannot affect the CRM deployment", () => {
  it("CRM resolves only CRM specs, so OWN_WM is never consulted", () => {
    expect(specsFor(crm)).toEqual(CRM_SPECS);
    for (const s of specsFor(crm)) expect(s.ownership?.owner).toBe("crm");
  });

  it("no WM spec is reachable from the CRM deployment at all", () => {
    const crmBoards = new Set(specsFor(crm).map(s => s.boardId));
    for (const w of ALL_SPECS) expect(crmBoards.has(w.boardId)).toBe(false);
  });

  /** The early return fires only for owner !== "crm". Every CRM spec is "crm", so CRM always takes the
   *  CRM branch. Proven with a PARKED record: the WM short-circuit would card it, the CRM branch does
   *  not. (The CRM branch itself changed on 2026-09-23 -- an unstamped record of any age is now carded,
   *  because the historical import is complete; see mayCreateCrmCard.) */
  it("mayCreateCrmCard's WM short-circuit never fires on a CRM spec", () => {
    for (const s of CRM_SPECS) {
      expect(s.ownership!.owner).toBe("crm");
      expect(mayCreateCrmCard(rec({ sync_owner: "hold", createdate: "2026-09-20T00:00:00Z" }), s.ownership)).toBe(false);
    }
  });
});

describe("the line-item and association guards are unreachable on CRM", () => {
  /** Both new guards sit behind callers that CRM cannot reach. Asserted structurally, because
   *  "no caller" is the whole reason the hotfix was safe. */
  it("no CRM spec declares subitems, so the subitem reverse path never runs", () => {
    for (const s of CRM_SPECS)
      for (const a of s.associations ?? [])
        expect(a.subitems, `${s.object} -> ${a.toObject} declares subitems`).toBeUndefined();
  });

  it("the subitems board belongs to Work Management, so CRM cannot resolve it", async () => {
    const { LINE_ITEM_SUBITEMS, specByBoard } = await import("../src/config");
    expect(LINE_ITEM_SUBITEMS.boardId).toBe("5029480548");
    expect(specByBoard(crm, LINE_ITEM_SUBITEMS.boardId)).toBeUndefined();
  });

  /**
   * THE ONE THAT NEEDED CHECKING. `/app/*` is not gated by the session secret alone — authApp also
   * accepts X-Trigger-Secret, which the CRM Worker DOES have. So the app routes are reachable there in
   * principle, and the guards would change behaviour if anything called them. Nothing does: the Board
   * View app is pointed at the Work-Management Worker.
   */
  it("the monday Board View app targets the WM Worker, not CRM", () => {
    const cfg = readCode("../../monday-app/src/board-config.ts");
    expect(cfg).toContain("hubspot-monday-sync.askada.workers.dev");
    expect(cfg).not.toContain("hubspot-monday-crm-sync");
  });
});

describe("the hotfix itself is the only CRM behaviour change", () => {
  it("lifecyclestage is the field that changed direction", async () => {
    const { CRM_CONTACTS } = await import("../src/config/crm");
    expect(CRM_CONTACTS.fields.find(f => f.hs === "lifecyclestage")?.reverse).toBe(true);
  });

  /** A reverse write still needs ownership. What changed on 2026-09-23 is HOW an unstamped record
   *  becomes CRM's -- a person's edit on a CRM card now claims it -- not whether ownership is needed.
   *  An explicit stamp is still never overridden, by a claim or by carding. */
  it("an explicit stamp is still never overridden", async () => {
    const { CRM_CONTACTS } = await import("../src/config/crm");
    const { canClaimCrmOwnership } = await import("../src/ownership");
    expect(CRM_CONTACTS.ownership?.owner).toBe("crm");
    for (const stamp of ["wm", "hold"]) {
      const r = rec({ sync_owner: stamp, createdate: "2020-01-01T00:00:00Z" });
      expect(canClaimCrmOwnership(r, CRM_CONTACTS.ownership!, "human-edit")).toBe(false);
      expect(mayCreateCrmCard(r, CRM_CONTACTS.ownership)).toBe(false);
    }
  });
});
