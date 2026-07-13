import { UNASSIGNED_GROUP } from "../board-config";

export interface Group { id: string; title: string }

/** Selectable stage titles = every group except the no-sales-user "Unassigned" bucket. */
export function stageOptions(groups: Group[]): string[] {
  return groups.filter(g => g.id !== UNASSIGNED_GROUP).map(g => g.title);
}
export function groupIdForStage(stage: string, groups: Group[]): string | undefined {
  return groups.find(g => g.title === stage && g.id !== UNASSIGNED_GROUP)?.id;
}
export function stageForGroupId(groupId: string, groups: Group[]): string | undefined {
  return groups.find(g => g.id === groupId)?.title;
}
