import { UNASSIGNED_GROUP } from "../board-config";

export interface Group { id: string; title: string }

/** A stage has two names on this board and they are NOT interchangeable:
 *   group title       "Sales Pipeline 01 - Appointment Scheduled"   <- where the item lives
 *   Deal Stage label  "Appointment Scheduled"                       <- what the status column accepts
 * monday rejects any status value that isn't one of the column's own labels, and a deal row carries the
 * label (not the title), so everything user-facing speaks LABELS and the group is derived from them.
 * The group still matters: it is what the Worker reverses into HubSpot's dealstage. */
export function groupStageLabel(title: string): string {
  const m = /^Sales Pipeline\s*\d+\s*[-–—]\s*(.+)$/.exec(title.trim());
  return (m ? m[1] : title).trim();
}

/** Selectable stage labels, in board (pipeline) order. The no-sales-user bucket isn't a stage. */
export function stageOptions(groups: Group[]): string[] {
  return groups.filter(g => g.id !== UNASSIGNED_GROUP).map(g => groupStageLabel(g.title));
}
export function groupIdForStage(stage: string, groups: Group[]): string | undefined {
  return groups.find(g => g.id !== UNASSIGNED_GROUP && groupStageLabel(g.title) === stage)?.id;
}
export function stageForGroupId(groupId: string, groups: Group[]): string | undefined {
  const g = groups.find(g => g.id === groupId);
  return g ? groupStageLabel(g.title) : undefined;
}
