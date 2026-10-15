import { describe, it, expect, vi, beforeEach } from "vitest";
import { patchRecord, createRecord, claimOwnership, OwnershipError } from "../src/hubspot";
import { authorizeCreate, NEW_RECORD_ID } from "../src/ownership";
import { DEALS } from "../src/config";
import type { ObjectSpec, OwnershipSpec, RunOpts, WriteAuth } from "../src/types";

const env = { HUBSPOT_ACCESS_TOKEN: "x" } as never;
// dryRun false + writeHubspot true, so the GUARD is the only thing that can stop a write.
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 10 };
const CUTOVER = Date.parse("2026-10-01T00:00:00Z");
const own: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: CUTOVER };
const owned: ObjectSpec = { ...DEALS, object: "contacts", ownership: own };
// NO ownership, stated explicitly. This was `{ ...DEALS }` until 2026-09-22, when every WM spec gained
// an ownership spec so it would refuse crm-stamped records — at which point the spread silently
// INHERITED ownership and this fixture stopped testing the unowned path at all. The guarantee is about
// the code path, not about which real spec happens to lack a stamp.
const plain: ObjectSpec = { ...DEALS, ownership: undefined };

const allow = (forId: string): WriteAuth => ({ allowed: true, reason: "stamped crm", forId });
const deny = (forId: string): WriteAuth => ({ allowed: false, reason: "owned by wm", forId });
const rec = (id: string, props: Record<string, string>) => ({ id, properties: props });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const mockFetch = () => globalThis.fetch as never as ReturnType<typeof vi.fn>;
const calls = () => mockFetch().mock.calls;

beforeEach(() => { vi.restoreAllMocks(); globalThis.fetch = vi.fn() as never; });

describe("patchRecord ownership guard", () => {
  it("THROWS when the spec declares ownership and no auth is supplied (fail-closed)", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, live)).rejects.toThrow(OwnershipError);
    expect(calls()).toHaveLength(0);
  });

  it("THROWS when auth denies, and issues NO http request", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, live, deny("1")))
      .rejects.toThrow(/owned by wm/);
    expect(calls()).toHaveLength(0);
  });

  it("denies loudly even in dry-run — a refusal must never look like a skip", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, { ...live, dryRun: true }, deny("1")))
      .rejects.toThrow(OwnershipError);
  });

  // An auth is bound to ONE record. A loop that computes it once and patches many is an ordinary
  // mistake; without the identity check the guard would wave every one of them through.
  it("THROWS when an ALLOW was computed for a DIFFERENT record", async () => {
    await expect(patchRecord(env, owned, "2", { firstname: "A" }, live, allow("1")))
      .rejects.toThrow(/computed for 1/);
    expect(calls()).toHaveLength(0);
  });

  it("writes when auth allows and belongs to this record", async () => {
    mockFetch().mockResolvedValue(ok({ properties: {} }));
    await patchRecord(env, owned, "1", { firstname: "A" }, live, allow("1"));
    expect(calls()).toHaveLength(1);
  });

  it("a spec WITHOUT ownership needs no auth — production path unchanged", async () => {
    mockFetch().mockResolvedValue(ok({ properties: {} }));
    await expect(patchRecord(env, plain, "1", { dealname: "A" }, live)).resolves.not.toThrow();
    expect(calls()).toHaveLength(1);
  });
});

describe("createRecord ownership guard", () => {
  it("THROWS without auth when ownership is declared", async () => {
    await expect(createRecord(env, owned, { firstname: "A" }, live)).rejects.toThrow(OwnershipError);
    expect(calls()).toHaveLength(0);
  });

  it("THROWS when auth denies", async () => {
    await expect(createRecord(env, owned, { firstname: "A" }, live, deny(NEW_RECORD_ID)))
      .rejects.toThrow(OwnershipError);
    expect(calls()).toHaveLength(0);
  });

  // A create has no record to authorize against, so an auth computed FROM a record must not pass.
  it("THROWS when handed an auth computed for an existing record", async () => {
    await expect(createRecord(env, owned, { firstname: "A" }, live, allow("123")))
      .rejects.toThrow(/computed for 123/);
    expect(calls()).toHaveLength(0);
  });

  it("accepts authorizeCreate, which is bound to the new-record id", async () => {
    mockFetch().mockResolvedValue(ok({ id: "9", properties: {} }));
    await expect(createRecord(env, owned, { firstname: "A" }, live, authorizeCreate(own)))
      .resolves.toMatchObject({ id: "9" });
  });

  it("a spec without ownership creates as before", async () => {
    mockFetch().mockResolvedValue(ok({ id: "9", properties: {} }));
    await expect(createRecord(env, plain, { dealname: "A" }, live)).resolves.toMatchObject({ id: "9" });
  });
});

describe("claimOwnership", () => {
  const claimable = rec("1", { createdate: "2026-11-01T00:00:00Z" });   // unstamped, post-cutover

  it("PATCHes exactly one property and nothing else", async () => {
    mockFetch().mockResolvedValue(ok({ properties: { hs_lastmodifieddate: "T" } }));
    await claimOwnership(env, owned, claimable, live);
    const body = JSON.parse(String((calls()[0][1] as { body: string }).body));
    expect(body.properties).toEqual({ sync_owner: "crm" });
    expect(Object.keys(body.properties)).toHaveLength(1);
  });

  it("writes nothing in dry-run", async () => {
    await claimOwnership(env, owned, claimable, { ...live, dryRun: true });
    expect(calls()).toHaveLength(0);
  });

  it("writes nothing when writeHubspot is false — Phase B blocks claims too", async () => {
    await claimOwnership(env, owned, claimable, { ...live, writeHubspot: false });
    expect(calls()).toHaveLength(0);
  });

  it("throws on a spec with no ownership (nothing to claim)", async () => {
    await expect(claimOwnership(env, plain, claimable, live)).rejects.toThrow(OwnershipError);
  });

  // ELIGIBILITY IS ASSERTED INSIDE. authorizeWrite denies both "unstamped: crm must claim" and
  // "owned by wm", so the natural wiring `if (!auth.allowed) claim()` would stamp crm onto every
  // WM-owned record. These make that impossible rather than merely discouraged.
  it("REFUSES to overwrite a wm stamp — the silent-reassignment failure mode", async () => {
    const wmOwned = rec("1", { sync_owner: "wm", createdate: "2026-11-01T00:00:00Z" });
    await expect(claimOwnership(env, owned, wmOwned, live)).rejects.toThrow(/not eligible/);
    expect(calls()).toHaveLength(0);
  });

  it("REFUSES a historical pre-cutover record — recreating it must not migrate ownership", async () => {
    const historical = rec("1", { createdate: "2024-03-01T00:00:00Z" });
    await expect(claimOwnership(env, owned, historical, live)).rejects.toThrow(/not eligible/);
    expect(calls()).toHaveLength(0);
  });

  it("REFUSES when the cutover is inert (the Phase 1 setting)", async () => {
    const inert: ObjectSpec = { ...owned, ownership: { ...own, cutoverAtMs: Number.POSITIVE_INFINITY } };
    await expect(claimOwnership(env, inert, claimable, live)).rejects.toThrow(/not eligible/);
    expect(calls()).toHaveLength(0);
  });

  it("REFUSES a record parked with an unrecognised stamp", async () => {
    const parked = rec("1", { sync_owner: "hold", createdate: "2026-11-01T00:00:00Z" });
    await expect(claimOwnership(env, owned, parked, live)).rejects.toThrow(/not eligible/);
    expect(calls()).toHaveLength(0);
  });

  it("REFUSES an already-crm-stamped record (no redundant re-claim)", async () => {
    const already = rec("1", { sync_owner: "crm", createdate: "2026-11-01T00:00:00Z" });
    await expect(claimOwnership(env, owned, already, live)).rejects.toThrow(/not eligible/);
    expect(calls()).toHaveLength(0);
  });
});
