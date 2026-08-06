export interface ContactHit {
  hubspotId: string; name: string; email: string; phone: string; jobtitle: string; company: string;
  leadStatus: string; leadSource: string; createdate: string; ownerName: string; salesUser: string;
}

/** A value or an em dash when blank. */
export function orDash(v: string): string { return v?.trim() ? v : "—"; }

/** Short calendar date; blank/invalid -> "—". */
export function fmtContactDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
