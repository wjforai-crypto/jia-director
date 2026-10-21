import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256Canonical } from "./canonical-json.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface TranscriptSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  wordIds: string[];
}

interface TranscriptFile {
  segments: TranscriptSegment[];
  words: unknown[];
  contentHash: string;
  asrReviewStatus: string;
}

function operationId(parts: unknown[]): string {
  return `op_${sha256Canonical(parts).slice(0, 16)}`;
}

export async function createCutPlan(input: { projectDir: string; strategy: string }) {
  return withProjectStateLock(input.projectDir, "create-cut-plan", () => createCutPlanLocked(input));
}

async function createCutPlanLocked(input: { projectDir: string; strategy: string }) {
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  if (project.workflowStatus !== "source_registered") {
    throw new Error(`plan-cut requires source_registered, got ${project.workflowStatus}`);
  }
  if (input.strategy !== "semantic+silence") {
    throw new Error(`Unsupported cut strategy: ${input.strategy}`);
  }
  const transcriptPath = path.join(input.projectDir, ARTIFACT_FILES.transcript);
  const transcript = await readJson<TranscriptFile>(transcriptPath);
  if (transcript.segments.length === 0 || transcript.words.length === 0) {
    throw new Error("plan-cut requires a non-empty transcript");
  }

  const operations: Array<Record<string, unknown> & { sourceIn: number }> = [];
  for (const [index, segment] of transcript.segments.entries()) {
    operations.push({
      id: operationId(["speech", segment.id]),
      kind: "speech",
      segmentId: segment.id,
      sourceIn: segment.start,
      sourceOut: segment.end,
      wordIds: segment.wordIds,
      transcript: segment.text,
      decision: "keep",
      reason: "Complete semantic unit; default to keep until explicit review",
      confidence: transcript.asrReviewStatus === "needs_review" ? "review_required" : "normal",
    });
    const next = transcript.segments[index + 1];
    if (next) {
      const gap = Number((next.start - segment.end).toFixed(3));
      if (gap > 0) {
        const longPause = gap >= 0.8;
        operations.push({
          id: operationId(["pause", segment.end, next.start]),
          kind: "pause",
          sourceIn: segment.end,
          sourceOut: next.start,
          originalDuration: gap,
          targetDuration: longPause ? 0.25 : gap,
          decision: longPause ? "compress_candidate" : "keep",
          reason: longPause
            ? "Long pause candidate; never applied as speech deletion"
            : "Short pause; preserve the full source interval until explicit review",
        });
      }
    }
  }
  operations.sort((left, right) => left.sourceIn - right.sourceIn);
  const transcriptFileHash = createHash("sha256").update(await readFile(transcriptPath)).digest("hex");
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    strategy: input.strategy,
    transcriptHash: transcriptFileHash,
    transcriptContentHash: transcript.contentHash,
    operations,
    reviewStatus: "needs_review",
    invariants: {
      automaticSpeechDrops: 0,
      pauseCompressionIsAdvisory: true,
      semanticUnitsRemainComplete: true,
    },
    generatedAt: new Date().toISOString(),
  };
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.cutPlan), plan);
  project.workflowStatus = "plan_ready";
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return { operations: operations.length, reviewStatus: plan.reviewStatus };
}
