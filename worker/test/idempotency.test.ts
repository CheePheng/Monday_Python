import { describe, it, expect } from "vitest";
import { emptyResult, decideClaim, type CreateState } from "../src/idempotency";

describe("emptyResult", () => {
  it("starts in_progress with every step false and no ids", () => {
    const r = emptyResult();
    expect(r.status).toBe("in_progress");
    expect(r.hubspotId).toBeUndefined();
    expect(r.steps).toEqual({ dedup: false, hubspot: false, monday: false, owner: false, associations: false });
  });
});

describe("decideClaim", () => {
  const now = 1_000_000;
  it("proceeds from empty when there is no prior state", () =>
    expect(decideClaim(undefined, now).status).toBe("proceed"));
  it("short-circuits a completed key and returns its result", () => {
    const done: CreateState = { status: "done", result: { ...emptyResult(), hubspotId: "9" }, updatedAt: now - 5 };
    const c = decideClaim(done, now);
    expect(c.status).toBe("done");
    expect(c.result.hubspotId).toBe("9");
  });
  it("reports a fresh in-flight key as inflight (concurrent double-submit)", () => {
    const s: CreateState = { status: "inflight", result: emptyResult(), updatedAt: now - 1000 };
    expect(decideClaim(s, now).status).toBe("inflight");
  });
  it("lets a stale in-flight key be reclaimed, carrying its partial result forward", () => {
    const partial = { ...emptyResult(), hubspotId: "42", steps: { ...emptyResult().steps, hubspot: true } };
    const s: CreateState = { status: "inflight", result: partial, updatedAt: now - 120_000 };
    const c = decideClaim(s, now);
    expect(c.status).toBe("proceed");
    expect(c.result.hubspotId).toBe("42"); // resume: don't re-create in HubSpot
  });
});
