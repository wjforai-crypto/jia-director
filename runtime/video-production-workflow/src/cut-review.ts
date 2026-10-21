import path from "node:path";
import { ARTIFACT_FILES, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";
import { withProjectStateLock } from "./project-state-lock.js";

type SpeechDecision = "keep" | "drop";
type PauseDecision = "keep" | "drop" | "compress";

interface CutOperation {
  id: string;
  kind: "speech" | "pause";
  sourceIn: number;
  sourceOut: number;
  decision: string;
  [key: string]: unknown;
}

interface CutPlan {
  operations: CutOperation[];
  reviewStatus: string;
  reviews?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface CutDecision {
  operationId: string;
  decision: SpeechDecision | PauseDecision;
  targetDuration?: number;
  reason: string;
}

interface CutReviewInput {
  sourceCutPlanHash: string;
  reviewer: string;
  decisions: CutDecision[];
}

export async function reviewCutPlan(input: { projectDir: string; inputPath: string }) {
  return withProjectStateLock(input.projectDir, "review-cut-plan", () => reviewCutPlanLocked(input));
}

async function reviewCutPlanLocked(input: { projectDir: string; inputPath: string }) {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  if (project.workflowStatus !== "plan_ready") throw new Error(`review-cut requires plan_ready, got ${project.workflowStatus}`);
  const cutPlanPath = path.join(input.projectDir, ARTIFACT_FILES.cutPlan);
  const cutPlan = await readJson<CutPlan>(cutPlanPath);
  if (cutPlan.reviewStatus !== "needs_review") {
    throw new Error(`review-cut requires a needs_review plan, got ${cutPlan.reviewStatus}`);
  }
  const review = await readJson<CutReviewInput>(path.resolve(input.inputPath));
  if (review.sourceCutPlanHash !== (await sha256File(cutPlanPath))) {
    throw new Error("Cut review is stale: sourceCutPlanHash does not match the current cut plan");
  }
  if (!review.reviewer?.trim()) throw new Error("Cut review requires a reviewer");
  if (!Array.isArray(review.decisions)) throw new Error("Cut review decisions must be an array");

  const decisions = new Map<string, CutDecision>();
  for (const decision of review.decisions) {
    if (decisions.has(decision.operationId)) throw new Error(`Duplicate cut decision: ${decision.operationId}`);
    decisions.set(decision.operationId, decision);
  }
  const operationIds = new Set(cutPlan.operations.map((operation) => operation.id));
  const unknown = [...decisions.keys()].filter((id) => !operationIds.has(id));
  const missing = [...operationIds].filter((id) => !decisions.has(id));
  if (unknown.length > 0) throw new Error(`Unknown cut operations: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`Cut review is incomplete; missing operations: ${missing.join(", ")}`);

  for (const operation of cutPlan.operations) {
    const decision = decisions.get(operation.id)!;
    if (!decision.reason?.trim()) throw new Error(`Cut decision ${operation.id} requires a reason`);
    if (operation.kind === "speech" && !new Set<SpeechDecision>(["keep", "drop"]).has(decision.decision as SpeechDecision)) {
      throw new Error(`Speech operation ${operation.id} only supports keep or drop`);
    }
    if (operation.kind === "pause" && !new Set<PauseDecision>(["keep", "drop", "compress"]).has(decision.decision as PauseDecision)) {
      throw new Error(`Pause operation ${operation.id} only supports keep, drop, or compress`);
    }
    if (decision.decision === "compress") {
      const duration = operation.sourceOut - operation.sourceIn;
      if (!(typeof decision.targetDuration === "number" && decision.targetDuration > 0 && decision.targetDuration < duration)) {
        throw new Error(`Compressed pause ${operation.id} requires targetDuration between zero and its source duration`);
      }
      operation.targetDuration = decision.targetDuration;
    }
    operation.previousDecision = operation.decision;
    operation.decision = decision.decision;
    operation.reviewReason = decision.reason.trim();
    operation.reviewedBy = review.reviewer.trim();
  }
  cutPlan.reviewStatus = "approved";
  cutPlan.reviews = [
    ...(cutPlan.reviews ?? []),
    {
      sourceCutPlanHash: review.sourceCutPlanHash,
      reviewer: review.reviewer.trim(),
      decisions: review.decisions,
      reviewedAt: new Date().toISOString(),
    },
  ];
  await writeJson(cutPlanPath, cutPlan);
  return {
    operations: cutPlan.operations.length,
    keptSpeech: cutPlan.operations.filter((operation) => operation.kind === "speech" && operation.decision === "keep").length,
    droppedSpeech: cutPlan.operations.filter((operation) => operation.kind === "speech" && operation.decision === "drop").length,
    reviewStatus: cutPlan.reviewStatus,
  };
}
