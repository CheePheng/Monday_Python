/**
 * PRE-FLIGHT GATES FOR THE POST-DEPLOY REPAIR SCRIPTS. Read only: neither gate writes anything, anywhere.
 *
 * Four scripts repair what the old CRM engine got wrong -- dedupe-timeline, catchup-after-deploy,
 * resync-people-columns and repair-phantom-status -- and every one of them is only correct AFTER the
 * 2026-09-23 build is live. Run early, the old engine answers their writes: it moves each People-corrected
 * card back to "Active Contacts" (and the new build is placeOnly, so it never moves them back), reads a
 * phantom status straight back into HubSpot, keeps writing fresh timeline duplicates behind the dedupe,
 * and has no /resync routes for the catch-up at all. Until now that ordering was a sentence in each header.
 * The user deploys by hand, and a resumed session cannot know whether the deploy happened, so a sentence
 * is not enough. These two gates make it a refusal.
 *
 *   requireNewBuild(workerUrl)
 *     POSTs {} to <workerUrl>/resync with NO trigger secret. The new build has the route and refuses the
 *     missing secret: 403, body "forbidden". The old build (live version b5afd7f0) has no such route and
 *     falls through to 404 "not found". Anything other than exactly 403 + "forbidden" -- a 404, a 5xx, a
 *     Cloudflare error page, a network failure -- is a refusal, because "could not tell" must never read
 *     as "deployed". The secret is deliberately NOT sent: the probe must be unable to trigger a resync
 *     even if the route's body parsing changed, and a probe that leaks the secret in a log line would be
 *     worse than no probe.
 *
 *   requireIntegrationToken(mondayToken)
 *     Asks monday who the token acts as and requires user 104118038 ("ask ada") -- the integration user
 *     the Worker itself writes as. The CRM engine tells its own writes from a person's by that user id:
 *     a write from any other user is a HUMAN EDIT, and on the column-level engine a person's edit claims
 *     the column and pushes it to HubSpot. So a repair run with a person's token would not just repair
 *     monday -- it would push every corrected cell into HubSpot as if that person had typed it. A token
 *     that cannot be identified at all is refused for the same reason.
 *
 * Both throw an Error whose message says what to do; the callers let it end the run before any write.
 * Call them only on --apply: a dry run reads, and reading is safe on either build.
 */

/** The CRM Worker, unless worker/.dev.vars overrides it with CRM_WORKER_URL. */
export const DEFAULT_CRM_WORKER_URL = "https://hubspot-monday-crm-sync.askada.workers.dev";

/** The monday user the Worker writes as. Writes from anyone else are treated as a person's edit. */
export const INTEGRATION_USER_ID = "104118038";

export async function requireNewBuild(workerUrl = DEFAULT_CRM_WORKER_URL) {
  const url = `${String(workerUrl || DEFAULT_CRM_WORKER_URL).replace(/\/+$/, "")}/resync`;
  let status = "no response", body = "";
  try {
    // No x-trigger-secret header, on purpose. See the header.
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: "{}", signal: AbortSignal.timeout(30_000) });
    status = r.status;
    body = (await r.text().catch(() => "")).trim();
  } catch (e) {
    status = `network error: ${String(e?.message ?? e).slice(0, 80)}`;
  }
  if (status === 403 && body === "forbidden") return;
  const seen = typeof status === "number" && body ? ` "${body.slice(0, 40)}"` : "";
  throw new Error(`the new CRM build is not live yet (got ${status}${seen}) — deploy first`);
}

export async function requireIntegrationToken(mondayToken) {
  let id = null, why = "";
  try {
    const r = await fetch("https://api.monday.com/v2", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: mondayToken, "API-Version": "2026-07" },
      body: JSON.stringify({ query: "query { me { id } }" }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => null);
    id = j?.data?.me?.id != null ? String(j.data.me.id) : null;
    if (!id) why = `monday answered ${r.status} without a user id`;
  } catch (e) {
    why = `could not reach monday: ${String(e?.message ?? e).slice(0, 80)}`;
  }
  if (id === INTEGRATION_USER_ID) return;
  throw new Error(`MONDAY_API_TOKEN must be the integration user ${INTEGRATION_USER_ID} ("ask ada"), the one the `
    + `Worker writes as; ${id ? `it acts as user ${id}` : why}. A write made with a person's token counts as `
    + `that person's edit, and the CRM engine pushes a person's edit to HubSpot -- so this repair would `
    + `write every corrected cell into HubSpot too. Put the integration token in worker/.dev.vars.`);
}
