import { describe, it, expect } from "vitest";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_SPECS, CRM_CUTOVER_AT_MS, CRM_CREATE_CUTOFF_MS } from "../src/config/crm";
import { ALL_SPECS, CONTACTS_MYLA, COMPANIES_MYLA, DEALS } from "../src/config";
import { propertiesForSpec } from "../src/hubspot";
import { recInScope } from "../src/sync";
import { mayCreateCrmCard } from "../src/ownership";

// Every id asserted here was captured from the live boards after Task 5 and is authoritative. The
// pre-Task-5 stubs were DELETED (monday cannot retype a column), so referencing one is a real bug.
const DEAD_STUBS = [
  "text_mm6t8x04", "text_mm6sdc3b", "text_mm6tqwyw", "text_mm6t4jp", "text_mm6tghg4",
  "text_mm6t6w6n", "text_mm6t8r57", "text_mm6t7rpd", "text_mm6t1n5g",
  "numeric_mm6swz9c", "12849070_last_name", "text_mm6t40d7", "text_mm6s7db3",
  "text_mm6t68sz", "text_mm6tyx9z", "text_mm6thg86", "text_mm6t638", "text_mm6tvb8q", "text_mm6t5nqt",
];

const colsOf = (s: typeof CRM_CONTACTS) =>
  [s.idCol, s.syncStateCol, s.linkCol ?? "", ...s.fields.map(f => f.col)].filter(Boolean);

describe("no deleted stub id survives anywhere in the CRM specs", () => {
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s references only live columns", (_o, spec) => {
    for (const c of colsOf(spec)) expect(DEAD_STUBS).not.toContain(c);
  });
});

describe("CRM_CONTACTS", () => {
  it("targets the right board, columns and group", () => {
    expect(CRM_CONTACTS.boardId).toBe("5028000495");
    expect(CRM_CONTACTS.idCol).toBe("text_mm6t71dj");
    expect(CRM_CONTACTS.syncStateCol).toBe("text_mm6twy4w");
    expect(CRM_CONTACTS.linkCol).toBe("link_mm6z7mj");
    expect(CRM_CONTACTS.groupBy).toEqual({ singleGroup: "topics" });
  });

  it("uses `lastmodifieddate`, not the deal/company property", () =>
    expect(CRM_CONTACTS.modifiedProp).toBe("lastmodifieddate"));

  // THE 2026-09-07 MEETING DECISION.
  it("creation is HubSpot-only: no createFromMonday, no adoptBy, no createDefaults", () => {
    expect(CRM_CONTACTS.createFromMonday).toBe(false);
    expect(CRM_CONTACTS.adoptBy).toBeUndefined();
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
  });

  it("never manufactures or maps sales_user", () => {
    expect(CRM_CONTACTS.createDefaults?.sales_user).toBeUndefined();
    expect(CRM_CONTACTS.fields.some(f => f.hs === "sales_user")).toBe(false);
  });

  it("declares crm ownership with the inert Phase-1 cutover", () => {
    expect(CRM_CONTACTS.ownership).toEqual({
      prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: Number.POSITIVE_INFINITY,
    });
    expect(CRM_CUTOVER_AT_MS).toBe(Number.POSITIVE_INFINITY);
    expect(CRM_CREATE_CUTOFF_MS).toBe(Number.POSITIVE_INFINITY);
  });

  it("email is the native email column and is FORWARD-ONLY (it is the dedup key)", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "email")!;
    expect(f).toMatchObject({ col: "contact_email", type: "email" });
    expect(f.reverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });

  it("phone uses the native phone column", () =>
    expect(CRM_CONTACTS.fields.find(f => f.hs === "phone")).toMatchObject({ col: "contact_phone", type: "phone" }));

  it("owner is appReverse, never a plain reverse (the 2026-08-28 reassignment incident)", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "hubspot_owner_id")!;
    expect(f).toMatchObject({ col: "multiple_person_mm6zap53", type: "people", appReverse: true });
    expect(f.reverse).toBeUndefined();
  });

  it("hs_lead_status is two-way on the seeded status column", () =>
    expect(CRM_CONTACTS.fields.find(f => f.hs === "hs_lead_status"))
      .toMatchObject({ col: "color_mm6zb4tc", type: "status", labels: "leadStatus", reverse: true }));

  it("leadsource is forward-only (~200 legacy options)", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "leadsource")!;
    expect(f).toMatchObject({ col: "text_mm6sc26t", type: "text" });
    expect(f.reverse).toBeUndefined();
  });

  it("createdate is one-way and never reversible", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "createdate")!;
    expect(f).toMatchObject({ col: "date_mm6z33nk", type: "date", oneWay: true });
    expect(f.reverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });

  it("a renamed card cannot rewrite the HubSpot name", () => {
    expect(CRM_CONTACTS.nameProps).toEqual(["firstname", "lastname"]);
    expect(CRM_CONTACTS.nameReverse).toBeUndefined();
  });

  // Vendors stays DEFER: manufacturer__c is a MULTI-VALUE enum (a live record holds
  // "49HubSpot;55Aircall") with 89 options, and an unvalidated text/status reverse would send a typo
  // straight into the enumeration. It may only go two-way as a seeded multi-select dropdown.
  it("does NOT map manufacturer__c yet", () =>
    expect(CRM_CONTACTS.fields.some(f => f.hs === "manufacturer__c")).toBe(false));

  // Approved 2026-09-07 from the mapping sheet. HubSpot `event_name` is verified free text and the
  // monday column was already `text`, so no retype was needed.
  it("event_name is mapped FORWARD-ONLY onto the existing Event Name column", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "event_name")!;
    expect(f).toMatchObject({ col: "text_mm6t8bxb", type: "text" });
    expect(f.reverse).toBeUndefined();
    expect(f.appReverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });

  // DECISIONS HELD FROM THE 2026-09-07 REQUIREMENTS REVIEW. Each of these must stay unmapped; the
  // mapping sheet lists some of them and they must not be wired up on name similarity alone.
  it("priority__c stays UNMAPPED — HubSpot 优先级 is a follow-up SLA (P1_2小时内 …) while monday's native Priority is High/Medium/Low. Different concepts, zero label overlap", () => {
    expect(CRM_CONTACTS.fields.some(f => f.hs === "priority__c")).toBe(false);
    expect(CRM_CONTACTS.fields.some(f => f.col === "status5")).toBe(false);
  });

  it("notes_last_updated stays deferred to the 24-hour reminder feature", () => {
    expect(CRM_CONTACTS.fields.some(f => f.hs === "notes_last_updated")).toBe(false);
    expect(CRM_CONTACTS.fields.some(f => f.col === "text_mm6tmzgq")).toBe(false);
  });

  it("num_notes / activity COUNTS stay unmapped — a number cannot represent an activity timeline", () => {
    for (const hs of ["num_notes", "num_contacted_notes", "num_associated_deals",
                      "hs_last_sales_activity_timestamp"])
      expect(CRM_CONTACTS.fields.some(f => f.hs === hs)).toBe(false);
  });

  it("monday's native Activities timeline and Comments stay native and unmapped", () => {
    for (const col of ["custom_mkrm9y8c", "long_text4", "mirror2", "title5"])
      expect(CRM_CONTACTS.fields.some(f => f.col === col)).toBe(false);
  });

  it("associates ONLY to companies, via the native relation, and maps no deal column", () => {
    expect(CRM_CONTACTS.associations).toEqual([
      { toObject: "companies", nameProps: ["name"], relationCol: "contact_account" },
    ]);
    for (const f of CRM_CONTACTS.fields) expect(f.col).not.toMatch(/deal/i);
  });
});

describe("CRM_ACCOUNTS", () => {
  it("targets the right board, columns and group", () => {
    expect(CRM_ACCOUNTS.boardId).toBe("5028000496");
    expect(CRM_ACCOUNTS.idCol).toBe("text_mm6tsnwx");
    expect(CRM_ACCOUNTS.syncStateCol).toBe("text_mm6tccd0");
    expect(CRM_ACCOUNTS.linkCol).toBe("link_mm6zyad8");
    expect(CRM_ACCOUNTS.groupBy).toEqual({ singleGroup: "topics" });
    expect(CRM_ACCOUNTS.modifiedProp).toBe("hs_lastmodifieddate");
  });

  it("adopts by DOMAIN on the native link column, never by company name", () => {
    expect(CRM_ACCOUNTS.adoptBy).toEqual({ kind: "domain", col: "company_domain" });
    expect(CRM_ACCOUNTS.adoptBy!.col).not.toBe("text_mm6t1q4h");
    expect(CRM_ACCOUNTS.createFromMonday).toBe(true);
  });

  // THE INDUSTRY REGRESSION GUARD.
  it("industry goes to the renamed custom stub, and the NATIVE dropdown stays unmapped", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "industry")!;
    expect(f).toMatchObject({ col: "text_mm6tafj5", type: "text", labels: "industry" });
    expect(f.reverse).toBeUndefined();
    expect(CRM_ACCOUNTS.fields.some(x => x.col === "industry")).toBe(false);
  });

  it("partner_with is a DROPDOWN (status cannot hold its 27 labels) and forward-only", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "partner_with")!;
    expect(f).toMatchObject({ col: "dropdown_mm6zd1ge", type: "dropdown", labels: "partnerWith" });
    expect(f.reverse).toBeUndefined();
  });

  it("type is two-way on the seeded status column", () =>
    expect(CRM_ACCOUNTS.fields.find(f => f.hs === "type"))
      .toMatchObject({ col: "color_mm6zwhwt", type: "status", labels: "companyType", reverse: true }));

  // THE EMPLOYEE-COUNT DECISION.
  it("numberofemployees reuses the NATIVE column, ONE-WAY, with no second employee column", () => {
    const f = CRM_ACCOUNTS.fields.find(x => x.hs === "numberofemployees")!;
    expect(f).toMatchObject({ col: "employee_count", type: "text" });
    expect(f.reverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
    expect(CRM_ACCOUNTS.fields.filter(x => /employee/i.test(x.hs))).toHaveLength(1);
  });

  it("owner is appReverse", () =>
    expect(CRM_ACCOUNTS.fields.find(f => f.hs === "hubspot_owner_id"))
      .toMatchObject({ col: "multiple_person_mm6z8mwy", type: "people", appReverse: true }));

  it("maps no sales_user, and associates ONLY to contacts", () => {
    expect(CRM_ACCOUNTS.fields.some(f => f.hs === "sales_user")).toBe(false);
    expect(CRM_ACCOUNTS.associations).toEqual([
      { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "account_contact" },
    ]);
  });
});

describe("scope: includeAll is paired with the Task 3B gate, and searchFilters are inert", () => {
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s sets includeAll + skipFullReconcile", (_o, spec) => {
    expect(spec.includeAll).toBe(true);
    expect(spec.skipFullReconcile).toBe(true);
    expect(spec.searchFilters).toEqual([]);        // dead by construction, asserted so it stays that way
  });

  // The 771-record case: in scope with no sales_user and no createdate at all.
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s: a record with NO sales_user is in scope", (_o, spec) => {
    expect(recInScope(spec, { properties: {} })).toBe(true);
    expect(recInScope(spec, { properties: { sales_user: "", createdate: "2019-01-01T00:00:00Z" } })).toBe(true);
  });

  // ...and being in scope must NOT mean a historical record gets a card.
  it.each(CRM_SPECS.map(s => [s.object, s] as const))("%s: in-scope history still cannot be carded", (_o, spec) => {
    expect(mayCreateCrmCard({ id: "1", properties: { createdate: "2024-03-01T00:00:00Z" } }, spec.ownership)).toBe(false);
    expect(mayCreateCrmCard({ id: "1", properties: {} }, spec.ownership)).toBe(false);
  });

  it("ownership metadata is always fetched, so the gate can never read undefined", () => {
    for (const spec of CRM_SPECS) {
      const p = propertiesForSpec(spec);
      expect(p).toContain("sync_owner");
      expect(p).toContain("createdate");
    }
  });
});

describe("PRODUCTION WM specs are untouched", () => {
  it("no WM spec declares ownership or adoptBy", () => {
    for (const s of ALL_SPECS) {
      expect(s.ownership).toBeUndefined();
      expect(s.adoptBy).toBeUndefined();
    }
  });

  it("WM contacts/companies still gate on sales_user — the 771 must NOT reach the WM boards", () => {
    expect(recInScope(CONTACTS_MYLA, { properties: {} })).toBe(false);
    expect(recInScope(CONTACTS_MYLA, { properties: { createdate: "2026-09-01T00:00:00Z" } })).toBe(false);
    expect(recInScope(DEALS, { properties: {} })).toBe(false);
  });

  it("no WM spec uses the new `email` column type, so the mapper change is inert for production", () => {
    for (const s of ALL_SPECS) expect(s.fields.some(f => f.type === "email")).toBe(false);
  });

  it("CRM specs and WM specs share no board and no HubSpot-id column", () => {
    const wmBoards = new Set(ALL_SPECS.map(s => s.boardId));
    for (const s of CRM_SPECS) expect(wmBoards.has(s.boardId)).toBe(false);
    expect(CRM_CONTACTS.boardId).not.toBe(CONTACTS_MYLA.boardId);
    expect(CRM_ACCOUNTS.boardId).not.toBe(COMPANIES_MYLA.boardId);
  });

  it("CRM_SPECS covers exactly companies + contacts, all crm-owned, none with associations", () => {
    expect(CRM_SPECS.map(s => s.object).sort()).toEqual(["companies", "contacts"]);
    for (const s of CRM_SPECS) {
      expect(s.ownership?.owner).toBe("crm");
      expect(s.associations).toHaveLength(1);          // Contact<->Company only; reverse is code-blocked
    }
  });
});
