# monday Update → HubSpot Note — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`). Tasks 4-5 hit live monday/HubSpot — run inline.

**Goal:** Posting an Update on a monday deal/contact/company item creates an author-prefixed Note on the matching HubSpot record. One-way, no scope change.

**Tech Stack:** Cloudflare Worker (TS, vitest), HubSpot notes v3, monday webhooks.

---

## Task 1: createNote + getUserById helpers

**Files:** Modify `worker/src/hubspot.ts`, `worker/src/monday.ts`

- [ ] **Step 1:** `hubspot.ts` — `createNote(env, body, tsMs, ownerId, objectType, objectId, opts)`:
  `POST /crm/v3/objects/notes` with `{ properties: { hs_note_body: body, hs_timestamp: String(tsMs), ...(ownerId?{hubspot_owner_id:ownerId}:{}) }, associations: [{ to: { id: objectId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_ASSOC[objectType] }] }] }` where `NOTE_ASSOC = { deals: 214, contacts: 202, companies: 190 }`. retries=1. Dry-run guard like `createRecord`.
- [ ] **Step 2:** `monday.ts` — `getUserById(env, userId): Promise<{ name: string; email: string } | null>` via `query { users(ids:[$u]) { name email } }`.
- [ ] **Step 3:** `npx tsc --noEmit` → clean.

---

## Task 2: handleMonday create_update path

**Files:** Modify `worker/src/webhooks.ts`; Test `worker/test/webhook.test.ts`

- [ ] **Step 1: Write failing test:** `extractUpdate(ev)` (a small pure helper) returns `{ itemId, userId, text }` for a `create_update` event and `null` for other types / empty text.

```typescript
it("extractUpdate parses a create_update event", () =>
  expect(extractUpdate({ type: "create_update", pulseId: 100, userId: 42, textBody: "hi" }))
    .toEqual({ itemId: "100", userId: "42", text: "hi" }));
it("extractUpdate ignores non-updates / empty text", () => {
  expect(extractUpdate({ type: "change_column_value", pulseId: 1 })).toBeNull();
  expect(extractUpdate({ type: "create_update", pulseId: 1, textBody: "  " })).toBeNull();
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** `extractUpdate` (export) reading `pulseId`, `userId`, `textBody ?? body`, trimming text.
- [ ] **Step 4:** In `handleMonday`, after resolving `spec`/`itemId`, add: `if (ev.type === "create_update")` → `ectx.waitUntil(coalesce(\`upd:\${ev.updateId ?? itemId}\`, () => syncMondayUpdate(env, spec, ev)).catch(log))` then `return new Response("ok")`. Implement `syncMondayUpdate`:
  - `const u = extractUpdate(ev); if (!u) return;`
  - `const item = await getItem(env, u.itemId); const hsId = item ? colText(item, spec.idCol) : ""; if (!hsId) { log skip; return; }`
  - `const ctx = await getCtxCached(env); let author = "a monday user", ownerId;` if `u.userId`: `const mu = await getUserById(env, u.userId); if (mu) { author = mu.name || author; ownerId = mu.email ? ctx.ownerIdByEmail[mu.email.toLowerCase()] : undefined; }`
  - `await createNote(env, \`Update by \${author} (via monday): \${u.text}\`, Date.now(), ownerId, spec.object, hsId, liveOpts(env));`
  - log `[webhook] source=monday-update item=… object=… note action=created`.
- [ ] **Step 5:** `npx tsc --noEmit && npx vitest run` → green.

---

## Task 3: Deploy

- [ ] **Step 1:** `npx wrangler deploy`.

---

## Task 4: Subscribe create_update on all three boards

- [ ] **Step 1:** One-off monday script: for board in [5029480547, 5029639630, 5029639440], `create_webhook(board_id, url: "https://hubspot-monday-sync.askada.workers.dev/webhooks/monday", event: create_update)`. Print the created webhook ids. Skip if one already exists.

---

## Task 5: Live verify

- [ ] **Step 1:** Post an Update on a monday **deal** → within ~15s a Note "Update by <you> (via monday): …" appears on the HubSpot deal's Activities. Repeat on a **contact** and a **company** card.
- [ ] **Step 2:** Confirm no echo/loop (HubSpot note doesn't create a monday update).

---

## Self-Review Notes

- **Spec coverage:** createNote per-object assoc (Task 1) ✔; create_update routing + author mapping (Task 2) ✔; all-3-boards subscription (Task 4) ✔; live verify (Task 5) ✔; one-way/no-loop (we never create monday updates) ✔.
- **Type consistency:** `createNote` / `getUserById` (Task 1) used in `syncMondayUpdate` (Task 2); `extractUpdate` exported + tested.
- **No scope change** (token already writes notes).
