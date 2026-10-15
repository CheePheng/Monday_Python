import { describe, it, expect } from "vitest";
import {
  CONTACT_WRITE_PROPS, COMPANY_WRITE_PROPS, CONTACT_ENUM_PROPS, COMPANY_ENUM_PROPS,
  pickWritableContactProps, pickWritableCompanyProps,
} from "../src/contact-company-props";

describe("pickWritableContactProps", () => {
  it("keeps allowlisted contact props and drops unknown / server-set ones", () => {
    expect(pickWritableContactProps({
      firstname: "Ada", lastname: "Lovelace", email: "ada@acme.com", jobtitle: "CTO",
      sales_user: "999", hubspot_owner_id: "999", createdate: "x", bogus: "y",
    })).toEqual({ firstname: "Ada", lastname: "Lovelace", email: "ada@acme.com", jobtitle: "CTO" });
  });
  it("coerces values to strings and drops null/empty", () => {
    expect(pickWritableContactProps({ firstname: "Ada", email: "", jobtitle: null as unknown as string }))
      .toEqual({ firstname: "Ada" });
  });
});

describe("pickWritableCompanyProps", () => {
  it("keeps allowlisted company props and drops unknown / server-set ones", () => {
    expect(pickWritableCompanyProps({
      name: "Acme", domain: "acme.com", industry: "TECH", sales_user: "9", hubspot_owner_id: "9", bogus: "z",
    })).toEqual({ name: "Acme", domain: "acme.com", industry: "TECH" });
  });
});

describe("enum + write prop sets", () => {
  it("never exposes owner/sales_user in the write allowlists", () => {
    for (const s of [CONTACT_WRITE_PROPS, COMPANY_WRITE_PROPS]) {
      expect(s.has("sales_user")).toBe(false);
      expect(s.has("hubspot_owner_id")).toBe(false);
    }
  });
  it("enum props are a subset of the write props", () => {
    for (const e of CONTACT_ENUM_PROPS) expect(CONTACT_WRITE_PROPS.has(e)).toBe(true);
    for (const e of COMPANY_ENUM_PROPS) expect(COMPANY_WRITE_PROPS.has(e)).toBe(true);
  });
});
