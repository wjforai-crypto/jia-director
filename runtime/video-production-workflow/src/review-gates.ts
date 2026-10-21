import path from "node:path";
import { stat } from "node:fs/promises";
import { ARTIFACT_FILES, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";
import { withProjectStateLock } from "./project-state-lock.js";

type VersionStage = "draft1" | "draft2" | "final_candidate";
type ConfirmationGate = "initial" | "final";
type ConfirmationDecision = "approve" | "revise";

interface VersionRecord {
  versionId: string;
  stage: VersionStage;
  label: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
  evidenceStatus: "valid" | "invalidated";
  userStatus: "pending" | "confirmed" | "revision_requested" | "superseded";
  recordedAt: string;
}

interface ReviewFile {
  schemaVersion: string;
  versions: VersionRecord[];
  confirmations: Array<Record<string, unknown>>;
  internalReviews?: Array<Record<string, unknown>>;
}

async function loadProject(projectDir: string) {
  const projectPath = path.join(projectDir, "project.json");
  return { projectPath, project: await readJson<VideoProject>(projectPath) };
}

async function loadReview(projectDir: string) {
  const reviewPath = path.join(projectDir, ARTIFACT_FILES.review);
  return { reviewPath, review: await readJson<ReviewFile>(reviewPath) };
}

async function assertCurrentHash(version: VersionRecord, reviewPath: string, review: ReviewFile): Promise<void> {
  if (version.evidenceStatus !== "valid") {
    throw new Error(`Version ${version.versionId} has invalidated evidence and cannot be reused`);
  }
  const currentHash = await sha256File(version.filePath);
  if (currentHash !== version.sha256) {
    version.evidenceStatus = "invalidated";
    await writeJson(reviewPath, review);
    throw new Error(`Version hash mismatch for ${version.versionId}; previous review evidence was invalidated`);
  }
}

export async function recordVersion(input: {
  projectDir: string;
  stage: VersionStage;
  filePath: string;
  label: string;
}) {
  return withProjectStateLock(input.projectDir, "record-version", () => recordVersionLocked(input));
}

async function recordVersionLocked(input: {
  projectDir: string;
  stage: VersionStage;
  filePath: string;
  label: string;
}) {
  const { projectPath, project } = await loadProject(input.projectDir);
  const { reviewPath, review } = await loadReview(input.projectDir);
  if (input.stage === "draft1" && !new Set(["visual_direction_ready", "draft1_pending_user", "revision_in_progress"]).has(project.workflowStatus)) {
    throw new Error(`draft1 requires visual_direction_ready, draft1_pending_user, or revision_in_progress; got ${project.workflowStatus}`);
  }
  const isRevisionCandidate =
    input.stage !== "draft1" && project.workflowStatus === "revision_in_progress";
  if (
    input.stage !== "draft1" &&
    project.workflowStatus !== "internal_review_passed" &&
    !isRevisionCandidate
  ) {
    throw new Error(`${input.stage} requires internal_review_passed or revision_in_progress, got ${project.workflowStatus}`);
  }

  const filePath = path.resolve(input.filePath);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new Error(`Version file does not exist: ${filePath}`);
  }
  if (!fileStat.isFile()) throw new Error(`Version path is not a file: ${filePath}`);
  const sha256 = await sha256File(filePath);
  const staleSameBytes = review.versions.find(
    (version) => version.sha256 === sha256
      && (version.evidenceStatus === "invalidated"
        || version.userStatus === "revision_requested"
        || version.userStatus === "superseded"),
  );
  if (staleSameBytes) {
    throw new Error(
      `Version bytes match stale evidence ${staleSameBytes.versionId} (${staleSameBytes.evidenceStatus}/${staleSameBytes.userStatus}); render changed bytes instead of switching stage`,
    );
  }
  const versionId = `version_${input.stage}_${sha256.slice(0, 12)}`;
  const nextWorkflowStatus = input.stage === "draft1"
    ? "draft1_pending_user"
    : isRevisionCandidate
      ? "revision_in_progress"
      : "draft2_pending_user";
  const record: VersionRecord = {
    versionId,
    stage: input.stage,
    label: input.label,
    filePath,
    sha256,
    sizeBytes: fileStat.size,
    evidenceStatus: "valid",
    userStatus: "pending",
    recordedAt: new Date().toISOString(),
  };
  const existingIndex = review.versions.findIndex((version) => version.versionId === versionId);
  if (existingIndex >= 0) {
    const existing = review.versions[existingIndex];
    if (existing.evidenceStatus !== "valid" || existing.userStatus !== "pending") {
      throw new Error(
        `Version bytes were already registered as ${existing.versionId} with ${existing.evidenceStatus}/${existing.userStatus} evidence; render changed bytes instead of reusing old evidence`,
      );
    }
    if (project.workflowStatus !== nextWorkflowStatus) {
      project.workflowStatus = nextWorkflowStatus;
      project.updatedAt = new Date().toISOString();
      await writeJson(projectPath, project);
    }
    return existing;
  }
  for (const previous of review.versions) {
    const sameUserGate =
      input.stage === "draft1"
        ? previous.stage === "draft1"
        : previous.stage !== "draft1";
    if (sameUserGate && previous.userStatus === "pending") previous.userStatus = "superseded";
  }
  review.versions.push(record);
  await writeJson(reviewPath, review);

  project.workflowStatus = nextWorkflowStatus;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return record;
}

export async function confirmVersion(input: {
  projectDir: string;
  gate: ConfirmationGate;
  versionId: string;
  decision: ConfirmationDecision;
  reviewer: string;
}) {
  return withProjectStateLock(input.projectDir, "confirm-version", () => confirmVersionLocked(input));
}

async function confirmVersionLocked(input: {
  projectDir: string;
  gate: ConfirmationGate;
  versionId: string;
  decision: ConfirmationDecision;
  reviewer: string;
}) {
  const { projectPath, project } = await loadProject(input.projectDir);
  const { reviewPath, review } = await loadReview(input.projectDir);
  const reviewer = input.reviewer.trim();
  if (!reviewer) throw new Error("Confirmation reviewer is required");
  if (input.gate === "final" && input.decision === "approve") {
    const { assertNoActiveBrollExecutionClaims, brollArchiveErrors } = await import("./broll-handoff.js");
    await assertNoActiveBrollExecutionClaims(input.projectDir, "Final confirmation");
    const brollErrors = await brollArchiveErrors(input.projectDir);
    if (brollErrors.length > 0) {
      throw new Error(`Final confirmation is blocked by unresolved or invalid B-roll handoffs: ${brollErrors.join("; ")}`);
    }
  }
  const requiredStatus = input.gate === "initial" ? "draft1_pending_user" : "draft2_pending_user";
  const version = review.versions.find((item) => item.versionId === input.versionId);
  if (!version) throw new Error(`Unknown version: ${input.versionId}`);
  const priorForVersion = review.confirmations.filter((item) =>
    item.gate === input.gate && item.versionId === version.versionId,
  );
  if (priorForVersion.length === 0 && project.workflowStatus !== requiredStatus) {
    throw new Error(`${input.gate} confirmation requires ${requiredStatus}, got ${project.workflowStatus}`);
  }
  if (input.gate === "initial" && version.stage !== "draft1") {
    throw new Error("Initial confirmation requires a draft1 version");
  }
  if (input.gate === "final" && !new Set(["draft2", "final_candidate"]).has(version.stage)) {
    throw new Error("Final confirmation requires a draft2 or final_candidate version");
  }
  const targetStatus = input.decision === "revise"
    ? "revision_in_progress"
    : input.gate === "initial"
      ? "draft1_approved"
      : "final_confirmed";
  const expectedUserStatus = input.decision === "approve" ? "confirmed" : "revision_requested";
  if (priorForVersion.length > 0) {
    const matching = priorForVersion.filter((item) =>
      item.versionHash === version.sha256
      && item.decision === input.decision
      && item.reviewer === reviewer,
    );
    if (priorForVersion.length !== 1 || matching.length !== 1) {
      throw new Error(`Conflicting confirmation evidence already exists for ${version.versionId}`);
    }
    if (version.evidenceStatus !== "valid" || version.userStatus !== expectedUserStatus) {
      throw new Error(`Confirmation evidence for ${version.versionId} is inconsistent with its version state`);
    }
    await assertCurrentHash(version, reviewPath, review);
    if (project.workflowStatus === requiredStatus) {
      project.workflowStatus = targetStatus;
      project.updatedAt = new Date().toISOString();
      await writeJson(projectPath, project);
    } else if (project.workflowStatus !== targetStatus) {
      throw new Error(`Confirmation recovery expected ${requiredStatus} or ${targetStatus}, got ${project.workflowStatus}`);
    }
    return matching[0];
  }
  if (project.workflowStatus !== requiredStatus) {
    throw new Error(`${input.gate} confirmation requires ${requiredStatus}, got ${project.workflowStatus}`);
  }
  const isSameGate = (candidate: VersionRecord) => input.gate === "initial"
    ? candidate.stage === "draft1"
    : candidate.stage !== "draft1";
  const pendingForGate = review.versions.filter(
    (candidate) => isSameGate(candidate) && candidate.evidenceStatus === "valid" && candidate.userStatus === "pending",
  );
  if (version.userStatus !== "pending" || pendingForGate.length !== 1 || pendingForGate[0].versionId !== version.versionId) {
    throw new Error(`Confirmation requires the current gate's unique pending version; ${version.versionId} is ${version.userStatus}`);
  }
  await assertCurrentHash(version, reviewPath, review);

  const confirmation = {
    gate: input.gate,
    versionId: version.versionId,
    versionHash: version.sha256,
    decision: input.decision,
    reviewer,
    recordedAt: new Date().toISOString(),
  };
  review.confirmations.push(confirmation);
  version.userStatus = input.decision === "approve" ? "confirmed" : "revision_requested";
  await writeJson(reviewPath, review);

  project.workflowStatus = targetStatus;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return confirmation;
}

export async function recordInternalReview(input: {
  projectDir: string;
  versionId: string;
  decision: "pass" | "fail";
  reviewer: string;
}) {
  return withProjectStateLock(input.projectDir, "record-internal-review", () => recordInternalReviewLocked(input));
}

async function recordInternalReviewLocked(input: {
  projectDir: string;
  versionId: string;
  decision: "pass" | "fail";
  reviewer: string;
}) {
  const { projectPath, project } = await loadProject(input.projectDir);
  const { reviewPath, review } = await loadReview(input.projectDir);
  const reviewer = input.reviewer.trim();
  if (!reviewer) throw new Error("Internal reviewer is required");
  const version = review.versions.find((item) => item.versionId === input.versionId);
  if (!version) throw new Error(`Unknown version: ${input.versionId}`);
  const recoveryTarget = input.decision === "fail"
    ? "revision_in_progress"
    : version.stage === "draft1"
      ? "internal_review_passed"
      : "draft2_pending_user";
  const recoverySources = input.decision === "fail"
    ? new Set(["draft1_approved", "revision_in_progress"])
    : version.stage === "draft1" && version.userStatus === "confirmed"
      ? new Set(["draft1_approved"])
      : new Set(["revision_in_progress"]);
  const priorForVersion = (review.internalReviews ?? []).filter((item) => item.versionId === version.versionId);
  if (priorForVersion.length > 0) {
    const matching = priorForVersion.filter((item) =>
      item.versionHash === version.sha256
      && item.decision === input.decision
      && item.reviewer === reviewer,
    );
    if (priorForVersion.length !== 1 || matching.length !== 1) {
      throw new Error(`Conflicting internal-review evidence already exists for ${version.versionId}; rejected evidence cannot be reused`);
    }
    const validPassStatus = version.stage === "draft1"
      ? new Set(["confirmed", "pending"]).has(version.userStatus)
      : version.userStatus === "pending";
    const validVersionStatus = input.decision === "fail"
      ? version.userStatus === "revision_requested"
      : validPassStatus;
    if (version.evidenceStatus !== "valid" || !validVersionStatus) {
      throw new Error(`Internal-review evidence for ${version.versionId} is inconsistent with its version state`);
    }
    await assertCurrentHash(version, reviewPath, review);
    if (recoverySources.has(project.workflowStatus)) {
      project.workflowStatus = recoveryTarget;
      project.updatedAt = new Date().toISOString();
      await writeJson(projectPath, project);
    } else if (project.workflowStatus !== recoveryTarget) {
      throw new Error(`Internal-review recovery expected ${[...recoverySources, recoveryTarget].join(" or ")}, got ${project.workflowStatus}`);
    }
    return matching[0];
  }
  if (!new Set(["draft1_approved", "revision_in_progress"]).has(project.workflowStatus)) {
    throw new Error(`Internal review requires draft1_approved or revision_in_progress, got ${project.workflowStatus}`);
  }
  const isRevisionReview = project.workflowStatus === "revision_in_progress";
  if (isRevisionReview && version.userStatus !== "pending") {
    throw new Error("Revision review requires a newly registered pending candidate; rejected evidence cannot be reused");
  }
  if (
    project.workflowStatus === "draft1_approved"
    && (version.stage !== "draft1" || version.userStatus !== "confirmed")
  ) {
    throw new Error("Initial internal review requires the currently confirmed draft1 version");
  }
  await assertCurrentHash(version, reviewPath, review);
  const record = {
    versionId: version.versionId,
    versionHash: version.sha256,
    decision: input.decision,
    reviewer,
    recordedAt: new Date().toISOString(),
  };
  review.internalReviews = [...(review.internalReviews ?? []), record];
  if (input.decision === "fail") version.userStatus = "revision_requested";
  await writeJson(reviewPath, review);
  project.workflowStatus =
    input.decision === "fail"
      ? "revision_in_progress"
      : isRevisionReview && version.stage !== "draft1"
        ? "draft2_pending_user"
        : "internal_review_passed";
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return record;
}
