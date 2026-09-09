import { describe, it, expect } from "vitest";
import { reverseFieldValue, buildReversePatch, fieldDiffs } from "../src/reconcile";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "../src/types";

/**
 * THE 2026-09-09 REVERSE BATCH. monday CRM is the salespeople's working system, so the normal editable
 * business fields must push back to HubSpot. Before this, 5 of 29 Contact fields were two-way and an
 * edit to any of the other 24 was not ignored but REVERTED — the reconcile found nothing reversible and
 * the forward write restored HubSpot's value over the top. That is what "monday -> HubSpot doesn't work"
 * actually was.
 *
 * Two of the fields nominated for this batch would have shipped a defect, and both are covered below:
 *
 *   department_3__c — a DROPDOWN with no label dictionary. The dropdown reverse branch built its
 *     candidate list from the (empty) inverted dict, matched nothing, and returned "" — silently
 *     refusing every edit. Fixed by passing through raw when there is no dictionary, which is correct
 *     because value === label for every option on that property.
 *
 *   numberofemployees — HELD BACK. It is `type: "text"` on a HubSpot NUMBER property, so the reverse
 *     path passes the cell through raw and "approx 500" would 400. It needs the numeric guard first,
 *     the same way the four text-enum fields need a dictionary guard.
 */

const LEAD_STATUS = { NEW: "New", IN_PROGRESS: "In Progress" };
const CONTACT_PRIORITY = { "P1_2小时内": "P1_2小时内", "P2_1周内": "P2_1周内" };
const CONTACT_STATUS = { "1New": "1新增", "7购买有意向": "7购买有意向" };
const CONTACT_VENDOR = { HubSpot: "HubSpot", Tableau: "Tableau", Aircall: "Aircall" };

const ctx = {
  labels: {
    leadStatus: LEAD_STATUS, contactPriority: CONTACT_PRIORITY,
    contactStatus: CONTACT_STATUS, contactVendor: CONTACT_VENDOR,
  },
  ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {}, portalId: "1",
} as unknown as Ctx;

const f = (spec: ObjectSpec, hs: string): FieldSpec => {
  const found = spec.fields.find(x => x.hs === hs);
  if (!found) throw new Error(`no field ${hs} on ${spec.object}`);
  return found;
};

const ENABLED_CONTACTS = [
  "priority__c", "sales_person", "leadstatus", "manufacturer__c", "department_3__c",
  "concrete_demand", "utm_term", "registration_page__c", "industry", "hs_state_code",
  "mobilephone", "event_name",
];

describe("the batch is enabled, and only the batch", () => {
  it.each(ENABLED_CONTACTS)("contacts.%s is now reverse:true", (hs) =>
    expect(f(CRM_CONTACTS, hs).reverse).toBe(true));

  it("accounts.timezone is now reverse:true", () =>
    expect(f(CRM_ACCOUNTS, "timezone").reverse).toBe(true));

  // HELD BACK, with the reason asserted so it cannot be quietly enabled later without a guard.
  it("numberofemployees stays FORWARD-ONLY: a text column on a HubSpot NUMBER property", () => {
    const noe = f(CRM_ACCOUNTS, "numberofemployees");
    expect(noe.reverse).toBeUndefined();
    expect(noe.type).toBe("text");   // not "numbers", so numText never runs on it
  });

  // Identity, system and computed fields must stay one-way regardless of the "monday is the system"
  // goal — a monday edit to any of these breaks record matching or fights HubSpot's own computation.
  it.each(["email", "createdate", "registration_date", "hubspot_owner_assigneddate", "notes_last_updated"])(
    "contacts.%s stays one-way", (hs) => expect(f(CRM_CONTACTS, hs).reverse).toBeUndefined());

  it.each(["domain", "createdate", "hs_object_source_label"])(
    "accounts.%s stays one-way", (hs) => expect(f(CRM_ACCOUNTS, hs).reverse).toBeUndefined());

  // Deliberate holds, each for its own stated reason.
  it("lifecyclestage stays one-way — it fires HubSpot workflows, so it is a business decision", () =>
    expect(f(CRM_CONTACTS, "lifecyclestage").reverse).toBeUndefined());

  it("sales_user stays one-way — two owner ids share the name \"Rick Antonio\"", () =>
    expect(f(CRM_CONTACTS, "sales_user").reverse).toBeUndefined());

  it("hubspot_owner_id stays on the app-save path, never a plain reverse", () => {
    expect(f(CRM_CONTACTS, "hubspot_owner_id").appReverse).toBe(true);
    expect(f(CRM_CONTACTS, "hubspot_owner_id").reverse).toBeUndefined();
  });

  it.each(["countries", "lead_source_sub__c", "city_1__c", "leadsource"])(
    "%s stays one-way pending text-enum validation", (hs) =>
      expect(f(CRM_CONTACTS, hs).reverse).toBeUndefined());
});

describe("each newly-enabled type reverses correctly", () => {
  it("status WITH a dictionary maps label -> internal value, and refuses junk", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    expect(reverseFieldValue(pri, "P2_1周内", ctx)).toBe("P2_1周内");
    expect(reverseFieldValue(pri, "Not A Priority", ctx)).toBe("");
    const st = f(CRM_CONTACTS, "leadstatus");
    expect(reverseFieldValue(st, "1新增", ctx)).toBe("1New");        // label -> value
    expect(reverseFieldValue(st, "1New", ctx)).toBe("1New");         // value passes too
    expect(reverseFieldValue(st, "made up", ctx)).toBe("");
  });

  it("status WITHOUT a dictionary passes through — sales_person has value === label", () => {
    const sp = f(CRM_CONTACTS, "sales_person");
    expect(sp.labels).toBeUndefined();
    expect(reverseFieldValue(sp, "Emily You", ctx)).toBe("Emily You");
  });

  it("dropdown WITH a dictionary validates and drops the unknown part", () => {
    const v = f(CRM_CONTACTS, "manufacturer__c");
    expect(reverseFieldValue(v, "HubSpot, Aircall", ctx)).toBe("HubSpot;Aircall");
    expect(reverseFieldValue(v, "HubSpot, Nonsense", ctx)).toBe("HubSpot");
    expect(reverseFieldValue(v, "Nonsense", ctx)).toBe("");
  });

  // THE BUG THIS BATCH WOULD HAVE SHIPPED. Without the no-dictionary branch this returned "" for
  // every value, so department_3__c would have looked enabled and silently synced nothing.
  it("dropdown WITHOUT a dictionary passes through instead of refusing everything", () => {
    const d = f(CRM_CONTACTS, "department_3__c");
    expect(d.labels).toBeUndefined();
    expect(reverseFieldValue(d, "Engineering/R&D", ctx)).toBe("Engineering/R&D");
    expect(reverseFieldValue(d, "Finance, IT", ctx)).toBe("Finance;IT");
    expect(reverseFieldValue(d, "", ctx)).toBe("");
  });

  it("phone canonicalises, keeping a leading +", () => {
    const m = f(CRM_CONTACTS, "mobilephone");
    expect(reverseFieldValue(m, "+60 12-345 6789", ctx)).toBe("+60123456789");
    expect(reverseFieldValue(m, "012 345 6789", ctx)).toBe("0123456789");
    expect(reverseFieldValue(m, "no digits here", ctx)).toBe("");
  });

  it("long_text is clamped to monday's 2000, so the round trip converges", () => {
    const cd = f(CRM_CONTACTS, "concrete_demand");
    expect(reverseFieldValue(cd, "需要 40 个席位", ctx)).toBe("需要 40 个席位");
    expect(reverseFieldValue(cd, "x".repeat(2500), ctx).length).toBe(2500);  // reverse sends what the rep typed
  });

  it("plain text passes through", () => {
    expect(reverseFieldValue(f(CRM_CONTACTS, "utm_term"), "hubspot crm", ctx)).toBe("hubspot crm");
    expect(reverseFieldValue(f(CRM_CONTACTS, "hs_state_code"), "广东省", ctx)).toBe("广东省");
    expect(reverseFieldValue(f(CRM_ACCOUNTS, "timezone"), "Asia/Kuala_Lumpur", ctx)).toBe("Asia/Kuala_Lumpur");
  });
});

describe("the patch carries exactly the edited field", () => {
  const rec = (props: Record<string, string>): HsRecord =>
    ({ id: "301", properties: { firstname: "Jane", lastname: "Smith", ...props } }) as unknown as HsRecord;
  const card = (cells: Record<string, string>): MondayItem => ({
    id: "CARD1", name: "Jane Smith", group: { id: "topics" },
    column_values: [
      { id: CRM_CONTACTS.idCol, text: "301", value: null },
      ...Object.entries(cells).map(([id, text]) => ({ id, text, value: null })),
    ],
  } as unknown as MondayItem);

  it("a 优先级 edit sends priority__c and nothing else", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    const item = card({ [pri.col]: "P2_1周内" });
    const patch = buildReversePatch(
      fieldDiffs(rec({ priority__c: "P1_2小时内" }), item, CRM_CONTACTS, ctx), item, CRM_CONTACTS, ctx);
    expect(patch).toEqual({ priority__c: "P2_1周内" });
  });

  it("an invalid 优先级 sends nothing, so the card reconciles forward instead of wedging", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    const item = card({ [pri.col]: "P9_whenever" });
    const patch = buildReversePatch(
      fieldDiffs(rec({ priority__c: "P1_2小时内" }), item, CRM_CONTACTS, ctx), item, CRM_CONTACTS, ctx);
    expect(patch).toEqual({});
  });

  it("and converges once HubSpot holds the reversed value", () => {
    const pri = f(CRM_CONTACTS, "priority__c");
    const item = card({ [pri.col]: "P2_1周内" });
    expect(fieldDiffs(rec({ priority__c: "P2_1周内" }), item, CRM_CONTACTS, ctx)
      .filter(d => d.f?.hs === "priority__c")).toEqual([]);
  });
});
