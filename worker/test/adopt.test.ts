import { describe, it, expect } from "vitest";
import { adoptionKey } from "../src/adopt";
import { authorizeWrite, canClaimCrmOwnership, withBirthOwnership } from "../src/ownership";
import { DEALS, CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";
import { CRM_ACCOUNTS, CRM_CONTACTS } from "../src/config/crm";
import type { MondayItem, ObjectSpec, OwnershipSpec } from "../src/types";

const item = (cols: { id: string; text: string | null; value?: string | null }[], name = "Display Co"): MondayItem =>
  ({ id: "i1", name, created_at: "", updated_at: "", group: { id: "g" }, column_values: cols as never });

const emailSpec: ObjectSpec = { ...DEALS, object: "contacts", adoptBy: { kind: "email", col: "c_email" } };
const domainSpec: ObjectSpec = { ...DEALS, object: "companies", adoptBy: { kind: "domain", col: "c_domain" } };

describe("adoptionKey — email", () => {
  it("lowercases and trims", () =>
    expect(adoptionKey(item([{ id: "c_email", text: "  JO@X.COM " }]), emailSpec)).toBe("jo@x.com"));

  it.each(["", "   ", "not-an-email", "@x.com", "jo@", "@", "jo x@y.com"])(
    "unusable input %j yields no key", (t) =>
      expect(adoptionKey(item([{ id: "c_email", text: t }]), emailSpec)).toBe(""));

  it("a missing column yields no key", () =>
    expect(adoptionKey(item([{ id: "other", text: "jo@x.com" }]), emailSpec)).toBe(""));
});

describe("adoptionKey — domain", () => {
  it("normalizes a bare domain", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "Acme.COM" }]), domainSpec)).toBe("acme.com"));

  it("reads a LINK column's url from value JSON when text is empty", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "",
      value: JSON.stringify({ url: "https://acme.com/about", text: "" }) }]), domainSpec)).toBe("acme.com"));

  it("prefers the url over display text (text is often a human label)", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "Acme Corporate Site",
      value: JSON.stringify({ url: "https://acme.com" }) }]), domainSpec)).toBe("acme.com"));

  // THE INVARIANT: never match records by name.
  it("NEVER falls back to the item name", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "" }], "Acme Sdn Bhd"), domainSpec)).toBe(""));

  // THE TRUST BOUNDARY. normalizeDomain only canonicalises; a rep can type anything into this column,
  // and without a shape check "ABC Trading Sdn Bhd" would normalise to "abc trading sdn bhd", match no
  // HubSpot company, and then be used to CREATE one with a garbage domain.
  it.each([
    "ABC Trading Sdn Bhd", "acme", "acme.", ".com", "-acme.com", "acme-.com",
    "acme .com", "a b c", "http://", "acme.c", "TBC", "n/a", "?",
  ])("rejects %j — not a hostname, so no create and no adoption", (t) =>
    expect(adoptionKey(item([{ id: "c_domain", text: t }]), domainSpec)).toBe(""));

  it.each([
    ["acme.com", "acme.com"],
    ["sub.acme.co.uk", "sub.acme.co.uk"],
    ["sz-gkts.com", "sz-gkts.com"],
    ["https://WWW.Acme.com/about?x=1", "acme.com"],
    ["acme.com.", "acme.com"],
  ])("accepts %j -> %j", (input, want) =>
    expect(adoptionKey(item([{ id: "c_domain", text: input }]), domainSpec)).toBe(want));

  it("malformed value JSON degrades to text, never throws", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "acme.com", value: "{oops" }]), domainSpec)).toBe("acme.com"));

  it("value JSON with no url degrades to text", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "acme.com",
      value: JSON.stringify({ text: "Acme" }) }]), domainSpec)).toBe("acme.com"));
});

// ADOPTION MUST NOT TRANSFER OWNERSHIP. A rep recreating an old company on the CRM board links the
// existing HubSpot record (so no duplicate) but must NOT take ownership of history.
describe("adopting a historical record does not claim it", () => {
  const crmOwn: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm",
    cutoverAtMs: Date.parse("2026-10-01T00:00:00Z") };
  const historical = { id: "old1", properties: { createdate: "2024-03-01T00:00:00Z" } };

  it("is NOT claimable — recreating a record must not migrate ownership", () =>
    expect(canClaimCrmOwnership(historical, crmOwn)).toBe(false));

  it("is NOT writable by CRM — reverse writes stay blocked", () =>
    expect(authorizeWrite(historical, crmOwn).allowed).toBe(false));

  it("stays writable by WM, which still owns it", () =>
    expect(authorizeWrite(historical, { ...crmOwn, owner: "wm" }).allowed).toBe(true));

  it("a wm-STAMPED record adopted by domain is still refused to CRM", () => {
    const wmOwned = { id: "c1", properties: { sync_owner: "wm", createdate: "2026-11-01T00:00:00Z" } };
    expect(canClaimCrmOwnership(wmOwned, crmOwn)).toBe(false);
    expect(authorizeWrite(wmOwned, crmOwn).allowed).toBe(false);
  });

  it("a CRM-owned company allows the approved reverse updates", () => {
    const crmOwned = { id: "c2", properties: { sync_owner: "crm", createdate: "2026-11-01T00:00:00Z" } };
    expect(authorizeWrite(crmOwned, crmOwn).allowed).toBe(true);
  });
});

// BIRTH OWNERSHIP is the other half: a genuinely NEW record has nothing to claim, so the stamp rides in
// the create payload. Without it the record would be born unstamped and stranded behind our own guard.
describe("birth ownership on a monday-originated create", () => {
  const crmOwn: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: 0 };

  it("stamps the create payload alongside the business fields", () =>
    expect(withBirthOwnership({ name: "Acme", domain: "acme.com" }, crmOwn))
      .toEqual({ name: "Acme", domain: "acme.com", sync_owner: "crm" }));

  it("leaves a spec without ownership untouched — the WM create path is unchanged", () =>
    expect(withBirthOwnership({ name: "Acme" }, undefined)).toEqual({ name: "Acme" }));

  it("a newly born CRM record is immediately writable by CRM", () => {
    const born = { id: "new1", properties: withBirthOwnership({}, crmOwn) };
    expect(authorizeWrite(born, crmOwn).allowed).toBe(true);
  });
});

describe("production WM specs are untouched by this mechanism", () => {
  it("neither WM spec declares adoptBy, so both keep their existing adoption branch", () => {
    expect(CONTACTS_MYLA.adoptBy).toBeUndefined();
    expect(COMPANIES_MYLA.adoptBy).toBeUndefined();
    expect(DEALS.adoptBy).toBeUndefined();
  });

  it("a spec without adoptBy yields no key, so it can never enter the new branch", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "acme.com" }]), DEALS)).toBe(""));
});

describe("the CRM specs use the mechanism as approved", () => {
  it("Accounts adopts by DOMAIN on the native link column", () => {
    expect(CRM_ACCOUNTS.adoptBy).toEqual({ kind: "domain", col: "company_domain" });
    expect(CRM_ACCOUNTS.createFromMonday).toBe(true);
  });

  it("Contacts declares NO adoptBy — creation is HubSpot-only, so there is nothing to adopt for", () => {
    expect(CRM_CONTACTS.adoptBy).toBeUndefined();
    expect(CRM_CONTACTS.createFromMonday).toBe(false);
  });

  it("an Accounts card whose Domain column is empty produces no key -> no HubSpot company", () =>
    expect(adoptionKey(item([{ id: "company_domain", text: "" }], "Acme Sdn Bhd"), CRM_ACCOUNTS)).toBe(""));

  it("an Accounts card with a real Domain link adopts on the normalized domain", () =>
    expect(adoptionKey(item([{ id: "company_domain", text: "acme.com",
      value: JSON.stringify({ url: "https://www.acme.com/" }) }]), CRM_ACCOUNTS)).toBe("acme.com"));
});

/**
 * THE 2026-09-09 ADOPTION FAILURE — six live Accounts cards (example.com, ukmarketreport.com,
 * qk.ilongyu.com.cn, hubspot.com, vml.com, zkqcip.com) each showed a FILLED Company domain, a filled
 * Contacts relation, a BLANK HubSpot ID, a BLANK HubSpot Link, and a Sync State reading
 * "not synced — needs domain".
 *
 * The cause was a test fixture, not a hard diagnosis. Every existing domain case above passes a `value`
 * JSON — and `ITEM_FIELDS` in monday.ts selects `column_values { id text ... }` WITHOUT `value`, so
 * production never has it. The suite was therefore exercising a branch the deployed code cannot reach,
 * while the branch it does reach — the `text` fallback — received monday's link RENDERING
 * ("example.com - https://example.com"), which is not a hostname, so adoptionKey returned "" and every
 * card was stamped "needs domain" regardless of what a rep typed.
 *
 * These cases deliberately pass NO `value`, which is the only shape production ever sees.
 */
describe("adoptionKey on the shape production actually receives (no value JSON)", () => {
  const domainOnly = (text: string) => adoptionKey(item([{ id: "company_domain", text }]), CRM_ACCOUNTS);

  // monday renders a link column's text as "<label> - <url>". All six live cards looked like this.
  it.each([
    ["example.com - https://example.com", "example.com"],
    ["ukmarketreport.com - https://ukmarketreport.com", "ukmarketreport.com"],
    ["qk.ilongyu.com.cn - http://qk.ilongyu.com.cn", "qk.ilongyu.com.cn"],
    ["vml.com - https://www.vml.com/", "vml.com"],
  ])("adopts from monday's link rendering %s", (text, want) => expect(domainOnly(text)).toBe(want));

  it("still adopts a bare domain, the shape a plain text column gives", () =>
    expect(domainOnly("zkqcip.com")).toBe("zkqcip.com"));

  // A LABELLED link: the url half is the domain and the label half is not. Taking the wrong half would
  // adopt on a company NAME, which is the one thing this key must never do.
  it("takes the url half of a labelled link, never the label", () =>
    expect(domainOnly("Acme Corporate Site - https://acme.com")).toBe("acme.com"));

  // The refusals must SURVIVE the fix — this is the half that could have regressed. A company name that
  // happens to contain " - " must not have its tail treated as a domain.
  it.each(["ABC Trading Sdn Bhd", "ABC Trading - Sdn Bhd", "", "   ", "no-tld", "gmail.com",
    "Some Co - not a url"])(
    "still refuses %s", (text) => expect(domainOnly(text)).toBe(""));

  it("still refuses a public provider presented as a link render", () =>
    expect(domainOnly("gmail.com - https://gmail.com")).toBe(""));

  // The `value` branch is kept for the day ITEM_FIELDS selects it; it must keep winning when present.
  it("prefers value.url when it IS present, so adding value to ITEM_FIELDS changes nothing", () =>
    expect(adoptionKey(item([{ id: "company_domain", text: "Acme Corporate Site - https://wrong.example",
      value: JSON.stringify({ url: "https://www.acme.com/" }) }]), CRM_ACCOUNTS)).toBe("acme.com"));
});
