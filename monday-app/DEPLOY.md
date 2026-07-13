# Deploy the Deal Cockpit Board View

## OAuth scopes (Developer Center > OAuth)
`boards:read`, `boards:write`, `me:read`, `users:read`, `updates:read`, `updates:write`

## Build + push (monday-hosted)
1. `cd monday-app && npm install && npm run build`
2. `npm i -g @mondaycom/apps-cli` (once)
3. `mapps init` — paste the app's API token (Developer Center > … > "Show API token")
4. `mapps code:push -d ./dist` — uploads the built bundle to monday hosting
   (ZIP upload still exists but is being deprecated; use `code:push`.)
5. In the app's **Board View** feature, set the hosting URL to the pushed build and add the view.

## Worker secrets (set once, then `wrangler deploy`)
- `MONDAY_APP_SESSION_SECRET` — the secret that verifies the client `sessionToken`.
  **Confirm empirically which secret it is before setting:** in a Board View dev session log
  `await monday.get("sessionToken")`, then verify its HS256 signature (same check as
  `worker/src/session.ts`) against the app's **Client Secret** and its **Signing Secret** — whichever
  verifies is the value to set. (The Worker also runs unsigned-safe: if the secret is unset, `/app/*`
  rejects every session token, so set it before going live.)
- `MONDAY_ACCOUNT_ID` — the DKM monday account id (rejects tokens from any other account). If left unset,
  the account check is skipped (any account whose token verifies is accepted) — set it for production.

```
cd worker
npx wrangler secret put MONDAY_APP_SESSION_SECRET
npx wrangler secret put MONDAY_ACCOUNT_ID
npx wrangler deploy
```

## Add to a board
Open the Hubspot Deals board → **+ (Add view)** → the app's Board View → "Deal Cockpit".

## v1 notes / known follow-ups
- **Presentation is plain HTML under Vibe's `ThemeProvider`** (inherits monday's theme). The list, modal,
  and inputs are lightweight; upgrade to full Vibe `Table`/`Modal`/inputs during live polish (a
  presentational swap — all data flow lives in the tested `src/lib` + `*-client.ts`).
- **Association editing in the modal starts empty** in edit mode (add works; existing contact/company
  links are shown on the board itself). To let users *remove* a link from the modal, hydrate the chips
  from the deal's `linked_item_ids` (needs a small `getCardsByIds` query). Deferred from v1.
- The `/app/*` endpoints accept either a valid session token or `X-Trigger-Secret` (server-to-server);
  the old static `X-App-Secret` browser path was removed.
