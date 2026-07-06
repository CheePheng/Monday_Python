import { describe, it, expect } from "vitest";
import { targetGroup, reverseGroup } from "../src/routing";
import { indexByHubspotId } from "../src/dedup";
import type { MondayItem, ObjectSpec } from "../src/types";

const grouped: ObjectSpec = {
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "m",
  nameProps: ["dealname"], boardId: "B", idCol: "c_id", syncStateCol: "c_sync",
  groupBy: { prop: "dealstage", map: { appointmentscheduled: "g1", closedwon: "g6" }, reverse: true },
  createFromMonday: true, fields: [],
};
const single: ObjectSpec = { ...grouped, groupBy: { singleGroup: "gS" } };
const withFallback: ObjectSpec = {
  ...grouped,
  groupBy: { prop: "hs_lead_status", map: { NEW: "gNew", OPEN: "gOpen" }, reverse: true, fallbackGroup: "gNew" },
};

describe("targetGroup", () => {
  it("maps the group-by property value", () =>
    expect(targetGroup({ id: "1", properties: { dealstage: "closedwon" } }, grouped)).toBe("g6"));
  it("returns null for unmapped values", () =>
    expect(targetGroup({ id: "1", properties: { dealstage: "weird" } }, grouped)).toBeNull());
  it("single-group boards always route to that group", () =>
    expect(targetGroup({ id: "1", properties: {} }, single)).toBe("gS"));
  it("empty group-by value falls back instead of skipping (contact with no lead status)", () =>
    expect(targetGroup({ id: "1", properties: { hs_lead_status: "" } }, withFallback)).toBe("gNew"));
  it("unmapped group-by value also falls back", () =>
    expect(targetGroup({ id: "1", properties: { hs_lead_status: "SOMETHING_ELSE" } }, withFallback)).toBe("gNew"));
  it("a mapped value still wins over the fallback", () =>
    expect(targetGroup({ id: "1", properties: { hs_lead_status: "OPEN" } }, withFallback)).toBe("gOpen"));
});

describe("reverseGroup", () => {
  it("maps a monday group id back to the HubSpot value", () =>
    expect(reverseGroup(grouped, "g6")).toBe("closedwon"));
  it("returns null for unknown groups or single-group specs", () => {
    expect(reverseGroup(grouped, "gX")).toBeNull();
    expect(reverseGroup(single, "gS")).toBeNull();
  });
});

const item = (id: string, hsId: string): MondayItem => ({
  id, name: "x", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
  group: { id: "g1" }, column_values: [{ id: "c_id", text: hsId }],
});

describe("indexByHubspotId", () => {
  it("finds items by the id column, ignores blanks", () => {
    const idx = indexByHubspotId([item("i1", "9001"), item("i2", "")], "c_id");
    expect(idx["9001"].id).toBe("i1");
    expect(idx["9002"]).toBeUndefined();
  });
});
