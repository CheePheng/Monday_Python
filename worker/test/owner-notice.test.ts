import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, Env } from "../src/types";

/**
 * THE OWNER NOTICE (owner-notice.ts, OWNER_NOTICE): the Worker decides, the board's own workflow notifies.
 *
 * The workflow (monday workflow #06, 5031811440) fires on "When 通知状态 changes to 待通知": it emails the card's Contact
 * owner, writes them into 上次通知Owner and sets 已通知. So every claim below is about the ONE thing the Worker does
 * -- set 通知状态 to 待通知, or not -- and is proven by the presence or absence of that write. And by one absence
 * after EVERY test, whatever it did: the Worker never writes 上次通知Owner, and never anything but 待通知 (see
 * afterEach). The failures that matter most:
 *   - DUPLICATES (the 2 / 5 Oct emails, sent twice half a second apart): one assignment, at most one flag;
 *   - NON-ASSIGNMENTS: HubSpot fires an owner propertyChange for writes that change nothing, and every card that
 *     predates the notice records nobody told -- so only a RECENT assignment may be flagged;
 *   - THE PHANTOM STATUS: an unset status cell can report a label's text, so 通知状态 is judged by its index;
 *   - THE WRONG OWNER: HubSpot can change again while monday makes a run wait, so it is read again before writing;
 *   - THE WRONG RECIPIENT: the workflow mails whoever the card's Contact owner shows, so 待通知 waits until the card
 *     shows HubSpot's owner -- flagged earlier, it would mail the previous owner and the new one would never be told;
 *   - THE SWALLOWED OWNER: a 待通知 still waiting for an EARLIER assignment never covers a newer one.
 *
 * The registry fake keeps the real contract in memory -- an owner-checked lock with a hold, an owner-strict
 * renewal, and a timed note that says whether it was a flag -- because the behaviour under test IS the interaction
 * with it. The monday fake serves the card's three cells the way monday does: 上次通知Owner as an email value,
 * 通知状态 with its index (null when unset) and its changed_at when monday gives one, Contact owner with its
 * persons_and_teams. The Worker's own 待通知 goes through the API and comes back WITHOUT a changed_at here unless a
 * test says monday stamped it (apiStamps). Live, monday does stamp a {label} write (seen 2026-10-09), but bare
 * {"index":N} values with none exist on the board, so the harder, undated case is the default.
 */

const TOLD = "email_mm7v3xxg";     // 上次通知Owner: the workflow's. The Worker only reads it.
const STATUS = "color_mm7zktxc";   // 通知状态: the one column the Worker writes, and only ever with 待通知.
const OWNER_COL = "multiple_person_mm6zap53";   // Contact owner: whom the workflow sends to. Written by the sync.
const PENDING = "待通知";
const DONE = "已通知";
const CONTACT = "550936454903";
const CARD = "2856378306";
const MYLA = { owner: "1739141284", email: "mylamestiola@dkmeco.com", name: "Myla Mestiola", monday: "102443183" };
const ELAINE = { owner: "165857269", email: "elainerivera@dkmeco.com", name: "Elaine Rivera", monday: "102444897" };
const DESMOND = { owner: "100100100", email: "desmond@dkm.test", name: "Desmond", monday: "9100" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn(), getUsersByEmail: vi.fn() }));
const cards = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const deferred = vi.hoisted(() => ({ spillDeferred: vi.fn(), spillDeferredLeftover: vi.fn() }));
const reg = vi.hoisted(() => {
  type Flag = { cycle: string; at: number };
  // A note as stored: the settled assignment, and the Worker's last flag (`flag`). `flagged` is how a note saved
  // while that was the field read; a note with neither was saved before both existed.
  const notes = new Map<string, { cycle: string; at: number; flag?: Flag; flagged?: boolean }>();
  const locks = new Map<string, { owner: string; at: number; hold: number }>();
  return {
    notes, locks,
    unreadable: { on: false },
    /** The flag's own record fails (activity-registry recordNoticeFlag throws). */
    flagRecordFails: { on: false },
    /** The settlement's save fails soft (rememberNoticedCycle logs and answers false). */
    saveFails: { on: false },
    acquireLock: vi.fn(async (_e: unknown, name: string, hold: number, owner: string) => {
      const l = locks.get(name);
      if (l && l.owner !== owner && Date.now() - l.at < l.hold) return false;
      locks.set(name, { owner, at: Date.now(), hold }); return true;
    }),
    // CreateIdempotency.renewLock: only a lock this run still holds -- refused when it is gone or another's.
    renewLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
      const l = locks.get(name);
      if (!l || l.owner !== owner) return false;
      locks.set(name, { ...l, at: Date.now() }); return true;
    }),
    releaseLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
      if (locks.get(name)?.owner === owner) locks.delete(name);
    }),
    // activity-registry lastNoticedCycle, read as the real one reads a stored note.
    lastNoticedCycle: vi.fn(async (_e: unknown, c: string) => {
      if (reg.unreadable.on) throw new Error("owner notice unreadable: DO down");
      const n = notes.get(c);
      if (!n) return null;
      const flag = n.flag ?? (n.flagged === true && n.at > 0 ? { cycle: n.cycle, at: n.at } : undefined);
      return { cycle: n.cycle, at: n.at, ...(flag ? { flag } : {}) };
    }),
    rememberNoticedCycle: vi.fn(async (_e: unknown, c: string, cycle: string, at = Date.now(), flag?: Flag) => {
      if (reg.saveFails.on) return false;
      notes.set(c, { cycle, at, ...(flag ? { flag } : {}) }); return true;
    }),
    recordNoticeFlag: vi.fn(async (_e: unknown, c: string, settled: { cycle: string; at: number } | null, flag: Flag) => {
      if (reg.flagRecordFails.on) throw new Error(`owner notice flag for ${c} not recorded: DO down`);
      notes.set(c, { cycle: settled?.cycle ?? "", at: settled?.at ?? 0, flag });
    }),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/card-registry", () => cards);
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/deferred-sync", () => deferred);

const { noticeOwner, noticeOwnerChange, queueOwnerNotices, runOwnerNoticesInline, ownerNoticeOn, emailOfCell, statusOfCell,
  peopleOfCell, ownerColOf, NOTICE_WINDOW_MS, NOTICE_BUSY_GRACE_MS, NOTICE_ERROR_GRACE_MS, FLAG_STUCK_MS } = await import("../src/owner-notice");

const env = { ENABLE_CRM: "true", OWNER_NOTICE: "true", DRY_RUN: "false" } as unknown as Env;
const dry = { ...env, DRY_RUN: "true" } as Env;
const USERS = { [MYLA.email]: MYLA.monday, [ELAINE.email]: ELAINE.monday, [DESMOND.email]: DESMOND.monday };
const ctx = {
  ownersById: { [MYLA.owner]: { email: MYLA.email, name: MYLA.name }, [ELAINE.owner]: { email: ELAINE.email, name: ELAINE.name },
    [DESMOND.owner]: { email: DESMOND.email, name: DESMOND.name } },
  mondayUsersByEmail: USERS,
} as unknown as Ctx;
const mondayOf = (owner: string) => [MYLA, ELAINE, DESMOND].find(p => p.owner === owner)?.monday;

/** The card as monday serves it: whom the workflow last told (上次通知Owner), 通知状态 with its index and when it
 *  changed, and whom its Contact owner shows -- "synced": HubSpot's owner, as the contact's own sync writes it. */
let told: { email: string; text: string } | null = null;
let status: { text: string; index: number | null; changedAt?: string } | null = null;
let shows: { id: string; kind: string }[] | "synced" = "synced";
/** Every column_values object the Worker sent to monday. */
let writes: Record<string, unknown>[] = [];
/** Whether monday stamps changed_at on the Worker's own API write of 通知状态. Not by default: two API-written
 *  status cells on the live board read just {"index":1} (2026-10-09). */
let apiStamps = false;
/** HubSpot, now: the contact's owner and when HubSpot assigned it. A queue lets a test change it between reads. */
let hsOwner = MYLA.owner;
let hsAssigned = "";
let hsSequence: { owner: string; assigned: string }[] = [];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const cycleOf = (owner: string, assigned: string) => `${owner}|${assigned}`;
const person = (p: { monday: string }) => ({ id: p.monday, kind: "person" });
/** The board's workflow, run: it tells whoever the card's Contact owner shows, records them in 上次通知Owner, and
 *  sets 已通知. `p` is that person. */
const workflowTells = (p: { email: string; name: string }) => {
  told = { email: p.email, text: p.name };
  status = { text: DONE, index: 1, changedAt: new Date().toISOString() };
};
const contactReads = () => hubspot.hs.mock.calls.filter(c => String(c[2]).startsWith(`/crm/v3/objects/contacts/${CONTACT}`)).length;
/** Every [owner-notice] line a run logs. */
const logged = async (run: () => Promise<unknown>) => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => { lines.push(String(s)); });
  try { await run(); } finally { spy.mockRestore(); }
  return lines;
};
/** The card's three cells, as monday serves them right now. */
const cardCells = () => {
  const pt = shows === "synced" ? (mondayOf(hsOwner) ? [{ id: mondayOf(hsOwner)!, kind: "person" }] : []) : shows;
  return [
    { id: TOLD, text: told ? `${told.text} - ${told.email}` : "",
      value: told ? JSON.stringify({ ...told, changed_at: "2026-10-09T08:00:00Z" }) : null },
    { id: STATUS, text: status?.text ?? "",
      value: status?.index != null ? JSON.stringify({ index: status.index, post_id: null,
        ...(status.changedAt ? { changed_at: status.changedAt } : {}) }) : null,
      index: status ? status.index : null },
    { id: OWNER_COL, text: pt.length ? "someone" : "", value: pt.length ? JSON.stringify({ personsAndTeams: pt }) : null,
      persons_and_teams: pt },
  ];
};

beforeEach(() => {
  vi.clearAllMocks();
  reg.notes.clear(); reg.locks.clear(); reg.unreadable.on = false; reg.flagRecordFails.on = false; reg.saveFails.on = false;
  told = null; status = null; shows = "synced"; writes = []; hsSequence = []; apiStamps = false;
  hsOwner = MYLA.owner; hsAssigned = minutesAgo(5);   // a fresh assignment
  cards.lookupCard.mockResolvedValue(CARD);
  monday.findItemByColumn.mockResolvedValue([{ id: CARD }]);
  monday.getUsersByEmail.mockResolvedValue(USERS);
  deferred.spillDeferred.mockResolvedValue(true);
  deferred.spillDeferredLeftover.mockResolvedValue([]);
  monday.gql.mockImplementation(async (_e: unknown, q: string, v: any) => {
    if (q.includes("change_multiple_column_values")) {
      const cv = JSON.parse(v.c);
      writes.push(cv);
      if (cv[STATUS]) status = { text: cv[STATUS].label, index: cv[STATUS].label === PENDING ? 0 : 1,
        ...(apiStamps ? { changedAt: new Date().toISOString() } : {}) };
      return { change_multiple_column_values: { id: v.i } };
    }
    return { items: [{ column_values: cardCells() }] };
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

/** NEVER 上次通知Owner, and never any value but 待通知 in 通知状态: after every test, whatever it did. */
afterEach(() => {
  vi.useRealTimers();
  for (const w of writes) expect(w).toEqual({ [STATUS]: { label: PENDING } });
  expect(writes.some(w => TOLD in w)).toBe(false);
});

const notice = (e: Env = env) => noticeOwner(e, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "test" });
const FLAG = { [STATUS]: { label: PENDING } };

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

  it("a spec with no owner notice (Accounts) is never noticed", async () => {
    expect(CRM_ACCOUNTS.ownerNotice).toBeUndefined();
    expect(await noticeOwner(env, ctx, CRM_ACCOUNTS, { contactId: CONTACT, why: "t" })).toBe("off");
    expect(monday.gql).not.toHaveBeenCalled();
  });

  it("on the CRM Contacts board: 通知状态 is flagged with 待通知 (已通知 is the workflow's), 上次通知Owner is read", () => {
    expect(CRM_CONTACTS.ownerNotice).toEqual({ lastToldCol: TOLD, statusCol: STATUS, pending: PENDING, done: DONE });
  });

  it("...and the Contact owner it checks is the People column the sync writes HubSpot's owner into", () => {
    expect(ownerColOf(CRM_CONTACTS)).toBe(OWNER_COL);
    expect(CRM_CONTACTS.fields.find(f => f.col === OWNER_COL)).toMatchObject({ hs: "hubspot_owner_id", type: "people" });
  });

  it("a spec whose owner it cannot check is never flagged", async () => {
    const noOwnerCol = { ...CRM_CONTACTS, fields: CRM_CONTACTS.fields.filter(f => f.col !== OWNER_COL) };
    expect(await noticeOwner(env, ctx, noOwnerCol, { contactId: CONTACT, why: "t" })).toBe("off");
    expect(monday.gql).not.toHaveBeenCalled();
  });
});

// ===================================================================================================
describe("one assignment, at most one flag", () => {
  it("a fresh assignment nobody was told about: 通知状态 is set to 待通知 on the card -- and nothing else", async () => {
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG]);
    const write = monday.gql.mock.calls.find(c => String(c[1]).includes("change_multiple_column_values"))!;
    expect(write[2]).toMatchObject({ b: CRM_CONTACTS.boardId, i: CARD });
  });

  it("remembers the flagged assignment -- owner and HubSpot's own assignment stamp -- with the time, AS a flag", async () => {
    const now = Date.now();
    expect(await noticeOwner(env, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "t" }, () => now)).toBe("flagged");
    const cycle = cycleOf(MYLA.owner, hsAssigned);
    expect(reg.notes.get(CONTACT)).toEqual({ cycle, at: now, flag: { cycle, at: now } });
  });

  it("...while an assignment settled WITHOUT a write ('baseline', 'already') is remembered with no flag", async () => {
    const now = Date.now();
    hsAssigned = "2026-06-16T08:00:00Z";
    expect(await noticeOwner(env, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "t" }, () => now)).toBe("baseline");
    expect(reg.notes.get(CONTACT)).toEqual({ cycle: cycleOf(MYLA.owner, hsAssigned), at: now });
    hsAssigned = minutesAgo(1); told = { email: MYLA.email, text: MYLA.name };
    expect(await noticeOwner(env, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "t" }, () => now)).toBe("already");
    expect(reg.notes.get(CONTACT)).toEqual({ cycle: cycleOf(MYLA.owner, hsAssigned), at: now });
  });

  it("the same assignment again (a redelivery, a second sync write) writes nothing", async () => {
    await notice();
    expect(await notice()).toBe("waiting");        // its flag still stands: checked again, never written twice
    workflowTells(MYLA);
    expect(await notice()).toBe("already");
    expect(await notice()).toBe("already");
    expect(writes).toHaveLength(1);
  });

  /** monday can serve the status a moment stale right after our write; the note, saved right after, covers it. */
  it("a stale read of 通知状态 right after the write (still empty) flags nothing again: the note answers", async () => {
    await notice();
    status = null;
    expect(await notice()).toBe("already");
    expect(writes).toHaveLength(1);
  });

  /** ...and the note is read BEFORE the waiting flag, so our own 待通知 is this assignment's -- never a "pending"
   *  for an earlier one -- and, while it stands, "waiting": checked again until the workflow has finished it. */
  it("our own 待通知 still waiting for the workflow is 'waiting' -- this assignment's flag, not an earlier one", async () => {
    await notice();
    expect(status).toMatchObject({ text: PENDING, index: 0 });
    expect(await notice()).toBe("waiting");
    expect(writes).toHaveLength(1);
  });

  it("...and once the workflow has run (上次通知Owner = the owner, 已通知), still nothing", async () => {
    await notice();
    workflowTells(MYLA);
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
    expect(outs.sort()).toEqual(["flagged", "waiting"]);   // the second finds the first's flag standing
  });

  it("a reassignment: the workflow told the previous owner, the new owner's assignment is flagged", async () => {
    workflowTells(MYLA);
    hsOwner = ELAINE.owner; hsAssigned = minutesAgo(1);
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(ELAINE.owner, hsAssigned));
  });

  it("A -> B -> A: every hand-over is flagged, each once the workflow has told the one before", async () => {
    expect(await notice()).toBe("flagged"); workflowTells(MYLA);
    hsOwner = ELAINE.owner; hsAssigned = minutesAgo(3);
    expect(await notice()).toBe("flagged"); workflowTells(ELAINE);
    hsOwner = MYLA.owner; hsAssigned = minutesAgo(1);
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG, FLAG, FLAG]);
  });
});

// ===================================================================================================
describe("the workflow sends to the card's Contact owner: flagged only once the card shows HubSpot's owner", () => {
  /**
   * THE 40-CONTACT REASSIGNMENT (owner-notice-race.test.ts). Desmond's contacts move to Myla in one webhook batch;
   * contacts 16-40 had their notices run a wave ahead of their own syncs, so 25 flags would mail Desmond -- the card
   * still showed him -- and the note would then hold Myla's assignment, so nothing would ever tell her.
   */
  it("the card still shows the PREVIOUS owner: 'busy' -- nothing written, nothing remembered, the contact's sync queued", async () => {
    shows = [person(ELAINE)];
    const lines = await logged(async () => { expect(await notice()).toBe("busy"); });
    expect(writes).toEqual([]);
    expect(reg.notes.has(CONTACT)).toBe(false);
    // `ensure`: a sync the queue is running right now counts as coming (deferred-sync-do.ts enqueue).
    expect(deferred.spillDeferred).toHaveBeenCalledWith(env, [{ type: "contact", id: CONTACT, ensure: true }]);
    expect(lines.join("\n")).toContain(`card_shows=person:${ELAINE.monday} wants=person:${MYLA.monday}`);
    expect(reg.locks.size).toBe(0);
  });

  it("...and once its sync has put the new owner on the card, the retry flags it -- for the new owner", async () => {
    shows = [person(ELAINE)];
    expect(await notice()).toBe("busy");
    shows = "synced";
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(MYLA.owner, hsAssigned));
  });

  it("an empty Contact owner is not the owner either: 'busy'", async () => {
    shows = [];
    expect(await notice()).toBe("busy");
    expect(writes).toEqual([]);
  });

  it("only EXACTLY the owner: with someone else beside them, or as a team, it waits for the sync to set it right", async () => {
    shows = [person(MYLA), person(ELAINE)];
    expect(await notice()).toBe("busy");
    shows = [{ id: MYLA.monday, kind: "team" }];
    expect(await notice()).toBe("busy");
    expect(writes).toEqual([]);
  });

  /** reconcile.ts clears the cell (peopleClear) for an owner with no monday user: the workflow has nobody to mail. */
  it("an owner with no monday account is never flagged ('no-user'), and nothing is remembered", async () => {
    const noMyla = { ...ctx, mondayUsersByEmail: { [ELAINE.email]: ELAINE.monday } } as unknown as Ctx;
    shows = [];
    expect(await noticeOwner(env, noMyla, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("no-user");
    expect(writes).toEqual([]);
    expect(reg.notes.has(CONTACT)).toBe(false);
    expect(deferred.spillDeferred).not.toHaveBeenCalled();
  });

  it("without a cached user list, the monday user comes from monday's own, read with one rate-limit wait", async () => {
    const ownersOnly = { ownersById: ctx.ownersById } as unknown as Ctx;
    expect(await noticeOwner(env, ownersOnly, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("flagged");
    expect(monday.getUsersByEmail).toHaveBeenCalledWith(env, 1);
    monday.getUsersByEmail.mockResolvedValue({});
    reg.notes.clear(); status = null;
    expect(await noticeOwner(env, ownersOnly, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("no-user");
    expect(writes).toEqual([FLAG]);
  });

  it("DRY_RUN with the card behind: 'dry-run' -- no retry to wait for a sync that writes nothing -- and no sync queued", async () => {
    shows = [person(ELAINE)];
    expect(await notice(dry)).toBe("dry-run");
    expect(deferred.spillDeferred).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("reads the Contact owner in the same card read, by its PeopleValue", async () => {
    await notice();
    const read = monday.gql.mock.calls.find(c => !String(c[1]).includes("mutation"))!;
    expect(String(read[1])).toContain(`"${OWNER_COL}"`);
    expect(String(read[1])).toContain("... on PeopleValue { persons_and_teams { id kind } }");
    expect(monday.gql.mock.calls.filter(c => !String(c[1]).includes("mutation"))).toHaveLength(1);
  });
});

// ===================================================================================================
describe("nothing twice: told, flagged -- and a waiting flag never covers a newer assignment", () => {
  it("上次通知Owner already naming the owner (hiffer's 6 Oct fill; any case) is 'already': no flag, the cycle remembered", async () => {
    told = { email: MYLA.email.toUpperCase(), text: MYLA.name };
    expect(await notice()).toBe("already");
    expect(writes).toEqual([]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(MYLA.owner, hsAssigned));
  });

  it("a flag waiting for an EARLIER assignment is 'pending': nothing written, NOTHING remembered, retried", async () => {
    status = { text: PENDING, index: 0, changedAt: minutesAgo(1) };
    expect(await notice()).toBe("pending");
    expect(writes).toEqual([]);
    expect(reg.notes.has(CONTACT)).toBe(false);
    expect(await notice()).toBe("pending");      // still waiting: still not settled
    workflowTells(MYLA);                          // the workflow read the card late: it told this owner
    expect(await notice()).toBe("already");
    expect(writes).toEqual([]);
  });

  /** SKEPTIC (b): the workflow had already picked the first owner when the reassignment came. */
  it("a reassignment while the first flag still waits: 'pending' -- and once the workflow has told the FIRST owner, the new one is flagged", async () => {
    expect(await notice()).toBe("flagged");                         // Myla's flag
    const mylas = cycleOf(MYLA.owner, hsAssigned);
    hsOwner = ELAINE.owner; hsAssigned = minutesAgo(1);
    expect(await notice()).toBe("pending");
    expect(reg.notes.get(CONTACT)?.cycle).toBe(mylas);             // Elaine's assignment is NOT remembered
    workflowTells(MYLA);
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG, FLAG]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(ELAINE.owner, hsAssigned));
  });

  it("...mid-send too: 上次通知Owner already names the first owner while 待通知 still stands -- 'pending', then flagged", async () => {
    expect(await notice()).toBe("flagged");
    told = { email: MYLA.email, text: MYLA.name };                  // recorded, 已通知 not yet set
    hsOwner = ELAINE.owner; hsAssigned = new Date().toISOString();
    expect(await notice()).toBe("pending");
    status = { text: DONE, index: 1, changedAt: new Date().toISOString() };
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG, FLAG]);
  });

  it("...or, had the workflow read the card after the sync and told the NEW owner, 'already'", async () => {
    expect(await notice()).toBe("flagged");
    hsOwner = ELAINE.owner; hsAssigned = minutesAgo(1);
    expect(await notice()).toBe("pending");
    workflowTells(ELAINE);
    expect(await notice()).toBe("already");
    expect(writes).toEqual([FLAG]);
  });

  /** SKEPTIC (a): the workflow stopped before its last step (its Outlook step failing, say). */
  it("a STUCK 待通知 (older than FLAG_STUCK_MS) is 'stuck': loud, nothing written, nothing remembered", async () => {
    status = { text: PENDING, index: 0, changedAt: new Date(Date.now() - FLAG_STUCK_MS - 60_000).toISOString() };
    const lines = await logged(async () => { expect(await notice()).toBe("stuck"); });
    expect(writes).toEqual([]);
    expect(reg.notes.has(CONTACT)).toBe(false);
    expect(lines.join("\n")).toMatch(/action=stuck .*did not finish its last flag/);
    // ...nothing was remembered, so if the status is cleared and the assignment's notice runs again (another HubSpot
    // owner event: nothing re-runs it on a status change), it is flagged.
    status = null;
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG]);
  });

  /** Nothing re-runs a notice when 通知状态 changes (an ignored column), so the line says what does recover it. */
  it("the 'stuck' line says how a person recovers the card -- and no stale mailbox", async () => {
    status = { text: PENDING, index: 0, changedAt: new Date(Date.now() - FLAG_STUCK_MS - 60_000).toISOString() };
    const line = (await logged(async () => { expect(await notice()).toBe("stuck"); })).join("\n");
    expect(line).toContain("NOT flagged, NOT remembered and NOT retried, and nothing re-runs it when the status changes");
    expect(line).toContain(`fix the workflow (its Outlook / Lark steps), then on this card clear 通知状态 and set it to ${PENDING} by hand`);
    expect(line).toContain("the workflow then emails whoever the card's Contact owner shows and records them in 上次通知Owner");
    expect(line).not.toMatch(/Gmail|asiadt|@/);
  });

  /** ...and that re-setting 待通知 mails whoever the card shows, so whom the workflow already told is checked FIRST. */
  it("the 'stuck' line says to check 上次通知Owner and the workflow's run history before setting 待通知 again", async () => {
    status = { text: PENDING, index: 0, changedAt: new Date(Date.now() - FLAG_STUCK_MS - 60_000).toISOString() };
    const line = (await logged(async () => { expect(await notice()).toBe("stuck"); })).join("\n");
    expect(line).toContain("To recover: first check this card's 上次通知Owner and the workflow's run history -- whom it already told --");
    expect(line).toContain("setting 待通知 again mails whoever the card's Contact owner shows, even someone already told");
    expect(line.indexOf("first check this card's 上次通知Owner")).toBeLessThan(line.indexOf("by hand"));
  });

  it("...and every later reassignment of a stuck card is 'stuck' too -- never 'pending', never remembered", async () => {
    hsOwner = ELAINE.owner; hsAssigned = minutesAgo(10);
    expect(await notice()).toBe("flagged");                         // Elaine's flag; the workflow never finishes
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + FLAG_STUCK_MS + 60_000);
    hsOwner = MYLA.owner; hsAssigned = new Date().toISOString();
    expect(await notice()).toBe("stuck");
    expect(reg.notes.get(CONTACT)?.cycle.startsWith(ELAINE.owner)).toBe(true);
    expect(writes).toEqual([FLAG]);
  });

  it("a 待通知 that does not say when it changed is taken as fresh: 'pending' (retried, and bounded by the queue)", async () => {
    status = { text: PENDING, index: 0 };
    expect(await notice()).toBe("pending");
    expect(reg.notes.has(CONTACT)).toBe(false);
  });

  /** monday's phantom status: an unset cell can carry a label's text with a null index. It is EMPTY. */
  it("an unset 通知状态 reporting 待通知's text with a NULL index is empty: the assignment IS flagged", async () => {
    status = { text: PENDING, index: null };
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG]);
  });

  it("a done 通知状态 (已通知, from the workflow's last run) does not hold back a new owner", async () => {
    status = { text: DONE, index: 1 };
    told = { email: ELAINE.email, text: ELAINE.name };
    expect(await notice()).toBe("flagged");
  });
});

// ===================================================================================================
/**
 * A FLAG'S AGE WITHOUT changed_at. monday does not always stamp a status value: two cells written through the API
 * read just {"index":1} on the live board (2026-10-09), and the Worker writes 待通知 through the API. With the age
 * taken from changed_at alone, the Worker's own stuck flag was never "stuck" -- it was "pending" until the queue's
 * retries ran out. So when changed_at is missing and the note is the Worker's own FLAG, the note's time is the age.
 */
describe("a flag's age when monday gives no changed_at", () => {
  /** Myla's flag at T0, written the way the API writes it; then Elaine is assigned while it still waits. */
  const flagThenReassign = async (after: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    expect(await notice()).toBe("flagged");
    if (!apiStamps) expect(status).toEqual({ text: PENDING, index: 0 });   // no changedAt: monday did not stamp it
    expect(reg.notes.get(CONTACT)).toMatchObject({ at: T0, flag: { at: T0 } });
    vi.setSystemTime(T0 + after);
    hsOwner = ELAINE.owner; hsAssigned = new Date().toISOString();
    return T0;
  };

  it("the Worker's own flag, older than FLAG_STUCK_MS by the note's time: 'stuck' -- not left to exhaust the retries", async () => {
    await flagThenReassign(FLAG_STUCK_MS + 1_000);
    const lines = await logged(async () => { expect(await notice()).toBe("stuck"); });
    expect(lines.join("\n")).toMatch(/action=stuck .*flag_age_s=301 flag_age_from=note/);
    expect(writes).toEqual([FLAG]);                                   // Myla's only
    expect(reg.notes.get(CONTACT)?.cycle.startsWith(MYLA.owner)).toBe(true);   // Elaine's NOT remembered
  });

  it("...while it is still fresh: 'pending', retried", async () => {
    await flagThenReassign(FLAG_STUCK_MS - 30_000);
    const lines = await logged(async () => { expect(await notice()).toBe("pending"); });
    expect(lines.join("\n")).toMatch(/action=pending .*flag_age_s=270 flag_age_from=note/);
    expect(writes).toEqual([FLAG]);
  });

  it.each(["baseline", "already"] as const)(
    "a note from %j -- a settlement with NO flag -- gives an undated 待通知 no age: 'pending', however old the note", async (how) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const T0 = Date.now();
      if (how === "baseline") hsAssigned = "2026-06-16T08:00:00Z";
      else told = { email: MYLA.email, text: MYLA.name };
      expect(await notice()).toBe(how);
      expect(reg.notes.get(CONTACT)).toMatchObject({ at: T0 });
      expect(reg.notes.get(CONTACT)?.flag).toBeUndefined();
      status = { text: PENDING, index: 0 };                           // a 待通知 the Worker did not write, undated
      vi.setSystemTime(T0 + 60 * 60_000);                             // the note is an hour old
      hsOwner = ELAINE.owner; hsAssigned = new Date().toISOString();
      const lines = await logged(async () => { expect(await notice()).toBe("pending"); });
      expect(lines.join("\n")).toMatch(/action=pending .*flag_age_s=- flag_age_from=-/);
      expect(writes).toEqual([]);
    });

  it("a note saved before `flagged` existed ({cycle, at} only) is not a flag: no age from it -- 'pending'", async () => {
    reg.notes.set(CONTACT, { cycle: cycleOf(MYLA.owner, minutesAgo(60)), at: Date.now() - 60 * 60_000 });
    status = { text: PENDING, index: 0 };
    hsOwner = ELAINE.owner; hsAssigned = minutesAgo(1);
    expect(await notice()).toBe("pending");
    expect(reg.notes.get(CONTACT)?.cycle.startsWith(MYLA.owner)).toBe(true);
  });

  it("changed_at, when monday gives one, still wins over the note's time -- both ways", async () => {
    const T0 = await flagThenReassign(FLAG_STUCK_MS + 60_000);         // by the note: six minutes old
    status = { text: PENDING, index: 0, changedAt: new Date(Date.now() - 60_000).toISOString() };   // by monday: one
    expect(await notice()).toBe("pending");
    const mylas = reg.notes.get(CONTACT)!.cycle;
    reg.notes.set(CONTACT, { cycle: mylas, at: Date.now() - 1_000, flag: { cycle: mylas, at: Date.now() - 1_000 } });
    status = { text: PENDING, index: 0, changedAt: new Date(T0 - 60_000).toISOString() };          // by monday: old
    expect(await notice()).toBe("stuck");
  });

  it("...and monday stamping the Worker's own write: the same verdicts, by changed_at", async () => {
    apiStamps = true;
    await flagThenReassign(FLAG_STUCK_MS + 1_000);
    expect(status?.changedAt).toBeDefined();
    const lines = await logged(async () => { expect(await notice()).toBe("stuck"); });
    expect(lines.join("\n")).toMatch(/flag_age_from=changed_at/);
  });
});

// ===================================================================================================
/**
 * WHICH FLAG A STANDING 待通知 CAN BE (reviewed 2026-10-09, F2). The Worker's last flag time dates an undated
 * 待通知 only while that flag can be the one standing: once 上次通知Owner names its owner the workflow finished it,
 * and a 待通知 standing now is a LATER one -- the Worker's own write that lost its response, a note save that
 * failed, someone else's write through the API -- of unknown age. Taking the old flag's time for it called a
 * 10-second-old flag "stuck", which is final: its advice re-mailed the owner, and a corrected owner was never told.
 * And the Worker records its flag BEFORE the write, so that flag is dated even when nothing after the write lands.
 */
describe("a standing 待通知 is dated only by a flag it can be", () => {
  /** monday applies the write -- and the response never comes back (gql has retries=1: no second write). */
  const loseNextResponse = () => {
    const real = monday.gql.getMockImplementation()!;
    monday.gql.mockImplementation(async (e: unknown, q: string, v: any) => {
      if (!q.includes("change_multiple_column_values")) return real(e, q, v);
      await real(e, q, v);
      monday.gql.mockImplementation(real);
      throw new Error("network connection lost");
    });
  };
  /** Myla's flag, finished by the workflow `daysAgo` days ago; now Elaine is assigned. */
  const mylaToldThenElaine = async (daysAgo: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const D0 = Date.now();
    expect(await notice()).toBe("flagged");
    workflowTells(MYLA);
    vi.setSystemTime(D0 + daysAgo * DAY);
    hsOwner = ELAINE.owner; hsAssigned = new Date().toISOString();
  };

  it("a write that landed but lost its response, after an old flag the workflow finished: the retry is 'pending', dated by its own flag", async () => {
    await mylaToldThenElaine(3);
    loseNextResponse();
    expect(await notice()).toBe("error");                           // Elaine's 待通知 landed; nothing settled
    expect(status).toMatchObject({ text: PENDING, index: 0 });
    vi.setSystemTime(Date.now() + 10_000);                          // the queue's retry
    const lines = await logged(async () => { expect(await notice()).toBe("pending"); });   // was: a final "stuck", 3 days "old"
    expect(lines.join("\n")).toMatch(/action=pending .*flag_owner=165857269 flag_told=no flag_age_s=10 flag_age_from=note/);
    workflowTells(ELAINE);
    expect(await notice()).toBe("already");
    expect(writes).toEqual([FLAG, FLAG]);
  });

  it("...and a correction inside the workflow's run (Elaine -> Desmond): 'pending', then Desmond is flagged once it finishes", async () => {
    await mylaToldThenElaine(3);
    loseNextResponse();
    expect(await notice()).toBe("error");                           // the workflow picks the card's owner: Elaine
    vi.setSystemTime(Date.now() + 8_000);
    hsOwner = DESMOND.owner; hsAssigned = new Date().toISOString(); // corrected; the card shows Desmond now
    expect(await notice()).toBe("pending");                         // was "stuck": Desmond never told
    workflowTells(ELAINE);                                          // it mails the one it picked
    expect(await notice()).toBe("flagged");                         // ...and now Desmond's assignment is flagged
    expect(writes).toEqual([FLAG, FLAG, FLAG]);
    expect(reg.notes.get(CONTACT)?.cycle.startsWith(DESMOND.owner)).toBe(true);
  });

  it("a settlement save that failed after a landed flag, then a duplicate event: 'pending' on that fresh flag", async () => {
    await mylaToldThenElaine(1);
    reg.saveFails.on = true;
    expect(await notice()).toBe("flagged");                         // written; the settlement's save failed (soft)
    reg.saveFails.on = false;
    vi.setSystemTime(Date.now() + 5_000);
    const lines = await logged(async () => { expect(await notice()).toBe("pending"); });   // was "stuck", a day "old"
    expect(lines.join("\n")).toMatch(/flag_age_s=5 flag_age_from=note/);
    expect(writes).toEqual([FLAG, FLAG]);
  });

  it("a 待通知 someone else wrote through the API after an old Worker flag the workflow finished: age unknown -- 'pending'", async () => {
    await mylaToldThenElaine(2);
    status = { text: PENDING, index: 0 };                          // just now, through the API: no changed_at
    const lines = await logged(async () => { expect(await notice()).toBe("pending"); });   // was "stuck" at once
    expect(lines.join("\n")).toMatch(new RegExp(`flag_owner=${MYLA.owner} flag_told=yes flag_age_s=- flag_age_from=-`));
    expect(writes).toEqual([FLAG]);
    expect(reg.notes.get(CONTACT)?.cycle.startsWith(MYLA.owner)).toBe(true);   // Elaine's NOT remembered
  });

  it("the flag is dated BEFORE its write: a landed flag whose response was lost is 'stuck' once the workflow has not finished it in time", async () => {
    await mylaToldThenElaine(1);
    loseNextResponse();
    expect(await notice()).toBe("error");
    expect(reg.notes.get(CONTACT)?.flag?.cycle.startsWith(ELAINE.owner)).toBe(true);
    vi.setSystemTime(Date.now() + FLAG_STUCK_MS + 1_000);           // the workflow never finishes it
    const lines = await logged(async () => { expect(await notice()).toBe("stuck"); });
    expect(lines.join("\n")).toMatch(/flag_told=no flag_age_s=301 flag_age_from=note/);
    expect(writes).toEqual([FLAG, FLAG]);
  });

  it("the flag's record is written before 通知状态, and the settlement after it", async () => {
    expect(await notice()).toBe("flagged");
    const write = monday.gql.mock.calls.findIndex(c => String(c[1]).includes("change_multiple_column_values"));
    const writeOrder = monday.gql.mock.invocationCallOrder[write];
    expect(reg.recordNoticeFlag.mock.invocationCallOrder[0]).toBeLessThan(writeOrder);
    expect(reg.rememberNoticedCycle.mock.invocationCallOrder[0]).toBeGreaterThan(writeOrder);
  });
});

// ===================================================================================================
/**
 * EVERY FLAG IS CHECKED (reviewed 2026-10-09). The likeliest failure of option A is the workflow itself -- switched
 * off, out of quota, its Outlook connection lapsed -- and that used to read "flagged", then "already" for every
 * later run of the assignment: nothing said the owner was never told. The queue now runs a flagged notice once
 * more (deferred-owner-notice.test.ts), and a run that finds THIS assignment's own 待通知 still standing says so:
 * "waiting" while it is fresh, "stuck" once it is older than FLAG_STUCK_MS.
 */
describe("every flag is checked: the workflow finishing it, or not", () => {
  it("the check after the flag: 'waiting' while the workflow has not finished it, 'already' once it has -- nothing written", async () => {
    expect(await notice()).toBe("flagged");
    expect(await notice()).toBe("waiting");
    workflowTells(MYLA);
    expect(await notice()).toBe("already");
    expect(writes).toEqual([FLAG]);
  });

  it("a flag the workflow never finishes is 'stuck' past FLAG_STUCK_MS -- its owner may not have been told -- and stays so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await notice()).toBe("flagged");
    vi.setSystemTime(Date.now() + FLAG_STUCK_MS + 1_000);
    const line = (await logged(async () => { expect(await notice()).toBe("stuck"); })).join("\n");
    expect(line).toMatch(/action=stuck .*flag_age_s=301 flag_age_from=note/);
    expect(line).toContain("this owner may NOT have been told");
    expect(line).toContain("first check this card's 上次通知Owner and the workflow's run history");
    vi.setSystemTime(Date.now() + HOUR);                            // a redelivery an hour on: never a bare "already"
    expect(await notice()).toBe("stuck");
    expect(writes).toEqual([FLAG]);
  });

  /** The workflow mailed and recorded the owner, but never reached 已通知: the card is wedged for every later owner. */
  it("told, but 已通知 never set: 'waiting', then 'stuck' -- remembered as told; recover with 已通知 by hand, NOT 待通知", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await notice()).toBe("flagged");
    told = { email: MYLA.email, text: MYLA.name };                  // recorded; 通知状态 still 待通知
    expect(await notice()).toBe("waiting");
    vi.setSystemTime(Date.now() + FLAG_STUCK_MS + 1_000);
    const line = (await logged(async () => { expect(await notice()).toBe("stuck"); })).join("\n");
    expect(line).toContain("the workflow did not reach its last step (已通知)");
    expect(line).toContain(`set this card's 通知状态 to ${DONE} by hand -- NOT to ${PENDING}, which would mail this owner again`);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(MYLA.owner, hsAssigned));
    expect(writes).toEqual([FLAG]);
  });

  it("a 待通知 that is not this assignment's own flag is not checked here: a settled assignment is 'already'", async () => {
    hsAssigned = "2026-06-16T08:00:00Z";
    expect(await notice()).toBe("baseline");
    hsAssigned = minutesAgo(1);
    reg.notes.set(CONTACT, { cycle: cycleOf(MYLA.owner, hsAssigned), at: Date.now() });   // settled without a flag
    status = { text: PENDING, index: 0 };
    expect(await notice()).toBe("already");
    expect(writes).toEqual([]);
  });

  /**
   * A SETTLEMENT THAT WRITES NOTHING KEEPS THE FLAG (M4 / M5). Day 0: Myla's flag, and the workflow's Outlook step
   * fails. 25 h later an import re-sets the same owner: "baseline". That used to rewrite the note with no flag, so
   * when Elaine was assigned the stuck 待通知 had no age -- "pending" until the queue gave up -- never "stuck".
   */
  it("a 'baseline' of the same assignment keeps the Worker's flag: the next owner still finds the stuck flag dated -- 'stuck'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    expect(await notice()).toBe("flagged");                         // the workflow never finishes it
    vi.setSystemTime(T0 + 25 * HOUR);
    expect(await notice()).toBe("baseline");                        // the same owner re-set: an old assignment now
    expect(reg.notes.get(CONTACT)?.flag).toMatchObject({ at: T0 });
    hsOwner = ELAINE.owner; hsAssigned = new Date().toISOString();
    const lines = await logged(async () => { expect(await notice()).toBe("stuck"); });
    expect(lines.join("\n")).toMatch(/flag_told=no flag_age_s=90000 flag_age_from=note/);
    expect(writes).toEqual([FLAG]);
  });

  /** ...and a no-write settlement of ANOTHER assignment -- rewriting the note -- carries the flag over. */
  it("a 'baseline' of a later assignment carries the Worker's flag over: the stuck flag stays dated for the owner after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    expect(await notice()).toBe("flagged");                         // Myla's; the workflow never finishes it
    vi.setSystemTime(T0 + HOUR);
    hsOwner = ELAINE.owner; hsAssigned = new Date().toISOString();
    expect(await notice()).toBe("stuck");                           // Elaine: behind Myla's stuck flag, not remembered
    vi.setSystemTime(T0 + 26 * HOUR);                               // a no-op owner write: Elaine's stamp, now old
    expect(await notice()).toBe("baseline");
    expect(reg.notes.get(CONTACT)).toMatchObject({ cycle: cycleOf(ELAINE.owner, hsAssigned), flag: { at: T0 } });
    hsOwner = DESMOND.owner; hsAssigned = new Date().toISOString();
    const lines = await logged(async () => { expect(await notice()).toBe("stuck"); });   // was "pending": no age left
    expect(lines.join("\n")).toMatch(new RegExp(`flag_owner=${MYLA.owner} flag_told=no flag_age_s=93600 flag_age_from=note`));
    expect(writes).toEqual([FLAG]);
  });

  it("...and so does an 'already' (上次通知Owner names the owner) of the same assignment", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    expect(await notice()).toBe("flagged");
    told = { email: MYLA.email, text: MYLA.name };                  // recorded; 通知状态 still 待通知
    expect(await notice()).toBe("waiting");
    expect(reg.notes.get(CONTACT)?.flag).toMatchObject({ at: T0 });
  });

  it("checking a flag never rewrites the note: an assignment it already holds is not settled again", async () => {
    expect(await notice()).toBe("flagged");
    told = { email: MYLA.email, text: MYLA.name };
    expect(await notice()).toBe("waiting");
    workflowTells(MYLA);
    expect(await notice()).toBe("already");
    expect(reg.rememberNoticedCycle).toHaveBeenCalledTimes(1);      // the flag's own settlement only
  });

  /** A value the Worker wrote cannot be older than the Worker's write: an earlier changed_at is someone else's, gone. */
  it("this assignment's own flag is never aged by a changed_at older than the flag itself", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await notice()).toBe("flagged");
    status = { text: PENDING, index: 0, changedAt: new Date(Date.now() - DAY).toISOString() };
    vi.setSystemTime(Date.now() + 10_000);
    const lines = await logged(async () => { expect(await notice()).toBe("waiting"); });
    expect(lines.join("\n")).toMatch(/flag_age_s=10 flag_age_from=changed_at/);
    status = { text: PENDING, index: 0, changedAt: new Date(Date.now() - 1_000).toISOString() };   // set again since
    expect(await notice()).toBe("waiting");
  });
});

// ===================================================================================================
describe("a run's own bounds", () => {
  /** A contact deleted from HubSpot is nobody to tell: final, never an "error" retried for minutes. */
  it("a contact HubSpot no longer has (404) is 'no-owner' -- final -- and the lock is released", async () => {
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => {
      if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`))
        throw new Error(`hubspot GET /crm/v3/objects/contacts/${CONTACT}?properties=hubspot_owner_id: 404 {"status":"error"}`);
      return null;
    });
    const lines = await logged(async () => { expect(await notice()).toBe("no-owner"); });
    expect(lines.join("\n")).toContain("HubSpot has no such contact (404)");
    expect(writes).toEqual([]);
    expect(reg.locks.size).toBe(0);
  });

  it("...and one gone between the decision and the write is 'no-owner' too, with nothing written", async () => {
    let reads = 0;
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => {
      if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`) && ++reads === 2)
        throw new Error(`hubspot GET /crm/v3/objects/contacts/${CONTACT}?properties=x: 404 {"status":"error"}`);
      return { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } };
    });
    expect(await notice()).toBe("no-owner");
    expect(writes).toEqual([]);
  });

  /** The registry forgets a card's pairing after a day, so most reassignments search the board for the card. */
  it("the card search allows ONE monday rate-limit wait, like every other monday call of a run (gql's default is six)", async () => {
    cards.lookupCard.mockResolvedValue(null);
    expect(await notice()).toBe("flagged");
    expect(monday.findItemByColumn).toHaveBeenCalledWith(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, CONTACT, 1);
  });
});

// ===================================================================================================
describe("only a NEW assignment is flagged", () => {
  /** Myla has owned it since June, and an import re-sets the same owner. */
  it("an owner 'change' on a contact owned for months flags nothing -- remembered, nobody told", async () => {
    hsAssigned = "2026-06-16T08:00:00Z";
    expect(await notice()).toBe("baseline");
    expect(writes).toEqual([]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(MYLA.owner, "2026-06-16T08:00:00Z"));
  });

  it("...whatever the card shows: an old assignment is never flagged, even with nobody ever told", async () => {
    hsAssigned = "2026-06-16T08:00:00Z";
    status = { text: "", index: null };
    expect(await notice()).toBe("baseline");
    expect(monday.gql).not.toHaveBeenCalled();     // decided before the card is even read
  });

  it("...and the next REAL reassignment (HubSpot stamps a new assignment time) is flagged", async () => {
    hsAssigned = "2026-06-16T08:00:00Z";
    await notice();
    hsOwner = ELAINE.owner; hsAssigned = minutesAgo(1);
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG]);
  });

  it("no assignment time at all counts as old", async () => {
    hsAssigned = "";
    expect(await notice()).toBe("baseline");
    expect(writes).toEqual([]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(`${MYLA.owner}|`);
  });

  it("an assignment time given as epoch ms is read too", async () => {
    hsAssigned = String(Date.now() - 60_000);
    expect(await notice()).toBe("flagged");
  });

  it("the window is a day: 23 h ago is news, 25 h ago is not", async () => {
    const now = Date.parse("2026-10-09T08:00:00Z");
    hsAssigned = new Date(now - 23 * HOUR).toISOString();
    expect(await noticeOwner(env, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "t" }, () => now)).toBe("flagged");
    writes = []; status = null; reg.notes.clear();
    hsAssigned = new Date(now - 25 * HOUR).toISOString();
    expect(await noticeOwner(env, ctx, CRM_CONTACTS, { contactId: CONTACT, why: "t" }, () => now)).toBe("baseline");
    expect(writes).toEqual([]);
    expect(NOTICE_WINDOW_MS).toBe(24 * HOUR);
  });
});

// ===================================================================================================
describe("HubSpot decides: read inside the lock, and again just before the write", () => {
  it("reads the owner AFTER taking the lock", async () => {
    await notice();
    expect(reg.acquireLock.mock.invocationCallOrder[0]).toBeLessThan(hubspot.hs.mock.invocationCallOrder[0]);
  });

  /** Myla was set, then corrected to Elaine while monday held the run up: Elaine's assignment is the one decided. */
  it("an owner corrected between the read and the write: the NEW assignment is decided on, flagged and remembered", async () => {
    const t1 = minutesAgo(1), t2 = new Date().toISOString();
    hsSequence = [{ owner: MYLA.owner, assigned: t1 }, { owner: ELAINE.owner, assigned: t2 }];
    const lines = await logged(async () => { expect(await notice()).toBe("flagged"); });
    expect(writes).toEqual([FLAG]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(ELAINE.owner, t2));
    expect(lines.find(l => l.includes("action=flagged"))).toContain(`owner=${ELAINE.owner}`);
    expect(contactReads()).toBe(3);                 // read, re-read (changed), re-read (confirmed)
  });

  /** ...and decided on the card as it is THEN: the corrected owner must be the one it shows. */
  it("...and the corrected owner must be the one the card shows: still Myla on the card, so 'busy', nothing written", async () => {
    shows = [person(MYLA)];
    hsSequence = [{ owner: MYLA.owner, assigned: minutesAgo(1) }, { owner: ELAINE.owner, assigned: new Date().toISOString() }];
    expect(await notice()).toBe("busy");
    expect(writes).toEqual([]);
  });

  it("...so when the workflow had already told the corrected owner, nothing is written at all", async () => {
    told = { email: ELAINE.email, text: ELAINE.name };
    hsSequence = [{ owner: MYLA.owner, assigned: minutesAgo(1) }, { owner: ELAINE.owner, assigned: new Date().toISOString() }];
    expect(await notice()).toBe("already");
    expect(writes).toEqual([]);
  });

  it("an owner that keeps changing is left to the queue's retry ('busy'), with nothing written", async () => {
    const at = (m: number) => minutesAgo(10 - m);
    hsSequence = [MYLA, ELAINE, MYLA, ELAINE, MYLA, ELAINE].map((p, i) => ({ owner: p.owner, assigned: at(i) }));
    expect(await notice()).toBe("busy");
    expect(writes).toEqual([]);
    expect(reg.locks.size).toBe(0);
  });

  it("reads 通知状态 by its index (... on StatusValue { index }), in one read with 上次通知Owner", async () => {
    await notice();
    const read = monday.gql.mock.calls.find(c => !String(c[1]).includes("mutation"))!;
    expect(String(read[1])).toContain("... on StatusValue { index }");
    expect(String(read[1])).toContain(`"${TOLD}"`);
    expect(String(read[1])).toContain(`"${STATUS}"`);
  });

  it("allows at most one monday rate-limit wait per call inside the lock, and writes with retries=1", async () => {
    await notice();
    for (const c of monday.gql.mock.calls) expect(c[4]).toBe(1);
    const write = monday.gql.mock.calls.find(c => String(c[1]).includes("change_multiple_column_values"))!;
    expect(write[3]).toBe(1);
  });

  it("RENEWS its own lock right before writing (never re-takes it); a run whose renewal is refused writes nothing", async () => {
    reg.renewLock.mockResolvedValueOnce(false);
    expect(await notice()).toBe("busy");
    expect(writes).toEqual([]);
    expect(reg.acquireLock).toHaveBeenCalledTimes(1);
    expect(reg.renewLock).toHaveBeenCalledTimes(1);
    expect(reg.renewLock.mock.calls[0][2]).toBe(reg.acquireLock.mock.calls[0][3]);   // the same run id
  });

  /**
   * THE OVERRUN. Run A overran its 90 s hold (rate-limit waits); run B took the expired lock, flagged, remembered and
   * RELEASED it -- the lock record is gone -- and the workflow has already set 已通知. A re-take is granted on a
   * missing record, so A wrote 待通知 again from its stale reads: a second email. A renewal is not.
   */
  it("a run that overran its hold while another flagged the contact and released it: nothing written twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    let reads = 0;
    let b: string | null = null;
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => {
      if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`)) {
        if (++reads === 2) {                       // A's re-read, just before its write
          vi.setSystemTime(T0 + 100_000);          // ...A has overrun its hold
          b = await notice();                      // B: takes the expired lock, flags, remembers, releases
          workflowTells(MYLA);                     // ...and the workflow has done its part
        }
        return { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } };
      }
      return null;
    });
    expect(await notice()).toBe("busy");           // A
    expect(b).toBe("flagged");
    expect(writes).toEqual([FLAG]);                // B's flag only
    expect(status).toMatchObject({ text: DONE });  // the workflow's 已通知 is not turned back into 待通知
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

  /** The queue retries "busy" and "pending" without counting them for this long: it must outlast a lock left by a
   *  killed run, and a waiting flag until it is either finished or stuck. */
  it("the queue's busy grace outlasts the lock's hold and the stuck threshold", async () => {
    await notice();
    const hold = reg.acquireLock.mock.calls[0][2] as number;
    expect(NOTICE_BUSY_GRACE_MS).toBeGreaterThan(hold);
    expect(NOTICE_BUSY_GRACE_MS).toBeGreaterThan(FLAG_STUCK_MS);
  });

  it("without a cached owner list, the address comes from HubSpot's owner API (compared in any case)", async () => {
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) =>
      path.startsWith(`/crm/v3/owners/${MYLA.owner}`) ? { id: MYLA.owner, email: "Myla@DKMECO.com", firstName: "Myla", lastName: "M" }
        : { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } });
    monday.getUsersByEmail.mockResolvedValue({ "myla@dkmeco.com": MYLA.monday });
    told = { email: "myla@dkmeco.com", text: "Myla M" };
    expect(await noticeOwner(env, undefined, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("already");
    expect(hubspot.hs).toHaveBeenCalledWith(env, "GET", `/crm/v3/owners/${MYLA.owner}`, undefined, 2);
    told = null; reg.notes.clear();
    shows = [{ id: MYLA.monday, kind: "person" }];
    expect(await noticeOwner(env, undefined, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("flagged");
    expect(writes).toEqual([FLAG]);
  });

  /**
   * ONLY A 404 IS "NO SUCH OWNER". The owner API is read when the wave has no owner list -- most likely in the very
   * HubSpot 429 burst a bulk reassignment brings -- and its failure used to be swallowed into "no-email", which the
   * queue counts as done: the notice was lost without a trace, and the log said the owner had no email.
   */
  it.each([
    ["a 429 that outlasted hs()'s retries", new Error(`hubspot GET /crm/v3/owners/${MYLA.owner}: 429 {"policyName":"TEN_SECONDLY_ROLLING"}`)],
    ["a 5xx", new Error(`hubspot GET /crm/v3/owners/${MYLA.owner}: 503 Service Unavailable`)],
    ["a network failure", new TypeError("fetch failed")],
  ])("an owner-API read that fails with %s is 'error' -- retried by the queue -- never 'no-email'; the lock is released",
    async (_what, failure) => {
      hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => {
        if (path.startsWith("/crm/v3/owners/")) throw failure;
        return { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } };
      });
      expect(await noticeOwner(env, undefined, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("error");
      expect(writes).toEqual([]);
      expect(reg.locks.size).toBe(0);
    });

  it("...while a 404 really is nobody to tell: 'no-email'", async () => {
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => {
      if (path.startsWith("/crm/v3/owners/")) throw new Error(`hubspot GET /crm/v3/owners/${MYLA.owner}: 404 {"status":"error"}`);
      return { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } };
    });
    expect(await noticeOwner(env, undefined, CRM_CONTACTS, { contactId: CONTACT, why: "t" })).toBe("no-email");
    expect(writes).toEqual([]);
  });
});

// ===================================================================================================
describe("never a wrong or a half-made flag", () => {
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
    expect(hubspot.hs).not.toHaveBeenCalled();
  });

  it("a card that is gone by the time it is read: nothing, and the lock is released", async () => {
    monday.gql.mockResolvedValue({ items: [] });
    expect(await notice()).toBe("no-card");
    expect(writes).toEqual([]);
    expect(reg.locks.size).toBe(0);
  });

  it("DRY_RUN: decides and logs, writes nothing, remembers nothing -- whatever it decides", async () => {
    expect(await notice(dry)).toBe("dry-run");
    hsAssigned = "2026-06-16T08:00:00Z";
    expect(await notice(dry)).toBe("baseline");
    hsAssigned = minutesAgo(5);
    told = { email: MYLA.email, text: MYLA.name };
    expect(await notice(dry)).toBe("already");
    told = null; status = { text: PENDING, index: 0, changedAt: minutesAgo(1) };
    expect(await notice(dry)).toBe("pending");
    expect(writes).toEqual([]);
    expect(reg.notes.size).toBe(0);
    expect(reg.rememberNoticedCycle).not.toHaveBeenCalled();
    expect(deferred.spillDeferred).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the durable note cannot be read: 'error' (the queue retries), no write, lock released", async () => {
    reg.unreadable.on = true;
    expect(await notice()).toBe("error");
    expect(writes).toEqual([]);
    expect(reg.locks.size).toBe(0);
  });

  it("a failed write is a log line, never a throw; the lock is released and nothing settled -- the retry writes it", async () => {
    const real = monday.gql.getMockImplementation()!;
    monday.gql.mockImplementation(async (e: unknown, q: string, v: any) => {
      if (q.includes("change_multiple_column_values")) throw new Error("monday 500");
      return real(e, q, v);
    });
    expect(await notice()).toBe("error");
    expect(reg.locks.size).toBe(0);
    // Nothing SETTLED -- only the flag's own record, made before the write, stands.
    expect(reg.notes.get(CONTACT)).toMatchObject({ cycle: "", at: 0, flag: { cycle: cycleOf(MYLA.owner, hsAssigned) } });
    monday.gql.mockImplementation(real);
    expect(await notice()).toBe("flagged");          // the write never landed: nothing stands, so it is written now
    expect(writes).toEqual([FLAG]);
  });

  /** "error" is retried by the queue, and a write whose RESPONSE was lost did land: the retry must not write again. */
  it("a write that landed but lost its response: 'error', and the retries write nothing -- 'pending', then 'already'", async () => {
    monday.gql.mockImplementation(async (_e: unknown, q: string, v: any) => {
      if (q.includes("change_multiple_column_values")) {
        writes.push(JSON.parse(v.c));
        status = { text: PENDING, index: 0, changedAt: new Date().toISOString() };
        throw new Error("network connection lost");
      }
      return { items: [{ column_values: cardCells() }] };
    });
    expect(await notice()).toBe("error");
    expect(reg.notes.get(CONTACT)?.cycle).toBe("");  // nothing settled
    expect(await notice()).toBe("pending");          // our own flag, unsettled: waited on, never written twice
    workflowTells(MYLA);
    expect(await notice()).toBe("already");
    expect(writes).toEqual([FLAG]);
  });

  /** No 待通知 is written without the record that dates it (activity-registry recordNoticeFlag fails loud). */
  it("a flag whose own record cannot be kept is not written: 'error', retried by the queue", async () => {
    reg.flagRecordFails.on = true;
    expect(await notice()).toBe("error");
    expect(writes).toEqual([]);
    expect(reg.locks.size).toBe(0);
    reg.flagRecordFails.on = false;
    expect(await notice()).toBe("flagged");
    expect(writes).toEqual([FLAG]);
  });

  it("a HubSpot read that fails is 'error', never a throw, and the lock is released", async () => {
    hubspot.hs.mockRejectedValue(new Error("HubSpot 502"));
    expect(await notice()).toBe("error");
    expect(writes).toEqual([]);
    expect(reg.locks.size).toBe(0);
  });

  it("logs owner ids, never an address -- not even inside an error's own text", async () => {
    const ok = await logged(() => notice());
    expect(ok.join("\n")).toContain(`owner=${MYLA.owner}`);
    status = null; reg.notes.clear(); hsAssigned = minutesAgo(2);
    told = { email: ELAINE.email, text: ELAINE.name };
    monday.gql.mockImplementation(async (_e: unknown, q: string) => {
      if (q.includes("change_multiple_column_values")) throw new Error(`monday 500: rejected ${MYLA.email}`);
      return { items: [{ column_values: cardCells() }] };
    });
    const failed = await logged(() => notice());
    expect(failed.join("\n")).toContain("action=error");
    shows = [person(ELAINE)];
    const behind = await logged(() => notice());
    expect(behind.join("\n")).toContain("action=busy");
    expect([...ok, ...failed, ...behind].join("\n")).not.toMatch(/@/);
  });
});

// ===================================================================================================
describe("every trigger only enqueues", () => {
  it("queueOwnerNotices puts one notice entry per contact on the queue, deduplicated", async () => {
    await queueOwnerNotices(env, ["1", "2", "1"], "test");
    expect(deferred.spillDeferredLeftover).toHaveBeenCalledWith(env,
      [{ type: "contact", id: "1", notice: true }, { type: "contact", id: "2", notice: true }]);
    expect(hubspot.hs).not.toHaveBeenCalled();             // nothing decided inline
  });

  it("off, or nothing to queue: no call at all", async () => {
    await queueOwnerNotices({ ENABLE_CRM: "true" } as Env, ["1"], "test");
    await queueOwnerNotices(env, [], "test");
    expect(deferred.spillDeferredLeftover).not.toHaveBeenCalled();
  });

  /**
   * NEVER INLINE (reviewed 2026-10-09). A card's birth awaited queueOwnerNotices, and a notice the queue did not
   * take ran inline right there: ~10 s of lock retries, a minute or more per monday rate-limit wait, all before the
   * card's caller got its card back. queueOwnerNotices now only enqueues, and says what it could not.
   */
  it("with no queue to hand it to, nothing runs: the ids are answered and logged -- lost, unless the caller runs them", async () => {
    deferred.spillDeferredLeftover.mockImplementation(async (_e: unknown, items: unknown[]) => items);
    const lines = await logged(async () => { expect(await queueOwnerNotices(env, [CONTACT], "new card")).toEqual([CONTACT]); });
    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(monday.gql).not.toHaveBeenCalled();
    expect(reg.acquireLock).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(lines.join("\n")).toContain(`contacts=${CONTACT} action=not-queued why="new card"`);
    expect(lines.join("\n")).toContain("lost -- nothing re-runs them");
    const forWebhook = await logged(() => queueOwnerNotices(env, [CONTACT], "owner changed in HubSpot", "inline"));
    expect(forWebhook.join("\n")).toContain("run inline once the batch's own syncs have finished");
  });

  it("the webhook's fallback runs them inline (best effort; with no ctx the address comes from HubSpot's owner API)", async () => {
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) =>
      path.startsWith(`/crm/v3/owners/${MYLA.owner}`) ? { id: MYLA.owner, email: MYLA.email, firstName: "Myla", lastName: "Mestiola" }
        : { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } });
    await runOwnerNoticesInline(env, [CONTACT], "test");
    expect(writes).toEqual([FLAG]);
  });

  it("...and with the batch's ctx, reads neither HubSpot's owner API nor monday's user list", async () => {
    await runOwnerNoticesInline(env, [CONTACT], "test", ctx);
    expect(writes).toEqual([FLAG]);
    expect(hubspot.hs.mock.calls.some(c => String(c[2]).startsWith("/crm/v3/owners/"))).toBe(false);
    expect(monday.getUsersByEmail).not.toHaveBeenCalled();
  });

  /**
   * A FULL QUEUE DROPS THE TAIL. Running every id inline put the ones it HAD queued first, and the webhook's ~30 s
   * cut-off ended the loop before it reached any it had dropped -- which have no other way to be noticed.
   */
  it("a queue that drops part of the batch: ONLY the dropped contacts are answered, and run inline", async () => {
    deferred.spillDeferredLeftover.mockImplementation(async (_e: unknown, items: { id: string }[]) => items.slice(2));
    hubspot.hs.mockImplementation(async () => ({ properties: { hubspot_owner_id: "", hubspot_owner_assigneddate: "" } }));
    const lines = await logged(async () => {
      const left = await queueOwnerNotices(env, ["11", "12", "13", "14"], "test", "inline");
      expect(left).toEqual(["13", "14"]);
      await runOwnerNoticesInline(env, left, "test");
    });
    const ran = hubspot.hs.mock.calls.map(c => String(c[2]))
      .filter(p => p.startsWith("/crm/v3/objects/contacts/")).map(p => p.split("/")[5].split("?")[0]);
    expect(ran).toEqual(["13", "14"]);
    expect(lines.join("\n")).toContain("contacts=11,12 action=queued");
    expect(lines.join("\n")).toContain("contacts=13,14 action=not-queued");
    expect(lines.join("\n")).toContain("contacts=13,14 action=inline");
  });

  /**
   * AN INLINE RUN IS NOT RETRIED (reviewer residual R2). noticeOwner logs "busy", "pending" and "error" as the
   * queue's to retry, but a notice run inline -- the queue did not take it -- has no queue behind it: one more line
   * says it is lost.
   */
  const ownerApi = async (_e: unknown, _m: string, path: string) =>
    path.startsWith(`/crm/v3/owners/${MYLA.owner}`) ? { id: MYLA.owner, email: MYLA.email }
      : { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned } };

  it.each<[string, () => void]>([
    ["busy", () => { shows = [person(ELAINE)]; }],
    ["pending", () => { status = { text: PENDING, index: 0, changedAt: minutesAgo(1) }; }],
    ["error", () => { reg.unreadable.on = true; }],
  ])("an inline run that ends %j is logged as LOST: nothing retries it", async (outcome, arrange) => {
    hubspot.hs.mockImplementation(ownerApi);
    arrange();
    const lines = await logged(() => runOwnerNoticesInline(env, [CONTACT], "test"));
    expect(lines.some(l => l.includes(`contact=${CONTACT} `) && l.includes(`action=${outcome} `))).toBe(true);
    expect(lines).toContain(`[owner-notice] contact=${CONTACT} action=lost`
      + ` reason="ran inline because the queue did not take it; ${outcome} is not retried"`);
    expect(lines.join("\n")).not.toMatch(/@/);                       // owner ids only, never an address
    expect(writes).toEqual([]);
  });

  it("...but never for a run that settled, or whose own flag still waits, nor for a notice the queue took", async () => {
    hubspot.hs.mockImplementation(ownerApi);
    const inline = await logged(() => runOwnerNoticesInline(env, [CONTACT], "test"));
    expect(inline.join("\n")).toContain("action=flagged");
    const again = await logged(() => runOwnerNoticesInline(env, [CONTACT], "test"));
    expect(again.join("\n")).toContain("action=waiting");             // flagged: only the check is skipped
    shows = [person(ELAINE)];
    const taken = await logged(() => queueOwnerNotices(env, ["77"], "test"));
    expect(taken.join("\n")).toContain("contacts=77 action=queued");
    expect([...inline, ...again, ...taken].join("\n")).not.toContain("action=lost");
  });

  it("noticeOwnerChange (the queue's entry point) resolves the CRM Contacts spec itself", async () => {
    expect(await noticeOwnerChange(env, CONTACT, ctx)).toBe("flagged");
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

describe("statusOfCell", () => {
  it("a set cell is its label -- index 0 included", () => {
    expect(statusOfCell({ text: PENDING, index: 0 })).toBe(PENDING);
    expect(statusOfCell({ text: DONE, index: 1 })).toBe(DONE);
  });
  it("an unset cell is empty whatever its text says (monday's phantom status)", () => {
    expect(statusOfCell({ text: PENDING, index: null })).toBe("");
    expect(statusOfCell({ text: DONE })).toBe("");
    expect(statusOfCell(undefined)).toBe("");
  });
});

describe("peopleOfCell", () => {
  it("reads persons_and_teams as kind:id", () => {
    expect(peopleOfCell({ persons_and_teams: [{ id: "1", kind: "person" }, { id: 2, kind: "team" }] })).toEqual(["person:1", "team:2"]);
  });
  it("falls back to the value's personsAndTeams, and is empty for an empty cell", () => {
    expect(peopleOfCell({ value: JSON.stringify({ personsAndTeams: [{ id: 7, kind: "person" }] }) })).toEqual(["person:7"]);
    expect(peopleOfCell({ value: null })).toEqual([]);
    expect(peopleOfCell({ value: "not json" })).toEqual([]);
    expect(peopleOfCell(undefined)).toEqual([]);
  });
});

// ===================================================================================================
/**
 * AN IMPORT IS NEVER ANNOUNCED (the team's rule, 2026-10-12): HubSpot mails the owner of every contact an import
 * assigns, and a 100-contact upload gave Myla a hundred emails from each. The shapes below are the upload's own, as
 * HubSpot's history recorded them (import 190432563): a contact the import created, an existing one it reassigned,
 * and one whose owner followed its company's -- set by the import.
 */
describe("an import is never announced", () => {
  let created = "";
  let source = "";
  let history: object[] = [];
  let company: { status: number; history: object[] } = { status: 200, history: [] };
  const IMPORT_ID = "190432563";
  const COMPANY = "37197369250";
  const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
  beforeEach(() => {
    created = minutesAgo(400 * 24 * 60); source = "IMPORT"; history = []; company = { status: 200, history: [] };
    hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => {
      if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`))
        return { properties: { hubspot_owner_id: hsOwner, hubspot_owner_assigneddate: hsAssigned, createdate: created,
          hs_object_source: source }, propertiesWithHistory: { hubspot_owner_id: history } };
      if (path.startsWith(`/crm/v3/objects/companies/${COMPANY}`)) {
        if (company.status !== 200) throw new Error(`hubspot GET ${path}: ${company.status} {"status":"error"}`);
        return { propertiesWithHistory: { hubspot_owner_id: company.history } };
      }
      return null;
    });
  });
  const run = async (e: Env = env) => {
    let out = "";
    const lines = await logged(async () => { out = await notice(e); });
    return { out, lines };
  };
  const cascade = () => [{ value: MYLA.owner, timestamp: hsAssigned, sourceType: "COMPANIES",
    sourceId: `OwnerChangeToContactUpdate:triggered by companyId=${COMPANY}` }];

  it("the import set the owner of a contact it created: not flagged, remembered -- and the same assignment stays settled", async () => {
    created = hsAssigned;
    history = [{ value: MYLA.owner, timestamp: hsAssigned, sourceType: "IMPORT", sourceId: IMPORT_ID }];
    const { out, lines } = await run();
    expect(out).toBe("import");
    expect(writes).toEqual([]);
    expect(reg.notes.get(CONTACT)?.cycle).toBe(cycleOf(MYLA.owner, hsAssigned));
    expect(lines.some(l => /action=import why="test" owner=1739141284 reason="the contact was created by an import 0 min before/
      .test(l))).toBe(true);
    // The same assignment again (a second trigger): the same answer, before any monday read, nothing written, and the
    // settlement is not saved twice.
    const gqlCalls = monday.gql.mock.calls.length;
    expect(await notice()).toBe("import");
    expect(writes).toEqual([]);
    expect(monday.gql.mock.calls.length).toBe(gqlCalls);
    expect(reg.rememberNoticedCycle).toHaveBeenCalledTimes(1);
  });

  it("the import reassigned an EXISTING contact (its record source is not Import): not flagged", async () => {
    source = "BCC_TO_CRM"; created = minutesAgo(18 * 24 * 60);
    history = [{ value: MYLA.owner, timestamp: hsAssigned, sourceType: "IMPORT", sourceId: IMPORT_ID },
      { value: "", timestamp: created, sourceType: "BCC_TO_CRM" }];
    const { out, lines } = await run();
    expect(out).toBe("import");
    expect(writes).toEqual([]);
    expect(lines.some(l => l.includes(`import ${IMPORT_ID} set the owner`))).toBe(true);
  });

  it("its owner followed its company's, which the import set (HubSpot's cascade): not flagged", async () => {
    source = "FORM";
    history = cascade();
    company.history = [{ value: MYLA.owner, timestamp: at(hsAssigned, -300), sourceType: "IMPORT", sourceId: IMPORT_ID },
      { value: DESMOND.owner, timestamp: minutesAgo(90 * 24 * 60), sourceType: "CRM_UI" }];
    const { out, lines } = await run();
    expect(out).toBe("import");
    expect(writes).toEqual([]);
    expect(lines.some(l => l.includes(`import ${IMPORT_ID} set the owner of company ${COMPANY}`))).toBe(true);
  });

  it("...but a company owner a PERSON changed moves the contact's like any assignment: announced", async () => {
    source = "FORM";
    history = cascade();
    company.history = [{ value: MYLA.owner, timestamp: at(hsAssigned, -300), sourceType: "CRM_UI", sourceId: "userId:1" }];
    expect((await run()).out).toBe("flagged");
    expect(writes).toEqual([FLAG]);
  });

  it("a contact uploaded this morning and bulk-assigned by hand this afternoon is still a fresh upload: not flagged", async () => {
    created = at(hsAssigned, -4 * HOUR);
    history = [{ value: MYLA.owner, timestamp: hsAssigned, sourceType: "CRM_UI_BULK_ACTION", sourceId: "userId:1" }];
    expect((await run()).out).toBe("import");
    expect(writes).toEqual([]);
  });

  it("a contact imported LAST YEAR and assigned by hand today IS announced: 89% of all contacts were imported once", async () => {
    history = [{ value: MYLA.owner, timestamp: hsAssigned, sourceType: "CRM_UI", sourceId: "userId:1" }];
    expect((await run()).out).toBe("flagged");
    expect(writes).toEqual([FLAG]);
  });

  it("the change that SET the owner decides: a workflow re-writing the same owner since does not hide the import", async () => {
    source = "BCC_TO_CRM";
    history = [{ value: MYLA.owner, timestamp: at(hsAssigned, 60_000), sourceType: "WORKFLOWS" },
      { value: MYLA.owner, timestamp: hsAssigned, sourceType: "IMPORT", sourceId: IMPORT_ID },
      { value: DESMOND.owner, timestamp: minutesAgo(30 * 24 * 60), sourceType: "CRM_UI" }];
    expect((await run()).out).toBe("import");
  });

  it("an import that set ANOTHER owner earlier does not hide a person's reassignment since", async () => {
    source = "BCC_TO_CRM";
    history = [{ value: MYLA.owner, timestamp: hsAssigned, sourceType: "CRM_UI", sourceId: "userId:1" },
      { value: DESMOND.owner, timestamp: minutesAgo(60), sourceType: "IMPORT", sourceId: IMPORT_ID }];
    expect((await run()).out).toBe("flagged");
  });

  it("a company that cannot be read is an error -- retried by the queue, nothing remembered -- never a guess", async () => {
    source = "FORM";
    history = cascade();
    company.status = 503;
    expect((await run()).out).toBe("error");
    expect(writes).toEqual([]);
    expect(reg.notes.get(CONTACT)).toBeUndefined();
  });

  it("a company HubSpot no longer has is no import: announced", async () => {
    source = "FORM";
    history = cascade();
    company.status = 404;
    expect((await run()).out).toBe("flagged");
  });

  it("DRY_RUN: answered, nothing remembered", async () => {
    created = hsAssigned;
    history = [{ value: MYLA.owner, timestamp: hsAssigned, sourceType: "IMPORT", sourceId: IMPORT_ID }];
    expect((await run(dry)).out).toBe("import");
    expect(reg.notes.get(CONTACT)).toBeUndefined();
  });

  it("the owner is read with what decides it, in the same GET", async () => {
    await run();
    const path = String(hubspot.hs.mock.calls.find(c => String(c[2]).startsWith(`/crm/v3/objects/contacts/${CONTACT}`))![2]);
    expect(path).toContain("hs_object_source");
    expect(path).toContain("createdate");
    expect(path).toContain("propertiesWithHistory=hubspot_owner_id");
  });
});
