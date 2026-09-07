import { describe, it, expect, vi, beforeEach } from "vitest";
import { patchRecord, createRecord, claimOwnership, OwnershipError } from "../src/hubspot";
import { DEALS } from "../src/config";
import type { ObjectSpec, RunOpts } from "../src/types";

const env = { HUBSPOT_ACCESS_TOKEN: "x" } as never;
// dryRun false + writeHubspot true, so the GUARD is the only thing that can stop a write.
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 10 };
const owned: ObjectSpec = {
  ...DEALS, object: "contacts",
  ownership: { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: 0 },
};
const plain: ObjectSpec = { ...DEALS };   // no ownership -> legacy production behaviour

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => { vi.restoreAllMocks(); globalThis.fetch = vi.fn() as never; });
const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;

describe("patchRecord ownership guard", () => {
  it("THROWS when the spec declares ownership and no auth is supplied (fail-closed)", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, live)).rejects.toThrow(OwnershipError);
    expect(calls()).toHaveLength(0);
  });

  it("THROWS when auth denies, and issues NO http request", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, live,
      { allowed: false, reason: "owned by wm" })).rejects.toThrow(/owned by wm/);
    expect(calls()).toHaveLength(0);
  });

  it("denies loudly even in dry-run — a refusal must never look like a skip", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, { ...live, dryRun: true },
      { allowed: false, reason: "owned by wm" })).rejects.toThrow(OwnershipError);
  });

  it("writes when auth allows", async () => {
    (globalThis.fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ properties: {} }));
    await patchRecord(env, owned, "1", { firstname: "A" }, live, { allowed: true, reason: "stamped crm" });
    expect(calls()).toHaveLength(1);
  });

  it("a spec WITHOUT ownership needs no auth — production path unchanged", async () => {
    (globalThis.fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ properties: {} }));
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
    await expect(createRecord(env, owned, { firstname: "A" }, live,
      { allowed: false, reason: "owned by wm" })).rejects.toThrow(OwnershipError);
    expect(calls()).toHaveLength(0);
  });

  it("a spec without ownership creates as before", async () => {
    (globalThis.fetch as never as ReturnType<typeof vi.fn>)
      .mockResolvedValue(ok({ id: "9", properties: {} }));
    await expect(createRecord(env, plain, { dealname: "A" }, live)).resolves.toMatchObject({ id: "9" });
  });
});

describe("claimOwnership", () => {
  it("PATCHes exactly one property and nothing else", async () => {
    (globalThis.fetch as never as ReturnType<typeof vi.fn>)
      .mockResolvedValue(ok({ properties: { hs_lastmodifieddate: "T" } }));
    await claimOwnership(env, owned, "1", live);
    const body = JSON.parse(String((calls()[0][1] as { body: string }).body));
    expect(body.properties).toEqual({ sync_owner: "crm" });
    expect(Object.keys(body.properties)).toHaveLength(1);
  });

  it("writes nothing in dry-run", async () => {
    await claimOwnership(env, owned, "1", { ...live, dryRun: true });
    expect(calls()).toHaveLength(0);
  });

  it("writes nothing when writeHubspot is false — Phase B blocks claims too", async () => {
    await claimOwnership(env, owned, "1", { ...live, writeHubspot: false });
    expect(calls()).toHaveLength(0);
  });

  it("throws on a spec with no ownership (nothing to claim)", async () => {
    await expect(claimOwnership(env, plain, "1", live)).rejects.toThrow(OwnershipError);
  });
});
