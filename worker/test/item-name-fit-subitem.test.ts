import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LINE_ITEM_SUBITEMS } from "../src/config";
import { fitItemName } from "../src/mapping";
import type { Env, MondayItem, RunOpts } from "../src/types";

/**
 * ITEM_NAME_FIT AND THE LINE-ITEM SUBITEM'S RENAME (associations.ts reverseSubitemEdit).
 *
 * The one reverse name push with NO actor filter: every subitem rename -- our own token's included -- is
 * compared with HubSpot's line-item name, and a difference is PATCHed. With the switch on, syncLineItems'
 * createSubitem / updateItem write a line-item name past monday's limit FITTED (monday.ts), so the echo of
 * our own write would differ from HubSpot's longer name, and the old comparison would PATCH the cut-down
 * copy over it. The fitted name is therefore read as the echo it is, and any other rename of such a name is
 * refused. Off -- and for a name within the limit either way -- the path is exactly as before.
 */

const mondayApi = vi.hoisted(() => ({ getItem: vi.fn() }));
const hubspotApi = vi.hoisted(() => ({ getRecord: vi.fn(), patchLineItem: vi.fn() }));
const auth = vi.hoisted(() => ({ lineItemWriteAuth: vi.fn() }));

vi.mock("../src/monday", async (orig) => ({ ...(await orig<typeof import("../src/monday")>()), ...mondayApi }));
vi.mock("../src/hubspot", async (orig) => ({ ...(await orig<typeof import("../src/hubspot")>()), ...hubspotApi }));
vi.mock("../src/write-auth", async (orig) => ({ ...(await orig<typeof import("../src/write-auth")>()), ...auth }));

const { reverseSubitemEdit } = await import("../src/associations");

const base = { LINE_ITEM_WRITE: "true", ENABLE_CRM: "true", MONDAY_API_TOKEN: "t", HUBSPOT_ACCESS_TOKEN: "x" };
const ON = { ...base, ITEM_NAME_FIT: "true" } as unknown as Env;
const OFF = { ...base } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

const LONG = "Annual maintenance & support - " + "授权许可".repeat(70);    // 311 units
const renameEvent = { type: "change_subitem_name", pulseId: "S1", parentItemId: "P1" };

const subitem = (name: string): MondayItem => ({
  id: "S1", name, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", group: { id: "g" },
  column_values: [{ id: LINE_ITEM_SUBITEMS.idCol, text: "LI1" }],
});

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  hubspotApi.patchLineItem.mockResolvedValue(true);
  auth.lineItemWriteAuth.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

async function renameTo(env: Env, subitemName: string, hsName: string) {
  mondayApi.getItem.mockResolvedValue(subitem(subitemName));
  hubspotApi.getRecord.mockResolvedValue({ id: "LI1", properties: { name: hsName } });
  await reverseSubitemEdit(env, renameEvent, live, { left: 30 });
}

describe("switch on: a line-item name past the limit is never cut down from monday", () => {
  it("the fitted name -- our own write's echo -- sends nothing", async () => {
    await renameTo(ON, fitItemName(LONG), LONG);
    expect(hubspotApi.patchLineItem).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes("action=refused-name"))).toBe(false);
  });

  it("any other rename is refused and logged: it would replace HubSpot's whole name from a cut-down copy", async () => {
    await renameTo(ON, "Maintenance 2027", LONG);
    expect(hubspotApi.patchLineItem).not.toHaveBeenCalled();
    expect(logs.some(l => l.startsWith("source=monday reverse-line-item subitem=S1 line_item=LI1 action=refused-name")
      && l.includes("311 > 255"))).toBe(true);
  });

  it("a name within the limit is renamed in HubSpot exactly as before", async () => {
    await renameTo(ON, "Maintenance 2027", "Maintenance 2026");
    expect(hubspotApi.patchLineItem).toHaveBeenCalledWith(ON, "LI1", { name: "Maintenance 2027" }, live, undefined, undefined);
  });

  it("an echo within the limit is still an echo", async () => {
    await renameTo(ON, "Maintenance 2026", "Maintenance 2026");
    expect(hubspotApi.patchLineItem).not.toHaveBeenCalled();
  });
});

describe("switch off: exactly as before", () => {
  it("the fitted copy IS pushed over HubSpot's longer name -- the hazard the switch closes", async () => {
    await renameTo(OFF, fitItemName(LONG), LONG);
    expect(hubspotApi.patchLineItem).toHaveBeenCalledWith(OFF, "LI1", { name: fitItemName(LONG) }, live, undefined, undefined);
  });

  it("an ordinary rename is pushed", async () => {
    await renameTo(OFF, "Maintenance 2027", "Maintenance 2026");
    expect(hubspotApi.patchLineItem).toHaveBeenCalledWith(OFF, "LI1", { name: "Maintenance 2027" }, live, undefined, undefined);
  });

  it("and the WM Worker never arms it, even with the var leaked (no ENABLE_CRM)", async () => {
    const wm = { LINE_ITEM_WRITE: "true", ITEM_NAME_FIT: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
    await renameTo(wm, fitItemName(LONG), LONG);
    expect(hubspotApi.patchLineItem).toHaveBeenCalledWith(wm, "LI1", { name: fitItemName(LONG) }, live, undefined, undefined);
  });
});
