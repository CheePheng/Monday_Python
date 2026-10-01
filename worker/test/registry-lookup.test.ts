import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * A diagnostic route on a production Worker is permanent attack surface until someone deletes it, so
 * the tests are mostly about what it REFUSES, and about proving no write path is reachable from it.
 */

const registry = vi.hoisted(() => ({
  lookupCardOwner: vi.fn(async () => null as string | null),
  // every mutating export of the module, so a test can assert none of them is reachable
  finishCard: vi.fn(), forgetCard: vi.fn(), forgetCardOwner: vi.fn(),
  rememberCardOwner: vi.fn(), claimCard: vi.fn(), claimHubspotForItem: vi.fn(),
}));
vi.mock("../src/card-registry", () => registry);

const { handleRegistryLookup } = await import("../src/registry-lookup");

const SECRET = "diag-secret-value";
const env = { DIAGNOSTIC_SECRET: SECRET } as unknown as Env;
const BOARD = "5028000496", CARD = "2857186946";

const post = (body: unknown, secret: string | null = SECRET) =>
  new Request("https://w.example/admin/registry-lookup", {
    method: "POST",
    headers: secret === null ? {} : { "x-diagnostic-secret": secret },
    body: JSON.stringify(body),
  });

beforeEach(() => { vi.clearAllMocks(); registry.lookupCardOwner.mockResolvedValue(null); });

describe("answering the one question it exists for", () => {
  it("reports no mapping for an orphan the registry has never seen", async () => {
    const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cardId: CARD, mappingPresent: false });
  });

  it("returns the exact HubSpot id when a mapping does exist", async () => {
    registry.lookupCardOwner.mockResolvedValue("347077025505");
    const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD }));
    expect(await r.json()).toEqual({ cardId: CARD, mappingPresent: true, hubspotId: "347077025505" });
  });

  it("echoes the card id it was asked about, so two answers cannot be confused", async () => {
    const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: "2855140556" }));
    expect((await r.json() as any).cardId).toBe("2855140556");
  });
});

describe("what it refuses", () => {
  it("rejects a missing secret", async () => {
    const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD }, null));
    expect(r.status).toBe(403);
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD }, "nope"));
    expect(r.status).toBe(403);
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();
  });

  it("rejects a secret of the right length but wrong content", async () => {
    const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD },
      "X".repeat(SECRET.length)));
    expect(r.status).toBe(403);
  });

  /** A Worker deployed without the secret must be closed, not open. */
  it("refuses everything when the Worker has no diagnostic secret configured", async () => {
    const r = await handleRegistryLookup({} as Env, post({ boardId: BOARD, cardId: CARD }));
    expect(r.status).toBe(403);
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();
  });

  it("rejects any board other than Accounts", async () => {
    for (const b of ["5028000495", "5029639440", "5028000494", ""]) {
      const r = await handleRegistryLookup(env, post({ boardId: b, cardId: CARD }));
      expect(r.status).toBe(400);
    }
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();
  });

  it("rejects a malformed card id", async () => {
    for (const c of ["", "abc", "12a", "../../etc", "2857186946; DROP", null]) {
      const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: c }));
      expect(r.status).toBe(400);
    }
    expect(registry.lookupCardOwner).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON at all", async () => {
    const r = await handleRegistryLookup(env, new Request("https://w.example/admin/registry-lookup",
      { method: "POST", headers: { "x-diagnostic-secret": SECRET }, body: "not json" }));
    expect(r.status).toBe(400);
  });
});

describe("it cannot mutate anything", () => {
  it("touches no registry write function on a successful lookup", async () => {
    registry.lookupCardOwner.mockResolvedValue("347077025505");
    await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD }));
    for (const fn of [registry.finishCard, registry.forgetCard, registry.forgetCardOwner,
                      registry.rememberCardOwner, registry.claimCard, registry.claimHubspotForItem])
      expect(fn).not.toHaveBeenCalled();
  });

  it("never returns anything beyond the three permitted fields", async () => {
    registry.lookupCardOwner.mockResolvedValue("347077025505");
    const body = await (await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD }))).json() as any;
    expect(Object.keys(body).sort()).toEqual(["cardId", "hubspotId", "mappingPresent"]);
  });

  it("does not echo the secret back in any response", async () => {
    const r = await handleRegistryLookup(env, post({ boardId: BOARD, cardId: CARD }));
    expect(JSON.stringify(await r.json())).not.toContain(SECRET);
  });
});
