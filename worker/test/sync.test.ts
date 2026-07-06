import { describe, it, expect, beforeEach, vi } from "vitest";
import { COMPANIES_MYLA, CONTACTS_MYLA, DEALS_MYLA, SALES_USER_MYLA } from "../src/config";

// ---------------------------------------------------------------------------
// In-memory fakes for the monday + HubSpot API layers so we can drive the REAL
// orchestration (sync.ts) and REAL pure logic (reconcile/mapping/routing) with
// no network. The store renders written column values to text the same way
// monday would echo them, so round-trip diffs behave like production.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const items = new Map<string, any>();
  const deals = new Map<string, any>();
  const counts: Record<string, number> = {};
  const ids = { item: 1000, deal: 5000 };

  const colText = (item: any, colId: string): string =>
    (item.column_values.find((c: any) => c.id === colId)?.text ?? "").trim();

  // Mirror mapping.formatValue's shapes back to the display text monday echoes.
  const valueToText = (v: any): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v.labels)) return v.labels.join(", "); // dropdown
    if (v.label !== undefined) return String(v.label);        // status
    if (v.date !== undefined) return String(v.date);          // date
    if (v.personsAndTeams || v.phone !== undefined) return ""; // people/phone: not diffable
    if (v.url !== undefined) return String(v.text ?? "");     // link column
    return "";
  };

  const applyCv = (item: any, cv: Record<string, any>) => {
    for (const [k, val] of Object.entries(cv)) {
      if (k === "name") continue; // handled via item.name
      const text = valueToText(val);
      const existing = item.column_values.find((c: any) => c.id === k);
      if (existing) existing.text = text;
      else item.column_values.push({ id: k, text });
    }
  };

  const mkItem = (id: string, boardId: string, groupId: string, name: string, cv: Record<string, any>) => {
    const item = {
      id, name, boardId, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
      group: { id: groupId }, column_values: [] as any[],
    };
    applyCv(item, cv);
    return item;
  };

  const reset = () => {
    items.clear(); deals.clear(); ids.item = 1000; ids.deal = 5000;
    for (const k of ["createItem", "updateItem", "setColumns", "moveItem", "deleteItem", "createRecord", "patchRecord"])
      counts[k] = 0;
  };

  return { items, deals, counts, ids, colText, valueToText, applyCv, mkItem, reset };
});

vi.mock("../src/monday", () => ({
  getItem: async (_e: any, id: string) => H.items.get(id) ?? null,
  getBoardItems: async (_e: any, boardId: string) => [...H.items.values()].filter(i => i.boardId === boardId),
  findItemByColumn: async (_e: any, boardId: string, colId: string, value: string) =>
    [...H.items.values()].filter(i => i.boardId === boardId && H.colText(i, colId) === String(value)),
  getUsersByEmail: async () => ({}),
  createItem: async (_e: any, boardId: string, groupId: string, name: string, cv: any) => {
    H.counts.createItem++;
    const id = String(H.ids.item++);
    H.items.set(id, H.mkItem(id, boardId, groupId, name, cv));
  },
  updateItem: async (_e: any, _b: string, itemId: string, name: string, cv: any) => {
    H.counts.updateItem++;
    const it = H.items.get(itemId); it.name = name; H.applyCv(it, cv);
  },
  setColumns: async (_e: any, _b: string, itemId: string, cv: any) => {
    H.counts.setColumns++; H.applyCv(H.items.get(itemId), cv);
  },
  moveItem: async (_e: any, _b: string, itemId: string, groupId: string) => {
    H.counts.moveItem++; H.items.get(itemId).group = { id: groupId };
  },
  deleteItem: async (_e: any, itemId: string) => { H.counts.deleteItem++; H.items.delete(itemId); },
}));

vi.mock("../src/hubspot", () => ({
  getOwners: async () => ({ [SALES_USER_MYLA]: { name: "Myla Mestiola", email: "myla@example.com" } }),
  getDealStageLabels: async () => ({
    appointmentscheduled: "Appointment Scheduled", qualifiedtobuy: "Qualified To Buy", closedwon: "Closed Won",
  }),
  getPropertyOptions: async () => ({}),
  propertiesForSpec: () => [],
  searchAll: async () => [],
  searchModifiedIds: async () => [],
  searchContactByEmail: async () => null,
  getRecord: async (_e: any, _obj: string, id: string) => H.deals.get(id) ?? null,
  createRecord: async (_e: any, spec: any, props: any) => {
    H.counts.createRecord++;
    const id = String(H.ids.deal++);
    const modified = new Date().toISOString();
    H.deals.set(id, { id, properties: { ...props, [spec.modifiedProp]: modified } });
    return { id, modified };
  },
  patchRecord: async (_e: any, spec: any, id: string, props: any) => {
    H.counts.patchRecord++;
    const d = H.deals.get(id);
    Object.assign(d.properties, props);
    const modified = new Date(Date.now() + 1000).toISOString();
    d.properties[spec.modifiedProp] = modified;
    return modified;
  },
}));

// Import AFTER the mocks are registered.
import { syncHubspotDeal, syncHubspotObject, syncMondayItem } from "../src/sync";
import { extractDealIds } from "../src/webhooks";

const BOARD = DEALS_MYLA.boardId;      // 5029480547
const ID_COL = DEALS_MYLA.idCol;       // numeric_mm4nz332
const SYNC_COL = DEALS_MYLA.syncStateCol;
const GROUP = "group_mm4nf6fw";        // appointmentscheduled group on Myla's Deals board
const RECENT = "2026-08-01T00:00:00.000Z";
const env: any = { DRY_RUN: "false", MONDAY_API_TOKEN: "x", HUBSPOT_ACCESS_TOKEN: "x", TRIGGER_SECRET: "x" };
const opts = { dryRun: false, writeHubspot: true, maxWrites: 50 };
const budget = () => ({ left: 50 });

function putDeal(id: string, props: Record<string, string> = {}) {
  H.deals.set(id, { id, properties: {
    pipeline: "default", sales_user: SALES_USER_MYLA, createdate: RECENT,
    hs_lastmodifieddate: RECENT, dealstage: "appointmentscheduled", ...props,
  } });
}
function putItem(id: string, cols: { id: string; text: string }[], over: Partial<any> = {}) {
  H.items.set(id, {
    id, name: "Card", boardId: BOARD, created_at: RECENT, updated_at: RECENT,
    group: { id: GROUP }, column_values: cols, ...over,
  });
}

beforeEach(() => H.reset());

describe("hardening: create-once / update / dedup / no-loop (real sync orchestration)", () => {
  it("monday item with NO HubSpot ID creates a HubSpot deal exactly once (dup-safe)", async () => {
    putItem("i1", [], { name: "Brand New Deal" }); // no id column -> new card
    const r1 = await syncMondayItem(env, BOARD, "i1", opts, budget());
    expect(H.counts.createRecord).toBe(1);
    expect(r1).toContain("created-hubspot");
    expect(H.colText(H.items.get("i1"), ID_COL)).not.toBe(""); // id written back to the card

    // duplicate webhook for the same card must NOT create a second HubSpot deal
    await syncMondayItem(env, BOARD, "i1", opts, budget());
    expect(H.counts.createRecord).toBe(1);
  });

  it("monday item WITH a HubSpot ID updates the existing deal (never creates)", async () => {
    putDeal("9002", { dealname: "Old Name" });
    putItem("i2", [{ id: ID_COL, text: "9002" }, { id: SYNC_COL, text: RECENT }], { name: "New Name" });
    const r = await syncMondayItem(env, BOARD, "i2", opts, budget());
    expect(H.counts.createRecord).toBe(0);
    expect(H.counts.patchRecord).toBe(1);
    expect(H.deals.get("9002").properties.dealname).toBe("New Name");
    expect(r).toContain("updated-hubspot");
  });

  it("HubSpot deal webhook updates the existing linked monday item", async () => {
    putDeal("9003", { dealname: "HS Updated Name" });
    putItem("i3", [{ id: ID_COL, text: "9003" }, { id: SYNC_COL, text: "" }], { name: "Stale Name" });
    const r = await syncHubspotDeal(env, "9003", opts, budget());
    expect(H.counts.createItem).toBe(0);
    expect(H.counts.updateItem).toBe(1);
    expect(H.items.get("i3").name).toBe("HS Updated Name");
    expect(r).toContain("updated-monday");
  });

  it("HubSpot deal webhook creates a monday item only when no matching card exists (dup-safe)", async () => {
    putDeal("9004", { dealname: "Fresh Deal" }); // no linked card
    const r1 = await syncHubspotDeal(env, "9004", opts, budget());
    expect(H.counts.createItem).toBe(1);
    expect(r1).toContain("created-monday");

    // duplicate webhook -> finds the card by HubSpot ID and updates in place, never a 2nd card
    const r2 = await syncHubspotDeal(env, "9004", opts, budget());
    expect(H.counts.createItem).toBe(1);
    expect(r2).not.toContain("created-monday");
  });

  it("duplicate webhook payload does not create duplicate records", async () => {
    putDeal("9005", { dealname: "Batch Deal" });
    // one HubSpot payload carrying several property-change events for the SAME deal
    const idsInPayload = extractDealIds([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 9005, propertyName: "dealname" },
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 9005, propertyName: "dealstage" },
    ]);
    expect(idsInPayload).toEqual(["9005"]); // collapsed to one id up front

    for (const id of idsInPayload) await syncHubspotDeal(env, id, opts, budget());
    expect(H.counts.createItem).toBe(1);

    // HubSpot re-delivering the same payload later must still not duplicate
    for (const id of idsInPayload) await syncHubspotDeal(env, id, opts, budget());
    expect(H.counts.createItem).toBe(1);
  });

  it("worker-made updates do not cause an infinite loop (echo is a no-op)", async () => {
    putDeal("9006", { dealname: "Loop Deal" });
    putItem("i6", [{ id: ID_COL, text: "9006" }, { id: SYNC_COL, text: "" }], { name: "Old" });

    // 1) HubSpot change -> worker updates the monday card and stamps the sync-state baseline
    const a = await syncHubspotDeal(env, "9006", opts, budget());
    expect(a).toContain("updated-monday");
    const patchesAfterPush = H.counts.patchRecord;

    // 2) that write fires a monday webhook (the echo). Reconcile must see no diffs and write nothing back.
    const b = await syncMondayItem(env, BOARD, "i6", opts, budget());
    expect(b).toContain("skipped-in-sync");
    expect(H.counts.patchRecord).toBe(patchesAfterPush); // no HubSpot write -> no ping-pong
  });
});

describe("contacts & companies sync via webhook the same way as deals", () => {
  const putRecord = (id: string, props: Record<string, string>) => H.deals.set(id, { id, properties: props });
  const putItemFor = (spec: any, key: string, hsId: string, name: string, groupId: string) =>
    H.items.set(key, {
      id: key, name, boardId: spec.boardId, created_at: RECENT, updated_at: RECENT,
      group: { id: groupId },
      column_values: [{ id: spec.idCol, text: hsId }, { id: spec.syncStateCol, text: "" }],
    });

  it("HubSpot contact.creation creates a monday contact item (linked by HubSpot id)", async () => {
    putRecord("70001", { firstname: "Jane", lastname: "Doe", sales_user: SALES_USER_MYLA,
      createdate: RECENT, lastmodifieddate: RECENT, hs_lead_status: "OPEN" });
    const r = await syncHubspotObject(env, "contact", "70001", opts, budget());
    expect(H.counts.createItem).toBe(1);
    expect(r).toContain("created-monday");
    const card = [...H.items.values()].find(i => i.boardId === CONTACTS_MYLA.boardId)!;
    expect(H.colText(card, CONTACTS_MYLA.idCol)).toBe("70001");
  });

  it("HubSpot contact.propertyChange updates the existing contact item (never creates)", async () => {
    putRecord("70003", { firstname: "Edit", lastname: "Me", sales_user: SALES_USER_MYLA,
      createdate: RECENT, lastmodifieddate: RECENT, hs_lead_status: "OPEN" });
    putItemFor(CONTACTS_MYLA, "ci3", "70003", "Stale Name", "group_mm4wk3z0"); // OPEN group
    const r = await syncHubspotObject(env, "contact", "70003", opts, budget());
    expect(H.counts.createItem).toBe(0);
    expect(H.counts.updateItem).toBe(1);
    expect(H.items.get("ci3").name).toBe("Edit");                          // item name = firstname
    expect(H.colText(H.items.get("ci3"), CONTACTS_MYLA.idCol)).toBe("70003");
    expect(r).toContain("updated-monday");
  });

  it("contact with no Lead Status lands in the 'New' group (topics), not skipped", async () => {
    putRecord("70002", { firstname: "No", lastname: "Status", sales_user: SALES_USER_MYLA,
      createdate: RECENT, lastmodifieddate: RECENT, hs_lead_status: "" });
    await syncHubspotObject(env, "contact", "70002", opts, budget());
    expect(H.counts.createItem).toBe(1);
    const card = [...H.items.values()].find(i => i.boardId === CONTACTS_MYLA.boardId)!;
    expect(card.group.id).toBe("topics");
  });

  it("duplicate contact webhook does not create a duplicate item", async () => {
    putRecord("70004", { firstname: "Dup", lastname: "Contact", sales_user: SALES_USER_MYLA,
      createdate: RECENT, lastmodifieddate: RECENT, hs_lead_status: "OPEN" });
    await syncHubspotObject(env, "contact", "70004", opts, budget());
    await syncHubspotObject(env, "contact", "70004", opts, budget());
    expect(H.counts.createItem).toBe(1);
  });

  it("a contact not owned by Myla is skipped (out of scope, keyed on HubSpot Record ID)", async () => {
    putRecord("70099", { firstname: "Not", lastname: "Myla", sales_user: "999",
      createdate: RECENT, lastmodifieddate: RECENT, hs_lead_status: "OPEN" });
    const r = await syncHubspotObject(env, "contact", "70099", opts, budget());
    expect(H.counts.createItem).toBe(0);
    expect(r).toContain("out of scope");
  });

  it("HubSpot company.creation creates a monday company item (linked by HubSpot id)", async () => {
    putRecord("80001", { name: "Acme Corp", domain: "acme.com", sales_user: SALES_USER_MYLA,
      createdate: RECENT, hs_lastmodifieddate: RECENT });
    const r = await syncHubspotObject(env, "company", "80001", opts, budget());
    expect(H.counts.createItem).toBe(1);
    expect(r).toContain("created-monday");
    const card = [...H.items.values()].find(i => i.boardId === COMPANIES_MYLA.boardId)!;
    expect(H.colText(card, COMPANIES_MYLA.idCol)).toBe("80001");
    expect(card.name).toBe("acme.com");                     // primary column = domain
    expect(H.colText(card, "text_mm4scke9")).toBe("Acme Corp"); // "Company Name" column = name
  });

  it("HubSpot company.propertyChange updates the existing company item (never creates)", async () => {
    putRecord("80002", { name: "New Co Name", domain: "newco.com", sales_user: SALES_USER_MYLA,
      createdate: RECENT, hs_lastmodifieddate: RECENT });
    putItemFor(COMPANIES_MYLA, "co2", "80002", "oldco.com", "group_mm4s3z7e"); // company single group
    const r = await syncHubspotObject(env, "company", "80002", opts, budget());
    expect(H.counts.createItem).toBe(0);
    expect(H.counts.updateItem).toBe(1);
    expect(H.items.get("co2").name).toBe("newco.com");            // primary column = domain
    expect(H.colText(H.items.get("co2"), "text_mm4scke9")).toBe("New Co Name");
    expect(r).toContain("updated-monday");
  });

  it("duplicate company webhook does not create a duplicate item", async () => {
    putRecord("80003", { name: "Dup Co", domain: "dupco.com", sales_user: SALES_USER_MYLA,
      createdate: RECENT, hs_lastmodifieddate: RECENT });
    await syncHubspotObject(env, "company", "80003", opts, budget());
    await syncHubspotObject(env, "company", "80003", opts, budget());
    expect(H.counts.createItem).toBe(1);
  });
});
