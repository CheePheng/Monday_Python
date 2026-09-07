import { describe, it, expect } from "vitest";
import { reverseFieldValue } from "../src/reconcile";
import { expectedText, formatValue } from "../src/mapping";
import type { Ctx, FieldSpec } from "../src/types";

/**
 * EVIDENCE TEST — monday labels are NOT HubSpot internal enum values.
 *
 * Task 5 seeded the three new status/dropdown columns with HubSpot's human-facing LABELS, which is
 * right for the board UX but means a reverse write must translate label -> internal value. For several
 * options those differ badly ("Google Workspace" -> "GOOGLE", "Docusign" -> "3 Docusign"), so writing
 * the monday label would 400 against the HubSpot enumeration.
 *
 * The machinery: hubspot.ts:630 getPropertyOptions builds { internal value -> label } straight from
 * GET /crm/v3/properties/{object}/{prop}; buildCtx (sync.ts:37) already fetches exactly these three;
 * reconcile.ts inverts that dict for reverse writes. These assertions prove the round trip on the real
 * option data verified against the live portal on 2026-09-07, including every non-identity case.
 */

// value -> label, exactly the shape getPropertyOptions returns.
const LEAD_STATUS = {
  NEW: "New", OPEN: "Open", IN_PROGRESS: "In Progress", OPEN_DEAL: "Open Deal",
  UNQUALIFIED: "Unqualified", ATTEMPTED_TO_CONTACT: "Attempted to Contact",
  CONNECTED: "Connected", BAD_TIMING: "Bad Timing",
};

const COMPANY_TYPE = {
  PROSPECT: "Prospect", PARTNER: "Partner", RESELLER: "Reseller", VENDOR: "Vendor", OTHER: "Other",
  "1 Key Account": "1 Key Account", "2 Enterprise": "2 Enterprise", "3 Commercial": "3 Commercial",
  "4 Public Sector公共单位": "4 Public Sector公共单位", "5 ISV独立软件提供商": "5 ISV独立软件提供商",
  Integrator: "Integrator", 已购买客户: "已购买客户", 正在谈opp的客户: "正在谈opp的客户",
  prospectboughtfromothers: "prospectboughtfromothers", Customer: "Customer",
  "无拓展机会 - 联系人都离职了，找不到新联系人": "无拓展机会 - 联系人都离职了，找不到新联系人",
};

const PARTNER_WITH = {
  Tableau: "Tableau", "3 Docusign": "Docusign", HubSpot: "HubSpot", Intercom: "Intercom",
  Shopify: "Shopify", Miro: "Miro", SAP: "SAP -Theobald Software", Sumsub: "Sumsub",
  Fivetran: "Fivetran", Minitab: "Minitab", AWS: "AWS", GOOGLE: "Google Workspace",
  SALESFORCE: "SALESFORCE", "9 Power BI": "Power BI", IBM: "IBM", Snowflake: "Snowflake",
  Databricks: "Databricks", Klyviyo: "Klyviyo", Datadog: "Datadog", Dataiku: "Dataiku",
  Others: "Others", Zendesk: "Zendesk", Zoom: "Zoom", Trustpilot: "Trustpilot", Monday: "Monday",
  Nextcloud: "Nextcloud", Microsoft: "Microsoft",
};

const ctx = {
  labels: { leadStatus: LEAD_STATUS, companyType: COMPANY_TYPE, partnerWith: PARTNER_WITH },
  ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {}, portalId: 1,
} as unknown as Ctx;

const leadStatus: FieldSpec = { hs: "hs_lead_status", col: "color_mm6zb4tc", type: "status", labels: "leadStatus", reverse: true };
const companyType: FieldSpec = { hs: "type", col: "color_mm6zwhwt", type: "status", labels: "companyType", reverse: true };
const partnerWith: FieldSpec = { hs: "partner_with", col: "dropdown_mm6zd1ge", type: "dropdown", labels: "partnerWith" };

describe("hs_lead_status — label <-> internal value", () => {
  it("every option round-trips label -> internal value", () => {
    for (const [value, label] of Object.entries(LEAD_STATUS))
      expect(reverseFieldValue(leadStatus, label, ctx)).toBe(value);
  });

  // These are the ones that would silently corrupt if label were assumed == value.
  it.each([["New", "NEW"], ["In Progress", "IN_PROGRESS"], ["Attempted to Contact", "ATTEMPTED_TO_CONTACT"]])(
    "monday label %j reverses to %j, NOT the label", (label, value) => {
      expect(reverseFieldValue(leadStatus, label, ctx)).toBe(value);
      expect(reverseFieldValue(leadStatus, label, ctx)).not.toBe(label);
    });

  it("forward direction shows the label on the board, not the raw value", () => {
    expect(formatValue(leadStatus, "IN_PROGRESS", ctx)).toEqual({ label: "In Progress" });
    expect(expectedText(leadStatus, "IN_PROGRESS", ctx)).toBe("In Progress");
  });
});

describe("company type — label <-> internal value", () => {
  it("every option round-trips", () => {
    for (const [value, label] of Object.entries(COMPANY_TYPE))
      expect(reverseFieldValue(companyType, label, ctx)).toBe(value);
  });

  it("the uppercase ones are the trap", () => {
    expect(reverseFieldValue(companyType, "Prospect", ctx)).toBe("PROSPECT");
    expect(reverseFieldValue(companyType, "Vendor", ctx)).toBe("VENDOR");
  });

  // A label containing a comma survives, because status reverses whole-label.
  it("a label containing a comma and Chinese text round-trips intact", () => {
    const label = "无拓展机会 - 联系人都离职了，找不到新联系人";
    expect(reverseFieldValue(companyType, label, ctx)).toBe(label);
  });
});

describe("partner_with — label <-> internal value (the worst offenders)", () => {
  it("every option round-trips", () => {
    for (const [value, label] of Object.entries(PARTNER_WITH))
      expect(reverseFieldValue(partnerWith, label, ctx)).toBe(value);
  });

  // Exactly the case the review flagged: the board says "Google Workspace", HubSpot stores "GOOGLE".
  it.each([
    ["Google Workspace", "GOOGLE"],
    ["Docusign", "3 Docusign"],
    ["Power BI", "9 Power BI"],
    ["SAP -Theobald Software", "SAP"],
  ])("monday label %j must PATCH %j", (label, value) => {
    expect(reverseFieldValue(partnerWith, label, ctx)).toBe(value);
    expect(reverseFieldValue(partnerWith, label, ctx)).not.toBe(label);
  });

  it("forward direction renders the friendly label", () =>
    expect(formatValue(partnerWith, "GOOGLE", ctx)).toEqual({ labels: ["Google Workspace"] }));
});

// WHY partner_with IS A DROPDOWN AND NOT A STATUS. Beyond monday's 27-label status limit, the two
// reverse branches differ in safety: dropdown validates against the dict, status/text does not.
describe("unknown monday labels: dropdown refuses, status falls through raw", () => {
  it("dropdown DROPS an unknown label rather than sending it to HubSpot", () => {
    expect(reverseFieldValue(partnerWith, "Some Typo Vendor", ctx)).toBe("");
  });

  it("dropdown keeps the known part of a multi-value list and stops at the unknown one", () => {
    expect(reverseFieldValue(partnerWith, "Tableau, Miro", ctx)).toBe("Tableau;Miro");
    expect(reverseFieldValue(partnerWith, "Tableau, Nonsense", ctx)).toBe("Tableau");
  });

  // Documented, not endorsed: this is the asymmetry that makes an unvalidated status/text column
  // unsafe for an enum, and is why manufacturer__c (89 options) stays DEFER until it is a dropdown.
  it("status sends an unknown label RAW — the reason a text/status enum column is unsafe", () => {
    expect(reverseFieldValue(companyType, "Not A Real Type", ctx)).toBe("Not A Real Type");
  });

  it("a plain text column has no validation at all", () => {
    const asText: FieldSpec = { hs: "manufacturer__c", col: "text_mm6s40ew", type: "text", reverse: true };
    expect(reverseFieldValue(asText, "38Intercomm typo", ctx)).toBe("38Intercomm typo");
  });
});
