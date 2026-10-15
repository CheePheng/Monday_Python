# hubspot-crm-webhook-sync — HubSpot project app for the monday CRM sync

**STATUS, 2026-09-15: UPLOADED AND INSTALLED.** App ID **52247773** on portal 39939588. The header
below ("NOT UPLOADED") described the state on 2026-09-07 and is kept only because §1's reasoning is
still the record of why this app exists separately. Steps §4.1-§4.6 are DONE.

> **NOT UPLOADED. NOT INSTALLED. Nothing in HubSpot has been created or changed.**
> These are prepared configuration files only. See §4 for the exact commands, which are yours to run.

## 0. Scope change, 2026-09-15 — deals and line items ADDED, reversing §1c

§1c below argues *against* giving this app deals/line-item scopes, on least-privilege grounds, because
"the CRM deployment['s] dependency on Deals" had just been removed. **That is no longer true, and the
paragraph is left standing as the record of the original decision rather than as current guidance.**

What changed: `CRM_DEALS` and `CRM_LINE_ITEMS` joined `CRM_SPECS` in `ea0430a` (2026-09-14), and
`buildCtx` loads a label dictionary for every dictionary any spec in the deployment references. So from
the first deploy carrying those specs — `df2c03db`, 2026-09-15T04:54:59Z — **every contact and company
webhook began reading `/crm/v3/pipelines/deals` and deal property schemas.** The token had no deals
scope, the 403 threw, the throw escaped, and live Contacts/Companies sync stopped on a deploy that
changed nothing about contacts or companies.

Four scopes added, all READ, no write:

```
crm.objects.deals.read   crm.schemas.deals.read
crm.objects.line_items.read   crm.schemas.line_items.read
```

This does NOT start syncing deals. §3 still holds: this app has **no deal and no line-item webhook
subscriptions**, so no deal event is delivered here. The scopes let the Worker build its label
dictionaries; turning deal sync on is a separate, later change that adds subscriptions.

The general lesson, recorded because it cost a live outage: **a spec added to `CRM_SPECS` changes what
the whole deployment reads at startup, not only what that one object does.** `worker/scripts/
check-hubspot-scopes.mjs` now probes every read the specs make — run it before deploying a spec for a
new object.

---

## 1. Why this is a separate app, and not a reuse of `hubspot-monday-webhook-sync`

The reuse question was investigated properly. **Recommendation: DO NOT REUSE.** Three independent
reasons, each sufficient on its own.

### 1a. One app has ONE webhook destination — and it already points at the live WM Worker

`hubspot-monday-webhook-sync/src/app/webhooks/webhooks-hsmeta.json`:

```jsonc
"settings": {
  "targetUrl": "https://hubspot-monday-sync.askada.workers.dev/webhooks/hubspot",
  "maxConcurrentRequests": 10
}
```

`targetUrl` is **a single string under `settings`**, and the subscription list is flat beneath it. There
is no per-subscription destination. So repointing it to the CRM Worker would redirect **every**
subscription — all deal, contact, company **and** line-item events — away from the live WM Worker in one
move. That is a total outage of the running Work Management sync, not a partial one.

### 1b. That app is already subscribed to Contacts and Companies

This is the part that settles it. The existing app is **not** deals-only, despite the name. It carries:

- `object.creation` / `object.deletion` / `object.associationChange` for **contact** and **company**
- 11 contact `propertyChange` subscriptions (`firstname`, `lastname`, `email`, `jobtitle`, `company`,
  `phone`, `hubspot_owner_id`, `hs_lead_status`, `leadsource`, `manufacturer__c`, `sales_user`)
- 11 company `propertyChange` subscriptions
- 12 deal + 7 line-item subscriptions

So the exact events the CRM sync needs are **already being delivered to the WM Worker**. There is no
"add the CRM subscriptions" move available — they exist, pointed elsewhere.

### 1c. Its scopes are read-only, and adding ours would widen the live app

```
oauth, crm.objects.deals.read, crm.objects.contacts.read,
crm.objects.companies.read, crm.objects.line_items.read
```

**Every scope is `.read`.** The CRM Worker needs `contacts.write` and `companies.write` (reverse field
writes, company creation), plus `crm.schemas.*.read` for enum labels and `crm.objects.owners.read` for
the People columns. Adding those here would grant the **live WM integration** write access it does not
currently hold — expanding the blast radius of the very app that serves production.

It also carries `crm.objects.line_items.read`, which the CRM Worker has no use for, and would undo the
least-privilege work that just removed the CRM deployment's dependency on Deals entirely.

### 1d. Shared credential

One `auth.type: "static"` token per app. Rotating it, or changing scopes, would affect both
integrations at once.

### What reuse WOULD have needed

For the record, reuse would only have been safe if the app were unused **and** the platform allowed a
second webhooks component with its own `targetUrl`. Neither holds: the destination is the live Worker,
and the config shape has exactly one `settings.targetUrl`.

## 2. What the investigation confirmed that we can now copy

The existing project is **already the modern platform** — `platformVersion: "2026.03"`, `*-hsmeta.json`
components, `distribution: "private"`, `auth.type: "static"`. So the platform decision needs no
research: this repo contains a working reference for exactly the shape recommended, and the files here
are modelled on it directly rather than guessed from documentation.

*(In my previous report I declined to write these files because I could not validate the schema. That
reservation is resolved — this is a copy of a working config, not an invention.)*

## 3. What differs from the WM app

| | `hubspot-monday-webhook-sync` (existing, live) | `hubspot-crm-webhook-sync` (this, new) |
|---|---|---|
| Destination | `hubspot-monday-sync.askada.workers.dev` | the **CRM** Worker — §4 step 3 |
| Deals | 12 subscriptions | **none** |
| Line items | 7 subscriptions | **none** |
| Contacts | creation, deletion, assoc, 11 props | creation, deletion, assoc, **11 CRM-mapped props** |
| Companies | creation, deletion, assoc, 11 props | creation, deletion, assoc, **14 CRM-mapped props** |
| Scopes | 4 × read, deals + line_items included | contacts/companies **read + write**, schemas, owners. **No deals, no line items** |
| `sales_user` prop subscription | yes | **no** — plays no part in CRM scope |

Contact subscriptions match the CRM spec's mapped fields, plus `event_name`. Company subscriptions add
`domain` (the adoption key), `partner_with`, `zip` and `timezone`.

## 4. Steps — yours to run, in this order

```bash
# 1. Authenticate the CLI to portal 39939588 (once)
npm i -g @hubspot/cli@latest
hs init

# 2. Deploy the CRM Worker FIRST — its URL is not known until then
cd ../worker && npx wrangler deploy        # DRY_RUN=true, WRITE_HUBSPOT=false, ENABLE_CRM=true

# 3. Put the deployed hostname into webhooks-hsmeta.json, replacing REPLACE-AFTER-DEPLOY
#    -> https://hubspot-monday-crm-sync.<subdomain>.workers.dev/webhooks/hubspot
#       (the path is /webhooks/hubspot — PLURAL; see worker/src/index.ts:75)

# 4. Review, then upload. This CREATES the app in HubSpot.
cd ../hubspot-crm-webhook-sync
hs project upload

# 5. Install it to the portal, then copy the static access token and the client secret
#    from the app's auth page.

# 6. Store them on the CRM Worker (never in git):
cd ../worker
npx wrangler secret put HUBSPOT_ACCESS_TOKEN     # the NEW CRM app's static token
npx wrangler secret put HUBSPOT_APP_SECRET       # the CRM app's client secret
npx wrangler secret put MONDAY_API_TOKEN         # ROTATE FIRST — see the secrets runbook
npx wrangler secret put TRIGGER_SECRET           # fresh random value
npx wrangler secret put MONDAY_SIGNING_SECRET    # recommended before Phase B
```

**Do not run `hs project upload` from the `hubspot-monday-webhook-sync` directory.** That would upload
the WM app and could reset its live configuration.

## 5. One consequence to expect during Phase A

Because the existing app already delivers contact and company events to the WM Worker, once this app is
installed **each contact/company change fires two deliveries** — one to the WM Worker, one to the CRM
Worker. That is correct and safe by design: exclusive routing means each Worker resolves only its own
boards, and the WM Worker will treat these events exactly as it does today (most new contacts have no
`sales_user`, so `recInScope` drops them, unchanged).

It does mean **Phase A log inspection must be done on the CRM Worker's logs specifically**
(`wrangler tail` on `hubspot-monday-crm-sync`), not on the portal's webhook delivery view, which will
show both destinations.

## 6. Still outstanding before Phase A

1. Rotate the monday API token and update **both** Workers — see
   `docs/rollout/2026-09-07-crm-hubspot-app-and-secrets.md` §6.
2. Steps 2-6 above.
3. Register the monday board webhooks with the reviewed idempotent registrar (`--plan` first; both CRM
   boards currently have **0** hooks).
4. **Then** pick a fresh future UTC timestamp and set it as the `CRM_CUTOVER_AT` Worker **var** — never
   as a code edit.
