/**
 * Replace the six assertions that the 2026-09-08 mapping sheet supersedes.
 *
 * Each of those tests protected a SAFETY property, not merely a state, so none is deleted: each is
 * rewritten to assert the property that still has to hold now the field is mapped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const f = (...p) => join(here, "..", ...p);

function sub(path, old, next) {
  const s = readFileSync(path, "utf8");
  if (!s.includes(old)) throw new Error(`anchor not found in ${path}:\n${old.slice(0, 90)}`);
  writeFileSync(path, s.replace(old, next));
}

const C = f("test", "crm-config.test.ts");

// sales_user: the protected property was "never FABRICATED, never drives scope" — not "never shown".
sub(C,
`  it("never manufactures or maps sales_user", () => {
    expect(CRM_CONTACTS.createDefaults?.sales_user).toBeUndefined();
    expect(CRM_CONTACTS.fields.some(f => f.hs === "sales_user")).toBe(false);
  });`,
`  // sales_user is now DISPLAYED (mapping sheet, 2026-09-08) but the two properties that actually
  // mattered are unchanged: it is never FABRICATED, and it never decides scope.
  it("never manufactures sales_user, and shows it display-only", () => {
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
    expect(CRM_CONTACTS.createDefaults?.sales_user).toBeUndefined();
    const f = CRM_CONTACTS.fields.find(x => x.hs === "sales_user")!;
    expect(f).toMatchObject({ col: "text_mm6sakj3", type: "text", labels: "salesUser" });
    expect(f.reverse).toBeUndefined();      // a monday edit must never reassign it
    expect(f.appReverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });

  it("and sales_user still plays NO part in CRM scope", () => {
    expect(recInScope(CRM_CONTACTS, { properties: {} })).toBe(true);
    expect(recInScope(CRM_CONTACTS, { properties: { sales_user: "" } })).toBe(true);
  });`);

// manufacturer__c: the risk was an unvalidated TWO-WAY write into an 89-option enum.
sub(C,
`  it("does NOT map manufacturer__c yet", () =>
    expect(CRM_CONTACTS.fields.some(f => f.hs === "manufacturer__c")).toBe(false));`,
`  // Now mapped, but FORWARD-ONLY. The hazard was never "showing it" — it was an unvalidated monday
  // edit reaching an 89-option multi-value HubSpot enum. A seeded multi-select dropdown is the
  // prerequisite for two-way; until then \`reverse\` must stay absent.
  it("maps manufacturer__c FORWARD-ONLY — no unvalidated write into an 89-option enum", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "manufacturer__c")!;
    expect(f).toMatchObject({ col: "text_mm6s40ew", type: "text", labels: "contactVendor" });
    expect(f.reverse).toBeUndefined();
    expect(f.appReverse).toBeUndefined();
    expect(f.backfill).toBeUndefined();
  });`);

// priority__c: the protected property was "never into monday's NATIVE Priority column".
sub(C,
`  it("priority__c stays UNMAPPED — HubSpot 优先级 is a follow-up SLA (P1_2小时内 …) while monday's native Priority is High/Medium/Low. Different concepts, zero label overlap", () => {
    expect(CRM_CONTACTS.fields.some(f => f.hs === "priority__c")).toBe(false);
    expect(CRM_CONTACTS.fields.some(f => f.col === "status5")).toBe(false);
  });`,
`  // priority__c now has its OWN column. The property that mattered is unchanged and is the real
  // guard: HubSpot's SLA (P1_2小时内 …) must never be written into monday's NATIVE Priority column,
  // which holds High/Medium/Low — same name, different concept, zero label overlap.
  it("priority__c goes to its OWN status column, never monday's native Priority", () => {
    expect(CRM_CONTACTS.fields.find(x => x.hs === "priority__c"))
      .toMatchObject({ col: "color_mm70ahh7", type: "status", labels: "contactPriority" });
    expect(CRM_CONTACTS.fields.some(f => f.col === "status5")).toBe(false);
  });`);

// notes_last_updated: the concern was the text/datetime mismatch, now resolved by a real date column.
sub(C,
`  it("notes_last_updated stays deferred to the 24-hour reminder feature", () => {
    expect(CRM_CONTACTS.fields.some(f => f.hs === "notes_last_updated")).toBe(false);
    expect(CRM_CONTACTS.fields.some(f => f.col === "text_mm6tmzgq")).toBe(false);
  });`,
`  // Now mapped into a real DATE column created for it. The old TEXT column stays unmapped: a datetime
  // in a text column renders a raw ISO string, which is what deferred this in the first place.
  it("notes_last_updated maps to a DATE column, one-way, not the old text column", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "notes_last_updated")!;
    expect(f).toMatchObject({ col: "date_mm7054jz", type: "date", oneWay: true });
    expect(f.reverse).toBeUndefined();      // HubSpot sets it automatically from real activity
    expect(CRM_CONTACTS.fields.some(x => x.col === "text_mm6tmzgq")).toBe(false);
  });

  // The trigger field for the future 24-hour reminder. HubSpot resets it on reassignment.
  it("hubspot_owner_assigneddate maps to a DATE column, one-way", () => {
    const f = CRM_CONTACTS.fields.find(x => x.hs === "hubspot_owner_assigneddate")!;
    expect(f).toMatchObject({ col: "date_mm70pa4c", type: "date", oneWay: true });
    expect(f.reverse).toBeUndefined();
  });`);

// coexistence matrix: same split — createDefaults still absent, sales_user now shown.
sub(f("test", "crm-coexistence-matrix.test.ts"),
`  it("no createDefaults at all, so no sales_user can be fabricated", () => {
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
    expect(CRM_CONTACTS.fields.some(f => f.hs === "sales_user")).toBe(false);
  });`,
`  it("no createDefaults at all, so no sales_user can be fabricated", () => {
    expect(CRM_CONTACTS.createDefaults).toBeUndefined();
    // sales_user IS displayed since 2026-09-08, but forward-only and never as a scope input.
    const f = CRM_CONTACTS.fields.find(x => x.hs === "sales_user")!;
    expect(f.reverse).toBeUndefined();
    expect(recInScope(CRM_CONTACTS, { properties: {} })).toBe(true);
  });`);

// deploy-config: the CRM dictionary set grew by contactVendor + contactPriority. Still no deal dicts.
sub(f("test", "deploy-config.test.ts"),
`  it("CRM loads exactly the contact + company dictionaries its fields reference", () =>
    expect(labelDictsFor(crmEnv).sort())
      .toEqual(["companyType", "contactSource", "industry", "leadStatus", "partnerWith"]));`,
`  it("CRM loads exactly the contact + company dictionaries its fields reference", () =>
    expect(labelDictsFor(crmEnv).sort())
      .toEqual(["companyType", "contactPriority", "contactSource", "contactVendor",
                "industry", "leadStatus", "partnerWith", "salesUser"]));`);

console.log("six superseded assertions rewritten to preserve their safety properties");
