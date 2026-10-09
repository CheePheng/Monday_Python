import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, Env } from "../src/types";

/**
 * THE OWNER NOTICE (owner-notice.ts, OWNER_NOTICE): the Worker decides, monday sends.
 *
 * The board's assignment email fires on "When 上次通知Owner changes". So every claim below is about the ONE
 * thing the Worker does -- write the new owner's email into that column, or not -- and is proven by the
 * presence or absence of that write. The failures that matter most:
 *   - DUPLICATES (the 2 / 5 Oct emails, sent twice half a second apart): one assignment, one write;
 *   - NON-ASSIGNMENTS: HubSpot fires an owner propertyChange for writes that change nothing, and every card that
 *     predates the notice carries no record of who was told -- so only a RECENT assignment may be announced;
 *   - THE WRONG OWNER: HubSpot can change again while monday makes a run wait, so it is read again before writing.
 *
 * The registry fake keeps the real contract in memory -- an owner-checked lock with a hold, and a timed note --
 * because the behaviour under test IS the interaction with it.
 */

const COL = "email_mm7v3xxg";
const CONTACT = "550936454903";
const CARD = "2856378306";
const MYLA = { owner: "1739141284", email: "mylamestiola@dkmeco.com", name: "Myla Mestiola" };
const ELAINE = { owner: "165857269", email: "elainerivera@dkmeco.com", name: "Elaine Rivera" };
const HOUR = 3_600_000;

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
const cards = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const deferred = vi.hoisted(() => ({ spillDeferred: vi.fn() }));
const reg = vi.hoisted(() => {
  const notes = new Map<string, { email: string; at: number }>();
  const locks = new Map<string, { owner: string; at: number; hold: number }>();
  return {
    notes, locks,
    unreadable: { on: false },
    acquireLock: vi.fn(async (_e: unknown, name: string, hold: number, owner: string) => {
      const l = locks.get(name);
      if (l && l.owner !== owner && Date.now() - l.at < l.hold) return false;
      locks.set(name, { owner, at: Date.now(), hold }); return true;
    }),
    releaseLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
      if (locks.get(name)?.owner === owner) locks.delete(name);
    }),
    lastNoticedOwner: vi.fn(async (_e: unknown, c: string) => {
      if (reg.unreadable.on) throw new Error("owner notice unreadable: DO down");
      return notes.get(c) ?? null;
    }),
    rememberNoticedOwner: vi.fn(async (_e: unknown, c: string, email: string, at = Date.now()) => {
      notes.set(c, { email, at }); return true;
    }),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/card-registry", () => cards);
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/deferred-sync", () => deferred);

const { noticeOwner, noticeOwnerChange, queueOwnerNotices, ownerNoticeOn, emailOfCell, lastTold, NOTICE_WINDOW_MS } =
  await import("../src/owner-notice");

const env = { ENABLE_CRM: "true", OWNER_NOTICE: "true", DRY_RUN: "false" } as unknown as Env;
const ctx = {
  ownersById: { [MYLA.owner]: { email: MYLA.email, name: MYLA.name }, [ELAINE.owner]: { email: ELAINE.email, name: ELAINE.name } },
} as unknown as Ctx;

/** The card's 上次通知Owner as monday stores it (with changed_at), and every write made to it. */
let cell: { email: string; text: string; changed_at?: string } | null = null;
let writes: Record<string, unknown>[] = [];
/** HubSpot, now: the contact's owner and when HubSpot assigned it. A queue lets a test change it between reads. */
let hsOwner = MYLA.owner;
let hsAssigned = "";
let hsSequence: { owner: string; assigned: string }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  reg.notes.clear(); reg.locks.clear(); reg.unreadable.on = false;
  cell = null; writes = []; hsSequence = [];
  hsOwner = MYLA.owner; hsAssigned = new Date(Date.now() - 5 * 60_000).toISOString();   // a fresh assignment
  cards.lookupCard.mockResolvedValue(CARD);
  monday.findItemByColumn.mockResolvedValue([{ id: CARD }]);
  deferred.spillDeferred.mockResolvedValue(true);
  monday.gql.mockImplementation(async (_e: unknown, q: string, v: any) => {
    if (q.includes("change_multiple_column_values")) {
      const cv = JSON.parse(v.c);
      writes.push(cv);
      cell = { ...cv[COL], changed_at: new Date().toISOString() };
      return { change_multiple_column_values: { id: v.i } };
    }
    return { items: [{ column_values: [{ text: cell ? `${cell.text} - ${cell.email}` : "", value: cell ? JSON.stringify(cell) : null }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => {
    if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`)) {
      const next = hsSequence.shift();
      if (next) { hsOwner = next.owner; hsAssigned = next.assigned; }
      return { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } };
    }
    return null;
  });
});
afterEach(() => { vi.useRealTimers(); });

const notice = (e: Env = env) => noticeOwner(e, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "test" });
const lastEmail = () => (writes.at(-1)?.[COL] as any)?.email;

// ===================================================================================================
describe("the switch", () => {
  it("only the literal \"true\", and only on the CRM Worker", () => {
    expect(ownerNoticeOn({ ENABLE_CRM: "true", OWNER_NOTICE: "true" })).toBe(true);
    for (const v of ["TRUE", "1", "yes", "", " true", undefined])
      expect(ownerNoticeOn({ ENABLE_CRM: "true", OWNER_NOTICE: v })).toBe(false);
    expect(ownerNoticeOn({ OWNER_NOTICE: "true" })).toBe(false);
  });

  it("off: reads nothing and writes nothing", async () => {
    expect(await notice({ ENABLE_CRM: "true" } as Env)).toBe("off");
    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(monday.gql).not.toHaveBeenCalled();
  });

  it("a spec with no notice column (Accounts) is never noticed", async () => {
    expect(await noticeOwner(env, ctx, CRM_ACCOUNTS, { contactId: CONTACT, why: "t" })).toBe("off");
    expect(monday.gql).not.toHaveBeenCalled();
  });

  it("the column is 上次通知Owner on the CRM Contacts board", () => {
    expect(CRM_CONTACTS.ownerNoticeCol).toBe(COL);
  });
});

// ===================================================================================================
describe("one assignment, one write", () => {
  it("a fresh assignment: writes the owner's email and name into 上次通知Owner, once", async () => {
    expect(await notice()).toBe("notified");
    expect(writes).toEqual([{ [COL]: { email: MYLA.email, text: MYLA.name } }]);
    expect(reg.notes.get(CONTACT)?.email).toBe(MYLA.email);
  });

  it("the same owner again (a redelivery, a second sync write) writes nothing", async () => {
    await notice();
    expect(await notice()).toBe("already");
    expect(await notice()).toBe("already");
    expect(writes).toHaveLength(1);
  });

  /** THE 2 / 5 OCT DUPLICATE, as a race: two runs for one reassignment arrive together. */
  it("two runs at once for the same reassignment produce exactly one write", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const both = Promise.all([notice(), notice()]);
    await vi.advanceTimersByTimeAsync(15_000);
    const outs = await both;
    expect(writes).toHaveLength(1);
    expect(outs.sort()).toEqual(["already", "notified"]);
  });

  it("a reassignment: the column held the previous owner, now the new one is written", async () => {
    cell = { email: MYLA.email, text: MYLA.name };
    hsOwner = ELAINE.owner;
    expect(await notice()).toBe("notified");
    expect(writes).toEqual([{ [COL]: { email: ELAINE.email, text: ELAINE.name } }]);
  });

  it("A -> B -> A notifies every hand-over", async () => {
    await notice();                                   // A
    hsOwner = ELAINE.owner; await notice();           // B
    hsOwner = MYLA.owner; await notice();             // A again
    expect(writes.map(w => (w[COL] as any).email)).toEqual([MYLA.email, ELAINE.email, MYLA.email]);
  });

  it("a column already naming the owner (hiffer's 6 Oct fill) is adopted, not rewritten", async () => {
    cell = { email: MYLA.email.toUpperCase(), text: MYLA.name, changed_at: "2026-10-06T12:07:45Z" };
    expect(await notice()).toBe("already");
    expect(writes).toEqual([]);
    expect(reg.notes.get(CONTACT)?.email).toBe(MYLA.email);
  });
});

// ===================================================================================================
describe("who was told last: the column and the note, whichever was written later", () => {
  const cellOf = (email: string, changed: string) => ({ value: JSON.stringify({ email, text: "x", changed_at: changed }), text: `x - ${email}` });

  /** monday serves a column read a moment stale after our write; the note, saved right after, covers it. */
  it("a note newer than the column speaks (read-after-write lag)", () => {
    expect(lastTold(cellOf(MYLA.email, "2026-10-09T08:00:00Z"), { email: ELAINE.email, at: Date.parse("2026-10-09T08:00:01Z") }))
      .toBe(ELAINE.email);
  });

  /** A note whose save failed after the column write must not swallow a later A -> B -> A. */
  it("a column newer than the note speaks (a failed note save, anyone's later write)", () => {
    expect(lastTold(cellOf(ELAINE.email, "2026-10-09T09:00:00Z"), { email: MYLA.email, at: Date.parse("2026-10-09T08:00:00Z") }))
      .toBe(ELAINE.email);
  });

  it("either alone speaks; neither is nobody", () => {
    expect(lastTold(cellOf(MYLA.email, "2026-10-09T08:00:00Z"), null)).toBe(MYLA.email);
    expect(lastTold({ value: null, text: "" }, { email: MYLA.email, at: 1 })).toBe(MYLA.email);
    expect(lastTold(undefined, null)).toBe("");
  });

  it("end to end: a redelivery that reads the column stale writes nothing", async () => {
    await notice();                                  // writes Myla, note saved after
    cell = null;                                     // monday serves the old (empty) cell
    expect(await notice()).toBe("already");
    expect(writes).toHaveLength(1);
  });
});

// ===================================================================================================
describe("only a NEW assignment is announced", () => {
  /** Myla has owned it since June, and an import re-sets the same owner. */
  it("an owner 'change' on a contact owned for months writes nothing -- remembered, nobody told", async () => {
    hsAssigned = "2026-06-16T08:00:00Z";
    expect(await notice()).toBe("baseline");
    expect(writes).toEqual([]);
    expect(reg.notes.get(CONTACT)?.email).toBe(MYLA.email);
  });

  it("...and the next REAL reassignment (HubSpot stamps a new assignment time) is announced", async () => {
    hsAssigned = "2026-06-16T08:00:00Z";
    await notice();
    hsOwner = ELAINE.owner; hsAssigned = new Date(Date.now() - 60_000).toISOString();
    expect(await notice()).toBe("notified");
    expect(lastEmail()).toBe(ELAINE.email);
  });

  it("no assignment time at all counts as old", async () => {
    hsAssigned = "";
    expect(await notice()).toBe("baseline");
    expect(writes).toEqual([]);
  });

  it("an assignment time given as epoch ms is read too", async () => {
    hsAssigned = String(Date.now() - 60_000);
    expect(await notice()).toBe("notified");
  });

  it("the window is a day: 23 h ago is news, 25 h ago is not", async () => {
    const now = Date.parse("2026-10-09T08:00:00Z");
    hsAssigned = new Date(now - 23 * HOUR).toISOString();
    expect(await noticeOwner(env, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "t" }, () => now)).toBe("notified");
    writes = []; cell = null; reg.notes.clear();
    hsAssigned = new Date(now - 25 * HOUR).toISOString();
    expect(await noticeOwner(env, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "t" }, () => now)).toBe("baseline");
    expect(NOTICE_WINDOW_MS).toBe(24 * HOUR);
  });
});

// ===================================================================================================
describe("HubSpot decides: read inside the lock, and again just before the write", () => {
  it("reads the owner AFTER taking the lock", async () => {
    await notice();
    expect(reg.acquireLock.mock.invocationCallOrder[0]).toBeLessThan(hubspot.hs.mock.invocationCallOrder[0]);
  });

  /** A was set, then corrected to B while monday held the run up: B is announced, A never is. */
  it("an owner corrected between the read and the write: the NEW owner is announced, the old one never", async () => {
    const t = new Date(Date.now() - 60_000).toISOString();
    hsSequence = [{ owner: MYLA.owner, assigned: t }, { owner: ELAINE.owner, assigned: new Date().toISOString() }];
    expect(await notice()).toBe("notified");
    expect(writes).toEqual([{ [COL]: { email: ELAINE.email, text: ELAINE.name } }]);
  });

  it("an owner that keeps changing is left to the queue's retry ('busy'), with nothing written", async () => {
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    hsSequence = [MYLA, ELAINE, MYLA, ELAINE, MYLA, ELAINE].map((p, i) => ({ owner: p.owner, assigned: at(10 - i) }));
    expect(await notice()).toBe("busy");
    expect(writes).toEqual([]);
  });

  it("allows at most one monday rate-limit wait per call inside the lock, and writes with retries=1", async () => {
    await notice();
    for (const c of monday.gql.mock.calls) expect(c[4]).toBe(1);
    const write = monday.gql.mock.calls.find(c => String(c[1]).includes("change_multiple_column_values"))!;
    expect(write[3]).toBe(1);
  });

  it("re-claims the lock right before writing; a run that lost it writes nothing", async () => {
    reg.acquireLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);   // first claim ok, the renewal refused
    expect(await notice()).toBe("busy");
    expect(writes).toEqual([]);
    expect(reg.acquireLock).toHaveBeenCalledTimes(2);
  });

  it("another run holding the lock past the waits: 'busy', and its lock is left alone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    reg.locks.set(`notice:${CONTACT}`, { owner: "someone-else", at: Date.now(), hold: 90_000 });
    const p = notice();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toBe("busy");
    expect(writes).toEqual([]);
    expect(reg.locks.get(`notice:${CONTACT}`)?.owner).toBe("someone-else");
  });

  it("without a cached owner list, the address comes from HubSpot's owner API", async () => {
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) =>
      path.startsWith(`/crm/v3/owners/${MYLA.owner}`) ? { id: MYLA.owner, email: "Myla@DKMECO.com", firstName: "Myla", lastName: "M" }
        : { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } });
    expect(await noticeOwner(env, undefined, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("notified");
    expect(writes).toEqual([{ [COL]: { email: "myla@dkmeco.com", text: "Myla M" } }]);
  });
});

// ===================================================================================================
describe("never a wrong or a half-made notice", () => {
  it("no owner: nothing", async () => {
    hsOwner = "";
    expect(await notice()).toBe("no-owner");
    expect(writes).toEqual([]);
  });

  it("an owner with no email anywhere: nothing", async () => {
    hsOwner = "999";
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) =>
      path.startsWith("/crm/v3/owners/999") ? { id: "999" } : { properties: { hubspot_owner_id: "999", hubspot_owner_assigneddate: hsAssigned } });
    expect(await notice()).toBe("no-email");
    expect(writes).toEqual([]);
  });

  it("no card yet: nothing -- the card's creation queues a notice of its own", async () => {
    cards.lookupCard.mockResolvedValue(null);
    monday.findItemByColumn.mockResolvedValue([]);
    expect(await notice()).toBe("no-card");
    expect(writes).toEqual([]);
  });

  it("DRY_RUN: decides and logs, writes nothing, remembers nothing", async () => {
    expect(await notice({ ...env, DRY_RUN: "true" } as Env)).toBe("dry-run");
    expect(writes).toEqual([]);
    expect(reg.notes.size).toBe(0);
    hsAssigned = "2026-06-16T08:00:00Z";
    expect(await notice({ ...env, DRY_RUN: "true" } as Env)).toBe("baseline");
    expect(reg.notes.size).toBe(0);
  });

  it("FAILS CLOSED when the durable note cannot be read: no write, and the lock is released", async () => {
    reg.unreadable.on = true;
    expect(await notice()).toBe("error");
    expect(writes).toEqual([]);
    expect(reg.locks.size).toBe(0);
  });

  it("a failed write is a log line, never a throw; the lock is released and nothing remembered", async () => {
    monday.gql.mockImplementation(async (_e: unknown, q: string) => {
      if (q.includes("change_multiple_column_values")) throw new Error("monday 500");
      return { items: [{ column_values: [{ text: "", value: null }] }] };
    });
    expect(await notice()).toBe("error");
    expect(reg.locks.size).toBe(0);
    expect(reg.notes.has(CONTACT)).toBe(false);
  });

  it("logs owner ids, never an address", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => { lines.push(String(s)); });
    await notice();
    spy.mockRestore();
    expect(lines.join("\n")).not.toMatch(/@/);
    expect(lines.join("\n")).toContain(`owner=${MYLA.owner}`);
  });
});

// ===================================================================================================
describe("every trigger only enqueues", () => {
  it("queueOwnerNotices puts one notice entry per contact on the queue, deduplicated", async () => {
    await queueOwnerNotices(env, ["1", "2", "1"], "test");
    expect(deferred.spillDeferred).toHaveBeenCalledWith(env,
      [{ type: "contact", id: "1", notice: true }, { type: "contact", id: "2", notice: true }]);
    expect(hubspot.hs).not.toHaveBeenCalled();             // nothing decided inline
  });

  it("off, or nothing to queue: no call at all", async () => {
    await queueOwnerNotices({ ENABLE_CRM: "true" } as Env, ["1"], "test");
    await queueOwnerNotices(env, [], "test");
    expect(deferred.spillDeferred).not.toHaveBeenCalled();
  });

  it("with no queue to hand it to, the notice runs inline (best effort; the address from HubSpot's owner API)", async () => {
    deferred.spillDeferred.mockResolvedValue(false);
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) =>
      path.startsWith(`/crm/v3/owners/${MYLA.owner}`) ? { id: MYLA.owner, email: MYLA.email, firstName: "Myla", lastName: "Mestiola" }
        : { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } });
    await queueOwnerNotices(env, [CONTACT], "test");
    expect(writes).toEqual([{ [COL]: { email: MYLA.email, text: MYLA.name } }]);
  });

  it("noticeOwnerChange (the queue's entry point) resolves the CRM Contacts spec itself", async () => {
    expect(await noticeOwnerChange(env, CONTACT, ctx)).toBe("notified");
    expect(await noticeOwnerChange({ ENABLE_CRM: "true" } as Env, CONTACT)).toBe("off");
    expect(await noticeOwnerChange({ OWNER_NOTICE: "true" } as unknown as Env, CONTACT)).toBe("off");
  });
});

// ===================================================================================================
describe("emailOfCell", () => {
  it("reads the value's email, lowercased", () => {
    expect(emailOfCell(JSON.stringify({ email: "A@B.com", text: "A" }))).toBe("a@b.com");
  });
  it("falls back to the text, where monday shows \"label - address\"", () => {
    expect(emailOfCell(null, "Myla Mestiola - MylaMestiola@dkmeco.com")).toBe("mylamestiola@dkmeco.com");
  });
  it("is empty for an empty cell", () => {
    expect(emailOfCell(null, "")).toBe("");
    expect(emailOfCell("{}", null)).toBe("");
  });
});
