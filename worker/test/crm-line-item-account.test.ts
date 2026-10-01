import { describe, it, expect } from "vitest";
import { CRM_LINE_ITEMS, CRM_DEALS, CRM_ACCOUNTS } from "../src/config/crm";

/**
 * The spec-level guarantees for the derived Account link on Products & Services. These are the
 * assertions that would have caught the two ways this feature can be wrong without failing loudly:
 * an entry that reads nothing forever, and an entry that tries to write back an association HubSpot
 * does not define.
 */

const accountAssoc = () => CRM_LINE_ITEMS.associations?.find(a => a.toObject === "companies");

describe("Products & Services links to its Account without anyone choosing one", () => {
  it("declares a companies association at all", () => {
    expect(accountAssoc()).toBeDefined();
  });

  it("resolves it THROUGH deals — a direct line_item->company association does not exist in HubSpot", () => {
    expect(accountAssoc()?.via).toBe("deals");
  });

  it("writes the relation column that already exists on the board, not a new one", () => {
    expect(accountAssoc()?.relationCol).toBe("board_relation_mm7cz3v8");
  });

  it("points at the board the Accounts spec owns, so cards resolve through its idCol", () => {
    expect(CRM_ACCOUNTS.boardId).toBe("5028000496");
    expect(CRM_ACCOUNTS.idCol).toBe("text_mm6tsnwx");
  });

  it("breaks a multi-company tie with HubSpot's own Primary flag", () => {
    expect(accountAssoc()?.viaPrimary).toBe(true);
  });

  /** lookup_mm7cte64 "Company name" already mirrors through the relation. A text copy would be a second
   *  source of truth for the same fact — exactly what removing Contacts' `company` was about. */
  it("carries NO text name column, because the board already mirrors the name", () => {
    expect(accountAssoc()?.col).toBeUndefined();
  });

  it("keeps the existing Deal association untouched", () => {
    const deal = CRM_LINE_ITEMS.associations?.find(a => a.toObject === "deals");
    expect(deal?.relationCol).toBe("board_relation_mm76w9y5");
    expect(deal?.via).toBeUndefined();
  });
});

describe("the derived link cannot leak into a HubSpot write", () => {
  it("is the ONLY association on any CRM spec that is derived", () => {
    const derived = [CRM_LINE_ITEMS, CRM_DEALS, CRM_ACCOUNTS]
      .flatMap(s => (s.associations ?? []).map(a => ({ spec: s.object, to: a.toObject, via: a.via })))
      .filter(a => a.via);
    expect(derived).toEqual([{ spec: "line_items", to: "companies", via: "deals" }]);
  });

  /** `via` is what reverseAssociations checks to skip the entry (whole-cell pass) or dispatch it to
   *  fillDealCompany (a person's column-level edit). If a derived association ever lost it while keeping
   *  relationCol, the generic reverse would try line_items->companies -- which hubspot.ts now refuses
   *  outright, but the spec must not depend on that. */
  it("every derived association still names a relation column, so the reverse skip is reachable", () => {
    for (const a of CRM_LINE_ITEMS.associations ?? [])
      if (a.via) expect(a.relationCol).toBeTruthy();
  });
});
