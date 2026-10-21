import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256Canonical } from "./canonical-json.js";
import { assertCurrentSensitiveEvidence, isSensitiveProject, privacyContractIssues } from "./privacy-policy.js";
import { withKimiProjectLock } from "./kimi-handoff.js";
import { withProjectStateLock } from "./project-state-lock.js";

export interface VisualScores {
  critical: number;
  abstract: number;
  information: number;
  brand: number;
  assetGap: number;
}

export interface RouteVisualInput {
  projectDir: string;
  scores: VisualScores;
  selectedShotIds: string[];
  explicit?: boolean;
}

function validateScores(scores: VisualScores): void {
  for (const [name, value] of Object.entries(scores)) {
    if (!Number.isInteger(value) || value < 0 || value > 2) {
      throw new Error(`Visual score ${name} must be an integer from 0 to 2`);
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function routeVisualUnlocked(input: RouteVisualInput) {
  validateScores(input.scores);
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  if (!new Set(["plan_ready", "draft1_pending_user", "revision_in_progress"]).has(project.workflowStatus)) {
    throw new Error(`route-visual requires plan_ready, draft1_pending_user, or revision_in_progress, got ${project.workflowStatus}`);
  }
  const direction = await readJson<{ status?: string }>(
    path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection),
  );
  if (direction.status === "prepared") {
    throw new Error("route-visual cannot replace a prepared Kimi handoff");
  }
  if (new Set(["fallback_codex_pending", "fallback_codex_completed"]).has(direction.status ?? "")) {
    throw new Error(`route-visual cannot replace Kimi direction status ${direction.status}`);
  }

  const routingPath = path.join(input.projectDir, ARTIFACT_FILES.visualRouting);
  const existingRouting = await readJson<{ callsUsed?: number; maxCalls?: number }>(routingPath);
  const callsUsed = existingRouting.callsUsed ?? 0;
  if (project.workflowStatus !== "plan_ready" && callsUsed > 0) {
    throw new Error("Post-draft Kimi routing is allowed only when the project call remains unused");
  }

  const total = Object.values(input.scores).reduce((sum, value) => sum + value, 0);
  const sensitiveProject = isSensitiveProject(project);
  const contractIssues = privacyContractIssues(project);
  const authorization = project.privacy.externalProcessingAuthorization;
  const sensitiveAuthorizationReady =
    authorization?.status === "authorized" &&
    authorization.scope.includes("kimi_visual_direction") &&
    authorization.redactionEvidence !== null;
  let currentEvidenceReady = !sensitiveProject;
  if (sensitiveProject && contractIssues.length === 0 && sensitiveAuthorizationReady) {
    try {
      currentEvidenceReady = (await assertCurrentSensitiveEvidence(input.projectDir, project)) !== null;
    } catch {
      currentEvidenceReady = false;
    }
  }
  const privacyBlockReasons = sensitiveProject
    ? [
        ...contractIssues.map((issue) => `privacy_contract_${issue}`),
        ...(!project.privacy.redacted ? ["unredacted_sensitive_data"] : []),
        ...(!sensitiveAuthorizationReady ? ["external_processing_not_authorized"] : []),
        ...(!project.privacy.cloudAllowed ? ["cloud_processing_not_allowed"] : []),
        ...(sensitiveAuthorizationReady && !currentEvidenceReady ? ["privacy_evidence_invalid"] : []),
      ]
    : [];
  const privacyBlocked = privacyBlockReasons.length > 0;
  const wantsKimi = input.explicit === true || total >= 6;
  const decision = wantsKimi
    ? privacyBlocked
      ? "blocked_sensitive"
      : "kimi_advice_required"
    : "codex";

  const routing = {
    schemaVersion: SCHEMA_VERSION,
    score: { ...input.scores, total },
    threshold: 6,
    explicit: input.explicit === true,
    decision,
    selectedShotIds: input.selectedShotIds,
    callsUsed,
    maxCalls: project.priority === "flagship" ? 2 : 1,
    privacyBlocked,
    privacyBlockReasons,
    privacyHash: sha256Canonical(project.privacy),
    editPlanHash: await sha256File(path.join(input.projectDir, ARTIFACT_FILES.editPlan)),
    scoredAt: new Date().toISOString(),
  };

  await writeJson(routingPath, routing);
  if (decision === "codex" && project.workflowStatus === "plan_ready") {
    project.workflowStatus = "visual_direction_ready";
    project.updatedAt = new Date().toISOString();
    await writeJson(projectPath, project);
  }
  return routing;
}

export async function routeVisual(input: RouteVisualInput) {
  return withProjectStateLock(input.projectDir, "route-visual", () =>
    withKimiProjectLock(input.projectDir, () => routeVisualUnlocked(input)));
}
