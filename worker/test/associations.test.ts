import { describe, it, expect, beforeEach, vi } from "vitest";

// Mirror the in-memory-fake pattern from sync.test.ts, but for the association pass.
const H = vi.hoisted(() => {
  const assoc = new Map<string, string[]>();      // `${obj}:${id}:${to}` -> associated ids
  const records = new Map<string, any>();          // `${obj}:${id}` -> {id, properties}
  const parentCols = new Map<string, Record<string, any>>();    // parent itemId -> {col: raw value}
  const subitems = new Map<string, any[]>();        // parentId -> [{id,name,column_values}]
  const targetItems = new Map<string, string>();    // HubSpot id -> monday card id on the target board
  const targetHsId = new Map<string, string>();     // monday card id -> its HubSpot id (reverse resolve)
  const links = new Map<string, string[]>();        // `${itemId}:${col}` -> currently linked item ids
  const puts: string[][] = [];                      // recorded putAssociation calls [from,fromId,to,toId]
  const lineItemProps: any[] = [];                  // recorded createLineItem property payloads
  const counts: Record<string, number> = { createSubitem: 0, updateItem: 0, deleteItem: 0, setColumns: 0, createItem: 0, createLineItem: 0 };
  let next = 900;
  const tt = (v: any): string => {
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v.labels)) return v.labels.join(", ");
    if (v.date !== undefined) return String(v.date);
    if (v.label !== undefined) return String(v.label);
    return "";
  };
  const colText = (it: any, c: string) => (it.column_values.find((x: any) => x.id === c)?.text ?? "").trim();
  const reset = () => { assoc.clear(); records.clear(); parentCols.clear(); subitems.clear();
    targetItems.clear(); targetHsId.clear(); links.clear(); puts.length = 0; lineItemProps.length = 0; next = 900;
    for (const k in counts) counts[k] = 0; };
  return { assoc, records, parentCols, subitems, targetItems, targetHsId, links, puts, lineItemProps, counts, tt, colText, reset, id: () => "s" + (next++) };
});

vi.mock("../src/hubspot", () => ({
  getAssociatedIds: async (_e: any, f: string, id: string, t: string) => H.assoc.get(`${f}:${id}:${t}`) ?? [],
  getRecordsByIds: async (_e: any, o: string, ids: string[]) => ids.map(id => H.records.get(`${o}:${id}`)).filter(Boolean),
  propertiesForSpec: () => [],
  putAssociation: async (_e: any, from: string, fromId: string, to: string, toId: string) => { H.puts.push([from, fromId, to, toId]); },
  createLineItem: async (_e: any, p: any, _deal: string) => { H.counts.createLineItem++; H.lineItemProps.push(p); return "999"; },
}));
vi.mock("../src/monday", () => ({
  getSubitems: async (_e: any, p: string) => H.subitems.get(p) ?? [],
  createSubitem: async (_e: any, p: string, name: string, cv: any) => {
    H.counts.createSubitem++; const sid = H.id();
    H.subitems.set(p, [...(H.subitems.get(p) ?? []), { id: sid, name, column_values: Object.entries(cv).map(([id, v]) => ({ id, text: H.tt(v) })) }]);
    return sid;
  },
  updateItem: async (_e: any, _b: string, itemId: string, name: string, cv: any) => {
    H.counts.updateItem++;
    for (const arr of H.subitems.values()) for (const s of arr) if (s.id === itemId) {
      s.name = name;
      for (const [k, v] of Object.entries(cv)) { const ex = s.column_values.find((c: any) => c.id === k); if (ex) ex.text = H.tt(v); else s.column_values.push({ id: k, text: H.tt(v) }); }
    }
  },
  setColumns: async (_e: any, _b: string, itemId: string, cv: any) => {
    H.counts.setColumns++; const cur = H.parentCols.get(itemId) ?? {};
    for (const [k, v] of Object.entries(cv)) cur[k] = v; H.parentCols.set(itemId, cur); // store raw value
  },
  findItemIdsByColumn: async (_e: any, _b: string, _c: string, values: string[]) =>
    Object.fromEntries(values.filter(v => H.targetItems.has(v)).map(v => [v, H.targetItems.get(v)])),
  getItemsColumnText: async (_e: any, itemIds: string[], _c: string) =>
    Object.fromEntries(itemIds.map(id => [id, H.targetHsId.get(id) ?? ""])),
  getLinkedItemIds: async (_e: any, itemId: string, col: string) => H.links.get(`${itemId}:${col}`) ?? [],
  createItem: async (_e: any, _b: string, _g: string, _n: string, _c: any) => {
    H.counts.createItem++; return String(700 + H.counts.createItem); // numeric card id
  },
  deleteItem: async (_e: any, itemId: string) => {
    H.counts.deleteItem++;
    for (const [p, arr] of H.subitems) H.subitems.set(p, arr.filter(s => s.id !== itemId));
  },
}));

import { reverseAssociations, reverseLineItems, syncAssociations } from "../src/associations";
import { DEALS, COMPANIES_MYLA } from "../src/config";

const env: any = {}; const opts = { dryRun: false, writeHubspot: false, maxWrites: 50 }; const budget = () => ({ left: 50 });
const item = (id: string, cols: { id: string; text: string }[] = []) =>
  ({ id, name: "x", created_at: "", updated_at: "", group: { id: "g" }, column_values: cols });
const ctx: any = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, portalId: 1 };
const LI = DEALS.associations!.find(a => a.subitems)!.subitems!;
// The real config now links via board_relation columns; the text `col` path (syncNameColumn) is still
// supported, so exercise it via synthetic specs rather than the live config.
const COMPANY_COL = "text_co"; const CONTACT_COL = "text_ct";
const nameSpec: any = { ...DEALS, associations: [
  { toObject: "companies", nameProps: ["name"], col: COMPANY_COL },
  { toObject: "contacts", nameProps: ["firstname", "lastname"], col: CONTACT_COL },
] };

beforeEach(() => H.reset());

describe("syncAssociations (HubSpot -> monday, one-directional)", () => {
  it("writes associated company + contact names to the parent columns", async () => {
    H.assoc.set("deals:1:companies", ["11"]); H.records.set("companies:11", { id: "11", properties: { name: "Acme" } });
    H.assoc.set("deals:1:contacts", ["21"]); H.records.set("contacts:21", { id: "21", properties: { firstname: "Jo", lastname: "Lee" } });
    await syncAssociations(env, nameSpec, { id: "1", properties: {} }, item("100"), ctx, opts, budget());
    expect(H.parentCols.get("100")![COMPANY_COL]).toBe("Acme");
    expect(H.parentCols.get("100")![CONTACT_COL]).toBe("Jo Lee");
  });

  it("clears the association column when there are no associations", async () => {
    const col = "text_clear";
    const clearSpec: any = { ...COMPANIES_MYLA, associations: [{ toObject: "contacts", nameProps: ["firstname", "lastname"], col }] };
    await syncAssociations(env, clearSpec, { id: "7", properties: {} }, item("70", [{ id: col, text: "Old" }]), ctx, opts, budget());
    expect(H.parentCols.get("70")![col]).toBe("");
  });

  it("creates a subitem per line item, updates an existing one by Line Item ID, marks removed ones (Status=Removed)", async () => {
    H.assoc.set("deals:1:line_items", ["999", "888"]);
    H.records.set("line_items:999", { id: "999", properties: { name: "A", price: "1500", quantity: "1", amount: "1500" } });
    H.records.set("line_items:888", { id: "888", properties: { name: "B", price: "10", quantity: "2", amount: "20" } });
    H.subitems.set("100", [
      { id: "s999", name: "A-old", column_values: [{ id: LI.idCol, text: "999" }] },  // -> update
      { id: "s777", name: "gone", column_values: [{ id: LI.idCol, text: "777" }] },   // -> mark Removed
    ]);
    await syncAssociations(env, DEALS, { id: "1", properties: {} }, item("100"), ctx, opts, budget());
    const subs = H.subitems.get("100")!;
    expect(subs.map(s => H.colText(s, LI.idCol)).sort()).toEqual(["777", "888", "999"]); // all present; 777 marked, not deleted
    expect(H.colText(subs.find(s => H.colText(s, LI.idCol) === "777")!, LI.statusCol!)).toBe("Removed");
    expect(H.counts.createSubitem).toBe(1); // 888 created
    expect(H.counts.updateItem).toBe(2);     // 999 updated + 777 marked Removed
    expect(H.counts.deleteItem).toBe(0);
    // No parent roll-up: everything lives on the subitem columns.
    expect(H.parentCols.has("100")).toBe(false);
  });

  it("does not create duplicate subitems on a second sync (matches by Line Item ID)", async () => {
    H.assoc.set("deals:5:line_items", ["999"]);
    H.records.set("line_items:999", { id: "999", properties: { name: "A", price: "1500", quantity: "1", amount: "1500" } });
    await syncAssociations(env, DEALS, { id: "5", properties: {} }, item("500"), ctx, opts, budget()); // create
    await syncAssociations(env, DEALS, { id: "5", properties: {} }, item("500"), ctx, opts, budget()); // update, no dup
    expect(H.subitems.get("500")!.filter(s => H.colText(s, LI.idCol) === "999").length).toBe(1);
    expect(H.counts.createSubitem).toBe(1);
  });

  it("one association failing does not block the others", async () => {
    // companies read throws; contacts still writes.
    H.assoc.set("deals:2:contacts", ["21"]); H.records.set("contacts:21", { id: "21", properties: { firstname: "Ann", lastname: "Ng" } });
    const hubspot = await import("../src/hubspot");
    const spy = vi.spyOn(hubspot, "getRecordsByIds").mockImplementationOnce(async () => { throw new Error("403"); });
    H.assoc.set("deals:2:companies", ["11"]); H.records.set("companies:11", { id: "11", properties: { name: "Acme" } });
    await syncAssociations(env, nameSpec, { id: "2", properties: {} }, item("200"), ctx, opts, budget());
    expect(H.parentCols.get("200")![CONTACT_COL]).toBe("Ann Ng");
    spy.mockRestore();
  });

  it("links associated cards in a Connect Boards (board_relation) column by resolving HubSpot ids -> monday cards", async () => {
    const relSpec = { ...DEALS, associations: [{ toObject: "companies", nameProps: ["name"], relationCol: "conn_co" }] };
    H.assoc.set("deals:1:companies", ["11", "22"]);
    H.targetItems.set("11", "901"); H.targetItems.set("22", "902"); // matching cards on the company board
    await syncAssociations(env, relSpec as any, { id: "1", properties: {} }, item("100"), ctx, opts, budget());
    expect(H.parentCols.get("100")!["conn_co"]).toEqual({ item_ids: [901, 902] });
  });

  it("does not re-write a Connect Boards column when the links already match", async () => {
    const relSpec = { ...DEALS, associations: [{ toObject: "companies", nameProps: ["name"], relationCol: "conn_co" }] };
    H.assoc.set("deals:1:companies", ["11"]);
    H.targetItems.set("11", "901");
    H.links.set("100:conn_co", ["901"]); // already linked -> must skip
    await syncAssociations(env, relSpec as any, { id: "1", properties: {} }, item("100"), ctx, opts, budget());
    expect(H.counts.setColumns).toBe(0);
  });

  it("reverseLineItems creates a HubSpot line item only for subitems lacking an id, then stamps it", async () => {
    H.subitems.set("100", [
      { id: "s1", name: "Widget", column_values: [{ id: LI.idCol, text: "" }, { id: "numeric_mm53rsfd", text: "50" }] },
      { id: "s2", name: "Synced", column_values: [{ id: LI.idCol, text: "31395364724" }] },
    ]);
    await reverseLineItems(env, LI, item("100"), "DEAL1", opts, budget());
    expect(H.counts.createLineItem).toBe(1);                    // only s1 (no id) created
    expect(H.parentCols.get("s1")![LI.idCol]).toBe("999");      // returned line-item id stamped onto the subitem
  });

  it("reverseLineItems adopts an existing same-name line item instead of duplicating (cross-isolate guard)", async () => {
    H.subitems.set("100", [{ id: "s1", name: "Widget", column_values: [{ id: LI.idCol, text: "" }, { id: "numeric_mm53rsfd", text: "50" }] }]);
    H.assoc.set("deals:DEAL1:line_items", ["777"]);                     // deal already has a "Widget" line item
    H.records.set("line_items:777", { id: "777", properties: { name: "Widget" } });
    await reverseLineItems(env, LI, item("100"), "DEAL1", opts, budget());
    expect(H.counts.createLineItem).toBe(0);                            // adopted, not created
    expect(H.parentCols.get("s1")![LI.idCol]).toBe("777");             // adopted id stamped onto the subitem
  });

  it("reverseLineItems sets hs_product_id when the product-id column is filled (picked from the catalog)", async () => {
    H.subitems.set("100", [{ id: "s1", name: "Prod", column_values: [
      { id: LI.idCol, text: "" }, { id: "numeric_mm53rsfd", text: "50" }, { id: LI.productIdCol!, text: "PROD123" }] }]);
    await reverseLineItems(env, LI, item("100"), "DEAL1", opts, budget());
    expect(H.lineItemProps[0].hs_product_id).toBe("PROD123");
  });

  it("reverseAssociations PUTs monday links missing from HubSpot, skips present ones (additive)", async () => {
    const relSpec = { ...DEALS, associations: [{ toObject: "companies", nameProps: ["name"], relationCol: "conn_co" }] };
    H.assoc.set("deals:1:companies", ["11"]);              // HubSpot already has company 11
    H.links.set("100:conn_co", ["901", "902"]);            // monday deal card 100 links cards 901, 902
    H.targetHsId.set("901", "11"); H.targetHsId.set("902", "22"); // linked card -> its HubSpot id
    await reverseAssociations(env, relSpec as any, { id: "1", properties: {} }, item("100"), opts, budget());
    expect(H.puts).toEqual([["deals", "1", "companies", "22"]]); // only 22 is missing -> PUT; 11 skipped
  });

  it("creates the target card on demand when it's missing from the board, then links it", async () => {
    const relSpec = { ...DEALS, associations: [{ toObject: "companies", nameProps: ["name"], relationCol: "conn_co" }] };
    H.assoc.set("deals:9:companies", ["55"]);
    H.records.set("companies:55", { id: "55", properties: { name: "NewCo", domain: "newco.com" } }); // for getRecordsByIds
    // H.targetItems empty -> card not on the board -> ensureTargetCard creates it (createItem -> "701")
    await syncAssociations(env, relSpec as any, { id: "9", properties: {} }, item("900"), ctx, opts, budget());
    expect(H.counts.createItem).toBe(1);
    expect(H.parentCols.get("900")!["conn_co"]).toEqual({ item_ids: [701] });
  });
});
