import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS } from "../src/config/crm";
import type { Ctx, Env, HsRecord, RunOpts } from "../src/types";

/**
 * A CONTACT REACHES MONDAY ONLY ONCE HUBSPOT GIVES IT AN OWNER (2026-10-09 meeting; CONTACT_CARD_NEEDS_OWNER),
 * and EVERY card the Worker creates on the Contacts board queues an owner notice (OWNER_NOTICE, owner-notice.ts),
 * owned or not: the queue reads HubSpot afresh and decides.
 *
 * Driven through the real ensureCardForRecord -- THE single way any path obtains a card -- so the gate covers
 * the HubSpot webhook, the Deal Cockpit's /app/ensure-card, the association pass and the restore path alike.
 */

const monday = vi.hoisted(() => ({ createItem: vi.fn(), findItemByColumn: vi.fn(), getItem: vi.fn() }));
const cards = vi.hoisted(() => ({ claimCard: vi.fn(), finishCard: vi.fn(), forgetCard: vi.fn() }));
const notice = vi.hoisted(() => ({
  queueOwnerNotices: vi.fn(),
  ownerNoticeOn: (e: { ENABLE_CRM?: string; OWNER_NOTICE?: string }) => e.ENABLE_CRM === "true" && e.OWNER_NOTICE === "true",
}));
vi.mock("../src/monday", () => monday);
vi.mock("../src/card-registry", () => cards);
vi.mock("../src/owner-notice", () => notice);

const { ensureCardForRecord, cardNeedsOwnerOn } = await import("../src/ensure-card");

const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {},
  portalId: 39939588 } as unknown as Ctx;
const on = { ENABLE_CRM: "true", CONTACT_CARD_NEEDS_OWNER: "true", OWNER_NOTICE: "true" } as unknown as Env;
const off = { ENABLE_CRM: "true" } as unknown as Env;

const contact = (owner: string): HsRecord => ({ id: "552000000001", properties: {
  firstname: "New", lastname: "Lead", email: "new.lead@example.com", hubspot_owner_id: owner,
  createdate: "2026-10-09T01:00:00Z", lastmodifieddate: "2026-10-09T01:00:05Z" } });

beforeEach(() => {
  vi.clearAllMocks();
  cards.claimCard.mockResolvedValue({ status: "claimed" });
  monday.findItemByColumn.mockResolvedValue([]);
  monday.createItem.mockResolvedValue("NEWCARD");
  notice.queueOwnerNotices.mockResolvedValue(undefined);
});

describe("owner first", () => {
  it("on: a contact with no owner gets NO card, and the reservation is released", async () => {
    const r = await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact(""), live);
    expect(r).toEqual({ status: "refused", reason: "no owner yet" });
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(cards.forgetCard).toHaveBeenCalledWith(on, CRM_CONTACTS.boardId, "552000000001");
    expect(notice.queueOwnerNotices).not.toHaveBeenCalled();
  });

  it("on: once HubSpot has set an owner, the same contact is carded", async () => {
    const r = await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact("1739141284"), live);
    expect(r).toEqual({ status: "created", itemId: "NEWCARD" });
    expect(monday.createItem).toHaveBeenCalledTimes(1);
  });

  it("an existing card is never refused for lacking an owner (the gate is on BIRTH only)", async () => {
    cards.claimCard.mockResolvedValue({ status: "have", itemId: "OLD" });
    monday.getItem.mockResolvedValue({ id: "OLD" });
    expect(await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact(""), live)).toEqual({ status: "existing", itemId: "OLD" });
  });

  /** Cards already on the board stay: a card a person deleted is RESTORED (restoreOnDelete) whoever owns it. */
  it("restoring a deleted card is not a first card: an ownerless contact's card comes back", async () => {
    const r = await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact(""), { ...live, restore: "552000000001" });
    expect(r).toEqual({ status: "created", itemId: "NEWCARD" });
  });

  it("...but only that record's card: any other ownerless contact the same pass touches is still held back", async () => {
    const r = await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact(""), { ...live, restore: "999" });
    expect(r).toEqual({ status: "refused", reason: "no owner yet" });
  });

  it("off: an ownerless contact is carded, as today", async () => {
    expect((await ensureCardForRecord(off, CRM_CONTACTS, ctx, contact(""), live)).status).toBe("created");
  });

  it("only Contacts carry the rule: an ownerless Account is still carded with the switch on", async () => {
    const company: HsRecord = { id: "40000000001", properties: { name: "Acme", domain: "acme.example",
      createdate: "2026-10-09T01:00:00Z", hs_lastmodifieddate: "2026-10-09T01:00:05Z" } };
    expect(CRM_ACCOUNTS.cardNeedsOwner).toBeUndefined();
    expect((await ensureCardForRecord(on, CRM_ACCOUNTS, ctx, company, live)).status).toBe("created");
  });

  it("the switch: only the literal \"true\", only on the CRM Worker", () => {
    expect(cardNeedsOwnerOn({ ENABLE_CRM: "true", CONTACT_CARD_NEEDS_OWNER: "true" })).toBe(true);
    for (const v of ["TRUE", "1", "", undefined]) expect(cardNeedsOwnerOn({ ENABLE_CRM: "true", CONTACT_CARD_NEEDS_OWNER: v })).toBe(false);
    expect(cardNeedsOwnerOn({ CONTACT_CARD_NEEDS_OWNER: "true" })).toBe(false);
  });
});

describe("the new card queues an owner notice", () => {
  it("after the card exists, for that contact (the queue then decides: a recent assignment is announced)", async () => {
    await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact("1739141284"), live);
    expect(notice.queueOwnerNotices).toHaveBeenCalledWith(on, ["552000000001"], "new card");
    expect(monday.createItem.mock.invocationCallOrder[0]).toBeLessThan(notice.queueOwnerNotices.mock.invocationCallOrder[0]);
  });

  /**
   * N3. The owner in `rec` is only what this pass read: an owner HubSpot set while the card was being made fires an
   * owner-change notice that finds no card yet ("no-card"), so this entry is the only one left to tell them. For a
   * contact that really is unowned the queue answers "no-owner" for the price of one HubSpot read.
   */
  it("for an ownerless contact's new card too (gate off): the queue decides, not the record this pass read", async () => {
    const noticeOnly = { ENABLE_CRM: "true", OWNER_NOTICE: "true" } as unknown as Env;
    expect(await ensureCardForRecord(noticeOnly, CRM_CONTACTS, ctx, contact(""), live)).toEqual({ status: "created", itemId: "NEWCARD" });
    expect(notice.queueOwnerNotices).toHaveBeenCalledWith(noticeOnly, ["552000000001"], "new card");
  });

  it("...and for a restored ownerless contact's card (gate on): the queue finds no owner, or an old assignment", async () => {
    await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact(""), { ...live, restore: "552000000001" });
    expect(notice.queueOwnerNotices).toHaveBeenCalledWith(on, ["552000000001"], "new card");
  });

  it("not with the switch off, nor for an Account (no owner notice on that board)", async () => {
    await ensureCardForRecord({ ENABLE_CRM: "true" } as unknown as Env, CRM_CONTACTS, ctx, contact("1739141284"), live);
    await ensureCardForRecord({ ENABLE_CRM: "true", CONTACT_CARD_NEEDS_OWNER: "true" } as unknown as Env, CRM_CONTACTS, ctx,
      contact("1739141284"), live);
    expect(CRM_ACCOUNTS.ownerNotice).toBeUndefined();
    await ensureCardForRecord(on, CRM_ACCOUNTS, ctx, { id: "4", properties: { name: "Acme", domain: "acme.example",
      createdate: "2026-10-09T01:00:00Z", hubspot_owner_id: "1739141284" } }, live);
    expect(notice.queueOwnerNotices).not.toHaveBeenCalled();
  });

  it("an existing card queues nothing: only a card's birth does", async () => {
    cards.claimCard.mockResolvedValue({ status: "have", itemId: "OLD" });
    monday.getItem.mockResolvedValue({ id: "OLD" });
    await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact("1739141284"), live);
    monday.findItemByColumn.mockResolvedValue([{ id: "ADOPTED" }]);
    cards.claimCard.mockResolvedValue({ status: "claimed" });
    await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact("1739141284"), live);
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(notice.queueOwnerNotices).not.toHaveBeenCalled();
  });

  it("a dry run creates nothing and queues nothing", async () => {
    monday.createItem.mockResolvedValue(null);
    await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact("1739141284"), { ...live, dryRun: true });
    expect(notice.queueOwnerNotices).not.toHaveBeenCalled();
  });

  it("a queue that fails can never fail the card", async () => {
    notice.queueOwnerNotices.mockRejectedValue(new Error("boom"));
    expect(await ensureCardForRecord(on, CRM_CONTACTS, ctx, contact("1739141284"), live))
      .toEqual({ status: "created", itemId: "NEWCARD" });
    expect(cards.forgetCard).not.toHaveBeenCalled();
  });
});
