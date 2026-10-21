import { readdir, stat, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sha256Canonical } from "./canonical-json.js";
import { sha256File } from "./media.js";
import { readJson, writeJsonAtomic } from "./json-store.js";
import { SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { verifyRecreationPlan, type RecreationPlanArtifact } from "./reference-recreation.js";
import { verifyReferenceAnalysis, type ReferenceAnalysisArtifact } from "./reference-analysis.js";
import { isSensitiveProject, privacyContractIssues } from "./privacy-policy.js";
import { assertProjectStateLockHeld, withProjectStateLock } from "./project-state-lock.js";

/**
 * B-roll generation is intentionally a file handoff.  This module never calls
 * a hosted generator (and therefore never creates a billable request).  The
 * A separately approved, claim-compatible external executor may read the
 * handoff JSON and return a result manifest; the result is imported and
 * checked here before a user can accept it.
 */

export const BROLL_HANDOFF_DIR = ".handoff/broll";
export const BROLL_HANDOFF_FILE = "broll-handoff.json";
export const BROLL_RESULT_FILE = "broll-result.json";

type BrollHandoffStatus =
  | "pending_user_approval"
  | "approved"
  | "execution_claimed"
  | "result_pending_user_review"
  | "accepted"
  | "needs_revision"
  | "stale"
  | "superseded";

type BrollResultStatus =
  | "pending_user_review"
  | "acceptance_pending_registration"
  | "accepted"
  | "needs_revision"
  | "stale";

export interface BrollReferenceAsset {
  assetId: string | null;
  role: string;
  usage: "evidence_only" | "generation_input";
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface BrollHandoffContent {
  project: {
    projectId: string;
    title: string;
    platform: string;
    aspectRatio: string;
    privacyHash: string;
  };
  plan: {
    path: string;
    contentHash: string;
    approvedContentHash: string;
    status: "approved" | "applied";
  };
  slot: {
    id: string;
    shootingShotId: string;
    shootingShotSlug: string;
    trigger: string;
    purpose: string;
    visual: string;
    sourceStrategy: "generated_after_approval";
    durationSeconds: number;
  };
  generation: {
    executor: string;
    model: string;
    mode: string;
    prompt: string;
    promptHash: string;
    durationSeconds: number;
    aspectRatio: string;
    payloadHash: string;
  };
  revision: {
    sequence: number;
    previousHandoffId: string | null;
    previousResultContentHash: string | null;
    previousGenerationPayloadHash: string | null;
    reason: string | null;
  };
  referenceAssets: BrollReferenceAsset[];
}

export interface BrollHandoffApproval {
  decision: "approve";
  reviewer: string;
  authority: "user";
  slotId: string;
  handoffContentHash: string;
  reviewedHandoffSha256: string;
  approvedAt: string;
}

export interface BrollExecutionClaim {
  claimHash: string;
  sequence: number;
  executor: string;
  claimedBy: string;
  handoffContentHash: string;
  planContentHash: string;
  privacyHash: string;
  issuedAt: string;
  expiresAt: string;
}

export interface BrollReconciledExecutionClaim {
  claim: BrollExecutionClaim;
  outcome: "confirmed_not_submitted";
  reconciledBy: string;
  authority: "user" | "operator";
  reason: string;
  reconciledAt: string;
}

export interface BrollHandoffRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "minimax-broll-handoff";
  handoffId: string;
  status: BrollHandoffStatus;
  content: BrollHandoffContent;
  contentHash: string;
  /** The external manifest must echo this exact value as inputHash. */
  inputHash: string;
  preparedAt: string;
  approval: BrollHandoffApproval | null;
  execution: {
    status: "not_started" | "claimed" | "returned";
    attempts: number;
    claim?: BrollExecutionClaim;
    reconciledClaims?: BrollReconciledExecutionClaim[];
    importedAt?: string;
  };
  supersession?: {
    supersededByHandoffId: string;
    supersededAt: string;
    reason: string;
  };
  staleEvidence?: {
    reason: "recreation_plan_revised_or_replaced";
    invalidatedPlanContentHash: string;
    invalidatedAt: string;
  };
  resultPath?: string;
  resultContentHash?: string;
}

export interface BrollExternalKeyframeInput {
  timeSeconds?: number;
  timestampSeconds?: number;
  time?: number;
  timestamp?: number;
  path: string;
  sha256: string;
  sizeBytes?: number;
}

export interface BrollExternalResultInput {
  schemaVersion?: string;
  kind?: string;
  handoffId: string;
  inputHash: string;
  handoffContentHash?: string;
  executionClaimHash?: string;
  video?: { path: string; sha256: string; sizeBytes?: number };
  videoPath?: string;
  videoSha256?: string;
  videoSizeBytes?: number;
  keyframes?: BrollExternalKeyframeInput[];
  keyFrames?: BrollExternalKeyframeInput[];
}

export interface BrollProbeEvidence {
  durationSeconds: number | null;
  formatName: string | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
}

export interface BrollResultContent {
  handoffId: string;
  inputHash: string;
  handoffContentHash: string;
  executionClaimHash: string;
  manifestPath: string;
  manifestSha256: string;
  video: {
    path: string;
    sha256: string;
    sizeBytes: number;
    probe: BrollProbeEvidence;
  };
  keyframes: Array<{
    role: "entry" | "climax" | "exit" | "support";
    timeSeconds: number;
    path: string;
    sha256: string;
    sizeBytes: number;
  }>;
}

export interface BrollResultRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "minimax-broll-result";
  status: BrollResultStatus;
  handoffId: string;
  content: BrollResultContent;
  resultContentHash: string;
  review: null | {
    decision: "accept" | "revise";
    reviewer: string;
    authority: "user";
    resultContentHash: string;
    handoffContentHash: string;
    videoSha256: string;
    keyframeSha256: string[];
    reviewedAt: string;
    notes: string | null;
    rights: null | {
      status: "confirmed_for_project_use";
      basis: string;
      confirmedBy: string;
      confirmedAt: string;
    };
  };
  assetRegistration: null | {
    assetId: string;
    slotId: string;
    planContentHash: string;
    handoffId: string;
    inputHash: string;
    resultContentHash: string;
    videoSha256: string;
    registeredAt: string;
  };
  importedAt: string;
}

interface AssetsFile {
  schemaVersion?: string;
  assets?: Array<Record<string, unknown> & {
    assetId?: string;
    path?: string;
    sha256?: string;
    role?: string;
    roles?: string[];
    brollBindings?: Array<Record<string, unknown>>;
  }>;
}

interface BrollSlot {
  id?: unknown;
  trigger?: unknown;
  purpose?: unknown;
  visual?: unknown;
  sourceStrategy?: unknown;
  durationSeconds?: unknown;
  sourcePlan?: Record<string, unknown>;
  generation?: Record<string, unknown> | null;
}

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const BROLL_HANDOFF_PREFIX = "BRL-";
const BROLL_HANDOFF_ID = /^BRL-[A-F0-9]{24}$/;

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text`);
  return value.normalize("NFC").trim();
}

function sha(value: unknown, label: string): string {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!HEX_SHA256.test(normalized)) throw new Error(`${label} must be lowercase SHA-256`);
  return normalized;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function validIsoDateTime(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be a valid ISO date-time`);
  return text;
}

function stablePath(filePath: string): string {
  return path.resolve(filePath);
}

function samePath(left: string, right: string): boolean {
  return stablePath(left).toLowerCase() === stablePath(right).toLowerCase();
}

function assertPathInside(rootDir: string, filePath: string, label: string): void {
  const relative = path.relative(stablePath(rootDir), stablePath(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${stablePath(rootDir)}`);
  }
}

function assertBrollExternalPrivacy(project: VideoProject): void {
  const issues = privacyContractIssues(project);
  if (issues.length > 0) throw new Error(`Privacy contract is inconsistent: ${issues.join(", ")}`);
  if (isSensitiveProject(project)) {
    throw new Error("Sensitive projects cannot create a MiniMax B-roll handoff; use a separately reviewed redacted, non-sensitive project package");
  }
  if (!project.privacy.cloudAllowed) throw new Error("Project privacy policy does not allow external B-roll generation");
  if (project.privacy.externalProcessingAuthorization?.status === "denied") {
    throw new Error("External B-roll generation was explicitly denied by the project privacy review");
  }
}

function assertBrollMutationAllowed(project: VideoProject): void {
  if (project.workflowStatus === "final_confirmed" || project.workflowStatus === "archived") {
    throw new Error(`B-roll handoff mutations are closed after final confirmation; got ${project.workflowStatus}`);
  }
}

function relativeProjectPath(projectDir: string, filePath: string): string {
  const relative = path.relative(path.resolve(projectDir), path.resolve(filePath)).replaceAll("\\", "/");
  return relative || path.basename(filePath);
}

function isoNow(): string {
  return new Date().toISOString();
}

function sha256SerializedJson(value: unknown): string {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`, "utf8").digest("hex");
}

function reviewedPendingHandoffSha256(handoff: BrollHandoffRecord): string {
  const pending: BrollHandoffRecord = {
    ...handoff,
    status: "pending_user_approval",
    approval: null,
    execution: { status: "not_started", attempts: 0 },
  };
  delete pending.resultPath;
  delete pending.resultContentHash;
  delete pending.supersession;
  delete pending.staleEvidence;
  return sha256SerializedJson(pending);
}

async function fileEvidence(filePath: string, label: string): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  const resolved = stablePath(filePath);
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (!fileStat.isFile()) throw new Error(`${label} is not a file: ${resolved}`);
  return { path: resolved, sizeBytes: fileStat.size, sha256: await sha256File(resolved) };
}

function isReferenceRole(asset: Record<string, unknown>): boolean {
  const role = typeof asset.role === "string" ? asset.role : "";
  const roles = Array.isArray(asset.roles) ? asset.roles.filter((item): item is string => typeof item === "string") : [];
  return role === "reference" || roles.includes("reference") || role === "reference-video" || roles.includes("reference-video");
}

async function collectReferenceAssets(
  projectDir: string,
  project: VideoProject,
  analysis: ReferenceAnalysisArtifact,
  slot: BrollSlot,
): Promise<BrollReferenceAsset[]> {
  const candidates: Array<{ path: string; role: string; usage: "evidence_only" | "generation_input"; assetId: string | null }> = [
    { path: analysis.source.path, role: "reference-analysis-source", usage: "evidence_only", assetId: analysis.source.assetId },
  ];
  const assetsFile = await readJson<AssetsFile>(path.join(projectDir, "assets.json"));
  for (const asset of assetsFile.assets ?? []) {
    if (!asset.path || !isReferenceRole(asset)) continue;
    candidates.push({ path: asset.path, role: "reference-asset", usage: "evidence_only", assetId: typeof asset.assetId === "string" ? asset.assetId : null });
  }
  const sourcePlan = slot.sourcePlan ?? {};
  if (typeof sourcePlan.assetId === "string") {
    const matching = (assetsFile.assets ?? []).find((asset) => asset.assetId === sourcePlan.assetId);
    if (!matching?.path) throw new Error(`B-roll source asset is not registered: ${sourcePlan.assetId}`);
    candidates.push({ path: matching.path, role: "slot-reference-asset", usage: "generation_input", assetId: sourcePlan.assetId });
  }

  // Newer plan producers may attach reference frame paths to generation.  The
  // current recreation contract does not require that field, but preserving it
  // here makes drift checking safe for forward-compatible plans.
  const generation = slot.generation ?? {};
  const extraValues: unknown[] = [generation.referenceAssets, generation.referencePaths, generation.referenceFrames];
  for (const value of extraValues) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") candidates.push({ path: item, role: "generation-reference", usage: "generation_input", assetId: null });
      else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).path === "string") {
        candidates.push({ path: (item as Record<string, unknown>).path as string, role: "generation-reference", usage: "generation_input", assetId: null });
      }
    }
  }

  const seen = new Map<string, BrollReferenceAsset>();
  for (const candidate of candidates) {
    const evidence = await fileEvidence(candidate.path, "B-roll reference asset");
    const key = evidence.path.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      if (existing.sha256 !== evidence.sha256) throw new Error(`Reference asset path resolves to conflicting bytes: ${evidence.path}`);
      if (candidate.usage === "generation_input") existing.usage = "generation_input";
      continue;
    }
    // If the plan gave an asset hash, verify it now.  This prevents creating a
    // handoff with a path that looks right but has already been replaced.
    if (candidate.assetId && typeof sourcePlan.assetSha256 === "string" && candidate.assetId === sourcePlan.assetId) {
      const expected = sha(sourcePlan.assetSha256, "sourcePlan.assetSha256");
      if (expected !== evidence.sha256) throw new Error(`B-roll reference asset hash changed: ${evidence.path}`);
    }
    seen.set(key, {
      assetId: candidate.assetId,
      role: candidate.role,
      usage: candidate.usage,
      path: evidence.path,
      sizeBytes: evidence.sizeBytes,
      sha256: evidence.sha256,
    });
  }
  return [...seen.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function findSlot(plan: RecreationPlanArtifact, slotId: string): { blueprint: RecreationPlanArtifact["editBlueprint"][number]; slot: BrollSlot } {
  const requested = nonEmpty(slotId, "slotId");
  for (const blueprint of plan.editBlueprint) {
    const slot = blueprint.brollSlots.find((candidate) => candidate.id === requested) as BrollSlot | undefined;
    if (slot) return { blueprint, slot };
  }
  throw new Error(`Unknown B-roll slot: ${requested}`);
}

function requireGeneratedPending(slot: BrollSlot): void {
  if (slot.sourceStrategy !== "generated_after_approval") {
    throw new Error("B-roll handoff requires sourceStrategy=generated_after_approval");
  }
  if (!slot.generation || typeof slot.generation !== "object") throw new Error("Generated B-roll slot is missing generation settings");
  if (slot.generation.approvalStatus !== "pending_plan_review") {
    throw new Error("B-roll handoff requires generation.approvalStatus=pending_plan_review");
  }
}

function buildContent(
  project: VideoProject,
  plan: RecreationPlanArtifact,
  blueprint: RecreationPlanArtifact["editBlueprint"][number],
  slot: BrollSlot,
  references: BrollReferenceAsset[],
  revision: BrollHandoffContent["revision"] = {
    sequence: 0,
    previousHandoffId: null,
    previousResultContentHash: null,
    previousGenerationPayloadHash: null,
    reason: null,
  },
  generationPromptOverride?: string,
): BrollHandoffContent {
  requireGeneratedPending(slot);
  const generation = slot.generation!;
  const prompt = nonEmpty(generationPromptOverride ?? generation.prompt, "generation.prompt");
  const promptHash = sha256Canonical(prompt);
  const declaredPromptHash = generation.promptHash;
  if (generationPromptOverride === undefined && declaredPromptHash !== undefined && declaredPromptHash !== promptHash) {
    throw new Error("Generated B-roll promptHash is stale");
  }
  const durationSeconds = finiteNumber(slot.durationSeconds, "broll.durationSeconds");
  if (durationSeconds <= 0) throw new Error("B-roll durationSeconds must be greater than zero");
  const normalizedGeneration = {
    executor: nonEmpty(generation.executor, "generation.executor"),
    model: nonEmpty(generation.model, "generation.model"),
    mode: nonEmpty(generation.mode, "generation.mode"),
    prompt,
    promptHash,
    durationSeconds,
    aspectRatio: nonEmpty(project.aspectRatio, "project.aspectRatio"),
  };
  const payloadHash = sha256Canonical({
    ...normalizedGeneration,
    referenceInputs: references
      .filter((reference) => reference.usage === "generation_input")
      .map((reference) => ({ path: reference.path, sha256: reference.sha256, sizeBytes: reference.sizeBytes })),
  });
  return {
    project: {
      projectId: nonEmpty(project.projectId, "project.projectId"),
      title: nonEmpty(project.title, "project.title"),
      platform: nonEmpty(project.platform, "project.platform"),
      aspectRatio: nonEmpty(project.aspectRatio, "project.aspectRatio"),
      privacyHash: sha256Canonical(project.privacy),
    },
    plan: {
      path: "recreation-plan.json",
      contentHash: sha(plan.contentHash, "recreation-plan.contentHash"),
      approvedContentHash: sha(plan.approvedContentHash, "recreation-plan.approvedContentHash"),
      status: plan.status as "approved" | "applied",
    },
    slot: {
      id: nonEmpty(slot.id, "broll.id"),
      shootingShotId: nonEmpty(blueprint.shootingShotId, "editBlueprint.shootingShotId"),
      shootingShotSlug: nonEmpty(blueprint.shootingShotSlug, "editBlueprint.shootingShotSlug"),
      trigger: nonEmpty(slot.trigger, "broll.trigger"),
      purpose: nonEmpty(slot.purpose, "broll.purpose"),
      visual: nonEmpty(slot.visual, "broll.visual"),
      sourceStrategy: "generated_after_approval",
      durationSeconds,
    },
    generation: { ...normalizedGeneration, payloadHash },
    revision,
    referenceAssets: references,
  };
}

function handoffId(
  projectId: string,
  planContentHash: string,
  slotId: string,
  revision: BrollHandoffContent["revision"],
  generationPayloadHash: string,
): string {
  return `${BROLL_HANDOFF_PREFIX}${sha256Canonical({
    projectId,
    planContentHash,
    slotId,
    revision,
    generationPayloadHash,
  }).slice(0, 24).toUpperCase()}`;
}

function expectedHandoffId(content: BrollHandoffContent): string {
  return handoffId(
    content.project.projectId,
    content.plan.contentHash,
    content.slot.id,
    content.revision,
    content.generation.payloadHash,
  );
}

function handoffDefaultPath(projectDir: string, id: string): string {
  return path.join(projectDir, BROLL_HANDOFF_DIR, id, BROLL_HANDOFF_FILE);
}

function assertCanonicalHandoffPath(projectDir: string, handoffPath: string, id: string): void {
  const root = path.join(projectDir, BROLL_HANDOFF_DIR);
  assertPathInside(root, handoffPath, "B-roll handoff path");
  const expected = handoffDefaultPath(projectDir, id);
  if (!samePath(handoffPath, expected)) {
    throw new Error(`B-roll handoff must use its unique canonical path: ${expected}`);
  }
}

function executionClaimContent(claim: BrollExecutionClaim) {
  return {
    sequence: claim.sequence,
    executor: claim.executor,
    claimedBy: claim.claimedBy,
    handoffContentHash: claim.handoffContentHash,
    planContentHash: claim.planContentHash,
    privacyHash: claim.privacyHash,
    issuedAt: claim.issuedAt,
    expiresAt: claim.expiresAt,
  };
}

function assertExecutionClaim(handoff: BrollHandoffRecord): BrollExecutionClaim {
  const claim = handoff.execution.claim;
  if (!claim) throw new Error("B-roll execution claim is missing");
  if (
    !Number.isInteger(claim.sequence)
    || claim.sequence < 1
    || claim.executor !== handoff.content.generation.executor
    || !claim.claimedBy?.trim()
    || claim.handoffContentHash !== handoff.contentHash
    || claim.planContentHash !== handoff.content.plan.contentHash
    || claim.privacyHash !== handoff.content.project.privacyHash
    || claim.claimHash !== sha256Canonical(executionClaimContent(claim))
  ) {
    throw new Error("B-roll execution claim is not bound to the approved current handoff");
  }
  const issuedAt = validIsoDateTime(claim.issuedAt, "handoff.execution.claim.issuedAt");
  const expiresAt = validIsoDateTime(claim.expiresAt, "handoff.execution.claim.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error("B-roll execution claim expiry is invalid");
  return claim;
}

function assertReconciledExecutionClaims(handoff: BrollHandoffRecord): BrollReconciledExecutionClaim[] {
  const reconciled = handoff.execution.reconciledClaims ?? [];
  const seen = new Set<string>();
  let previousSequence = 0;
  for (const item of reconciled) {
    if (
      item.outcome !== "confirmed_not_submitted"
      || !item.reconciledBy?.trim()
      || (item.authority !== "user" && item.authority !== "operator")
      || !item.reason?.trim()
    ) {
      throw new Error("B-roll reconciled execution claim evidence is incomplete");
    }
    validIsoDateTime(item.reconciledAt, "handoff.execution.reconciledClaims.reconciledAt");
    const claim = item.claim;
    if (
      claim.handoffContentHash !== handoff.contentHash
      || claim.planContentHash !== handoff.content.plan.contentHash
      || claim.privacyHash !== handoff.content.project.privacyHash
      || claim.executor !== handoff.content.generation.executor
      || claim.claimHash !== sha256Canonical(executionClaimContent(claim))
      || seen.has(claim.claimHash)
      || claim.sequence <= previousSequence
    ) {
      throw new Error("B-roll reconciled execution claim is not bound to this handoff or is out of sequence");
    }
    validIsoDateTime(claim.issuedAt, "handoff.execution.reconciledClaims.claim.issuedAt");
    validIsoDateTime(claim.expiresAt, "handoff.execution.reconciledClaims.claim.expiresAt");
    seen.add(claim.claimHash);
    previousSequence = claim.sequence;
  }
  if (handoff.execution.claim) {
    if (seen.has(handoff.execution.claim.claimHash) || handoff.execution.claim.sequence <= previousSequence) {
      throw new Error("Active B-roll execution claim must follow all reconciled claims");
    }
  }
  return reconciled;
}

function canonicalResultPath(handoffPath: string): string {
  return path.join(path.dirname(handoffPath), BROLL_RESULT_FILE);
}

function assertHandoffWorkflowState(handoff: BrollHandoffRecord): void {
  if (handoff.schemaVersion !== SCHEMA_VERSION || handoff.kind !== "minimax-broll-handoff") throw new Error("B-roll handoff identity is invalid");
  if (!BROLL_HANDOFF_ID.test(handoff.handoffId)) throw new Error("B-roll handoffId is invalid");
  if (!new Set<BrollHandoffStatus>(["pending_user_approval", "approved", "execution_claimed", "result_pending_user_review", "accepted", "needs_revision", "stale", "superseded"]).has(handoff.status)) {
    throw new Error(`B-roll handoff status is invalid: ${String(handoff.status)}`);
  }
  validIsoDateTime(handoff.preparedAt, "handoff.preparedAt");
  const revision = handoff.content.revision;
  if (!revision || !Number.isInteger(revision.sequence) || revision.sequence < 0) throw new Error("B-roll handoff revision sequence is invalid");
  if (revision.sequence === 0) {
    if (
      revision.previousHandoffId !== null
      || revision.previousResultContentHash !== null
      || revision.previousGenerationPayloadHash !== null
      || revision.reason !== null
    ) {
      throw new Error("Base B-roll handoff cannot claim revision ancestry");
    }
  } else if (
    !BROLL_HANDOFF_ID.test(revision.previousHandoffId ?? "")
    || !HEX_SHA256.test(revision.previousResultContentHash ?? "")
    || !HEX_SHA256.test(revision.previousGenerationPayloadHash ?? "")
    || !revision.reason?.trim()
  ) {
    throw new Error("Revised B-roll handoff lacks valid previous result evidence and reason");
  }
  const generation = handoff.content.generation;
  if (generation.promptHash !== sha256Canonical(generation.prompt)) throw new Error("B-roll handoff generation promptHash is stale");
  const expectedPayloadHash = sha256Canonical({
    executor: generation.executor,
    model: generation.model,
    mode: generation.mode,
    prompt: generation.prompt,
    promptHash: generation.promptHash,
    durationSeconds: generation.durationSeconds,
    aspectRatio: generation.aspectRatio,
    referenceInputs: handoff.content.referenceAssets
      .filter((reference) => reference.usage === "generation_input")
      .map((reference) => ({ path: reference.path, sha256: reference.sha256, sizeBytes: reference.sizeBytes })),
  });
  if (generation.payloadHash !== expectedPayloadHash) throw new Error("B-roll handoff generation payloadHash is stale");
  const deterministicId = expectedHandoffId(handoff.content);
  if (handoff.handoffId !== deterministicId) {
    throw new Error(`B-roll handoffId is not deterministic for its immutable content; expected ${deterministicId}`);
  }
  const resultStates = new Set<BrollHandoffStatus>(["result_pending_user_review", "accepted", "needs_revision"]);
  assertReconciledExecutionClaims(handoff);
  if (handoff.status === "stale") {
    if (
      !handoff.staleEvidence
      || handoff.staleEvidence.reason !== "recreation_plan_revised_or_replaced"
      || handoff.staleEvidence.invalidatedPlanContentHash !== handoff.content.plan.contentHash
    ) {
      throw new Error("stale B-roll handoff lacks plan invalidation evidence");
    }
    validIsoDateTime(handoff.staleEvidence.invalidatedAt, "handoff.staleEvidence.invalidatedAt");
    if (handoff.supersession) throw new Error("stale B-roll handoff cannot also be superseded");
    if (handoff.approval && (
      handoff.approval.decision !== "approve"
      || handoff.approval.authority !== "user"
      || !handoff.approval.reviewer?.trim()
      || handoff.approval.slotId !== handoff.content.slot.id
      || handoff.approval.handoffContentHash !== handoff.contentHash
    )) {
      throw new Error("stale B-roll handoff approval evidence is invalid");
    }
    if (handoff.resultPath || handoff.resultContentHash) {
      if (!handoff.resultPath || !handoff.resultContentHash || !handoff.approval) {
        throw new Error("stale B-roll handoff has an incomplete historical result binding");
      }
      if (handoff.execution.status !== "returned" || handoff.execution.attempts !== 1 || !handoff.execution.importedAt) {
        throw new Error("stale B-roll handoff has inconsistent historical execution evidence");
      }
      validIsoDateTime(handoff.execution.importedAt, "handoff.execution.importedAt");
    } else if (handoff.execution.status !== "not_started" || handoff.execution.attempts !== 0 || handoff.execution.claim) {
      throw new Error("stale unexecuted B-roll handoff has inconsistent execution evidence");
    }
    return;
  }
  if (handoff.staleEvidence) throw new Error(`${handoff.status} B-roll handoff cannot contain stale-plan evidence`);
  if (handoff.status === "superseded") {
    if (handoff.approval !== null) throw new Error("superseded B-roll handoff must not contain approval evidence");
    if (handoff.execution.status !== "not_started" || handoff.execution.attempts !== 0 || handoff.execution.claim) {
      throw new Error("superseded B-roll handoff cannot contain execution evidence");
    }
    if (handoff.resultPath || handoff.resultContentHash) throw new Error("superseded B-roll handoff cannot contain a result binding");
    if (
      !handoff.supersession
      || !BROLL_HANDOFF_ID.test(handoff.supersession.supersededByHandoffId)
      || handoff.supersession.supersededByHandoffId === handoff.handoffId
      || !handoff.supersession.reason?.trim()
    ) {
      throw new Error("superseded B-roll handoff lacks a valid replacement binding");
    }
    validIsoDateTime(handoff.supersession.supersededAt, "handoff.supersession.supersededAt");
    return;
  }
  if (handoff.supersession) throw new Error(`${handoff.status} B-roll handoff cannot contain supersession evidence`);
  if (handoff.status === "pending_user_approval") {
    if (handoff.approval !== null) throw new Error("pending B-roll handoff must not contain approval evidence");
    if (handoff.execution.status !== "not_started" || handoff.execution.attempts !== 0 || handoff.execution.claim) throw new Error("pending B-roll handoff cannot contain execution evidence");
    if (handoff.resultPath || handoff.resultContentHash) throw new Error("pending B-roll handoff cannot contain a result binding");
    return;
  }
  if (!handoff.approval) throw new Error(`${handoff.status} B-roll handoff lacks user approval evidence`);
  if (
    handoff.approval.decision !== "approve"
    || handoff.approval.authority !== "user"
    || !handoff.approval.reviewer?.trim()
    || handoff.approval.slotId !== handoff.content.slot.id
    || handoff.approval.handoffContentHash !== handoff.contentHash
  ) {
    throw new Error("B-roll handoff approval is not bound to the current slot/content");
  }
  validIsoDateTime(handoff.approval.approvedAt, "handoff.approval.approvedAt");
  if (handoff.status === "approved") {
    if (handoff.execution.status !== "not_started" || handoff.execution.attempts !== 0 || handoff.execution.claim) throw new Error("approved B-roll handoff has inconsistent execution evidence");
    if (handoff.resultPath || handoff.resultContentHash) throw new Error("approved B-roll handoff cannot already contain a result binding");
    return;
  }
  if (handoff.status === "execution_claimed") {
    if (handoff.execution.status !== "claimed" || handoff.execution.attempts !== 0) {
      throw new Error("claimed B-roll handoff has inconsistent execution evidence");
    }
    assertExecutionClaim(handoff);
    if (handoff.resultPath || handoff.resultContentHash) throw new Error("claimed B-roll handoff cannot already contain a result binding");
    return;
  }
  if (resultStates.has(handoff.status)) {
    if (!handoff.resultPath || !handoff.resultContentHash) throw new Error(`${handoff.status} B-roll handoff lacks a result binding`);
    if (handoff.execution.status !== "returned" || handoff.execution.attempts !== 1 || !handoff.execution.importedAt) {
      throw new Error(`${handoff.status} B-roll handoff has inconsistent returned execution evidence`);
    }
    validIsoDateTime(handoff.execution.importedAt, "handoff.execution.importedAt");
    assertExecutionClaim(handoff);
  }
}

async function readHandoff(filePath: string): Promise<BrollHandoffRecord> {
  const record = await readJson<BrollHandoffRecord>(stablePath(filePath));
  if (record.kind !== "minimax-broll-handoff") throw new Error("Input is not a MiniMax B-roll handoff");
  if (!record.content || typeof record.content !== "object") throw new Error("B-roll handoff is missing immutable content");
  if (record.contentHash !== sha256Canonical(record.content)) throw new Error("B-roll handoff contentHash is stale");
  if (record.inputHash !== record.contentHash) throw new Error("B-roll handoff inputHash must equal contentHash");
  if (record.approval && record.approval.reviewedHandoffSha256 !== reviewedPendingHandoffSha256(record)) {
    throw new Error("B-roll approval no longer matches the exact handoff file reviewed by the user");
  }
  assertHandoffWorkflowState(record);
  return record;
}

async function writeProjectHandoffRegistration(projectDir: string, handoffPath: string): Promise<void> {
  const projectPath = path.join(projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  const artifacts = project.artifacts as VideoProject["artifacts"] & { brollHandoffs?: string[] };
  const relative = relativeProjectPath(projectDir, handoffPath);
  const existing = Array.isArray(artifacts.brollHandoffs) ? artifacts.brollHandoffs : [];
  if (!existing.some((item) => item.toLowerCase() === relative.toLowerCase())) {
    artifacts.brollHandoffs = [...existing, relative].sort();
    project.updatedAt = isoNow();
    await writeJsonAtomic(projectPath, project);
  }
}

async function currentPlanAndContent(projectDir: string, handoff: BrollHandoffRecord): Promise<{ project: VideoProject; plan: RecreationPlanArtifact }> {
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  assertBrollExternalPrivacy(project);
  const plan = await verifyRecreationPlan(projectDir);
  if (!new Set(["approved", "applied"]).has(plan.status)) {
    throw new Error(`B-roll handoff requires recreation-plan status approved/applied, got ${plan.status}`);
  }
  if (plan.approvedContentHash !== plan.contentHash || plan.contentHash !== handoff.content.plan.contentHash) {
    throw new Error("B-roll handoff is stale: recreation-plan approval or content hash changed");
  }
  if (project.projectId !== handoff.content.project.projectId) throw new Error("B-roll handoff project changed");
  if (project.platform !== handoff.content.project.platform) throw new Error("B-roll handoff platform changed");
  if (project.aspectRatio !== handoff.content.project.aspectRatio) throw new Error("B-roll handoff aspect ratio changed");
  const selected = findSlot(plan, handoff.content.slot.id);
  requireGeneratedPending(selected.slot);
  const references = await collectReferenceAssets(projectDir, project, await verifyReferenceAnalysis(projectDir), selected.slot);
  const regenerated = buildContent(
    project,
    plan,
    selected.blueprint,
    selected.slot,
    references,
    handoff.content.revision,
    handoff.content.revision.sequence > 0 ? handoff.content.generation.prompt : undefined,
  );
  // Applying a recreation plan changes only its workflow status; the approved
  // plan content hash and this handoff's immutable input do not change.
  regenerated.plan.status = handoff.content.plan.status;
  if (sha256Canonical(regenerated) !== handoff.contentHash) {
    throw new Error("B-roll handoff content drifted from the approved plan or reference assets");
  }
  for (const reference of handoff.content.referenceAssets) {
    const current = await fileEvidence(reference.path, "B-roll reference asset");
    if (current.sha256 !== reference.sha256 || current.sizeBytes !== reference.sizeBytes) {
      throw new Error(`B-roll reference asset changed after handoff approval: ${reference.path}`);
    }
  }
  return { project, plan };
}

export async function prepareBrollHandoff(input: {
  projectDir: string;
  slotId: string;
  outputPath?: string;
  revisionOf?: string;
  revisionReason?: string;
  revisionPrompt?: string;
  supersedePendingRevision?: boolean;
}) {
  const projectDir = stablePath(input.projectDir);
  return withProjectStateLock(projectDir, "prepare-handoff", async () => {
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  assertBrollMutationAllowed(project);
  assertBrollExternalPrivacy(project);
  const plan = await verifyRecreationPlan(projectDir);
  if (!new Set(["approved", "applied"]).has(plan.status) || plan.approvedContentHash !== plan.contentHash) {
    throw new Error("prepare-broll-handoff requires the current recreation plan to be user-approved/applied");
  }
  const selected = findSlot(plan, input.slotId);
  requireGeneratedPending(selected.slot);
  const revisionContext = await revisionForPreparation(
    projectDir,
    input.slotId,
    input.revisionOf,
    input.revisionReason,
    input.revisionPrompt,
  );
  const revision = revisionContext.revision;
  const references = await collectReferenceAssets(projectDir, project, await verifyReferenceAnalysis(projectDir), selected.slot);
  const content = buildContent(
    project,
    plan,
    selected.blueprint,
    selected.slot,
    references,
    revision,
    revisionContext.promptOverride,
  );
  if (revision.previousGenerationPayloadHash && content.generation.payloadHash === revision.previousGenerationPayloadHash) {
    throw new Error("B-roll revision must change the effective generation payload, not only its reason");
  }
  const contentHash = sha256Canonical(content);
  const id = handoffId(project.projectId, plan.contentHash, content.slot.id, revision, content.generation.payloadHash);
  const pendingSiblings: Array<{ path: string; record: BrollHandoffRecord }> = [];
  if (revision.previousHandoffId) {
    for (const candidatePath of await discoverBrollHandoffPaths(projectDir)) {
      const candidate = await readHandoff(candidatePath);
      if (
        candidate.content.revision.previousHandoffId === revision.previousHandoffId
        && candidate.handoffId !== id
        && candidate.status !== "superseded"
      ) {
        if (
          input.supersedePendingRevision
          && candidate.status === "pending_user_approval"
          && candidate.approval === null
          && candidate.execution.status === "not_started"
          && candidate.execution.attempts === 0
          && !candidate.resultPath
          && !candidate.resultContentHash
        ) {
          pendingSiblings.push({ path: candidatePath, record: candidate });
        } else {
          throw new Error(
            `B-roll handoff ${revision.previousHandoffId} already has a different revision child; `
            + "use supersedePendingRevision only to replace an unapproved, unexecuted revision",
          );
        }
      }
    }
  }
  const canonicalPath = stablePath(handoffDefaultPath(projectDir, id));
  if (input.outputPath && !samePath(input.outputPath, canonicalPath)) {
    throw new Error(`Custom B-roll handoff output is not allowed; use the unique canonical path: ${canonicalPath}`);
  }
  const handoffPath = canonicalPath;
  assertCanonicalHandoffPath(projectDir, handoffPath, id);
  const existing = await readOptionalHandoff(handoffPath);
  if (existing) {
    if (existing.handoffId !== id || existing.contentHash !== contentHash) {
      throw new Error("Existing B-roll handoff path belongs to a different immutable handoff");
    }
    await writeProjectHandoffRegistration(projectDir, handoffPath);
    for (const sibling of pendingSiblings) {
      sibling.record.status = "superseded";
      sibling.record.supersession = {
        supersededByHandoffId: id,
        supersededAt: isoNow(),
        reason: "Replaced before user approval with a revised generation prompt or reason",
      };
      await writeJsonAtomic(sibling.path, sibling.record);
    }
    return {
      handoffId: id,
      handoffPath,
      contentHash,
      inputHash: contentHash,
      status: existing.status,
      idempotent: true,
    };
  }
  const record: BrollHandoffRecord = {
    schemaVersion: SCHEMA_VERSION,
    kind: "minimax-broll-handoff",
    handoffId: id,
    status: "pending_user_approval",
    content,
    contentHash,
    inputHash: contentHash,
    preparedAt: isoNow(),
    approval: null,
    execution: { status: "not_started", attempts: 0 },
  };
  await mkdir(path.dirname(handoffPath), { recursive: true });
  await writeJsonAtomic(handoffPath, record);
  await writeProjectHandoffRegistration(projectDir, handoffPath);
  for (const sibling of pendingSiblings) {
    sibling.record.status = "superseded";
    sibling.record.supersession = {
      supersededByHandoffId: id,
      supersededAt: isoNow(),
      reason: "Replaced before user approval with a revised generation prompt or reason",
    };
    await writeJsonAtomic(sibling.path, sibling.record);
  }
    return { handoffId: id, handoffPath, contentHash, inputHash: contentHash, status: record.status, idempotent: false };
  });
}

async function readOptionalHandoff(filePath: string): Promise<BrollHandoffRecord | null> {
  try {
    return await readHandoff(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function resolveHandoffPath(projectDir: string, handoffIdOrPath: string): Promise<string> {
  const candidate = stablePath(handoffIdOrPath);
  if (handoffIdOrPath.includes("\\") || handoffIdOrPath.includes("/") || handoffIdOrPath.toLowerCase().endsWith(".json")) {
    const record = await readHandoff(candidate);
    assertCanonicalHandoffPath(projectDir, candidate, record.handoffId);
    return candidate;
  }
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  const registered = (project.artifacts as VideoProject["artifacts"] & { brollHandoffs?: string[] }).brollHandoffs ?? [];
  for (const item of registered) {
    const registeredPath = stablePath(path.resolve(projectDir, item));
    const record = await readOptionalHandoff(registeredPath);
    if (record?.handoffId === handoffIdOrPath) {
      assertCanonicalHandoffPath(projectDir, registeredPath, record.handoffId);
      return registeredPath;
    }
  }
  throw new Error(`B-roll handoff not found: ${handoffIdOrPath}`);
}

async function revisionForPreparation(
  projectDir: string,
  slotId: string,
  revisionOf?: string,
  revisionReason?: string,
  revisionPrompt?: string,
): Promise<{ revision: BrollHandoffContent["revision"]; promptOverride?: string }> {
  if (!revisionOf && !revisionReason && !revisionPrompt) {
    return {
      revision: {
        sequence: 0,
        previousHandoffId: null,
        previousResultContentHash: null,
        previousGenerationPayloadHash: null,
        reason: null,
      },
    };
  }
  if (!revisionOf || !revisionReason?.trim() || !revisionPrompt?.trim()) {
    throw new Error("A B-roll revision requires revisionOf, a non-empty revisionReason, and a complete revised prompt");
  }
  const previousPath = await resolveHandoffPath(projectDir, revisionOf);
  const previous = await readHandoff(previousPath);
  await currentPlanAndContent(projectDir, previous);
  if (previous.content.slot.id !== slotId) throw new Error("B-roll revision must keep the same approved slot");
  if (previous.status !== "needs_revision" || !previous.resultPath || !previous.resultContentHash) {
    throw new Error("B-roll revision requires a previously imported result that the user rejected");
  }
  const result = await readOptionalResult(previous.resultPath);
  if (!result || result.status !== "needs_revision" || result.review?.decision !== "revise") {
    throw new Error("B-roll revision requires hash-bound user revise evidence for the previous result");
  }
  await verifyResultContent(result.content);
  if (result.resultContentHash !== previous.resultContentHash) throw new Error("Previous B-roll revision result binding is stale");
  const promptOverride = nonEmpty(revisionPrompt, "revisionPrompt");
  const normalizedPrompt = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalizedPrompt(promptOverride) === normalizedPrompt(previous.content.generation.prompt)) {
    throw new Error("B-roll revision prompt must materially differ from the rejected generation prompt");
  }
  return {
    revision: {
      sequence: previous.content.revision.sequence + 1,
      previousHandoffId: previous.handoffId,
      previousResultContentHash: result.resultContentHash,
      previousGenerationPayloadHash: previous.content.generation.payloadHash,
      reason: revisionReason.trim(),
    },
    promptOverride,
  };
}

export async function approveBrollHandoff(input: {
  projectDir: string;
  handoffPath?: string;
  handoffId?: string;
  slotId: string;
  reviewer: string;
  authority: "user" | "operator";
  handoffContentHash: string;
}) {
  const projectDir = stablePath(input.projectDir);
  return withProjectStateLock(projectDir, "approve-handoff", async () => {
    assertBrollMutationAllowed(await readJson<VideoProject>(path.join(projectDir, "project.json")));
    const handoffPath = await resolveHandoffPath(projectDir, input.handoffPath ?? input.handoffId ?? "");
    const handoff = await readHandoff(handoffPath);
  const reviewer = nonEmpty(input.reviewer, "reviewer");
  if (input.authority !== "user") throw new Error("B-roll generation approval is a user gate");
  if (input.slotId !== handoff.content.slot.id) throw new Error("B-roll approval slotId does not match the handoff slot");
  if (input.handoffContentHash !== handoff.contentHash) throw new Error("B-roll approval must bind the current handoff contentHash");
  await currentPlanAndContent(projectDir, handoff);
  if (
    handoff.status === "approved"
    || handoff.status === "execution_claimed"
    || handoff.status === "result_pending_user_review"
    || handoff.status === "accepted"
  ) {
    if (handoff.approval?.handoffContentHash !== input.handoffContentHash) throw new Error("Existing B-roll approval is bound to a different handoff hash");
    return { handoffId: handoff.handoffId, handoffPath, status: handoff.status, idempotent: true };
  }
  if (handoff.status !== "pending_user_approval") {
    throw new Error(`B-roll handoff cannot be approved from status ${handoff.status}`);
  }
  const reviewedHandoffSha256 = await sha256File(handoffPath);
  handoff.status = "approved";
  handoff.approval = {
    decision: "approve",
    reviewer,
    authority: "user",
    slotId: input.slotId,
    handoffContentHash: input.handoffContentHash,
    reviewedHandoffSha256,
    approvedAt: isoNow(),
  };
  handoff.execution = { status: "not_started", attempts: 0 };
  await writeJsonAtomic(handoffPath, handoff);
    return { handoffId: handoff.handoffId, handoffPath, status: handoff.status, idempotent: false };
  });
}

/**
 * Issue the short-lived, hash-bound lease that an executor must obtain
 * immediately before starting a billable generation request. User approval
 * alone is deliberately non-executable. The claim step re-checks the live
 * recreation plan, privacy contract, authorization state and reference bytes.
 *
 * An existing claim is returned only to the same named executor/caller while
 * it remains live. Expired claims fail closed: a human must first reconcile
 * whether a provider task was already submitted instead of silently creating
 * a second billable request.
 */
export async function claimBrollExecution(input: {
  projectDir: string;
  handoffPath?: string;
  handoffId?: string;
  executor: string;
  claimedBy: string;
  ttlSeconds?: number;
}) {
  const projectDir = stablePath(input.projectDir);
  return withProjectStateLock(projectDir, "claim-execution", async () => {
    assertBrollMutationAllowed(await readJson<VideoProject>(path.join(projectDir, "project.json")));
    const handoffPath = await resolveHandoffPath(projectDir, input.handoffPath ?? input.handoffId ?? "");
    const handoff = await readHandoff(handoffPath);
    const executor = nonEmpty(input.executor, "executor");
    const claimedBy = nonEmpty(input.claimedBy, "claimedBy");
  if (executor !== handoff.content.generation.executor) {
    throw new Error(`B-roll execution claim executor must match the approved handoff executor ${handoff.content.generation.executor}`);
  }
  await currentPlanAndContent(projectDir, handoff);
  if (!handoff.approval || handoff.approval.handoffContentHash !== handoff.contentHash) {
    throw new Error("B-roll execution claim requires a current user approval bound to the handoff contentHash");
  }
  if (handoff.status === "execution_claimed") {
    const existing = assertExecutionClaim(handoff);
    if (existing.executor !== executor || existing.claimedBy !== claimedBy) {
      throw new Error("B-roll execution already has a live claim owned by another executor or caller");
    }
    if (Date.parse(existing.expiresAt) <= Date.now()) {
      throw new Error("B-roll execution claim expired; reconcile provider task state before requesting any new paid execution");
    }
    return {
      handoffId: handoff.handoffId,
      handoffPath,
      status: handoff.status,
      claimHash: existing.claimHash,
      issuedAt: existing.issuedAt,
      expiresAt: existing.expiresAt,
      idempotent: true,
    };
  }
  if (handoff.status !== "approved") {
    throw new Error(`B-roll execution cannot be claimed from handoff status ${handoff.status}`);
  }
  const ttlSeconds = input.ttlSeconds ?? 900;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
    throw new Error("B-roll execution claim ttlSeconds must be an integer from 60 to 3600");
  }
  const issuedAt = isoNow();
  const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
  const sequence = (handoff.execution.reconciledClaims?.at(-1)?.claim.sequence ?? 0) + 1;
  const claimWithoutHash = {
    sequence,
    executor,
    claimedBy,
    handoffContentHash: handoff.contentHash,
    planContentHash: handoff.content.plan.contentHash,
    privacyHash: handoff.content.project.privacyHash,
    issuedAt,
    expiresAt,
  };
  const claim = { claimHash: sha256Canonical(claimWithoutHash), ...claimWithoutHash };
  handoff.status = "execution_claimed";
  handoff.execution = {
    status: "claimed",
    attempts: 0,
    claim,
    reconciledClaims: handoff.execution.reconciledClaims,
  };
  await writeJsonAtomic(handoffPath, handoff);
    return {
      handoffId: handoff.handoffId,
      handoffPath,
      status: handoff.status,
      claimHash: claim.claimHash,
      issuedAt,
      expiresAt,
      idempotent: false,
    };
  });
}

/**
 * Release a claim only after a named user/operator explicitly confirms that
 * no provider request was submitted. The old claim remains immutable audit
 * evidence and the next claim receives a higher sequence number.
 */
export async function reconcileBrollExecutionClaim(input: {
  projectDir: string;
  handoffPath?: string;
  handoffId?: string;
  claimHash: string;
  outcome: "confirmed_not_submitted";
  reconciledBy: string;
  authority: "user" | "operator";
  reason: string;
}) {
  const projectDir = stablePath(input.projectDir);
  return withProjectStateLock(projectDir, "reconcile-execution", async () => {
    assertBrollMutationAllowed(await readJson<VideoProject>(path.join(projectDir, "project.json")));
    const handoffPath = await resolveHandoffPath(projectDir, input.handoffPath ?? input.handoffId ?? "");
    const handoff = await readHandoff(handoffPath);
  if (handoff.status !== "execution_claimed" || handoff.execution.status !== "claimed") {
    throw new Error(`B-roll execution claim cannot be reconciled from handoff status ${handoff.status}`);
  }
  const claim = assertExecutionClaim(handoff);
  if (sha(input.claimHash, "claimHash") !== claim.claimHash) {
    throw new Error("B-roll execution reconciliation must bind the active claimHash");
  }
  if (input.outcome !== "confirmed_not_submitted") {
    throw new Error("Only an explicit confirmed_not_submitted outcome can release a B-roll execution claim");
  }
  const reconciledBy = nonEmpty(input.reconciledBy, "reconciledBy");
  if (input.authority !== "user" && input.authority !== "operator") {
    throw new Error("B-roll execution reconciliation authority must be user or operator");
  }
  const reason = nonEmpty(input.reason, "reason");
  const reconciledAt = isoNow();
  const reconciledClaims = [
    ...(handoff.execution.reconciledClaims ?? []),
    { claim, outcome: input.outcome, reconciledBy, authority: input.authority, reason, reconciledAt },
  ];
  handoff.status = "approved";
  handoff.execution = { status: "not_started", attempts: 0, reconciledClaims };
  await writeJsonAtomic(handoffPath, handoff);
    return {
      handoffId: handoff.handoffId,
      handoffPath,
      status: handoff.status,
      reconciledClaimHash: claim.claimHash,
      reconciledAt,
    };
  });
}

function normalizeExternalPath(value: unknown, baseDir: string, label: string): string {
  const text = nonEmpty(value, label);
  return stablePath(path.isAbsolute(text) ? text : path.resolve(baseDir, text));
}

function keyframeTime(frame: BrollExternalKeyframeInput, index: number): number {
  const value = frame.timeSeconds ?? frame.timestampSeconds ?? frame.time ?? frame.timestamp;
  const time = finiteNumber(value, `keyframes[${index}].timeSeconds`);
  if (time < 0) throw new Error(`keyframes[${index}].timeSeconds must be non-negative`);
  return Number(time.toFixed(6));
}

function probeVideo(videoPath: string): BrollProbeEvidence {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height", "-of", "json", videoPath],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`B-roll video is not readable by ffprobe: ${result.stderr?.trim() || "ffprobe failed"}`);
  let payload: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    payload = JSON.parse(result.stdout) as typeof payload;
  } catch {
    throw new Error("B-roll ffprobe returned invalid JSON");
  }
  const video = (payload.streams ?? []).find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("B-roll output must contain a video stream");
  const duration = Number(payload.format?.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    formatName: typeof payload.format?.format_name === "string" ? payload.format.format_name : null,
    videoCodec: typeof video.codec_name === "string" ? video.codec_name : null,
    width: typeof video.width === "number" ? video.width : null,
    height: typeof video.height === "number" ? video.height : null,
  };
}

async function extractVerifiedFrame(input: {
  videoPath: string;
  outputPath: string;
  timeSeconds: number;
  label: string;
}): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-ss", input.timeSeconds.toFixed(6),
      "-i", input.videoPath,
      "-frames:v", "1",
      "-y", input.outputPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`${input.label} could not be extracted from the returned video: ${result.stderr?.trim() || "ffmpeg failed"}`);
  }
  return fileEvidence(input.outputPath, input.label);
}

function numericAspectRatio(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`Unsupported B-roll aspect ratio: ${value}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) throw new Error(`Invalid B-roll aspect ratio: ${value}`);
  return width / height;
}

function assertOutputProbe(probe: BrollProbeEvidence, handoff: BrollHandoffRecord): number {
  if (!probe.durationSeconds || !probe.width || !probe.height) {
    throw new Error("B-roll output probe lacks duration or dimensions");
  }
  const expectedDuration = handoff.content.generation.durationSeconds;
  const durationTolerance = Math.max(0.5, expectedDuration * 0.25);
  if (Math.abs(probe.durationSeconds - expectedDuration) > durationTolerance) {
    throw new Error(`B-roll output duration ${probe.durationSeconds}s differs from approved ${expectedDuration}s`);
  }
  const expectedAspect = numericAspectRatio(handoff.content.generation.aspectRatio);
  const actualAspect = probe.width / probe.height;
  if (Math.abs(actualAspect - expectedAspect) / expectedAspect > 0.03) {
    throw new Error(`B-roll output aspect ratio ${probe.width}:${probe.height} differs from approved ${handoff.content.generation.aspectRatio}`);
  }
  return probe.durationSeconds;
}

async function buildResultContent(input: {
  manifestPath: string;
  manifest: BrollExternalResultInput;
  handoff: BrollHandoffRecord;
  evidenceDir: string;
}): Promise<BrollResultContent> {
  const baseDir = path.dirname(input.manifestPath);
  if (input.manifest.handoffId !== input.handoff.handoffId) throw new Error("B-roll result handoffId does not match the prepared handoff");
  if (input.manifest.inputHash !== input.handoff.inputHash) throw new Error("B-roll result inputHash does not match the prepared handoff");
  if (input.manifest.handoffContentHash !== undefined && input.manifest.handoffContentHash !== input.handoff.contentHash) {
    throw new Error("B-roll result handoffContentHash does not match the prepared handoff");
  }
  const claim = assertExecutionClaim(input.handoff);
  const executionClaimHash = sha(input.manifest.executionClaimHash, "executionClaimHash");
  if (executionClaimHash !== claim.claimHash) {
    throw new Error("B-roll result executionClaimHash does not match the active execution claim");
  }
  const videoPath = normalizeExternalPath(input.manifest.video?.path ?? input.manifest.videoPath, baseDir, "video.path");
  const expectedVideoHash = sha(input.manifest.video?.sha256 ?? input.manifest.videoSha256, "video.sha256");
  const videoEvidence = await fileEvidence(videoPath, "B-roll video");
  if (videoEvidence.sha256 !== expectedVideoHash) throw new Error("B-roll video hash does not match the external manifest");
  const declaredVideoSize = input.manifest.video?.sizeBytes ?? input.manifest.videoSizeBytes;
  if (declaredVideoSize !== undefined && declaredVideoSize !== videoEvidence.sizeBytes) {
    throw new Error("B-roll video size does not match the external manifest");
  }
  const probe = probeVideo(videoPath);
  const probedDuration = assertOutputProbe(probe, input.handoff);
  const rawFrames = input.manifest.keyframes ?? input.manifest.keyFrames;
  if (!Array.isArray(rawFrames) || rawFrames.length < 3) throw new Error("B-roll result requires at least three keyframes");
  const frameRequests: Array<{ timeSeconds: number }> = [];
  const times = new Set<number>();
  const paths = new Set<string>();
  for (const [index, rawFrame] of rawFrames.entries()) {
    if (!rawFrame || typeof rawFrame !== "object") throw new Error(`keyframes[${index}] must be an object`);
    const frame = rawFrame as BrollExternalKeyframeInput;
    const timeSeconds = keyframeTime(frame, index);
    if (times.has(timeSeconds)) throw new Error("B-roll keyframes must use three different time points");
    times.add(timeSeconds);
    const framePath = normalizeExternalPath(frame.path, baseDir, `keyframes[${index}].path`);
    const pathKey = framePath.toLowerCase();
    if (paths.has(pathKey)) throw new Error("B-roll keyframes must reference three different files");
    paths.add(pathKey);
    const expectedHash = sha(frame.sha256, `keyframes[${index}].sha256`);
    const evidence = await fileEvidence(framePath, `B-roll keyframe ${index + 1}`);
    if (evidence.sha256 !== expectedHash) throw new Error(`B-roll keyframe hash does not match the external manifest: ${framePath}`);
    if (frame.sizeBytes !== undefined && frame.sizeBytes !== evidence.sizeBytes) {
      throw new Error(`B-roll keyframe size does not match the external manifest: ${framePath}`);
    }
    if (timeSeconds > probedDuration) throw new Error(`B-roll keyframe time exceeds video duration: ${timeSeconds}s`);
    frameRequests.push({ timeSeconds });
  }
  frameRequests.sort((left, right) => left.timeSeconds - right.timeSeconds);
  const entryLimit = Math.max(0.5, probedDuration * 0.2);
  const exitLimit = Math.min(probedDuration - 0.5, probedDuration * 0.8);
  if (frameRequests[0].timeSeconds > entryLimit) throw new Error("B-roll keyframes do not include an entry frame");
  if (frameRequests.at(-1)!.timeSeconds < exitLimit) throw new Error("B-roll keyframes do not include an exit frame");
  const verifiedDir = path.join(input.evidenceDir, "verified-keyframes", videoEvidence.sha256);
  const keyframes: BrollResultContent["keyframes"] = [];
  for (const [index, request] of frameRequests.entries()) {
    const micros = Math.round(request.timeSeconds * 1_000_000).toString().padStart(10, "0");
    const outputPath = path.join(verifiedDir, `${String(index + 1).padStart(2, "0")}-${micros}.png`);
    const evidence = await extractVerifiedFrame({
      videoPath: videoEvidence.path,
      outputPath,
      timeSeconds: request.timeSeconds,
      label: `B-roll verified keyframe ${index + 1}`,
    });
    keyframes.push({ role: "support", timeSeconds: request.timeSeconds, ...evidence });
  }
  const interior = keyframes.slice(1, -1);
  const climax = interior.reduce((best, frame) =>
    Math.abs(frame.timeSeconds - probedDuration / 2) < Math.abs(best.timeSeconds - probedDuration / 2) ? frame : best,
  );
  keyframes[0].role = "entry";
  climax.role = "climax";
  keyframes[keyframes.length - 1].role = "exit";
  const manifestSha256 = await sha256File(input.manifestPath);
  return {
    handoffId: input.handoff.handoffId,
    inputHash: input.handoff.inputHash,
    handoffContentHash: input.handoff.contentHash,
    executionClaimHash,
    manifestPath: stablePath(input.manifestPath),
    manifestSha256,
    video: { path: videoEvidence.path, sha256: videoEvidence.sha256, sizeBytes: videoEvidence.sizeBytes, probe },
    keyframes,
  };
}

function handoffStatusForResult(status: BrollResultStatus): BrollHandoffStatus {
  if (status === "pending_user_review" || status === "acceptance_pending_registration") return "result_pending_user_review";
  return status;
}

async function synchronizeHandoffResult(
  projectDir: string,
  handoffPath: string,
  handoff: BrollHandoffRecord,
  resultPath: string,
  result: BrollResultRecord,
): Promise<void> {
  if (!handoff.approval || handoff.approval.handoffContentHash !== handoff.contentHash) {
    throw new Error("B-roll result synchronization requires current user approval");
  }
  if (result.status === "accepted") {
    await verifyAcceptedAssetRegistration(projectDir, handoff, result);
  }
  const expectedStatus = handoffStatusForResult(result.status);
  const expectedImportedAt = handoff.execution.importedAt ?? result.importedAt;
  if (
    handoff.status === expectedStatus
    && handoff.resultPath === resultPath
    && handoff.resultContentHash === result.resultContentHash
    && handoff.execution.status === "returned"
    && handoff.execution.attempts === 1
    && handoff.execution.importedAt === expectedImportedAt
  ) return;
  handoff.status = expectedStatus;
  handoff.resultPath = resultPath;
  handoff.resultContentHash = result.resultContentHash;
  handoff.execution = { ...handoff.execution, status: "returned", attempts: 1, importedAt: expectedImportedAt };
  await writeJsonAtomic(handoffPath, handoff);
}

async function verifyResultContent(content: BrollResultContent): Promise<void> {
  const manifest = await fileEvidence(content.manifestPath, "B-roll result manifest");
  if (manifest.sha256 !== content.manifestSha256) throw new Error("B-roll result manifest changed after import");
  const video = await fileEvidence(content.video.path, "B-roll video");
  if (video.sha256 !== content.video.sha256 || video.sizeBytes !== content.video.sizeBytes) throw new Error("B-roll video changed after import");
  const currentProbe = probeVideo(content.video.path);
  if (sha256Canonical(currentProbe) !== sha256Canonical(content.video.probe)) {
    throw new Error("B-roll video probe evidence changed after import");
  }
  const times = new Set<number>();
  const roles = new Set<string>();
  for (const [index, frame] of content.keyframes.entries()) {
    if (times.has(frame.timeSeconds)) throw new Error("B-roll result keyframe times are not distinct");
    times.add(frame.timeSeconds);
    roles.add(frame.role);
    const actual = await fileEvidence(frame.path, `B-roll keyframe ${index + 1}`);
    if (actual.sha256 !== frame.sha256 || actual.sizeBytes !== frame.sizeBytes) throw new Error(`B-roll keyframe changed after import: ${frame.path}`);
  }
  for (const requiredRole of ["entry", "climax", "exit"]) {
    if (!roles.has(requiredRole)) throw new Error(`B-roll result is missing ${requiredRole} keyframe evidence`);
  }
}

export async function importBrollResult(input: {
  projectDir: string;
  inputPath: string;
  handoffPath?: string;
  handoffId?: string;
}) {
  const projectDir = stablePath(input.projectDir);
  const manifestPath = stablePath(input.inputPath);
  const manifest = await readJson<BrollExternalResultInput>(manifestPath);
  return withProjectStateLock(projectDir, "import-result", async () => {
    assertBrollMutationAllowed(await readJson<VideoProject>(path.join(projectDir, "project.json")));
    const handoffPath = await resolveHandoffPath(projectDir, input.handoffPath ?? input.handoffId ?? manifest.handoffId);
    const handoff = await readHandoff(handoffPath);
  await currentPlanAndContent(projectDir, handoff);
  if (!handoff.approval || handoff.approval.handoffContentHash !== handoff.contentHash) {
    throw new Error("B-roll result import requires a current user approval bound to the handoff contentHash");
  }
  if (!["execution_claimed", "result_pending_user_review", "needs_revision", "accepted"].includes(handoff.status)) {
    throw new Error(`B-roll result cannot be imported from handoff status ${handoff.status}`);
  }
  const resultPath = stablePath(path.join(path.dirname(handoffPath), BROLL_RESULT_FILE));
  const existing = await readOptionalResult(resultPath);
  if (existing) {
    await verifyResultContent(existing.content);
    const currentManifest = await fileEvidence(manifestPath, "B-roll result manifest");
    if (
      existing.content.manifestPath === manifestPath
      && existing.content.manifestSha256 === currentManifest.sha256
      && existing.content.handoffId === handoff.handoffId
      && existing.content.inputHash === handoff.inputHash
      && existing.content.executionClaimHash === assertExecutionClaim(handoff).claimHash
    ) {
      await synchronizeHandoffResult(projectDir, handoffPath, handoff, resultPath, existing);
      return { handoffId: handoff.handoffId, resultPath, resultContentHash: existing.resultContentHash, status: existing.status, idempotent: true };
    }
    throw new Error("B-roll handoff already has a different imported result; refusing duplicate generation/import");
  }
  if (handoff.status !== "execution_claimed") {
    throw new Error(`A new B-roll result requires an active execution claim, got handoff status ${handoff.status}`);
  }
  const content = await buildResultContent({ manifestPath, manifest, handoff, evidenceDir: path.dirname(resultPath) });
  const resultContentHash = sha256Canonical(content);
  const result: BrollResultRecord = {
    schemaVersion: SCHEMA_VERSION,
    kind: "minimax-broll-result",
    status: "pending_user_review",
    handoffId: handoff.handoffId,
    content,
    resultContentHash,
    review: null,
    assetRegistration: null,
    importedAt: isoNow(),
  };
  await writeJsonAtomic(resultPath, result);
  await synchronizeHandoffResult(projectDir, handoffPath, handoff, resultPath, result);
    return { handoffId: handoff.handoffId, resultPath, resultContentHash, status: result.status, idempotent: false };
  });
}

async function readOptionalResult(resultPath: string): Promise<BrollResultRecord | null> {
  try {
    const result = await readJson<BrollResultRecord>(resultPath);
    if (result.kind !== "minimax-broll-result") throw new Error("Existing B-roll result has an invalid kind");
    if (result.resultContentHash !== sha256Canonical(result.content)) throw new Error("Existing B-roll result contentHash is stale");
    assertResultWorkflowState(result);
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertAcceptedAssetRegistrationShape(result: BrollResultRecord): void {
  const raw = result.assetRegistration as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("accepted B-roll result lacks a structured asset registration");
  }
  const registration = raw as Record<string, unknown>;
  const assetId = nonEmpty(registration.assetId, "result.assetRegistration.assetId");
  const slotId = nonEmpty(registration.slotId, "result.assetRegistration.slotId");
  if (assetId !== `asset_${result.content.video.sha256.slice(0, 16)}`) {
    throw new Error("accepted B-roll asset registration has an invalid assetId");
  }
  if (!/^broll_[a-f0-9]{20}$/.test(slotId)) throw new Error("accepted B-roll asset registration has an invalid slotId");
  sha(registration.planContentHash, "result.assetRegistration.planContentHash");
  if (registration.handoffId !== result.handoffId) throw new Error("accepted B-roll asset registration handoffId is stale");
  if (registration.inputHash !== result.content.inputHash) throw new Error("accepted B-roll asset registration inputHash is stale");
  if (registration.resultContentHash !== result.resultContentHash) throw new Error("accepted B-roll asset registration resultContentHash is stale");
  if (registration.videoSha256 !== result.content.video.sha256) throw new Error("accepted B-roll asset registration videoSha256 is stale");
  validIsoDateTime(registration.registeredAt, "result.assetRegistration.registeredAt");
}

function assertResultWorkflowState(result: BrollResultRecord): void {
  if (result.schemaVersion !== SCHEMA_VERSION || result.kind !== "minimax-broll-result") throw new Error("B-roll result identity is invalid");
  if (!BROLL_HANDOFF_ID.test(result.handoffId) || result.content.handoffId !== result.handoffId) throw new Error("B-roll result handoffId is invalid");
  if (!new Set<BrollResultStatus>(["pending_user_review", "acceptance_pending_registration", "accepted", "needs_revision", "stale"]).has(result.status)) {
    throw new Error(`B-roll result status is invalid: ${String(result.status)}`);
  }
  validIsoDateTime(result.importedAt, "result.importedAt");
  sha(result.content.executionClaimHash, "result.content.executionClaimHash");
  const review = result.review;
  if (result.status === "pending_user_review") {
    if (review !== null) throw new Error("pending B-roll result cannot already contain review evidence");
    if (result.assetRegistration !== null) throw new Error("pending B-roll result cannot contain an accepted asset registration");
    return;
  }
  const hasAcceptanceIntent = result.status === "acceptance_pending_registration" || result.status === "accepted";
  if (hasAcceptanceIntent && (!review || review.decision !== "accept")) {
    throw new Error(`${result.status} B-roll result lacks an accept review`);
  }
  if (result.status === "acceptance_pending_registration" && result.assetRegistration !== null) {
    throw new Error("B-roll acceptance intent cannot contain asset registration before registration completes");
  }
  if (result.status === "accepted") {
    assertAcceptedAssetRegistrationShape(result);
  }
  if (result.status === "needs_revision" && (!review || review.decision !== "revise")) {
    throw new Error("rejected B-roll result lacks a revise review");
  }
  if (result.status !== "accepted" && result.assetRegistration !== null) {
    throw new Error(`${result.status} B-roll result cannot contain an accepted asset registration`);
  }
  if (review === null) return;
  if (typeof review !== "object" || (review.decision !== "accept" && review.decision !== "revise")) {
    throw new Error("B-roll result review evidence is malformed");
  }
  if (hasAcceptanceIntent) {
    if (
      !review.rights
      || review.rights.status !== "confirmed_for_project_use"
      || !review.rights.basis?.trim()
      || review.rights.confirmedBy !== review.reviewer
      || review.rights.confirmedAt !== review.reviewedAt
    ) {
      throw new Error(`${result.status} B-roll result lacks explicit user rights confirmation for project use`);
    }
  } else if (review.rights !== null) {
    throw new Error(`${result.status} B-roll result cannot contain rights confirmation`);
  }
  if (
    review.authority !== "user"
    || !review.reviewer?.trim()
    || review.resultContentHash !== result.resultContentHash
    || review.handoffContentHash !== result.content.handoffContentHash
    || review.videoSha256 !== result.content.video.sha256
    || JSON.stringify(review.keyframeSha256) !== JSON.stringify(result.content.keyframes.map((frame) => frame.sha256))
  ) {
    throw new Error("B-roll result review evidence is not bound to the current result/video/keyframes");
  }
  validIsoDateTime(review.reviewedAt, "result.review.reviewedAt");
}

type BrollAssetRegistration = NonNullable<BrollResultRecord["assetRegistration"]>;

function expectedAssetRegistration(
  handoff: BrollHandoffRecord,
  result: BrollResultRecord,
  registeredAt: string,
): BrollAssetRegistration {
  return {
    assetId: `asset_${result.content.video.sha256.slice(0, 16)}`,
    slotId: handoff.content.slot.id,
    planContentHash: handoff.content.plan.contentHash,
    handoffId: handoff.handoffId,
    inputHash: handoff.inputHash,
    resultContentHash: result.resultContentHash,
    videoSha256: result.content.video.sha256,
    registeredAt,
  };
}

function sameBrollBinding(binding: Record<string, unknown>, expected: BrollAssetRegistration): boolean {
  return binding.slotId === expected.slotId
    && binding.planContentHash === expected.planContentHash
    && binding.handoffId === expected.handoffId
    && binding.inputHash === expected.inputHash
    && binding.resultContentHash === expected.resultContentHash
    && binding.videoSha256 === expected.videoSha256;
}

async function ensureAcceptedAssetRegistration(
  projectDir: string,
  resultPath: string,
  handoff: BrollHandoffRecord,
  result: BrollResultRecord,
): Promise<BrollAssetRegistration> {
  if (
    !new Set<BrollResultStatus>(["acceptance_pending_registration", "accepted"]).has(result.status)
    || result.review?.decision !== "accept"
  ) {
    throw new Error("Only a hash-bound B-roll acceptance intent can be registered as an asset");
  }
  const confirmedRights = result.review.rights;
  if (!confirmedRights || confirmedRights.status !== "confirmed_for_project_use") {
    throw new Error("Accepted B-roll must have explicit user rights confirmation before asset registration");
  }
  const assetsPath = path.join(projectDir, "assets.json");
  const assetsFile = await readJson<AssetsFile>(assetsPath);
  const assets = assetsFile.assets ?? [];
  let registeredAt = result.assetRegistration?.registeredAt;
  if (!registeredAt) {
    const provisional = expectedAssetRegistration(handoff, result, isoNow());
    for (const candidate of assets) {
      const recovered = (candidate.brollBindings ?? []).find((binding) => sameBrollBinding(binding, provisional));
      if (typeof recovered?.registeredAt === "string") {
        registeredAt = validIsoDateTime(recovered.registeredAt, "assets.brollBindings.registeredAt");
        break;
      }
    }
  }
  registeredAt ??= isoNow();
  const registration = expectedAssetRegistration(handoff, result, registeredAt);
  if (result.assetRegistration && sha256Canonical(result.assetRegistration) !== sha256Canonical(registration)) {
    throw new Error("B-roll result asset registration is stale or bound to different evidence");
  }
  for (const asset of assets) {
    for (const binding of asset.brollBindings ?? []) {
      if (
        binding.slotId === registration.slotId
        && binding.planContentHash === registration.planContentHash
        && !sameBrollBinding(binding, registration)
      ) {
        throw new Error(`B-roll slot ${registration.slotId} already has a different accepted asset binding`);
      }
    }
  }
  let asset = assets.find((candidate) => candidate.assetId === registration.assetId);
  if (asset) {
    if (asset.sha256 !== result.content.video.sha256) throw new Error("Existing B-roll asset ID is bound to different bytes");
    if (!samePath(nonEmpty(asset.path, "assets.path"), result.content.video.path)) {
      throw new Error("Existing B-roll asset path differs from the accepted result path");
    }
    const roles = new Set(Array.isArray(asset.roles) ? asset.roles : []);
    if (typeof asset.role === "string") roles.add(asset.role);
    roles.add("b-roll");
    asset.roles = [...roles];
    if (asset.role !== "a-roll") asset.role = "b-roll";
    const bindings = asset.brollBindings ?? [];
    if (!bindings.some((binding) => sameBrollBinding(binding, registration))) bindings.push(registration);
    asset.brollBindings = bindings;
    asset.rights = { ...confirmedRights };
  } else {
    asset = {
      assetId: registration.assetId,
      path: result.content.video.path,
      fileName: path.basename(result.content.video.path),
      role: "b-roll",
      roles: ["b-roll"],
      provenance: "minimax-generated",
      sha256: result.content.video.sha256,
      sizeBytes: result.content.video.sizeBytes,
      media: {
        durationSeconds: result.content.video.probe.durationSeconds,
        formatName: result.content.video.probe.formatName,
        video: {
          codec: result.content.video.probe.videoCodec,
          width: result.content.video.probe.width,
          height: result.content.video.probe.height,
          fps: null,
        },
        audio: null,
      },
      rights: { ...confirmedRights },
      cloudProcessing: [{
        provider: handoff.content.generation.executor,
        model: handoff.content.generation.model,
        mode: handoff.content.generation.mode,
        inputHash: handoff.inputHash,
        resultContentHash: result.resultContentHash,
      }],
      brollBindings: [registration],
      registeredAt,
    };
    assets.push(asset);
  }
  assetsFile.schemaVersion = SCHEMA_VERSION;
  assetsFile.assets = assets;
  await writeJsonAtomic(assetsPath, assetsFile);
  if (result.status !== "accepted" || !result.assetRegistration) {
    result.assetRegistration = registration;
    result.status = "accepted";
    await writeJsonAtomic(resultPath, result);
  }
  return registration;
}

async function verifyAcceptedAssetRegistration(
  projectDir: string,
  handoff: BrollHandoffRecord,
  result: BrollResultRecord,
): Promise<void> {
  if (result.status !== "accepted") return;
  if (!result.assetRegistration) throw new Error("accepted B-roll result is not registered in assets.json");
  const expected = expectedAssetRegistration(handoff, result, result.assetRegistration.registeredAt);
  if (sha256Canonical(expected) !== sha256Canonical(result.assetRegistration)) {
    throw new Error("accepted B-roll asset registration does not match the result/slot hashes");
  }
  const assetsFile = await readJson<AssetsFile>(path.join(projectDir, "assets.json"));
  const asset = (assetsFile.assets ?? []).find((candidate) => candidate.assetId === expected.assetId);
  if (!asset || asset.sha256 !== expected.videoSha256 || !asset.path || !samePath(asset.path, result.content.video.path)) {
    throw new Error("accepted B-roll asset is missing or stale in assets.json");
  }
  if (!(asset.brollBindings ?? []).some((binding) => sameBrollBinding(binding, expected))) {
    throw new Error("accepted B-roll asset lacks its slot/result binding in assets.json");
  }
  const confirmedRights = result.review?.rights;
  const assetRights = asset.rights as Record<string, unknown> | undefined;
  if (
    !confirmedRights
    || assetRights?.status !== confirmedRights.status
    || assetRights?.basis !== confirmedRights.basis
    || assetRights?.confirmedBy !== confirmedRights.confirmedBy
    || assetRights?.confirmedAt !== confirmedRights.confirmedAt
  ) {
    throw new Error("accepted B-roll asset lacks matching user rights confirmation");
  }
}

async function resolveResultPath(projectDir: string, input: { resultPath?: string; handoffPath?: string; handoffId?: string }): Promise<{ handoffPath: string; resultPath: string }> {
  const handoffPath = await resolveHandoffPath(projectDir, input.handoffPath ?? input.handoffId ?? "");
  const handoff = await readHandoff(handoffPath);
  const expected = stablePath(canonicalResultPath(handoffPath));
  const resultPath = input.resultPath ? stablePath(input.resultPath) : handoff.resultPath;
  if (!resultPath) throw new Error("B-roll result has not been imported yet");
  if (!samePath(resultPath, expected)) throw new Error(`B-roll result must use its canonical path: ${expected}`);
  return { handoffPath, resultPath: expected };
}

export async function reviewBrollResult(input: {
  projectDir: string;
  resultPath?: string;
  handoffPath?: string;
  handoffId?: string;
  decision: "accept" | "revise";
  reviewer: string;
  authority: "user" | "operator";
  resultContentHash: string;
  notes?: string;
  rightsConfirmed?: boolean;
  rightsBasis?: string;
}) {
  const projectDir = stablePath(input.projectDir);
  return withProjectStateLock(projectDir, "review-result", async () => {
    assertBrollMutationAllowed(await readJson<VideoProject>(path.join(projectDir, "project.json")));
    const resolved = await resolveResultPath(projectDir, input);
    const handoff = await readHandoff(resolved.handoffPath);
  const result = await readOptionalResult(resolved.resultPath);
  if (!result) throw new Error("B-roll result has not been imported yet");
  if (result.handoffId !== handoff.handoffId || result.content.handoffId !== handoff.handoffId) throw new Error("B-roll result is bound to a different handoff");
  if (
    !handoff.approval
    || handoff.approval.handoffContentHash !== handoff.contentHash
    || !handoff.resultPath
    || !samePath(handoff.resultPath, resolved.resultPath)
    || handoff.resultContentHash !== result.resultContentHash
    || !new Set<BrollHandoffStatus>(["result_pending_user_review", "accepted", "needs_revision"]).has(handoff.status)
  ) {
    throw new Error("B-roll result review requires the current approved, imported handoff/result binding");
  }
  await currentPlanAndContent(projectDir, handoff);
  await verifyResultContent(result.content);
  if (result.resultContentHash !== sha256Canonical(result.content)) throw new Error("B-roll result contentHash is stale");
  if (input.authority !== "user") throw new Error("B-roll result acceptance is a user gate");
  const reviewer = nonEmpty(input.reviewer, "reviewer");
  if (input.resultContentHash !== result.resultContentHash) throw new Error("B-roll result review must bind the current resultContentHash");
  if (result.status === "acceptance_pending_registration") {
    if (input.decision === "accept" && result.review?.resultContentHash === input.resultContentHash) {
      await ensureAcceptedAssetRegistration(projectDir, resolved.resultPath, handoff, result);
      await synchronizeHandoffResult(projectDir, resolved.handoffPath, handoff, resolved.resultPath, result);
      return { handoffId: handoff.handoffId, resultPath: resolved.resultPath, status: result.status, idempotent: true };
    }
    throw new Error("B-roll acceptance was already recorded and asset registration must be completed before any new decision");
  }
  if (result.status === "accepted") {
    if (input.decision === "accept" && result.review?.resultContentHash === input.resultContentHash) {
      await ensureAcceptedAssetRegistration(projectDir, resolved.resultPath, handoff, result);
      await synchronizeHandoffResult(projectDir, resolved.handoffPath, handoff, resolved.resultPath, result);
      return { handoffId: handoff.handoffId, resultPath: resolved.resultPath, status: result.status, idempotent: true };
    }
    throw new Error("B-roll result has already been accepted; create a revised handoff for another result");
  }
  if (result.status === "needs_revision") {
    if (input.decision === "revise" && result.review?.resultContentHash === input.resultContentHash) {
      await synchronizeHandoffResult(projectDir, resolved.handoffPath, handoff, resolved.resultPath, result);
      return { handoffId: handoff.handoffId, resultPath: resolved.resultPath, status: result.status, idempotent: true };
    }
    throw new Error("B-roll result was rejected and cannot later be accepted unchanged; prepare a revised handoff/result");
  }
  if (result.status !== "pending_user_review") {
    throw new Error(`B-roll result cannot be reviewed from status ${result.status}`);
  }
  const rights = input.decision === "accept"
    ? {
        status: "confirmed_for_project_use" as const,
        basis: input.rightsConfirmed === true
          ? nonEmpty(input.rightsBasis, "rightsBasis")
          : (() => { throw new Error("Accepting generated B-roll requires explicit user rights confirmation for project use"); })(),
        confirmedBy: reviewer,
        confirmedAt: "",
      }
    : null;
  const reviewedAt = isoNow();
  if (rights) rights.confirmedAt = reviewedAt;
  result.status = input.decision === "accept" ? "acceptance_pending_registration" : "needs_revision";
  result.review = {
    decision: input.decision,
    reviewer,
    authority: "user",
    resultContentHash: result.resultContentHash,
    handoffContentHash: handoff.contentHash,
    videoSha256: result.content.video.sha256,
    keyframeSha256: result.content.keyframes.map((frame) => frame.sha256),
    reviewedAt,
    notes: input.notes?.trim() || null,
    rights,
  };
  result.assetRegistration = null;
  await writeJsonAtomic(resolved.resultPath, result);
  if (result.status === "acceptance_pending_registration") {
    await ensureAcceptedAssetRegistration(projectDir, resolved.resultPath, handoff, result);
  }
  await synchronizeHandoffResult(projectDir, resolved.handoffPath, handoff, resolved.resultPath, result);
    return { handoffId: handoff.handoffId, resultPath: resolved.resultPath, status: result.status, idempotent: false };
  });
}

export async function discoverBrollHandoffPaths(projectDir: string): Promise<string[]> {
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  const candidates = new Set<string>();
  const root = path.join(projectDir, BROLL_HANDOFF_DIR);
  const registered = (project.artifacts as VideoProject["artifacts"] & { brollHandoffs?: string[] }).brollHandoffs ?? [];
  for (const item of registered) {
    const registeredPath = stablePath(path.resolve(projectDir, item));
    assertPathInside(root, registeredPath, "Registered B-roll handoff path");
    candidates.add(registeredPath);
  }
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === BROLL_HANDOFF_FILE) candidates.add(stablePath(full));
    }
  };
  await walk(root);
  return [...candidates].sort();
}

/**
 * A paid execution claim is an unresolved external side effect. Callers that
 * revoke its privacy, reference, or plan preconditions must stop until the
 * result is imported or the operator records confirmed_not_submitted.
 *
 * The caller must hold the project-state lock while using this preflight and
 * while applying the dependent mutation.
 */
export async function assertNoActiveBrollExecutionClaims(
  projectDir: string,
  reason: string,
): Promise<void> {
  const active: string[] = [];
  for (const handoffPath of await discoverBrollHandoffPaths(stablePath(projectDir))) {
    const handoff = await readHandoff(handoffPath);
    if (handoff.status === "execution_claimed" || handoff.execution.status === "claimed") {
      const claim = assertExecutionClaim(handoff);
      active.push(`${handoff.handoffId}:${claim.claimHash}`);
    }
  }
  if (active.length > 0) {
    throw new Error(
      `${nonEmpty(reason, "reason")} is blocked by active B-roll execution claim(s): ${active.join(", ")}. `
      + "Import the returned result, or reconcile each claim as confirmed_not_submitted before continuing.",
    );
  }
}

/**
 * Fail closed when a recreation plan is withdrawn or replaced. Approval is
 * retained as audit evidence, but the handoff status becomes non-executable.
 */
export async function invalidateBrollHandoffsForPlan(input: {
  projectDir: string;
  planContentHash: string;
  invalidatedAt?: string;
}): Promise<{ invalidated: number }> {
  const projectDir = stablePath(input.projectDir);
  return withProjectStateLock(projectDir, "invalidate-plan", () => invalidateBrollHandoffsForPlanLocked({ ...input, projectDir }));
}

/** @internal Use only from a transaction that already owns project state. */
export async function invalidateBrollHandoffsForPlanWithinProjectLock(input: {
  projectDir: string;
  planContentHash: string;
  invalidatedAt?: string;
}): Promise<{ invalidated: number }> {
  const projectDir = stablePath(input.projectDir);
  assertProjectStateLockHeld(projectDir, "B-roll plan invalidation");
  return invalidateBrollHandoffsForPlanLocked({ ...input, projectDir });
}

async function invalidateBrollHandoffsForPlanLocked(input: {
  projectDir: string;
  planContentHash: string;
  invalidatedAt?: string;
}): Promise<{ invalidated: number }> {
  const projectDir = stablePath(input.projectDir);
  const planContentHash = sha(input.planContentHash, "planContentHash");
  const invalidatedAt = input.invalidatedAt ? validIsoDateTime(input.invalidatedAt, "invalidatedAt") : isoNow();
  const matching: Array<{ handoffPath: string; handoff: BrollHandoffRecord }> = [];
  for (const handoffPath of await discoverBrollHandoffPaths(projectDir)) {
    const handoff = await readHandoff(handoffPath);
    if (
      handoff.content.plan.contentHash === planContentHash
      && handoff.status !== "stale"
      && handoff.status !== "superseded"
    ) matching.push({ handoffPath, handoff });
  }
  const active = matching.filter(({ handoff }) =>
    handoff.status === "execution_claimed" || handoff.execution.status === "claimed",
  );
  if (active.length > 0) {
    throw new Error(
      `Recreation plan invalidation is blocked by active B-roll execution claim(s): ${active.map(({ handoff }) => handoff.handoffId).join(", ")}. `
      + "Import the returned result, or reconcile each claim as confirmed_not_submitted before withdrawing the plan.",
    );
  }
  let invalidated = 0;
  for (const { handoffPath, handoff } of matching) {
    handoff.status = "stale";
    handoff.staleEvidence = {
      reason: "recreation_plan_revised_or_replaced",
      invalidatedPlanContentHash: planContentHash,
      invalidatedAt,
    };
    await writeJsonAtomic(handoffPath, handoff);
    invalidated += 1;
  }
  return { invalidated };
}

/**
 * Semantic validator used by the project-level validator.  It is a no-op for
 * projects that have not prepared a B-roll handoff.
 */
export async function validateBrollHandoffs(projectDir: string): Promise<{ filesChecked: number; errors: string[] }> {
  const errors: string[] = [];
  const paths = await discoverBrollHandoffPaths(stablePath(projectDir));
  let filesChecked = 0;
  const seenIds = new Map<string, string>();
  const records = new Map<string, { path: string; handoff: BrollHandoffRecord }>();
  for (const handoffPath of paths) {
    filesChecked += 1;
    try {
      const handoff = await readHandoff(handoffPath);
      assertCanonicalHandoffPath(projectDir, handoffPath, handoff.handoffId);
      const duplicate = seenIds.get(handoff.handoffId);
      if (duplicate && !samePath(duplicate, handoffPath)) throw new Error(`duplicate handoffId also exists at ${duplicate}`);
      seenIds.set(handoff.handoffId, handoffPath);
      records.set(handoff.handoffId, { path: handoffPath, handoff });
    } catch (error) {
      errors.push(`${path.relative(projectDir, handoffPath).replaceAll("\\", "/")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let currentPlan: RecreationPlanArtifact | null = null;
  try {
    currentPlan = await verifyRecreationPlan(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && records.size > 0) {
      errors.push(`recreation-plan.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  const activeRevisionChildren = new Map<string, string>();
  const activeReplacement = (handoff: BrollHandoffRecord): BrollHandoffRecord => {
    let current = handoff;
    const visited = new Set<string>();
    while (current.status === "superseded") {
      if (visited.has(current.handoffId)) throw new Error("B-roll supersession chain contains a cycle");
      visited.add(current.handoffId);
      const replacementId = current.supersession!.supersededByHandoffId;
      const replacement = records.get(replacementId)?.handoff;
      if (!replacement) throw new Error(`superseded B-roll replacement is missing: ${replacementId}`);
      if (
        replacement.content.revision.previousHandoffId !== current.content.revision.previousHandoffId
        || replacement.content.revision.sequence !== current.content.revision.sequence
        || replacement.content.slot.id !== current.content.slot.id
        || replacement.content.plan.contentHash !== current.content.plan.contentHash
      ) {
        throw new Error("superseded B-roll replacement does not preserve the same plan, slot, and revision parent");
      }
      current = replacement;
    }
    return current;
  };

  for (const { path: handoffPath, handoff } of records.values()) {
    try {
      if (handoff.content.revision.previousHandoffId) {
        const previousId = handoff.content.revision.previousHandoffId;
        if (handoff.status !== "superseded") {
          const existingChild = activeRevisionChildren.get(previousId);
          if (existingChild && existingChild !== handoff.handoffId) throw new Error(`${previousId} has multiple active revision children`);
          activeRevisionChildren.set(previousId, handoff.handoffId);
        } else {
          activeReplacement(handoff);
        }
        const previous = records.get(previousId)?.handoff ?? await readHandoff(handoffDefaultPath(projectDir, previousId));
        let previousWasRejected = previous.status === "needs_revision";
        if (previous.status === "stale" && previous.resultPath && previous.resultContentHash) {
          const previousResult = await readOptionalResult(previous.resultPath);
          previousWasRejected = Boolean(
            previousResult
            && previousResult.status === "needs_revision"
            && previousResult.review?.decision === "revise"
            && previousResult.resultContentHash === previous.resultContentHash,
          );
        }
        if (
          !previousWasRejected
          || previous.resultContentHash !== handoff.content.revision.previousResultContentHash
          || previous.content.generation.payloadHash !== handoff.content.revision.previousGenerationPayloadHash
          || previous.content.generation.payloadHash === handoff.content.generation.payloadHash
          || previous.content.slot.id !== handoff.content.slot.id
          || previous.content.plan.contentHash !== handoff.content.plan.contentHash
          || previous.content.revision.sequence + 1 !== handoff.content.revision.sequence
        ) {
          throw new Error("B-roll revision ancestry is stale or does not follow a rejected result for the same slot");
        }
      }
      if (handoff.content.plan.status !== "approved" && handoff.content.plan.status !== "applied") {
        throw new Error("handoff plan status is not approved/applied");
      }
      if (
        currentPlan?.contentHash === handoff.content.plan.contentHash
        && handoff.status !== "stale"
        && new Set(["approved", "applied"]).has(currentPlan.status)
      ) {
        await currentPlanAndContent(projectDir, handoff);
      } else {
        if (handoff.status !== "stale" && handoff.status !== "superseded") {
          throw new Error("historical B-roll handoff remains executable; invalidate it when replacing the recreation plan");
        }
        if (project.projectId !== handoff.content.project.projectId) throw new Error("historical B-roll handoff belongs to a different project");
        for (const reference of handoff.content.referenceAssets) {
          const current = await fileEvidence(reference.path, "historical B-roll reference asset");
          if (current.sha256 !== reference.sha256 || current.sizeBytes !== reference.sizeBytes) {
            throw new Error(`historical B-roll reference asset changed: ${reference.path}`);
          }
        }
      }
      if (handoff.approval && handoff.approval.handoffContentHash !== handoff.contentHash) {
        throw new Error("handoff approval hash is stale");
      }
      if (handoff.resultPath) {
        const expectedResultPath = stablePath(canonicalResultPath(handoffPath));
        if (!samePath(handoff.resultPath, expectedResultPath)) throw new Error(`result must use its canonical path: ${expectedResultPath}`);
        const result = await readOptionalResult(handoff.resultPath);
        if (!result) throw new Error("bound result file is missing");
        filesChecked += 1;
        if (result.handoffId !== handoff.handoffId) throw new Error("result handoffId does not match handoff");
        if (result.resultContentHash !== sha256Canonical(result.content)) throw new Error("result contentHash is stale");
        if (result.content.inputHash !== handoff.inputHash) throw new Error("result inputHash does not match handoff");
        if (result.content.executionClaimHash !== handoff.execution.claim?.claimHash) {
          throw new Error("result executionClaimHash does not match the handoff execution claim");
        }
        await verifyResultContent(result.content);
        assertOutputProbe(result.content.video.probe, handoff);
        if (handoff.status !== "stale" && handoff.status !== handoffStatusForResult(result.status)) {
          throw new Error("handoff/result workflow statuses do not match");
        }
        if (handoff.resultContentHash !== result.resultContentHash) throw new Error("handoff resultContentHash does not match result");
        assertResultWorkflowState(result);
        await verifyAcceptedAssetRegistration(projectDir, handoff, result);
      }
    } catch (error) {
      errors.push(`${path.relative(projectDir, handoffPath).replaceAll("\\", "/")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { filesChecked, errors };
}

export async function brollArchiveErrors(projectDir: string): Promise<string[]> {
  const semantic = await validateBrollHandoffs(projectDir);
  if (semantic.errors.length > 0) return semantic.errors;
  const errors: string[] = [];
  const handoffs = await Promise.all((await discoverBrollHandoffPaths(projectDir)).map((handoffPath) => readHandoff(handoffPath)));
  let currentPlan: RecreationPlanArtifact | null = null;
  try {
    currentPlan = await verifyRecreationPlan(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return [`recreation-plan.json: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
  if (!currentPlan) return errors;
  if (!new Set(["approved", "applied"]).has(currentPlan.status) || currentPlan.approvedContentHash !== currentPlan.contentHash) {
    errors.push(`current recreation plan is ${currentPlan.status}; archive requires an approved/applied current plan`);
    return errors;
  }
  const generatedSlotIds = currentPlan.editBlueprint.flatMap((blueprint) =>
    (blueprint.brollSlots ?? [])
      .filter((slot) => slot.sourceStrategy === "generated_after_approval")
      .map((slot) => slot.id),
  );
  const currentHandoffs = handoffs.filter((handoff) => handoff.content.plan.contentHash === currentPlan!.contentHash);
  if (generatedSlotIds.length > 0 && currentPlan.status !== "applied") {
    errors.push("current recreation plan contains generated B-roll slots but is not applied to the Edit Plan");
    return errors;
  }
  const supersededRejected = new Set(
    currentHandoffs
      .filter((handoff) => handoff.status !== "superseded")
      .map((handoff) => handoff.content.revision.previousHandoffId)
      .filter((value): value is string => Boolean(value)),
  );
  for (const handoff of currentHandoffs) {
    if (handoff.status === "superseded") continue;
    if (handoff.status === "needs_revision" && supersededRejected.has(handoff.handoffId)) continue;
    if (handoff.status !== "accepted") {
      errors.push(`${handoff.handoffId} is ${handoff.status}; prepared B-roll handoffs must be accepted or removed through a revised project plan before archive`);
    }
  }
  for (const slotId of generatedSlotIds) {
    if (!currentHandoffs.some((handoff) => handoff.content.slot.id === slotId && handoff.status === "accepted")) {
      errors.push(`${slotId} has no accepted B-roll result bound to the current recreation plan`);
    }
  }
  return errors;
}

export interface BrollArchiveEntry {
  group: "generated_broll";
  path: string;
  label: string;
  sha256: string;
}

/**
 * Return every current, accepted B-roll byte that must remain discoverable in
 * the final archive.  Archive validation calls brollArchiveErrors first, so
 * this function only projects already-validated evidence into the manifest.
 */
export async function acceptedBrollArchiveEntries(projectDir: string): Promise<BrollArchiveEntry[]> {
  let currentPlan: RecreationPlanArtifact;
  try {
    currentPlan = await verifyRecreationPlan(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (currentPlan.status !== "applied") return [];
  const entries = new Map<string, BrollArchiveEntry>();
  const add = async (filePath: string, label: string, expectedSha256?: string): Promise<void> => {
    const resolved = stablePath(filePath);
    const currentSha256 = await sha256File(resolved);
    if (expectedSha256 && currentSha256 !== expectedSha256) {
      throw new Error(`B-roll archive evidence changed after acceptance: ${resolved}`);
    }
    const key = resolved.toLowerCase();
    const existing = entries.get(key);
    if (existing && existing.sha256 !== currentSha256) throw new Error(`B-roll archive path has conflicting hashes: ${resolved}`);
    if (!existing) entries.set(key, { group: "generated_broll", path: resolved, label, sha256: currentSha256 });
  };

  for (const handoffPath of await discoverBrollHandoffPaths(projectDir)) {
    const handoff = await readHandoff(handoffPath);
    if (handoff.content.plan.contentHash !== currentPlan.contentHash || handoff.status !== "accepted" || !handoff.resultPath) continue;
    const result = await readOptionalResult(handoff.resultPath);
    if (!result || result.status !== "accepted") throw new Error(`Accepted B-roll result is missing for ${handoff.handoffId}`);
    await add(handoffPath, `${handoff.handoffId} approved handoff`);
    await add(handoff.resultPath, `${handoff.handoffId} accepted result`);
    await add(result.content.manifestPath, `${handoff.handoffId} provider result manifest`, result.content.manifestSha256);
    await add(result.content.video.path, `${handoff.handoffId} accepted video`, result.content.video.sha256);
    for (const frame of result.content.keyframes) {
      await add(frame.path, `${handoff.handoffId} ${frame.role} review frame`, frame.sha256);
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}
