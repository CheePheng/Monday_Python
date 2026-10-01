import { describe, it, expect, vi } from "vitest";
import { h2mReservationKey } from "../src/activity-registry";
import { repairPair, bodyOf, validateAgainstSource,
  type RepairDeps, type TimelineEntry, type EmailSource } from "../src/email-repair";

/**
 * EVERY CRASH POINT, EVERY WAY THE LIVE CARD CAN DISAGREE WITH THE MANIFEST, AND EVERY WAY A
 * SURVIVOR CAN BE WRONG.
 *
 * The one thing these tests exist to prevent is a customer's communication history going from one
 * copy to none — or, worse, from a correct copy to a wrong one that got adopted because it merely
 * had *a* body. A repair that leaves an extra copy is untidy; a repair that leaves a gap, or blesses
 * the wrong content, cannot be undone. So most assertions are about what was NOT deleted.
 */

const EMAIL_TYPE = "eaca46da-4695-4386-8dd4-a3fa088d31ce";
const EMAIL = "400770368243";
const CARD = "2855739270";
const DEST = "553196381902";                 // the HubSpot contact the card stands for
const CUT = Date.parse("2026-09-16T11:16:48Z");
const TS = "2026-09-18T02:50:12Z";
const BODY = "Hi there, the real body";

const SOURCE: EmailSource = { id: EMAIL, timestamp: TS, ownerId: "OW", direction: "EMAIL",
  subject: "Invite", from: "rep@dkmeco.com", to: "c@example.com", body: BODY };

/** An entry shaped exactly as timelinePayload() builds one, with fields overridable to corrupt it. */
const entry = (id: string, body: string, over: Partial<{
    from: string; to: string; direction: string; owner: string; title: string; ts: string;
    marker: string; sequence: string }> = {}): TimelineEntry => {
  const o = { from: "rep@dkmeco.com", to: "c@example.com", direction: "EMAIL", owner: "OW",
    title: "Invite", ts: TS, marker: `[hubspot:emails:${EMAIL}]`, sequence: "", ...over };
  const lines = [`From: ${o.from}`, `To: ${o.to}`, `Direction: ${o.direction}`,
    `HubSpot owner: ${o.owner}`];
  if (o.sequence) lines.push(`Sequence ${o.sequence} — informational, does not count as follow-up`);
  if (body) lines.push(`\n${body}`);
  lines.push(`\n${o.marker}`);
  return { id, type: "custom", custom_activity_id: EMAIL_TYPE, title: o.title,
    created_at: o.ts, content: lines.join("\n") };
};

function world(initial: TimelineEntry[], over: Partial<RepairDeps> = {}) {
  let rows = [...initial];
  const created: string[] = [], removed: string[] = [], settled: any[] = [];
  let n = 0;
  const deps: RepairDeps = {
    readGroup: vi.fn(async () => ({ entries: [...rows], incomplete: null })),
    readEmail: vi.fn(async () => SOURCE),
    readMapping: vi.fn(async () => DEST),
    create: vi.fn(async (_card, payload) => {
      const id = `new${++n}`;
      created.push(id);
      rows.push({ id, type: "custom", custom_activity_id: payload.custom_activity_id,
        title: payload.title, content: payload.content, created_at: payload.timestamp ?? TS });
      return id;
    }),
    settleMapping: vi.fn(async (a) => { settled.push(a); }),
    remove: vi.fn(async (id) => { removed.push(id); rows = rows.filter(r => r.id !== id); }),
    ...over,
  };
  return { deps, created, removed, settled, rows: () => rows };
}
const OPTS = { cutoverMs: CUT, apply: true, allowedKinds: ["contact", "company"] };
const pair = { kind: "contact", card: CARD, email: EMAIL, destinationHubSpotId: DEST };

describe("the ordinary repairs", () => {
  it("bodyless singleton: creates, verifies, re-points the mapping, THEN removes the old copy", async () => {
    const w = world([entry("old1", "")]);
    const r = await repairPair(w.deps, pair, OPTS);

    expect(r.action).toBe("repaired");
    expect(w.created).toHaveLength(1);
    expect(w.removed).toEqual(["old1"]);
    expect(w.settled[0].timelineId).toEqual(w.created[0]);
    expect(bodyOf(w.rows()[0].content)).toContain(BODY);
    const createIdx = (w.deps.create as any).mock.invocationCallOrder[0];
    const removeIdx = (w.deps.remove as any).mock.invocationCallOrder[0];
    const settleIdx = (w.deps.settleMapping as any).mock.invocationCallOrder[0];
    expect(createIdx).toBeLessThan(settleIdx);
    expect(settleIdx).toBeLessThan(removeIdx);
  });

  it("duplicated and all bodyless: ONE replacement, both old copies removed after verification", async () => {
    const w = world([entry("old1", ""), entry("old2", "")]);
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("repaired");
    expect(w.created).toHaveLength(1);
    expect(new Set(w.removed)).toEqual(new Set(["old1", "old2"]));
    expect(w.rows()).toHaveLength(1);
  });

  it("a single body-present entry needs no HubSpot read, because nothing is mutated", async () => {
    const w = world([entry("good", "anything at all")]);
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("noop");
    expect(w.deps.readEmail).not.toHaveBeenCalled();
    expect(w.removed).toHaveLength(0);
  });
});

describe("resuming after a crash — the survivor must still be PROVEN", () => {
  it("adopts a survivor that matches HubSpot, and only then removes the rest", async () => {
    const w = world([entry("old1", ""), entry("new1", BODY)]);
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("adopted");
    expect(w.deps.readEmail).toHaveBeenCalled();      // validated, not trusted
    expect(w.created).toHaveLength(0);
    expect(w.removed).toEqual(["old1"]);
  });

  it("crash after the mapping update: converges on the validated survivor", async () => {
    const w = world([entry("old1", ""), entry("old2", ""), entry("new1", BODY)]);
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("adopted");
    expect(new Set(w.removed)).toEqual(new Set(["old1", "old2"]));
    expect(w.rows().map(x => x.id)).toEqual(["new1"]);
  });

  it("crash part way through deleting: a rerun removes the remainder", async () => {
    const w = world([entry("old2", ""), entry("new1", BODY)]);
    await repairPair(w.deps, pair, OPTS);
    expect(w.removed).toEqual(["old2"]);
  });

  it("a delete that fails leaves the survivor and reports that a rerun is needed", async () => {
    const w = world([entry("old1", ""), entry("old2", "")], {
      remove: vi.fn(async (id: string) => { if (id === "old2") throw new Error("monday 500"); }),
    });
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("repaired");
    expect(r.reason).toContain("rerun");
  });
});

/** A body-present copy is exactly what would be adopted on faith. Each field is checked. */
describe("a survivor whose content does not match HubSpot is never adopted", () => {
  const cases: Array<[string, TimelineEntry]> = [
    ["wrong body",      entry("s", "a completely different body")],
    ["wrong subject",   entry("s", BODY, { title: "Something else" })],
    ["wrong From",      entry("s", BODY, { from: "someone.else@dkmeco.com" })],
    ["wrong To",        entry("s", BODY, { to: "wrong@example.com" })],
    ["wrong direction", entry("s", BODY, { direction: "INCOMING_EMAIL" })],
    ["wrong owner",     entry("s", BODY, { owner: "SOMEONE_ELSE" })],
    ["wrong timestamp", entry("s", BODY, { ts: "2026-09-17T00:00:00Z" })],
    ["wrong marker",    entry("s", BODY, { marker: "[hubspot:emails:999999]" })],
    ["extra sequence",  entry("s", BODY, { sequence: "747721419" })],
  ];
  for (const [label, bad] of cases) {
    it(`refuses to delete anything when the survivor has a ${label}`, async () => {
      const w = world([entry("old1", ""), bad]);
      const r = await repairPair(w.deps, pair, OPTS);
      expect(r.action).toBe("skipped");
      expect(r.reason).toContain("does not match HubSpot");
      expect(w.removed).toHaveLength(0);
      expect(w.created).toHaveLength(0);
    });
  }

  it("adopts only the copy that validates when a good and a bad one sit together", async () => {
    const w = world([entry("bad", "wrong content"), entry("good", BODY)]);
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("adopted");
    expect(r.createdId).toBe("good");
    expect(w.removed).toEqual(["bad"]);
  });

  it("two matching survivors pick the same one every run", async () => {
    const a = world([entry("b", BODY), entry("a", BODY)]);
    const b = world([entry("a", BODY), entry("b", BODY)]);
    const r1 = await repairPair(a.deps, pair, OPTS);
    const r2 = await repairPair(b.deps, pair, OPTS);
    expect(r1.createdId).toBe("a");
    expect(r2.createdId).toBe("a");
  });
});

describe("destination identity", () => {
  it("refuses when the card now claims a DIFFERENT HubSpot record", async () => {
    const w = world([entry("old1", "")], { readMapping: vi.fn(async () => "999999999") });
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("skipped");
    expect(r.reason).toContain("destination changed");
    expect(w.created).toHaveLength(0);
    expect(w.removed).toHaveLength(0);
  });

  it("refuses when the card carries no HubSpot id at all", async () => {
    const w = world([entry("old1", "")], { readMapping: vi.fn(async () => "") });
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("skipped");
    expect(w.removed).toHaveLength(0);
  });

  it("refuses when the manifest itself has no expected destination id", async () => {
    const w = world([entry("old1", "")]);
    const r = await repairPair(w.deps, { ...pair, destinationHubSpotId: "" }, OPTS);
    expect(r.action).toBe("skipped");
    expect(r.reason).toContain("no expected destination");
  });

  it("reads the id from the column belonging to the destination KIND", async () => {
    const w = world([entry("old1", "")]);
    await repairPair(w.deps, { ...pair, kind: "company" }, OPTS);
    expect(w.deps.readMapping).toHaveBeenCalledWith("company", CARD);
  });
});

describe("refusing to act when anything is uncertain", () => {
  it("verification failure after create leaves every original in place", async () => {
    let reads = 0;
    const w = world([entry("old1", "")], {
      create: vi.fn(async () => "bad1"),
      readGroup: vi.fn(async () => {
        reads++;
        return reads === 1
          ? { entries: [entry("old1", "")], incomplete: null }
          : { entries: [entry("old1", ""), { id: "bad1", type: "custom",
              custom_activity_id: EMAIL_TYPE, title: "Invite", created_at: TS,
              content: "" }], incomplete: null };
      }),
    });
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("failed");
    expect(r.reason).toContain("verification");
    expect(w.removed).toHaveLength(0);
  });

  it("HubSpot read failure deletes nothing, even with a survivor present", async () => {
    const w = world([entry("old1", ""), entry("new1", BODY)],
      { readEmail: vi.fn(async () => { throw new Error("403"); }) });
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("skipped");
    expect(w.removed).toHaveLength(0);
  });

  it("an unreadable timeline deletes nothing", async () => {
    const w = world([], { readGroup: vi.fn(async () => ({ entries: [], incomplete: "repeated-cursor" })) });
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("skipped");
    expect(w.removed).toHaveLength(0);
  });

  it("HubSpot having no body is not worth a rewrite", async () => {
    const w = world([entry("old1", "")], { readEmail: vi.fn(async () => ({ ...SOURCE, body: "" })) });
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("skipped");
    expect(w.created).toHaveLength(0);
  });

  it("an entry that vanished since the manifest is skipped, not recreated", async () => {
    const w = world([]);
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("skipped");
    expect(w.created).toHaveLength(0);
  });
});

describe("hard boundaries", () => {
  it("a PRE-cutover entry can never be mutated", async () => {
    const w = world([entry("hist", "", { ts: "2026-05-01T00:00:00Z" })]);
    const r = await repairPair(w.deps, pair, OPTS);
    expect(r.action).toBe("skipped");
    expect(r.reason).toContain("cutover");
    expect(w.created).toHaveLength(0);
    expect(w.removed).toHaveLength(0);
  });

  it("a Deals destination is out of scope", async () => {
    const w = world([entry("old1", "")]);
    const r = await repairPair(w.deps, { ...pair, kind: "deal" }, OPTS);
    expect(r.action).toBe("skipped");
    expect(w.created).toHaveLength(0);
  });

  it("dry run writes nothing but reports what it would do", async () => {
    const w = world([entry("old1", ""), entry("old2", "")]);
    const r = await repairPair(w.deps, pair, { ...OPTS, apply: false });
    expect(r.action).toBe("repaired");
    expect(r.removed).toEqual(["old1", "old2"]);
    expect(w.created).toHaveLength(0);
    expect(w.removed).toHaveLength(0);
    expect(w.settled).toHaveLength(0);
  });
});

describe("the validator itself", () => {
  it("names every field that differs, not just the first", async () => {
    const expected = { custom_activity_id: EMAIL_TYPE, title: "Invite",
      content: String(entry("x", BODY).content), timestamp: TS };
    const problems = validateAgainstSource(
      entry("y", "different body", { from: "x@y.z", title: "Other" }), expected, EMAIL);
    expect(problems).toContain("body");
    expect(problems).toContain("from");
    expect(problems).toContain("subject");
  });

  it("passes an entry built from the same source", async () => {
    const expected = { custom_activity_id: EMAIL_TYPE, title: "Invite",
      content: String(entry("x", BODY).content), timestamp: TS };
    expect(validateAgainstSource(entry("y", BODY), expected, EMAIL)).toEqual([]);
  });
});

/**
 * THE H2M KEY, PROVEN END TO END.
 *
 * The durable mapping is keyed by the DESTINATION'S HUBSPOT ID. A monday card id is the same shape —
 * an opaque numeric string — so the two are trivially swappable by accident, and the swap fails
 * silently: live sync reads the HubSpot-keyed entry, finds nothing, and writes a duplicate. These
 * tests build the key with the REAL h2mReservationKey from activity-registry, so they check the
 * actual production key string rather than merely which argument was passed.
 */
describe("the durable mapping key", () => {
  it("settles a Contact repair under the CONTACT's HubSpot id, never the card id", async () => {
    const w = world([entry("old1", "")]);
    await repairPair(w.deps, pair, OPTS);

    const a: any = w.settled[0];
    expect(a.destinationHubSpotId).toBe(DEST);
    expect(a.destinationHubSpotId).not.toBe(CARD);
    expect(h2mReservationKey("emails", EMAIL, a.kind, a.destinationHubSpotId))
      .toBe(`act:h2m:emails:${EMAIL}:${DEST}`);            // contact keeps its three-part shape
  });

  it("settles a Company repair under the COMPANY's HubSpot id, never the card id", async () => {
    const COMPANY_CARD = "2855583472", COMPANY_HS = "346930173678";
    // the card must actually claim the company id, or the destination-identity guard refuses first
    const w = world([entry("old1", "")], { readMapping: vi.fn(async () => COMPANY_HS) });
    await repairPair(w.deps, { kind: "company", card: COMPANY_CARD, email: EMAIL,
      destinationHubSpotId: COMPANY_HS }, { ...OPTS, allowedKinds: ["company"] });

    const a: any = w.settled[0];
    expect(a.destinationHubSpotId).toBe(COMPANY_HS);
    expect(a.destinationHubSpotId).not.toBe(COMPANY_CARD);
    expect(h2mReservationKey("emails", EMAIL, a.kind, a.destinationHubSpotId))
      .toBe(`act:h2m:emails:${EMAIL}:company:${COMPANY_HS}`);
  });

  it("an ADOPTED survivor re-settles under the same HubSpot-keyed mapping", async () => {
    const w = world([entry("old1", ""), entry("new1", BODY)]);
    const r = await repairPair(w.deps, pair, OPTS);

    expect(r.action).toBe("adopted");
    const a: any = w.settled[0];
    expect(a.timelineId).toBe("new1");                     // points at the survivor, not the removed copy
    expect(a.destinationHubSpotId).toBe(DEST);
    expect(h2mReservationKey("emails", EMAIL, a.kind, a.destinationHubSpotId))
      .toBe(`act:h2m:emails:${EMAIL}:${DEST}`);
  });

  it("never passes a monday card id as the destination, on any path", async () => {
    for (const rows of [[entry("old1", "")], [entry("old1", ""), entry("new1", BODY)]]) {
      const w = world(rows);
      await repairPair(w.deps, pair, OPTS);
      for (const a of w.settled as any[]) {
        expect(a.destinationHubSpotId).not.toBe(CARD);
        expect(a.cardId).toBe(CARD);                       // the card travels for logging only
      }
    }
  });
});
