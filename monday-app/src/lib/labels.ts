// Extract the selectable label names from a monday column's settings_str.
// status columns: settings_str = {"labels":{"0":"Appointment Scheduled","1":"Qualified To Buy",...}}
// dropdown columns: settings_str = {"labels":[{"id":1,"name":"Vendor A"},{"id":2,"name":"Vendor B"}]}
export function columnLabels(settingsStr: string | null | undefined): string[] {
  try {
    const s = JSON.parse(settingsStr || "{}");
    if (Array.isArray(s.labels)) return s.labels.map((l: any) => l?.name).filter((n: any): n is string => typeof n === "string" && n.length > 0);
    if (s.labels && typeof s.labels === "object")
      return Object.values(s.labels).filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch { /* not parseable -> no options */ }
  return [];
}
