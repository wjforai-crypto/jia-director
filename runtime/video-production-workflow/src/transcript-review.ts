import path from "node:path";
import { ARTIFACT_FILES, REFERENCE_ARTIFACT_FILES, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256Canonical } from "./canonical-json.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface TranscriptSegment {
  id: string;
  text: string;
  asrText?: string;
  [key: string]: unknown;
}

interface TranscriptFile {
  segments: TranscriptSegment[];
  words: unknown[];
  contentHash: string;
  asrContentHash?: string;
  asrReviewStatus: string;
  reviewHistory?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface TranscriptReviewInput {
  sourceContentHash: string;
  reviewer: string;
  evidenceSources: string[];
  corrections: Array<{ segmentId: string; text: string; reason: string }>;
}

function transcriptContentHash(transcript: Pick<TranscriptFile, "segments" | "words">): string {
  return sha256Canonical({ segments: transcript.segments, words: transcript.words });
}

async function readOptionalRecreationPlanStatus(projectDir: string): Promise<string | null> {
  try {
    const plan = await readJson<{ status?: unknown }>(path.join(projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan));
    return typeof plan.status === "string" ? plan.status : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function reviewTranscript(input: { projectDir: string; inputPath: string }) {
  return withProjectStateLock(input.projectDir, "review-transcript", () => reviewTranscriptLocked(input));
}

async function reviewTranscriptLocked(input: { projectDir: string; inputPath: string }) {
  const projectPath = path.join(input.projectDir, "project.json");
  const transcriptPath = path.join(input.projectDir, ARTIFACT_FILES.transcript);
  const cutPlanPath = path.join(input.projectDir, ARTIFACT_FILES.cutPlan);
  const project = await readJson<VideoProject>(projectPath);
  if (!new Set(["source_registered", "plan_ready"]).has(project.workflowStatus)) {
    throw new Error(`review-transcript requires source_registered or plan_ready, got ${project.workflowStatus}`);
  }
  const transcript = await readJson<TranscriptFile>(transcriptPath);
  const review = await readJson<TranscriptReviewInput>(path.resolve(input.inputPath));
  if (review.sourceContentHash !== transcript.contentHash) {
    throw new Error("Transcript review is stale: sourceContentHash does not match the current transcript");
  }
  if (!review.reviewer?.trim()) throw new Error("Transcript review requires a reviewer");
  if (!Array.isArray(review.evidenceSources) || review.evidenceSources.length === 0) {
    throw new Error("Transcript review requires at least one evidence source");
  }
  if (!Array.isArray(review.corrections) || review.corrections.length === 0) {
    throw new Error("Transcript review requires at least one correction");
  }

  if (project.workflowStatus === "plan_ready") {
    const recreationStatus = await readOptionalRecreationPlanStatus(input.projectDir);
    if (recreationStatus && new Set(["pending_user_review", "approved", "applied"]).has(recreationStatus)) {
      throw new Error(
        `Transcript review cannot change a plan_ready project while recreation-plan status is ${recreationStatus}; `
        + "run review-recreation with decision revise first",
      );
    }
  }
  const { assertNoActiveBrollExecutionClaims } = await import("./broll-handoff.js");
  await assertNoActiveBrollExecutionClaims(input.projectDir, "Transcript review");

  const segmentById = new Map(transcript.segments.map((segment) => [segment.id, segment]));
  const seen = new Set<string>();
  const applied: Array<Record<string, unknown>> = [];
  for (const correction of review.corrections) {
    if (seen.has(correction.segmentId)) throw new Error(`Duplicate correction for segment ${correction.segmentId}`);
    seen.add(correction.segmentId);
    const segment = segmentById.get(correction.segmentId);
    if (!segment) throw new Error(`Unknown transcript segment: ${correction.segmentId}`);
    if (!correction.text?.trim() || !correction.reason?.trim()) {
      throw new Error(`Correction ${correction.segmentId} requires non-empty text and reason`);
    }
    const previousText = segment.text;
    segment.asrText ??= previousText;
    segment.text = correction.text.trim();
    applied.push({
      segmentId: segment.id,
      previousText,
      reviewedText: segment.text,
      reason: correction.reason.trim(),
    });
  }

  transcript.asrContentHash ??= transcript.contentHash;
  transcript.asrReviewStatus = "reviewed";
  transcript.reviewHistory = [
    ...(transcript.reviewHistory ?? []),
    {
      sourceContentHash: review.sourceContentHash,
      reviewer: review.reviewer.trim(),
      evidenceSources: review.evidenceSources,
      corrections: applied,
      reviewedAt: new Date().toISOString(),
    },
  ];
  transcript.contentHash = transcriptContentHash(transcript);
  await writeJson(transcriptPath, transcript);

  const downstreamInvalidated = project.workflowStatus === "plan_ready";
  if (downstreamInvalidated) {
    const cutPlan = await readJson<Record<string, unknown>>(cutPlanPath);
    cutPlan.reviewStatus = "invalidated";
    cutPlan.invalidatedAt = new Date().toISOString();
    cutPlan.invalidationReason = "Transcript content changed after the cut plan was generated";
    await writeJson(cutPlanPath, cutPlan);
    project.workflowStatus = "source_registered";
    project.updatedAt = new Date().toISOString();
    await writeJson(projectPath, project);
  }

  return {
    corrections: applied.length,
    contentHash: transcript.contentHash,
    asrReviewStatus: transcript.asrReviewStatus,
    downstreamInvalidated,
  };
}
