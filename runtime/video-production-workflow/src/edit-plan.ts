import path from "node:path";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";
import { sha256Canonical } from "./canonical-json.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface CutOperation {
  id: string;
  kind: "speech" | "pause";
  decision: string;
  sourceIn: number;
  sourceOut: number;
  transcript?: string;
}

interface CutPlan {
  reviewStatus: string;
  operations: CutOperation[];
}

function shotId(operation: CutOperation): string {
  return `shot_${sha256Canonical([operation.id, operation.sourceIn, operation.sourceOut]).slice(0, 16)}`;
}

export async function createEditPlan(projectDir: string) {
  return withProjectStateLock(projectDir, "create-edit-plan", () => createEditPlanLocked(projectDir));
}

async function createEditPlanLocked(projectDir: string) {
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  if (project.workflowStatus !== "plan_ready") throw new Error(`plan-edit requires plan_ready, got ${project.workflowStatus}`);
  const { assertNoActiveBrollExecutionClaims } = await import("./broll-handoff.js");
  await assertNoActiveBrollExecutionClaims(projectDir, "Edit Plan replacement");
  try {
    const recreation = await readJson<{ status?: string }>(path.join(projectDir, "recreation-plan.json"));
    if (new Set(["pending_user_review", "approved", "applied"]).has(String(recreation.status))) {
      throw new Error(
        `plan-edit cannot replace an Edit Plan while the dependent recreation plan is ${String(recreation.status)}; `
        + "withdraw the recreation plan first",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const cutPlanPath = path.join(projectDir, ARTIFACT_FILES.cutPlan);
  const cutPlan = await readJson<CutPlan>(cutPlanPath);
  if (cutPlan.reviewStatus !== "approved") throw new Error(`plan-edit requires an approved cut plan, got ${cutPlan.reviewStatus}`);
  const shots = cutPlan.operations
    .filter((operation) => operation.kind === "speech" && operation.decision === "keep")
    .map((operation) => ({
      id: shotId(operation),
      cutOperationId: operation.id,
      sourceIn: operation.sourceIn,
      sourceOut: operation.sourceOut,
      semanticIntent: "Preserve the reviewed semantic unit and make its delivery visually clear",
      visualRole: project.lane === "speech" ? "a-roll" : "product-ui",
      voiceover: operation.transcript ?? "",
      triggerWords: [],
      protectedRegions: project.lane === "speech" ? ["faces", "bottom-captions"] : ["product-ui", "bottom-captions"],
      acceptance: ["No clipped syllables", "No locked-script changes", "Visual treatment serves the spoken meaning"],
    }));
  const editPlan = {
    schemaVersion: SCHEMA_VERSION,
    cutPlanHash: await sha256File(cutPlanPath),
    shots,
    reviewStatus: "ready",
    generatedAt: new Date().toISOString(),
  };
  await writeJson(path.join(projectDir, ARTIFACT_FILES.editPlan), editPlan);
  return { shots: shots.length, reviewStatus: editPlan.reviewStatus };
}
