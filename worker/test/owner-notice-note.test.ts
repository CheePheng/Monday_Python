import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";

/**
 * THE OWNER NOTICE'S DURABLE NOTE (activity-registry lastNoticedCycle / rememberNoticedCycle / recordNoticeFlag),
 * through the real registry and the real CreateIdempotency row.
 *
 * monday does not always stamp a status value with changed_at -- two cells written through the API read just
 * {"index":1} on the live board (2026-10-09) -- and the Worker writes 待通知 through the API. The time of the
 * Worker's own last flag is then the only age a standing 待通知 has (owner-notice.ts, "A FLAG'S AGE"). So the note
 * keeps that flag (`flag`: the assignment, and when) beside the last settled assignment, and:
 *   - the flag is recorded BEFORE the write (recordNoticeFlag), so a lost response, a failed settlement save or a
 *     killed run still dates it -- recorded after, with the settlement, the PREVIOUS flag's time stood in for it;
 *   - a settlement passes the flag back (rememberNoticedCycle `flag`), so one that writes nothing ("already",
 *     "baseline") no longer erases the only age a stuck flag had;
 *   - a note saved while the field was `flagged` reads as that flag; one saved before either, as no flag.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
vi.mock("../src/sync", () => ({ settleAbandonedCreate: vi.fn() }));

const { CreateIdempotency } = await import("../src/create-idempotency-do");
const { lastNoticedCycle, rememberNoticedCycle, recordNoticeFlag } = await import("../src/activity-registry");

const CONTACT = "550936454903";
const CYCLE = "1739141284|2026-10-09T08:00:00.000Z";
const NEXT = "165857269|2026-10-09T09:00:00.000Z";
const T0 = Date.parse("2026-10-09T08:00:30Z");

/** The registry's namespace: one CreateIdempotency row per name, made on first use. */
function registry() {
  const rows = new Map<string, any>();
  const row = () => {
    const map = new Map<string, any>();
    const ctx = {
      storage: {
        get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
        delete: async (k: string) => { map.delete(k); }, deleteAll: async () => { map.clear(); },
        setAlarm: async () => {}, deleteAlarm: async () => {},
      },
      blockConcurrencyWhile: async (fn: () => any) => fn(),
    };
    return new (CreateIdempotency as any)(ctx, {});
  };
  const env = {
    CREATE_IDEMPOTENCY: {
      idFromName: (k: string) => k,
      get: (k: string) => { if (!rows.has(k)) rows.set(k, row()); return rows.get(k); },
    },
  } as unknown as Env;
  /** Store a note exactly as an older Worker saved it. */
  const saveRaw = async (raw: string) => {
    await (env as any).CREATE_IDEMPOTENCY.get(`notice:owner:${CONTACT}`).rememberPermanent(raw);
  };
  return { env, saveRaw };
}
const down = { CREATE_IDEMPOTENCY: { idFromName: (k: string) => k,
  get: () => ({ getCard: async () => { throw new Error("DO down"); }, rememberPermanent: async () => { throw new Error("DO down"); } }) },
} as unknown as Env;

describe("the notice's note: the last settled assignment, and the Worker's last flag", () => {
  it("a flag's settlement is remembered with its flag", async () => {
    const { env } = registry();
    expect(await rememberNoticedCycle(env, CONTACT, CYCLE, T0, { cycle: CYCLE, at: T0 })).toBe(true);
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: T0, flag: { cycle: CYCLE, at: T0 } });
  });

  it("a settlement with no flag ever -- 'already', 'baseline', the default -- has none", async () => {
    const { env } = registry();
    expect(await rememberNoticedCycle(env, CONTACT, CYCLE, T0)).toBe(true);
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: T0 });
  });

  it("a later settlement that passes the flag back KEEPS it: a flag, then a no-write settlement, still dates the flag", async () => {
    const { env } = registry();
    await rememberNoticedCycle(env, CONTACT, CYCLE, T0, { cycle: CYCLE, at: T0 });
    const read = await lastNoticedCycle(env, CONTACT);
    await rememberNoticedCycle(env, CONTACT, NEXT, T0 + 60_000, read?.flag);
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: NEXT, at: T0 + 60_000, flag: { cycle: CYCLE, at: T0 } });
  });

  /** Recorded BEFORE the write: whatever happens after it, the flag is dated, and the settlement stays as it was. */
  it("the flag's own record keeps the settlement beside it -- or none, when nothing was settled yet", async () => {
    const { env } = registry();
    await recordNoticeFlag(env, CONTACT, null, { cycle: CYCLE, at: T0 });
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: "", at: 0, flag: { cycle: CYCLE, at: T0 } });
    await rememberNoticedCycle(env, CONTACT, CYCLE, T0 + 1_000, { cycle: CYCLE, at: T0 });
    await recordNoticeFlag(env, CONTACT, await lastNoticedCycle(env, CONTACT), { cycle: NEXT, at: T0 + 90_000 });
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: T0 + 1_000, flag: { cycle: NEXT, at: T0 + 90_000 } });
  });

  it("the flag's record FAILS LOUD (no 待通知 without it); the settlement's save fails soft", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(recordNoticeFlag(down, CONTACT, null, { cycle: CYCLE, at: T0 })).rejects.toThrow(/not recorded/);
      expect(await rememberNoticedCycle(down, CONTACT, CYCLE, T0)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("a note saved while the field was `flagged: true` reads as that flag, at its time", async () => {
    const { env, saveRaw } = registry();
    await saveRaw(JSON.stringify({ cycle: CYCLE, at: T0, flagged: true }));
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: T0, flag: { cycle: CYCLE, at: T0 } });
  });

  it("a note saved before either field ({cycle, at}) reads as NO flag", async () => {
    const { env, saveRaw } = registry();
    await saveRaw(JSON.stringify({ cycle: CYCLE, at: T0 }));
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: T0 });
  });

  it("...and so does a bare cycle, with no time at all, a `flagged` that is not exactly true, or a malformed flag", async () => {
    const { env, saveRaw } = registry();
    await saveRaw(CYCLE);
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: 0 });
    await saveRaw(JSON.stringify({ cycle: CYCLE, at: T0, flagged: "true" }));
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: T0 });
    await saveRaw(JSON.stringify({ cycle: CYCLE, at: T0, flag: { cycle: CYCLE } }));
    expect(await lastNoticedCycle(env, CONTACT)).toEqual({ cycle: CYCLE, at: T0 });
  });

  it("nothing settled yet is null; an unreadable store still THROWS (never 'nothing settled')", async () => {
    const { env } = registry();
    expect(await lastNoticedCycle(env, CONTACT)).toBeNull();
    await expect(lastNoticedCycle(down, CONTACT)).rejects.toThrow(/unreadable/);
  });
});
