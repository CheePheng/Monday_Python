import { describe, it, expect } from "vitest";
import { propertiesForSpec } from "../src/hubspot";
import { DEALS, CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";
import type { ObjectSpec } from "../src/types";

// The write guard reads sync_owner and createdate off the FETCHED record. If propertiesFor omits
// them they arrive undefined, every record classifies as unstamped, and CRM records would be handed
// to the wrong Worker. This is load-bearing, not cosmetic.
describe("propertiesForSpec + ownership metadata", () => {
  const owned: ObjectSpec = {
    ...DEALS, object: "contacts",
    fields: [{ hs: "firstname", col: "c_first", type: "text" }],   // deliberately no createdate field
    ownership: { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: 0 },
  };

  it("adds both ownership properties even when no mapped field supplies them", () => {
    const p = propertiesForSpec(owned);
    expect(p).toContain("sync_owner");
    expect(p).toContain("createdate");
  });

  it("does not duplicate a property a field already maps", () => {
    const spec: ObjectSpec = {
      ...owned,
      fields: [{ hs: "createdate", col: "c_date", type: "date", oneWay: true }],
    };
    expect(propertiesForSpec(spec).filter(x => x === "createdate")).toHaveLength(1);
  });

  it("honours a non-default ownership property name", () => {
    const spec: ObjectSpec = {
      ...owned,
      ownership: { prop: "custom_owner_field", createdProp: "hs_createdate", owner: "crm", cutoverAtMs: 0 },
    };
    const p = propertiesForSpec(spec);
    expect(p).toContain("custom_owner_field");
    expect(p).toContain("hs_createdate");
  });

  it("PRODUCTION specs are unchanged — no ownership means no extra properties", () => {
    for (const spec of [DEALS, CONTACTS_MYLA, COMPANIES_MYLA]) {
      const p = propertiesForSpec(spec);
      expect(p).not.toContain("sync_owner");
      // and every property still comes from the spec itself
      const expected = new Set<string>([...spec.nameProps, spec.modifiedProp,
        ...spec.fields.map(f => f.hs), ...("prop" in spec.groupBy ? [spec.groupBy.prop] : [])]);
      expect(new Set(p)).toEqual(expected);
    }
  });
});
