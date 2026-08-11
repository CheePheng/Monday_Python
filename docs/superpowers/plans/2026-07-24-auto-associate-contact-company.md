# Auto-associate Contact → Company Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** When a contact is picked in the deal form, auto-add its associated company/companies to the Companies section.

**Architecture:** A new worker read endpoint returns a record's associations; a pure merge helper (TDD) dedupes them into the drawer's companies list; `DealDrawer` fetches on contact-add, seeding "already resolved" from the hydrated contacts so existing deals don't suddenly pull companies in.

**Tech Stack:** Cloudflare Worker + vitest; React + Vite + vitest. Deploy: `wrangler` + cached `mapps`.

**Spec:** `docs/superpowers/specs/2026-07-24-auto-associate-contact-company-design.md`

---

## Task 1: `mergeAssociatedCompanies` helper (TDD)

**Files:** Create `monday-app/src/lib/auto-associate.ts` and `monday-app/src/lib/auto-associate.test.ts`.

- [ ] **Step 1: Write the failing tests**

`monday-app/src/lib/auto-associate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mergeAssociatedCompanies } from "./auto-associate";
import type { Assoc } from "./assoc";

const co = (hubspotId: string, label: string): Assoc => ({ hubspotId, label });

describe("mergeAssociatedCompanies", () => {
  it("appends a new associated company", () =>
    expect(mergeAssociatedCompanies([], [{ hubspotId: "1", name: "Acme" }]))
      .toEqual([{ hubspotId: "1", label: "Acme" }]));
  it("dedupes one already staged (by hubspotId)", () =>
    expect(mergeAssociatedCompanies([co("1", "Acme")], [{ hubspotId: "1", name: "Acme" }]))
      .toEqual([co("1", "Acme")]));
  it("adds only the new ones from a mixed batch", () =>
    expect(mergeAssociatedCompanies([co("1", "Acme")], [{ hubspotId: "1", name: "Acme" }, { hubspotId: "2", name: "Beta" }]))
      .toEqual([co("1", "Acme"), { hubspotId: "2", label: "Beta" }]));
  it("empty fetch is a no-op (same array back)", () => {
    const cur = [co("1", "Acme")];
    expect(mergeAssociatedCompanies(cur, [])).toBe(cur);
  });
  it("falls back to the id when a name is missing", () =>
    expect(mergeAssociatedCompanies([], [{ hubspotId: "9", name: "" }]))
      .toEqual([{ hubspotId: "9", label: "9" }]));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd monday-app && npx vitest run src/lib/auto-associate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`monday-app/src/lib/auto-associate.ts`:
```ts
import type { Assoc } from "./assoc";

/** Append fetched associated companies to the current staged list, deduped by hubspotId. Never removes,
 * so a company the user deleted stays gone. Returns the same array reference when nothing is added. */
export function mergeAssociatedCompanies(current: Assoc[], fetched: { hubspotId: string; name: string }[]): Assoc[] {
  const have = new Set(current.map(a => a.hubspotId).filter(Boolean));
  const additions: Assoc[] = fetched
    .filter(f => f.hubspotId && !have.has(f.hubspotId))
    .map(f => ({ hubspotId: f.hubspotId, label: f.name || f.hubspotId }));
  return additions.length ? [...current, ...additions] : current;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd monday-app && npx vitest run src/lib/auto-associate.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/auto-associate.ts monday-app/src/lib/auto-associate.test.ts
git commit -m "feat(monday-app): mergeAssociatedCompanies helper (dedupe by hubspotId, never remove)"
```

---

## Task 2: Worker `/app/associations` read endpoint

**Files:** Modify `worker/src/index.ts`.

- [ ] **Step 1: Add the imports**

Extend the `./hubspot` import in `worker/src/index.ts` to include `getAssociatedIds, getRecordsByIds`:
```ts
import { searchObjects, patchLineItem, deleteLineItem, deleteAssociation, archiveDeal, patchRecord, createProduct, createLineItem, getWritablePropOptions, getDealLineItems, getRecord, propertiesForSpec, getAssociatedIds, getRecordsByIds } from "./hubspot";
```

- [ ] **Step 2: Add the endpoint**

Inside the `if (url.pathname.startsWith("/app/"))` block (after `authApp` succeeds), add a handler — place it next to `/app/search`:
```ts
      // GET /app/associations?type=contacts&id=<hsId>&to=companies -> [{ hubspotId, name }]. Read-only,
      // fails soft so a lookup hiccup never blocks the form.
      if (url.pathname === "/app/associations" && req.method === "GET") {
        const type = url.searchParams.get("type") ?? "", to = url.searchParams.get("to") ?? "";
        const id = url.searchParams.get("id") ?? "";
        const OBJ = new Set(["contacts", "companies", "deals"]);
        if (!OBJ.has(type) || !OBJ.has(to) || !/^\d+$/.test(id))
          return Response.json({ error: "type/to must be a CRM object; id must be numeric" }, { status: 400, headers: CORS });
        try {
          const ids = await getAssociatedIds(env, type, id, to);
          const recs = ids.length ? await getRecordsByIds(env, to, ids, ["name", "domain", "firstname", "lastname", "email"]) : [];
          const results = recs.map(r => {
            const p = r.properties;
            const name = to === "companies" ? (p.name || p.domain || "").trim()
                       : to === "contacts" ? ([p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? ""))
                       : "";
            return { hubspotId: r.id, name };
          });
          return Response.json({ results }, { headers: CORS });
        } catch (e) {
          console.log(`[app/associations] type=${type} to=${to} error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [] }, { headers: CORS });
        }
      }
```

- [ ] **Step 3: Worker gate + commit + deploy**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit && npx vitest run`
Expected: tsc clean; all pass.
```bash
git add worker/src/index.ts
git commit -m "feat(worker): GET /app/associations returns a record's linked records"
cd worker && npx wrangler deploy
```

---

## Task 3: App — fetch + auto-stage on contact add

**Files:** Modify `monday-app/src/worker-client.ts` and `monday-app/src/views/DealDrawer.tsx`.

- [ ] **Step 1: Add the client fetch**

In `monday-app/src/worker-client.ts`, add:
```ts
export async function getRecordAssociations(token: string, type: "contacts" | "companies", id: string, to: "contacts" | "companies"):
    Promise<{ hubspotId: string; name: string }[]> {
  const res = await call(token, "GET", `/app/associations?type=${type}&id=${encodeURIComponent(id)}&to=${to}`);
  return res?.results ?? [];
}
```

- [ ] **Step 2: Wire the drawer**

In `monday-app/src/views/DealDrawer.tsx`:

(a) add the imports:
```ts
import { mergeAssociatedCompanies } from "../lib/auto-associate";
```
and add `getRecordAssociations` to the existing `../worker-client` import.

(b) add a resolved-set ref near the other refs (e.g. by the `contacts`/`companies` state):
```ts
  // Contacts whose companies we've already auto-linked — seeded with the deal's existing contacts on load
  // so opening a saved deal doesn't suddenly pull companies in. Only NEW picks trigger a fetch.
  const resolvedContactsRef = useRef<Set<string>>(new Set());
```

(c) at hydration (the line `setContacts(cs); setOrigContacts(cs);`, ~line 122), seed the ref:
```ts
      setContacts(cs); setOrigContacts(cs);
      resolvedContactsRef.current = new Set(cs.map(c => c.hubspotId).filter((x): x is string => !!x));
```

(d) add the handler (near `resolveAssocs`):
```ts
  async function onContactsChange(next: Assoc[]) {
    setDirty(true);
    setContacts(next);
    // Auto-link contact -> company: for each newly-picked contact with a hubspotId we haven't resolved,
    // fetch its companies and merge (deduped, never removing what the user already has/removed).
    for (const c of next) {
      if (!c.hubspotId || resolvedContactsRef.current.has(c.hubspotId)) continue;
      resolvedContactsRef.current.add(c.hubspotId);
      try {
        const assoc = await getRecordAssociations(board.sessionToken, "contacts", c.hubspotId, "companies");
        if (assoc.length) setCompanies(prev => mergeAssociatedCompanies(prev, assoc));
      } catch { /* fail soft — auto-link is a convenience, never block the form */ }
    }
  }
```

(e) use it on the contact section (the `AssociationSection kind="contact"` line, ~351):
```tsx
              <AssociationSection kind="contact" token={board.sessionToken} schema={contactSchema} value={contacts} onChange={onContactsChange} />
```
(Leave the company section's `onChange` unchanged — company→contacts is out of scope.)

- [ ] **Step 3: App gate + commit**

Run: `cd monday-app && ./node_modules/.bin/tsc --noEmit && npx vitest run && npx vite build`
Expected: tsc clean; all pass; build succeeds.
```bash
git add monday-app/src/worker-client.ts monday-app/src/views/DealDrawer.tsx
git commit -m "feat(monday-app): picking a contact auto-adds its company in the deal form"
```

---

## Task 4: Deploy + verify

- [ ] **Step 1: Deploy the app**

Run: `cd monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/e144775468857254/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`

- [ ] **Step 2: Verify**

1. New deal → pick a contact that has a company in HubSpot → its company auto-appears in Companies.
2. Remove that auto-added company → it stays removed (picking the *same* contact again doesn't re-add it).
3. Open an existing deal with linked contacts → no surprise companies appear (seeded as resolved).
4. Pick a contact with no company → nothing added, no error.

---

## Self-Review

**Spec coverage:** merge helper → Task 1; endpoint → Task 2; client + drawer wiring (seed/dedupe/on-add) → Task 3; deploy → Task 4. ✅

**Placeholder scan:** every code step is complete; run steps have exact commands + expected output. ✅

**Type consistency:** `mergeAssociatedCompanies(Assoc[], {hubspotId,name}[])` matches across Task 1 (def) and Task 3 (use); `getRecordAssociations(...) -> {hubspotId,name}[]` feeds it directly; endpoint returns `{ results: {hubspotId,name}[] }` which the client unwraps to `results`. `Assoc` already has optional `hubspotId`/`label`. `getAssociatedIds`/`getRecordsByIds` signatures match the worker helpers. ✅

## Rollback

Four independent commits — `git revert` any. The worker endpoint is read-only and additive; the drawer change only stages extra companies the user can remove.
