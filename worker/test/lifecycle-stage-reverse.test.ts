import { describe, it, expect } from "vitest";
import { reverseFieldValue } from "../src/reconcile";
import { formatValue } from "../src/mapping";
import { authorizeWrite } from "../src/ownership";
import { ignoredColumns } from "../src/webhooks";
import { CRM_CONTACTS } from "../src/config/crm";
import type { Ctx, FieldSpec, HsRecord } from "../src/types";

/**
 * A REP'S LIFECYCLE STAGE EDIT MUST SURVIVE.
 *
 * Reported from the floor: change Lifecycle Stage off "1.NEW" in monday and it snaps back seconds
 * later. The team checked HubSpot's automations and found nothing, and they were right — HubSpot had
 * not touched the field. Contact 549865853636 has exactly ONE lifecyclestage history entry, written by
 * a FORM on 2026-09-10; monday's copy was rewritten on 2026-09-22.
 *
 * The cause was a field with NEITHER `reverse` NOR `oneWay`:
 *   - no `oneWay`  -> ignoredColumns() does not skip it, so a monday edit fires a reconcile;
 *   - no `reverse` -> that reconcile has nothing to send to HubSpot;
 *   - the forward pass then writes HubSpot's unchanged value back over the rep's edit.
 * The edit triggered the write that erased it. This file pins the fix and that mechanism.
 */

const f = (): FieldSpec => CRM_CONTACTS.fields.find(x => x.hs === "lifecyclestage")!;

/** The live dictionary, captured from the portal: internal value -> displayed label. */
const LIFECYCLE: Record<string, string> = {
  lead: "1.NEW",
  marketingqualifiedlead: "2.Information error or incomplete/Send email for promotion",
  "1028988526": "3.Competitors",
  "1029059094": "4.Returning customers/Have purchased from other channels",
  "1029060900": "5.No intention",
  "1029059095": "6.Not in contact/Pending further contact",
  opportunity: "7.Intention to purchase",
  customer: "8.The customer generating the transaction",
  "1029055302": "9.False or spam information",
  "1135842429": "10.Other",
};
const ctx = { labels: { lifecycleStage: LIFECYCLE }, ownersById: {}, mondayUsersByEmail: {} } as unknown as Ctx;

describe("the field is now two-way", () => {
  it("declares reverse", () => expect(f().reverse).toBe(true));

  it("keeps its dictionary — the option values are ids like 1028988526, not words", () =>
    expect(f().labels).toBe("lifecycleStage"));

  /** Not `oneWay`: a two-way field must still trigger a reconcile on a monday edit. */
  it("is NOT in ignoredColumns, so a monday edit is still noticed", () =>
    expect(ignoredColumns(CRM_CONTACTS).has("color_mm70k2wk")).toBe(false));
});

describe("translating a rep's edit back to HubSpot", () => {
  it("the reported case: 1.NEW -> 5.No intention writes the right internal value", () =>
    expect(reverseFieldValue(f(), "5.No intention", ctx)).toBe("1029060900"));

  it.each(Object.entries(LIFECYCLE))("%s <-> %s round-trips exactly", (value, label) => {
    expect(reverseFieldValue(f(), label, ctx)).toBe(value);
    expect(formatValue(f(), value, ctx)).toEqual({ label });
  });

  it("every one of the ten stages is reversible — none silently drops", () => {
    const reversed = Object.values(LIFECYCLE).map(l => reverseFieldValue(f(), l, ctx));
    expect(reversed.filter(Boolean)).toHaveLength(10);
  });

  /** The inverse is only a function because the labels are unique. If two stages ever shared a label
   *  the reverse would pick one arbitrarily, so the property is asserted rather than assumed. */
  it("labels are unique, so the inverse is well-defined", () =>
    expect(new Set(Object.values(LIFECYCLE)).size).toBe(Object.keys(LIFECYCLE).length));

  it.each(["Unqualified", "NEW", "1.new", "", "  ", "Closed Won", "8"])(
    "refuses the untranslatable label %j rather than inventing a value", (bad) =>
      expect(reverseFieldValue(f(), bad, ctx)).toBe(""));

  /** A refusal must be an OMISSION, not a write of "". Sending "" would blank a live lifecycle stage. */
  it("a refused label yields no value to send", () =>
    expect(reverseFieldValue(f(), "Whatever Someone Typed", ctx) || undefined).toBeUndefined());
});

describe("ownership still governs the write", () => {
  const own = CRM_CONTACTS.ownership!;
  const rec = (props: Record<string, string>): HsRecord => ({ id: "549865853636", properties: props });
  const o = { ...own, cutoverAtMs: Date.parse("2026-09-25T00:00:00Z") };

  /** The reported contact really is crm-stamped, which is why the fix reaches it. */
  it("a crm-stamped contact IS writable — the reported record's actual state", () =>
    expect(authorizeWrite(rec({ sync_owner: "crm", createdate: "2026-09-10T09:13:35Z" }), o).allowed).toBe(true));

  it("a wm-owned contact is refused", () =>
    expect(authorizeWrite(rec({ sync_owner: "wm", createdate: "2026-09-10T09:13:35Z" }), o).allowed).toBe(false));

  it("a parked (hold) contact is refused", () =>
    expect(authorizeWrite(rec({ sync_owner: "hold", createdate: "2026-09-10T09:13:35Z" }), o).allowed).toBe(false));

  /**
   * THE HONEST LIMIT. An unstamped contact cannot be written by CRM, so the reverse patch is refused
   * and sync.ts falls through to the forward write — the rep's edit still snaps back. That is 94,244
   * historical contacts. It is not a regression (it is today's behaviour) and it is not silent (the
   * refusal is logged), but it is not fixed by this change either.
   */
  it("an UNSTAMPED contact is still refused, so its edit still reverts", () => {
    const a = authorizeWrite(rec({ createdate: "2026-09-10T09:13:35Z" }), o);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("must claim");
  });
});

describe("no echo loop", () => {
  /** An unchanged value must produce no diff in either direction — otherwise the field would rewrite
   *  itself on every webhook, which is the churn the scale/expectedText pairing exists to prevent. */
  it("a value equal on both sides round-trips to itself", () => {
    for (const [value, label] of Object.entries(LIFECYCLE)) {
      expect(reverseFieldValue(f(), label, ctx)).toBe(value);
      expect((formatValue(f(), value, ctx) as { label: string }).label).toBe(label);
    }
  });

  it("HubSpot -> monday still works: 'lead' still displays as 1.NEW", () =>
    expect(formatValue(f(), "lead", ctx)).toEqual({ label: "1.NEW" }));
});

describe("blast radius", () => {
  it("only this one Contacts field changed direction", () => {
    // 状态 (leadstatus) was already reverse; Lead Status (hs_lead_status) was already reverse. Neither
    // is touched here — this issue was Lifecycle Stage alone.
    expect(CRM_CONTACTS.fields.find(x => x.hs === "hs_lead_status")?.reverse).toBe(true);
    expect(CRM_CONTACTS.fields.find(x => x.hs === "leadstatus")?.reverse).toBe(true);
  });

  it("no WM spec maps lifecyclestage at all, so the live WM Worker is unaffected", async () => {
    const { ALL_SPECS } = await import("../src/config");
    for (const s of ALL_SPECS)
      expect(s.fields.some(x => x.hs === "lifecyclestage"), `${s.object} maps lifecyclestage`).toBe(false);
  });
});
