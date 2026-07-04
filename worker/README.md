# HubSpot ⇄ monday Sync Worker (live)

A Cloudflare Worker that two-way syncs HubSpot with Myla's monday boards. **Webhooks** make it
near-instant (a few seconds); a **cron every 10 min** is only a backup that catches missed events.

- **URL:** `https://hubspot-monday-sync.askada.workers.dev`
- **Webhook endpoints:** `POST /webhooks/monday`, `POST /webhooks/hubspot`
- **Crons:** `* * * * *` = 1-min **incremental** poll (pushes recently-changed HubSpot deals to monday,
  ~60s, so HubSpot→monday is near-instant even without HubSpot webhooks); `*/10 * * * *` = full backup.
- **Latency:** monday→HubSpot = **seconds** (webhooks). HubSpot→monday = **~60s** via the poll, or
  **seconds** once a HubSpot event source is wired (see the HubSpot webhooks section).
- **Live/dry switch:** `vars.DRY_RUN` in `wrangler.jsonc` (`"false"` = live, anything else = dry). Redeploy to apply.

Webhooks and cron share the **same core** (`reconcileRecord` / `createFromMonday` in `src/sync.ts`), so
behaviour is identical whether an update arrives instantly or via the backup sweep.

## What it does

It reconciles four boards (config in `src/config.ts`):

| Board | HubSpot object | Grouped by | Scope |
|---|---|---|---|
| Myla Mestiola Deals `5029480547` | deals (sales_user = Myla) | deal stage | created ≥ 2026-07-01 |
| Unassigned Deals `5029479220` | deals with **no** sales_user | one group | created ≥ 2026-07-01 |
| Myla Company Follow Up `5029639440` | companies (sales_user = Myla) | one group | created ≥ 2026-07-01 |
| Myla Contact Follow Up `5029639630` | contacts (sales_user = Myla) | lead status | created ≥ 2026-07-01 |

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

**Already registered** on Deals board `5029480547`: `change_name`, `change_column_value`, `create_item`,
`item_moved_to_any_group`. List them with `query { webhooks(board_id:5029480547){ id event } }`; register
the same four on Company/Contact boards to make those instant too (the handler routes by board id).

### Create the HubSpot webhooks
> ⚠️ **HubSpot private apps cannot send webhooks.** To make HubSpot→monday instant you need **either**
> a **HubSpot developer (public) app** with webhook subscriptions, **or** HubSpot **Workflows** that POST
> to the endpoint on deal changes. Until one is set up, HubSpot→monday still syncs via the **10-min cron
> backup** (the `/webhooks/hubspot` endpoint is built and tested; it just needs an event source).

**Developer app:** in the app's **Webhooks** tab, set target URL = the HubSpot endpoint and subscribe to:
- `deal.creation`
- `deal.propertyChange` for: **dealname, dealstage, pipeline, hubspot_owner_id, sales_user** (add
  `dealtype`, `hs_priority` if you want those instant too).

**Workflow alternative (no dev app):** create a deal-based workflow triggered on create/property-change,
with a **"Send a webhook"** action → POST to the HubSpot endpoint (body = the deal). Simplest if you have
Operations/Sales Hub.

The webhook body just needs `{ "objectId": <dealId>, "subscriptionType": "deal.propertyChange" }` (an
array or single object) — the Worker fetches the fresh deal itself.

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

## Deploy / secrets

```bash
npm install
npx wrangler deploy
# secrets (one-time): npx wrangler secret put MONDAY_API_TOKEN | HUBSPOT_ACCESS_TOKEN | TRIGGER_SECRET
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

`npx vitest run` — 30 unit tests covering mapping, routing, dedup, and the reconcile direction logic.
