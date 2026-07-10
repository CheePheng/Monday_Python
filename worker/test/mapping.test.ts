import { describe, it, expect } from "vitest";
import { formatValue, buildColumnValues, itemName, expectedText } from "../src/mapping";
import type { Ctx, FieldSpec, ObjectSpec } from "../src/types";

const ctx: Ctx = {
  labels: {
    stage: { appointmentscheduled: "Appointment Scheduled" },
    dealtype: { existingbusiness: "Existing Business", newbusiness: "New Business" },
    pipeline: { default: "Sales Pipeline" },
  },
  ownersById: { "555": { name: "Myla Mestiola", email: "myla@x.com" } },
  mondayUsersByEmail: { "myla@x.com": "1001" },
  portalId: 39939588,
};

const f = (over: Partial<FieldSpec>): FieldSpec => ({ hs: "p", col: "c", type: "text", ...over });

describe("formatValue", () => {
  it("status uses the label dictionary", () =>
    expect(formatValue(f({ type: "status", labels: "stage" }), "appointmentscheduled", ctx))
      .toEqual({ label: "Appointment Scheduled" }));
  it("dropdown splits multi values and maps each", () =>
    expect(formatValue(f({ type: "dropdown", labels: "dealtype" }), "existingbusiness;newbusiness", ctx))
      .toEqual({ labels: ["Existing Business", "New Business"] }));
  it("date truncates to YYYY-MM-DD", () =>
    expect(formatValue(f({ type: "date" }), "2026-06-26T02:22:45Z", ctx)).toEqual({ date: "2026-06-26" }));
  it("people resolves owner -> monday user", () =>
    expect(formatValue(f({ type: "people" }), "555", ctx))
      .toEqual({ personsAndTeams: [{ id: 1001, kind: "person" }] }));
  it("numbers becomes a string", () =>
    expect(formatValue(f({ type: "numbers" }), "5000", ctx)).toBe("5000"));
  it("null/empty is skipped", () => {
    expect(formatValue(f({}), null, ctx)).toBeNull();
    expect(formatValue(f({}), "", ctx)).toBeNull();
  });
});

const spec: ObjectSpec = {
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"], boardId: "B", idCol: "c_id", syncStateCol: "c_sync", linkCol: "c_link",
  groupBy: { singleGroup: "g" }, createFromMonday: false,
  fields: [{ hs: "dealtype", col: "c_type", type: "dropdown", labels: "dealtype" }],
};

describe("buildColumnValues / itemName", () => {
  it("includes id, mapped fields, and deep link", () => {
    const cv = buildColumnValues({ id: "9001", properties: { dealtype: "existingbusiness" } }, spec, ctx);
    expect(cv.c_id).toBe("9001");
    expect(cv.c_type).toEqual({ labels: ["Existing Business"] });
    expect(cv.c_link).toEqual({
      url: "https://app.hubspot.com/contacts/39939588/record/0-3/9001", text: "Open in HubSpot" });
  });
  it("itemName joins nameProps and falls back", () => {
    expect(itemName({ id: "1", properties: { dealname: "Acme" } }, spec)).toBe("Acme");
    expect(itemName({ id: "1", properties: {} }, spec)).toBe("deals 1");
  });

  it("stamps the all-members team on the Shared column when the deal has NO sales_user", () => {
    const shared: ObjectSpec = { ...spec, unassignedShared: { col: "c_shared", teamId: "999" } };
    expect(buildColumnValues({ id: "1", properties: {} }, shared, ctx).c_shared)
      .toEqual({ personsAndTeams: [{ id: 999, kind: "team" }] });
    // has a sales_user -> Shared is left empty (only the salesperson can view it)
    expect(buildColumnValues({ id: "1", properties: { sales_user: "555" } }, shared, ctx).c_shared)
      .toBeUndefined();
    // disabled when teamId is "" (team not created yet)
    const off: ObjectSpec = { ...spec, unassignedShared: { col: "c_shared", teamId: "" } };
    expect(buildColumnValues({ id: "1", properties: {} }, off, ctx).c_shared).toBeUndefined();
  });
});

describe("expectedText (canonical comparison value)", () => {
  it("maps enum values to labels for status/dropdown", () => {
    expect(expectedText(f({ type: "status", labels: "stage" }), "appointmentscheduled", ctx))
      .toBe("Appointment Scheduled");
    expect(expectedText(f({ type: "date" }), "2026-06-26T02:22:45Z", ctx)).toBe("2026-06-26");
    expect(expectedText(f({ type: "people" }), "555", ctx)).toBeNull(); // not diffable
  });
  it("trims text and number-normalizes so it round-trips against monday", () => {
    expect(expectedText(f({ type: "text" }), "Austin ", ctx)).toBe("Austin");
    expect(expectedText(f({ type: "numbers" }), "1500000.50", ctx)).toBe("1500000.5");
  });
});
