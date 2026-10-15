import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * A SYNCED EMAIL MUST CARRY ITS BODY.
 *
 * The historical importer always asked HubSpot for hs_email_text and put it in the timeline entry.
 * The live path did not, so every email imported from history read properly while every email synced
 * after the cutover arrived as a subject line and two addresses — useless to a rep who is never
 * going to open HubSpot again.
 *
 * Two things have to hold, and only asserting the second would let the bug back in: the property has
 * to be REQUESTED from HubSpot, and it has to reach the monday content.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
const retry = vi.hoisted(() => ({ scheduleReconcile: vi.fn(), scheduleIfUnresolved: vi.fn() }));
const reg = vi.hoisted(() => ({
  m2hReservationKey: (t: string) => `act:m2h:${t}`,
  h2mReservationKey: (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`,
  claimActivityToMonday: vi.fn(async () => ({ status: "proceed" })),
  settleActivityToMonday: vi.fn(), unresolvedActivityToMonday: vi.fn(),
  claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
  unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(), releaseActivity: vi.fn(),
  lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(),
  getWatermark: vi.fn(async () => null), setWatermark: vi.fn(),
}));

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/activity-retry", () => retry);

const { syncHubspotActivity } = await import("../src/activity-sync");

const EMAIL = "88117788";
const CONTACT = "553287164663", CARD = "2860111111";
const BODY = "Hi Niels Olesen 我是Wendy，附件是今年续费的报价单，请查收。";

/** every path the sync asked HubSpot for, so the test can assert on what was REQUESTED */
let asked: string[];
let props: Record<string, string>;

const env = { ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2020-01-01T00:00:00Z" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  asked = [];
  props = {
    hs_timestamp: "2026-09-18T02:00:00Z",
    hs_email_subject: "报价单 MQ26203",
    hs_email_direction: "EMAIL",
    hs_email_from_email: "wendywang@dkmeco.com",
    hs_email_to_email: "customer@example.com",
    hubspot_owner_id: "75173140",
    hs_email_text: BODY,
  };

  monday.findItemByColumn.mockImplementation(async (_e: Env, _b: string, _c: string, value: string) =>
    value === CONTACT ? [{ id: CARD }] : []);
  monday.gql.mockImplementation(async (_e: Env, q: string) => {
    if (q.includes("create_timeline_item")) return { create_timeline_item: { id: "tl1" } };
    if (q.includes("timeline_items_page"))
      return { timeline: { timeline_items_page: { cursor: null, timeline_items: [] } } };
    return { items: [{ column_values: [{ text: "" }] }] };
  });

  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    asked.push(path);
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: "customer@example.com" } })) };
    // associations FIRST: "/crm/v4/objects/emails/<id>/associations/contacts" also contains
    // "/emails/<id>", so an object-fetch branch placed first would swallow it and the sync would
    // see no destinations at all.
    if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
    if (path.includes("/associations/")) return { results: [] };
    if (path.includes(`/emails/${EMAIL}`)) return { properties: props };
    return { properties: {} };
  });
});

const contentWritten = () => {
  const call = monday.gql.mock.calls.find(c => String(c[1]).includes("create_timeline_item"));
  return String((call?.[2] as any)?.c ?? (call?.[2] as any)?.content ?? "");
};

describe("a live HubSpot email reaching monday", () => {
  it("ASKS HubSpot for hs_email_text", async () => {
    await syncHubspotActivity(env, "emails", EMAIL);
    const fetched = asked.find(p => p.includes(`/emails/${EMAIL}`));
    expect(fetched, "the sync never fetched the email").toBeDefined();
    expect(fetched).toContain("hs_email_text");
  });

  it("puts the body into the monday timeline content", async () => {
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(contentWritten()).toContain(BODY);
  });

  it("keeps the header lines and the provenance marker alongside the body", async () => {
    await syncHubspotActivity(env, "emails", EMAIL);
    const c = contentWritten();
    expect(c).toContain("From: wendywang@dkmeco.com");
    expect(c).toContain("To: customer@example.com");
    expect(c).toContain("HubSpot owner: 75173140");
    expect(c).toContain(`[hubspot:emails:${EMAIL}]`);
    // the marker is what stops this entry being pushed back to HubSpot as a monday-origin activity
    expect(c.indexOf(BODY)).toBeLessThan(c.indexOf(`[hubspot:emails:${EMAIL}]`));
  });

  it("strips HTML rather than writing tags into the timeline", async () => {
    props.hs_email_text = "<p>Hello&nbsp;<b>there</b></p>";
    await syncHubspotActivity(env, "emails", EMAIL);
    const c = contentWritten();
    expect(c).toContain("Hello there");
    expect(c).not.toContain("<p>");
    expect(c).not.toContain("&nbsp;");
  });

  it("still writes an entry when the email has no body at all", async () => {
    delete props.hs_email_text;
    await syncHubspotActivity(env, "emails", EMAIL);
    const c = contentWritten();
    expect(c).toContain(`[hubspot:emails:${EMAIL}]`);
    expect(c).toContain("From: wendywang@dkmeco.com");
  });

  /** A note must not start picking up an email body, and vice versa — the precedence chain is shared. */
  it("does not disturb the body precedence for other activity types", async () => {
    props = { hs_timestamp: "2026-09-18T02:00:00Z", hs_note_body: "<p>note body</p>",
              hubspot_owner_id: "75173140", hs_email_text: "SHOULD NOT APPEAR" };
    hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
      asked.push(path);
      if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: "rep@dkmeco.com" }] };
      if (path === "/crm/v3/objects/contacts/batch/read")
        return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: "customer@example.com" } })) };
      if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
      if (path.includes("/associations/")) return { results: [] };
      if (path.includes(`/notes/${EMAIL}`)) return { properties: props };
      return { properties: {} };
    });
    await syncHubspotActivity(env, "notes", EMAIL);
    const c = contentWritten();
    expect(c).toContain("note body");
    expect(c).not.toContain("SHOULD NOT APPEAR");
  });
});
