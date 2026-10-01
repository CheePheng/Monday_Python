/**
 * HUBSPOT MARKETING EMAILS -> monday Contact timelines: the DECISIONS.
 *
 * Pure, like activities.ts: which Email Events API events become a timeline entry, and what that entry
 * says. The polling, lookups and writes live in marketing-email-poller.ts.
 *
 * WHAT THE SOURCE IS, and why it shapes everything below. HubSpot has no webhook for marketing email
 * events and no v3 per-recipient API, so the only per-recipient record is the LEGACY Email Events API
 * (GET /email/public/v1/events). Each event carries a recipient email address and a `sentBy` pointer
 * to the SENT event it belongs to -- no contact id, no company, no deal. And monday has no update
 * mutation for timeline items, so a "Delivered" entry cannot later become "Opened": every engagement
 * is its own entry.
 *
 * WHAT THE USER DECIDED (2026-09-29/30), each one enforced here:
 *   - ONE entry per SEND, written when DELIVERED or BOUNCE arrives. PROCESSED, SENT, DEFERRED, DROPPED
 *     and SUPPRESSION are never entries: the first two are plumbing, the last three were never delivered.
 *   - The FIRST non-bot OPEN and the FIRST non-bot CLICK (with its URL) of each send -- "first" as the
 *     poller sees it (see entryFor). Later ones add nothing a rep can act on and would multiply the
 *     writes. A click on the unsubscribe/preferences link is never the click shown.
 *   - The recipient's OWN unsubscribe or spam report. A STATUSCHANGE fires just as readily for an
 *     admin's bulk edit, an import, an API call or a bounce, so it is filtered by `source`.
 *   - Contacts cards only; staff never; nothing counts as follow-up.
 *
 * CHECKED AGAINST REAL EVENT JSON on 2026-09-30, once build #14's `content` scope was approved
 * (scripts/probe-marketing-events.mjs, 3 days, 473 events): ids are UUID strings, every event carries
 * sentBy {id, created}, OPEN/CLICK carry filteredEvent, and a STATUSCHANGE carries source + subscriptions
 * but no portalSubscriptionStatus. The API answers NEWEST first, which is why planEntries sorts. Not yet
 * seen in real data: BOUNCE and SPAMREPORT -- those two still follow HubSpot's documentation.
 *
 * A WRITTEN PRECONDITION FOR SWITCHING ON. The campaign-type allowlist below is a guess until real
 * campaigns are read, and a wrong guess fails SILENTLY: every entry of an unlisted type (or of a
 * campaign whose reply has no `type`) is excluded, the cursor moves past it for good, and the poller
 * looks healthy at written=0 failures=0. So ENABLE_MARKETING_EMAIL_SYNC stays "false" until the probe
 * and a dry run (POST /marketing-poll) over a window holding real sends show ZERO `campaign-type:*`
 * and `campaign-unknown` exclusions for the sends the team expects to see.
 */
import { PORTAL_ID } from "./config";
import { normalizeDomain } from "./normalize";

/**
 * The four registry/marker objects. Separate names, not one, because each is its OWN "have I written
 * this?" question: a send, its first open and its first click are all keyed by the same send, and
 * only a distinct object name stops the open's claim from reading as the send's.
 */
export const MARKETING_OBJECTS = {
  send: "marketing_emails",
  open: "marketing_email_opens",
  click: "marketing_email_clicks",
  event: "marketing_email_events",       // unsubscribe / spam report, keyed by the event itself
} as const;
export type MarketingObject = typeof MARKETING_OBJECTS[keyof typeof MARKETING_OBJECTS];
export const MARKETING_OBJECT_NAMES: readonly MarketingObject[] = Object.values(MARKETING_OBJECTS);
export const isMarketingObject = (o: string): boolean => (MARKETING_OBJECT_NAMES as readonly string[]).includes(o);

/** monday's limit for a timeline item's title (and, in practice, its summary). */
export const TITLE_MAX = 250;

/** One Email Events API event, as documented. Every field is optional in practice; see planEntries. */
export interface MarketingEvent {
  id: string;
  created: number;                       // ms since epoch -- when the event happened
  type: string;                          // DELIVERED | BOUNCE | OPEN | CLICK | STATUSCHANGE | SPAMREPORT | ...
  recipient?: string;
  emailCampaignId?: number | string;
  sentBy?: { id: string; created: number };
  filteredEvent?: boolean;               // HubSpot's bot filter; excludeFilteredEvents=true should drop these
  url?: string;                          // CLICK
  category?: string;                     // BOUNCE
  response?: string;                     // BOUNCE / DELIVERED
  status?: string;                       // BOUNCE
  source?: string;                       // STATUSCHANGE
  portalSubscriptionStatus?: string;     // STATUSCHANGE: SUBSCRIBED | UNSUBSCRIBED
  subscriptions?: { id: number | string; status: string }[];   // STATUSCHANGE
  bounced?: boolean;                     // STATUSCHANGE caused by a bounce
}

/** What GET /email/public/v1/campaigns/{id} is documented to return, narrowed to what we use. */
export interface CampaignInfo {
  id: string;
  name?: string;                         // the INTERNAL email name
  subject?: string;
  type?: string;                         // BATCH_EMAIL | AUTOMATED_EMAIL | BLOG_EMAIL | ...
  contentId?: string;                    // the marketing email's content id, for the HubSpot link
}

/**
 * THE CAMPAIGN TYPES A REP SHOULD SEE. An allowlist, because the event stream is not only campaigns:
 * blog and RSS digests, opt-in confirmations, feedback surveys, ticket mail and membership (password
 * reset) mail all flow through the same API, and none of it tells a rep anything about the customer.
 * An unknown type is EXCLUDED and counted, so a new one is noticed in the logs rather than shown blind.
 *
 * Left out: SINGLE_SEND_API / MARKETING_SINGLE_SEND_API (often transactional), LEADFLOW_EMAIL and
 * FOLLOWUP_EMAIL (form follow-ups). Adding one is a one-line change. The 2026-09-30 probe saw only
 * BATCH_EMAIL and AUTOMATED_EMAIL campaigns, plus Meetings-app booking mail whose campaign has no `type`
 * or is id 0 (HubSpot answers 400) -- excluded as campaign-type:none / campaign-unknown, and meant to be.
 */
export const CAMPAIGN_TYPES_SHOWN: ReadonlySet<string> = new Set([
  "BATCH_EMAIL", "AB_EMAIL", "LOCALTIME_EMAIL", "AUTOMATED_EMAIL", "AUTOMATED_AB_EMAIL",
]);

/** A recipient acting for themselves: the preferences page, or the mail client's unsubscribe button. */
const RECIPIENT_SOURCES: ReadonlySet<string> = new Set(["SOURCE_RECIPIENT", "SOURCE_LIST_UNSUBSCRIBE"]);

/**
 * IS THIS STATUS CHANGE THE RECIPIENT UNSUBSCRIBING?
 *
 * Only their own act. An admin unsubscribing a list, an import, an API opt-out, HubSpot's own cleanup
 * and every bounce-driven change all arrive as the same event type, and a bulk admin change would
 * otherwise write one "Unsubscribed" line onto thousands of cards at once. SOURCE_SPAM_REPORT is out
 * too: the SPAMREPORT event itself is shown, and showing both would say it twice. A re-subscribe is
 * not an unsubscribe.
 */
export function showsStatusChange(e: MarketingEvent): boolean {
  if (e.bounced) return false;
  if (!RECIPIENT_SOURCES.has(String(e.source ?? ""))) return false;
  if (String(e.portalSubscriptionStatus ?? "").toUpperCase() === "UNSUBSCRIBED") return true;
  return (e.subscriptions ?? []).some(s => String(s?.status ?? "").toUpperCase() === "UNSUBSCRIBED");
}

/**
 * AN EVENT'S IDENTITY IS (id, created), as HubSpot documents it -- the id alone is not promised to be
 * unique. Both go into the registry key and the marker.
 *
 * Markers must match [A-Za-z0-9_-]+ (what the repair scripts now read). HubSpot's ids are random
 * strings whose alphabet nobody here has seen yet, so an id outside [A-Za-z0-9-] is hex-encoded
 * behind an "_x" prefix. A plain id never contains "_", so an encoded key can never equal a plain one.
 */
export function eventKey(id: string, created: number): string {
  const s = String(id ?? "");
  const safe = /^[A-Za-z0-9-]+$/.test(s)
    ? s
    : "_x" + [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${safe}_${created}`;
}

/** The provenance marker every synced entry ends with -- same shape as activities.ts writes. */
export const markerFor = (object: string, key: string) => `[hubspot:${object}:${key}]`;

/** The event types that can ever become an entry. Everything else is read past. */
const ENTRY_TYPES: ReadonlySet<string> = new Set(["DELIVERED", "BOUNCE", "OPEN", "CLICK", "STATUSCHANGE", "SPAMREPORT"]);

const isBot = (e: MarketingEvent) => e.filteredEvent === true;

/**
 * A CLICK ON THE UNSUBSCRIBE OR PREFERENCES LINK is not engagement: it is the first step of the
 * unsubscribe the STATUSCHANGE entry already reports. As the "first click" it would say, beside the
 * unsubscribe, that the recipient clicked through. Such a click is simply never an entry, so a real
 * click later in the same send is still the first one shown. HubSpot's own paths, as documented.
 */
export function isUnsubscribeLink(url: string | undefined): boolean {
  return /\/hs\/(manage-preferences|preferences-center)|\/_hcms\/preferences|[/?&]unsubscribe|email-preferences/i
    .test(String(url ?? ""));
}

/**
 * The campaigns worth one lookup each: those of events that could become an entry. A status change
 * that is not the recipient's own is dropped whatever its campaign, so it never costs a lookup -- every
 * lookup is one more call that can fail, and a failing one holds the whole slice.
 */
export function campaignIdsNeeded(events: MarketingEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events)
    if (ENTRY_TYPES.has(e.type) && !isBot(e) && e.emailCampaignId != null && e.emailCampaignId !== ""
        && (e.type !== "STATUSCHANGE" || showsStatusChange(e)))
      ids.add(String(e.emailCampaignId));
  return [...ids];
}

/** A contact the business itself is -- never the audience of its own marketing on a rep's board. */
export const STAFF_DOMAINS: readonly string[] = ["dkmeco.com", "dkmeco.com.sg"];

/**
 * STAFF: an owner's own address, or anything on the company's domains (subdomains included).
 *
 * The owner list is the existing rule (activity-sync.ts staffEmails). The domains are the two the user
 * named PLUS `internal` -- the caller passes activity-sync's internalDomains(owners), every non-public
 * domain an owner's address uses, the same set that keeps colleagues' mail off the company Account.
 * Both matter for the same person: a colleague with no HubSpot seat, or an ARCHIVED owner
 * (/crm/v3/owners lists active owners only), is not an owner, yet still receives every internal test
 * send. An owner on a PUBLIC mailbox marks only that address, never its domain (internalDomains drops
 * public providers).
 */
export function isStaffEmail(email: string, ownerEmails: ReadonlySet<string>,
    internal: ReadonlySet<string> = new Set()): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return false;
  if (ownerEmails.has(e)) return true;
  const domain = normalizeDomain(e.split("@")[1] ?? "");
  const ours = (d: string) => domain === d || domain.endsWith("." + d);
  return STAFF_DOMAINS.some(ours) || [...internal].some(ours);
}

/** MARKETING_CANARY_CONTACT_IDS: comma-separated HubSpot contact ids. null = no canary (full scope). */
export function parseCanaryIds(raw: string | undefined): Set<string> | null {
  const ids = String(raw ?? "").split(",").map(s => s.trim()).filter(s => /^\d+$/.test(s));
  return ids.length ? new Set(ids) : null;
}

/** One timeline entry the poller should make, if nothing has made it already. */
export interface PlannedEntry {
  object: MarketingObject;
  id: string;                  // eventKey -- the registry and marker id
  recipientEmail: string;      // lowercased
  timestamp: string;           // ISO: when it HAPPENED (a send: when it was sent), never "now"
  createdMs: number;           // the SOURCE event's time, which is what the watermark advances over
  eventType: string;
  title: string;
  summary: string;
  content: string;
  url?: string;
}

export interface PlanResult {
  entries: PlannedEntry[];
  /** reason -> count, for the poll's log line. Nothing is dropped without being counted. */
  excluded: Record<string, number>;
}

const clip = (s: string, n = TITLE_MAX) => (s.length > n ? s.slice(0, n) : s);
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * THE LINK BACK TO THE EMAIL IN HUBSPOT. UNVERIFIED: the host (app-na2) and the contentId come from the
 * critic's read of the portal; the path is HubSpot's usual email-details shape. Carried in the item's
 * `url` and in the body, and simply omitted when there is no content id.
 */
export function hubspotEmailLink(portalId: string, contentId?: string): string | undefined {
  return contentId ? `https://app-na2.hubspot.com/email/${portalId}/details/${contentId}/performance` : undefined;
}

/**
 * EVENTS -> ENTRIES. Pure, deterministic, oldest first.
 *
 * Sorted by (created, id) before anything else, because the API's own order is unverified and both
 * "first open" and the watermark depend on time order. "First" is enforced twice: here within one
 * window, and by the durable registry across windows (a claimed key reads "have" forever after).
 */
export function planEntries(events: MarketingEvent[], campaigns: ReadonlyMap<string, CampaignInfo | null>,
    opts: { portalId?: string } = {}): PlanResult {
  const portal = String(opts.portalId ?? PORTAL_ID);
  const excluded: Record<string, number> = {};
  const skip = (why: string) => { excluded[why] = (excluded[why] ?? 0) + 1; };
  const entries: PlannedEntry[] = [];
  const seen = new Set<string>();

  const sorted = [...events].sort((a, b) =>
    (a.created - b.created) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

  for (const e of sorted) {
    if (!ENTRY_TYPES.has(e.type)) { skip(`type:${e.type}`); continue; }
    if (isBot(e)) { skip("bot-filtered"); continue; }
    const recipient = String(e.recipient ?? "").trim().toLowerCase();
    if (!recipient || !Number.isFinite(e.created)) { skip("malformed"); continue; }

    const campaign = e.emailCampaignId != null ? campaigns.get(String(e.emailCampaignId)) ?? null : null;
    const ownUnsubscribe = e.type === "STATUSCHANGE";
    if (ownUnsubscribe && !showsStatusChange(e)) { skip("statuschange-not-recipient"); continue; }
    // An unsubscribe is the recipient's own act, so it alone may lack a campaign. But one that DOES name
    // a campaign of a type we never show (a blog/RSS digest, an opt-in mail) is excluded like the send
    // it came from: the allowlist decides which emails exist on the board, and an unsubscribe from an
    // email the board never showed would describe something the rep cannot see.
    if (!ownUnsubscribe) {
      if (!campaign) { skip("campaign-unknown"); continue; }
      if (!CAMPAIGN_TYPES_SHOWN.has(String(campaign.type ?? ""))) { skip(`campaign-type:${campaign.type ?? "none"}`); continue; }
    } else if (campaign && campaign.type && !CAMPAIGN_TYPES_SHOWN.has(String(campaign.type))) {
      skip(`campaign-type:${campaign.type}`); continue;
    }
    // Not marked seen: a real click later in the same send is still the first one shown.
    if (e.type === "CLICK" && isUnsubscribeLink(e.url)) { skip("click-unsubscribe-link"); continue; }

    const sendKey = e.sentBy?.id != null && Number.isFinite(e.sentBy.created)
      ? eventKey(e.sentBy.id, e.sentBy.created) : null;
    let object: MarketingObject, id: string;
    if (e.type === "DELIVERED" || e.type === "BOUNCE") object = MARKETING_OBJECTS.send;
    else if (e.type === "OPEN") object = MARKETING_OBJECTS.open;
    else if (e.type === "CLICK") object = MARKETING_OBJECTS.click;
    else object = MARKETING_OBJECTS.event;
    if (object === MARKETING_OBJECTS.event) id = eventKey(e.id, e.created);
    else if (sendKey) id = sendKey;
    else { skip("no-sentBy"); continue; }     // a send-keyed entry cannot be made first-only without it

    // One per (object, key, recipient): the second DELIVERED, the later opens and clicks stop here.
    const dedupe = `${object}|${id}|${recipient}`;
    if (seen.has(dedupe)) { skip(`not-first:${object}`); continue; }
    seen.add(dedupe);

    entries.push(entryFor(e, object, id, recipient, campaign, portal));
  }
  return { entries, excluded };
}

function entryFor(e: MarketingEvent, object: MarketingObject, id: string, recipient: string,
    campaign: CampaignInfo | null, portal: string): PlannedEntry {
  const subject = String(campaign?.subject ?? "").trim() || "(no subject)";
  /**
   * THE INTERNAL NAME GOES IN THE SUMMARY, not only the body. A timeline row shows title and summary;
   * two same-subject emails (the 09-28 "Your Place Is Confirmed" and its clone, 24 minutes apart) would
   * otherwise read as identical rows -- a "duplicate" to every rep who sees them.
   */
  const named = (status: string) => campaign?.name ? `${status} · ${String(campaign.name).trim()}` : status;
  const url = hubspotEmailLink(portal, campaign?.contentId ? String(campaign.contentId) : undefined);
  const sentMs = e.sentBy && Number.isFinite(e.sentBy.created) ? e.sentBy.created : undefined;
  let title: string, summary: string;
  const extra: string[] = [];
  if (object === MARKETING_OBJECTS.send) {
    title = `Marketing email: ${subject}`;
    summary = named(e.type === "BOUNCE"
      ? `Bounced${e.category ? ` (${e.category})` : ""}`
      : "Delivered");
    if (e.type === "BOUNCE" && e.response) extra.push(`Bounce response: ${String(e.response).slice(0, 300)}`);
  } else if (object === MARKETING_OBJECTS.open) {
    title = `Marketing email opened: ${subject}`;
    /**
     * "Opened", NOT "First open". Claim-once makes this the first open the POLLER saw, which is not
     * always the first that happened: for a send made before the cutover, the live cursor can reach a
     * later open before the backfill reaches the true first one, which then reads "have". Not a
     * duplicate either way -- only the wording would have been wrong.
     */
    summary = named("Opened (bots excluded)");
  } else if (object === MARKETING_OBJECTS.click) {
    title = `Marketing email clicked: ${subject}`;
    summary = named(String(e.url ?? "(no URL)"));
    extra.push(`Clicked: ${String(e.url ?? "(no URL)")}`);
  } else if (e.type === "SPAMREPORT") {
    title = `Marketing email marked as spam: ${subject}`;
    summary = named("Reported as spam");
  } else {
    title = campaign ? `Marketing email unsubscribe: ${subject}` : "Unsubscribed from marketing email";
    summary = named(String(e.portalSubscriptionStatus ?? "").toUpperCase() === "UNSUBSCRIBED"
      ? "Unsubscribed from all email"
      : `Unsubscribed from ${(e.subscriptions ?? []).filter(s => String(s.status).toUpperCase() === "UNSUBSCRIBED").length} subscription type(s)`);
  }
  // The SEND is dated when it was sent; everything else when it happened.
  const whenMs = object === MARKETING_OBJECTS.send && sentMs !== undefined ? sentMs : e.created;
  const lines = [
    "HubSpot marketing email -- automated send, does not count as follow-up",
    campaign?.name ? `Email: ${campaign.name}` : "",
    campaign ? `Subject: ${subject}` : "",
    `To: ${recipient}`,
    campaign?.type ? `Type: ${campaign.type}` : "",
    object !== MARKETING_OBJECTS.send && sentMs !== undefined ? `Sent: ${utc(sentMs)}` : "",
    ...extra,
    url ? `View in HubSpot: ${url}` : "",
    `\n${markerFor(object, id)}`,
  ].filter(Boolean);
  return {
    object, id, recipientEmail: recipient, eventType: e.type,
    timestamp: new Date(whenMs).toISOString(), createdMs: e.created,
    title: clip(title), summary: clip(summary), content: lines.join("\n"), ...(url ? { url } : {}),
  };
}
