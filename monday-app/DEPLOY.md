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

## Secrets — confirmed values (do NOT commit these)
- `MONDAY_ACCOUNT_ID` = `34747182` (Dkmecosystem).
- `MONDAY_APP_SESSION_SECRET` = the app's **Client Secret** (per the account owner). If real session
  tokens 403 after deploy, switch to the **Signing Secret** instead — the Worker verifies whichever
  secret actually signed the token.

## Notes
- **Full Vibe UI** (`@vibe/core`): Vibe `Table` for the list; legacy `Modal` + `ModalFooterButtons` for
  the editor; `TextField` / `Dropdown` / `Search` / `TextArea` / `Chips` for inputs; `Button` for actions.
  (Row-open is an "Open" button per row — Vibe's `TableRow` has no `onClick`.)
- **Association chips hydrate in edit mode** (`getCardsByIds`), so existing contact/company links show and
  can be removed (removal disassociates in HubSpot only when both records already exist there).
- The `/app/*` endpoints accept either a valid session token or `X-Trigger-Secret` (server-to-server);
  the old static `X-App-Secret` browser path was removed.
