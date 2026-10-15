import { describe, it, expect } from "vitest";
import { normalizeDomain } from "../src/normalize";

describe("normalizeDomain", () => {
  it("lowercases and strips scheme, www, path and trailing slash", () => {
    expect(normalizeDomain("HTTPS://WWW.Acme.com/contact")).toBe("acme.com");
    expect(normalizeDomain("http://acme.com/")).toBe("acme.com");
    expect(normalizeDomain("www.Acme.Com")).toBe("acme.com");
    expect(normalizeDomain("acme.com")).toBe("acme.com");
  });
  it("trims surrounding whitespace and a trailing dot", () => {
    expect(normalizeDomain("  Acme.com.  ")).toBe("acme.com");
  });
  it("keeps subdomains other than www", () => {
    expect(normalizeDomain("https://mail.acme.co.uk/x")).toBe("mail.acme.co.uk");
  });
  it("returns empty string for blank/undefined input", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("   ")).toBe("");
    expect(normalizeDomain(undefined as unknown as string)).toBe("");
  });
});
