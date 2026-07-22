// Pure mapping from the Worker's CreateResult to the progress step list the UI renders. The endpoint is a
// single synchronous call, so the client can't observe an individual step "running" mid-flight — while the
// promise is pending the component shows a spinner and passes `null` here (all steps pending). Once the
// result lands, each step is `done` (its flag is true) or, for the one `failedStep`, `failed`.

export const CREATE_STEPS = [
  { key: "dedup", label: "Checking for duplicates" },
  { key: "hubspot", label: "Creating in HubSpot" },
  { key: "monday", label: "Adding to monday board" },
  { key: "owner", label: "Applying owner" },
  { key: "associations", label: "Creating associations" },
] as const;

export type StepKey = (typeof CREATE_STEPS)[number]["key"];
export type StepStatus = "done" | "failed" | "pending";
export interface ProgressStep { key: StepKey; label: string; status: StepStatus }

interface ResultLike { status?: string; failedStep?: string; steps?: Record<string, boolean> }

export function progressSteps(result: ResultLike | null): ProgressStep[] {
  return CREATE_STEPS.map(s => {
    let status: StepStatus = "pending";
    if (result?.steps?.[s.key]) status = "done";
    else if (result?.status === "failed" && result.failedStep === s.key) status = "failed";
    return { key: s.key, label: s.label, status };
  });
}

export function isComplete(result: ResultLike | null): boolean { return result?.status === "completed"; }
export function isFailed(result: ResultLike | null): boolean { return result?.status === "failed"; }
