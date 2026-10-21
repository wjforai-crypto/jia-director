import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "./contracts.js";
import { sha256Canonical } from "./canonical-json.js";
import { readJson, writeJsonAtomic } from "./json-store.js";
import { sha256File } from "./media.js";
import { isSensitiveProject, privacyContractIssues } from "./privacy-policy.js";
import { withProjectStateLock } from "./project-state-lock.js";

export const PRIMARY_GENERATION_FILE = "primary-generation.json";
export const PRIMARY_GENERATION_LEDGER_FILE = "primary-generation-ledger.json";
export const PRIMARY_GENERATION_ENDPOINT = "https://api.minimax.cn/v2/video_generation";
export const PRIMARY_GENERATION_PRICING_SOURCE = "https://platform.minimax.cn/docs/pricing/overview";

export interface PrimaryGenerationPayload {
  model: "MiniMax-H3-Max";
  content: [{ type: "text"; text: string }];
  resolution: "480P";
  duration: number;
  ratio: "16:9";
  extra: { prompt_expansion_mode: "disabled" };
  aigc_watermark: false;
}

export interface PrimaryGenerationAuthorization {
  authorizedBy: "user";
  evidence: string[];
  scope: "paid_generation_within_budget";
}

export interface PrimaryGenerationJob {
  id: string;
  shotIds: string[];
  endpoint: typeof PRIMARY_GENERATION_ENDPOINT;
  payload: PrimaryGenerationPayload;
  payloadHash: string;
  maxCostCents: number;
}

export interface PrimaryGenerationContract {
  schemaVersion: 1;
  kind: "primary-generation-contract";
  createdAt: string;
  contractHash: string;
  project: {
    projectId: string;
    projectBindingHash: string;
    editPlanPath: "edit-plan.json";
    editPlanSha256: string;
    privacyHash: string;
  };
  budgetCapCents: number;
  budgetCapCny: number;
  authorization: PrimaryGenerationAuthorization;
  pricing: {
    sourceUrl: typeof PRIMARY_GENERATION_PRICING_SOURCE;
    checkedAt: string;
    unitPriceCny: 0.33;
    unitPriceCents: 33;
  };
  jobs: PrimaryGenerationJob[];
}

export interface PrimaryGenerationReceipt {
  videoPath: string;
  sha256: string;
  sizeBytes: number;
  importedAt: string;
  probe: {
    durationSeconds: number;
    formatName: string;
    video: { codec: string; width: number; height: number; fps: number | null };
    audio: boolean;
  };
}

export interface PrimaryGenerationClaim {
  jobId: string;
  state: "submitting" | "submitted" | "unknown" | "imported";
  claimHash: string;
  contractHash: string;
  executor: string;
  claimedAt: string;
  nonce: string;
  reservedCents: number;
  taskId?: string;
  submittedAt?: string;
  failure?: { reason: string; recordedAt: string };
  receipt?: PrimaryGenerationReceipt;
}

export interface PrimaryGenerationLedger {
  schemaVersion: 1;
  kind: "primary-generation-ledger";
  contractHash: string;
  createdAt: string;
  updatedAt: string;
  budgetCapCents: number;
  reservedCents: number;
  claims: PrimaryGenerationClaim[];
  ledgerHash: string;
}

export interface PrimaryGenerationClaimInput {
  projectDir: string;
  jobId: string;
  contractHash: string;
  executor: string;
}

export interface PrimaryGenerationClaimResult {
  claimHash: string;
  contractHash: string;
  jobId: string;
  endpoint: typeof PRIMARY_GENERATION_ENDPOINT;
  payload: PrimaryGenerationPayload;
  reservedCents: number;
  reservedCny: number;
}

type JsonObject = Record<string, unknown>;
type PreparedInput = Pick<PrimaryGenerationContract, "budgetCapCny" | "authorization"> & {
  pricing: Pick<PrimaryGenerationContract["pricing"], "sourceUrl" | "checkedAt" | "unitPriceCny">;
  jobs: Array<Pick<PrimaryGenerationJob, "id" | "shotIds" | "endpoint" | "payload">>;
};

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function keys(value: unknown, required: string[], optional: string[], label: string): JsonObject {
  const record = object(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unknown key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}`);
  }
  return record;
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}

function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

function iso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function cents(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive CNY`);
  // Parse decimal digits rather than accumulating binary floating-point costs.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`${label} must have at most two decimal places`);
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside the safe integer range`);
  return result;
}

function assertPayload(value: unknown): asserts value is PrimaryGenerationPayload {
  const payload = keys(value, ["model", "content", "resolution", "duration", "ratio", "extra", "aigc_watermark"], [], "payload");
  if (payload.model !== "MiniMax-H3-Max" || payload.resolution !== "480P" || payload.ratio !== "16:9"
      || payload.aigc_watermark !== false) throw new Error("Primary generation requires MiniMax-H3-Max, 480P, 16:9 and aigc_watermark=false");
  if (!Number.isInteger(payload.duration) || Number(payload.duration) < 5 || Number(payload.duration) > 15) {
    throw new Error("MiniMax-H3-Max duration must be an integer between 5 and 15 seconds");
  }
  if (!Array.isArray(payload.content) || payload.content.length !== 1) throw new Error("Primary generation requires exactly one text content item");
  const content = keys(payload.content[0], ["type", "text"], [], "payload.content[0]");
  if (content.type !== "text") throw new Error("Primary generation permits text-only content; media and audio are not authorized");
  text(content.text, "payload.content[0].text");
  const extra = keys(payload.extra, ["prompt_expansion_mode"], [], "payload.extra");
  if (extra.prompt_expansion_mode !== "disabled") throw new Error("Prompt expansion must be explicitly disabled");
}

function assertAuthorization(value: unknown): asserts value is PrimaryGenerationAuthorization {
  const authorization = keys(value, ["authorizedBy", "evidence", "scope"], [], "authorization");
  if (authorization.authorizedBy !== "user" || authorization.scope !== "paid_generation_within_budget") {
    throw new Error("Primary generation requires the user's paid_generation_within_budget authorization");
  }
  if (!Array.isArray(authorization.evidence) || authorization.evidence.length === 0) throw new Error("User authorization evidence must not be empty");
  for (const evidence of authorization.evidence) text(evidence, "User authorization evidence");
}

function assertPricing(value: unknown, frozen: boolean): void {
  const pricing = keys(value, ["sourceUrl", "checkedAt", "unitPriceCny", ...(frozen ? ["unitPriceCents"] : [])], [], "pricing");
  if (pricing.sourceUrl !== PRIMARY_GENERATION_PRICING_SOURCE || pricing.unitPriceCny !== 0.33
      || (frozen && pricing.unitPriceCents !== 33)) {
    throw new Error("Primary generation pricing must use the official source and fixed 0.33 CNY per second (33 cents)");
  }
  iso(pricing.checkedAt, "pricing.checkedAt");
}

function assertJobs(value: unknown, frozen: boolean): asserts value is PrimaryGenerationJob[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Primary generation requires at least one job");
  const ids = new Set<string>();
  for (const item of value) {
    const job = keys(item, ["id", "shotIds", "endpoint", "payload", ...(frozen ? ["payloadHash", "maxCostCents"] : [])], [], "job");
    text(job.id, "job.id");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(job.id)) throw new Error("job.id must be a safe ASCII identifier");
    if (ids.has(job.id)) throw new Error(`Duplicate primary generation job: ${job.id}`);
    ids.add(job.id);
    if (job.endpoint !== PRIMARY_GENERATION_ENDPOINT) throw new Error("Only the official MiniMax v2 video_generation endpoint is authorized");
    if (!Array.isArray(job.shotIds) || job.shotIds.length === 0) throw new Error("Each primary job must bind at least one edit-plan shot id");
    const shotIds = new Set<string>();
    for (const shotId of job.shotIds) {
      text(shotId, "job.shotIds entry");
      if (shotIds.has(shotId)) throw new Error(`Duplicate shot id within job ${job.id}: ${shotId}`);
      shotIds.add(shotId);
    }
    assertPayload(job.payload);
    if (frozen && (job.payloadHash !== sha256Canonical({ endpoint: job.endpoint, payload: job.payload })
        || job.maxCostCents !== job.payload.duration * 33)) throw new Error(`Frozen primary payload or cost changed: ${job.id}`);
  }
}

function contractBody(contract: PrimaryGenerationContract) {
  const { contractHash: _hash, ...body } = contract;
  return body;
}

function comparisonBody(contract: PrimaryGenerationContract) {
  const { createdAt: _time, ...body } = contractBody(contract);
  return body;
}

function assertContract(value: unknown): asserts value is PrimaryGenerationContract {
  const record = keys(value, ["schemaVersion", "kind", "createdAt", "contractHash", "project", "budgetCapCents", "budgetCapCny", "authorization", "pricing", "jobs"], [], "primary contract");
  if (record.schemaVersion !== 1 || record.kind !== "primary-generation-contract") throw new Error("Unsupported primary generation contract");
  iso(record.createdAt, "contract.createdAt");
  hash(record.contractHash, "contract.contractHash");
  const project = keys(record.project, ["projectId", "projectBindingHash", "editPlanPath", "editPlanSha256", "privacyHash"], [], "contract.project");
  text(project.projectId, "contract.project.projectId");
  for (const name of ["projectBindingHash", "editPlanSha256", "privacyHash"]) hash(project[name], `contract.project.${name}`);
  if (project.editPlanPath !== "edit-plan.json") throw new Error("Primary generation must freeze the project's edit-plan.json");
  const budgetCapCents = cents(record.budgetCapCny, "budgetCapCny");
  if (budgetCapCents > 1000 || record.budgetCapCents !== budgetCapCents) throw new Error("Primary generation budget cannot exceed 10 CNY (1000 cents)");
  assertAuthorization(record.authorization);
  assertPricing(record.pricing, true);
  assertJobs(record.jobs, true);
  if (record.jobs.reduce((sum, job) => sum + job.maxCostCents, 0) > budgetCapCents) throw new Error("Primary generation jobs exceed the authorized budget");
  const contract = record as unknown as PrimaryGenerationContract;
  if (sha256Canonical(contractBody(contract)) !== contract.contractHash) throw new Error("Primary generation contract hash mismatch; frozen content changed");
}

function projectBinding(project: VideoProject): unknown {
  // Asset registration updates updatedAt, and visual routing may advance the
  // planning status. Neither grants permission to change the frozen content.
  const { updatedAt: _time, workflowStatus: _state, ...binding } = project;
  return binding;
}

function assertProject(project: VideoProject): void {
  text(project.projectId, "project.projectId");
  if (project.workflowStatus !== "plan_ready" && project.workflowStatus !== "visual_direction_ready") {
    throw new Error(`Primary generation requires plan_ready or visual_direction_ready, got ${project.workflowStatus}`);
  }
  const issues = privacyContractIssues(project);
  if (issues.length > 0) throw new Error(`Privacy contract is inconsistent: ${issues.join(", ")}`);
  if (isSensitiveProject(project)) throw new Error("Sensitive projects cannot submit primary generation to the cloud");
  if (!new Set(["public", "internal"]).has(project.privacy.classification)
      || project.privacy.containsSensitiveData !== false || project.privacy.cloudAllowed !== true
      || project.privacy.externalProcessingAuthorization?.status === "denied") {
    throw new Error("Project privacy policy does not allow non-sensitive cloud generation");
  }
}

async function currentProjectBinding(projectDir: string, jobs: PrimaryGenerationJob[]) {
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  assertProject(project);
  const editPlanPath = path.join(projectDir, "edit-plan.json");
  const editPlan = await readJson<{ shots?: Array<{ id?: string }>; reviewStatus?: string }>(editPlanPath);
  if (!Array.isArray(editPlan.shots) || editPlan.shots.length === 0 || editPlan.reviewStatus !== "ready") {
    throw new Error("Primary generation requires a real ready edit-plan with shot ids");
  }
  const shotIds = new Set<string>();
  for (const shot of editPlan.shots) {
    text(shot.id, "edit-plan shot id");
    if (shotIds.has(shot.id)) throw new Error(`Duplicate edit-plan shot id: ${shot.id}`);
    shotIds.add(shot.id);
  }
  for (const job of jobs) for (const shotId of job.shotIds) {
    if (!shotIds.has(shotId)) throw new Error(`Primary generation job ${job.id} refers to a missing edit-plan shot: ${shotId}`);
  }
  return {
    projectId: project.projectId,
    projectBindingHash: sha256Canonical(projectBinding(project)),
    editPlanPath: "edit-plan.json" as const,
    editPlanSha256: await sha256File(editPlanPath),
    privacyHash: sha256Canonical(project.privacy),
  };
}

function ledgerBody(ledger: PrimaryGenerationLedger) {
  const { ledgerHash: _hash, ...body } = ledger;
  return body;
}

function claimBody(claim: PrimaryGenerationClaim) {
  return {
    jobId: claim.jobId, contractHash: claim.contractHash, executor: claim.executor,
    claimedAt: claim.claimedAt, nonce: claim.nonce, reservedCents: claim.reservedCents,
  };
}

function assertReceipt(value: unknown, duration: number): asserts value is PrimaryGenerationReceipt {
  const receipt = keys(value, ["videoPath", "sha256", "sizeBytes", "importedAt", "probe"], [], "receipt");
  text(receipt.videoPath, "receipt.videoPath");
  if (!path.isAbsolute(receipt.videoPath)) throw new Error("Receipt videoPath must be absolute");
  hash(receipt.sha256, "receipt.sha256");
  iso(receipt.importedAt, "receipt.importedAt");
  if (!Number.isSafeInteger(receipt.sizeBytes) || Number(receipt.sizeBytes) <= 0) throw new Error("Receipt size must be positive");
  const probe = keys(receipt.probe, ["durationSeconds", "formatName", "video", "audio"], [], "receipt.probe");
  text(probe.formatName, "receipt.probe.formatName");
  if (typeof probe.audio !== "boolean") throw new Error("Receipt audio evidence must be boolean");
  if (typeof probe.durationSeconds !== "number" || !Number.isFinite(probe.durationSeconds)
      || Math.abs(probe.durationSeconds - duration) > 0.6) throw new Error("Primary video duration differs from the frozen request by more than 0.6 seconds");
  const video = keys(probe.video, ["codec", "width", "height", "fps"], [], "receipt.probe.video");
  text(video.codec, "receipt video codec");
  if (!Number.isInteger(video.width) || Number(video.width) < 800 || video.height !== 480
      || Math.abs(Number(video.width) / 480 - 16 / 9) > 0.05) throw new Error("Primary video must be 480P 16:9, height 480 and width at least 800");
  if (video.fps !== null && (typeof video.fps !== "number" || !Number.isFinite(video.fps) || video.fps <= 0)) throw new Error("Receipt fps is invalid");
}

function assertLedger(value: unknown, contract: PrimaryGenerationContract): asserts value is PrimaryGenerationLedger {
  const record = keys(value, ["schemaVersion", "kind", "contractHash", "createdAt", "updatedAt", "budgetCapCents", "reservedCents", "claims", "ledgerHash"], [], "primary ledger");
  if (record.schemaVersion !== 1 || record.kind !== "primary-generation-ledger" || record.contractHash !== contract.contractHash
      || record.budgetCapCents !== contract.budgetCapCents) throw new Error("Primary generation ledger is not bound to the frozen contract");
  iso(record.createdAt, "ledger.createdAt");
  iso(record.updatedAt, "ledger.updatedAt");
  hash(record.ledgerHash, "ledger.ledgerHash");
  if (!Array.isArray(record.claims)) throw new Error("Primary generation ledger claims must be an array");
  const seen = new Set<string>();
  let reservedCents = 0;
  for (const item of record.claims) {
    const claim = keys(item, ["jobId", "state", "claimHash", "contractHash", "executor", "claimedAt", "nonce", "reservedCents"], ["taskId", "submittedAt", "failure", "receipt"], "primary claim");
    text(claim.jobId, "claim.jobId");
    const job = contract.jobs.find((job) => job.id === claim.jobId);
    if (!job || seen.has(claim.jobId)) throw new Error("Primary ledger contains an unknown or duplicate job");
    seen.add(claim.jobId);
    if (claim.contractHash !== contract.contractHash || claim.reservedCents !== job.maxCostCents) throw new Error("Primary claim reservation or contract binding changed");
    text(claim.executor, "claim.executor");
    text(claim.nonce, "claim.nonce");
    iso(claim.claimedAt, "claim.claimedAt");
    hash(claim.claimHash, "claim.claimHash");
    if (claim.claimHash !== sha256Canonical(claimBody(claim as unknown as PrimaryGenerationClaim))) throw new Error("Primary generation claim hash mismatch");
    if (!new Set(["submitting", "submitted", "unknown", "imported"]).has(String(claim.state))) throw new Error("Invalid primary generation claim state");
    if (claim.taskId !== undefined) text(claim.taskId, "claim.taskId");
    if (claim.submittedAt !== undefined) iso(claim.submittedAt, "claim.submittedAt");
    if (claim.state === "submitting" && (claim.taskId !== undefined || claim.receipt !== undefined || claim.failure !== undefined)) throw new Error("Submitting claim cannot contain a task, receipt or failure");
    if ((claim.state === "submitted" || claim.state === "imported") && (claim.taskId === undefined || claim.submittedAt === undefined)) throw new Error("Submitted claim is missing its task id");
    if (claim.state === "unknown") {
      const failure = keys(claim.failure, ["reason", "recordedAt"], [], "claim.failure");
      text(failure.reason, "claim.failure.reason");
      iso(failure.recordedAt, "claim.failure.recordedAt");
    } else if (claim.failure !== undefined) throw new Error("Only unknown claims can contain failure evidence");
    if (claim.state === "imported") assertReceipt(claim.receipt, job.payload.duration);
    else if (claim.receipt !== undefined) throw new Error("Only imported claims can contain a receipt");
    reservedCents += job.maxCostCents;
  }
  if (!Number.isSafeInteger(record.reservedCents) || record.reservedCents !== reservedCents || reservedCents > contract.budgetCapCents) {
    throw new Error("Primary ledger budget reservation mismatch or overrun");
  }
  if (sha256Canonical(ledgerBody(record as unknown as PrimaryGenerationLedger)) !== record.ledgerHash) throw new Error("Primary generation ledger hash mismatch");
}

async function optionalJson(filePath: string): Promise<unknown | undefined> {
  try { return await readJson<unknown>(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function loadCurrent(projectDir: string, verifyBinding = true) {
  const contract = await readJson<unknown>(path.join(projectDir, PRIMARY_GENERATION_FILE));
  assertContract(contract);
  const ledger = await readJson<unknown>(path.join(projectDir, PRIMARY_GENERATION_LEDGER_FILE));
  assertLedger(ledger, contract);
  if (verifyBinding) {
    const current = await currentProjectBinding(projectDir, contract.jobs);
    if (current.privacyHash !== contract.project.privacyHash) throw new Error("Primary generation privacy changed after contract preparation");
    if (current.editPlanSha256 !== contract.project.editPlanSha256) throw new Error("Primary generation edit-plan changed after contract preparation");
    if (current.projectId !== contract.project.projectId || current.projectBindingHash !== contract.project.projectBindingHash) {
      throw new Error("Primary generation project content changed after contract preparation");
    }
  }
  return { contract, ledger };
}

async function saveLedger(projectDir: string, ledger: PrimaryGenerationLedger, contract: PrimaryGenerationContract) {
  ledger.updatedAt = new Date().toISOString();
  ledger.ledgerHash = sha256Canonical(ledgerBody(ledger));
  assertLedger(ledger, contract);
  await writeJsonAtomic(path.join(projectDir, PRIMARY_GENERATION_LEDGER_FILE), ledger);
}

/** This freezes execution-range authorization; it does not assert user review of a particular contract hash. */
export async function preparePrimaryGeneration(input: { projectDir: string; inputPath: string }): Promise<PrimaryGenerationContract> {
  return withProjectStateLock(input.projectDir, "prepare-primary-generation", async () => {
    const raw = await readJson<unknown>(input.inputPath);
    const record = keys(raw, ["budgetCapCny", "authorization", "pricing", "jobs"], [], "primary generation input");
    const budgetCapCents = cents(record.budgetCapCny, "budgetCapCny");
    if (budgetCapCents > 1000) throw new Error("Primary generation budget cannot exceed 10 CNY (1000 cents)");
    assertAuthorization(record.authorization);
    assertPricing(record.pricing, false);
    assertJobs(record.jobs, false);
    const prepared = record as unknown as PreparedInput;
    const jobs: PrimaryGenerationJob[] = prepared.jobs.map((job) => ({ ...job,
      payloadHash: sha256Canonical({ endpoint: job.endpoint, payload: job.payload }),
      maxCostCents: job.payload.duration * 33,
    }));
    if (jobs.reduce((sum, job) => sum + job.maxCostCents, 0) > budgetCapCents) throw new Error("Primary generation jobs exceed the authorized budget");
    const contract: PrimaryGenerationContract = {
      schemaVersion: 1, kind: "primary-generation-contract", createdAt: new Date().toISOString(), contractHash: "",
      project: await currentProjectBinding(input.projectDir, jobs), budgetCapCents, budgetCapCny: prepared.budgetCapCny,
      authorization: prepared.authorization, pricing: { ...prepared.pricing, unitPriceCents: 33 }, jobs,
    };
    contract.contractHash = sha256Canonical(contractBody(contract));
    assertContract(contract);
    const contractPath = path.join(input.projectDir, PRIMARY_GENERATION_FILE);
    const existing = await optionalJson(contractPath);
    if (existing !== undefined) {
      assertContract(existing);
      if (sha256Canonical(comparisonBody(existing)) !== sha256Canonical(comparisonBody(contract))) {
        throw new Error("Primary generation contract already exists; refusing to overwrite different frozen content");
      }
      await loadCurrent(input.projectDir);
      return existing;
    }
    if (await optionalJson(path.join(input.projectDir, PRIMARY_GENERATION_LEDGER_FILE)) !== undefined) {
      throw new Error("An orphan primary generation ledger exists; operator reconciliation is required");
    }
    const ledger: PrimaryGenerationLedger = {
      schemaVersion: 1, kind: "primary-generation-ledger", contractHash: contract.contractHash,
      createdAt: contract.createdAt, updatedAt: contract.createdAt, budgetCapCents, reservedCents: 0, claims: [], ledgerHash: "",
    };
    ledger.ledgerHash = sha256Canonical(ledgerBody(ledger));
    // A crash between writes leaves execution blocked, never an inferred empty budget ledger.
    await writeJsonAtomic(contractPath, contract);
    await writeJsonAtomic(path.join(input.projectDir, PRIMARY_GENERATION_LEDGER_FILE), ledger);
    return contract;
  });
}

async function claimLocked(input: PrimaryGenerationClaimInput): Promise<PrimaryGenerationClaimResult> {
  text(input.executor, "executor");
  hash(input.contractHash, "contractHash");
  const { contract, ledger } = await loadCurrent(input.projectDir);
  if (input.contractHash !== contract.contractHash) throw new Error("Requested primary contract hash does not match the frozen contract");
  const job = contract.jobs.find((job) => job.id === input.jobId);
  if (!job) throw new Error(`Unknown primary generation job: ${input.jobId}`);
  const existing = ledger.claims.find((claim) => claim.jobId === input.jobId);
  if (existing) throw new Error(`Primary generation job ${input.jobId} was already claimed (${existing.state}); duplicate submissions and automatic retries are forbidden`);
  if (ledger.reservedCents + job.maxCostCents > contract.budgetCapCents) throw new Error("Primary generation budget reservation would exceed the authorized cap");
  const claim: PrimaryGenerationClaim = {
    jobId: input.jobId, state: "submitting", claimHash: "", contractHash: contract.contractHash,
    executor: input.executor, claimedAt: new Date().toISOString(), nonce: randomUUID(), reservedCents: job.maxCostCents,
  };
  claim.claimHash = sha256Canonical(claimBody(claim));
  ledger.claims.push(claim);
  ledger.reservedCents += claim.reservedCents;
  await saveLedger(input.projectDir, ledger, contract);
  return {
    claimHash: claim.claimHash, contractHash: contract.contractHash, jobId: job.id,
    endpoint: job.endpoint, payload: structuredClone(job.payload), reservedCents: job.maxCostCents, reservedCny: job.maxCostCents / 100,
  };
}

export async function claimPrimaryGeneration(input: PrimaryGenerationClaimInput): Promise<PrimaryGenerationClaimResult> {
  return withProjectStateLock(input.projectDir, "claim-primary-generation", () => claimLocked(input));
}

function claimedJob(ledger: PrimaryGenerationLedger, jobId: string, claimHash: string): PrimaryGenerationClaim {
  hash(claimHash, "claimHash");
  const claim = ledger.claims.find((claim) => claim.jobId === jobId);
  if (!claim || claim.claimHash !== claimHash) throw new Error("Primary generation job/claim hash mismatch");
  return claim;
}

async function recordTaskLocked(input: { projectDir: string; jobId: string; claimHash: string; taskId: string }): Promise<PrimaryGenerationClaim> {
  text(input.taskId, "taskId");
  const { contract, ledger } = await loadCurrent(input.projectDir);
  const claim = claimedJob(ledger, input.jobId, input.claimHash);
  if (claim.taskId !== undefined && claim.taskId !== input.taskId) throw new Error("Primary generation task id conflicts with the recorded task");
  if (claim.state === "unknown") throw new Error("Unknown primary generation submission requires operator reconciliation; automatic recovery is forbidden");
  if (claim.state === "submitted" || claim.state === "imported") return claim;
  if (claim.state !== "submitting") throw new Error("Primary generation task can only be recorded after a fresh claim");
  if (ledger.claims.some((other) => other.jobId !== claim.jobId && other.taskId === input.taskId)) throw new Error("Primary generation task id is already bound to another job");
  claim.taskId = input.taskId;
  claim.submittedAt = new Date().toISOString();
  claim.state = "submitted";
  await saveLedger(input.projectDir, ledger, contract);
  return claim;
}

export async function recordPrimaryTask(input: { projectDir: string; jobId: string; claimHash: string; taskId: string }): Promise<PrimaryGenerationClaim> {
  return withProjectStateLock(input.projectDir, "record-primary-task", () => recordTaskLocked(input));
}

async function recordFailureLocked(input: { projectDir: string; jobId: string; claimHash: string; reason: string }, verifyBinding = true): Promise<PrimaryGenerationClaim> {
  text(input.reason, "reason");
  const { contract, ledger } = await loadCurrent(input.projectDir, verifyBinding);
  const claim = claimedJob(ledger, input.jobId, input.claimHash);
  if (claim.state === "imported") throw new Error("An imported primary result cannot be changed into a failed submission");
  if (claim.state === "unknown") {
    if (claim.failure?.reason !== input.reason) throw new Error("Primary generation failure evidence already exists; refusing to overwrite it");
    return claim;
  }
  claim.state = "unknown";
  claim.failure = { reason: input.reason, recordedAt: new Date().toISOString() };
  // No expiry, release, retry or refund: a failed HTTP exchange is not evidence of non-billing.
  await saveLedger(input.projectDir, ledger, contract);
  return claim;
}

export async function recordPrimaryFailure(input: { projectDir: string; jobId: string; claimHash: string; reason: string }): Promise<PrimaryGenerationClaim> {
  return withProjectStateLock(input.projectDir, "record-primary-failure", () => recordFailureLocked(input));
}

/** The callback may perform exactly one POST. This module itself never performs network IO. */
export async function submitPrimaryGeneration(
  input: PrimaryGenerationClaimInput,
  submit: (claim: PrimaryGenerationClaimResult) => Promise<string>,
): Promise<PrimaryGenerationClaimResult & { taskId: string }> {
  return withProjectStateLock(input.projectDir, "submit-primary-generation", async () => {
    const claim = await claimLocked(input);
    Object.freeze(claim.payload.content[0]);
    Object.freeze(claim.payload.content);
    Object.freeze(claim.payload.extra);
    Object.freeze(claim.payload);
    Object.freeze(claim);
    try {
      const taskId = await submit(claim);
      await recordTaskLocked({ projectDir: input.projectDir, jobId: input.jobId, claimHash: claim.claimHash, taskId });
      return { ...claim, taskId };
    } catch (error) {
      // Even drift discovered after a successful POST must retain uncertainty and reservation.
      try {
        await recordFailureLocked({ projectDir: input.projectDir, jobId: input.jobId, claimHash: claim.claimHash,
          reason: error instanceof Error ? error.message || error.name : String(error) || "Submission failed" }, false);
      } catch (recordError) {
        throw new AggregateError([error, recordError], "Primary submission outcome is uncertain and its reservation remains held; failure evidence could not be recorded");
      }
      throw error;
    }
  });
}

function probeVideo(videoPath: string): PrimaryGenerationReceipt["probe"] {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries",
    "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate", "-of", "json", videoPath],
  { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`ffprobe failed: ${result.error?.message ?? result.stderr.trim() ?? "unknown error"}`);
  const media = JSON.parse(result.stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }>;
  };
  const video = media.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Primary generation import requires an actual video stream");
  const [numerator = "0", denominator = "1"] = (video.avg_frame_rate ?? video.r_frame_rate ?? "0").split("/");
  const frameRate = Number(numerator) / Number(denominator);
  return {
    durationSeconds: Number(media.format?.duration ?? 0), formatName: media.format?.format_name ?? "",
    video: { codec: video.codec_name ?? "", width: video.width ?? 0, height: video.height ?? 0,
      fps: Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null },
    audio: media.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}

export async function importPrimaryGeneration(input: { projectDir: string; jobId: string; claimHash: string; taskId: string; videoPath: string }): Promise<PrimaryGenerationReceipt> {
  return withProjectStateLock(input.projectDir, "import-primary-generation", async () => {
    const { contract, ledger } = await loadCurrent(input.projectDir);
    const claim = claimedJob(ledger, input.jobId, input.claimHash);
    if (claim.taskId !== input.taskId) throw new Error("Primary generation import task id does not match the submitted task");
    if (claim.state !== "submitted" && claim.state !== "imported") throw new Error("Primary generation result import requires a submitted task");
    const videoPath = path.resolve(input.videoPath);
    const info = await stat(videoPath);
    if (!info.isFile() || info.size <= 0) throw new Error("Primary generation result must be a non-empty video file");
    const sha256 = await sha256File(videoPath);
    if (claim.state === "imported") {
      if (!claim.receipt || claim.receipt.videoPath !== videoPath || claim.receipt.sha256 !== sha256 || claim.receipt.sizeBytes !== info.size) {
        throw new Error("Primary generation imported result changed; refusing to overwrite the existing receipt");
      }
      return claim.receipt;
    }
    const receipt: PrimaryGenerationReceipt = {
      videoPath, sha256, sizeBytes: info.size, importedAt: new Date().toISOString(), probe: probeVideo(videoPath),
    };
    const job = contract.jobs.find((job) => job.id === input.jobId)!;
    assertReceipt(receipt, job.payload.duration);
    if (await sha256File(videoPath) !== sha256) throw new Error("Primary video changed while its hash and media probe were being captured");
    claim.receipt = receipt;
    claim.state = "imported";
    await saveLedger(input.projectDir, ledger, contract);
    return receipt;
  });
}

/** Read-only validation, also safe to call from an executor already holding the project-state lock. */
export async function getPrimaryGeneration(input: { projectDir: string }): Promise<{ contract: PrimaryGenerationContract; ledger: PrimaryGenerationLedger }> {
  return loadCurrent(input.projectDir);
}
