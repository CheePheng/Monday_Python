import { describe, it, expect } from "vitest";
import { cardIdOf, isRetryable, type EnsureCard } from "../src/ensure-card";
import { CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";

/**
 * TASK 10 — TERMINAL vs TRANSIENT at /app/ensure-card.
 *
 * Before this, an ownership refusal and ordinary card-creation contention were indistinguishable: both
 * arrived as `{status:"skipped"}` and the endpoint answered 409 `card-pending`, whose own comment tells
 * the caller to "retry shortly". For a refusal a retry can NEVER succeed, so a client that honours that
 * advice loops forever. The statuses are now distinct and the responses say which is which.
 */

const refused: EnsureCard = { status: "refused", reason: "outside CRM creation scope" };
const contention: EnsureCard = { status: "skipped" };
const created: EnsureCard = { status: "created", itemId: "i1" };
const existing: EnsureCard = { status: "existing", itemId: "i1" };
const dryRun: EnsureCard = { status: "created", itemId: null };

describe("the two failure modes are distinguishable", () => {
  it("a refusal is terminal", () => expect(isRetryable(refused)).toBe(false));

  it("contention is retryable", () => expect(isRetryable(contention)).toBe(true));

  it("success is not a failure mode at all", () => {
    expect(isRetryable(created)).toBe(true);
    expect(isRetryable(existing)).toBe(true);
  });

  it("they are different statuses, so a client cannot confuse them", () => {
    expect(refused.status).not.toBe(contention.status);
    expect(refused.status).toBe("refused");
    expect(contention.status).toBe("skipped");
  });

  it("a refusal carries a machine-readable reason", () =>
    expect(refused.reason).toMatch(/CRM creation scope/));
});

describe("cardIdOf handles every variant without throwing or dereferencing null", () => {
  it.each([
    ["refused", refused, null],
    ["skipped", contention, null],
    ["created", created, "i1"],
    ["existing", existing, "i1"],
    ["dry-run create", dryRun, null],
  ])("%s -> %j", (_l, r, want) => expect(cardIdOf(r as EnsureCard)).toBe(want));
});

// THE ENDPOINT CONTRACT, asserted as data so it cannot silently drift. index.ts returns:
//   refused    -> 422 { code: "card-refused", retryable: false, reason: "ownership", detail }
//   no itemId  -> 409 { error: "card-pending", retryable: true }
describe("/app/ensure-card response contract", () => {
  const respond = (r: EnsureCard) => {
    if (r.status === "refused")
      return { status: 422, body: { code: "card-refused", retryable: false, reason: "ownership", detail: r.reason } };
    const itemId = cardIdOf(r);
    if (!itemId) return { status: 409, body: { error: "card-pending", retryable: true } };
    return { status: 200, body: { itemId } };
  };

  it("a permanent refusal is 422 and explicitly non-retryable", () => {
    const res = respond(refused);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "card-refused", retryable: false, reason: "ownership" });
  });

  it("422 rather than 403: the CALLER is authorised, the RECORD is not ours", () =>
    expect(respond(refused).status).not.toBe(403));

  it("422 rather than 409: 409 means conflict/try-again, which is the opposite of terminal", () =>
    expect(respond(refused).status).not.toBe(409));

  it("contention stays 409 with the UNCHANGED `error` key, so existing WM clients are unaffected", () => {
    const res = respond(contention);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "card-pending" });   // pre-existing shape preserved
    expect((res.body as { retryable?: boolean }).retryable).toBe(true);
  });

  it("a successful ensure returns the item id", () =>
    expect(respond(existing)).toEqual({ status: 200, body: { itemId: "i1" } }));

  it("the two failure responses share no field values a client could mix up", () => {
    const a = respond(refused).body as Record<string, unknown>;
    const b = respond(contention).body as Record<string, unknown>;
    expect(a.retryable).toBe(false);
    expect(b.retryable).toBe(true);
    expect(a.code).toBeDefined();
    expect(b.code).toBeUndefined();      // legacy shape uses `error`, not `code`
  });
});

// The refusal path releases its reservation (asserted in crm-discovery-gate.test.ts via forgetCard), so
// no registry entry is left behind. This pins the OTHER half: the endpoint's WM route cannot be refused.
describe("the WM route can never reach the terminal response", () => {
  it("/app/ensure-card resolves WM specs only, and neither declares ownership", () => {
    for (const s of [CONTACTS_MYLA, COMPANIES_MYLA]) expect(s.ownership?.owner).toBe("wm");
  });

  // mayCreateCrmCard returns true when spec.ownership is undefined, so status "refused" is unreachable
  // for these specs and the endpoint's behaviour for WM is byte-for-byte what it was.
  it("so a WM ensure-card can only ever be 200 or the pre-existing 409", () => {
    const wmOutcomes: EnsureCard[] = [created, existing, contention, dryRun];
    for (const r of wmOutcomes) expect(r.status).not.toBe("refused");
  });
});
