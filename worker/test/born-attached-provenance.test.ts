import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { CRM_DEALS } from "../src/config/crm";

/**
 * THE WEBHOOK HALF OF THE BIRTH PASS'S PROVENANCE.
 *
 * The birth pass (test/born-attached.test.ts) links a new record only when a PERSON's event started the
 * create. `edit.byAutomation` cannot carry that for an item-created event: it names no column, so the
 * webhook builds no `edit` for it at all, and an automation that made a row read exactly like a person
 * making it. What these pin: the webhook hands syncMondayItem who caused the event, for every event
 * shape, and resolves an automation from the same negative pseudo-user the rest of the Worker does.
 */

const actor = vi.hoisted(() => ({
  isIntegrationActor: vi.fn(async (_e: unknown, id: string) => id === "999"),
  isAutomationActor: (id: string) => /^-\d+$/.test(id),
  actorLabel: vi.fn(async () => "actor=x"),
}));
const sync = vi.hoisted(() => ({
  syncMondayItem: vi.fn(async () => "ok"), syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(),
  getCtxCached: vi.fn(),
}));
vi.mock("../src/actor-label", () => actor);
vi.mock("../src/sync", () => sync);

const { handleMonday } = await import("../src/webhooks");
const crm = { ENABLE_CRM: "true" } as unknown as Env;

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const settle = async () => { await Promise.all(waits.splice(0)); };

const fire = async (event: Record<string, unknown>) => {
  await handleMonday(new Request("https://w/webhooks/monday", { method: "POST",
    body: JSON.stringify({ event: { boardId: Number(CRM_DEALS.boardId), pulseId: 7001, ...event } }) }), crm, ectx);
  await settle();
};
/** The 8th and 9th arguments of the one syncMondayItem call: the edit and the actor. */
const lastCall = () => {
  expect(sync.syncMondayItem).toHaveBeenCalledTimes(1);
  const c = sync.syncMondayItem.mock.calls[0] as unknown[];
  return { selfOrigin: c[6], edit: c[7] as { byAutomation?: boolean } | undefined, actor: c[8] };
};

beforeEach(() => { vi.clearAllMocks(); waits.length = 0; });

describe("an item-created event, which names no column and so carries no edit", () => {
  it("by an automation (-4): the actor says so", async () => {
    await fire({ type: "create_pulse", userId: -4 });
    const c = lastCall();
    expect(c.edit).toBeUndefined();                      // the gap: nothing else could have carried it
    expect(c.actor).toEqual({ id: "-4", byAutomation: true });
    expect(c.selfOrigin).toBe(false);                   // an automation is not our own echo
  });

  it("by a person (the Create form, '+ Add'): a person", async () => {
    await fire({ type: "create_pulse", userId: 102443183 });
    expect(lastCall().actor).toEqual({ id: "102443183", byAutomation: false });
  });
});

describe("a column event", () => {
  it("by an automation: both the edit and the actor say so", async () => {
    await fire({ type: "update_column_value", columnId: "color_mm76tdww", userId: -4,
      value: { label: { index: 1 } }, previousValue: null });
    const c = lastCall();
    expect(c.edit?.byAutomation).toBe(true);
    expect(c.actor).toEqual({ id: "-4", byAutomation: true });
  });

  it("by a person: neither does", async () => {
    await fire({ type: "update_column_value", columnId: "color_mm76tdww", userId: 102443183,
      value: { label: { index: 1 } }, previousValue: null });
    const c = lastCall();
    expect(c.edit?.byAutomation).toBeUndefined();
    expect(c.actor).toEqual({ id: "102443183", byAutomation: false });
  });
});
