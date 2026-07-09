import { describe, it, expect, beforeEach, vi } from "vitest";

// Mirror the in-memory-fake pattern from sync.test.ts, but for the association pass.
const H = vi.hoisted(() => {
  const assoc = new Map<string, string[]>();      // `${obj}:${id}:${to}` -> associated ids
  const records = new Map<string, any>();          // `${obj}:${id}` -> {id, properties}
  const parentCols = new Map<string, Record<string, string>>(); // parent itemId -> {col: text}
  const subitems = new Map<string, any[]>();        // parentId -> [{id,name,column_values}]
  const counts: Record<string, number> = { createSubitem: 0, updateItem: 0, deleteItem: 0, setColumns: 0 };
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
  const reset = () => { assoc.clear(); records.clear(); parentCols.clear(); subitems.clear(); next = 900;
    for (const k in counts) counts[k] = 0; };
  return { assoc, records, parentCols, subitems, counts, tt, colText, reset, id: () => "s" + (next++) };
});

vi.mock("../src/hubspot", () => ({
  getAssociatedIds: async (_e: any, f: string, id: string, t: string) => H.assoc.get(`${f}:${id}:${t}`) ?? [],
  getRecordsByIds: async (_e: any, o: string, ids: string[]) => ids.map(id => H.records.get(`${o}:${id}`)).filter(Boolean),
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
    for (const [k, v] of Object.entries(cv)) cur[k] = H.tt(v); H.parentCols.set(itemId, cur);
  },
  deleteItem: async (_e: any, itemId: string) => {
    H.counts.deleteItem++;
    for (const [p, arr] of H.subitems) H.subitems.set(p, arr.filter(s => s.id !== itemId));
  },
}));

import { syncAssociations } from "../src/associations";
import { DEALS, COMPANIES_MYLA } from "../src/config";

const env: any = {}; const opts = { dryRun: false, writeHubspot: false, maxWrites: 50 }; const budget = () => ({ left: 50 });
const item = (id: string, cols: { id: string; text: string }[] = []) =>
  ({ id, name: "x", created_at: "", updated_at: "", group: { id: "g" }, column_values: cols });
const ctx: any = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, portalId: 1 };
const COMPANY_COL = DEALS.associations!.find(a => a.toObject === "companies")!.col!;
const CONTACT_COL = DEALS.associations!.find(a => a.toObject === "contacts")!.col!;
const LI = DEALS.associations!.find(a => a.subitems)!.subitems!;

beforeEach(() => H.reset());

describe("syncAssociations (HubSpot -> monday, one-directional)", () => {
  it("writes associated company + contact names to the parent columns", async () => {
    H.assoc.set("deals:1:companies", ["11"]); H.records.set("companies:11", { id: "11", properties: { name: "Acme" } });
    H.assoc.set("deals:1:contacts", ["21"]); H.records.set("contacts:21", { id: "21", properties: { firstname: "Jo", lastname: "Lee" } });
    await syncAssociations(env, DEALS, { id: "1", properties: {} }, item("100"), ctx, opts, budget());
    expect(H.parentCols.get("100")![COMPANY_COL]).toBe("Acme");
    expect(H.parentCols.get("100")![CONTACT_COL]).toBe("Jo Lee");
  });

  it("clears the association column when there are no associations", async () => {
    const col = COMPANIES_MYLA.associations![0].col!;
    await syncAssociations(env, COMPANIES_MYLA, { id: "7", properties: {} }, item("70", [{ id: col, text: "Old" }]), ctx, opts, budget());
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
    expect(H.parentCols.get("100")![LI.countCol]).toBe("2");
    expect(H.parentCols.get("100")![LI.totalCol]).toBe("1520");
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
    await syncAssociations(env, DEALS, { id: "2", properties: {} }, item("200"), ctx, opts, budget());
    expect(H.parentCols.get("200")![CONTACT_COL]).toBe("Ann Ng");
    spy.mockRestore();
  });
});
