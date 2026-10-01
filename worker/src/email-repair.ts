import { timelinePayload } from "./activities";

/**
 * REPAIRING AN IMMUTABLE TIMELINE ENTRY.
 *
 * monday timeline items cannot be edited, so giving a bodyless email its body means creating a
 * replacement and removing the old copy. Done in the obvious order — delete, then create — a crash
 * or a failed create destroys a customer's communication history. So the order here is inverted and
 * never negotiable:
 *
 *     CREATE  ->  VERIFY  ->  RE-POINT THE MAPPING  ->  DELETE
 *
 * THE INVARIANT: never go from >=1 valid representation to 0. A crash may leave an extra copy, which
 * is untidy and self-healing; it may never leave a gap, which is not recoverable.
 *
 * RESUMPTION NEEDS NO LEDGER, because the state is legible from the data itself: the survivor is the
 * copy WITH a body. A rerun that finds one adopts it rather than creating another, so every crash
 * point converges on the same end state.
 *
 * The manifest chooses which pair to look at. The LIVE card and the authoritative HubSpot email
 * decide what happens — a snapshot taken hours earlier is a hint, never an instruction. Measured:
 * between the inventory and the audit, 90 minutes apart, one entry vanished from under us.
 */

/** HTML arrives in bodies; a timeline entry is plain text. Identical to activity-sync's strip(). */
const strip = (h: unknown) =>
  String(h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const HEADER = /^(From|To|Direction|HubSpot owner|Sequence \d+)/;
/** The visible body of an entry: everything that is not a header line and not the marker. */
export const bodyOf = (content: unknown): string =>
  String(content ?? "").split("\n")
    .filter(l => l.trim() && !HEADER.test(l.trim()) && !/^\[hubspot:/.test(l.trim()))
    .join(" ").trim();

export interface TimelineEntry {
  id: string;
  type?: string | null;
  title?: string | null;
  content?: string | null;
  created_at?: string | null;
  custom_activity_id?: string | null;
}

/** The authoritative HubSpot email, as the replacement needs it. */
export interface EmailSource {
  id: string;
  timestamp?: string;
  ownerId?: string;
  sourceUserId?: string;
  direction?: string;
  sequenceId?: string;
  subject?: string;
  from?: string;
  to?: string;
  /** hs_email_text */
  body?: string;
}

export type RepairAction =
  | "noop"              // already a single body-present entry
  | "repaired"          // created a replacement, verified it, removed the old copies
  | "adopted"           // a replacement already existed (a previous run got that far)
  | "skipped"           // could not establish the state; nothing touched
  | "failed";           // something went wrong mid-flight; originals preserved

export interface RepairResult {
  kind: string; card: string; email: string;
  action: RepairAction;
  before: number; after: number;
  createdId?: string;
  removed: string[];
  reason?: string;
}

/**
 * THE ONE AUTHORITATIVE CHECK, used for a replacement we just created AND for a body-present copy a
 * previous run left behind. Both are about to justify deleting a customer's history, so both must
 * clear the same bar. Trusting an existing survivor merely because it has *a* body would let any
 * wrong content — a partial write, a copy from some other source — become the record.
 *
 * Every field is compared against what timelinePayload() would build from the authoritative HubSpot
 * email, so the comparison cannot drift from what live sync writes.
 */
export function validateAgainstSource(entry: TimelineEntry, expected: {
    custom_activity_id: string; title: string; content: string; timestamp?: string },
    emailId: string): string[] {
  const problems: string[] = [];
  const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
  const lines = (s: unknown) => String(s ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  const headerOf = (s: unknown, key: RegExp) => lines(s).find(l => key.test(l)) ?? "";

  if (entry.custom_activity_id !== expected.custom_activity_id) problems.push("activity type");
  if (!String(entry.content ?? "").includes(`[hubspot:emails:${emailId}]`)) problems.push("marker");
  if (norm(entry.title) !== norm(expected.title)) problems.push("subject");
  if (expected.timestamp
      && String(entry.created_at ?? "").slice(0, 19) !== String(expected.timestamp).slice(0, 19))
    problems.push("timestamp");

  // Each header compared individually so a failure says WHICH field is wrong, not just "content".
  for (const [name, re] of [["from", /^From:/], ["to", /^To:/], ["direction", /^Direction:/],
                            ["owner", /^HubSpot owner:/], ["sequence", /^Sequence /]] as const)
    if (norm(headerOf(entry.content, re)) !== norm(headerOf(expected.content, re))) problems.push(name);

  // The body itself, normalised the same way on both sides.
  if (norm(bodyOf(entry.content)) !== norm(bodyOf(expected.content))) problems.push("body");
  return problems;
}

export interface RepairDeps {
  /** Every entry on the card carrying this email's marker, plus whether the walk completed. */
  readGroup(card: string, email: string): Promise<{ entries: TimelineEntry[]; incomplete: string | null }>;
  /** The authoritative HubSpot email. Null/throw means "do not proceed". */
  readEmail(emailId: string): Promise<EmailSource | null>;
  /** The HubSpot id the destination card currently claims, read from that KIND's own id column. */
  readMapping(kind: string, card: string): Promise<string>;
  /** Create one timeline entry; returns its new id. */
  create(card: string, payload: { custom_activity_id: string; title: string; summary: string;
    content: string; timestamp?: string }): Promise<string>;
  /**
   * Re-point the durable HubSpot->monday mapping at the surviving entry.
   *
   * TAKES A NAMED OBJECT ON PURPOSE. The underlying key is
   * `act:h2m:<object>:<hubspotActivityId>:<destKind>:<destinationHubSpotId>` — the DESTINATION'S
   * HUBSPOT ID, never the monday card id. Those are two opaque numeric strings sitting next to each
   * other in every record here, and a positional signature `(kind, card, email, id)` invites exactly
   * the wrong one. A mapping written under a card id is not merely wrong, it is INVISIBLE: live sync
   * reads the HubSpot-keyed entry, finds nothing, concludes the activity was never synced, and
   * writes a second copy — recreating the duplicate this repair exists to remove.
   */
  settleMapping(args: { kind: string; destinationHubSpotId: string; email: string;
    timelineId: string; cardId: string }): Promise<void>;
  /** Remove one timeline entry. */
  remove(timelineId: string): Promise<void>;
}

export interface RepairOptions {
  /** Entries at or after this are live-sync's; anything earlier is the historical import. */
  cutoverMs: number;
  /** Destination kinds the repair is allowed to touch. */
  allowedKinds?: string[];
  apply: boolean;
}

/** Same fingerprint the audit used: what the user sees, never the id. */
export const fingerprint = (t: TimelineEntry): string =>
  JSON.stringify({ type: t.type ?? "", custom: t.custom_activity_id ?? "",
    title: String(t.title ?? ""), content: String(t.content ?? ""), ts: String(t.created_at ?? "") });

/**
 * Repair ONE (destination, email) pair.
 *
 * Every early return leaves the card exactly as it was found. The only ordering that can delete is
 * the one that has already created and verified a replacement.
 */
export async function repairPair(deps: RepairDeps,
    pair: { kind: string; card: string; email: string; destinationHubSpotId: string },
    opts: RepairOptions): Promise<RepairResult> {
  const base = { kind: pair.kind, card: pair.card, email: pair.email, removed: [] as string[] };
  const skip = (reason: string, before = 0): RepairResult =>
    ({ ...base, action: "skipped", before, after: before, reason });

  if (opts.allowedKinds && !opts.allowedKinds.includes(pair.kind))
    return skip(`destination kind ${pair.kind} is out of scope`);

  // 1. the live group, not the manifest's memory of it
  const group = await deps.readGroup(pair.card, pair.email);
  if (group.incomplete) return skip(`timeline could not be read: ${group.incomplete}`);
  const entries = group.entries;
  if (!entries.length) return skip("no entry for this email on the card any more");

  // 2. the historical import is out of bounds, whatever a manifest says
  if (entries.some(e => Date.parse(String(e.created_at)) < opts.cutoverMs))
    return skip("entry predates the activity cutover — historical import, never mutated", entries.length);

  /**
   * 3. DESTINATION IDENTITY. The manifest names a card AND the HubSpot record that card stood for
   * when the manifest was built. A card can be re-pointed, merged or reused; writing to it on the
   * strength of its id alone would put one customer's mail on another's record. The live value must
   * still equal the expected one, and "missing" is a refusal, not a pass.
   */
  const liveDestination = await deps.readMapping(pair.kind, pair.card);
  if (!liveDestination) return skip("card carries no HubSpot id", entries.length);
  if (!pair.destinationHubSpotId)
    return skip("manifest has no expected destination HubSpot id", entries.length);
  if (liveDestination !== pair.destinationHubSpotId)
    return skip(`destination changed: card now claims ${liveDestination},`
      + ` manifest expected ${pair.destinationHubSpotId}`, entries.length);

  const withBody = entries.filter(e => bodyOf(e.content).length > 0);
  const bodyless = entries.filter(e => bodyOf(e.content).length === 0);

  // 4. already correct, and nothing would be created or deleted — so nothing needs proving
  if (withBody.length === 1 && entries.length === 1)
    return { ...base, action: "noop", before: 1, after: 1 };

  /**
   * 5. EVERY REMAINING PATH EITHER CREATES OR DELETES, so from here the authoritative email is
   * required. It is read BEFORE any survivor is trusted, because a body-present copy is exactly the
   * thing that would otherwise be adopted on faith and then used to justify deleting the rest.
   */
  let src: EmailSource | null;
  try { src = await deps.readEmail(pair.email); }
  catch (e) { return skip(`HubSpot read failed: ${String(e).slice(0, 80)}`, entries.length); }
  if (!src) return skip("HubSpot returned no email", entries.length);
  const body = strip(src.body);
  if (!body) return skip("HubSpot has no body for this email — a replacement would be no better",
    entries.length);

  const payload = timelinePayload(
    { id: src.id, object: "emails", timestamp: src.timestamp, ownerId: src.ownerId,
      sourceUserId: src.sourceUserId, direction: src.direction, sequenceId: src.sequenceId },
    { title: src.subject, from: src.from, to: src.to, body });
  if (!payload.custom_activity_id) return skip("no monday activity type for emails", entries.length);

  // 6. a body-present copy from an earlier run — validate it against HubSpot before trusting it
  if (withBody.length) {
    const valid = withBody.filter(e => validateAgainstSource(e, payload as any, pair.email).length === 0);
    if (valid.length === 0) {
      const why = validateAgainstSource(withBody[0], payload as any, pair.email).join(", ");
      return skip(`existing body-present copy does not match HubSpot (${why}) — nothing removed`,
        entries.length);
    }
    if (valid.length > 1) {
      const fps = new Set(valid.map(fingerprint));
      if (fps.size > 1)
        return skip(`${valid.length} differing authoritative copies — no safe survivor`, entries.length);
    }
    // deterministic survivor: lowest id, so repeated runs always choose the same one
    const keep = [...valid].sort((a, b) => a.id.localeCompare(b.id))[0];
    const drop = entries.filter(e => e.id !== keep.id);
    if (!opts.apply) return { ...base, action: "adopted", before: entries.length, after: 1,
      createdId: keep.id, removed: drop.map(e => e.id),
      reason: "existing copy validated against HubSpot; would keep it and remove the rest" };
    await deps.settleMapping({ kind: pair.kind, destinationHubSpotId: pair.destinationHubSpotId,
      email: pair.email, timelineId: keep.id, cardId: pair.card });
    const gone: string[] = [];
    for (const e of drop) { try { await deps.remove(e.id); gone.push(e.id); } catch { /* rerun converges */ } }
    const after = await deps.readGroup(pair.card, pair.email);
    return { ...base, action: "adopted", before: entries.length,
      after: after.incomplete ? -1 : after.entries.length, createdId: keep.id, removed: gone };
  }

  if (!opts.apply) return { ...base, action: "repaired", before: entries.length, after: 1,
    removed: bodyless.map(e => e.id), reason: "would create a replacement, verify, then remove the old copies" };

  // CREATE
  let newId: string;
  try { newId = await deps.create(pair.card, payload as any); }
  catch (e) { return { ...base, action: "failed", before: entries.length, after: entries.length,
    reason: `create failed, nothing removed: ${String(e).slice(0, 80)}` }; }
  if (!newId) return { ...base, action: "failed", before: entries.length, after: entries.length,
    reason: "create returned no id, nothing removed" };

  // VERIFY — by re-reading the group, not by trusting the create's response
  const check = await deps.readGroup(pair.card, pair.email);
  if (check.incomplete)
    return { ...base, action: "failed", before: entries.length, after: -1, createdId: newId,
      reason: `created ${newId} but the card could not be re-read; removed nothing` };
  const made = check.entries.find(e => e.id === newId);
  if (!made)
    return { ...base, action: "failed", before: entries.length, after: check.entries.length, createdId: newId,
      reason: "replacement not found on re-read; removed nothing" };
  // The SAME bar an adopted survivor has to clear — one validator, so the two paths cannot diverge.
  const problems = validateAgainstSource(made, payload as any, pair.email);
  if (problems.length)
    return { ...base, action: "failed", before: entries.length, after: check.entries.length, createdId: newId,
      reason: `replacement failed verification (${problems.join(", ")}); removed nothing` };

  // RE-POINT, then and only then DELETE
  await deps.settleMapping({ kind: pair.kind, destinationHubSpotId: pair.destinationHubSpotId,
    email: pair.email, timelineId: newId, cardId: pair.card });
  const removed: string[] = [];
  for (const e of bodyless) {
    try { await deps.remove(e.id); removed.push(e.id); }
    catch { /* a rerun adopts the survivor and removes whatever is left */ }
  }
  const final = await deps.readGroup(pair.card, pair.email);
  return { ...base, action: "repaired", before: entries.length,
    after: final.incomplete ? -1 : final.entries.length, createdId: newId, removed,
    reason: removed.length === bodyless.length ? undefined : "some old copies survived; a rerun will converge" };
}
