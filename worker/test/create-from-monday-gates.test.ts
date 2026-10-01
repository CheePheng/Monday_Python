import { describe, it, expect } from "vitest";
import { buildCreateProperties } from "../src/reconcile";
import { specsFor, specByObject, CREATE_CUTOFF_MS } from "../src/config";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS, CRM_CREATE_CUTOFF_MS } from "../src/config/crm";
import type { Ctx, MondayItem, ObjectSpec } from "../src/types";

/**
 * THE THREE GUARDS THAT MAKE "monday form -> HubSpot record" SAFE TO SHIP.
 *
 * Enabling creation is one boolean. Enabling it SAFELY is these:
 *
 *   1. a go-live cutoff, so the ~1,301 id-less Accounts cards that monday's Item association
 *      manufactured in September cannot each mint a HubSpot Company the first time anyone edits them;
 *   2. an adoption key that reaches the birth payload, so a Contact is never born unfindable;
 *   3. a stage that belongs to its pipeline, because HubSpot rejects a deal whose pair does not match.
 */

const SF_SALES_STAGE = "833608d9-3cbb-4bae-93a0-d0d1bf6c1064";   // "1 共同利益 MI" in Salesforce - Sales
const SF_SALES_PIPELINE = "551f4f6c-ced0-4069-b1be-f0d3dc33bf2d";

/**
 * The monday dropdown stores a LABEL, not the HubSpot stage id — so the create path is only correct
 * when the stage dictionary is loaded. Modelling that faithfully matters: with an empty dictionary
 * `reverseFieldValue` refuses the value (by design, so a renamed label cannot 400 HubSpot), the stage
 * never reaches the payload, and `createDefaults` silently answers instead. That is the right
 * behaviour and it is asserted separately below.
 */
const ctx = {
  labels: { crmStage: { [SF_SALES_STAGE]: "SF-Sales / 1 共同利益 MI" } },
  ownersById: {}, mondayUsersByEmail: {}, ownerIdByEmail: {}, ownerIdByName: {},
  mondayEmailByUserId: {}, portalId: 1,
  pipelineByStage: { [SF_SALES_STAGE]: SF_SALES_PIPELINE },
} as unknown as Ctx;

const item = (cols: Record<string, string>, name = "New Row"): MondayItem => ({
  id: "i1", name, created_at: "2026-09-21T00:00:00Z", updated_at: "", group: { id: "topics" },
  column_values: Object.entries(cols).map(([id, text]) => ({ id, text })) as never,
});

const crm = (extra: Record<string, string> = {}) =>
  ({ ENABLE_CRM: "true", ...extra }) as { ENABLE_CRM?: string; CRM_CUTOVER_AT?: string; CRM_CREATE_CUTOFF_AT?: string };

// ------------------------------------------------------------------ 1. the go-live cutoff

describe("nothing creates until a go-live timestamp says so", () => {
  it("ships INERT: the create cutoff is infinite, so no card is newer than it", () => {
    expect(CRM_CREATE_CUTOFF_MS).toBe(Number.POSITIVE_INFINITY);
    for (const s of specsFor(crm()))
      if (s.createFromMonday) expect(s.createCutoffMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("does NOT fall back to the Work-Management constant, which is far too old", () => {
    // 2026-07-03. Every id-less Accounts card was made in September and would clear it.
    expect(CREATE_CUTOFF_MS).toBeLessThan(Date.parse("2026-08-01T00:00:00Z"));
    for (const s of specsFor(crm()))
      if (s.createFromMonday) expect(s.createCutoffMs).not.toBe(CREATE_CUTOFF_MS);
  });

  it("an explicit go-live timestamp turns creation on from that moment", () => {
    const specs = specsFor(crm({ CRM_CREATE_CUTOFF_AT: "2026-09-22T00:00:00Z" }));
    for (const s of specs)
      if (s.createFromMonday) expect(s.createCutoffMs).toBe(Date.parse("2026-09-22T00:00:00Z"));
  });

  it.each(["", "   ", "not-a-date", "1999-01-01T00:00:00Z", "2999-01-01T00:00:00Z"])(
    "FAILS CLOSED on a malformed or implausible value (%j) — creates nothing", (v) => {
      for (const s of specsFor(crm({ CRM_CREATE_CUTOFF_AT: v })))
        if (s.createFromMonday) expect(s.createCutoffMs).toBe(Number.POSITIVE_INFINITY);
    });

  /** The documented invariant: absent env -> the ORIGINAL objects, because callers compare by reference. */
  it("returns the original spec objects when no override is set", () => {
    expect(specByObject(crm(), "contacts")).toBe(CRM_CONTACTS);
    expect(specByObject(crm(), "companies")).toBe(CRM_ACCOUNTS);
    expect(specByObject(crm(), "deals")).toBe(CRM_DEALS);
  });

  it("leaves the Work-Management specs entirely alone", () => {
    for (const s of specsFor({ CRM_CREATE_CUTOFF_AT: "2026-09-22T00:00:00Z" } as never))
      expect(s.createCutoffMs).toBeUndefined();
  });
});

// ------------------------------------------------------------------ 2. the adoption key at birth

describe("a Contact is born with the key that identifies it", () => {
  it("email reaches the CREATE payload", () => {
    const props = buildCreateProperties(item({ contact_email: "jo@acme.com" }, "Jo Smith"), CRM_CONTACTS, ctx);
    expect(props.email).toBe("jo@acme.com");
  });

  // Two-way since 2026-09-23. A later edit rewrites the ADDRESS, never the card's link: once a card holds
  // a HubSpot ID it is found by that id, so the dedup key only matters at birth.
  it("and a later edit can correct it, pushed only when that cell is edited", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "email")!;
    expect(f.reverse).toBe(true);
    expect(f.writeOnCreate).toBe(true);
    expect(CRM_CONTACTS.columnLevelReverse).toBe(true);
  });

  it("writeOnCreate widens ONLY the create builder — no other CRM field uses it", () => {
    const flagged = [CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS]
      .flatMap(s => s.fields.filter(f => f.writeOnCreate).map(f => `${s.object}.${f.hs}`));
    expect(flagged).toEqual(["contacts.email"]);
  });

  it("an Account is still born with its domain, which is ITS adoption key", () => {
    const props = buildCreateProperties(item({ company_domain: "acme.com" }, "Acme"), CRM_ACCOUNTS, ctx);
    expect(props.domain).toBe("acme.com");
  });
});

// ------------------------------------------------------------------ 3. a legal pipeline/stage pair

describe("a Deal is born into a pipeline that accepts its stage", () => {
  it("falls back to the declared default pair when the rep chose nothing", () => {
    const props = buildCreateProperties(item({}, "New Deal"), CRM_DEALS, ctx);
    expect(props.pipeline).toBe("default");
    expect(props.dealstage).toBe("appointmentscheduled");
  });

  it("derives the pipeline FROM the stage the rep picked, overriding the default", () => {
    // The rep picks a Salesforce-Sales stage by its label; Deal Pipeline is hidden on the form and
    // contributes nothing. Without the pairing this would ship SF-Sales stage + "default" pipeline,
    // which HubSpot rejects outright.
    const props = buildCreateProperties(
      item({ dropdown_mm7624zd: "SF-Sales / 1 共同利益 MI" }), CRM_DEALS, ctx);
    expect(props.dealstage).toBe(SF_SALES_STAGE);
    expect(props.pipeline).toBe(SF_SALES_PIPELINE);   // NOT "default"
  });

  it("a label the dictionary does not know falls back to the default PAIR, never a mismatch", () => {
    const props = buildCreateProperties(item({ dropdown_mm7624zd: "Some Renamed Label" }), CRM_DEALS, ctx);
    expect(props.dealstage).toBe("appointmentscheduled");
    expect(props.pipeline).toBe("default");
  });

  /** An empty dictionary is the cold-start / failed-fetch case, and must still produce a legal deal. */
  it("an unloaded stage dictionary still produces a legal pair", () => {
    const cold = { ...ctx, labels: {} } as unknown as Ctx;
    const props = buildCreateProperties(item({ dropdown_mm7624zd: "SF-Sales / 1 共同利益 MI" }), CRM_DEALS, cold);
    expect(props.dealstage).toBe("appointmentscheduled");
    expect(props.pipeline).toBe("default");
  });

  it("never emits a stage with no pipeline — the shape HubSpot rejects", () => {
    const cases: Record<string, string>[] = [
      {}, { dropdown_mm7624zd: "Some Renamed Label" }, { dropdown_mm7624zd: "SF-Sales / 1 共同利益 MI" }];
    for (const cols of cases) {
      const p = buildCreateProperties(item(cols), CRM_DEALS, ctx);
      expect(p.dealstage, "a deal must always be born with a stage").toBeTruthy();
      expect(p.pipeline, `stage ${p.dealstage} shipped with no pipeline`).toBeTruthy();
    }
  });

  it("the default stage is an OPEN stage, not a closed one", () => {
    // appointmentscheduled is the first stage of HubSpot's own Sales Pipeline (verified live).
    expect(CRM_DEALS.createDefaults?.dealstage).toBe("appointmentscheduled");
    expect(CRM_DEALS.createDefaults?.dealstage).not.toMatch(/closed/);
  });

  it("Deals declare NO adoptBy — deal names are not unique", () => {
    expect(CRM_DEALS.adoptBy).toBeUndefined();
  });

  /** WM deals must keep their own defaults untouched. */
  it("the Work-Management deal spec is unchanged", async () => {
    const { DEALS } = await import("../src/config");
    expect(DEALS.createDefaults).toEqual({ pipeline: "default" });
    expect(DEALS.stagePipelinePairing).toBeUndefined();
  });
});

describe("which CRM objects create at all", () => {
  it("all four do — the 创建/Create form on every CRM board must reach HubSpot", () => {
    const flags = Object.fromEntries(
      specsFor(crm()).map(s => [s.object, !!s.createFromMonday]));
    expect(flags).toEqual({ contacts: true, companies: true, deals: true, line_items: true });
  });

  it("each has a duplicate defence appropriate to its object", () => {
    // adoptBy where a natural key exists; the per-item claim where none does.
    expect(CRM_CONTACTS.adoptBy?.kind).toBe("email");
    expect(CRM_ACCOUNTS.adoptBy?.kind).toBe("domain");
    expect(CRM_DEALS.adoptBy).toBeUndefined();          // deal names are not unique
    expect(CRM_LINE_ITEMS.adoptBy).toBeUndefined();     // two identical rows are two real line items
  });

  it("only the line item requires a parent at birth", () => {
    expect(CRM_LINE_ITEMS.createParent)
      .toEqual({ toObject: "deals", relationCol: "board_relation_mm76w9y5", associationTypeId: 20 });
    for (const s of [CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS]) expect(s.createParent).toBeUndefined();
  });

  /** The relation the parent is read from must be the same one the association pass writes. */
  it("the parent relation column matches the declared Deal association", () => {
    const dealAssoc = CRM_LINE_ITEMS.associations?.find(a => a.toObject === "deals");
    expect(CRM_LINE_ITEMS.createParent?.relationCol).toBe(dealAssoc?.relationCol);
  });

  it("every create-enabled CRM spec carries a cutoff, so none can slip the guard", () => {
    for (const s of specsFor(crm()) as ObjectSpec[])
      if (s.createFromMonday) expect(typeof s.createCutoffMs).toBe("number");
  });
});
