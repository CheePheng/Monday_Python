# Audit Fixes F1–F4 — Design

**Date:** 2026-07-24
**Status:** approved for implementation
**Source:** the proactive code/logic audit (see the findings report in-conversation)

## Scope

Fix four audit findings. Two others were considered and deliberately excluded:

- **F5** (a deleted HubSpot line item leaves an orphan monday subitem until the daily reconcile) — **documented, not code-fixed.** A targeted fix would need an expensive board-wide subitem scan on every line-item deletion, or reliance on a HubSpot deal association-change webhook subscription configured outside this repo. The daily reconcile already removes the orphan within a day. Writing scanning code would make the codebase worse for a self-healing latency issue.
- **F6** (a field clear dropped on a not-yet-synced deal) — **withdrawn; not a bug.** The fallback clear path in `useBoard.finishSave` runs only when the deal had no HubSpot id at save time, i.e. it was never synced. `syncDeal` then creates the HubSpot record fresh from monday's current (already-cleared) values, so the field is created empty. There is nothing to clear.

Each fix is independent and small. No new dependencies, no schema changes, no data migration.

---

## F1 — Contact first/last name split is dead code

**File:** `worker/src/reconcile.ts`, `buildCreateProperties`

**Bug.** For a contact created from a monday board card (`createFromMonday`), `props["firstname"]` is
set to the whole item name by the generic `nameReverse` line (`firstname` is the contact's
`nameReverse`). The block that follows tries to split a "First Last" item name into first + last, but
it is guarded by `!props["firstname"]`, which is now always false — so it never runs. A card whose
First-name column holds a full name becomes `firstname="John Smith", lastname="Smith"` in HubSpot.

**Fix.** Make the split realize its intent, and only in the case it was written for: the First-name
column holds multiple words **and** the separate Last Name column is empty. Then override `firstname`
to the first token and set `lastname` to the rest. When Last Name is filled, the columns are
authoritative and we don't second-guess them.

```ts
// Contacts: the item name is the First Name column. If a rep typed a FULL name there and left the
// separate Last Name column empty, split it so HubSpot gets a clean first/last instead of the whole
// name as firstname. When Last Name is filled, the columns are authoritative — don't second-guess them.
if (spec.object === "contacts") {
  const parts = item.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && !props["lastname"]) {
    props["firstname"] = parts[0];
    props["lastname"] = parts.slice(1).join(" ");
  }
}
```

**Behaviour after fix:**

| First-name column | Last Name column | firstname | lastname |
|---|---|---|---|
| "John" | (empty) | John | (unset) |
| "John Smith" | (empty) | John | Smith |
| "John" | "Smith" | John | Smith |
| "Mary Anne" | "Smith" | Mary Anne | Smith |

`buildCreateProperties` is a pure function, so this is covered by real unit tests.

---

## F2 — Owner-resolution failure blocks a Contact/Company create

**File:** `worker/src/create-records.ts`, `createContactOrCompany`

**Bug.** `const email = input.sessionUserId ? (await getUserById(env, input.sessionUserId))?.email : undefined;`
runs at the `owner` step. A transient monday error from `getUserById` throws, and the whole create
fails — even though a missing owner is already a supported, non-fatal state (the record is created
Unassigned). A rep hitting a monday blip sees a hard failure instead.

**Fix.** Treat a lookup *failure* the same as a lookup *miss*: degrade to Unassigned. Wrap the call so
an error yields `undefined`, which flows into the existing, already-tested `resolveActor(ctx, undefined)
→ unassigned` path. Owner resolution becomes non-blocking.

```ts
let email: string | undefined;
try { email = input.sessionUserId ? (await getUserById(env, input.sessionUserId))?.email : undefined; }
catch (e) { console.log(`[create] owner lookup failed for user ${input.sessionUserId}: ${String(e).slice(0, 120)} — creating Unassigned`); }
const owner = resolveActor(ctx, email);
```

The record is created Unassigned with the existing `ownerMessage`, so the rep is told two-way sync is
off until a Sales User is assigned — the same message they'd get for an unmapped owner today.

**Testing.** This is I/O orchestration (`getUserById` hits the monday API), which this codebase verifies
live rather than unit-testing — consistent with the rest of `createContactOrCompany`. The behavioural
target (undefined email → Unassigned) is already covered by `actor.test.ts`; this change only routes a
thrown lookup into that tested path. Verified by `tsc` + review.

---

## F3 — Reverse-dropdown comma split is fragile

**File:** `worker/src/reconcile.ts`, `reverseFieldValue`

**Bug.** A multi-select dropdown's monday text is reversed to HubSpot by `text.split(",")`. A label
that itself contains a comma (e.g. an Industry-style "Glass, Ceramics & Concrete") would be mis-split
into invalid tokens. No current trigger — the only reverse-enabled dropdowns are Vendors (no commas)
and single-select Industry (caught by the existing whole-label match) — but it is a latent trap for any
future comma-containing multi-select reversible dropdown.

**Fix.** Replace the blind split with a boundary-checked greedy matcher: repeatedly consume the longest
known label the remaining text starts with, requiring the next character to be end-of-string or a comma
(so a label can't partial-match inside a longer unknown token). Unknown labels stop the scan, preserving
today's "drop unmappable labels" behaviour.

```ts
if (f.type === "dropdown") {
  if (rev[text] !== undefined) return rev[text]; // whole-label match first (single value)
  // Multi-select: monday joins labels with ", ", and a label can itself contain a comma, so don't
  // blindly split on ",". Greedily consume the longest known label at a comma/end boundary; an unknown
  // label stops the scan (a raw monday label is not a valid HubSpot enum value -> 400 every tick).
  const labels = Object.keys(rev).filter(Boolean).sort((a, b) => b.length - a.length); // longest first; skip any empty label (would never advance `rest`)
  const out: string[] = [];
  let rest = text;
  while (rest) {
    rest = rest.replace(/^\s*,\s*/, "");
    const hit = labels.find(l => rest.startsWith(l) && (rest.length === l.length || rest[l.length] === ","));
    if (!hit) break;
    out.push(rev[hit]);
    rest = rest.slice(hit.length);
  }
  return out.join(";");
}
```

`reverseFieldValue` is pure — covered by real unit tests, including a comma-containing multi-select label.

**Backward compatibility.** For today's data this produces output identical to the old split: a single
value returns via the whole-label match (unchanged); `"1Tableau, 3AWS"` still yields `"1Tableau;3AWS"`.
Note this function is also called from `buildCreateProperties` (create-from-monday), so the tests must
confirm the current comma-free multi-value case is unchanged there too, not only the new comma case.

---

## F4 — Worker errors surface as a bare HTTP status

**File:** `monday-app/src/worker-client.ts`, `call`

**Bug.** On a non-2xx response `call` throws `worker ${method} ${path}: ${status}`, discarding the JSON
`{error}` the Worker returns (e.g. `{ok:false, error:"deal-not-synced"}` with 409). The rep sees "409".

**Fix.** Read the body and append its `error` to the thrown message. The app already renders `String(e)`
in its error toasts, so the readable reason flows through with no caller changes.

```ts
if (!res.ok) {
  const detail = await res.json().catch(() => null);
  const msg = detail && typeof detail.error === "string" ? `: ${detail.error}` : "";
  throw new Error(`worker ${method} ${path}: ${res.status}${msg}`);
}
```

**Testing.** `call` wraps `fetch`; this codebase does not unit-test the fetch layer. The change is
additive and backward-compatible (a richer message; the 200-path `{error}` handling in `searchHubspot`
is untouched). Verified by `tsc` + review.

---

## Testing summary

| Fix | Unit test | Rationale |
|---|---|---|
| F1 | ✅ `buildCreateProperties` (pure) | new cases: single word, multi-word no lastname, multi-word with lastname |
| F2 | — verify `tsc` + review | I/O orchestration; degrades into the actor path already tested |
| F3 | ✅ `reverseFieldValue` (pure) | new case: multi-select with a comma-containing label |
| F4 | — verify `tsc` + review | fetch layer, not unit-tested here; additive change |

Both workspaces must stay green: worker `tsc` + `vitest`, app `tsc` + `vitest` + `vite build`.

## Non-goals

- F5 (orphan subitem on line-item deletion) — documented as known eventual-consistency latency.
- F6 — withdrawn (not a bug).
- No changes to the sync direction logic, the DO/registry, associations, or any board/column.
