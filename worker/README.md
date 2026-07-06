# HubSpot ⇄ monday Sync Worker (live)

A Cloudflare Worker that two-way syncs HubSpot with Myla's monday boards. **Webhooks** make it
near-instant (a few seconds); a **cron every 10 min** is only a backup that catches missed events.

- **URL:** `https://hubspot-monday-sync.askada.workers.dev`
- **Webhook endpoints:** `POST /webhooks/monday`, `POST /webhooks/hubspot`
- **Crons (backup only):** `* * * * *` = 1-min **incremental** poll (pushes recently-changed HubSpot
  **deals, contacts, and companies** to monday, ~60s — a safety net if a webhook is missed);
  `*/10 * * * *` = full reconcile sweep.
- **Latency:** monday→HubSpot = **seconds** (monday webhooks on all four boards). HubSpot→monday =
  **seconds** for **deals, contacts, and companies** (HubSpot webhooks via the
  `hubspot-monday-webhook-sync` developer-projects app); the 1-min poll only backstops missed events.
- **Live/dry switch:** `vars.DRY_RUN` in `wrangler.jsonc` (`"false"` = live, anything else = dry). Redeploy to apply.

Webhooks and cron share the **same core** (`reconcileRecord` / `createFromMonday` in `src/sync.ts`), so
behaviour is identical whether an update arrives instantly or via the backup sweep.

## What it does

It reconciles four boards (config in `src/config.ts`):

| Board | HubSpot object | Grouped by | Scope |
|---|---|---|---|
| Myla Mestiola Deals `5029480547` | deals (sales_user = Myla) | deal stage | **all dates** (full history) |
| Unassigned Deals `5029479220` | deals with **no** sales_user | one group | created ≥ 2026-07-01 |
| Myla Company Follow Up `5029639440` | companies (sales_user = Myla) | one group | created ≥ 2026-07-01 |
| Myla Contact Follow Up `5029639630` | contacts (sales_user = Myla) | lead status (empty → **New**) | created ≥ 2026-07-01 |

**Two-way, last-edit-wins:** for each linked record it compares fields; whichever side changed since the
last sync wins (tracked in a hidden **Sync State** column per board). Direction is immune to the sync's
own writes, so it converges and never ping-pongs.

**Create:** a card added to a per-owner board (Deals/Company/Contact) after the go-live cutoff creates a
HubSpot record and writes the new id back. Contacts adopt an existing HubSpot contact by email if one
exists. **HubSpot records are never deleted**, and old history is never migrated (new-only).

## Manual trigger (testing / one-off)

Secret is sent as a header (never in the URL). `mode=dry` previews without writing.

```bash
SECRET=...   # the TRIGGER_SECRET
curl -H "X-Trigger-Secret: $SECRET" \
  "https://hubspot-monday-sync.askada.workers.dev/run?object=deals&mode=dry&maxWrites=25"
# object = deals | companies | contacts (omit for all); mode = dry | live
```

`npx wrangler tail` streams live logs (webhooks log `[webhook] source=... action=...`).

## Webhooks (near-instant sync)

Endpoints (already live after deploy):
- **monday →** `https://hubspot-monday-sync.askada.workers.dev/webhooks/monday`
- **HubSpot →** `https://hubspot-monday-sync.askada.workers.dev/webhooks/hubspot`

### Create the monday webhooks
Per board (start with **Deals 5029480547**), create a webhook pointing at the monday endpoint. Two ways:
- **API (recommended):** `create_webhook` mutation, one per event:
  ```graphql
  mutation { create_webhook(board_id: 5029480547,
    url: "https://hubspot-monday-sync.askada.workers.dev/webhooks/monday",
    event: create_item) { id } }
  ```
  Repeat with `event:` = **`create_item`**, **`change_name`**, **`change_column_value`**, **`move_item_to_group`**.
  (monday sends a one-time challenge to the URL; the Worker answers it automatically.)
- **UI:** board → **Integrations → Webhooks** (or the "Webhooks" integration recipe) for the same events.

The Worker **ignores changes to its own bookkeeping columns** (Sync State / HubSpot ID / HubSpot Link),
so those don't cause loops.

**Already registered** — those four events on **all three** owned boards: Deals `5029480547`,
Contacts `5029639630`, and Companies `5029639440` (the handler routes by board id via `SPEC_BY_BOARD`).
List them with `query { webhooks(board_id:<id>){ id event } }`.

### HubSpot webhooks — done via a developer-projects app ✅
HubSpot→monday is instant for **deals, contacts, AND companies** through the
**`hubspot-monday-webhook-sync`** developer-projects app (source in the repo folder of the same name),
on portal **39939588**. It's a **private, static-auth** app on platform **2026.03** that POSTs to
`/webhooks/hubspot`.

- Subscriptions (in `src/app/webhooks/webhooks-hsmeta.json`): `object.creation` + `object.propertyChange`
  for **deals** (dealname, dealstage, pipeline, owner, sales_user, dealtype, hs_priority, vendor),
  **contacts** (firstname, lastname, email, jobtitle, company, phone, owner, sales_user, hs_lead_status,
  leadsource, manufacturer__c), and **companies** (name, owner, sales_user, industry, type, city, state,
  numberofemployees, annualrevenue, description, linkedin_company_page).
- Scopes: `crm.objects.deals.read`, `crm.objects.contacts.read`, `crm.objects.companies.read`. The
  Worker's own writes use the private-app token (`HUBSPOT_ACCESS_TOKEN`), which has read+write on all three.
- Redeploy after config changes: `hs project upload --account 39939588`. **Adding scopes requires a
  re-install** — `hs project app-install-status` says "outdated scopes" until you reinstall in the portal.
- **Routing:** the Worker's `extractObjectEvents` reads `objectTypeId` (`0-1` contact, `0-2` company,
  `0-3` deal) — or the legacy `deal.*`/`contact.*`/`company.*` prefix — so a **mixed batch routes each
  event to the right object type**. It fetches the fresh record itself (never trusts the payload value).
- **Volume note:** contact/company webhooks fire **portal-wide** (HubSpot config can't filter by
  `sales_user`), so the Worker fetches each and **drops non-Myla records after one read** (scope check
  before any monday call). A giant import burst may exceed the free-plan per-invocation subrequest cap for
  some events; those simply sync on the next 1-min poll (self-healing).

> Alternative event sources still work with the same endpoint: a HubSpot **Workflow** "Send a webhook"
> action, or a legacy public app. The endpoint accepts all of these.

Optional signature check: put the app's **client secret** in the Worker as `HUBSPOT_APP_SECRET`
(`npx wrangler secret put HUBSPOT_APP_SECRET`). When set, the Worker validates the `v3` signature and
rejects anything else; when unset, it accepts (the URL is unguessable).

### Testing near-instant sync
Run `npx wrangler tail` in one terminal, then:
- **monday → HubSpot:** rename a card on the Deals board → within a few seconds the log shows
  `source=monday ... action=updated-hubspot`, and the HubSpot deal name changes.
- **HubSpot → monday:** change a deal's stage in HubSpot → log shows
  `source=hubspot ... action=updated-monday` and the card moves group / updates.
- **Create monday → HubSpot:** add a new card (owned board) → `action=created-hubspot`, and the card
  gets a HubSpot Deal ID written back within seconds.

### Confirming duplicate prevention
- Rename the same card twice quickly → each webhook logs `updated-hubspot` but **no new HubSpot deal**
  is created (the card already has a Deal ID). Re-running `/run` shows `inSync`.
- Create a deal in HubSpot, then create a monday card for the same deal name manually: the HubSpot
  webhook path searches **all** deal boards for the Deal ID first and logs `skipped-in-sync` /
  `updated-*` instead of making a second card. Look for `action=skipped reason="..."` lines.

## Production safety

How each guarantee is enforced in code (all covered by `npx vitest run`):

**Webhook authenticity**
- **HubSpot:** `/webhooks/hubspot` validates the **v3 signature** when `HUBSPOT_APP_SECRET` is set —
  `base64(HMAC-SHA256(clientSecret, method + url + rawBody + timestamp))` vs `x-hubspot-signature-v3`,
  rejecting stale timestamps (>5 min, replay guard). Invalid requests get a `403` and a specific log
  (`action=rejected reason="signature mismatch|missing …|stale …"`). When the secret is unset it accepts
  (the URL is unguessable) and logs `unsigned-accepted`. See "Enabling HubSpot signature validation" below.
- **monday:** the subscription **challenge** is echoed automatically, and only **configured board ids**
  (`SPEC_BY_BOARD`) are processed — anything else logs `action=ignored reason="board not configured"`.

**Loop prevention** (monday → HubSpot → monday can't ping-pong)
- **Value-diff:** a side is written only for fields that actually differ (`fieldDiffs` / `buildUpdatePayload`).
  An echo of our own write diffs to nothing → `action=skipped-in-sync`, no write.
- **Direction by Sync-State timestamp,** not monday's `updated_at`: the hidden Sync-State column stores the
  last-synced HubSpot `hs_lastmodifieddate`; HubSpot wins only if it changed since then, so the sync is
  immune to its own writes and the fetch→write self-race.
- **Bookkeeping-column guard:** monday column-change events on the Sync-State / HubSpot-ID / Link columns
  are ignored outright.

**Duplicate prevention** (idempotent on HubSpot Deal ID + monday item id)
- monday → HubSpot: a card is only created if its **HubSpot ID column is empty**; the new id is written
  back (retried hard — `setColumns` retries=3 — and aborts the create loop if it can't, to avoid orphans).
- HubSpot → monday: `findLinkedDealItem` searches **every** deal board for the Deal ID before creating.
- **Concurrency:** webhooks are **coalesced per record id** within an isolate (`coalesce()` in
  `webhooks.ts`) so a burst of events for one deal/card can't race two creates. Cross-isolate bursts still
  converge via the id search + the cron backup — a duplicate never survives.

**Failure handling**
- HubSpot `hs()` retries **429 + 5xx** with backoff on safe/idempotent calls; **creates use retries=1** so a
  POST is never retried into a duplicate. Other 4xx throw immediately (no pointless retries).
- monday `gql()` waits out **429 / complexity-budget** (safe even for mutations — the request didn't apply);
  create/update/move mutations use retries=1, the idempotent Sync-State write-back retries=3.
- Every failed sync logs the object + id + error (`error deals/<id>: …`, `source=… action=error reason="…"`).

### Enabling HubSpot signature validation (safe rollout)
The app's **client secret** is the HMAC key. Enable without risk of dropping live events:
1. Grab the client secret from the app page (project `hubspot-monday-webhook-sync` → app → Auth).
2. `cd worker && npx wrangler secret put HUBSPOT_APP_SECRET` (paste it) — no redeploy needed.
3. `npx wrangler tail` and edit a deal. A good webhook logs `action=received`. If you instead see
   `action=rejected reason="signature mismatch"`, the scheme differs — **roll back immediately** with
   `npx wrangler secret delete HUBSPOT_APP_SECRET` (reverts to accept-unsigned) and open an issue.

### Manual test checklist (post-deploy smoke test)
Run `npx wrangler tail`, then confirm each line appears:
- [ ] **HubSpot → monday update:** change a Myla deal's stage → `source=hubspot … action=updated-monday`;
      card moves group within seconds.
- [ ] **HubSpot → monday create:** create a Myla deal (Sales Pipeline, created today) → `action=created-monday`;
      a card appears with the HubSpot ID + link filled.
- [ ] **monday → HubSpot update:** rename that card → `source=monday … action=updated-hubspot`; deal renamed.
- [ ] **monday → HubSpot create:** add a card on the Deals board → `action=created-hubspot`; a Deal ID is
      written back to the card within seconds.
- [ ] **No loop:** after any of the above, confirm the follow-on echo logs `action=skipped-in-sync` (not a
      second write).
- [ ] **No duplicate (HubSpot side):** rename the same card twice fast → both log `updated-hubspot`, **no**
      new deal; `curl …/run?object=deals&mode=dry` shows `inSync`.
- [ ] **No duplicate (monday side):** trigger the same deal webhook twice → second logs `skipped-in-sync`,
      **no** second card.
- [ ] **Signature (if enabled):** a real webhook logs `action=received`; a hand-crafted POST with no
      signature logs `action=rejected`.

## Deploy / secrets

```bash
npm install
npx wrangler deploy
# secrets (one-time): npx wrangler secret put MONDAY_API_TOKEN | HUBSPOT_ACCESS_TOKEN | TRIGGER_SECRET
# optional hardening:  npx wrangler secret put HUBSPOT_APP_SECRET   (enables v3 signature validation)
```

## ⚠️ Free plan limit

The account is on the **free** Workers plan (50 subrequests / invocation). The cron caps writes at
**25/tick** (`optsFromEnv` in `src/index.ts`) to stay under it; overflow syncs on the next tick. For
more salespeople or higher volume, click **Upgrade → Workers Paid** ($5/mo, 1,000 subrequests) and raise
that cap.

## Onboard another salesperson

1. Find their `sales_user` id (= HubSpot owner id) and their 3 board ids.
2. Add a `HubSpot ID` (numbers) + `Sync State` (text) column to each new board (see `add_id_columns.py`).
3. Copy the `*_MYLA` specs in `src/config.ts` with the new ids and add them to `ALL_SPECS`.
4. `npx tsc --noEmit && npx vitest run`, then `npx wrangler deploy`.

## Known limitations

- **Clearing** a field in HubSpot does not clear it in monday (prevents a resurrection loop). Change
  values in HubSpot rather than blanking them.
- A monday value on a field that is **empty in HubSpot** does push to HubSpot; but see above for clears.
- Contact create splits the card name into first/last heuristically; fix names in HubSpot if needed.
- Adopting a contact whose HubSpot owner isn't Myla leaves the card frozen (logged) — reassign in HubSpot.

## Tests

`npx vitest run` — 48 tests covering mapping, routing, dedup, reconcile direction, webhook-payload parsing,
and the end-to-end hardening behaviours (create-once, update-existing, cross-board dedup, duplicate-payload
safety, and the no-loop echo) driven through the real sync orchestration with in-memory API fakes.
