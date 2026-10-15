/** Extract the human-readable cause out of a monday API failure.
 *
 * Under seamless auth the SDK never touches HTTP: it postMessages the query to the monday host, which
 * rejects with a *summary* only (e.g. "Graphql validation errors") and hangs the real GraphQL errors off
 * `error.data`. Without digging those out, every failure reaches the UI as an unactionable one-liner. */
export function apiErrorDetail(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.map(apiErrorDetail).filter(Boolean).join("; ");
  if (typeof data !== "object") return String(data);

  const d = data as Record<string, unknown>;
  if (Array.isArray(d.errors)) {
    const msgs = d.errors
      .map(e => (typeof e === "string" ? e : (e as Record<string, unknown>)?.message))
      .filter(Boolean)
      .map(String);
    if (msgs.length) return msgs.join("; ");
  }
  if (typeof d.error_message === "string") return d.error_message;
  if (typeof d.message === "string") return d.message;
  return "";
}

/** Build the message we throw for a failed monday call: summary + the real cause when we can find it. */
export function apiErrorMessage(err: unknown): string {
  const e = err as { message?: string; data?: unknown };
  const summary = e?.message ? String(e.message) : String(err);
  const detail = apiErrorDetail(e?.data);
  return detail && !summary.includes(detail) ? `${summary} — ${detail}` : summary;
}
