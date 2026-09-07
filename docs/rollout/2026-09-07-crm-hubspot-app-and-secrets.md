# CRM HubSpot runtime app + Worker secrets — prepared, NOT created

**Nothing in this document has been executed.** No HubSpot app, project, scope grant or webhook
subscription has been created or modified. Portal `39939588` is untouched.

---

## 1. Correction to my earlier report

I previously wrote the callback path as `/webhook/hubspot`. **It is `/webhooks/hubspot` — plural.**
Verified at `worker/src/index.ts:74-75`:

```ts
if (url.pathname === "/webhooks/monday") return handleMonday(req, env, ectx);
if (url.pathname === "/webhooks/hubspot") return handleHubspot(req, env, ectx);
```

The singular form would have 404'd every delivery. Both paths below use the plural.

## 2. Which app to build

**A project-based private app with static auth**, per the platform decision — not a legacy Private App,
which is on the sunset path for new creation.

**One caveat I cannot verify from here, and would not guess at:** the exact `hsproject.json` /
app-config schema and field names for private distribution + static auth are version-specific and have
changed more than once. **Generate the scaffold with the CLI rather than hand-writing it:**

```bash
npm i -g @hubspot/cli@latest
hs init                       # authenticate to portal 39939588
hs project create             # choose the private/single-account app template
hs project upload             # first upload creates the app; review before running
```

Then fill in the scopes and webhooks below. I have deliberately **not** committed a config file I
cannot validate against the current schema — a wrong-but-plausible one is worse than none.

**Keep it isolated.** Do not reuse:
- the existing WM private-app token (`HUBSPOT_ACCESS_TOKEN` on the live Worker), or
- the developer app `hubspot-monday-webhook-sync` (App ID 44796352) used for deal webhooks.

## 3. Scopes — least privilege, after the `buildCtx` fix

| Scope | Why it is needed |
|---|---|
| `crm.objects.contacts.read` | read contacts |
| `crm.objects.contacts.write` | reverse field writes (Phase C+; blocked in A/B) |
| `crm.objects.companies.read` | read companies |
| `crm.objects.companies.write` | reverse writes + company create from monday |
| `crm.schemas.contacts.read` | enum labels: `hs_lead_status`, `leadsource` |
| `crm.schemas.companies.read` | enum labels: `type`, `partner_with`, `industry` |
| `crm.objects.owners.read` | owner id ↔ name/email for the People columns |

**Deliberately NOT granted:**

- ❌ `crm.objects.deals.read` / `crm.schemas.deals.read` — **removed by the `buildCtx` refactor.**
  Metadata loading is now driven by the active specs, so the CRM deployment fetches only the five
  contact/company label dictionaries its own fields reference and makes **no call under `/deals`**.
  Asserted in `test/deploy-config.test.ts`.
- ❌ any deals write, line items, quotes, tickets, marketing, associations write *(Phase 1 associations
  are HubSpot→monday only, and the reverse path is code-blocked)*.

> If a future change makes the CRM Worker need a deals scope, treat that as a design question first —
> Deals are out of CRM scope by decision, not by accident.

## 4. Webhook subscriptions

Prefer the **generic** object events, which the existing parser already handles (`webhooks.ts:185-207`
accepts generic `object.*` + `objectTypeId` *and* the legacy `contact.*`/`company.*` forms — **do not
rewrite it**):

| Subscription | Object type |
|---|---|
| `object.creation` | `0-1` contacts |
| `object.propertyChange` | `0-1` contacts |
| `object.deletion` | `0-1` contacts |
| `object.creation` | `0-2` companies |
| `object.propertyChange` | `0-2` companies |
| `object.deletion` | `0-2` companies |

**No deal subscriptions.** A stray deal event would already be a logged no-op
(`reason="deals not in scope for this deployment"`), but it should not be subscribed in the first place.

`propertyChange` may be narrowed to the mapped properties; leaving it broad is also safe — the sync
no-ops on irrelevant changes.

**Callback URL** — known only after the first deploy:

```
https://hubspot-monday-crm-sync.<workers-subdomain>.workers.dev/webhooks/hubspot
```

So the order is: **deploy the Worker → read its URL → set it in the app → then subscribe.**

## 5. Worker secrets

Set with `wrangler secret put <NAME>` (never in `wrangler.jsonc`, never in git):

| Secret | Source | Required? |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | the **new CRM** app's static access token, after install | **yes** |
| `MONDAY_API_TOKEN` | monday API token — **rotate first, see §6** | **yes** |
| `TRIGGER_SECRET` | a fresh random value; guards `/run` | **yes** |
| `HUBSPOT_APP_SECRET` | the CRM app's client secret; enables v3 signature validation | recommended |
| `MONDAY_SIGNING_SECRET` | monday webhook signing secret; verifies webhook JWTs | recommended |
| `MONDAY_ACCOUNT_ID` | restricts session tokens to one monday account | optional |
| `MONDAY_APP_SESSION_SECRET` | only if the Board View app is served from this Worker | not for Phase A |

Signature validation is **skipped when the secret is unset**, so both "recommended" entries mean the
endpoint accepts unsigned posts until they are set. Fine for a dry-run Phase A; set them before Phase B.

## 6. monday token — exposure assessment and rotation

**Assessment (checked, not assumed):**

| Question | Answer |
|---|---|
| Committed to this repo? | **No** — `git log --all -S` finds no commit containing it |
| Present in any tracked file? | **No** — `git grep` finds nothing |
| Where it is | `C:\Users\PC\AppData\Local\Temp\claude\mq.py`, my scratch helper — **outside the repo** |
| Git history rewrite needed? | **No** |

So this is a **local-disk plaintext exposure, not a VCS leak** — materially smaller than it first
sounded. It is still worth rotating: the token sat in cleartext in a temp file, and it carries
`me:write` on account `34747182`.

**Rotation procedure** (do not paste the old or new value into chat, a ticket, or a file):

1. monday → avatar → **Administration → Connections → API** *(or Developers → My Access Tokens)*.
2. **Regenerate / revoke** the personal API v2 token. Regenerating invalidates the old one immediately.
3. Copy the new token straight from the browser into the two places that need it:
   - **CRM Worker:** `cd worker && wrangler secret put MONDAY_API_TOKEN` — paste at the prompt.
   - **Live WM Worker:** the same, in that project. ⚠️ **The live sync uses this token too — rotating
     without updating it breaks the running WM sync.** Update both in the same sitting.
4. Delete the scratch file: `rm "C:\Users\PC\AppData\Local\Temp\claude\mq.py"`.
5. Confirm: the WM Worker's next tick should log no monday auth errors.

> The board-inspection scripts I used during Task 5 read this file. They are throwaway and already
> served their purpose; nothing in the repo depends on it.

## 7. What is still yours to do, in order

1. Rotate the monday token and update **both** Workers (§6).
2. Create the project-based private app, select the §3 scopes, install to portal `39939588`.
3. Copy the static access token and client secret.
4. Deploy the CRM Worker (`DRY_RUN=true`, `WRITE_HUBSPOT=false`, `ENABLE_CRM=true`, no crons).
5. Read the deployed URL and set the §4 callback + subscriptions.
6. Register the monday board webhooks with the reviewed idempotent registrar
   (`--plan` first; both CRM boards currently have **0** hooks).
7. **Then** choose a fresh future UTC timestamp and set it as the `CRM_CUTOVER_AT` Worker var —
   never as a code edit. Create the test records after it.

Steps 1-3 are entirely manual and need your HubSpot/monday admin access. I can do 4-6 on your word.
