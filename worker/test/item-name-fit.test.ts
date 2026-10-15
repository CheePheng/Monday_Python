import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MONDAY_ITEM_NAME_MAX, expectedText, fitItemName, itemName, itemNameFitOn } from "../src/mapping";
import { buildReversePatch, columnEditPatch, fieldDiffs, type Diff } from "../src/reconcile";
import { createItem, createSubitem, updateItem } from "../src/monday";
import { ensureCardForRecord } from "../src/ensure-card";
import { CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import type { Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * A MONDAY ITEM NAME PAST MONDAY'S LIMIT (ITEM_NAME_FIT). Ported from the parked wip/reliability-queue
 * branch, re-gated from RECORD_SYNC_QUEUE onto ITEM_NAME_FIT.
 *
 * Live, 2026-10: HubSpot contact 563860620999 has a 148-character firstname and a 148-character lastname,
 * so its card name is 297 characters, and monday answered the create with "item_name is too long. Item
 * names must be below 256 characters." The create is refused for good, so the contact never got a card.
 * updateItem sends the name on EVERY forward write, so the same name on an existing card fails every
 * update of it too.
 *
 * With the switch on, monday.ts fits every name it writes (fitItemName), the name diff compares the fitted
 * form (so a fitted card is never renamed again), and a name the card shows only fitted is never pushed
 * back over HubSpot's longer one. With it off, every path below is pinned to today's exact behaviour.
 *
 * This file drives the REAL monday.ts against a monday-like fetch stub that refuses a name over 255, as
 * monday does. The engine-level paths (forward pass, a person's rename) are in item-name-fit-engine.test.ts,
 * the line-item subitem's rename in item-name-fit-subitem.test.ts.
 */

const ELLIPSIS = "…";
const FIRST = "F".repeat(148);
const LAST = "L".repeat(148);
const FULL = `${FIRST} ${LAST}`;                     // the live 297-character card name
const MOD = "2026-10-02T08:07:46Z";

const p3 = (over: Record<string, string> = {}): HsRecord => ({
  id: "563860620999",
  properties: { firstname: FIRST, lastname: LAST, createdate: "2026-09-29T10:17:21Z", lastmodifieddate: MOD, ...over },
});

// ------------------------------------------------------------------------------------- fitItemName

describe("fitItemName: the name monday will take", () => {
  it("pins monday's limit: 'Item names must be below 256 characters'", () =>
    expect(MONDAY_ITEM_NAME_MAX).toBe(255));

  it("the live record really is over it", () => {
    expect(itemName(p3(), CRM_CONTACTS)).toBe(FULL);
    expect(FULL).toHaveLength(297);
  });

  it.each([0, 1, 100, 254, 255])("returns a %i-unit name unchanged", (n) => {
    const s = "x".repeat(n);
    expect(fitItemName(s)).toBe(s);
  });

  it.each([256, 297, 1000, 100_000])("fits a %i-unit name to exactly 255, the last unit an ellipsis", (n) => {
    const out = fitItemName("y".repeat(n));
    expect(out).toHaveLength(255);
    expect(out).toBe("y".repeat(254) + ELLIPSIS);
  });

  it("fits the live name to its first 254 characters and the ellipsis", () =>
    expect(fitItemName(FULL)).toBe(FULL.slice(0, 254) + ELLIPSIS));

  it("is idempotent: a fitted name comes back unchanged, so no second write ever differs", () => {
    for (const s of [FULL, "需".repeat(300), "a".repeat(253) + "\u{1F600}".repeat(10), "z".repeat(255)]) {
      const once = fitItemName(s);
      expect(once.length).toBeLessThanOrEqual(255);
      expect(fitItemName(once)).toBe(once);
    }
  });

  it("is deterministic", () => expect(fitItemName(FULL)).toBe(fitItemName(`${FIRST} ${LAST}`)));

  it("never keeps half of a surrogate pair at the cut", () => {
    // Units 253 and 254 are one emoji. A plain slice(0, 254) keeps its high half alone.
    const s = "a".repeat(253) + "\u{1F600}".repeat(10);
    expect(() => encodeURIComponent(s.slice(0, 254))).toThrow();       // the hazard itself
    const out = fitItemName(s);
    expect(out).toBe("a".repeat(253) + ELLIPSIS);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it("keeps a pair that ends exactly at the cut", () => {
    const s = "a".repeat(252) + "\u{1F600}" + "b".repeat(10);
    const out = fitItemName(s);
    expect(out).toBe("a".repeat(252) + "\u{1F600}" + ELLIPSIS);
    expect(out).toHaveLength(255);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it("trims whitespace the cut leaves in front of the ellipsis", () =>
    expect(fitItemName("a".repeat(250) + " ".repeat(10) + "b".repeat(10))).toBe("a".repeat(250) + ELLIPSIS));

  it("counts UTF-16 units, so a Chinese name keeps the whole allowance", () =>
    expect(fitItemName("需".repeat(300))).toBe("需".repeat(254) + ELLIPSIS));

  it("honours an explicit max", () => {
    expect(fitItemName("abcdef", 4)).toBe("abc" + ELLIPSIS);
    expect(fitItemName("abcd", 4)).toBe("abcd");
  });
});

// -------------------------------------------------------------------------------------- the switch

describe("ITEM_NAME_FIT arms only as the literal \"true\", and only on the CRM Worker", () => {
  it("on", () => expect(itemNameFitOn({ ITEM_NAME_FIT: "true", ENABLE_CRM: "true" })).toBe(true));

  it.each(["false", "TRUE", "True", "1", "yes", "", " true", undefined])("ITEM_NAME_FIT=%j is off", (v) =>
    expect(itemNameFitOn({ ITEM_NAME_FIT: v, ENABLE_CRM: "true" })).toBe(false));

  it("the WM Worker (no ENABLE_CRM) stays off even with the var leaked onto it", () => {
    expect(itemNameFitOn({ ITEM_NAME_FIT: "true" })).toBe(false);
    expect(itemNameFitOn({ ITEM_NAME_FIT: "true", ENABLE_CRM: "false" })).toBe(false);
  });

  it("is independent of HS_RATE_LIMIT_RETRY", () =>
    expect(itemNameFitOn({ ENABLE_CRM: "true", HS_RATE_LIMIT_RETRY: "true" } as never)).toBe(false));
});

// ------------------------------------------------------------------- monday.ts, the one chokepoint

const ON = { MONDAY_API_TOKEN: "tok", ENABLE_CRM: "true", ITEM_NAME_FIT: "true" } as unknown as Env;
const OFF = { MONDAY_API_TOKEN: "tok", ENABLE_CRM: "true", ITEM_NAME_FIT: "false" } as unknown as Env;
const ABSENT = { MONDAY_API_TOKEN: "tok", ENABLE_CRM: "true" } as unknown as Env;
const WM = { MONDAY_API_TOKEN: "tok", ITEM_NAME_FIT: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

const registry = vi.hoisted(() => ({ claimCard: vi.fn(), finishCard: vi.fn(), forgetCard: vi.fn() }));
vi.mock("../src/card-registry", () => registry);

/** One request as monday received it: the raw body, and its parsed query and variables. */
interface Sent { raw: string; query: string; variables: Record<string, any> }
let sent: Sent[];
let logs: string[];

/** The name a request asks monday to store, if it names one. */
function nameIn(s: Sent): string | undefined {
  if (s.query.includes("change_multiple_column_values(")) return JSON.parse(s.variables.c).name;
  return s.query.includes("create_item(") || s.query.includes("create_subitem(") ? s.variables.n : undefined;
}

beforeEach(() => {
  sent = []; logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  // monday, as far as these writes go: a name over 255 is REFUSED, exactly the live error; anything else
  // lands. A refusal carries no result, so gql throws it at once (a create is never retried).
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const raw = String(init?.body);
    const body = JSON.parse(raw);
    const s: Sent = { raw, query: body.query, variables: body.variables };
    sent.push(s);
    const name = nameIn(s);
    if (name !== undefined && name.length > 255)
      return Response.json({ errors: [{ message: "item_name is too long. Item names must be below 256 characters." }] });
    const q = s.query;
    const data = q.includes("create_item(") ? { create_item: { id: "9001" } }
      : q.includes("create_subitem(") ? { create_subitem: { id: "9002" } }
      : q.includes("change_multiple_column_values(") ? { change_multiple_column_values: { id: "9003" } }
      : q.includes("items_page_by_column_values(") ? { items_page_by_column_values: { items: [] } }
      : {};
    return Response.json({ data });
  }));
  registry.claimCard.mockReset().mockResolvedValue({ status: "proceed" });
  registry.finishCard.mockReset().mockResolvedValue(undefined);
  registry.forgetCard.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fitted = () => logs.filter(l => l.startsWith("[name] action=fitted"));

describe("switch on: every name a write sends is fitted, at monday.ts", () => {
  it("createItem sends the fitted name, says so, and monday takes it", async () => {
    await expect(createItem(ON, "5028000495", "topics", FULL, { a: 1 }, live)).resolves.toBe("9001");
    expect(sent).toHaveLength(1);
    expect(sent[0].variables.n).toBe(fitItemName(FULL));
    expect(fitted()).toEqual(["[name] action=fitted from=297 to=255 op=create board=5028000495 group=topics"]);
    expect(logs).toContain(`created '${fitItemName(FULL)}' on 5028000495/topics`);
  });

  it("createSubitem sends the fitted name", async () => {
    await expect(createSubitem(ON, "777", FULL, { a: 1 }, live)).resolves.toBe("9002");
    expect(sent[0].variables.n).toBe(fitItemName(FULL));
    expect(fitted()).toEqual(["[name] action=fitted from=297 to=255 op=create-subitem parent=777"]);
  });

  /** updateItem sends the name on EVERY forward write, which is why a long HubSpot name broke every
   *  update of its card, not only its creation. The columns beside it must be untouched. */
  it("updateItem fits the name it always sends, and leaves the columns alone", async () => {
    await updateItem(ON, "5028000494", "777", FULL, { deal_value: "5", text_x: "y" }, live);
    expect(JSON.parse(sent[0].variables.c)).toEqual({ deal_value: "5", text_x: "y", name: fitItemName(FULL) });
    expect(fitted()).toEqual(["[name] action=fitted from=297 to=255 op=update board=5028000494 item=777"]);
  });

  it("a name within the limit goes out untouched, and nothing is logged", async () => {
    await createItem(ON, "B", "G", "z".repeat(255), {}, live);
    await updateItem(ON, "B", "I", "Jane Smith", {}, live);
    await createSubitem(ON, "P", "Widget x 4", {}, live);
    expect(sent.map(nameIn)).toEqual(["z".repeat(255), "Jane Smith", "Widget x 4"]);
    expect(fitted()).toEqual([]);
  });

  it("a dry run fits too, and logs the name it would have sent", async () => {
    await createItem(ON, "B", "G", FULL, {}, { ...live, dryRun: true });
    await createSubitem(ON, "P", FULL, {}, { ...live, dryRun: true });
    expect(sent).toHaveLength(0);
    expect(logs).toContain(`DRY create '${fitItemName(FULL)}' on B/G`);
    expect(logs).toContain(`DRY create subitem '${fitItemName(FULL)}' under P`);
  });
});

describe.each([
  ["\"false\"", OFF],
  ["absent", ABSENT],
  ["\"true\" on the WM Worker (no ENABLE_CRM)", WM],
])("switch %s: byte-for-byte the request it always was -- and monday's refusal", (_label, env) => {
  it("createItem", async () => {
    const cv = { x: 1 };
    await expect(createItem(env, "B", "G", FULL, cv, live)).rejects.toThrow(/item_name is too long/);
    expect(sent).toHaveLength(1);    // a create is never retried
    expect(sent[0].raw).toBe(JSON.stringify({ query: sent[0].query,
      variables: { b: "B", g: "G", n: FULL, c: JSON.stringify(cv) } }));
    expect(fitted()).toEqual([]);
  });

  it("createSubitem", async () => {
    const cv = { x: 1 };
    await expect(createSubitem(env, "P", FULL, cv, live)).rejects.toThrow(/item_name is too long/);
    expect(sent[0].raw).toBe(JSON.stringify({ query: sent[0].query,
      variables: { p: "P", n: FULL, c: JSON.stringify(cv) } }));
  });

  it("updateItem", async () => {
    const cv = { deal_value: "5" };
    await expect(updateItem(env, "B", "I", FULL, cv, live)).rejects.toThrow(/item_name is too long/);
    expect(sent[0].raw).toBe(JSON.stringify({ query: sent[0].query,
      variables: { b: "B", i: "I", c: JSON.stringify({ ...cv, name: FULL }) } }));
  });

  it("a short name, too: the same bytes either way", async () => {
    await createItem(env, "B", "G", "Jane Smith", { x: 1 }, live);
    await createItem(ON, "B", "G", "Jane Smith", { x: 1 }, live);
    expect(sent[1].raw).toBe(sent[0].raw);
  });

  it("the dry-run log too", async () => {
    await createItem(env, "B", "G", FULL, {}, { ...live, dryRun: true });
    expect(logs).toContain(`DRY create '${FULL}' on B/G`);
  });
});

// ---------------------------------------------------- the live record, through the card's birth

describe("contact 563860620999 gets its card (ensureCardForRecord -> createItem)", () => {
  const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {},
    ownerIdByEmail: {}, portalId: 39939588 } as unknown as Ctx;

  it("switch on: the create carries the fitted name, and the card is recorded against the record", async () => {
    await expect(ensureCardForRecord(ON, CRM_CONTACTS, ctx, p3(), live))
      .resolves.toEqual({ status: "created", itemId: "9001" });
    const create = sent.find(s => s.query.includes("create_item("))!;
    expect(create.variables.n).toBe(fitItemName(FULL));
    expect(create.variables.g).toBe("topics");
    // The rest of the card is built exactly as before: the full names stay in their own text columns.
    const cv = JSON.parse(create.variables.c);
    expect(cv[CRM_CONTACTS.idCol]).toBe("563860620999");
    expect(cv[CRM_CONTACTS.fields.find(f => f.hs === "firstname")!.col]).toBe(FIRST);
    expect(cv[CRM_CONTACTS.fields.find(f => f.hs === "lastname")!.col]).toBe(LAST);
    expect(registry.finishCard).toHaveBeenCalledWith(ON, CRM_CONTACTS.boardId, "563860620999", "9001");
    expect(registry.forgetCard).not.toHaveBeenCalled();
  });

  it("switch off: today's create, refused by monday; the reservation is released for a later /resync", async () => {
    await expect(ensureCardForRecord(OFF, CRM_CONTACTS, ctx, p3(), live)).rejects.toThrow(/item_name is too long/);
    expect(sent.find(s => s.query.includes("create_item("))!.variables.n).toBe(FULL);
    expect(registry.finishCard).not.toHaveBeenCalled();
    expect(registry.forgetCard).toHaveBeenCalledWith(OFF, CRM_CONTACTS.boardId, "563860620999");
  });
});

// ---------------------------------------------------------------- comparisons, carried in Ctx

const CTX: Ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {},
  ownerIdByEmail: {}, portalId: 1 };
/** What buildCtx returns while ITEM_NAME_FIT is on (pinned in item-name-fit-engine.test.ts). */
const FIT: Ctx = { ...CTX, itemNameMax: MONDAY_ITEM_NAME_MAX };

function cardOf(spec: ObjectSpec, recId: string, name: string, cells: Record<string, string> = {}): MondayItem {
  return {
    id: "CARD", name, created_at: "2026-09-29T10:17:30Z", updated_at: MOD, group: { id: "topics" },
    column_values: [
      { id: spec.idCol, text: recId }, { id: spec.syncStateCol, text: MOD },
      ...Object.entries(cells).map(([id, text]) => ({ id, text })),
    ],
  };
}
/** The contact's card with every cell as the engine would have written it, so "in line" means no diff at
 *  all -- the name is the only thing a test varies. */
function contactCard(name: string, rec = p3()): MondayItem {
  const cells: Record<string, string> = {};
  for (const f of CRM_CONTACTS.fields) {
    const t = expectedText(f, rec.properties[f.hs], CTX);
    if (t) cells[f.col] = t;
  }
  return cardOf(CRM_CONTACTS, rec.id, name, cells);
}
const nameDiffs = (ds: Diff[]) => ds.filter(d => d.kind === "name");

describe("fieldDiffs compares the FITTED name while the switch is on", () => {
  it("a card showing the fitted name is in line: no rename, so no rename loop", () =>
    expect(fieldDiffs(p3(), contactCard(fitItemName(FULL)), CRM_CONTACTS, FIT)).toEqual([]));

  it("a card behind HubSpot gets ONE rename, to the fitted name, marked as a partial view", () =>
    expect(nameDiffs(fieldDiffs(p3(), contactCard("Old Name"), CRM_CONTACTS, FIT)))
      .toStrictEqual([{ kind: "name", hsText: fitItemName(FULL), mdText: "Old Name", viewTruncated: true }]));

  it("a name within the limit diffs exactly as before -- no viewTruncated", () => {
    const rec = p3({ firstname: "Jane", lastname: "Smith" });
    expect(nameDiffs(fieldDiffs(rec, contactCard("Old Name", rec), CRM_CONTACTS, FIT)))
      .toStrictEqual([{ kind: "name", hsText: "Jane Smith", mdText: "Old Name" }]);
  });

  it("exactly 255 is not cut", () => {
    const rec = p3({ firstname: "x".repeat(127), lastname: "y".repeat(127) });
    const name = itemName(rec, CRM_CONTACTS);
    expect(name).toHaveLength(255);
    expect(fieldDiffs(rec, contactCard(name, rec), CRM_CONTACTS, FIT)).toEqual([]);
  });

  it("switch off (no itemNameMax): the full name, exactly as before", () =>
    expect(nameDiffs(fieldDiffs(p3(), contactCard(fitItemName(FULL)), CRM_CONTACTS, CTX)))
      .toStrictEqual([{ kind: "name", hsText: FULL, mdText: fitItemName(FULL) }]));
});

const LONG_DEAL = "DKM ERP rollout - " + "第二阶段".repeat(80);    // 338 units
const deal = (dealname: string): HsRecord => ({
  id: "D1", properties: { dealname, hs_lastmodifieddate: MOD, createdate: "2026-09-29T00:00:00Z", sync_owner: "crm" },
});
const dealCard = (name: string) => cardOf(CRM_DEALS, "D1", name);

describe("buildReversePatch never writes a fitted name back (record-level path: the drawer save)", () => {
  it("a viewTruncated name diff is refused, and says why", () => {
    const card = dealCard("Renamed");
    const diffs = nameDiffs(fieldDiffs(deal(LONG_DEAL), card, CRM_DEALS, FIT));
    expect(diffs).toHaveLength(1);
    expect(diffs[0].viewTruncated).toBe(true);
    expect(buildReversePatch(diffs, card, CRM_DEALS, FIT)).toEqual({});
    expect(logs.some(l => l.includes("field=dealname type=name action=refused")
      && l.includes("monday shows only the first 255 chars of a longer HubSpot name"))).toBe(true);
  });

  it("nor the fitted name itself: a card showing it raises no name diff at all", () =>
    expect(nameDiffs(fieldDiffs(deal(LONG_DEAL), dealCard(fitItemName(LONG_DEAL)), CRM_DEALS, FIT))).toEqual([]));

  it("a name within the limit is still sent with the switch on", () => {
    const card = dealCard("Renamed");
    expect(buildReversePatch(nameDiffs(fieldDiffs(deal("Short deal"), card, CRM_DEALS, FIT)), card, CRM_DEALS, FIT))
      .toEqual({ dealname: "Renamed" });
  });

  it("switch off: the same rename is sent, exactly as before", () => {
    const card = dealCard("Renamed");
    expect(buildReversePatch(nameDiffs(fieldDiffs(deal(LONG_DEAL), card, CRM_DEALS, CTX)), card, CRM_DEALS, CTX))
      .toEqual({ dealname: "Renamed" });
  });
});

describe("columnEditPatch: a person's rename of a card whose HubSpot name is past the limit", () => {
  const rename = (hsName: string, cardName: string, ctx: Ctx) =>
    columnEditPatch(deal(hsName), dealCard(cardName), CRM_DEALS, ctx, { cols: [], name: true });

  it("the fitted name itself is no change: nothing is sent and nothing healed", () =>
    expect(rename(LONG_DEAL, fitItemName(LONG_DEAL), FIT))
      .toStrictEqual({ patch: {}, heal: [], healName: false, refusals: [] }));

  it("any other rename is refused and healed: it would replace HubSpot's whole name from a cut-down copy", () =>
    expect(rename(LONG_DEAL, "Shorter name", FIT)).toStrictEqual({ patch: {}, heal: [], healName: true,
      refusals: ["HubSpot's name is longer than monday can show; rename it in HubSpot"] }));

  it("even a rename that keeps the fitted text and drops the ellipsis", () =>
    expect(rename(LONG_DEAL, LONG_DEAL.slice(0, 254), FIT).healName).toBe(true));

  it("an emptied name keeps its own refusal", () =>
    expect(rename(LONG_DEAL, "", FIT).refusals).toEqual(["item name cannot be emptied"]));

  it("at exactly 255, HubSpot's whole name is on the card, so a rename is sent as before", () =>
    expect(rename("n".repeat(255), "Shorter name", FIT).patch).toEqual({ dealname: "Shorter name" }));

  it("a name within the limit is sent with the switch on", () =>
    expect(rename("Short deal", "Shorter name", FIT).patch).toEqual({ dealname: "Shorter name" }));

  it("switch off (no itemNameMax): sent exactly as before -- the truncated copy over HubSpot's name", () =>
    expect(rename(LONG_DEAL, fitItemName(LONG_DEAL), CTX))
      .toStrictEqual({ patch: { dealname: fitItemName(LONG_DEAL) }, heal: [], healName: false, refusals: [] }));

  it("switch off: any rename sent exactly as before", () =>
    expect(rename(LONG_DEAL, "Shorter name", CTX))
      .toStrictEqual({ patch: { dealname: "Shorter name" }, heal: [], healName: false, refusals: [] }));

  it("Contacts' name stays one-way, whatever its length", () =>
    expect(columnEditPatch(p3(), contactCard("Someone Else"), CRM_CONTACTS, FIT, { cols: [], name: true }))
      .toStrictEqual({ patch: {}, heal: [], healName: true, refusals: ["item name is one-way"] }));
});
