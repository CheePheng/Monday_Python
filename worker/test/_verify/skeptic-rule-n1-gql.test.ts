import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "../../src/types";
import { gql, MondayRateLimitedError } from "../../src/monday";

/**
 * SKEPTIC for RULE-N1, on the REAL gql (fetch stubbed): the label write follow-up-reminder.ts:324-327 sends with
 * retries=1, maxRateWaits=1. A rate-limit refusal is waited out and the mutation RE-SENT (monday.ts:55-61) --
 * `retries` does not bound that path -- so the label can land up to ~65 s after every HubSpot read of the run,
 * wherever a re-read is put before renewLock. With maxRateWaits=0 the same refusal is MondayRateLimitedError at
 * once, which the reminder already releases for the next run (follow-up-reminder.ts:329-331): never sent late.
 */

const env = { MONDAY_API_TOKEN: "t" } as unknown as Env;
const MUTATION = `mutation ($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`;
const limited = () => new Response(JSON.stringify({ error_message: "Complexity budget exhausted", errors: [{ message: "Complexity budget exhausted, reset in 14 seconds" }] }), { status: 429 });
const ok = () => new Response(JSON.stringify({ data: { change_multiple_column_values: { id: "5551" } } }), { status: 200 });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the label's own rate-limit wait (real gql)", () => {
  it("retries=1, maxRateWaits=1 (as written): refused, waited 15 s, RE-SENT -- the label lands late", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    const p = gql(env, MUTATION, { b: "1", i: "5551", c: "{}" }, 1, 1);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).resolves.toEqual({ change_multiple_column_values: { id: "5551" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maxRateWaits=0: the refusal is MondayRateLimitedError at once, nothing re-sent (the reminder releases it)", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(limited());
    vi.stubGlobal("fetch", fetch);
    await expect(gql(env, MUTATION, { b: "1", i: "5551", c: "{}" }, 1, 0)).rejects.toBeInstanceOf(MondayRateLimitedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
