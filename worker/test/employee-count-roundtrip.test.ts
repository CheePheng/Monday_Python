import { describe, it, expect } from "vitest";
import { formatValue, expectedText } from "../src/mapping";
import { fieldDiffs, reverseFieldValue } from "../src/reconcile";
import type { Ctx, FieldSpec, MondayItem, ObjectSpec } from "../src/types";

/**
 * EVIDENCE TEST — can HubSpot `numberofemployees` (a HubSpot property of type `number`) round-trip
 * through monday's NATIVE `employee_count` column, which is a monday `text` column?
 *
 * Asked because the CRM Accounts board already carries a native "No. of employees" (`employee_count`,
 * text) AND an empty hand-added "Number Of Employees" stub. Business guidance is to keep native columns
 * and delete duplicates, so the question is whether the native text column is technically sufficient
 * rather than whether a second numeric column is nicer.
 *
 * These assertions exercise the REAL mapper (formatValue / expectedText / fieldDiffs / reverseFieldValue),
 * not a description of it.
 */

const ctx: Ctx = {
  labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {},
  portalId: 1,
};

// The two candidate mappings, differing ONLY in the declared monday column type.
const asText: FieldSpec = { hs: "numberofemployees", col: "employee_count", type: "text" };
const asNumbers: FieldSpec = { hs: "numberofemployees", col: "numeric_new", type: "numbers" };
const asTextReverse: FieldSpec = { ...asText, reverse: true };

describe("forward write HubSpot -> monday", () => {
  // The decisive fact: for a plain scalar both branches emit the SAME bare string, so a text column
  // needs no different payload from a numbers column.
  it("emits an identical payload for a text column and a numbers column", () => {
    expect(formatValue(asText, "500", ctx)).toBe("500");
    expect(formatValue(asNumbers, "500", ctx)).toBe("500");
  });

  it("passes large values through unchanged", () => {
    expect(formatValue(asText, "1500000", ctx)).toBe("1500000");
  });

  it("writes nothing for an empty HubSpot value (never clears the column)", () => {
    expect(formatValue(asText, "", ctx)).toBeNull();
    expect(formatValue(asText, null, ctx)).toBeNull();
  });
});

describe("diff stability — the phantom-diff / sync-loop risk", () => {
  const spec = (f: FieldSpec): ObjectSpec => ({
    object: "companies", objectTypeId: "0-2", searchFilters: [], modifiedProp: "hs_lastmodifieddate",
    nameProps: ["domain"], boardId: "B", idCol: "c_id", syncStateCol: "c_sync",
    groupBy: { singleGroup: "g1" }, createFromMonday: false, fields: [f],
  });
  const item = (colId: string, text: string): MondayItem => ({
    id: "i1", name: "acme.com", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    group: { id: "g1" },
    column_values: [{ id: "c_id", text: "9001" }, { id: colId, text }],
  });
  const rec = (v: string) => ({ id: "9001", properties: { domain: "acme.com", numberofemployees: v } });

  it("no diff once the text column holds what HubSpot holds — no loop", () => {
    const diffs = fieldDiffs(rec("500"), item("employee_count", "500"), spec(asText), ctx);
    expect(diffs.filter(d => d.kind === "field")).toHaveLength(0);
  });

  it("raises exactly one diff when HubSpot changes", () => {
    const diffs = fieldDiffs(rec("750"), item("employee_count", "500"), spec(asText), ctx);
    expect(diffs.filter(d => d.kind === "field")).toHaveLength(1);
  });

  // THE ONE PLACE THE TYPES DIVERGE. `numbers` normalizes through Number(); `text` compares raw. So a
  // column already holding a differently-FORMATTED equivalent number diffs forever under `text`.
  it("DIVERGES on formatting: text re-diffs '500' vs HubSpot '500.0', numbers does not", () => {
    const asTextDiffs = fieldDiffs(rec("500.0"), item("employee_count", "500"), spec(asText), ctx);
    expect(asTextDiffs.filter(d => d.kind === "field")).toHaveLength(1);   // phantom diff

    const asNumbersDiffs = fieldDiffs(rec("500.0"), item("numeric_new", "500"), spec(asNumbers), ctx);
    expect(asNumbersDiffs.filter(d => d.kind === "field")).toHaveLength(0);  // normalized away
  });

  // ...but it is self-limiting: the forward write stores HubSpot's own string verbatim, so after one
  // pass the column matches byte-for-byte and the diff stops. It only persists if something OTHER than
  // this sync wrote a differently-formatted value.
  it("self-heals: after the forward write stores HubSpot's own string, the diff is gone", () => {
    const written = String(formatValue(asText, "500.0", ctx));
    const diffs = fieldDiffs(rec("500.0"), item("employee_count", written), spec(asText), ctx);
    expect(diffs.filter(d => d.kind === "field")).toHaveLength(0);
  });
});

describe("reverse write monday -> HubSpot", () => {
  it("a clean numeric string reverses to a value HubSpot's number property accepts", () => {
    expect(reverseFieldValue(asTextReverse, "500", ctx)).toBe("500");
  });

  // THE DISQUALIFYING CASES. A monday TEXT column accepts arbitrary text, and nothing in the reverse
  // path validates it — reverseFieldValue's default branch returns the raw string. HubSpot
  // `numberofemployees` is type `number`, so each of these is a 400 on every reconcile tick.
  it.each(["approx 500", "500-1000", "50+", "1,500", "unknown", "N/A"])(
    "passes free text %j straight through to a HubSpot NUMBER property (would 400)", (typed) => {
      expect(reverseFieldValue(asTextReverse, typed, ctx)).toBe(typed);
      expect(Number.isFinite(Number(typed))).toBe(false);   // not a number HubSpot can store
    });

  it("a numbers column cannot carry those values in the first place — monday validates entry", () => {
    // Same mapper, but monday's numbers column UI only admits numerics, so the reverse value is
    // always parseable. The protection is the COLUMN TYPE, not the mapper.
    expect(reverseFieldValue({ ...asNumbers, reverse: true }, "500", ctx)).toBe("500");
  });
});
