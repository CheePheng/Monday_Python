import { describe, it, expect, afterEach, vi } from "vitest";
import { getRecordWithHistory } from "../src/hubspot";
import { changedAtOf, getItemFresh, getLinkedCell, setColumns, updateColumns, updateItem } from "../src/monday";
import { cardValueFingerprint, lastCellChanges, valueFingerprint } from "../src/ui-actor";
import { extractObjectScopes } from "../src/webhooks";
import { WATCH_RPC_TIMEOUT_MS, markEdits, watchCells } from "../src/card-registry";
import { CRM_CONTACTS } from "../src/config/crm";
import type { Env, RunOpts } from "../src/types";

/**
 * STALE_FORWARD_GATE'S READS AND WRITES, at the wire (fetch stubbed): the record with its property history, the card
 * with each cell's changed_at, a relation cell with its own, the name-less write, the activity log's newest change
 * per cell, and what a HubSpot webhook batch names (extractObjectScopes).
 */

const env = { HUBSPOT_ACCESS_TOKEN: "t", MONDAY_API_TOKEN: "m" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
afterEach(() => { vi.unstubAllGlobals(); });

/** A fetch fake: each call answered by `answer(url, body)`; every call recorded. */
function fetchFake(answer: (url: string, body: any) => { status?: number; json: unknown }) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const a = answer(url, body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  }));
  return calls;
}

describe("getRecordWithHistory: one GET, the record and its properties' history", () => {
  it("asks for properties and propertiesWithHistory, and keeps each version's source", async () => {
    const calls = fetchFake(() => ({ json: { id: "1", properties: { lifecyclestage: "lead", jobtitle: null },
      propertiesWithHistory: { lifecyclestage: [
        { value: "1029060900", timestamp: "2026-10-09T08:21:32.807Z", sourceType: "INTEGRATION", sourceId: 52247773 },
        { value: "lead", timestamp: "2026-07-18T12:40:00.000Z", sourceType: "FORM" }] } } }));
    const r = await getRecordWithHistory(env, "contacts", "1", ["lifecyclestage", "jobtitle", "email"], ["lifecyclestage"]);
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0].url)).toContain("properties=lifecyclestage,jobtitle,email");
    expect(decodeURIComponent(calls[0].url)).toContain("&propertiesWithHistory=lifecyclestage");
    expect(r!.properties).toEqual({ lifecyclestage: "lead", jobtitle: null, email: null });
    expect(r!.history.lifecyclestage).toEqual([
      { value: "1029060900", timestamp: "2026-10-09T08:21:32.807Z", sourceType: "INTEGRATION", sourceId: "52247773" },
      { value: "lead", timestamp: "2026-07-18T12:40:00.000Z", sourceType: "FORM" }]);
  });

  it("no history asked: no propertiesWithHistory; a property HubSpot never held has no versions", async () => {
    const calls = fetchFake(() => ({ json: { id: "1", properties: { a: "x" } } }));
    expect(await getRecordWithHistory(env, "contacts", "1", ["a"], [])).toEqual({ properties: { a: "x" }, history: {} });
    expect(calls[0].url).not.toContain("propertiesWithHistory");
    const r = await getRecordWithHistory(env, "contacts", "1", ["a"], ["b"]);
    expect(r!.history).toEqual({ b: [] });
  });

  it("404 -> null; anything else throws", async () => {
    fetchFake(() => ({ status: 404, json: { message: "not found" } }));
    expect(await getRecordWithHistory(env, "contacts", "1", ["a"], ["a"])).toBeNull();
    fetchFake(() => ({ status: 400, json: { message: "bad" } }));
    await expect(getRecordWithHistory(env, "contacts", "1", ["a"], ["a"])).rejects.toThrow(/400/);
  });
});

describe("getItemFresh: the card with each asked cell's changed_at", () => {
  const item = { id: "5", name: "Pat", created_at: "", updated_at: "2026-10-09T09:00:00Z", group: { id: "g" }, column_values: [] };

  it("one query; changed_at where the value carries one (null for a text cell); the raw value too", async () => {
    const calls = fetchFake(() => ({ json: { data: { items: [{ ...item, stamps: [
      { id: "color_x", value: JSON.stringify({ index: 4, changed_at: "2026-10-09T08:21:27.004Z" }) },
      { id: "text_y", value: JSON.stringify("Buyer") }] }] } } }));
    const r = await getItemFresh(env, "5", ["color_x", "text_y", "date_z"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.query).toContain("stamps: column_values(ids:$c) { id value }");
    expect(calls[0].body.variables).toEqual({ i: ["5"], c: ["color_x", "text_y", "date_z"] });
    expect(r!.stamps).toEqual({ color_x: Date.parse("2026-10-09T08:21:27.004Z"), text_y: null, date_z: null });
    expect(r!.values.text_y).toBe(JSON.stringify("Buyer"));
    expect(r!.values.date_z).toBeNull();
    expect((r!.item as unknown as Record<string, unknown>).stamps).toBeUndefined();
  });

  it("no columns: the plain read; an item that does not exist: null", async () => {
    const calls = fetchFake(() => ({ json: { data: { items: [] } } }));
    expect(await getItemFresh(env, "5", [])).toBeNull();
    expect(calls[0].body.query).not.toContain("stamps");
  });

  it("changedAtOf reads JSON strings and objects; anything else is null", () => {
    expect(changedAtOf('{"changed_at":"2026-10-09T08:00:00.000Z"}')).toBe(Date.parse("2026-10-09T08:00:00.000Z"));
    expect(changedAtOf({ changed_at: "2026-10-09T08:00:00.000Z" })).toBe(Date.parse("2026-10-09T08:00:00.000Z"));
    for (const v of [null, undefined, "", "\"text\"", "{bad", { changed_at: "never" }, 5]) expect(changedAtOf(v)).toBeNull();
  });

  it("getLinkedCell: the linked ids, and the cell's changed_at", async () => {
    fetchFake(() => ({ json: { data: { items: [{ column_values: [{ linked_item_ids: [7001, "7002"],
      value: JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 7001 }], changed_at: "2026-10-09T09:00:00.000Z" }) }] }] } } }));
    expect(await getLinkedCell(env, "5", "rel")).toEqual({ ids: ["7001", "7002"], changedAt: Date.parse("2026-10-09T09:00:00.000Z") });
  });
});

describe("the gated writes", () => {
  it("updateColumns: no name, and new labels are created as updateItem creates them", async () => {
    const calls = fetchFake(() => ({ json: { data: { change_multiple_column_values: { id: "5" } } } }));
    await updateColumns(env, "b", "5", { color_x: { label: "5.No intention" } }, live);
    expect(calls[0].body.query).toContain("create_labels_if_missing:true");
    expect(JSON.parse(calls[0].body.variables.c)).toEqual({ color_x: { label: "5.No intention" } });
    await updateColumns(env, "b", "5", { a: "x" }, { ...live, dryRun: true });
    expect(calls).toHaveLength(1);
  });

  it("maxRateWaits 0: a rate-limited write is refused at once (MondayRateLimitedError, provably not executed)", async () => {
    const calls = fetchFake(() => ({ status: 429, json: { error_message: "Rate limit exceeded", retry_in_seconds: 30 } }));
    await expect(updateColumns(env, "b", "5", { a: "x" }, live, 0)).rejects.toMatchObject({ name: "MondayRateLimitedError" });
    await expect(updateItem(env, "b", "5", "Pat", { a: "x" }, live, 0)).rejects.toMatchObject({ name: "MondayRateLimitedError" });
    expect(calls).toHaveLength(2);
  });

  it("...and setColumns (a stamp-only write) as well: refused, never waited on (only gql's own short retry pauses)", async () => {
    vi.useFakeTimers();
    try {
      const calls = fetchFake(() => ({ status: 429, json: { error_message: "Rate limit exceeded", retry_in_seconds: 30 } }));
      const settled = expect(setColumns(env, "b", "5", { s: "t" }, live, 0)).rejects.toMatchObject({ name: "MondayRateLimitedError" });
      await vi.advanceTimersByTimeAsync(10_000);                             // 1.5 s + 3 s pauses; a rate wait would be 31 s
      await settled;
      expect(calls).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });

  it("setColumns and updateItem without maxRateWaits are the calls they always were", async () => {
    const calls = fetchFake(() => ({ json: { data: { change_multiple_column_values: { id: "5" } } } }));
    await setColumns(env, "b", "5", { s: "t" }, live);
    await updateItem(env, "b", "5", "Pat", { a: "x" }, live);
    expect(calls[0].body.query).not.toContain("create_labels_if_missing");
    expect(JSON.parse(calls[1].body.variables.c)).toEqual({ a: "x", name: "Pat" });
  });
});

describe("the card watch's RPCs (card-registry): bounded and fail-soft", () => {
  it("a watch that never answers: the call gives up after WATCH_RPC_TIMEOUT_MS, logs, and returns null", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const hung = { CREATE_IDEMPOTENCY: { idFromName: (n: string) => n, get: () => ({ watchCells: () => new Promise(() => {}) }) } } as unknown as Env;
      const p = watchCells(hung, { boardId: "1", itemId: "2", object: "contacts" }, [], { windowMs: 180_000 });
      await vi.advanceTimersByTimeAsync(WATCH_RPC_TIMEOUT_MS);
      await expect(p).resolves.toBeNull();
      expect(log.mock.calls.some(c => /\[watch\] board=1 item=2 action=watch-unreachable call=watchCells/.test(String(c[0])))).toBe(true);
    } finally { log.mockRestore(); vi.useRealTimers(); }
  });

  it("a watch that throws: null, logged; a mark that cannot be made is logged as such and the edit goes on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const down = { CREATE_IDEMPOTENCY: { idFromName: (n: string) => n, get: () => { throw new Error("DO unreachable"); } } } as unknown as Env;
      await expect(watchCells(down, { boardId: "1", itemId: "2", object: "contacts" }, [], { windowMs: 180_000 })).resolves.toBeNull();
      await expect(markEdits(down, { boardId: "1", itemId: "2", object: "contacts" }, [{ key: "c", at: 1, rx: 1 }])).resolves.toBeUndefined();
      expect(log.mock.calls.some(c => /action=mark-unreachable call=markEdits/.test(String(c[0])))).toBe(true);
    } finally { log.mockRestore(); }
  });
});

describe("lastCellChanges: who last changed each cell, by monday's activity log", () => {
  const row = (col: string, user: string, at: string, value: unknown, uuid = false) => ({
    event: "update_column_value", user_id: user, created_at: String(Date.parse(at) * 1e4),
    data: JSON.stringify({ pulse_id: 5, column_id: col, value, ...(uuid ? { action_record_uuid: "u-1" } : {}) }) });
  const answer = (rows: unknown[]) => (_url: string, body: any) => body.query.includes("me { id }")
    ? { json: { data: { me: { id: "104118038" } } } }
    : { json: { data: { boards: [{ activity_logs: rows }] } } };
  const spec = CRM_CONTACTS;

  it("the newest row per column, classified, with its value's fingerprint", async () => {
    const calls = fetchFake(answer([
      row("a", "104239547", "2026-10-09T09:00:05.000Z", { label: { index: 4 } }),
      row("a", "104118038", "2026-10-09T09:00:01.000Z", { label: { index: 1 } }),
      row("b", "-4", "2026-10-09T09:00:02.000Z", { value: "x" }),
      row("c", "104118038", "2026-10-09T09:00:03.000Z", { value: "y" }, true),
      row("d", "104118038", "2026-10-09T09:00:03.000Z", { value: "z" }),
    ]));
    const r = await lastCellChanges({ ...env, ASK_ADA_UI_EDITS: "true" } as Env, spec, "5", ["a", "b", "c", "d", "e"], Date.parse("2026-10-09T09:00:00.000Z"));
    expect(r!.a).toEqual({ atMs: Date.parse("2026-10-09T09:00:05.000Z"), userId: "104239547", cls: "person", valueFp: "L:4" });
    expect(r!.b!.cls).toBe("automation");
    expect(r!.c!.cls, "our token in the UI (a uuid), ASK_ADA_UI_EDITS on").toBe("person");
    expect(r!.d!.cls, "our token's API write").toBe("integration");
    expect(Object.hasOwn(r!, "e"), "no row in the window: absent (null is kept for 'cannot be told')").toBe(false);
    const q = calls.find(c => c.body.query.includes("activity_logs"))!;
    expect(q.body.variables.f).toBe("2026-10-09T08:58:00.000Z");
  });

  it("[F2] a People column's row carries the people it removed (null: no before-side); other columns carry none", async () => {
    const SALES = spec.fields.find(f => f.hs === "sales_user")!.col;
    const p = (...ids: number[]) => ({ personsAndTeams: ids.map(id => ({ id, kind: "person" })) });
    fetchFake((_url, body) => body.query.includes("me { id }") ? { json: { data: { me: { id: "104118038" } } } }
      : { json: { data: { boards: [{ activity_logs: [
        { event: "update_column_value", user_id: "1", created_at: String(Date.parse("2026-10-09T09:00:05.000Z") * 1e4),
          data: JSON.stringify({ pulse_id: 5, column_id: SALES, value: p(), previous_value: p(998) }) },
        { event: "update_column_value", user_id: "1", created_at: String(Date.parse("2026-10-09T09:00:04.000Z") * 1e4),
          data: JSON.stringify({ pulse_id: 5, column_id: "a", value: { value: "x" }, previous_value: { value: "y" } }) },
      ] }] } } });
    const r = await lastCellChanges(env, spec, "5", [SALES, "a"], 0);
    expect(r![SALES]!.removed).toEqual(["998"]);
    expect(r!.a!.removed).toBeUndefined();
    fetchFake((_url, body) => body.query.includes("me { id }") ? { json: { data: { me: { id: "104118038" } } } }
      : { json: { data: { boards: [{ activity_logs: [{ event: "update_column_value", user_id: "1", created_at: "1",
        data: JSON.stringify({ pulse_id: 5, column_id: SALES, value: p() }) }] }] } } });
    expect((await lastCellChanges(env, spec, "5", [SALES], 0))![SALES]!.removed, "no before-side: cannot tell").toBeNull();
  });

  it("our token's UI row is our own while ASK_ADA_UI_EDITS is off", async () => {
    fetchFake(answer([row("c", "104118038", "2026-10-09T09:00:03.000Z", { value: "y" }, true)]));
    expect((await lastCellChanges(env, spec, "5", ["c"], 0))!.c!.cls).toBe("integration");
  });

  it("two newest rows at the same instant, or an unreadable one: no verdict for that cell (fail closed)", async () => {
    fetchFake(answer([row("a", "1", "2026-10-09T09:00:05.000Z", { value: "x" }), row("a", "2", "2026-10-09T09:00:05.000Z", { value: "y" }),
      { event: "update_column_value", user_id: "1", created_at: "soon", data: JSON.stringify({ pulse_id: 5, column_id: "b", value: {} }) }]));
    const r = await lastCellChanges(env, spec, "5", ["a", "b"], 0);
    expect(r).toEqual({ a: null, b: null });
  });

  it("a query that fails, or a row whose data is unreadable: no answer at all", async () => {
    fetchFake(() => ({ status: 500, json: { error_message: "boom" } }));
    expect(await lastCellChanges(env, spec, "5", ["a"], 0)).toBeNull();
    fetchFake(answer([{ event: "update_column_value", user_id: "1", created_at: "1", data: "{not json" }]));
    expect(await lastCellChanges(env, spec, "5", ["a"], 0)).toBeNull();
    expect(await lastCellChanges(env, spec, "5", [], 0)).toEqual({});
  });
});

describe("a card's raw column value, fingerprinted like its event", () => {
  it("status {index}, text as a bare JSON string, dropdown {ids} read as the webhook / log spell them", () => {
    expect(cardValueFingerprint(JSON.stringify({ index: 4, changed_at: "x" }))).toBe(valueFingerprint({ label: { index: 4, text: "5" } }));
    expect(cardValueFingerprint(JSON.stringify("Buyer"))).toBe(valueFingerprint({ value: "Buyer" }));
    expect(cardValueFingerprint(JSON.stringify({ ids: [2, 1] }))).toBe(valueFingerprint({ chosenValues: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }));
    expect(cardValueFingerprint(JSON.stringify({ date: "2026-10-09", changed_at: "x" }))).toBe(valueFingerprint({ date: "2026-10-09" }));
    expect(cardValueFingerprint(null)).toBe("∅");
    expect(cardValueFingerprint("")).toBe("∅");
  });
});

describe("extractObjectScopes: what each record's events named", () => {
  const ev = (o: Record<string, unknown>) => ({ subscriptionType: "object.propertyChange", objectTypeId: "0-1", objectId: 1, ...o });

  it("a propertyChange names its property, at its time, our own or not", () => {
    const s = extractObjectScopes([
      ev({ propertyName: "notes_last_updated", occurredAt: 1000, changeSource: "CALCULATED" }),
      ev({ propertyName: "lifecyclestage", occurredAt: 2000, changeSource: "INTEGRATION", sourceId: "52247773" }),
      ev({ propertyName: "jobtitle", occurredAt: 3000, changeSource: "INTEGRATION", sourceId: "99" }),
    ]);
    expect(s.get("contact:1")).toEqual({ props: {
      notes_last_updated: { at: 1000, own: false }, lifecyclestage: { at: 2000, own: true }, jobtitle: { at: 3000, own: null } } });
  });

  it("the newest event per property; an event without a time cannot be placed (its source is left to the history)", () => {
    const s = extractObjectScopes([ev({ propertyName: "a", occurredAt: 5000, changeSource: "CRM_UI" }),
      ev({ propertyName: "a", occurredAt: 3000, changeSource: "INTEGRATION", sourceId: "52247773" }),
      ev({ propertyName: "b", changeSource: "CRM_UI" })]);
    expect(s.get("contact:1")).toEqual({ props: { a: { at: 5000, own: false }, b: { at: 0, own: null } } });
  });

  it("an associationChange names nothing; a creation, a merge or a bare workflow payload is unscoped (and wins)", () => {
    expect(extractObjectScopes([{ subscriptionType: "object.associationChange", fromObjectTypeId: "0-1", fromObjectId: 1 }])
      .get("contact:1")).toEqual({ props: {} });
    expect(extractObjectScopes([ev({ propertyName: "a", occurredAt: 1 }), { subscriptionType: "object.creation", objectTypeId: "0-1", objectId: 1 }])
      .get("contact:1")).toBe("unscoped");
    expect(extractObjectScopes([{ subscriptionType: "contact.merge", objectId: 1 }]).get("contact:1")).toBe("unscoped");
    expect(extractObjectScopes([{ hs_object_id: 9 }]).get("deal:9")).toBe("unscoped");
  });

  it("line items resolve by objectTypeId 0-8 or a line_item.* subscription; deletions are not passes", () => {
    expect(extractObjectScopes([{ subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 77, propertyName: "price",
      occurredAt: 5, changeSource: "CRM_UI" }]).get("line_item:77")).toEqual({ props: { price: { at: 5, own: false } } });
    expect(extractObjectScopes([{ subscriptionType: "line_item.propertyChange", objectId: 78, propertyName: "quantity", occurredAt: 6 }])
      .get("line_item:78")).toEqual({ props: { quantity: { at: 6, own: null } } });
    expect(extractObjectScopes([{ subscriptionType: "object.deletion", objectTypeId: "0-1", objectId: 1 }]).size).toBe(0);
    expect(extractObjectScopes(null).size).toBe(0);
  });
});
