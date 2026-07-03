# HubSpot ⇄ monday Sync Worker (live)

An always-on Cloudflare Worker that two-way syncs HubSpot with Myla's monday boards every **2 minutes**.

- **URL:** `https://hubspot-monday-sync.askada.workers.dev`
- **Cron:** `*/2 * * * *` (set in `wrangler.jsonc`)
- **Live/dry switch:** `vars.DRY_RUN` in `wrangler.jsonc` (`"false"` = live, anything else = dry). Redeploy to apply.

## What it does

Per 2-minute tick it reconciles four boards (config in `src/config.ts`):

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

`npx wrangler tail` streams live logs (each tick logs a per-board summary).

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
