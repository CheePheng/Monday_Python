import { describe, it, expect } from "vitest";
import { formatValue, expectedText, linkText, linkReverse } from "../src/mapping";
import { fieldDiffs, reverseFieldValue } from "../src/reconcile";
import { CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, FieldSpec, HsRecord, MondayItem } from "../src/types";

/**
 * THE LINK LOOP, observed live on 2026-09-08.
 *
 * A monday link column does not echo back what you wrote. formatValue sends `{ url: v, text: v }`;
 * monday canonicalises the url (a bare domain becomes `https://domain`) and its `text` field then
 * renders as `"<text> - <url>"` because the two now differ. So:
 *
 *   HubSpot  domain = "reversetest-company.example.com"
 *   monday   text   = "reversetest-company.example.com - https://reversetest-company.example.com"
 *
 * `fieldDiffs` compared those raw and they could never be equal. For most column types a permanently
 * dirty diff just rewrites the card. For a link column it LOOPS: the forward write fires monday's own
 * change_column_value webhook, which reconciles, which writes again. 76 iterations were logged from a
 * single company — the first one with a domain ever to sync — with nothing capping it.
 *
 * It went unnoticed because no company had ever reached the board: the Accounts board held one stale
 * card with no HubSpot id, and there were zero post-cutover companies in the portal.
 */

const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {},
  ownerIdByEmail: {}, portalId: "1" } as unknown as Ctx;

const DOMAIN = CRM_ACCOUNTS.fields.find(f => f.hs === "domain")!;
const LINKEDIN = CRM_ACCOUNTS.fields.find(f => f.hs === "linkedin_company_page")!;

/** A monday item whose link cell holds exactly what monday renders back. */
function itemWith(colId: string, text: string): MondayItem {
  return {
    id: "1", name: "Reverse Test Company", group: { id: "topics" },
    column_values: [
      { id: CRM_ACCOUNTS.idCol, text: "344965792487", value: null },
      { id: colId, text, value: null },
    ],
  } as unknown as MondayItem;
}
const rec = (props: Record<string, string>): HsRecord =>
  ({ id: "344965792487", properties: { name: "Reverse Test Company", ...props } }) as unknown as HsRecord;

describe("linkText canonicalises for COMPARISON", () => {
  it("strips the ' - url' suffix monday appends", () =>
    expect(linkText("acme.com - https://acme.com")).toBe("acme.com"));

  it("strips the scheme monday adds, and a trailing slash", () => {
    expect(linkText("https://acme.com")).toBe("acme.com");
    expect(linkText("http://acme.com/")).toBe("acme.com");
    expect(linkText("https://acme.com///")).toBe("acme.com");
  });

  it("folds case, since a host is case-insensitive", () =>
    expect(linkText("HTTPS://Acme.COM")).toBe("acme.com"));

  it("is a no-op on an already-bare domain", () =>
    expect(linkText("acme.com")).toBe("acme.com"));

  it("survives empty and nullish input", () => {
    for (const v of ["", "   ", null, undefined]) expect(linkText(v)).toBe("");
  });

  // The exact live values that produced the 76-iteration loop.
  it("makes the live loop values compare EQUAL", () => {
    const hs = "reversetest-company.example.com";
    const md = "reversetest-company.example.com - https://reversetest-company.example.com";
    expect(hs).not.toBe(md);                       // why it looped
    expect(linkText(hs)).toBe(linkText(md));       // why it no longer does
  });
});

describe("fieldDiffs no longer raises a phantom link diff", () => {
  it("sees NO diff when monday holds monday's own rendering of the HubSpot value", () => {
    const hs = "reversetest-company.example.com";
    const item = itemWith(DOMAIN.col, `${hs} - https://${hs}`);
    const diffs = fieldDiffs(rec({ domain: hs }), item, CRM_ACCOUNTS, ctx);
    expect(diffs.filter(d => d.kind === "field" && d.f?.hs === "domain")).toEqual([]);
  });

  it("STILL raises a diff when the domain genuinely differs", () => {
    const item = itemWith(DOMAIN.col, "old.example.com - https://old.example.com");
    const diffs = fieldDiffs(rec({ domain: "new.example.com" }), item, CRM_ACCOUNTS, ctx);
    expect(diffs.some(d => d.kind === "field" && d.f?.hs === "domain")).toBe(true);
  });

  it("raises a diff when monday is empty and HubSpot has a value", () => {
    const item = itemWith(DOMAIN.col, "");
    const diffs = fieldDiffs(rec({ domain: "acme.com" }), item, CRM_ACCOUNTS, ctx);
    expect(diffs.some(d => d.kind === "field" && d.f?.hs === "domain")).toBe(true);
  });

  // Convergence is the anti-loop property: what formatValue writes must compare equal on the next pass.
  it("what formatValue writes converges against expectedText", () => {
    for (const v of ["acme.com", "https://acme.com", "sub.acme.co.uk", "acme.com/path"]) {
      const written = formatValue(DOMAIN, v, ctx) as { url: string; text: string };
      // monday echoes "<text> - <canonical url>" once they differ; simulate both renderings.
      for (const rendered of [written.text, `${written.text} - https://${written.text.replace(/^https?:\/\//, "")}`])
        expect(linkText(rendered)).toBe(linkText(expectedText(DOMAIN, v, ctx)));
    }
  });
});

describe("linkReverse sends HubSpot a usable URL, not the concatenation", () => {
  // companies.linkedin_company_page is reverse:true, so this value goes INTO a HubSpot URL property.
  it("is a two-way field, which is why this matters", () =>
    expect(LINKEDIN.reverse).toBe(true));

  it("takes the URL half of monday's rendering", () =>
    expect(linkReverse("MyCo - https://linkedin.com/company/myco"))
      .toBe("https://linkedin.com/company/myco"));

  it("passes a bare url through untouched, scheme INTACT", () => {
    expect(linkReverse("https://linkedin.com/company/myco")).toBe("https://linkedin.com/company/myco");
    expect(linkReverse("linkedin.com/company/myco")).toBe("linkedin.com/company/myco");
  });

  // A display label may itself contain " - ", so this cannot be a blind split.
  it("keeps the whole string when the tail is not URL-shaped", () =>
    expect(linkReverse("Acme - the good one")).toBe("Acme - the good one"));

  it("takes the LAST separator when a label also contains one", () =>
    expect(linkReverse("Acme - Europe - https://acme.eu")).toBe("https://acme.eu"));

  it("reverseFieldValue routes link through it", () =>
    expect(reverseFieldValue(LINKEDIN, "MyCo - https://linkedin.com/company/myco", ctx))
      .toBe("https://linkedin.com/company/myco"));

  it("no longer pushes the concatenated display string", () =>
    expect(reverseFieldValue(LINKEDIN, "MyCo - https://linkedin.com/company/myco", ctx))
      .not.toContain(" - "));
});
