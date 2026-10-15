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

  // `prop` is now constrained to the literal "sync_owner" so a spec author cannot aim the claim
  // payload at a business field — so only createdProp varies, and it must still be fetched.
  it("honours a non-default create-date property", () => {
    const spec: ObjectSpec = {
      ...owned,
      ownership: { prop: "sync_owner", createdProp: "hs_createdate", owner: "crm", cutoverAtMs: 0 },
    };
    const p = propertiesForSpec(spec);
    expect(p).toContain("sync_owner");
    expect(p).toContain("hs_createdate");
    expect(p).not.toContain("createdate");   // only the DECLARED createdProp is fetched
  });

  it("WM specs now fetch the ownership metadata, and nothing else new", () => {
    for (const spec of [DEALS, CONTACTS_MYLA, COMPANIES_MYLA]) {
      const p = propertiesForSpec(spec);
      expect(p).toContain("sync_owner");     // REQUIRED since WM authorizes too (2026-09-22)
      // and every property still comes from the spec itself
      const expected = new Set<string>([...spec.nameProps, spec.modifiedProp,
        ...spec.fields.map(f => f.hs), ...("prop" in spec.groupBy ? [spec.groupBy.prop] : []),
        // the two ownership properties, which are infrastructure rather than mapped fields
        spec.ownership!.prop, spec.ownership!.createdProp]);
      expect(new Set(p)).toEqual(expected);
    }
  });
});
