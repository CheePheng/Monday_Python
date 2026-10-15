import { describe, it, expect } from "vitest";
import { buildDealSeed, fmtNumber, orDash, fmtCompanyDate } from "./companies";

describe("buildDealSeed", () => {
  it("company only -> one company assoc, no contacts", () => {
    expect(buildDealSeed({ company: { hubspotId: "5", name: "Acme" } }))
      .toEqual({ companies: [{ label: "Acme", hubspotId: "5" }] });
  });
  it("company + contact -> both staged", () => {
    expect(buildDealSeed({ company: { hubspotId: "5", name: "Acme" }, contact: { hubspotId: "3", name: "Jo Lee" } }))
      .toEqual({ companies: [{ label: "Acme", hubspotId: "5" }], contacts: [{ label: "Jo Lee", hubspotId: "3" }] });
  });
});

describe("fmtNumber", () => {
  it("formats a numeric string with grouping", () => expect(fmtNumber("1000000")).toBe("1,000,000"));
  it("empty -> em dash", () => expect(fmtNumber("")).toBe("—"));
  it("non-numeric -> raw", () => expect(fmtNumber("N/A")).toBe("N/A"));
});

describe("orDash", () => {
  it("returns value when present", () => expect(orDash("x")).toBe("x"));
  it("blank -> em dash", () => { expect(orDash("")).toBe("—"); expect(orDash("  ")).toBe("—"); });
});

describe("fmtCompanyDate", () => {
  it("formats an ISO date", () => expect(fmtCompanyDate("2026-07-01T00:00:00Z")).toMatch(/2026/));
  it("empty/invalid -> em dash", () => { expect(fmtCompanyDate("")).toBe("—"); expect(fmtCompanyDate("nope")).toBe("—"); });
});
