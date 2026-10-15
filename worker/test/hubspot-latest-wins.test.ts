import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * A SECOND HUBSPOT EVENT FOR THE SAME RECORD MUST BE ACTED ON, NOT HANDED THE FIRST ONE'S RESULT.
 *
 * Every activity logged in HubSpot produces an association event and, 2-12 s later, a
 * notes_last_updated propertyChange for the same record. `coalesce` (first wins) gave the second event
 * the first one's in-flight sync, which had already READ the record -- so the new Last Activity Date
 * was never written (delivered on 77% of Contacts, 67% of Accounts, 4 of 5 Deals, 2026-09-30).
 *
 * The fake below is a sync that does exactly what the real one does in the order that matters: read
 * HubSpot, wait (monday calls), write what it read onto the card.
 */

let hubspotLad = "";            // HubSpot's notes_last_updated right now
let cardLad = "";               // what the monday card shows
let gate: Promise<void> | null = null;
const sync = vi.hoisted(() => ({
  syncHubspotObject: vi.fn(),
  deleteHubspotObject: vi.fn(async () => "deleted"),
  syncMondayItem: vi.fn(async () => "ok"),
  getCtxCached: vi.fn(),
}));
vi.mock("../src/sync", () => sync);
vi.mock("../src/hubspot", () => ({ getAssociatedIds: vi.fn(async () => []), createNote: vi.fn() }));
vi.mock("../src/monday", () => ({ getItem: vi.fn(async () => null), getUserById: vi.fn(async () => null) }));
vi.mock("../src/activity-sync", () => ({
  ACTIVITY_BY_NAME: {}, ACTIVITY_BY_TYPEID: {}, activitySyncEnabled: () => false,
  syncHubspotActivity: vi.fn(), syncMondayTimeline: vi.fn(), resetHelperOnReassignment: vi.fn(),
}));
vi.mock("../src/deferred-sync", () => ({ spillDeferred: vi.fn() }));
vi.mock("../src/activity-retry", () => ({ scheduleDelivery: vi.fn(async () => true), scheduleIfUnresolved: vi.fn(), scheduleReconcile: vi.fn() }));

const { handleHubspot } = await import("../src/webhooks");

const crm = { ENABLE_CRM: "true" } as unknown as Env;
const wm = {} as Env;
const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const fire = (env: Env, payload: unknown) => handleHubspot(
  new Request("https://w/webhooks/hubspot", { method: "POST", body: JSON.stringify(payload) }), env, ectx);

const assocEvent = { subscriptionType: "object.associationChange", fromObjectTypeId: "0-1", fromObjectId: 501,
  toObjectTypeId: "0-46", toObjectId: 9001 };
const ladEvent = { subscriptionType: "object.propertyChange", objectTypeId: "0-1", objectId: 501,
  propertyName: "notes_last_updated", propertyValue: "1759230000000" };

beforeEach(() => {
  vi.clearAllMocks();
  waits.length = 0;
  hubspotLad = "2026-09-29"; cardLad = "2026-09-29";
  let open!: () => void;
  gate = new Promise<void>(r => { open = r; });
  (gate as any).open = open;
  sync.syncHubspotObject.mockImplementation(async () => {
    const read = hubspotLad;                 // 1. read the record
    if (gate) await gate;                    // 2. ...the monday round trips...
    cardLad = read;                          // 3. write what was read
    return "updated-monday";
  });
});
const release = () => { const g = gate as any; gate = null; g.open(); };

describe("HubSpot object events on the CRM Worker: the latest event wins", () => {
  it("the first sync reads the OLD date; the second event, mid-flight, still gets the NEW one written", async () => {
    await fire(crm, [assocEvent]);                   // the association event starts a sync
    await new Promise(r => setTimeout(r, 5));        // it has read the record by now
    hubspotLad = "2026-09-30";                       // HubSpot stamps notes_last_updated...
    await fire(crm, [ladEvent]);                     // ...and its propertyChange arrives mid-sync
    release();
    await Promise.all(waits);
    expect(cardLad).toBe("2026-09-30");
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(2);   // one run, then ONE trailing re-read
  });

  it("the first sync THROWS (a transient 429) -- the mid-flight event still re-reads and writes", async () => {
    let first = true;
    sync.syncHubspotObject.mockImplementation(async () => {
      const read = hubspotLad;
      if (gate) await gate;
      if (first) { first = false; throw new Error("HubSpot 429"); }
      cardLad = read;
      return "updated-monday";
    });
    await fire(crm, [assocEvent]);
    await new Promise(r => setTimeout(r, 5));
    hubspotLad = "2026-09-30";
    await fire(crm, [ladEvent]);                     // arrives while the doomed first run is in flight
    release();
    await Promise.all(waits);
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(2);
    expect(cardLad).toBe("2026-09-30");
  });

  it("a failure with nothing pending is not retried (one error, one log, no loop)", async () => {
    release();
    sync.syncHubspotObject.mockImplementation(async () => { throw new Error("HubSpot 500"); });
    await fire(crm, [assocEvent]);
    await Promise.all(waits);
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(1);
  });

  it("runs one sync at a time per record -- the trailing run starts after the first finishes", async () => {
    let running = 0, peak = 0;
    sync.syncHubspotObject.mockImplementation(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running--; return "ok";
    });
    await fire(crm, [assocEvent]);
    await fire(crm, [ladEvent]);
    await fire(crm, [ladEvent]);
    await Promise.all(waits);
    expect(peak).toBe(1);                              // never two at once: no duplicate-card race
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(2);   // any number mid-flight = one re-run
  });

  it("different records still run independently", async () => {
    release();
    await fire(crm, [assocEvent, { ...ladEvent, objectId: 502 }]);
    await Promise.all(waits);
    expect(sync.syncHubspotObject.mock.calls.map(c => c[2]).sort()).toEqual(["501", "502"]);
  });

  it("deletes keep first-wins: a second delete has nothing newer to read", async () => {
    let finish!: () => void;
    sync.deleteHubspotObject.mockImplementationOnce(() => new Promise<string>(r => { finish = () => r("deleted"); }));
    const del = { subscriptionType: "object.deletion", objectTypeId: "0-1", objectId: 501 };
    await fire(crm, [del]);
    await fire(crm, [del]);
    finish();
    await Promise.all(waits);
    expect(sync.deleteHubspotObject).toHaveBeenCalledTimes(1);
  });
});

describe("the Work Management Worker keeps its behaviour exactly", () => {
  it("a second event mid-flight is coalesced into the first, as before", async () => {
    await fire(wm, [{ subscriptionType: "deal.propertyChange", objectId: 7, propertyName: "dealstage" }]);
    await new Promise(r => setTimeout(r, 5));
    await fire(wm, [{ subscriptionType: "deal.propertyChange", objectId: 7, propertyName: "dealname" }]);
    release();
    await Promise.all(waits);
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(1);
  });
});
