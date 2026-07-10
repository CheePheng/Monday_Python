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

describe("sales_user group moves (routing by HubSpot sales_user; existing item moved by Deal ID, never duplicated)", () => {
  // A deals-style spec: group by stage, no-sales_user -> Unassigned; Sales Users is a (display) people column.
  const dealsRule: ObjectSpec = {
    ...spec,
    groupBy: { prop: "dealstage", map: { appointmentscheduled: "gStage", closedwon: "g6" },
               reverse: true, noSalesUserGroup: "gUnassigned" },
    fields: [{ hs: "sales_user", col: "c_people", type: "people" }],
  };
  const MYLA = "1739141284";
  const pctx: Ctx = { labels: {}, ownersById: { [MYLA]: { name: "Myla", email: "myla@x.com" } },
    mondayUsersByEmail: { "myla@x.com": "42" }, portalId: 1 };
  // card() keeps the SAME HubSpot Deal ID (9001) across group changes -> reconcile moves it, never creates.
  const card = (groupId: string, avatar = "") => item({ group: { id: groupId },
    column_values: [{ id: "c_id", text: "9001" }, { id: "c_people", text: avatar }] });
  const dealRec = (sales_user: string) => ({ id: "9001",
    properties: { dealname: "Acme", dealstage: "appointmentscheduled", sales_user } });
  const groupDiff = (d: ReturnType<typeof fieldDiffs>) => d.find(x => x.kind === "group");

  it("Myla -> empty: a card in a stage group gets a group move to Unassigned", () => {
    const d = fieldDiffs(dealRec(""), card("gStage"), dealsRule, pctx);
    expect(groupDiff(d)?.hsText).toBe("gUnassigned");
  });
  it("empty -> Myla: a card in Unassigned gets a group move to its Deal Stage group", () => {
    const d = fieldDiffs(dealRec(MYLA), card("gUnassigned"), dealsRule, pctx);
    expect(groupDiff(d)?.hsText).toBe("gStage");
  });
  it("blank monday avatar but sales_user = Myla stays in its Deal Stage group (no move to Unassigned)", () => {
    const d = fieldDiffs(dealRec(MYLA), card("gStage", /* blank avatar */ ""), dealsRule, pctx);
    expect(groupDiff(d)).toBeUndefined(); // routing ignores the blank avatar; sales_user is set -> stays put
  });
});

describe("fieldDiffs people population (backfills empty person columns like Sales Users)", () => {
  const peopleSpec: ObjectSpec = { ...spec, nameProps: ["dealname"],
    fields: [{ hs: "sales_user", col: "c_people", type: "people" }] };
  const pctx: Ctx = { labels: {}, ownersById: { "555": { name: "Owner", email: "o@x.com" } },
    mondayUsersByEmail: { "o@x.com": "42" }, portalId: 1 };
  const recOwner = { id: "1", properties: { dealname: "Acme", sales_user: "555" } };
  const emptyPeople = item({ column_values: [{ id: "c_people", text: "" }] });
  const filledPeople = item({ column_values: [{ id: "c_people", text: "Owner" }] });

  const hasPeople = (d: ReturnType<typeof fieldDiffs>) => d.some(x => x.kind === "field" && x.f?.col === "c_people");

  it("diffs an EMPTY people column when the owner resolves to a monday user", () =>
    expect(hasPeople(fieldDiffs(recOwner, emptyPeople, peopleSpec, pctx))).toBe(true));
  it("does NOT diff a people column that already has someone", () =>
    expect(hasPeople(fieldDiffs(recOwner, filledPeople, peopleSpec, pctx))).toBe(false));
  it("does NOT diff when the owner doesn't resolve (no monday user)", () =>
    expect(hasPeople(fieldDiffs({ id: "1", properties: { dealname: "Acme", sales_user: "999" } }, emptyPeople, peopleSpec, pctx))).toBe(false));
});

describe("lead status: Lead Status column reverses to HubSpot; group is forward-only (no oscillation)", () => {
  const contactSpec: ObjectSpec = {
    ...spec,
    // group FOLLOWS HubSpot (reverse:false); the status column is the reversible source of truth.
    groupBy: { prop: "hs_lead_status", map: { NEW: "gNew", OPEN: "gOpen" }, reverse: false, fallbackGroup: "gNew" },
    fields: [{ hs: "hs_lead_status", col: "c_status", type: "status", labels: "leadStatus", reverse: true }],
  };
  const lctx: Ctx = { labels: { leadStatus: { NEW: "New", OPEN: "Open" } }, ownersById: {}, mondayUsersByEmail: {}, portalId: 1 };
  const cItem = (groupId: string, status: string) => item({ group: { id: groupId },
    column_values: [{ id: "c_id", text: "9001" }, { id: "c_status", text: status }] });
  const cRec = (hs_lead_status: string) => ({ id: "9001", properties: { dealname: "Acme", hs_lead_status } });

  it("editing the Lead Status column writes back to HubSpot (New -> Open)", () => {
    const md = cItem("gNew", "Open");                       // column edited to Open, HubSpot still NEW
    const patch = buildReversePatch(fieldDiffs(cRec("NEW"), md, contactSpec, lctx), md, contactSpec, lctx);
    expect(patch).toEqual({ hs_lead_status: "OPEN" });
  });
  it("a lagging group does NOT reverse-write lead status -> it moves forward instead of reverting", () => {
    const md = cItem("gNew", "Open");                       // HubSpot already OPEN, column Open, group lags in gNew
    const diffs = fieldDiffs(cRec("OPEN"), md, contactSpec, lctx);
    expect(diffs.some(d => d.kind === "group")).toBe(true); // the group is behind...
    expect(buildReversePatch(diffs, md, contactSpec, lctx)).toEqual({}); // ...but it does NOT write HubSpot (forward move only)
  });
});
