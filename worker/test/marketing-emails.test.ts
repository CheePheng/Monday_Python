import { describe, it, expect } from "vitest";
import {
  planEntries, eventKey, markerFor, MARKETING_OBJECTS, MARKETING_OBJECT_NAMES, CAMPAIGN_TYPES_SHOWN,
  showsStatusChange, isStaffEmail, campaignIdsNeeded, TITLE_MAX, parseCanaryIds, isUnsubscribeLink, type MarketingEvent,
  type CampaignInfo,
} from "../src/marketing-emails";
import { qualifiesAsFollowUp, eligibleForHubspot, MONDAY_ACTIVITY_TYPE } from "../src/activities";

/**
 * MARKETING EMAILS ON CONTACT CARDS -- the pure decisions.
 *
 * Everything here is the answer to "which HubSpot marketing email events become a monday timeline
 * entry, and what does it say?", decided without credentials. The user's decisions (2026-09-29/30)
 * are pinned one test each: one entry per SEND (on DELIVERED or BOUNCE), the FIRST open, the FIRST
 * click with its URL, and the recipient's own unsubscribe or spam report -- nothing else.
 */

const SENT_AT = Date.parse("2026-09-28T06:27:00Z");
const send = { id: "sent-1", created: SENT_AT };
const CAMPAIGNS = new Map<string, CampaignInfo | null>([
  ["100", { id: "100", name: "DKM Final Email 2026 Singapore Executive Dinner 2", subject: "Your Place Is Confirmed",
            type: "BATCH_EMAIL", contentId: "555" }],
  ["200", { id: "200", name: "Blog digest", subject: "This week on the blog", type: "BLOG_EMAIL" }],
  ["300", null],   // looked up, not found
]);
const ev = (over: Partial<MarketingEvent>): MarketingEvent => ({
  id: "e-" + Math.random().toString(36).slice(2), created: SENT_AT + 60_000, type: "DELIVERED",
  recipient: "Customer@Example.com", emailCampaignId: 100, sentBy: send, ...over,
});
const plan = (events: MarketingEvent[]) => planEntries(events, CAMPAIGNS, { portalId: "39939588" });

describe("which events become entries", () => {
  it("DELIVERED makes ONE send entry, dated at the send, not at delivery", () => {
    const r = plan([ev({ type: "DELIVERED" })]);
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0];
    expect(e.object).toBe(MARKETING_OBJECTS.send);
    expect(e.id).toBe(eventKey(send.id, send.created));
    expect(e.timestamp).toBe(new Date(SENT_AT).toISOString());
    expect(e.summary).toBe("Delivered · DKM Final Email 2026 Singapore Executive Dinner 2");
    expect(e.recipientEmail).toBe("customer@example.com");
  });

  it("a BOUNCE makes the send entry too, and says so", () => {
    const r = plan([ev({ type: "BOUNCE", category: "UNKNOWN_USER" })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].object).toBe(MARKETING_OBJECTS.send);
    expect(r.entries[0].summary).toMatch(/^Bounced/);
    expect(r.entries[0].summary).toContain("UNKNOWN_USER");
  });

  it("DELIVERED and BOUNCE for the same send are ONE entry, whichever comes first", () => {
    const r = plan([ev({ type: "BOUNCE", created: SENT_AT + 1 }), ev({ type: "DELIVERED", created: SENT_AT + 2 })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].summary).toMatch(/^Bounced/);
  });

  it.each(["PROCESSED", "SENT", "DEFERRED", "DROPPED", "SUPPRESSION", "PRINT", "FORWARD", "SOMETHING_NEW"])(
    "%s is never an entry -- never delivered, or not worth a line", (type) => {
      const r = plan([ev({ type })]);
      expect(r.entries).toHaveLength(0);
    });

  it("only the FIRST open of a send counts; later opens are silent", () => {
    const r = plan([ev({ type: "OPEN", created: SENT_AT + 10 }), ev({ type: "OPEN", created: SENT_AT + 20 })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].object).toBe(MARKETING_OBJECTS.open);
    expect(r.entries[0].id).toBe(eventKey(send.id, send.created));   // keyed by the SEND: one per send
    expect(r.entries[0].timestamp).toBe(new Date(SENT_AT + 10).toISOString());
  });

  it("the first open is taken in TIME order, however the API happened to return them", () => {
    const r = plan([ev({ type: "OPEN", id: "late", created: SENT_AT + 20 }),
                    ev({ type: "OPEN", id: "early", created: SENT_AT + 10 })]);
    expect(r.entries[0].timestamp).toBe(new Date(SENT_AT + 10).toISOString());
  });

  it("the first click carries its URL, and later clicks are silent", () => {
    const r = plan([ev({ type: "CLICK", url: "https://dkmeco.com/rsvp?x=1", created: SENT_AT + 30 }),
                    ev({ type: "CLICK", url: "https://other", created: SENT_AT + 40 })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].object).toBe(MARKETING_OBJECTS.click);
    expect(r.entries[0].summary).toBe("https://dkmeco.com/rsvp?x=1 · DKM Final Email 2026 Singapore Executive Dinner 2");
    expect(r.entries[0].content).toContain("https://dkmeco.com/rsvp?x=1");
  });

  /** excludeFilteredEvents=true already asks HubSpot to drop bots; this is the belt to that brace. */
  it("a bot-filtered open or click is ignored even if the API returned it", () => {
    const r = plan([ev({ type: "OPEN", filteredEvent: true }), ev({ type: "CLICK", filteredEvent: true })]);
    expect(r.entries).toHaveLength(0);
  });

  it("a spam report is its own entry, keyed by the event's own identity (id + created)", () => {
    const e = ev({ type: "SPAMREPORT", id: "spam-9", created: SENT_AT + 99 });
    const r = plan([e]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].object).toBe(MARKETING_OBJECTS.event);
    expect(r.entries[0].id).toBe(eventKey("spam-9", SENT_AT + 99));
    expect(r.entries[0].title).toMatch(/spam/i);
  });

  it("an open and a click of the same send are two entries with different objects", () => {
    const r = plan([ev({ type: "DELIVERED", created: SENT_AT + 1 }), ev({ type: "OPEN", created: SENT_AT + 2 }),
                    ev({ type: "CLICK", url: "u", created: SENT_AT + 3 })]);
    expect(r.entries.map(e => e.object)).toEqual(
      [MARKETING_OBJECTS.send, MARKETING_OBJECTS.open, MARKETING_OBJECTS.click]);
  });

  it("entries come out oldest first, each carrying its source event's time for the watermark", () => {
    const r = plan([ev({ type: "OPEN", created: SENT_AT + 500 }), ev({ type: "DELIVERED", created: SENT_AT + 100 })]);
    expect(r.entries.map(e => e.createdMs)).toEqual([SENT_AT + 100, SENT_AT + 500]);
  });

  it("an event with no recipient or no usable time is dropped, not guessed at", () => {
    expect(plan([ev({ recipient: "" })]).entries).toHaveLength(0);
    expect(plan([ev({ created: Number.NaN })]).entries).toHaveLength(0);
  });
});

describe("the campaign-type allowlist", () => {
  it("a batch email is shown", () => expect(plan([ev({})]).entries).toHaveLength(1));

  it("a blog digest is NOT a marketing email for a rep's timeline", () => {
    const r = plan([ev({ emailCampaignId: 200 })]);
    expect(r.entries).toHaveLength(0);
    expect(r.excluded["campaign-type:BLOG_EMAIL"]).toBe(1);
  });

  it("an email whose campaign cannot be found is excluded and counted, never shown blind", () => {
    expect(plan([ev({ emailCampaignId: 300 })]).excluded["campaign-unknown"]).toBe(1);
    expect(plan([ev({ emailCampaignId: 999 })]).excluded["campaign-unknown"]).toBe(1);
  });

  it.each(["BLOG_EMAIL", "BLOG_EMAIL_CHILD", "RSS_EMAIL", "RSS_EMAIL_CHILD", "OPTIN_EMAIL", "OPTIN_FOLLOWUP_EMAIL",
           "RESUBSCRIBE_EMAIL", "FEEDBACK_NPS_EMAIL", "FEEDBACK_CES_EMAIL", "FEEDBACK_CUSTOM_EMAIL", "TICKET_EMAIL",
           "MEMBERSHIP_REGISTRATION_EMAIL", "MEMBERSHIP_PASSWORD_RESET_EMAIL"])(
    "%s is excluded", (t) => expect(CAMPAIGN_TYPES_SHOWN.has(t)).toBe(false));

  it.each(["BATCH_EMAIL", "AB_EMAIL", "AUTOMATED_EMAIL", "AUTOMATED_AB_EMAIL", "LOCALTIME_EMAIL"])(
    "%s is shown", (t) => expect(CAMPAIGN_TYPES_SHOWN.has(t)).toBe(true));

  it("only asks for the campaigns of events that could become entries", () => {
    const ids = campaignIdsNeeded([ev({ type: "PROCESSED", emailCampaignId: 1 }), ev({ type: "OPEN", emailCampaignId: 2 }),
      ev({ type: "DELIVERED", emailCampaignId: 2 }), ev({ type: "OPEN", emailCampaignId: 3, filteredEvent: true })]);
    expect(ids).toEqual(["2"]);
  });
});

describe("unsubscribes: only the recipient's own act", () => {
  const unsub = (over: Partial<MarketingEvent>) => ev({ type: "STATUSCHANGE", id: "st-1",
    source: "SOURCE_RECIPIENT", portalSubscriptionStatus: "UNSUBSCRIBED", ...over });

  it("a recipient unsubscribing is shown", () => {
    const r = plan([unsub({})]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].object).toBe(MARKETING_OBJECTS.event);
    expect(r.entries[0].title).toMatch(/unsubscribe/i);
  });

  it("the list-unsubscribe header counts as the recipient too", () =>
    expect(showsStatusChange(unsub({ source: "SOURCE_LIST_UNSUBSCRIBE" }))).toBe(true));

  /** The flood the critic warned about: a bulk admin change must not write to thousands of cards. */
  it.each(["SOURCE_HUBSPOT_CUSTOMER", "SOURCE_IMPORT", "SOURCE_HUBSPOT", "SOURCE_MIGRATION", "SOURCE_HUBSPOT_CLEANUP",
           "SOURCE_NON_DELIVERY_REPORT", "SOURCE_SPAM_REPORT", "SOURCE_KNOWN_SPAM_TRAP", "SOURCE_MTA_RECORD", undefined])(
    "a status change from %s is NOT shown", (source) =>
      expect(showsStatusChange(unsub({ source }))).toBe(false));

  it("a bounce-driven status change is not shown, whatever its source says", () =>
    expect(showsStatusChange(unsub({ bounced: true }))).toBe(false));

  it("a RE-subscribe is not an unsubscribe", () => {
    expect(showsStatusChange(unsub({ portalSubscriptionStatus: "SUBSCRIBED" }))).toBe(false);
    expect(showsStatusChange(unsub({ portalSubscriptionStatus: undefined,
      subscriptions: [{ id: 1, status: "SUBSCRIBED" }] }))).toBe(false);
  });

  it("unsubscribing from one subscription type still counts", () =>
    expect(showsStatusChange(unsub({ portalSubscriptionStatus: undefined,
      subscriptions: [{ id: 7, status: "UNSUBSCRIBED" }] }))).toBe(true));

  it("an unsubscribe with no email attached is still the recipient's act, and still shown", () => {
    const r = plan([unsub({ emailCampaignId: undefined, sentBy: undefined })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].title.length).toBeGreaterThan(0);
  });
});

describe("how an entry reads", () => {
  it("is labelled as MARKETING, because the same campaign also exists as sequence 'HubSpot Email' entries", () => {
    for (const e of plan([ev({ type: "DELIVERED" }), ev({ type: "OPEN" }), ev({ type: "CLICK", url: "u" })]).entries)
      expect(e.title.toLowerCase()).toContain("marketing email");
  });

  it("carries the INTERNAL email name, so two same-subject emails can be told apart", () => {
    const e = plan([ev({})]).entries[0];
    expect(e.content).toContain("Email: DKM Final Email 2026 Singapore Executive Dinner 2");
    expect(e.content).toContain("Subject: Your Place Is Confirmed");
    expect(e.content).toContain("To: customer@example.com");
  });

  it("says it does not count as follow-up", () =>
    expect(plan([ev({})]).entries[0].content).toMatch(/does not count as follow-up/i));

  it("an engagement entry names the send it belongs to", () =>
    expect(plan([ev({ type: "OPEN" })]).entries[0].content).toContain("Sent: 2026-09-28 06:27 UTC"));

  it("links back to the email in HubSpot when the content id is known", () => {
    const e = plan([ev({})]).entries[0];
    expect(e.url).toBe("https://app-na2.hubspot.com/email/39939588/details/555/performance");
    expect(e.content).toContain(e.url!);
  });

  it("ends with its provenance marker, the same shape every other synced entry carries", () => {
    const e = plan([ev({})]).entries[0];
    expect(e.content.trim().split("\n").pop()).toBe(markerFor(e.object, e.id));
  });

  it("truncates the title to monday's 250 characters", () => {
    const long = new Map(CAMPAIGNS);
    long.set("100", { ...CAMPAIGNS.get("100")!, subject: "x".repeat(400) });
    const e = planEntries([ev({})], long, { portalId: "39939588" }).entries[0];
    expect(e.title.length).toBe(TITLE_MAX);
    expect(TITLE_MAX).toBe(250);
  });

  it("truncates a long click URL in the summary, but keeps it whole in the body", () => {
    const url = "https://x/" + "a".repeat(400);
    const e = plan([ev({ type: "CLICK", url })]).entries[0];
    expect(e.summary.length).toBeLessThanOrEqual(250);
    expect(e.content).toContain(url);
  });
});

describe("event identity and markers", () => {
  /** HubSpot documents an event's identity as (id, created); the id alone is not unique. */
  it("the key carries both the id and the created time", () => {
    expect(eventKey("abc-DEF", 1759040820000)).toBe("abc-DEF_1759040820000");
    expect(eventKey("abc", 1)).not.toBe(eventKey("abc", 2));
  });

  it("an id with characters a marker cannot hold is encoded, unambiguously", () => {
    const k = eventKey("a+b/c=", 5);
    expect(k).toMatch(/^[A-Za-z0-9_-]+$/);
    // A plain id never contains "_", so an encoded key can never equal a plain one.
    expect(k.startsWith("_x")).toBe(true);
    expect(eventKey("a+b/c=", 5)).not.toBe(eventKey("a+b/c-", 5));
  });

  it("every marker matches the widened script pattern", () => {
    for (const o of MARKETING_OBJECT_NAMES)
      expect(markerFor(o, eventKey("Z9-x", 42))).toMatch(/^\[hubspot:[a-z_]+:[A-Za-z0-9_-]+\]$/);
  });
});

describe("staff are never the audience", () => {
  const owners = new Set(["rep@dkmeco.com", "boss@gmail.com"]);
  it("an owner's email is staff", () => expect(isStaffEmail("Rep@DKMeco.com", owners)).toBe(true));
  it("dkmeco.com and dkmeco.com.sg are staff domains, owners or not", () => {
    expect(isStaffEmail("anyone@dkmeco.com", new Set())).toBe(true);
    expect(isStaffEmail("anyone@dkmeco.com.sg", new Set())).toBe(true);
    expect(isStaffEmail("anyone@mail.dkmeco.com", new Set())).toBe(true);
  });
  it("a rep on a public mailbox does not make every gmail user staff", () => {
    expect(isStaffEmail("boss@gmail.com", owners)).toBe(true);
    expect(isStaffEmail("customer@gmail.com", owners)).toBe(false);
  });
  it("a customer domain that merely contains ours is not ours", () =>
    expect(isStaffEmail("x@notdkmeco.com", owners)).toBe(false));
});

describe("the canary list", () => {
  it("parses a comma list of HubSpot contact ids, ignoring junk", () => {
    expect(parseCanaryIds(" 123, 456 ,,abc")).toEqual(new Set(["123", "456"]));
    expect(parseCanaryIds(undefined)).toBeNull();
    expect(parseCanaryIds("")).toBeNull();
  });
});

describe("the monday activity type and the follow-up rules", () => {
  it("all four objects are keys of MONDAY_ACTIVITY_TYPE, sharing ONE type", () => {
    const ids = new Set(MARKETING_OBJECT_NAMES.map(o => {
      expect(Object.prototype.hasOwnProperty.call(MONDAY_ACTIVITY_TYPE, o)).toBe(true);
      return MONDAY_ACTIVITY_TYPE[o];
    }));
    expect(ids.size).toBe(1);
  });

  /**
   * PINNED, like HubSpot Task's id: a typo would fail every create_timeline_item, a blank would stop the
   * poller, and HubSpot Email's id would file marketing sends beside the sequence copies of the same mail.
   */
  it("is the live \"HubSpot Marketing Email\" type (created 2026-09-30), never HubSpot Email's", () => {
    for (const o of MARKETING_OBJECT_NAMES) expect(MONDAY_ACTIVITY_TYPE[o]).toBe("e30a1386-45a1-446d-aadf-b033dfd9ac22");
    expect(MONDAY_ACTIVITY_TYPE.marketing_emails).not.toBe(MONDAY_ACTIVITY_TYPE.emails);
  });

  /** A marketing send is the machine's work: it must never silence a reminder (#03/#04/#05). */
  it("NONE of them qualifies as follow-up, even from the owner, outbound, after assignment", () => {
    for (const object of MARKETING_OBJECT_NAMES)
      expect(qualifiesAsFollowUp({ id: "1", object, timestamp: "2026-09-29T00:00:00Z", ownerId: "7",
        direction: "EMAIL" }, { contactOwnerId: "7", ownerAssignedAtMs: 0 })).toBe(false);
  });

  /** THE ECHO GUARD: our marketing entries must never travel back to HubSpot as a Note or Call. */
  it("an entry of the marketing type is never eligible for HubSpot", () => {
    expect(eligibleForHubspot({ custom_activity_id: "11111111-2222-3333-4444-555555555555", type: "note" })).toBe(false);
  });

  it("nor is anything carrying a marketing marker, even if monday reported no custom type for it", () => {
    for (const o of MARKETING_OBJECT_NAMES)
      expect(eligibleForHubspot({ custom_activity_id: null, type: "note",
        content: `Opened\n\n${markerFor(o, eventKey("a", 1))}` })).toBe(false);
    // ...while an ordinary native note is still eligible.
    expect(eligibleForHubspot({ custom_activity_id: null, type: "note", content: "called him" })).toBe(true);
  });
});

/* ============================================================== the review's findings, one by one */

describe("rows a rep can tell apart, and wording that stays true", () => {
  /** The 09-28 "Your Place Is Confirmed" and its clone, 24 minutes apart: the ROW must differ. */
  it("two same-subject emails get different SUMMARIES, not only different bodies", () => {
    const two = new Map(CAMPAIGNS);
    two.set("101", { id: "101", name: "DKM Final Email 2026 Singapore Executive Dinner 2 (clone)",
      subject: "Your Place Is Confirmed", type: "BATCH_EMAIL" });
    const entries = planEntries([ev({ emailCampaignId: 100 }), ev({ emailCampaignId: 101, sentBy: { id: "sent-2", created: SENT_AT } })],
      two, { portalId: "39939588" }).entries;
    expect(entries).toHaveLength(2);
    const [a, b] = entries;
    expect(a.title).toBe(b.title);
    expect(a.summary).not.toBe(b.summary);
    expect(entries.filter(e => e.summary.includes("(clone)"))).toHaveLength(1);
  });

  it("the summary with the name is still clipped to 250", () => {
    const long = new Map(CAMPAIGNS);
    long.set("100", { ...CAMPAIGNS.get("100")!, name: "n".repeat(400) });
    expect(planEntries([ev({})], long, { portalId: "39939588" }).entries[0].summary.length).toBe(TITLE_MAX);
  });

  /** Claim-once makes it the first open the POLLER saw; across the cutover that is not always the first. */
  it("an open says 'Opened', never 'First open'", () => {
    const e = plan([ev({ type: "OPEN" })]).entries[0];
    expect(e.summary).toMatch(/^Opened \(bots excluded\)/);
    expect(e.summary).not.toMatch(/first/i);
  });
});

describe("the allowlist decides which emails exist on the board -- unsubscribes included", () => {
  const unsub = (over: Partial<MarketingEvent>) => ev({ type: "STATUSCHANGE", id: "st-9",
    source: "SOURCE_RECIPIENT", portalSubscriptionStatus: "UNSUBSCRIBED", ...over });

  it("an unsubscribe from a blog/RSS digest (a type never shown) is not shown either", () => {
    const r = plan([unsub({ emailCampaignId: 200 })]);
    expect(r.entries).toHaveLength(0);
    expect(r.excluded["campaign-type:BLOG_EMAIL"]).toBe(1);
  });

  it("but one whose campaign is unknown or absent is still the recipient's act, and shown", () => {
    expect(plan([unsub({ emailCampaignId: 300 })]).entries).toHaveLength(1);
    expect(plan([unsub({ emailCampaignId: undefined })]).entries).toHaveLength(1);
  });

  it("a status change that is not the recipient's own never costs a campaign lookup", () =>
    expect(campaignIdsNeeded([unsub({ source: "SOURCE_IMPORT", emailCampaignId: 9 })])).toEqual([]));
});

describe("a click on the unsubscribe link is not the first click", () => {
  it.each(["https://39939588.hs-sites.com/hs/manage-preferences/unsubscribe?x=1",
           "https://dkmeco.com/hs/preferences-center/en/page?x=1",
           "https://dkmeco.com/_hcms/preferences?x",
           "https://mail.example/email-preferences/abc"])("%s is an unsubscribe link", (u) =>
    expect(isUnsubscribeLink(u)).toBe(true));

  it("a real link is not", () =>
    expect(isUnsubscribeLink("https://luma.com/tdwsdr4r?utm_campaign=x&utm_medium=email")).toBe(false));

  it("skipped, and a REAL click later in the same send is still the one shown", () => {
    const r = plan([ev({ type: "CLICK", url: "https://x.hs-sites.com/hs/manage-preferences/unsubscribe?d=1", created: SENT_AT + 10 }),
                    ev({ type: "CLICK", url: "https://dkmeco.com/rsvp", created: SENT_AT + 20 })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].summary).toMatch(/^https:\/\/dkmeco\.com\/rsvp/);
    expect(r.excluded["click-unsubscribe-link"]).toBe(1);
  });
});

describe("staff includes every company domain the owners use", () => {
  it("a colleague with no seat on another company domain is staff when that domain is internal", () => {
    const internal = new Set(["dkm-group.com"]);
    expect(isStaffEmail("new.hire@dkm-group.com", new Set(), internal)).toBe(true);
    expect(isStaffEmail("x@sub.dkm-group.com", new Set(), internal)).toBe(true);
    expect(isStaffEmail("customer@dkm-group.com.evil.io", new Set(), internal)).toBe(false);
    expect(isStaffEmail("new.hire@dkm-group.com", new Set())).toBe(false);   // not without the domain set
  });
});
