# HubSpot ↔ monday CRM — Phase 1 Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-way sync of NEW HubSpot Contacts ⇄ monday CRM Contacts (`5028000495`) and HubSpot Companies ⇄ monday CRM Accounts (`5028000496`), with per-record HubSpot write ownership so it can never fight the live Work Management sync.

**Architecture:** One shared engine, two disjoint configurations. Add (a) a pure ownership module enforced **fail-closed** at the two HubSpot mutation chokepoints, (b) two CRM `ObjectSpec`s built on **real** column ids after the board schema is finalised, (c) an **additive** spec-driven adoption key. Every shared-file change is gated so that a spec without `ownership`/`adoptBy` — i.e. every production WM spec — takes the identical pre-existing code path.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Vitest, monday GraphQL 2026-07, HubSpot CRM v3/v4.

**Spec:** `docs/handoff/2026-09-07-monday-crm-sync-handoff.md` (authoritative) + `docs/phase0/2026-09-07-crm-board-schema-audit.md` (Phase 0, user-approved 2026-09-07).

**v2 changes:** board schema finalised **before** the specs are written (no placeholder column ids ever enter real config); adoption made purely additive; CRM specs gated behind `ENABLE_CRM` so a production deploy from this codebase cannot pick them up; `CRM_CUTOVER_AT_MS` inert by construction.

## Global Constraints

- **Zero modification to the deployed production WM Worker's behaviour.** Shared files may only be changed additively, and every change must be inert for specs lacking `ownership`/`adoptBy`. If a genuine architectural need to change the production path appears — **stop and explain before doing it.**
- **CRM specs must not be reachable from a production deploy.** They are gated behind `env.ENABLE_CRM === "true"`, which the production Worker does not set.
- **No historical import / backfill.** No full sweep for CRM Contacts/Accounts, ever. Enforced in code by `mayCreateCrmCard` at the card-creation chokepoint (Task 3B) — **not** by scope filters, which `includeAll: true` deliberately bypasses.
- **`sales_user` has NO role in CRM scope, and is never manufactured.** It is a WM board-routing property hardcoded into `recInScope` (`sync.ts:460`); 771 of the 2,318 Contacts created since June 2026 have none (3 of them on 2026-09-07 alone), so inheriting that filter would silently drop ~1 in 3 new Contacts. CRM specs set `includeAll: true` to bypass it; **no `createDefaults.sales_user`**, and no CRM field maps it. WM's `recInScope` behaviour is unchanged.
- **Creation source, Contacts: HubSpot only** (2026-09-07 meeting). `createFromMonday: false`; field updates stay two-way once the Contact exists. Companies unchanged.
- **Contacts + Companies/Accounts only.** No Deals, Leads, Activities, Forms, Lark, Quotes, Products, line items, Contact↔Account associations.
- **`DRY_RUN = "true"`**, **crons disabled**, **no `wrangler deploy`**, **no production webhook registration**, **no production HubSpot schema change** (the real `sync_owner` property is Phase 2).
- **`CRM_CUTOVER_AT_MS` stays inert** (`Number.POSITIVE_INFINITY`) until full → incremental → two-way testing is validated. Do not pick a date.
- **No push** without explicit approval. **No `Co-Authored-By: Claude` trailer.**
- Typecheck with `./node_modules/.bin/tsc --noEmit` — **never `npx tsc`**.
- Baseline that must not regress: **worker 433 tests, monday-app 195 tests**, both builds clean. (340 at plan time; Tasks 1-3 + the employee-count evidence test brought it to 433.)
- Invariants: never clear/overwrite HubSpot from an empty monday value · never match by name · cards only via `ensureCard`/`ensureCardForRecord` · normalize diffable fields on both sides · ownership fields `appReverse` · `reverseAssociations` additive-only · a silent `.catch(() => [])` is a defect.
- Approved Phase 0 directions: `industry` **forward-only text** · `leadsource` **forward-only** · `hs_lead_status`/`manufacturer__c`/`type` **two-way** · `partner_with` **forward-only** · Active/Inactive group sync out of scope (`singleGroup: "topics"`).

---

## How the two syncs coexist without fighting

This is the load-bearing design. **Two monday cards for the same HubSpot record are acceptable. Two systems writing that record are not.**

Ownership is decided per record, by a stamp on the record, with the cutover date only as a fallback for records neither Worker has claimed:

| HubSpot record state | WM Worker may write | CRM Worker may write | CRM may claim |
|---|---|---|---|
| `sync_owner = wm` | **yes** | no | no |
| `sync_owner = crm` | no | **yes** | no |
| unstamped, `createdate < cutover` | **yes** (the ~44k historical records) | no | no |
| unstamped, `createdate >= cutover` | no | no — claim first | **yes** |
| unstamped, `createdate` missing/unusable | no (fails closed) | no | no |

Three properties make this safe rather than merely stated:

1. **The claim is a separate operation, not a write exception.** `claimOwnership()` does not go through `patchRecord`, and its payload is exactly one property (`claimPatch`). Widening the write guard cannot widen the claim; widening the claim cannot write a business field.
2. **Enforcement is at the chokepoint and fails closed.** `patchRecord`/`createRecord` throw when a spec declares `ownership` but no `WriteAuth` was supplied. A forgotten call site is a loud error, not a silent write.
3. **No backfill of `sync_owner = wm`.** The ~44k historical records stay unstamped and are covered by the pre-cutover fallback — a mass write buys nothing and adds risk.

**Old WM Deal associations still create Contact/Company mirror cards** (`associations.ts` on-demand creation). That is expected and allowed: for a CRM-owned record, `HubSpot → WM mirror` is fine, `WM mirror → HubSpot` is refused by the ownership guard, since the guard keys on the HubSpot record's stamp regardless of which board the write came from.

**Adoption of a historical record does NOT transfer ownership.** If a rep recreates an old contact in
monday CRM and adoption-by-email finds a 2024 HubSpot record (unstamped, pre-cutover ⇒ WM-owned), the
CRM card **links** that HubSpot id — so no duplicate is created — but the record stays WM-owned:
`HubSpot → CRM` continues, `CRM → HubSpot` is refused, and **no claim is attempted**. Recreating a
record on a new board must not silently migrate ownership of history. An explicit "transfer to CRM"
process can be built later if the business wants individual records migrated.

**The cutover is ONE coordinated operation across BOTH Workers (Phase D).** The three changes below
must land together, because the ownership split depends on both sides agreeing on the same instant:

1. the **identical** finite `CRM_CUTOVER_AT` on the production WM Worker **and** the CRM Worker;
2. old Contact/Company `createFromMonday = false`;
3. CRM automatic claiming enabled.

If CRM got a finite date while WM stayed infinite, WM would still classify every new unstamped record
as pre-cutover and keep writing it, until CRM's claim landed — a window in which both Workers write.

**Cutover parsing must fail safe.** Missing, malformed, or `NaN` ⇒ `POSITIVE_INFINITY` (claiming
disabled). Note the specific trap: `Number("")` is **0**, which would make *every* record look
post-cutover and hand CRM the entire portal. An empty value must never become `0`.

**In Phase 1 none of this is live.** The CRM Worker is not deployed, has no webhooks, and
`CRM_CUTOVER_AT_MS` is infinite — so `canClaimCrmOwnership` is always false and the CRM path cannot
write anything at all. The guard is built and tested now so that it exists *before* it is needed.

---

## File Structure

| File | Responsibility | Production impact |
|---|---|---|
| `worker/src/ownership.ts` **(new)** | Pure ownership predicates. No I/O. | none (new file) |
| `worker/src/adopt.ts` **(new)** | Pure adoption-key extraction (email / domain, link-column aware). | none (new file) |
| `worker/src/config/crm.ts` **(new)** | CRM Contacts + Accounts specs, `CRM_SPECS`, cutover + create-cutoff constants. | none (gated by `ENABLE_CRM`) |
| `worker/src/types.ts` | Add `SyncOwner`, `OwnershipSpec`, `WriteAuth`, `AdoptBy`; two optional `ObjectSpec` fields. | additive types only |
| `worker/src/hubspot.ts` | `assertMayWrite` (early-returns without `ownership`), `claimOwnership`, `propertiesFor` ownership branch. | inert for WM specs |
| `worker/src/sync.ts` | Ownership gate inside `if (spec.ownership)`; **new** `if (spec.adoptBy)` adoption branch placed before the existing ones. | inert for WM specs |
| `worker/src/config.ts` | `specsFor(env)` / `specByBoard(env, id)` — CRM appended only when `ENABLE_CRM === "true"`. | WM lists unchanged |
| `worker/scripts/crm-board-schema.mjs` **(new)** | Board schema planner. `--plan` default (read-only); `--apply` approval-gated. | none |
| `worker/scripts/register-crm-webhooks.mjs` **(new)** | Idempotent monday webhook registrar. **Not run in Phase 1.** | none |
| `worker/test/*.test.ts` **(new)** | ownership · adoption · write-guard · crm-config · routing · matrix | none |

---

## Task 1: Ownership primitives (pure, no CRM column dependency)

**Files:** Create `worker/src/ownership.ts`, `worker/test/ownership.test.ts`; modify `worker/src/types.ts`.

**Interfaces:**
- Consumes: `HsRecord` from `./types`.
- Produces: `type SyncOwner = "wm" | "crm"`; `interface OwnershipSpec { prop: string; createdProp: string; owner: SyncOwner; cutoverAtMs: number }`; `interface WriteAuth { allowed: boolean; reason: string }`; `interface AdoptBy { kind: "email" | "domain"; col: string }`; `syncOwnerOf(rec, o): SyncOwner | ""`; `authorizeWrite(rec, o): WriteAuth`; `canClaimCrmOwnership(rec, o): boolean`; `claimPatch(o): Record<string, string>`; `cutoverFromEnv(raw: string | undefined): number`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/ownership.test.ts
import { describe, it, expect } from "vitest";
import { syncOwnerOf, authorizeWrite, canClaimCrmOwnership, claimPatch, cutoverFromEnv } from "../src/ownership";
import type { OwnershipSpec } from "../src/types";

const CUTOVER = Date.parse("2026-10-01T00:00:00Z");
const crm: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: CUTOVER };
const wm: OwnershipSpec = { ...crm, owner: "wm" };
const rec = (props: Record<string, string | null>) => ({ id: "1", properties: props });
const before = "2026-09-01T00:00:00Z";
const after = "2026-11-01T00:00:00Z";

describe("syncOwnerOf", () => {
  it("reads the stamp", () => expect(syncOwnerOf(rec({ sync_owner: "crm" }), crm)).toBe("crm"));
  it("trims and lowercases — the property is human-editable in HubSpot", () =>
    expect(syncOwnerOf(rec({ sync_owner: " WM " }), crm)).toBe("wm"));
  it("unstamped is empty, never a guess", () => {
    expect(syncOwnerOf(rec({}), crm)).toBe("");
    expect(syncOwnerOf(rec({ sync_owner: null }), crm)).toBe("");
    expect(syncOwnerOf(rec({ sync_owner: "  " }), crm)).toBe("");
  });
  it("an unrecognised value belongs to NEITHER owner", () =>
    expect(syncOwnerOf(rec({ sync_owner: "someone_else" }), crm)).toBe(""));
});

describe("authorizeWrite — CRM Worker", () => {
  it("allows a crm-stamped record", () =>
    expect(authorizeWrite(rec({ sync_owner: "crm" }), crm).allowed).toBe(true));
  it("REFUSES a wm-stamped record, and says why", () => {
    const a = authorizeWrite(rec({ sync_owner: "wm" }), crm);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("wm");
  });
  it("REFUSES an unstamped record even post-cutover — it must CLAIM first", () =>
    expect(authorizeWrite(rec({ createdate: after }), crm).allowed).toBe(false));
  it("REFUSES an unstamped pre-cutover record", () =>
    expect(authorizeWrite(rec({ createdate: before }), crm).allowed).toBe(false));
});

describe("authorizeWrite — WM Worker", () => {
  it("allows a wm-stamped record", () =>
    expect(authorizeWrite(rec({ sync_owner: "wm" }), wm).allowed).toBe(true));
  it("REFUSES a crm-stamped record", () =>
    expect(authorizeWrite(rec({ sync_owner: "crm" }), wm).allowed).toBe(false));
  it("allows unstamped + pre-cutover (the ~44k historical records, deliberately unstamped)", () =>
    expect(authorizeWrite(rec({ createdate: before }), wm).allowed).toBe(true));
  it("REFUSES unstamped + post-cutover (CRM's to claim)", () =>
    expect(authorizeWrite(rec({ createdate: after }), wm).allowed).toBe(false));
  it("fails CLOSED on an unusable create date", () => {
    expect(authorizeWrite(rec({ createdate: "not-a-date" }), wm).allowed).toBe(false);
    expect(authorizeWrite(rec({}), wm).allowed).toBe(false);
  });
  it("accepts an epoch-ms string, which HubSpot sometimes returns", () =>
    expect(authorizeWrite(rec({ createdate: String(Date.parse(before)) }), wm).allowed).toBe(true));
});

describe("canClaimCrmOwnership", () => {
  it("claims an unstamped post-cutover record", () =>
    expect(canClaimCrmOwnership(rec({ createdate: after }), crm)).toBe(true));
  it("never claims pre-cutover", () =>
    expect(canClaimCrmOwnership(rec({ createdate: before }), crm)).toBe(false));
  it("never re-claims an already-stamped record", () => {
    expect(canClaimCrmOwnership(rec({ sync_owner: "crm", createdate: after }), crm)).toBe(false);
    expect(canClaimCrmOwnership(rec({ sync_owner: "wm", createdate: after }), crm)).toBe(false);
  });
  it("the WM Worker never claims", () =>
    expect(canClaimCrmOwnership(rec({ createdate: after }), wm)).toBe(false));
  it("cannot claim on an unusable create date", () =>
    expect(canClaimCrmOwnership(rec({ createdate: "nope" }), crm)).toBe(false));
  it("an INFINITE cutover makes claiming impossible — the Phase 1 inert setting", () =>
    expect(canClaimCrmOwnership(rec({ createdate: after }),
      { ...crm, cutoverAtMs: Number.POSITIVE_INFINITY })).toBe(false));
});

describe("cutoverFromEnv — fails safe, never opens the floodgates", () => {
  it("a real ISO timestamp parses", () =>
    expect(cutoverFromEnv("2026-10-01T00:00:00Z")).toBe(Date.parse("2026-10-01T00:00:00Z")));
  it("undefined/missing -> INFINITY (claiming disabled)", () =>
    expect(cutoverFromEnv(undefined)).toBe(Number.POSITIVE_INFINITY));
  it('EMPTY STRING -> INFINITY, never 0. Number("") is 0, which would make EVERY record look '
     + "post-cutover and hand CRM the whole portal", () => {
    expect(cutoverFromEnv("")).toBe(Number.POSITIVE_INFINITY);
    expect(cutoverFromEnv("   ")).toBe(Number.POSITIVE_INFINITY);
  });
  it("malformed -> INFINITY", () => {
    expect(cutoverFromEnv("not-a-date")).toBe(Number.POSITIVE_INFINITY);
    expect(cutoverFromEnv("NaN")).toBe(Number.POSITIVE_INFINITY);
  });
  it("a zero or negative epoch is refused (a sentinel, not a real cutover)", () => {
    expect(cutoverFromEnv("0")).toBe(Number.POSITIVE_INFINITY);
    expect(cutoverFromEnv("-1")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("claimPatch", () => {
  it("is EXACTLY one property", () => {
    const p = claimPatch(crm);
    expect(p).toEqual({ sync_owner: "crm" });
    expect(Object.keys(p)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && ./node_modules/.bin/vitest run test/ownership.test.ts`
Expected: FAIL — `Cannot find module '../src/ownership'`

- [ ] **Step 3: Add the types**

Append to `worker/src/types.ts` (purely additive — no existing type changes shape):

```ts
/** Which sync owns WRITE access to a HubSpot record. */
export type SyncOwner = "wm" | "crm";

/** How a spec decides write ownership. `cutoverAtMs` is ONLY a fallback for unstamped records. */
export interface OwnershipSpec {
  prop: string;         // HubSpot property holding the stamp, e.g. "sync_owner"
  createdProp: string;  // create-date property (contacts + companies both use "createdate")
  owner: SyncOwner;     // which side THIS Worker is
  cutoverAtMs: number;  // CRM_CUTOVER_AT; POSITIVE_INFINITY = inert (nothing is ever post-cutover)
}

/** Result of the ownership check. `reason` is always logged, never swallowed. */
export interface WriteAuth { allowed: boolean; reason: string }

/** How a monday-originated create finds its existing HubSpot twin, so it ADOPTS instead of duplicating. */
export interface AdoptBy {
  kind: "email" | "domain";
  col: string;   // monday column id holding the key
}
```

Then add two optional fields to `interface ObjectSpec`, after `scopeAlsoLinkedProp`:

```ts
  /** Per-record HubSpot WRITE ownership. When set, EVERY HubSpot mutation for this spec must carry a
   * WriteAuth — a mutation without one throws rather than writing (see hubspot.ts assertMayWrite).
   * Absent on every production WM spec, so their code path is unchanged. */
  ownership?: OwnershipSpec;
  /** Spec-driven adoption key. Absent on production WM specs, which keep their existing
   * object-specific adoption branches untouched. */
  adoptBy?: AdoptBy;
```

- [ ] **Step 4: Write the implementation**

```ts
// worker/src/ownership.ts
import type { HsRecord, OwnershipSpec, SyncOwner, WriteAuth } from "./types";

/**
 * WRITE OWNERSHIP — the rule that keeps two two-way syncs off the same HubSpot record.
 *
 * Two monday cards for the same HubSpot record are acceptable. Two systems WRITING it are not.
 * The stamp on the record is primary; the cutover timestamp is only a fallback for records neither
 * Worker has claimed. Pure, so the rule is exhaustively testable without touching either API.
 */

/** The stamp, normalised. "" when absent, blank, or unrecognised — never a guess. */
export function syncOwnerOf(rec: HsRecord, o: OwnershipSpec): SyncOwner | "" {
  const v = String(rec.properties[o.prop] ?? "").trim().toLowerCase();
  return v === "wm" || v === "crm" ? v : "";
}

/** ms since epoch for the record's create date, or NaN when missing/unparseable. */
function createdMs(rec: HsRecord, o: OwnershipSpec): number {
  const raw = String(rec.properties[o.createdProp] ?? "").trim();
  if (!raw) return NaN;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const epoch = Number(raw);            // HubSpot sometimes returns epoch-ms as a string
  return Number.isFinite(epoch) ? epoch : NaN;
}

/**
 * May THIS Worker write this HubSpot record? Asymmetric and fail-closed:
 *  - stamped: only the named owner writes;
 *  - unstamped: WM writes only pre-cutover records (the ~44k historical ones, deliberately never
 *    backfilled with a stamp). CRM may NEVER write an unstamped record — it must claim first. That
 *    ordering is precisely what stops the claim path from decaying into a general write bypass;
 *  - an unusable create date is refused, not guessed.
 */
export function authorizeWrite(rec: HsRecord, o: OwnershipSpec): WriteAuth {
  const stamp = syncOwnerOf(rec, o);
  if (stamp) {
    return stamp === o.owner
      ? { allowed: true, reason: `stamped ${stamp}` }
      : { allowed: false, reason: `owned by ${stamp}, this worker is ${o.owner}` };
  }
  if (o.owner === "crm") return { allowed: false, reason: "unstamped: crm must claim before writing" };
  const created = createdMs(rec, o);
  if (Number.isNaN(created)) return { allowed: false, reason: `unstamped and ${o.createdProp} unusable` };
  return created < o.cutoverAtMs
    ? { allowed: true, reason: "unstamped, pre-cutover -> wm" }
    : { allowed: false, reason: "unstamped, post-cutover -> crm's to claim" };
}

/**
 * May the CRM Worker CLAIM this record? A claim is a distinct operation, not a write exception —
 * its only permitted mutation is claimPatch(). With an INFINITE cutover (the Phase 1 setting) this
 * is always false, so the CRM path cannot write anything at all until a real date is chosen.
 */
export function canClaimCrmOwnership(rec: HsRecord, o: OwnershipSpec): boolean {
  if (o.owner !== "crm") return false;      // the WM Worker never claims
  if (syncOwnerOf(rec, o)) return false;    // already owned
  const created = createdMs(rec, o);
  return !Number.isNaN(created) && created >= o.cutoverAtMs;
}

/** The ONLY payload a claim may send. Exactly one property; anything else is a bug. */
export function claimPatch(o: OwnershipSpec): Record<string, string> {
  return { [o.prop]: o.owner };
}

/**
 * Parse CRM_CUTOVER_AT from the environment, FAILING SAFE to infinity (claiming disabled).
 *
 * The specific trap this exists to close: `Number("")` is 0, so a blank env var would otherwise make
 * every record look post-cutover and hand the CRM Worker the entire portal. Missing, blank, malformed,
 * NaN, and non-positive values all disable claiming rather than enabling it everywhere.
 */
export function cutoverFromEnv(raw: string | undefined): number {
  const t = (raw ?? "").trim();
  if (!t) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(t);
  const ms = Number.isNaN(parsed) ? Number(t) : parsed;
  return Number.isFinite(ms) && ms > 0 ? ms : Number.POSITIVE_INFINITY;
}
```

- [ ] **Step 5: Run tests**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`
Expected: tsc clean; ownership tests pass; **340 baseline still green**.

- [ ] **Step 6: Commit**

```bash
git add worker/src/ownership.ts worker/test/ownership.test.ts worker/src/types.ts
git commit -m "feat(crm): pure write-ownership predicates (stamp primary, cutover fallback, claim separate)"
```

---

## Task 2: Ownership metadata always fetched from HubSpot

**Files:** Modify `worker/src/hubspot.ts` (`propertiesFor`, ~line 37); create `worker/test/ownership-fetch.test.ts`.

**Interfaces:** consumes `ObjectSpec.ownership` (Task 1); produces no new exports — `propertiesForSpec(spec)` now includes `ownership.prop` and `ownership.createdProp` when `ownership` is set.

**Why it is load-bearing:** the guard reads both properties off the fetched record. If `propertiesFor` omits them they arrive `undefined`, every record classifies as unstamped, and CRM records would be handed to the wrong Worker.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/ownership-fetch.test.ts
import { describe, it, expect } from "vitest";
import { propertiesForSpec } from "../src/hubspot";
import { DEALS, CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";
import type { ObjectSpec } from "../src/types";

describe("propertiesForSpec + ownership metadata", () => {
  const owned: ObjectSpec = {
    ...DEALS, object: "contacts",
    fields: [{ hs: "firstname", col: "c_first", type: "text" }],   // deliberately no createdate field
    ownership: { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: 0 },
  };

  it("adds both ownership properties even when no mapped field supplies them", () => {
    const p = propertiesForSpec(owned);
    expect(p).toContain("sync_owner");
    expect(p).toContain("createdate");
  });
  it("does not duplicate a property a field already maps", () => {
    const spec: ObjectSpec = { ...owned,
      fields: [{ hs: "createdate", col: "c_date", type: "date", oneWay: true }] };
    expect(propertiesForSpec(spec).filter(x => x === "createdate")).toHaveLength(1);
  });
  it("PRODUCTION specs are byte-for-byte unchanged (no ownership -> no extra properties)", () => {
    for (const spec of [DEALS, CONTACTS_MYLA, COMPANIES_MYLA])
      expect(propertiesForSpec(spec)).not.toContain("sync_owner");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && ./node_modules/.bin/vitest run test/ownership-fetch.test.ts`
Expected: FAIL — does not contain `'sync_owner'`.

- [ ] **Step 3: Implement**

Replace the body of `propertiesFor` in `worker/src/hubspot.ts`:

```ts
function propertiesFor(spec: ObjectSpec): string[] {
  const props = new Set<string>([...spec.nameProps, spec.modifiedProp]);
  for (const f of spec.fields) props.add(f.hs);
  if ("prop" in spec.groupBy) props.add(spec.groupBy.prop);
  // Ownership metadata is INFRASTRUCTURE, not a mapped field: fetched even though no monday column
  // shows it. Omitting it makes authorizeWrite read undefined and mis-classify every record.
  if (spec.ownership) { props.add(spec.ownership.prop); props.add(spec.ownership.createdProp); }
  return [...props];
}
```

- [ ] **Step 4: Run tests** — `cd worker && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`. Expected: tsc clean, all pass, production specs assert unchanged.

- [ ] **Step 5: Commit**

```bash
git add worker/src/hubspot.ts worker/test/ownership-fetch.test.ts
git commit -m "feat(crm): always fetch ownership metadata for specs that declare it"
```

---

## Task 3: Fail-closed guard at the HubSpot mutation chokepoints + claim-only path

**Files:** Modify `worker/src/hubspot.ts` (`patchRecord` ~493, `createRecord` ~505; add `assertMayWrite`, `claimOwnership`, `OwnershipError`); create `worker/test/hubspot-write-guard.test.ts`.

**Interfaces:**
- Consumes: `WriteAuth`, `claimPatch` (Task 1); `ObjectSpec.ownership` (Task 2).
- Produces: `patchRecord(env, spec, id, properties, opts, auth?: WriteAuth)`; `createRecord(env, spec, properties, opts, auth?: WriteAuth)`; `claimOwnership(env, spec, id, opts): Promise<string | null>`; `class OwnershipError extends Error`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/hubspot-write-guard.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { patchRecord, createRecord, claimOwnership, OwnershipError } from "../src/hubspot";
import { DEALS } from "../src/config";
import type { ObjectSpec, RunOpts } from "../src/types";

const env: any = { HUBSPOT_ACCESS_TOKEN: "x" };
// dryRun false + writeHubspot true, so the GUARD is the only thing that can stop a write.
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 10 };
const owned: ObjectSpec = { ...DEALS, object: "contacts",
  ownership: { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: 0 } };
const plain: ObjectSpec = { ...DEALS };

beforeEach(() => { vi.restoreAllMocks(); global.fetch = vi.fn() as any; });

describe("patchRecord guard", () => {
  it("THROWS when ownership is declared and no auth is supplied (fail-closed)", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, live)).rejects.toThrow(OwnershipError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("THROWS when auth denies, and issues NO http request", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, live,
      { allowed: false, reason: "owned by wm" })).rejects.toThrow(/owned by wm/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("denies loudly even in dry-run (a refusal must never look like a skip)", async () => {
    await expect(patchRecord(env, owned, "1", { firstname: "A" }, { ...live, dryRun: true },
      { allowed: false, reason: "owned by wm" })).rejects.toThrow(OwnershipError);
  });
  it("writes when auth allows", async () => {
    (global.fetch as any).mockResolvedValue(new Response(JSON.stringify({ properties: {} }), { status: 200 }));
    await patchRecord(env, owned, "1", { firstname: "A" }, live, { allowed: true, reason: "stamped crm" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it("a spec WITHOUT ownership needs no auth — production path unchanged", async () => {
    (global.fetch as any).mockResolvedValue(new Response(JSON.stringify({ properties: {} }), { status: 200 }));
    await expect(patchRecord(env, plain, "1", { dealname: "A" }, live)).resolves.not.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("createRecord guard", () => {
  it("THROWS without auth when ownership is declared", async () => {
    await expect(createRecord(env, owned, { firstname: "A" }, live)).rejects.toThrow(OwnershipError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("a spec without ownership creates as before", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ id: "9", properties: {} }), { status: 200 }));
    await expect(createRecord(env, plain, { dealname: "A" }, live)).resolves.toMatchObject({ id: "9" });
  });
});

describe("claimOwnership", () => {
  it("PATCHes exactly one property and nothing else", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ properties: { hs_lastmodifieddate: "T" } }), { status: 200 }));
    await claimOwnership(env, owned, "1", live);
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.properties).toEqual({ sync_owner: "crm" });
    expect(Object.keys(body.properties)).toHaveLength(1);
  });
  it("writes nothing in dry-run", async () => {
    await claimOwnership(env, owned, "1", { ...live, dryRun: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("writes nothing when writeHubspot is false — Phase B blocks claims too", async () => {
    await claimOwnership(env, owned, "1", { ...live, writeHubspot: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("throws on a spec with no ownership (nothing to claim)", async () => {
    await expect(claimOwnership(env, plain, "1", live)).rejects.toThrow(OwnershipError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `cd worker && ./node_modules/.bin/vitest run test/hubspot-write-guard.test.ts`. Expected: FAIL, `claimOwnership`/`OwnershipError` not exported.

- [ ] **Step 3: Implement**

Add to `worker/src/hubspot.ts` after the `hs()` helper:

```ts
import { claimPatch } from "./ownership";
import type { WriteAuth } from "./types";

/** A HubSpot mutation was attempted without, or against, write ownership. Never swallowed. */
export class OwnershipError extends Error {
  constructor(msg: string) { super(msg); this.name = "OwnershipError"; }
}

/**
 * Fail-closed. A spec that declares ownership may not be mutated without an explicit allow — so a
 * forgotten call site is a loud error rather than a silent write to a record another sync owns.
 * Specs without `ownership` (every production WM spec) return immediately: behaviour unchanged.
 */
function assertMayWrite(spec: ObjectSpec, id: string, auth: WriteAuth | undefined): void {
  if (!spec.ownership) return;
  if (!auth) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} requires a WriteAuth (spec declares ownership)`);
  if (!auth.allowed) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} refused: ${auth.reason}`);
}
```

Add `auth?: WriteAuth` as the last parameter of `patchRecord` and `createRecord`, and make `assertMayWrite(...)` the **first statement** of each — before the `dryRun` check, so a refusal is loud even in dry-run. Leave every other line of both functions untouched.

Then add the claim path:

```ts
/**
 * Claim CRM write ownership. The ONLY mutation permitted on an unclaimed record, with a payload of
 * exactly one property. Deliberately NOT routed through patchRecord: widening the write guard can
 * never widen this, and widening this can never write a business field.
 */
export async function claimOwnership(env: Env, spec: ObjectSpec, id: string,
    opts: RunOpts): Promise<string | null> {
  if (!spec.ownership) throw new OwnershipError(`claimOwnership on ${spec.object}: no ownership spec`);
  const properties = claimPatch(spec.ownership);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CLAIM ${spec.object}/${id}: ${JSON.stringify(properties)}`);
    return null;
  }
  const res = await hs(env, "PATCH", `/crm/v3/objects/${spec.object}/${id}`, { properties });
  console.log(`hubspot CLAIM ${spec.object}/${id} -> ${spec.ownership.owner}`);
  return res.properties?.[spec.modifiedProp] ?? null;
}
```

- [ ] **Step 4: Run the full suite** — expect tsc clean, guard tests pass, **340 baseline green** (WM specs bypass the guard).

- [ ] **Step 5: Commit**

```bash
git add worker/src/hubspot.ts worker/test/hubspot-write-guard.test.ts
git commit -m "feat(crm): fail-closed ownership guard at HubSpot chokepoints + claim-only path"
```

---

## Task 3B: CRM discovery gate at the monday card-creation chokepoint — ✅ **DONE 2026-09-07**

**Result:** `mayCreateCrmCard` in `ownership.ts`, gate wired into `ensure-card.ts` before `targetGroup`
and `createItem`. **33 gate tests + 18 enum reverse-map tests. Suite 433 → 484, tsc clean.**

### All five `ensureCardForRecord` callers, and what a refusal does to each

| # | Caller | Handling of `{status:"skipped"}` | Safe? |
|---|---|---|---|
| 1 | `sync.ts:80` `reconcileRecord` — normal HubSpot reconciliation | `if (r.status === "created")` counts, then returns. Refusal increments nothing and returns cleanly. | ✅ |
| 2 | `associations.ts:202` — association-triggered target card | `cardIdOf` → null → `if (id)` skips; `want` then filters falsy, so the relation is written **without** the denied target instead of crashing. | ✅ |
| 3 | `create-records.ts:82` — app create/adopt | `if (itemId) result.mondayItemId = itemId`, and `result.steps.monday = true` is set **unconditionally**, so no retry loop. | ✅ |
| 4 | `index.ts:517` `POST /app/ensure-card` | `if (!itemId) return 409 "card-pending"`, commented "caller should retry shortly". **Semantically wrong for a refusal** — a retry can never succeed, and an auto-retrying client would loop. **Unreachable for CRM in Phase 1**: this route hardcodes `CONTACTS_MYLA`/`COMPANIES_MYLA`, which declare no ownership, so the gate returns `true`. ⚠️ **Must return a distinct terminal status before any CRM spec is routed here — carried into Task 10.** | ⚠️ WM-only |
| 5 | `index.ts:662` — companies card import | `.catch(...)`, counts `created`/`existing`; a refusal is counted as neither. Also hardcodes `COMPANIES_MYLA` (no ownership). | ✅ |

**Proven by test, not by inspection:** zero `createItem` calls on refusal · zero `fetch` calls (the gate
is monday-side only) · `forgetCard` called so the reservation is released and the record is never wedged
as "creating" · refusal never reported as `created`/`existing` so no caller miscounts · no `itemId`
property to dereference · repeating a refusal 5× is stable with no escalation (no retry storm) · an
**adopted** pre-cutover card still resolves via both the column search and the registry, so rule 4's
forward updates keep flowing · specs without `ownership` create identically for pre-cutover,
post-cutover and missing dates.

---

## Task 3B (original specification)

**Files:** Modify `worker/src/ownership.ts`, `worker/src/ensure-card.ts`; create `worker/test/crm-discovery-gate.test.ts`.

**Interfaces:** produces `mayCreateCrmCard(rec: HsRecord, o: OwnershipSpec | undefined): boolean`.

**Why this task exists.** Task 3's guard protects the two **HubSpot** mutation chokepoints. Creating a
monday card writes to **monday**, so it never passes through them — verified by trace: nothing in
`sync.ts` → `reconcileRecord` → `ensureCardForRecord` → `createItem` reads `spec.ownership`,
`sync_owner` or `cutoverAtMs`, and none of `sync.ts`, `ensure-card.ts`, `routing.ts`, `mapping.ts`,
`card-registry.ts`, `monday.ts` imports the ownership module at all. With `includeAll: true` the only
gate on that path (`recInScope`, `sync.ts:458`) short-circuits to `true`, and `targetGroup` returns a
non-null group unconditionally for a `singleGroup` spec (`routing.ts:4`) — so an unstamped **2024**
Contact with no CRM card reaches `createItem`. `includeAll` also collapses discovery to modified-since
alone (`hubspot.ts:505`), so any historical record *edited* in the poll window is a candidate. Without
this task, `includeAll: true` breaks the no-historical-import invariant. **The two are approved
together and must ship together.**

**Why in `ensure-card.ts` and not `reconcileRecord`.** `ensureCardForRecord` documents itself as "THE
single way any path may obtain the monday card"; it has five call sites (`sync.ts:80`,
`associations.ts:202`, `create-records.ts:82`, `index.ts:517`, `index.ts:662`). Gating there covers all
five. `associations.ts:202` is the sharpest: `recInScope`'s own comment records that out-of-scope
associated records are **deliberately** carded on demand there, which is a second historical-import
door a `reconcileRecord`-only gate would leave open. This also discharges Phase 2 item P2-1 for the
creation path.

- [ ] **Step 1: Write the failing test** — `worker/test/crm-discovery-gate.test.ts`, for **contacts and companies** both:

```ts
const CUT = Date.parse("2026-10-01T00:00:00Z");
const own: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: CUT };
const r = (p: Record<string, string>) => ({ id: "1", properties: p });

it("WM specs (no ownership) are unaffected", () =>
  expect(mayCreateCrmCard(r({}), undefined)).toBe(true));
it("sync_owner=crm -> may create", () =>
  expect(mayCreateCrmCard(r({ sync_owner: "crm" }), own)).toBe(true));
it("unstamped + post-cutover -> may create (the 33% with no sales_user)", () =>
  expect(mayCreateCrmCard(r({ createdate: "2026-11-01T00:00:00Z" }), own)).toBe(true));
it("unstamped + PRE-cutover -> MUST NOT import", () =>
  expect(mayCreateCrmCard(r({ createdate: "2024-03-01T00:00:00Z" }), own)).toBe(false));
it("sync_owner=wm -> no CRM card even post-cutover", () =>
  expect(mayCreateCrmCard(r({ sync_owner: "wm", createdate: "2026-11-01T00:00:00Z" }), own)).toBe(false));
it("unrecognised stamp -> hands off", () =>
  expect(mayCreateCrmCard(r({ sync_owner: "hold", createdate: "2026-11-01T00:00:00Z" }), own)).toBe(false));
it("missing createdate -> refuse (fail-closed, not fail-open)", () =>
  expect(mayCreateCrmCard(r({}), own)).toBe(false));
it("unusable createdate -> refuse", () =>
  expect(mayCreateCrmCard(r({ createdate: "1e21" }), own)).toBe(false));
it("agrees with canClaimCrmOwnership on the unstamped case — one rule, not two", () => {
  for (const d of ["2024-03-01T00:00:00Z", "2026-11-01T00:00:00Z"])
    expect(mayCreateCrmCard(r({ createdate: d }), own))
      .toBe(canClaimCrmOwnership(r({ createdate: d }), own));
});
it("inert Phase-1 cutover (POSITIVE_INFINITY) creates nothing at all", () =>
  expect(mayCreateCrmCard(r({ createdate: "2026-11-01T00:00:00Z" }),
    { ...own, cutoverAtMs: Number.POSITIVE_INFINITY })).toBe(false));
```

plus, at the chokepoint itself (mock monday, assert **zero** `createItem` calls — a refusal must be
proven by the absence of the write, not by a return value):

```ts
it("ensureCardForRecord creates NOTHING for a pre-cutover unstamped record", async () => {
  const res = await ensureCardForRecord(env, crmSpec, ctx, r({ createdate: "2024-03-01T00:00:00Z" }), live);
  expect(res.status).toBe("skipped");
  expect(createItemCalls()).toHaveLength(0);
});
it("still creates for a post-cutover record with NO sales_user", async () => { /* status "created" */ });
it("a spec without ownership creates exactly as today — WM regression guard", async () => { /* "created" */ });
```

- [ ] **Step 2: Run it to verify it fails** — `mayCreateCrmCard` is not exported.

- [ ] **Step 3: Implement.** In `ownership.ts` (pure, reusing the existing range-bounded `toMs` and
`syncOwnerOf` — do **not** add a second date parser):

```ts
/** May the CRM path CREATE a missing monday card for this HubSpot record?
 *  Separate from authorizeWrite: that one guards HubSpot mutations, this one guards monday card birth,
 *  and the two chokepoints are on different sides of the sync. Returns true for specs without
 *  ownership so every WM path keeps its exact current behaviour. */
export function mayCreateCrmCard(rec: HsRecord, o: OwnershipSpec | undefined): boolean {
  if (!o) return true;                                    // WM specs: unchanged
  const stamp = syncOwnerOf(rec, o);
  if (stamp === "other") return false;                    // e.g. an ops "hold" -> hands off
  if (stamp === "wm") return false;                        // WM owns it -> no CRM card
  if (stamp === "crm") return true;                        // ours
  const created = toMs(rec.properties[o.createdProp]);     // unstamped: cutover decides
  return !Number.isNaN(created) && created >= o.cutoverAtMs;
}
```

and in `ensure-card.ts`, immediately **before** the `targetGroup` call and the `createItem` that follows
it (i.e. after the registry claim and the adopt-by-column-search, so an **already adopted** historical
card is still found and returned as `existing` and keeps receiving forward updates):

```ts
    // NO HISTORICAL IMPORT. Reached only when no card exists, so this decides card BIRTH, never
    // updates to an existing one. Release the reservation — refusing is a permanent decision for this
    // record, not work in flight.
    if (!mayCreateCrmCard(rec, spec.ownership)) {
      await forgetCard(env, boardId, rec.id);
      console.log(`${spec.object}/${rec.id} card creation refused — not in CRM creation scope`);
      return { status: "skipped" };
    }
```

**Fail-closed by construction:** a caller that fetches without `sync_owner`/`createdate` yields
`stamp === ""` and `createdate` `NaN` → refuse. A missing-properties bug therefore declines to create
rather than importing the portal. (`propertiesForSpec` already adds both when `ownership` is set —
Task 2, `hubspot.ts:72`.)

- [ ] **Step 4: Run the full suite** — tsc clean; the WM regression guard and the Phase 1 tripwire must both stay green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ownership.ts worker/src/ensure-card.ts worker/test/crm-discovery-gate.test.ts
git commit -m "feat(crm): no-historical-import gate at the monday card-creation chokepoint"
```

---

## Task 4: Board schema audit + dry-run plan — **STOPS FOR APPROVAL**

**Files:** Create `worker/scripts/crm-board-schema.mjs`, `worker/test/crm-board-schema.test.ts`.

**Interfaces:** produces `planBoardChanges(boards)` (pure, exported for test) → `{ creates, retypes, deletes }`; CLI `--plan` (default, read-only) / `--apply` (gated).

This task exists **before** the specs so that no placeholder column id ever enters real config.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/crm-board-schema.test.ts
import { describe, it, expect } from "vitest";
import { planBoardChanges } from "../scripts/crm-board-schema.mjs";

const contacts = { id: "5028000495", columns: [
  { id: "text_mm6s7db3", title: "Contact Owner", type: "text" },
  { id: "text_mm6sakj3", title: "Sales Users", type: "text" },
  { id: "numeric_mm6swz9c", title: "Phone Number", type: "numbers" },
  { id: "12849070_last_name", title: "Last name", type: "text" },
  { id: "text_mm6t71dj", title: "HubSpot ID", type: "text" },
  { id: "text_mm6tqwyw", title: "Lead Status", type: "text" },
  { id: "custom_mkrm9y8c", title: "Activities timeline", type: "unsupported" },
  { id: "mirror2", title: "Deals value", type: "mirror" },
]};

describe("planBoardChanges", () => {
  const plan = planBoardChanges([contacts]);

  it("CREATES people columns for owner and sales users (audit F1: they do not exist)", () => {
    expect(plan.creates.filter(c => c.type === "people").map(c => c.title))
      .toEqual(expect.arrayContaining(["Contact Owner (synced)", "Sales Users (synced)"]));
  });
  it("RETYPES Lead Status to status for the two-way enum mapping", () =>
    expect(plan.retypes.some(r => r.id === "text_mm6tqwyw" && r.to === "status")).toBe(true));
  it("KEEPS the text HubSpot ID (audit §11 — ids are matched as strings)", () =>
    expect(plan.retypes.some(r => r.id === "text_mm6t71dj")).toBe(false));
  it("proposes deleting the duplicate last name and the numbers phone column", () => {
    const del = plan.deletes.map(d => d.id);
    expect(del).toContain("12849070_last_name");
    expect(del).toContain("numeric_mm6swz9c");
  });
  it("NEVER touches mirror or unsupported columns", () => {
    const all = [...plan.creates, ...plan.retypes, ...plan.deletes].map(x => x.id ?? "");
    expect(all).not.toContain("custom_mkrm9y8c");
    expect(all).not.toContain("mirror2");
  });
  it("every delete demands an emptiness check first", () =>
    expect(plan.deletes.every(d => d.verifyEmptyFirst === true)).toBe(true));
});
```

- [ ] **Step 2: Run it to verify it fails** — module not found.

- [ ] **Step 3: Implement** `worker/scripts/crm-board-schema.mjs`: a pure `planBoardChanges(boards)` built from audit §4/§5, plus a CLI. **Default `--plan`: read-only, prints the plan, exit 0.** `--apply` must refuse without `CRM_SCHEMA_APPLY=yes`; print each mutation before issuing it; for every delete, first read that column's values across all board items and **abort the entire run** if any is non-empty; never touch `mirror`/`unsupported` columns; and print the created columns' real ids at the end.

- [ ] **Step 4: Run `--plan` against the live boards (read-only)**

Run: `cd worker && node scripts/crm-board-schema.mjs --plan`
Expected: prints creates/retypes/deletes for both boards; changes nothing; exit 0.

- [ ] **Step 5: Run tests** — tsc clean, all pass.

- [ ] **Step 6: Commit the planner**

```bash
git add worker/scripts/crm-board-schema.mjs worker/test/crm-board-schema.test.ts
git commit -m "feat(crm): board-schema planner (read-only default, emptiness-checked deletes)"
```

- [ ] **Step 7: Schema QUALITY review — not just "can it be mapped"**

The brief is to leave the boards **better**, not merely workable. Re-query both boards and judge every
relevant column on whether its type, name and configuration suit both the sync *and* everyday CRM use
by a salesperson. Improvements expected from Phase 0's findings:

| Area | Current | Recommendation |
|---|---|---|
| Contact Owner / Company Owner | text stub | proper **people** column (required for `appReverse` owner safety) |
| Sales Users | text stub | **people** column, if the field is genuinely used |
| Phone | `numeric_mm6swz9c` (numbers) | native **phone** column — numbers destroy a leading `+`/zeros |
| Job Title | free-text vs `title5` (CEO/COO/CIO) | keep the **free-text** column; leave the 3-option dropdown unmapped |
| Company domain | text stub vs `company_domain` | native **link** column, and it is the adoption key |
| Company name | competing with the item name | dedicated text property; item name **display-only** |
| Industry / Lead source | — | correct **text** representation (forward-only per audit §15) |
| HubSpot ID / Sync State | text | **keep text** (audit §11 — ids match as strings) |
| Confusing column/group names | — | rename so a salesperson understands them |
| Activities timeline, mirrors, native CRM columns | proprietary / computed | **leave alone** |

Two rules that constrain this:

- **Do not retype a column merely because another type looks tidier.** Native monday CRM columns can
  carry behaviour that is not visible through the API.
- **Empty does not mean safe to delete.** Emptiness is necessary but not sufficient; a native column
  may still be referenced by a view, automation, or CRM feature. Default to KEEP for anything native.

**Permission model — two tiers:**

| Change | Gate |
|---|---|
| Create a new column · rename a column or group | report before applying; approval checkpoint |
| Delete · retype · migrate data in an existing column | **explicit approval each time**, after showing the evidence below |

Before proposing any destructive change: re-query the board, verify the column holds no data, check
whether anything references it, state why the change is needed, and show the replacement/migration.

- [ ] **Step 8: ⛔ STOP — APPROVAL GATE 1**

Report to the user and **wait**. Do not run `--apply`. Do not begin Task 5. The report must be a
per-board table with one row per relevant column:

`current column · current type · KEEP / CHANGE / CREATE / DELETE · proposed type+name · HubSpot property · sync direction · reason`

plus, called out separately, every destructive change with its emptiness and reference evidence.

---

## Task 5: [POST-APPROVAL] Apply board changes and capture real column ids

**Files:** none in git — this task's output is the real column ids plus a short record appended to `docs/phase0/2026-09-07-crm-board-schema-audit.md`.

**Prerequisite:** explicit user approval of the Task 4 plan.

- [ ] **Step 1: Re-verify the eight demo rows are still unlinked**

Query both boards for HubSpot ID and Sync State on all 8 rows. **If any is non-empty: STOP and report — do not delete.**

- [ ] **Step 2: Apply** — `cd worker && CRM_SCHEMA_APPLY=yes node scripts/crm-board-schema.mjs --apply`

- [ ] **Step 3: Re-query both boards** and record the **real** ids of the four new people columns and any retyped columns.

- [ ] **Step 4: Append the applied change record** (date, columns created with ids, columns retyped, columns deleted with their verified-empty evidence) to the Phase 0 audit.

- [ ] **Step 5: Commit the record**

```bash
git add docs/phase0/2026-09-07-crm-board-schema-audit.md
git commit -m "docs(crm): record applied board schema changes and the resulting column ids"
```

---

## Task 6: CRM Contacts ObjectSpec (real column ids)

**Files:** Create `worker/src/config/crm.ts`, `worker/test/crm-config.test.ts`.

**Interfaces:** produces `CRM_CUTOVER_AT_MS`, `CRM_CREATE_CUTOFF_MS`, `CRM_CONTACTS: ObjectSpec`.

**Prerequisite:** Task 5 complete (**done 2026-09-07**) — every column id below is a real id from the live board. **No placeholders.**

> **⛔ HARD SEQUENCING GATE.** **Task 3B (`mayCreateCrmCard`) must be implemented and green BEFORE this
> task creates a spec carrying `includeAll: true`.** There must never be an intermediate state where a
> runtime-selectable CRM spec sets `includeAll: true` while the card-creation chokepoint is unguarded —
> that configuration gradually imports the historical portal. Tests must prove the gate covers both
> normal reconciliation (`sync.ts:80`) and association-triggered creation (`associations.ts:202`).
> Actual execution order: Tasks 1-3 → **Task 4** → **Task 5** → **Task 3B** → Tasks 6-7 → 8-11.

**Live column ids captured from Task 5 (board `5028000495`, 27 columns, group `topics` = "Active Contacts"):**

| Purpose | Column id | Type |
|---|---|---|
| HubSpot ID (`idCol`) | `text_mm6t71dj` | text |
| Sync State (`syncStateCol`) | `text_mm6twy4w` | text |
| HubSpot Link (`linkCol`) | **`link_mm6z7mj`** | link |
| `hubspot_owner_id` (`appReverse`) | `multiple_person_mm6zap53` | people |
| `hs_lead_status` (two-way) | **`color_mm6zb4tc`** | status, 8 labels seeded |
| `createdate` (one-way) | **`date_mm6z33nk`** | date |
| `email` (adoption key, unused in Phase 1) | `contact_email` | email |
| `phone` | `contact_phone` | phone |
| `jobtitle` | `text_mm6szy4q` | text |
| `company` (forward-only) | `text_mm6sdvkq` | text |
| `leadsource` (forward-only) | `text_mm6sc26t` | text |
| `firstname` / `lastname` | `text_mm6sab4c` / `text_mm6snp6r` | text |

**Deliberately unmapped:** `text_mm6s40ew` (Vendors — DEFER, see the note in Task 7), `text_mm6sakj3`
(Sales Users — DEFER, and `sales_user` is irrelevant to CRM), `text_mm6t8bxb` (Event Name — business
call), `text_mm6tmzgq` (Last Activity Date — reserved for R-1), `title5` / `status` / `status5` /
`long_text4` / `mirror2` / `contact_account` / `contact_deal` (native monday CRM functionality).

- [ ] **Step 1: Write the failing test** — assert board/id/sync-state columns; `modifiedProp === "lastmodifieddate"` (**not** `hs_lastmodifieddate`); `ownership.owner === "crm"`; `propertiesForSpec` contains `sync_owner` + `createdate`; `includeAll === true`; **`createFromMonday === false`**, **`adoptBy` undefined**, **`createDefaults` undefined** (see the creation-source note below); `skipFullReconcile === true`; `groupBy === { singleGroup: "topics" }`; phone maps to `contact_phone` and **no field maps `numeric_mm6swz9c`**; `hubspot_owner_id` has `appReverse: true` and **no** `reverse`; `hs_lead_status`/`manufacturer__c` have `reverse: true` while `leadsource`/`company` do not; `nameProps === ["firstname","lastname"]` with **`nameReverse` undefined**; and `CRM_CUTOVER_AT_MS === Number.POSITIVE_INFINITY` (inert). Plus: **no field maps `sales_user`**, and `recInScope(CRM_CONTACTS, rec)` is `true` for a record with no `sales_user`.

> **CREATION SOURCE — HubSpot only (business decision, 2026-09-07 meeting).** Desmond stated, and the
> meeting confirmed, that new Contacts are created **in HubSpot**. So `createFromMonday: false`: a new
> HubSpot Contact after cutover creates the monday card, approved fields still sync **two-way** once the
> Contact exists, and a row typed directly into the monday board creates **nothing** in HubSpot.
> `sync.ts:576` already returns `reason="board not create-enabled"` for this, so no engine change is
> needed. Consequences: `adoptBy` (adoption by normalized email) exists **only** to serve the
> monday→HubSpot create path, so it is dropped from this spec — the engine capability stays for Accounts.
> `createDefaults` is dropped entirely; in particular **no `createDefaults.sales_user`** — `sales_user` is
> not a required business property (771 of 2,318 Contacts created since June 2026 have none) and must
> never be manufactured to satisfy a filter. Companies are **unchanged** — the meeting established no new
> Company creation rule.

- [ ] **Step 2: Run it to verify it fails** — module not found.

- [ ] **Step 3: Implement** `worker/src/config/crm.ts` with the two constants and `CRM_CONTACTS`, using the audit §9 mapping and the real people-column ids from Task 5:

```ts
/** Records created at/after this belong to the CRM sync.
 *  INERT IN PHASE 1: POSITIVE_INFINITY means nothing is ever post-cutover, so canClaimCrmOwnership is
 *  always false and the CRM path cannot claim or write anything. Set a real timestamp only at Phase D,
 *  after full -> incremental -> two-way validation. */
export const CRM_CUTOVER_AT_MS = Number.POSITIVE_INFINITY;

/** monday CRM cards created BEFORE this never create a HubSpot record. Second guard, kept even after
 *  the demo rows are deleted: those rows have no HubSpot id, so without this they would be pushed into
 *  the production portal the moment createFromMonday is enabled. Set at Phase D alongside the cutover. */
export const CRM_CREATE_CUTOFF_MS = Number.POSITIVE_INFINITY;
```

- [ ] **Step 4: Run tests** — tsc clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/config/crm.ts worker/test/crm-config.test.ts
git commit -m "feat(crm): CRM Contacts ObjectSpec on real column ids"
```

---

## Task 7: CRM Accounts ObjectSpec (real column ids)

**Files:** Modify `worker/src/config/crm.ts`, `worker/test/crm-config.test.ts`.

**Interfaces:** produces `CRM_ACCOUNTS: ObjectSpec`, `CRM_SPECS: ObjectSpec[]`.

- [ ] **Step 1: Write the failing test** — assert board `5028000496`, `idCol text_mm6tsnwx`, `syncStateCol text_mm6tccd0`, `linkCol link_mm6zyad8`, `groupBy { singleGroup: "topics" }`; `modifiedProp === "hs_lastmodifieddate"`; `includeAll === true`; `adoptBy === { kind: "domain", col: "company_domain" }` and **not** the name column `text_mm6t1q4h`; `industry` is `type: "text"` mapped to **`text_mm6tafj5`** with **no** `reverse` and **no field maps the native `industry` dropdown** (audit F9 — see the taxonomy note below); `partner_with` forward-only on **`dropdown_mm6zd1ge`** with `type: "dropdown"`, `type` two-way on **`color_mm6zwhwt`**; `numberofemployees` maps to the **native `employee_count`** as `type: "text"` with **no `reverse`** and **no field maps a second employee-count column**; `hubspot_owner_id` `appReverse` on `multiple_person_mm6z8mwy`; `nameReverse` undefined; `skipFullReconcile` true; **no field maps `sales_user`**. Plus `CRM_SPECS` covers exactly `["companies","contacts"]`, all declare crm ownership, none carry associations.

**Live column ids captured from Task 5 (board `5028000496`, 27 columns, group `topics` = "Companies"):**

| Purpose | Column id | Type |
|---|---|---|
| HubSpot ID (`idCol`) | `text_mm6tsnwx` | text |
| Sync State (`syncStateCol`) | `text_mm6tccd0` | text |
| HubSpot Link (`linkCol`) | **`link_mm6zyad8`** | link |
| `hubspot_owner_id` (`appReverse`) | `multiple_person_mm6z8mwy` | people |
| `industry` (**forward-only text**) | `text_mm6tafj5` "Industry (HubSpot)" | text |
| `type` (two-way) | **`color_mm6zwhwt`** | status, 16 labels seeded |
| `partner_with` (forward-only) | **`dropdown_mm6zd1ge`** | **dropdown**, 27 labels seeded, `limit_select` |
| `annualrevenue` | **`numeric_mm6zj731`** | numbers |
| `linkedin_company_page` | **`link_mm6z41s3`** | link |
| `createdate` (one-way) | **`date_mm6zmtf8`** | date |
| `numberofemployees` (**one-way**, native col) | `employee_count` | text |
| `name` | `text_mm6t1q4h` | text |
| `domain` (adoption key) | `company_domain` | link |
| `city` / `state` / `zip` / `timezone` | `text_mm6tdrdn` / `text_mm6t5tv` / `text_mm6t7ha4` / `text_mm6tys5f` | text |
| `description` | `company_description` | long_text |

> **`partner_with` is a DROPDOWN, not a status — forced by a platform limit.** monday `status` columns
> reject 27 labels with a bare `500` (probed: 16 ✅, 20/24/26/27 ❌); `create_dropdown_column` accepted
> all 27. It is also the safer type — `reverseFieldValue`'s dropdown branch validates each label against
> the inverted dict and **stops on an unknown label** (`reconcile.ts:137-138`), where the status/text
> branch falls through raw (`rev[text] ?? text`, `reconcile.ts:144`).

> **`manufacturer__c` / Vendors (Contacts `text_mm6s40ew`) stays DEFER and must NOT go two-way yet.**
> 89 HubSpot enum options against an unconstrained monday **text** column, and the text reverse branch
> does not validate — so a rep's typo would be PATCHed straight into a HubSpot enumeration and 400 on
> every tick. Before it becomes two-way it must be a `dropdown` (or `status` if the option list is first
> reduced under ~19) whose labels are seeded from the exact HubSpot option list, so `reverseFieldValue`
> can validate against the dict. The same reasoning is why `hs_lead_status` (8) and company `type` (16)
> were seeded with their exact HubSpot labels at creation.

> **EMPLOYEE COUNT — reuse the native column, forward-only (verified 2026-09-07).**
> `worker/test/employee-count-roundtrip.test.ts` exercises the real mapper: `formatValue` emits the
> **identical** bare string for a `text` and a `numbers` column, and `fieldDiffs` raises no diff once the
> native text column holds HubSpot's own value — so the forward direction round-trips cleanly through
> native `employee_count` and needs no second column. The **reverse** direction is what fails:
> `reverseFieldValue` passes free text straight through (`"approx 500"`, `"500-1000"`, `"1,500"` all
> verified), and HubSpot `numberofemployees` is `type: number`, so each would 400 on every tick — a
> monday *text* column has no numeric validation to stop it. Therefore: **map it one-way**, keep the
> native column, and delete the empty `text_mm6t68sz` duplicate. If two-way employee count is ever
> required, that is the point at which a dedicated numeric column becomes necessary — not before.

- [ ] **Step 2: Run it to verify it fails** — `CRM_ACCOUNTS` not exported.

- [ ] **Step 3: Implement** per audit §9 with real ids, including:

```ts
    // industry is FORWARD-ONLY into a TEXT column, and the board's native `industry` DROPDOWN stays
    // UNMAPPED. Verified against the live portal 2026-09-07: HubSpot company `industry` is an
    // enumeration carrying ~250 options — LinkedIn-style English values, a parallel Chinese taxonomy,
    // and heavy near-duplication ("金融业"/"金融"/"金融服务业"/"FINANCIAL_SERVICES"). monday's native
    // dropdown is a 47-option Crunchbase-style list and only 8 labels match (audit F9).
    //   - Forward-only does NOT fix a vocabulary mismatch: HubSpot "COMPUTER_SOFTWARE" is not monday's
    //     "Software", so writing into the dropdown either fails or needs create_labels_if_missing.
    //   - create_labels_if_missing is FORBIDDEN here: it would pour HubSpot's ~250-value taxonomy into
    //     monday's native vocabulary and permanently contaminate a column the CRM board relies on.
    // So the existing empty custom stub carries it instead, renamed "Industry (HubSpot)" so a rep can
    // see which column is which. Native dropdown keeps working for monday-side use. Approved 2026-09-07.
    { hs: "industry", col: "text_mm6tafj5", type: "text" },
```

- [ ] **Step 4: Run tests.** - [ ] **Step 5: Commit** `feat(crm): CRM Accounts ObjectSpec (domain adoption, industry forward-only per audit F9)`

---

## Task 8: Additive spec-driven adoption key (**zero change to the WM path**)

**Files:** Create `worker/src/adopt.ts`, `worker/test/adopt.test.ts`; modify `worker/src/sync.ts` (adoption block ~230-253, additively).

**Interfaces:** produces `adoptionKey(item: MondayItem, spec: ObjectSpec): string` — normalized email or domain, `""` when unusable.

**Why additive:** `sync.ts:245` calls `searchCompanyByDomain(env, item.name)` because the WM company board's item name *is* the domain. CRM Accounts' item name is a display name, so reusing that would adopt on a company **name** — the "never match by name" violation the spec forbids. Rather than refactor a live production path, a **new branch** handles specs that declare `adoptBy`; the existing `spec.object === "contacts"/"companies"` branches are left byte-for-byte untouched and WM specs get no `adoptBy`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/adopt.test.ts
import { describe, it, expect } from "vitest";
import { adoptionKey } from "../src/adopt";
import { authorizeWrite, canClaimCrmOwnership } from "../src/ownership";
import { DEALS, CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";
import type { MondayItem, ObjectSpec } from "../src/types";

const item = (cols: { id: string; text: string | null; value?: string | null }[], name = "Display Co"): MondayItem =>
  ({ id: "i1", name, created_at: "", updated_at: "", group: { id: "g" }, column_values: cols as any });
const emailSpec: ObjectSpec = { ...DEALS, object: "contacts", adoptBy: { kind: "email", col: "c_email" } };
const domainSpec: ObjectSpec = { ...DEALS, object: "companies", adoptBy: { kind: "domain", col: "c_domain" } };

describe("adoptionKey — email", () => {
  it("lowercases and trims", () =>
    expect(adoptionKey(item([{ id: "c_email", text: "  JO@X.COM " }]), emailSpec)).toBe("jo@x.com"));
  it("blank is unusable", () =>
    expect(adoptionKey(item([{ id: "c_email", text: "   " }]), emailSpec)).toBe(""));
  it("a non-email is unusable — never adopt on arbitrary text", () =>
    expect(adoptionKey(item([{ id: "c_email", text: "not-an-email" }]), emailSpec)).toBe(""));
});

describe("adoptionKey — domain", () => {
  it("normalizes a bare domain", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "Acme.COM" }]), domainSpec)).toBe("acme.com"));
  it("reads a LINK column's url from value JSON when text is empty", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "",
      value: JSON.stringify({ url: "https://acme.com/about", text: "" }) }]), domainSpec)).toBe("acme.com"));
  it("prefers the url over display text (text is often a human label)", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "Acme Corporate Site",
      value: JSON.stringify({ url: "https://acme.com" }) }]), domainSpec)).toBe("acme.com"));
  it("NEVER falls back to the item name", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "" }], "Acme Sdn Bhd"), domainSpec)).toBe(""));
  it("malformed value JSON degrades to text, never throws", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "acme.com", value: "{oops" }]), domainSpec)).toBe("acme.com"));
});

// ADOPTION MUST NOT TRANSFER OWNERSHIP. A rep recreating an old contact on the CRM board links the
// existing HubSpot record (so no duplicate) but must NOT take ownership of history.
describe("adopting a historical WM-owned record", () => {
  const crmOwn = { prop: "sync_owner", createdProp: "createdate", owner: "crm" as const,
    cutoverAtMs: Date.parse("2026-10-01T00:00:00Z") };
  const historical = { id: "old1", properties: { createdate: "2024-03-01T00:00:00Z" } }; // unstamped, pre-cutover

  it("is NOT claimable — recreating a record must not migrate ownership", () =>
    expect(canClaimCrmOwnership(historical, crmOwn)).toBe(false));
  it("is NOT writable by CRM — reverse writes stay blocked", () =>
    expect(authorizeWrite(historical, crmOwn).allowed).toBe(false));
  it("stays writable by WM, which still owns it", () =>
    expect(authorizeWrite(historical, { ...crmOwn, owner: "wm" }).allowed).toBe(true));
  it("the same holds for a company adopted by domain", () => {
    const oldCo = { id: "oldco", properties: { createdate: "2023-01-01T00:00:00Z" } };
    expect(canClaimCrmOwnership(oldCo, crmOwn)).toBe(false);
    expect(authorizeWrite(oldCo, crmOwn).allowed).toBe(false);
  });
});

describe("production WM specs are untouched by this mechanism", () => {
  it("neither WM spec declares adoptBy, so both keep their existing adoption branch", () => {
    expect(CONTACTS_MYLA.adoptBy).toBeUndefined();
    expect(COMPANIES_MYLA.adoptBy).toBeUndefined();
  });
  it("a spec without adoptBy yields no key", () =>
    expect(adoptionKey(item([{ id: "c_domain", text: "acme.com" }]), DEALS)).toBe(""));
});
```

- [ ] **Step 2: Run it to verify it fails** — module not found.

- [ ] **Step 3: Implement `worker/src/adopt.ts`**

```ts
import type { MondayItem, ObjectSpec } from "./types";
import { normalizeDomain } from "./normalize";

/**
 * The key a monday-originated create uses to ADOPT an existing HubSpot record instead of duplicating.
 *
 * Spec-driven on purpose: the WM company board's item NAME is its domain, but the CRM Accounts board's
 * item name is a display name with the domain in a link column. Adopting on a display name would break
 * "never match records by name" — "ABC Trading", "ABC Trading Sdn Bhd" and "ABC Trading Malaysia" are
 * different companies. Returns "" when there is no usable key, which callers MUST treat as "do not create".
 */
export function adoptionKey(item: MondayItem, spec: ObjectSpec): string {
  const a = spec.adoptBy;
  if (!a) return "";
  const cv = item.column_values.find(c => c.id === a.col);
  const text = (cv?.text ?? "").trim();

  if (a.kind === "email") {
    const e = text.toLowerCase();
    return e.includes("@") ? e : "";
  }

  // A monday LINK column keeps the address in its value JSON; `text` is a human label that may be
  // empty or may read "Acme Corporate Site". Prefer the url, fall back to text, never the item name.
  let raw = text;
  const json = (cv as { value?: string | null } | undefined)?.value;
  if (json) {
    try {
      const url = String((JSON.parse(json) as { url?: unknown }).url ?? "").trim();
      if (url) raw = url;
    } catch { /* malformed value JSON: keep the text fallback */ }
  }
  return normalizeDomain(raw) || "";
}
```

- [ ] **Step 4: Add the new branch to `createFromMonday`, above the existing ones**

In `worker/src/sync.ts`, insert immediately **before** the existing `if (spec.object === "contacts") {` block. Do not modify that block or the `companies` block below it, and do not change the function signature:

```ts
  // CRM specs declare their adoption key. Added as a SEPARATE branch so the production WM adoption
  // paths below stay byte-for-byte unchanged (they have no adoptBy and never enter here).
  if (spec.adoptBy) {
    const key = adoptionKey(item, spec);
    if (!key) {
      stats.skipped++;
      await forgetHubspotForItem(env, spec.boardId, item.id);
      console.log(`${spec.object} card ${item.id} action=skip-create reason=needs_${spec.adoptBy.kind}`);
      return;
    }
    const adopt = spec.adoptBy.kind === "email"
      ? await searchContactByEmail(env, key)
      : await searchCompanyByDomain(env, key);
    if (adopt) {
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: adopt.id, [spec.syncStateCol]: adopt.modified, ...linkValue(spec, ctx, adopt.id) }, opts);
      await finishHubspotForItem(env, spec.boardId, item.id, adopt.id);
      stats.adopted++; budget.left--;
      return;
    }
  } else if (spec.object === "contacts") {
    // ...existing WM block, unchanged...
```

Add `import { adoptionKey } from "./adopt";` to the sync.ts imports.

- [ ] **Step 4b: Birth ownership — a genuinely NEW HubSpot record is created CRM-owned**

A record created from monday CRM has no HubSpot twin, so there is nothing to claim. Born unstamped it
would be stranded: the CRM Worker's own guard refuses to write an unstamped record. So ownership is set
**atomically in the create payload**. This is birth ownership, categorically different from a claim:

| | Existing HubSpot record | Brand-new record created from CRM |
|---|---|---|
| operation | `claimOwnership()` | `createRecord()` |
| payload | **only** `sync_owner` | full create properties **+** `sync_owner` |
| precondition | unstamped **and** post-cutover | none — it does not exist yet |

Add to `worker/src/ownership.ts`:

```ts
/**
 * Stamp ownership into a CREATE payload. A record created by this Worker is owned by it from birth —
 * there is no prior record to claim, and leaving it unstamped would strand it behind our own write
 * guard. Distinct from claimPatch(), which may only ever touch the ownership property of an EXISTING
 * record. Returns the properties unchanged for specs without ownership.
 */
export function withBirthOwnership(
  properties: Record<string, string>, o: OwnershipSpec | undefined,
): Record<string, string> {
  return o ? { ...properties, ...claimPatch(o) } : properties;
}
```

and in `createFromMonday`, wrap the create properties:

```ts
  const props = withBirthOwnership(buildCreateProperties(item, spec, ctx), spec.ownership);
```

Tests (append to `worker/test/ownership.test.ts`):

```ts
describe("withBirthOwnership", () => {
  it("stamps a CRM create payload alongside the business fields", () =>
    expect(withBirthOwnership({ firstname: "Jo", email: "jo@x.com" }, crm))
      .toEqual({ firstname: "Jo", email: "jo@x.com", sync_owner: "crm" }));
  it("leaves a spec WITHOUT ownership untouched (production create path unchanged)", () =>
    expect(withBirthOwnership({ dealname: "D" }, undefined)).toEqual({ dealname: "D" }));
  it("a birth stamp is NOT a claim — claimPatch stays single-property", () => {
    expect(Object.keys(withBirthOwnership({ a: "1", b: "2" }, crm))).toHaveLength(3);
    expect(Object.keys(claimPatch(crm))).toHaveLength(1);
  });
  it("does not mutate the caller's object", () => {
    const src = { firstname: "Jo" };
    withBirthOwnership(src, crm);
    expect(src).toEqual({ firstname: "Jo" });
  });
});
```

- [ ] **Step 5: Run the full suite** — expect tsc clean; adoption tests pass; **the existing sync.test.ts contact/company create-and-adopt tests still pass**, which is the regression signal that the WM path is untouched.

- [ ] **Step 6: Commit**

```bash
git add worker/src/adopt.ts worker/test/adopt.test.ts worker/src/sync.ts
git commit -m "feat(crm): additive spec-driven adoption key (link-column aware); WM path unchanged"
```

---

## Task 9: Claim-then-write gate in `reconcileRecord`

**Files:** Modify `worker/src/sync.ts` (`reconcileRecord`, after `lastSynced`); create `worker/test/crm-ownership-flow.test.ts`.

**Interfaces:** consumes `authorizeWrite`/`canClaimCrmOwnership` (Task 1), `claimOwnership`/`patchRecord(…, auth)` (Task 3). No new exports.

- [ ] **Step 1: Write the failing test** — assert the *ordering* property: an unstamped in-scope record is claimable but **not** writable; once stamped it is writable and no longer claimable; a wm-owned record is neither; a pre-cutover record is left alone. Plus: with `CRM_CUTOVER_AT_MS` infinite, nothing is claimable at all.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement** — insert after `const lastSynced = ...`:

```ts
  // OWNERSHIP GATE. Claim the record if it is ours to claim, then reflect the stamp locally so the
  // authorize call below needs no re-fetch. A refusal is logged and the record is left alone; the
  // forward (HubSpot -> monday) direction is unaffected, because reading is always safe.
  let ownershipAuth: WriteAuth | undefined;
  if (spec.ownership) {
    if (canClaimCrmOwnership(rec as HsRecord, spec.ownership)) {
      const mod = await claimOwnership(env, spec, rec.id, opts);
      budget.left--;
      rec.properties[spec.ownership.prop] = spec.ownership.owner;
      if (mod) rec.properties[spec.modifiedProp] = mod;
      console.log(`ownership object=${spec.object} id=${rec.id} action=claimed owner=${spec.ownership.owner}`);
    }
    ownershipAuth = authorizeWrite(rec as HsRecord, spec.ownership);
    if (!ownershipAuth.allowed)
      console.log(`ownership object=${spec.object} id=${rec.id} action=write-refused reason="${ownershipAuth.reason}"`);
  }
```

Pass `ownershipAuth` as the trailing argument at **every** `patchRecord(...)` inside `reconcileRecord` and `writeSafeBackfills`, and at the `createRecord(...)` in `createFromMonday`. Add the imports.

- [ ] **Step 4: Run the full suite** — tsc clean, all pass; WM specs leave `ownershipAuth` undefined and `assertMayWrite` early-returns.

- [ ] **Step 5: Commit** `feat(crm): claim-then-write ownership gate in reconcileRecord`

---

## Task 10: `ENABLE_CRM` EXCLUSIVE routing + webhook registrar (not run)

**Files:** Modify `worker/src/config.ts`, `worker/src/types.ts` (`Env.ENABLE_CRM?: string`); create `worker/scripts/register-crm-webhooks.mjs`, `worker/test/crm-routing.test.ts`.

**Interfaces:** produces `specsFor(env): ObjectSpec[]` (**exclusive**), `specByBoard(env, boardId)`, `ALL_KNOWN_SPECS` (non-runtime only), `CRM_WEBHOOK_EVENTS`.

**Why gated, and why EXCLUSIVE:** `ALL_SPECS`/`SPEC_BY_BOARD` are module-level constants shared with the production Worker, so adding CRM specs unconditionally would make a production deploy start syncing the CRM boards. But the gate must also be **exclusive, not additive** — if the CRM deployment resolved WM specs too, both Workers would reconcile the same WM records, write monday twice and race. Ownership only guards HubSpot writes and would not save us. **The old Worker owns WM; the new one owns CRM. Each deployment resolves only its own boards.**

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/crm-routing.test.ts
import { describe, it, expect } from "vitest";
import { ALL_SPECS, SPEC_BY_BOARD, specsFor, specByBoard, ALL_KNOWN_SPECS } from "../src/config";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";

const prod: any = {};                       // production Worker: ENABLE_CRM unset
const crmEnv: any = { ENABLE_CRM: "true" };

describe("CRM specs are invisible to a production deploy", () => {
  it("ALL_SPECS and SPEC_BY_BOARD still contain ONLY the WM specs", () => {
    expect(ALL_SPECS.every(s => !s.ownership)).toBe(true);
    expect(SPEC_BY_BOARD["5028000495"]).toBeUndefined();
  });
  // EXCLUSIVE, not a union. A union would make the CRM Worker a second processor for the WM boards.
  it("the WM deployment resolves ONLY WM specs", () => {
    expect(specsFor(prod).some(s => s.ownership)).toBe(false);
    expect(specsFor(prod)).toEqual(ALL_SPECS);
  });
  it("the CRM deployment resolves ONLY the two CRM specs", () => {
    expect(specsFor(crmEnv)).toEqual([CRM_CONTACTS, CRM_ACCOUNTS]);
    expect(specsFor(crmEnv)).toHaveLength(2);
    expect(specsFor(crmEnv).some(s => !s.ownership)).toBe(false);
  });
  it("WM environment: every CRM board id resolves to NO spec", () => {
    for (const b of ["5028000495", "5028000496"]) expect(specByBoard(prod, b)).toBeUndefined();
  });
  it("CRM environment: every WM board id resolves to NO spec", () => {
    for (const b of ["5029480547", "5029480548", "5029639630", "5029639440"])
      expect(specByBoard(crmEnv, b)).toBeUndefined();
  });
  it("a CRM board webhook resolves EXACTLY ONE spec, the CRM one", () => {
    expect(specByBoard(crmEnv, "5028000495")).toBe(CRM_CONTACTS);
    expect(specByBoard(crmEnv, "5028000496")).toBe(CRM_ACCOUNTS);
    expect(specsFor(crmEnv).filter(s => s.boardId === "5028000495")).toHaveLength(1);
  });
  it("a WM board webhook never resolves a CRM spec, in either environment", () => {
    expect(specByBoard(prod, "5029639630")?.ownership).toBeUndefined();
    expect(specByBoard(crmEnv, "5029639630")).toBeUndefined();
  });
  it("ALL_KNOWN_SPECS is the union, but is never what routing uses", () => {
    expect(ALL_KNOWN_SPECS).toHaveLength(ALL_SPECS.length + 2);
    expect(specsFor(prod)).not.toEqual(ALL_KNOWN_SPECS);
    expect(specsFor(crmEnv)).not.toEqual(ALL_KNOWN_SPECS);
  });
  it("no board id is claimed by both a WM and a CRM spec", () => {
    const crm = new Set([CRM_CONTACTS.boardId, CRM_ACCOUNTS.boardId]);
    expect(ALL_SPECS.map(s => s.boardId).filter(b => crm.has(b))).toEqual([]);
  });
  it("CRM specs never join the full sweep", () =>
    expect([CRM_CONTACTS, CRM_ACCOUNTS].every(s => s.skipFullReconcile)).toBe(true));
});

describe("monday webhook registration events", () => {
  it("registers create_item — NOT the delivered payload name create_pulse", async () => {
    const { CRM_WEBHOOK_EVENTS } = await import("../scripts/register-crm-webhooks.mjs");
    expect(CRM_WEBHOOK_EVENTS).toContain("create_item");
    expect(CRM_WEBHOOK_EVENTS).not.toContain("create_pulse");
    for (const e of ["change_column_value", "change_name", "item_deleted"])
      expect(CRM_WEBHOOK_EVENTS).toContain(e);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement** — leave `ALL_SPECS` and `SPEC_BY_BOARD` **exactly as they are**, and add:

```ts
import { CRM_SPECS } from "./config/crm";

/**
 * Specs THIS deployment syncs — EXCLUSIVE, never a union.
 *
 * A union would make the CRM Worker a SECOND processor for every WM board: both Workers would
 * reconcile the same records, write monday twice, double the API traffic and race. Ownership only
 * guards HubSpot writes, so it would not save us. The old Worker owns WM; the new one owns CRM.
 */
export function specsFor(env: Env): ObjectSpec[] {
  return env.ENABLE_CRM === "true" ? CRM_SPECS : ALL_SPECS;
}

/** Board -> spec for THIS deployment only. A board belonging to the other deployment resolves to
 *  undefined, so its webhook is ignored rather than processed twice. */
export function specByBoard(env: Env, boardId: string): ObjectSpec | undefined {
  return specsFor(env).find(s => s.boardId === boardId);
}

/** Every spec in the codebase. For diagnostics, migrations and tests ONLY — never runtime routing. */
export const ALL_KNOWN_SPECS: ObjectSpec[] = [...ALL_SPECS, ...CRM_SPECS];
```

Then migrate `webhooks.ts` / `sync.ts` call sites from `SPEC_BY_BOARD[boardId]` to `specByBoard(env, boardId)` and from `ALL_SPECS` to `specsFor(env)`. Set `"ENABLE_CRM": "true"` in the CRM `wrangler.jsonc` vars only.

- [ ] **Step 4: Write the registrar (do NOT run)** — `CRM_WEBHOOK_EVENTS = ["create_item","change_column_value","change_name","item_deleted"]`; idempotent (query `webhooks(board_id:)` first, create only what is missing); requires `CRM_WEBHOOK_URL` and refuses without it. Note in a comment that registration uses `create_item` while monday **delivers** `type: "create_pulse"`, and the handler routes on board id.

- [ ] **Step 5: Run the full suite** — tsc clean, all pass, 340 baseline green.

- [ ] **Step 6: Commit** `feat(crm): ENABLE_CRM-gated spec routing + idempotent monday webhook registrar (not run)`

---

## Task 11: Full matrix + final baseline

**Files:** Create `worker/test/crm-matrix.test.ts`.

- [ ] **Step 1: Write the tests** using `sync.test.ts`'s in-memory fakes, for both CRM specs: HubSpot create → CRM card created once (also on duplicate webhook delivery); HubSpot update → CRM update; CRM update → HubSpot **only when stamped crm**; CRM create with an existing HubSpot email → **adopted, not duplicated**; CRM Account with an existing domain → adopted; **CRM Account with no domain → no HubSpot create, logged `needs_domain`**; HubSpot delete → CRM card deleted; **monday delete → HubSpot survives**; a WM mirror card for a crm-owned record → **cannot mutate HubSpot**; loop prevention; empty-value protection; phone digit normalization; owner `appReverse`; the create cutoff blocking a pre-go-live demo row; and `ENABLE_CRM` unset → CRM boards produce no sync at all.

- [ ] **Step 2: Run and confirm each fails for the right reason.**
- [ ] **Step 3: Fix what they surface**, one behaviour at a time.
- [ ] **Step 4: Final baseline**

```bash
cd worker && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run
cd ../monday-app && npm run build && ./node_modules/.bin/vitest run
```
Expected: worker tsc clean, **≥ 340** passing; monday-app clean, **195** passing (untouched).

- [ ] **Step 5: Commit** `test(crm): ownership/mirror/delete/adoption/idempotency matrix`

---

## Recorded for later — NOT in Phase 1

Captured from the 2026-09-07 meeting so today's board cleanup doesn't remove something needed later.
**Do not implement any of these inside the Contacts/Companies sync.**

**R-1 — 24-hour Contact-Owner follow-up reminder.** When HubSpot Contact Owner becomes non-empty or is
reassigned, start/reset a 24-hour timer; a qualifying sales activity by the assignee cancels it;
otherwise email the assignee. Reassignment restarts the timer for the new assignee; clearing the owner
cancels it; one reminder per qualifying assignment window (idempotent). Proposed home: Cloudflare (a
Durable Object alarm is the natural fit) + monday.
*Before implementing, inspect the real activity data sources — do not guess event types.* Candidates
already located in the live portal: `hs_last_sales_activity_timestamp` ("Last Engagement Date"),
`num_notes` ("Number of Sales Activities" — counts call/chat/LinkedIn/mail/meeting/note/email/SMS/task/
WhatsApp), `notes_last_updated`, `notes_next_activity_date`, `hs_latest_meeting_activity`. Which of
these count as "qualifying" is a **business** decision, not a technical one.
Schema dependency: this is why the **Contact Owner people column** and Contacts `text_mm6tmzgq`
"Last Activity Date" are kept (see Tier 2 DEFER).

**R-2 — Deal Playbook Library.** Per-product playbooks (Intercom, DocuSign, …) holding what to ask,
what to prepare, what to watch for, and recommended next steps; associated with a Deal, and the
salesperson must be able to **read the content** from the Deal, not just see a linked item's name.
A Deals feature — out of scope for a Contacts/Companies sync. Note: the product list already exists in
HubSpot as company `partner_with` (27 options: Tableau, Docusign, Intercom, HubSpot, Shopify, Miro,
SAP, Sumsub, Fivetran, Minitab, AWS, Google Workspace, …) and contact `manufacturer__c` (89 options),
so a playbook key can reuse one of those vocabularies rather than inventing a third.

**R-3 — Prevent manual Contact creation in monday (UX for `createFromMonday: false`).** With creation
HubSpot-only, a rep can still type a row into the monday board and it will sync nothing. Preferred fix
is a monday permission, not code. The API exposes `set_board_permission(board_id, basic_role_name)`
with exactly four roles — `editor` / `contributor` / `assigned_contributor` / `viewer` (introspected
2026-09-07; both CRM boards are currently `permissions: "everyone"`, `board_kind: "public"`).
`contributor` is the candidate "edit values but don't add/delete items" role, but the enum ships **no
descriptions**, so confirm the exact semantics in the board UI before relying on it — and verify the
**integration token still creates items** under that role, or the whole sync breaks.
If monday cannot do it cleanly, use the non-destructive fallback: stamp Sync State
`"Not synced — create Contact in HubSpot"`. **Never auto-delete a rep's row.**

**R-4 — Unmapped HubSpot create-form fields.** The HubSpot Create Contact form also collects
**Registration Date** and **状态**, which have no monday CRM column and no property found under the
obvious internal names (`registration_date`, `reg_date`, `status`, `zhuang_tai` all missing). Identify
the real internal names before adding columns; both would be additive (Tier 1), so neither blocks
Tier 2.

---

## Phase 2 — mandatory items carried forward from the Tasks 1-3 independent review

**P2-1 — OWNERSHIP ACTIVATION GATE (hard, blocking).**

> **No production or CRM `ObjectSpec` may declare `ownership` in a deployable configuration until
> every HubSpot mutation path reachable for Contacts/Companies is either ownership-guarded or proven
> unreachable for that spec.**

The Tasks 1-3 guard covers `patchRecord` and `createRecord` only. These paths are **not** guarded and
each takes no `spec`, so they cannot consult ownership today:

| Helper | Reachable via | Why it matters |
|---|---|---|
| `putAssociation` / `deleteAssociation` | `associations.ts:reverseAssociations` (has `spec` + `rec`) | a monday-edit path writes associations onto a record the spec may not own; the surrounding `catch` logs and continues, so it is silent |
| `createNote` | `webhooks.ts:syncMondayUpdate` (has `spec` + `hsId`) | a monday update creates a HubSpot Note on a record another sync owns |
| `createLineItem` / `patchLineItem` / `deleteLineItem` / `createProduct` / `archiveDeal` | line-item + deal paths | out of Phase 1 scope, but must be audited before deals join CRM |

The sharpest case: **`create-records.ts:createContactOrCompany`** — when dedup **finds** an existing
record, `createRecord` is never called so the guard never runs, and execution falls through to
`putAssociation` against the adopted record. So a CRM-board create whose email matches a historical
WM-owned contact would mutate that record's associations with no ownership check at all — exactly the
case `ownership.test.ts` asserts at the predicate level and the chokepoint does not yet enforce.

Until this is done, the **`no production spec declares ownership yet` tripwire must stay green.** It
is what makes deferring this safe. The `types.ts` comment has been narrowed to claim only what is
true (property writes via the two chokepoints), rather than "every HubSpot mutation".

**P2-2 — Strict UTC cutover syntax (hardening).** `cutoverFromEnv` currently accepts anything
`Date.parse` tolerates, bounded to `[2020, 2100]`. That stops the catastrophic cases but leaves
operator ambiguity, and both Workers must agree on the **exact same instant**. Tighten to an explicit
UTC ISO-8601/RFC3339 timestamp, keeping the fail-closed range check:

| Input | Accept? |
|---|---|
| `2026-10-01T08:00:00Z` | ✓ |
| `2026-10-01` (no time or zone) | ✗ — ambiguous instant |
| `10/01/2026` | ✗ — D/M vs M/D |
| `2026`, `20261001`, `1`, `0` | ✗ |

---

## Approval gates (all closed)

1. **Task 4 → 5 board changes.** `--apply` requires explicit approval; blocks Tasks 6-7.
2. **Delete the eight demo rows.** Approved in principle, conditional on re-verifying all eight still have empty HubSpot ID **and** Sync State immediately before deletion. If any is linked: stop and report.
3. **Create the production `sync_owner` property** — Phase 2.
4. **Modify the production WM Worker** (guard + fetch list) — Phase 2. **Phase 1 requires none.**
5. **`wrangler deploy`, monday webhook registration, `CRM_CUTOVER_AT_MS` / `CRM_CREATE_CUTOFF_MS` activation** — Phase C/D.

---

## Self-review

**Spec coverage.** handoff §3 engine reuse → Tasks 1-3, 8-10 (additive only) · §6 ownership → 1, 3, 9 · §7 mirrors → 11 · §8 A/B/C → 2 (fetch list), 3 (engine hook), gates 3-4 · §10 rollout → Global Constraints, gate 5 · §11 schema → 4, 5, 6, 7 · §13 create cutoff → 6, 11 · §14/§15 adoption → 8 · §17 deletes → 11 · §18 webhooks → 10 · §19 crons → Global Constraints · §20 tests → 11. Audit §15 directions → 6, 7; F1 people columns → 4, 5; F9 industry → 7. **No uncovered requirement.**

**Placeholders.** None. Every column id in Tasks 6-7 comes from Task 5's live re-query; the ordering exists precisely so no symbolic id enters real config. `CRM_CUTOVER_AT_MS`/`CRM_CREATE_CUTOFF_MS` are `POSITIVE_INFINITY` — a deliberate inert value with a documented meaning and a test, not a stand-in.

**Type consistency.** `OwnershipSpec{prop,createdProp,owner,cutoverAtMs}` · `WriteAuth{allowed,reason}` · `AdoptBy{kind,col}` · `syncOwnerOf` · `authorizeWrite` · `canClaimCrmOwnership` · `claimPatch` · `claimOwnership` · `OwnershipError` · `adoptionKey` · `specsFor` · `specByBoard` · `CRM_CONTACTS` · `CRM_ACCOUNTS` · `CRM_SPECS` · `CRM_CUTOVER_AT_MS` · `CRM_CREATE_CUTOFF_MS` — spelled identically at every definition and use. `patchRecord`/`createRecord` gain the same trailing `auth?: WriteAuth` in Task 3 and are called with it in Task 9.

**Production-safety review.** Every shared-file change is inert without `ownership`/`adoptBy`/`ENABLE_CRM`: `propertiesFor` (Task 2) branches on `spec.ownership`; `assertMayWrite` (Task 3) returns immediately without it; the adoption branch (Task 8) is a new `if` above untouched code; the ownership gate (Task 9) is wrapped in `if (spec.ownership)`; routing (Task 10) leaves `ALL_SPECS`/`SPEC_BY_BOARD` literally unchanged and adds opt-in accessors. **Phase 1 requires no change to the deployed production WM Worker's behaviour.** Task 10's call-site migration (`SPEC_BY_BOARD[x]` → `specByBoard(env, x)`) is the only shared-code edit that touches a production execution path; it is behaviour-identical when `ENABLE_CRM` is unset and is covered by the "WM boards resolve identically either way" test.

---

## Tasks 6-7 — ✅ DONE 2026-09-07. `worker/src/config/crm.ts`, 36 tests. Suite 484 → 520.

All 30 column references in both specs were cross-checked against the live boards: every id exists and
every declared type matches. A test asserts none of the 19 deleted Task-5 stub ids can reappear.

**Two additive engine changes** were required and are inert for production (no WM field uses either type,
asserted by test): `ColType` gained **`"email"`** (monday email columns need `{email,text}`, and the CRM
board uses the native `contact_email`; compared case-insensitively so HubSpot's stored casing cannot
loop) and **`"link"`** (`{url,text}`, for `linkedin_company_page`). The WM contacts board keeps email in
a plain text column, so its path is untouched.

### Association findings — Contact↔Company is forward-only, and that needs a code guard

`reverseAssociations` is **not** deals-only: `sync.ts:567` sits in `syncMondayItem`'s generic
"already linked" branch, and `/app/sync-contact` (`index.ts:492`) already routes contacts through it.
So the moment a CRM spec declares `associations`, a monday relation edit would call
`putAssociation` — the unguarded HubSpot mutation path (P2-1/HIGH-3).

Right now that is a **safe no-op**: `reverseAssociations` iterates `spec.associations ?? []`, and neither
CRM spec declares associations. But forward-only cannot be left to convention.

**Association task, step 1 (before declaring any `associations`):** make `reverseAssociations` return
immediately when `spec.ownership` is set — a blanket "no ownership-declaring spec may write HubSpot
associations until the association path is guarded". Inert for every WM spec (none declares ownership),
impossible to forget per-field, and it is the ownership-activation gate applied to this path.

**Deals stay out.** `contact_deal` points at board **5028000494 "Deals"** — the monday CRM template's
third board, 26 columns, **3 demo items**. Populating it would mean carding HubSpot Deals onto a second
board while the live WM deal boards already sync them: two boards owning the same HubSpot deals, the
exact scenario `sync_owner` exists to prevent. `account_deal` is a mirror through `contact_deal`, so it
inherits this. Both DEFER.

### Primary association label — measured, recommendation: add nothing

The HubSpot MCP exposes **no associations and no association labels**, so a precise census of
companies-per-contact and Primary usage is not obtainable through this connector. What *is* exact, via
the HubSpot-maintained `last_associated_company_name`, for Contacts created since 2026-06-01:

| | Count | Share |
|---|---:|---:|
| Has >=1 associated Company | **1,202** | 52% |
| Has **no** Company at all | **1,118** | **48%** |
| Total | 2,320 | |

`associatedcompanyid` **does not exist in this portal** (absent from `get_properties` and from a full
record dump), so it cannot be used to identify the primary company either. **Separately: WM's
`CONTACTS_MYLA.scopeAlsoLinkedProp = "associatedcompanyid"` (`config.ts:206`) therefore looks dead** —
`recInScope`'s union branch would never fire, so the "also include company-linked contacts" scope
extension is silently inactive on the live WM sync. Worth verifying; not touched here (production, and
out of Phase 1 scope).

**Recommendation: do not create a Primary Company column.** Nothing is lost by waiting — the forward
association sync writes *all* associated companies into `contact_account`, so Primary can be added later
as a **separate** `board_relation` without disturbing it. Overloading `contact_account` to mean
"primary only" would discard the other associations, so that option is off the table either way.
The dominant fact is that ~half of new Contacts have no company at all; a Primary column would be empty
or redundant for the overwhelming majority.

### Vendors / `manufacturer__c` — still DEFER, and now with a further reason

A live record holds **`"49HubSpot;55Aircall"`** — it is a **multi-value** enumeration, not single-select.
So its eventual monday representation must be a **multi-select dropdown** (no `limit_select`) seeded with
all 89 exact labels, which `reverseFieldValue`'s dropdown branch can then validate. Not mapped at all in
Phase 1.

---

## Task 8 — ✅ DONE 2026-09-07. `worker/src/adopt.ts`, 40 tests. Suite 520 → 567.

`adoptionKey(item, spec)` plus a new `if (spec.adoptBy)` branch in `createFromMonday`, chained
`else if` ahead of both WM branches. **The chaining is load-bearing**, not cosmetic: without it a CRM
Accounts card that found no domain match would fall through into the WM companies branch and adopt on
`searchCompanyByDomain(env, item.name)` — i.e. on a company **display name**, the exact "never match by
name" violation the spec forbids. Both WM branch bodies are byte-for-byte unchanged.

**Behaviour delivered**

| Case | Result |
|---|---|
| Account card with a usable domain | search HubSpot by **normalised domain** |
| existing HubSpot company found | **adopt** its id (no duplicate); ownership untouched |
| historical pre-cutover unstamped company | adopted, **not claimed** — CRM reverse write stays blocked |
| CRM-owned company | approved reverse updates allowed |
| **no usable domain** | **no HubSpot company created**; Sync State stamped `not synced — needs domain` |
| brand-new company created from monday | full payload **+ `sync_owner=crm`** atomically (birth ownership) |
| adoption by name | **impossible** — `adoptionKey` never reads `item.name` |

**A gap the tests caught.** `normalizeDomain` only CANONICALISES (lowercase, strip scheme/`www.`/path);
it does not validate, and correctly so — the WM path feeds it a column that already is a domain. But
`adoptBy` reads a **free-typed rep column**, so `"ABC Trading Sdn Bhd"` normalised to
`"abc trading sdn bhd"`, would have matched no HubSpot company, and would then have been used to
**CREATE** one with a garbage domain. Fixed by shape-checking the result against a registrable-hostname
pattern inside `adoptionKey` (13 rejection cases + 5 acceptance cases asserted). `normalizeDomain`
itself is untouched, so the production path is unaffected.

**Open hazard, flagged not fixed:** a rep typing a free email-provider domain (`gmail.com`) into the
Domain column would adopt whichever HubSpot company holds that domain — a wrong-record link. The WM
company path has the same exposure today. Blocking a provider list is a business decision, so it is
recorded here rather than implemented unilaterally.

---

## Task 9 — ✅ DONE 2026-09-07. `ensureHubspotWriteAuth` in `sync.ts`, 26 tests. Suite 567 → 593.

### The plan's own Task 9 draft was WRONG, and this is the correction

The draft (above) placed the gate immediately after `const lastSynced = ...`, i.e. **before** `fieldDiffs`
and before the direction decision:

```ts
  // DRAFT — DO NOT USE
  if (spec.ownership) {
    if (canClaimCrmOwnership(rec, spec.ownership)) { await claimOwnership(...); ... }
```

At that position a **purely forward** HubSpot -> monday reconcile of an eligible unstamped record stamps
`sync_owner=crm`. Every new post-cutover Contact would be claimed simply by being discovered — the "claim
too early" failure. The draft also called `claimOwnership(env, spec, rec.id, opts)`, passing an **id**,
which is the pre-HIGH-2 signature; the fixed function takes the record so it can prove eligibility itself.

**Implemented instead:** `ensureHubspotWriteAuth(env, spec, budget, rec, opts)`, called **lazily at the
two points where a HubSpot business write is genuinely required** and only once the patch is known
non-empty:

- `reconcileRecord`, inside `dir === "toHubspot"`, after `Object.keys(patch).length > 0`;
- `writeSafeBackfills`, after its own patch is built and found non-empty.

Discovery, card creation and every HubSpot -> monday write now reach no ownership code at all. Reading
HubSpot and writing monday is always safe, so there is nothing to authorize.

A refusal returns without patching **and without stamping the sync state**, so the next tick
re-evaluates rather than treating the record as done.

### Where this differs from the review's guidance, and why

The review asked to "recompute authorization from confirmed CRM ownership before applying the
business-field PATCH. Prefer refetching or an equally strong verified transition."

**Implemented as the verified transition, deliberately not a refetch.** A re-read that lagged behind its
own write would return the pre-claim state, `authorizeWrite` would refuse the business patch we had just
earned the right to make, and the next tick would re-enter and re-claim — churn and a spurious skip, for
one extra GET per claim. The transition is sound because `claimOwnership` throws on any HubSpot error and
returns the new modified timestamp **only** on success, and `claimPatch` is type-constrained to exactly
`{ sync_owner: <owner> }`. "We wrote this one property and HubSpot accepted it" is therefore a confirmed
fact, not an assumption, and it is trusted across one statement with no interleaved `await`.

**Strengthened beyond both the draft and the guidance:** the draft stamped the record locally
*unconditionally*. Under `dryRun` or `writeHubspot: false`, `claimOwnership` writes nothing and returns
`null` — so stamping locally would manufacture an `allowed` auth for a record this Worker does not own,
and every downstream log line would be false. The implementation applies the local stamp **only when the
claim actually happened**, and otherwise logs `action=claim-suppressed`. Phase B therefore blocks the
claim *and* the business write, and says so truthfully.

### Pre-Phase-A / Phase-D items recorded here

**PA-1 — Public email-provider domains must fail closed for Company adoption/creation.** A rep typing
`gmail.com` into an Accounts Domain column would adopt whichever HubSpot company holds that domain — a
wrong-record link — or create a company keyed on a shared consumer domain. `adoptionKey`'s hostname
shape-check does **not** catch this: `gmail.com` is a perfectly valid hostname. Required before real
CRM -> HubSpot Company creation is enabled; deliberately **not** implemented during Task 9, and not as an
arbitrary large blacklist. Note for whoever implements it: for **this** portal the Chinese providers
matter at least as much as the Western ones — `qq.com`, `163.com`, `126.com`, `sina.com`, `foxmail.com`
alongside `gmail.com`, `yahoo.com`, `hotmail.com`, `outlook.com`. A live contact in this portal is
literally `uyjvs@qq.com`. A short, explicit, tested list beats a long guessed one.

**PA-2 — Rehearse the claim path before the cutover goes live.** `CRM_CUTOVER_AT_MS` is
`POSITIVE_INFINITY`, so `canClaimCrmOwnership` is **always false** and the claim path is 100% inert in
Phase 1 — it can only be exercised by tests. Its first real execution therefore happens the instant
someone sets a finite cutover at Phase D. Do not let that be the first observation of it: set the finite
cutover with `writeHubspot: false` first and read the `DRY hubspot CLAIM <object>/<id>` lines to preview
the exact blast radius, then enable writes. The `action=claim-suppressed` log exists for this rehearsal.
