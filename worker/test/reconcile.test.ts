import { describe, it, expect } from "vitest";
import {
  fieldDiffs, decideDirection, buildReversePatch, buildUpdatePayload, buildCreateProperties,
  reverseFieldValue,
} from "../src/reconcile";
import type { Ctx, MondayItem, ObjectSpec } from "../src/types";

const ctx: Ctx = {
  labels: { dealtype: { existingbusiness: "Existing Business", newbusiness: "New Business" } },
  ownersById: {}, mondayUsersByEmail: {}, portalId: 1,
};

const spec: ObjectSpec = {
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"], nameReverse: "dealname", boardId: "B", idCol: "c_id", syncStateCol: "c_sync",
  groupBy: { prop: "dealstage", map: { appointmentscheduled: "g1", closedwon: "g6" }, reverse: true },
  createFromMonday: true,
  createDefaults: { pipeline: "default", sales_user: "999" },
  fields: [
    { hs: "dealtype", col: "c_type", type: "dropdown", labels: "dealtype", reverse: true },
    { hs: "createdate", col: "c_date", type: "date" }, // forward-only
  ],
};

const item = (over: Partial<MondayItem>): MondayItem => ({
  id: "i1", name: "Acme", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
  group: { id: "g1" },
  column_values: [
    { id: "c_id", text: "9001" }, { id: "c_type", text: "Existing Business" },
    { id: "c_date", text: "2026-06-26" },
  ],
  ...over,
});

const rec = (props: Record<string, string>) => ({
  id: "9001",
  properties: { dealname: "Acme", dealstage: "appointmentscheduled",
    dealtype: "existingbusiness", createdate: "2026-06-26T00:00:00Z", ...props },
});

describe("fieldDiffs", () => {
  it("returns [] when everything matches", () =>
    expect(fieldDiffs(rec({}), item({}), spec, ctx)).toEqual([]));
  it("detects a field diff", () => {
    const d = fieldDiffs(rec({ dealtype: "newbusiness" }), item({}), spec, ctx);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "field", hsText: "New Business", mdText: "Existing Business" });
  });
  it("detects name and group diffs", () => {
    const d = fieldDiffs(rec({ dealname: "Acme2", dealstage: "closedwon" }), item({}), spec, ctx);
    expect(d.map(x => x.kind).sort()).toEqual(["group", "name"]);
  });
  it("skips fields whose HubSpot value is empty (no clear, no loop)", () =>
    expect(fieldDiffs(rec({ dealtype: "" }), item({}), spec, ctx)).toEqual([]));
});

describe("decideDirection (by last-synced timestamp)", () => {
  const diffs = [{ kind: "name" as const, hsText: "A", mdText: "B" }];
  it("none when no diffs", () =>
    expect(decideDirection([], "2026-07-02T00:00:00Z", "2026-07-01T00:00:00Z")).toBe("none"));
  it("HubSpot changed since last sync -> toMonday", () =>
    expect(decideDirection(diffs, "2026-07-02T00:00:00Z", "2026-07-01T00:00:00Z")).toBe("toMonday"));
  it("HubSpot unchanged since last sync (so the edit came from monday) -> toHubspot", () =>
    expect(decideDirection(diffs, "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z")).toBe("toHubspot"));
  it("first encounter (no last-synced value) -> toMonday", () =>
    expect(decideDirection(diffs, "2026-07-01T00:00:00Z", "")).toBe("toMonday"));
});

describe("reverseFieldValue", () => {
  it("inverts the label dictionary", () =>
    expect(reverseFieldValue(spec.fields[0], "New Business", ctx)).toBe("newbusiness"));
  it("empty stays empty", () =>
    expect(reverseFieldValue(spec.fields[0], "  ", ctx)).toBe(""));
});

describe("buildReversePatch", () => {
  it("inverts labels, includes name and group, skips non-reversible fields", () => {
    const md = item({
      name: "Acme Renamed", group: { id: "g6" },
      column_values: [
        { id: "c_id", text: "9001" }, { id: "c_type", text: "New Business" },
        { id: "c_date", text: "2030-01-01" }, // date is forward-only: must NOT appear in patch
      ],
    });
    const diffs = fieldDiffs(rec({}), md, spec, ctx);
    const patch = buildReversePatch(diffs, md, spec, ctx);
    expect(patch).toEqual({ dealname: "Acme Renamed", dealstage: "closedwon", dealtype: "newbusiness" });
  });
  it("returns {} when only non-reversible fields differ", () => {
    const md = item({ column_values: [
      { id: "c_id", text: "9001" }, { id: "c_type", text: "Existing Business" },
      { id: "c_date", text: "2030-01-01" }] });
    const diffs = fieldDiffs(rec({}), md, spec, ctx);
    expect(buildReversePatch(diffs, md, spec, ctx)).toEqual({});
  });
});

describe("buildUpdatePayload", () => {
  it("emits only the diffed fields, formatted for monday", () => {
    const md = item({ column_values: [
      { id: "c_id", text: "9001" }, { id: "c_type", text: "New Business" },
      { id: "c_date", text: "2026-06-26" }] });
    const diffs = fieldDiffs(rec({}), md, spec, ctx); // only dealtype differs
    expect(buildUpdatePayload(diffs, rec({}), spec, ctx)).toEqual({ c_type: { labels: ["Existing Business"] } });
  });
});

describe("buildCreateProperties", () => {
  it("combines defaults, group value, name, and reversible fields", () => {
    const md = item({ name: "New Deal", group: { id: "g6" },
      column_values: [{ id: "c_type", text: "New Business" }] });
    expect(buildCreateProperties(md, spec, ctx)).toEqual({
      pipeline: "default", sales_user: "999", dealstage: "closedwon",
      dealname: "New Deal", dealtype: "newbusiness",
    });
  });
});
