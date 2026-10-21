import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { readJson, writeJson, writeJsonAtomic } from "./json-store.js";
import { sha256Canonical } from "./canonical-json.js";
import { assertCurrentSensitiveEvidence, isSensitiveProject, type RedactionEvidence } from "./privacy-policy.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface VisualRoutingRecord {
  schemaVersion: string;
  decision: string;
  selectedShotIds: string[];
  callsUsed: number;
  maxCalls: number;
  privacyBlocked: boolean;
  privacyHash?: string;
  editPlanHash: string;
}

interface KimiDirectionRecord extends Record<string, unknown> {
  status: string;
  taskId?: string;
  inputHash?: string | null;
  outputPath?: string;
  packetPath?: string;
  packetSha256?: string;
  workingDirectory?: string;
  sessionId?: string | null;
  expectedSessionId?: string | null;
  callNumber?: number;
  suggestions?: Array<{ shotId: string; [key: string]: unknown }>;
  decisions?: Array<Record<string, unknown>>;
  priorReviews?: Array<Record<string, unknown>>;
  handoffManifest?: {
    editPlan: { path: string; sha256: string };
    frames: Array<{ path: string; sha256: string }>;
    privacyHash: string | null;
  };
}

export interface PrepareKimiInput {
  projectDir: string;
  outputPath: string;
  frames?: string[];
  resumeSessionId?: string;
}

interface PreparedKimi {
  taskId: string;
  packetPath: string;
  inputHash: string;
  outputPath: string;
  workingDirectory: string;
}

interface EditPlanShot {
  id: string;
  semanticIntent?: string;
  visualRole?: string;
  voiceover?: string;
  protectedRegions?: string[];
  [key: string]: unknown;
}

interface EditPlan {
  shots: EditPlanShot[];
}

interface KimiReview {
  sessionId: string;
  inputHash: string;
  suggestions: Array<{ shotId: string; [key: string]: unknown }>;
  constraintConfirmation: {
    scriptUnchanged: boolean;
    factsUnchanged: boolean;
    timelineUnchanged: boolean;
    brandConstraintsPreserved: boolean;
  };
}

type KimiDecision = "accept" | "adjust" | "reject";
type KimiFailureReason = "timeout" | "rate_limited" | "invalid_output" | "unavailable";

interface KimiDecisionInput {
  reviewer: string;
  decisions: Array<{ shotId: string; decision: KimiDecision; rationale: string }>;
}

interface CodexFallbackInput {
  reviewer: string;
  rationale: string;
  shotDirections: Array<{
    shotId: string;
    composition: string;
    hierarchy: string;
    palette: string;
    motion: { entry: string; development: string; conclusion: string };
    timingAnchors: string[];
    acceptanceFrames: string[];
  }>;
  constraintConfirmation: KimiReview["constraintConfirmation"];
}

function hashPayload(payload: unknown): string {
  return sha256Canonical(payload);
}

function taskId(projectId: string, inputHash: string): string {
  return `KIMI-VISUAL-${projectId.slice(3, 11).toUpperCase()}-${inputHash.slice(0, 8).toUpperCase()}`;
}

async function fileHash(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function assertPrivacyEvidenceCurrent(
  projectDir: string,
  project: VideoProject,
  routing: VisualRoutingRecord,
): Promise<RedactionEvidence | null> {
  const currentPrivacyHash = sha256Canonical(project.privacy);
  if (routing.privacyHash && routing.privacyHash !== currentPrivacyHash) {
    throw new Error("Visual routing is stale: privacy evidence changed after route-visual");
  }
  if (!isSensitiveProject(project)) return null;
  if (!routing.privacyHash) throw new Error("Sensitive Kimi routing is missing privacy evidence hash");
  if (routing.privacyBlocked) throw new Error("Sensitive Kimi routing is blocked by privacy policy");
  return assertCurrentSensitiveEvidence(projectDir, project);
}

async function assertKimiHandoffCurrent(
  projectDir: string,
  direction: KimiDirectionRecord,
  routing?: VisualRoutingRecord,
  project?: VideoProject,
): Promise<void> {
  if (!direction.packetPath || !direction.packetSha256) {
    throw new Error("Prepared Kimi direction is missing its hash-bound task packet");
  }
  if ((await fileHash(direction.packetPath)) !== direction.packetSha256) {
    throw new Error("Kimi task packet changed after preparation");
  }
  if (!direction.handoffManifest) throw new Error("Prepared Kimi direction is missing its hash-bound handoff manifest");
  const currentRouting = routing ?? await readJson<VisualRoutingRecord>(path.join(projectDir, ARTIFACT_FILES.visualRouting));
  const currentProject = project ?? await readJson<VideoProject>(path.join(projectDir, "project.json"));
  await assertPrivacyEvidenceCurrent(projectDir, currentProject, currentRouting);
  if (direction.handoffManifest.privacyHash !== (currentRouting.privacyHash ?? null)) {
    throw new Error("Kimi handoff privacy evidence changed after preparation");
  }
  const currentOriginalPlanHash = await fileHash(path.join(projectDir, ARTIFACT_FILES.editPlan));
  if (currentOriginalPlanHash !== currentRouting.editPlanHash) {
    throw new Error("Kimi handoff source Edit Plan changed after preparation");
  }
  if ((await fileHash(direction.handoffManifest.editPlan.path)) !== direction.handoffManifest.editPlan.sha256) {
    throw new Error("Kimi handoff Edit Plan changed after preparation");
  }
  for (const frame of direction.handoffManifest.frames) {
    if ((await fileHash(frame.path)) !== frame.sha256) {
      throw new Error(`Kimi handoff frame changed after preparation: ${frame.path}`);
    }
  }
}

async function copyHashBound(sourcePath: string, destinationPath: string, expectedHash: string): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    const existing = await stat(destinationPath);
    if (!existing.isFile() || (await fileHash(destinationPath)) !== expectedHash) {
      throw new Error(`Isolated Kimi bundle contains conflicting file: ${destinationPath}`);
    }
    return;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Isolated Kimi bundle")) throw error;
  }
  await copyFile(sourcePath, destinationPath);
  if ((await fileHash(destinationPath)) !== expectedHash) {
    throw new Error(`Failed to verify isolated Kimi bundle file: ${destinationPath}`);
  }
}

async function prepareKimiUnlocked(input: PrepareKimiInput): Promise<PreparedKimi> {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  const routing = await readJson<VisualRoutingRecord>(
    path.join(input.projectDir, ARTIFACT_FILES.visualRouting),
  );
  let editPlan = await readJson<EditPlan>(path.join(input.projectDir, ARTIFACT_FILES.editPlan));
  const directionPath = path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection);
  const previousDirection = await readJson<KimiDirectionRecord>(directionPath);

  if (new Set(["fallback_codex_pending", "fallback_codex_completed"]).has(previousDirection.status)) {
    throw new Error(`Kimi handoff is ${previousDirection.status === "fallback_codex_pending" ? "pending Codex fallback" : "already completed by Codex fallback"}`);
  }

  if (routing.decision !== "kimi_advice_required") {
    throw new Error(`prepare-kimi requires kimi_advice_required, got ${routing.decision}`);
  }
  const redactionEvidence = await assertPrivacyEvidenceCurrent(input.projectDir, project, routing);
  const currentEditPlanHash = createHash("sha256")
    .update(await readFile(path.join(input.projectDir, ARTIFACT_FILES.editPlan)))
    .digest("hex");
  if (currentEditPlanHash !== routing.editPlanHash) {
    throw new Error("Visual routing is stale: edit-plan.json changed after route-visual");
  }

  if (redactionEvidence) {
    const approvedPlan = redactionEvidence.approvedOutputs.find((output) => output.kind === "edit_plan");
    if (!approvedPlan) throw new Error("Sensitive Kimi handoff is missing an approved redacted edit plan");
    editPlan = await readJson<EditPlan>(path.resolve(approvedPlan.path));
  }
  const selected = editPlan.shots.filter((shot) => routing.selectedShotIds.includes(shot.id));
  if (selected.length !== routing.selectedShotIds.length) {
    throw new Error("One or more selected shots are missing from edit-plan.json");
  }

  const framePaths = input.frames ?? [];
  if (framePaths.length < 6 || framePaths.length > 12) {
    throw new Error(`prepare-kimi requires 6 to 12 review frames, got ${framePaths.length}`);
  }
  const approvedFrameByPath = new Map(
    (redactionEvidence?.approvedOutputs ?? [])
      .filter((output) => output.kind === "frame")
      .map((output) => [path.resolve(output.path).toLowerCase(), output]),
  );
  const frames = [];
  for (const frame of framePaths) {
    const framePath = path.resolve(frame);
    let frameStat;
    try {
      frameStat = await stat(framePath);
    } catch {
      throw new Error(`Kimi review frame does not exist: ${framePath}`);
    }
    if (!frameStat.isFile()) throw new Error(`Kimi review frame is not a file: ${framePath}`);
    const sha256 = await fileHash(framePath);
    if (redactionEvidence) {
      const approved = approvedFrameByPath.get(framePath.toLowerCase());
      if (!approved || approved.sha256 !== sha256) {
        throw new Error(`Sensitive Kimi frame is not an approved redacted output: ${framePath}`);
      }
    }
    frames.push({ path: framePath, sha256 });
  }
  if (new Set(frames.map((frame) => frame.sha256)).size !== frames.length) {
    throw new Error("prepare-kimi review frames must have unique content");
  }
  let outputPath = path.resolve(input.outputPath);
  if (!/^incoming-kimi-review(?:-[a-z0-9][a-z0-9._-]*)?\.json$/i.test(path.basename(outputPath))) {
    throw new Error("Kimi advice outputPath must use a dedicated incoming-kimi-review*.json filename");
  }
  if (!redactionEvidence && path.dirname(outputPath).toLowerCase() !== path.resolve(input.projectDir).toLowerCase()) {
    throw new Error("Non-sensitive Kimi advice outputPath must be in the project root");
  }
  let packetPath = path.join(input.projectDir, "kimi-task-packet.txt");
  let workingDirectory = path.resolve(input.projectDir);
  let allowedPlanPath = path.join(input.projectDir, ARTIFACT_FILES.editPlan);
  let packetFrames = frames;
  if (redactionEvidence) {
    const approvedPlan = redactionEvidence.approvedOutputs.find((output) => output.kind === "edit_plan")!;
    const bundleKey = sha256Canonical({
      privacyHash: routing.privacyHash,
      routingEditPlanHash: routing.editPlanHash,
      approvedPlanHash: approvedPlan.sha256,
      frames: frames.map((frame) => frame.sha256),
    }).slice(0, 16);
    const bundleDir = path.join(input.projectDir, ".handoff", "kimi", `redacted-${bundleKey}`);
    const bundlePlanPath = path.join(bundleDir, "edit-plan.redacted.json");
    await copyHashBound(path.resolve(approvedPlan.path), bundlePlanPath, approvedPlan.sha256);
    packetFrames = [];
    for (const [index, frame] of frames.entries()) {
      const destination = path.join(bundleDir, "frames", `${String(index + 1).padStart(2, "0")}${path.extname(frame.path) || ".png"}`);
      await copyHashBound(frame.path, destination, frame.sha256);
      packetFrames.push({ path: destination, sha256: frame.sha256 });
    }
    workingDirectory = bundleDir;
    allowedPlanPath = bundlePlanPath;
    outputPath = path.join(bundleDir, path.basename(outputPath));
    packetPath = path.join(bundleDir, "kimi-task-packet.txt");
  }
  const handoffInput = {
    projectId: project.projectId,
    title: redactionEvidence ? "redacted-sensitive-project" : project.title,
    lane: project.lane,
    platform: project.platform,
    aspectRatio: project.aspectRatio,
    priority: project.priority,
    outputPath,
    brief: redactionEvidence ? null : (project as VideoProject & { brief?: unknown }).brief ?? null,
    selectedShots: selected,
    frames: packetFrames,
    routingEditPlanHash: routing.editPlanHash,
    handoffEditPlanHash: redactionEvidence
      ? redactionEvidence.approvedOutputs.find((output) => output.kind === "edit_plan")!.sha256
      : routing.editPlanHash,
  };
  const handoffManifest = {
    editPlan: {
      path: allowedPlanPath,
      sha256: redactionEvidence
        ? redactionEvidence.approvedOutputs.find((output) => output.kind === "edit_plan")!.sha256
        : routing.editPlanHash,
    },
    frames: packetFrames,
    privacyHash: routing.privacyHash ?? null,
  };
  const inputHash = hashPayload(handoffInput);
  const id = taskId(project.projectId, inputHash);
  const packet = [
    `Task ID: ${id}`,
    "Goal: Act as an external visual director. Improve composition, hierarchy, color, motion grammar, timing, and acceptance frames for only the selected shots.",
    `Working directory: ${workingDirectory}`,
    `Allowed files: Write only ${outputPath}. Read only ${allowedPlanPath} and the listed frames.`,
    "Forbidden files/areas: Do not modify source media, project.json, cut-plan.json, edit-plan.json, the main timeline, dependencies, build configuration, Workbench, or any unselected shot.",
    "User-observable acceptance criteria: Return actionable visual direction for each selected shot, with composition, hierarchy, palette, entry/development/conclusion motion, timing anchors, asset options, risks, and 3-5 acceptance frames.",
    "Required tests: Confirm every suggested shotId is selected and every protected decision remains unchanged.",
    "Stop and return to Codex when: Required visual context is missing, a protected decision would need to change, or work would exceed the allowed output file.",
    "Required completion report: List suggestions, uncertainties, files read, the single file written, and safety-boundary confirmation.",
    "Do not modify script, facts, timeline, or brand constraints.",
    "",
    "Return JSON with this shape:",
    JSON.stringify(
      {
        sessionId: "returned-kimi-session-id",
        inputHash,
        suggestions: [
          {
            shotId: "selected-shot-id",
            why: "reason",
            composition: "layout",
            hierarchy: "attention order",
            palette: "brand-derived colors",
            motion: { entry: "", development: "", conclusion: "" },
            timingAnchors: ["spoken anchor"],
            assets: ["required asset"],
            risks: ["over-design risk"],
            acceptanceFrames: ["frame description"],
          },
        ],
        constraintConfirmation: {
          scriptUnchanged: true,
          factsUnchanged: true,
          timelineUnchanged: true,
          brandConstraintsPreserved: true,
        },
      },
      null,
      2,
    ),
    "",
    "Handoff input:",
    JSON.stringify(handoffInput, null, 2),
    "",
  ].join("\n");
  const packetSha256 = createHash("sha256").update(packet, "utf8").digest("hex");

  if (previousDirection.status === "prepared" && previousDirection.inputHash === inputHash) {
    let currentPacketHash: string | null = null;
    try {
      currentPacketHash = await fileHash(packetPath);
    } catch {
      currentPacketHash = null;
    }
    if (
      previousDirection.packetPath !== packetPath ||
      previousDirection.packetSha256 !== packetSha256 ||
      currentPacketHash !== packetSha256
    ) {
      await mkdir(path.dirname(packetPath), { recursive: true });
      await writeFile(packetPath, packet, "utf8");
      await writeJson(directionPath, {
        ...previousDirection,
        taskId: id,
        packetPath,
        packetSha256,
        outputPath,
        workingDirectory,
        handoffManifest,
        packetRepairedAt: new Date().toISOString(),
      });
    }
    return { taskId: id, packetPath, inputHash, outputPath, workingDirectory };
  }
  if (routing.callsUsed >= routing.maxCalls) {
    throw new Error(`Kimi call budget exhausted (${routing.callsUsed}/${routing.maxCalls})`);
  }
  const resumeSessionId = input.resumeSessionId?.trim() || null;
  if (routing.callsUsed > 0) {
    if (project.priority !== "flagship") throw new Error("Only flagship projects may continue a second Kimi call");
    if (!resumeSessionId || resumeSessionId !== previousDirection.sessionId) {
      throw new Error("Flagship Kimi continuation must resume the previous sessionId");
    }
  } else if (resumeSessionId) {
    throw new Error("A first Kimi call cannot resume an existing session");
  }

  await mkdir(path.dirname(packetPath), { recursive: true });
  await writeFile(packetPath, packet, "utf8");
  routing.callsUsed += 1;
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.visualRouting), routing);
  const priorReviews = [...(previousDirection.priorReviews ?? [])];
  if (!new Set(["not_requested", "prepared"]).has(previousDirection.status)) {
    priorReviews.push({ ...previousDirection, priorReviews: undefined });
  }
  await writeJson(directionPath, {
    schemaVersion: SCHEMA_VERSION,
    status: "prepared",
    taskId: id,
    inputHash,
    outputPath,
    packetPath,
    packetSha256,
    workingDirectory,
    handoffManifest,
    sessionId: previousDirection.sessionId ?? null,
    expectedSessionId: resumeSessionId,
    callNumber: routing.callsUsed,
    suggestions: [],
    decisions: [],
    priorReviews,
    preparedAt: new Date().toISOString(),
  });

  return { taskId: id, packetPath, inputHash, outputPath, workingDirectory };
}

export async function withKimiProjectLock<T>(projectDir: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(projectDir, ".prepare-kimi.lock");
  const createLock = async (recoveredStaleLock: boolean) => {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      recoveredStaleLock,
    })}\n`, "utf8");
    await handle.sync();
    return handle;
  };
  let lock;
  try {
    lock = await createLock(false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let lockPid = 0;
    let lockAgeMs = 0;
    try {
      const lockStat = await stat(lockPath);
      lockAgeMs = Date.now() - lockStat.mtimeMs;
      try {
        const metadata = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; createdAt?: string };
        lockPid = Number(metadata.pid ?? 0);
        const createdAt = Date.parse(metadata.createdAt ?? "");
        if (Number.isFinite(createdAt)) lockAgeMs = Date.now() - createdAt;
      } catch {
        lockPid = 0;
      }
    } catch {
      lockAgeMs = 0;
    }
    let processAlive = false;
    if (Number.isInteger(lockPid) && lockPid > 0) {
      try {
        process.kill(lockPid, 0);
        processAlive = true;
      } catch (probeError) {
        processAlive = (probeError as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (processAlive || lockAgeMs < 5 * 60 * 1000) {
      throw new Error(`Another Kimi handoff operation is already in progress: ${lockPath}`);
    }
    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    try {
      await rename(lockPath, stalePath);
      lock = await createLock(true);
    } catch {
      throw new Error(`Could not safely recover stale Kimi handoff lock: ${lockPath}`);
    } finally {
      await unlink(stalePath).catch(() => undefined);
    }
  }
  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function withKimiMutationLocks<T>(
  projectDir: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  return withProjectStateLock(projectDir, operation, () => withKimiProjectLock(projectDir, action));
}

export async function prepareKimi(input: PrepareKimiInput): Promise<PreparedKimi> {
  return withKimiMutationLocks(input.projectDir, "prepare-kimi", () => prepareKimiUnlocked(input));
}

function confirmProtectedConstraints(review: KimiReview): void {
  const confirmation = review.constraintConfirmation as Record<string, unknown> | undefined;
  const requiredKeys = [
    "scriptUnchanged",
    "factsUnchanged",
    "timelineUnchanged",
    "brandConstraintsPreserved",
  ];
  const actualKeys = Object.keys(confirmation ?? {}).sort();
  if (
    actualKeys.length !== requiredKeys.length ||
    actualKeys.some((key, index) => key !== [...requiredKeys].sort()[index]) ||
    requiredKeys.some((key) => confirmation?.[key] !== true)
  ) {
    throw new Error("Kimi review did not preserve all protected constraints");
  }
}

async function importKimiReviewUnlocked(input: { projectDir: string; inputPath: string }) {
  const directionPath = path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection);
  const routingPath = path.join(input.projectDir, ARTIFACT_FILES.visualRouting);
  const projectPath = path.join(input.projectDir, "project.json");
  const direction = await readJson<KimiDirectionRecord>(directionPath);
  const routing = await readJson<VisualRoutingRecord>(routingPath);
  const project = await readJson<VideoProject>(projectPath);
  const review = await readJson<KimiReview>(input.inputPath);

  if (direction.status !== "prepared") {
    throw new Error(`import-kimi-review requires prepared status, got ${String(direction.status)}`);
  }
  if (!review.sessionId || !Array.isArray(review.suggestions) || review.suggestions.length === 0) {
    throw new Error("Kimi review must include sessionId and at least one suggestion");
  }
  if (review.inputHash !== direction.inputHash) {
    throw new Error("Kimi review is stale: inputHash does not match the prepared task packet");
  }
  try {
    await assertKimiHandoffCurrent(input.projectDir, direction, routing, project);
  } catch (error) {
    await writeJsonAtomic(directionPath, { ...direction, status: "stale", staleReason: "handoff_evidence_changed" });
    throw error;
  }
  if (direction.expectedSessionId && review.sessionId !== direction.expectedSessionId) {
    throw new Error("Flagship Kimi continuation returned a different sessionId");
  }
  const currentEditPlanHash = createHash("sha256")
    .update(await readFile(path.join(input.projectDir, ARTIFACT_FILES.editPlan)))
    .digest("hex");
  if (currentEditPlanHash !== routing.editPlanHash) {
    await writeJson(directionPath, { ...direction, status: "stale", staleReason: "edit_plan_changed" });
    throw new Error("Kimi review is stale: edit-plan.json changed after visual routing");
  }
  confirmProtectedConstraints(review);
  for (const suggestion of review.suggestions) {
    if (!routing.selectedShotIds.includes(suggestion.shotId)) {
      throw new Error(`Kimi review contains unselected shot: ${suggestion.shotId}`);
    }
  }

  const incomingHash = createHash("sha256").update(await readFile(input.inputPath)).digest("hex");
  await writeJson(directionPath, {
    ...direction,
    status: "received",
    sessionId: review.sessionId,
    incomingHash,
    suggestions: review.suggestions,
    decisions: review.suggestions.map((suggestion) => ({ shotId: suggestion.shotId, decision: "pending" })),
    constraintConfirmation: review.constraintConfirmation,
    receivedAt: new Date().toISOString(),
  });
  if (project.workflowStatus === "plan_ready") {
    project.workflowStatus = "visual_direction_ready";
    project.updatedAt = new Date().toISOString();
    await writeJson(projectPath, project);
  }
  return { sessionId: review.sessionId, suggestions: review.suggestions.length };
}

export async function importKimiReview(input: Parameters<typeof importKimiReviewUnlocked>[0]) {
  return withKimiMutationLocks(input.projectDir, "import-kimi-review", () => importKimiReviewUnlocked(input));
}

async function recordKimiFailureUnlocked(input: {
  projectDir: string;
  attempt: "initial" | "retry";
  reason: KimiFailureReason;
  detail: string;
  startedAt: string;
  endedAt: string;
  launcherExitStatus: number;
  rawReportPath: string;
  sessionId?: string;
}) {
  if (!new Set(["initial", "retry"]).has(input.attempt)) {
    throw new Error(`Unsupported Kimi failure attempt: ${input.attempt}`);
  }
  if (!new Set<KimiFailureReason>(["timeout", "rate_limited", "invalid_output", "unavailable"]).has(input.reason)) {
    throw new Error(`Unsupported Kimi failure reason: ${input.reason}`);
  }
  if (!input.detail.trim()) throw new Error("Kimi failure detail is required");
  const directionPath = path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection);
  const direction = await readJson<KimiDirectionRecord & {
    failureHistory?: Array<Record<string, unknown>>;
    retryState?: string;
    retriesRemaining?: number;
  }>(directionPath);
  if (direction.status !== "prepared") {
    throw new Error(`record-kimi-failure requires prepared status, got ${direction.status}`);
  }
  await assertKimiHandoffCurrent(input.projectDir, direction);
  const startedAtMs = Date.parse(input.startedAt);
  const endedAtMs = Date.parse(input.endedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    throw new Error("Kimi failure requires valid ordered startedAt and endedAt timestamps");
  }
  if (!Number.isInteger(input.launcherExitStatus) || input.launcherExitStatus < 0 || input.launcherExitStatus > 255) {
    throw new Error("Kimi failure launcherExitStatus must be an integer from 0 to 255");
  }
  const rawReportPath = path.resolve(input.rawReportPath);
  if (!/^kimi-raw-report-(?:initial|retry)(?:-[a-z0-9][a-z0-9._-]*)?\.txt$/i.test(path.basename(rawReportPath))) {
    throw new Error("Kimi raw report must use a dedicated kimi-raw-report-initial*.txt or kimi-raw-report-retry*.txt filename");
  }
  if (path.dirname(rawReportPath).toLowerCase() !== path.resolve(input.projectDir).toLowerCase()) {
    throw new Error("Kimi raw report must be in the project root");
  }
  const rawReportStat = await lstat(rawReportPath);
  if (!rawReportStat.isFile() || rawReportStat.size === 0) {
    throw new Error("Kimi raw report must be a non-empty regular file");
  }
  const expectedReportPrefix = `kimi-raw-report-${input.attempt}`;
  if (!path.basename(rawReportPath).toLowerCase().startsWith(expectedReportPrefix)) {
    throw new Error(`Kimi raw report filename must match attempt ${input.attempt}`);
  }
  const rawReportBytes = await readFile(rawReportPath);
  const rawReportSha256 = createHash("sha256").update(rawReportBytes).digest("hex");
  let outputSha256: string | null = null;
  if (direction.outputPath) {
    try {
      outputSha256 = await fileHash(direction.outputPath);
    } catch {
      outputSha256 = null;
    }
  }
  const failureRecord = {
    attempt: input.attempt,
    reason: input.reason,
    detail: input.detail.trim(),
    taskId: direction.taskId,
    inputHash: direction.inputHash,
    packetSha256: direction.packetSha256,
    sessionId: input.sessionId?.trim() || null,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs: endedAtMs - startedAtMs,
    launcherExitStatus: input.launcherExitStatus,
    rawReportPath,
    rawReportSha256,
    outputPath: direction.outputPath ?? null,
    outputSha256,
    recordedAt: new Date().toISOString(),
  };
  const existingFailures = direction.failureHistory ?? [];
  if (input.attempt === "retry") {
    if (direction.retryState !== "authorized" || direction.retriesRemaining !== 1 || existingFailures.length !== 1) {
      throw new Error("A retry failure can only be recorded after an initial failure authorizes it");
    }
    const initialSessionId = existingFailures[0]?.sessionId;
    if (
      existingFailures[0]?.attempt !== "initial" ||
      existingFailures[0]?.taskId !== direction.taskId ||
      existingFailures[0]?.inputHash !== direction.inputHash ||
      existingFailures[0]?.packetSha256 !== direction.packetSha256
    ) {
      throw new Error("Initial Kimi failure evidence does not match the prepared task packet");
    }
    if (initialSessionId && failureRecord.sessionId !== initialSessionId) {
      throw new Error("Kimi retry failure must use the initial attempt sessionId");
    }
    const failureHistory = [...existingFailures, failureRecord];
    const routingPath = path.join(input.projectDir, ARTIFACT_FILES.visualRouting);
    const routing = await readJson<VisualRoutingRecord & { fallback?: Record<string, unknown> }>(routingPath);
    await writeJsonAtomic(routingPath, {
      ...routing,
      fallback: {
        target: "codex",
        status: "pending",
        failureCount: failureHistory.length,
        packetSha256: direction.packetSha256,
        requestedAt: new Date().toISOString(),
      },
    });
    await writeJsonAtomic(directionPath, {
      ...direction,
      status: "fallback_codex_pending",
      retryState: "exhausted",
      retriesRemaining: 0,
      failureHistory,
      fallbackRequestedAt: new Date().toISOString(),
    });
    return { status: "fallback_codex_pending", nextAction: "record_codex_fallback", retriesRemaining: 0 } as const;
  }
  if (existingFailures.length > 0) {
    throw new Error("The initial Kimi failure has already been recorded");
  }
  const failureHistory = [failureRecord];
  await writeJsonAtomic(directionPath, {
    ...direction,
    retryState: "authorized",
    retriesRemaining: 1,
    retryRequiresSamePacket: true,
    failureHistory,
  });
  return { status: "prepared", nextAction: "retry_same_packet", retriesRemaining: 1 } as const;
}

export async function recordKimiFailure(input: Parameters<typeof recordKimiFailureUnlocked>[0]) {
  return withKimiMutationLocks(input.projectDir, "record-kimi-failure", () => recordKimiFailureUnlocked(input));
}

async function completeKimiFallbackUnlocked(input: { projectDir: string; inputPath: string }) {
  const directionPath = path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection);
  const routingPath = path.join(input.projectDir, ARTIFACT_FILES.visualRouting);
  const projectPath = path.join(input.projectDir, "project.json");
  const direction = await readJson<KimiDirectionRecord & {
    failureHistory?: Array<Record<string, unknown>>;
    codexFallback?: { inputSha256?: string; shotDirections?: Array<Record<string, unknown>> };
  }>(directionPath);
  const routing = await readJson<VisualRoutingRecord & { fallback?: Record<string, unknown> }>(routingPath);
  const project = await readJson<VideoProject>(projectPath);
  await assertKimiHandoffCurrent(input.projectDir, direction, routing, project);
  if (routing.fallback?.packetSha256 !== direction.packetSha256) {
    throw new Error("Codex fallback routing is bound to a different Kimi task packet");
  }
  const inputPath = path.resolve(input.inputPath);
  if (!/^codex-visual-fallback(?:-[a-z0-9][a-z0-9._-]*)?\.json$/i.test(path.basename(inputPath))) {
    throw new Error("Codex fallback input must use a dedicated codex-visual-fallback*.json filename");
  }
  if (path.dirname(inputPath).toLowerCase() !== path.resolve(input.projectDir).toLowerCase()) {
    throw new Error("Codex fallback input must be in the project root");
  }
  const inputStat = await lstat(inputPath);
  if (!inputStat.isFile() || inputStat.size === 0) throw new Error("Codex fallback input must be a non-empty regular file");
  const inputBytes = await readFile(inputPath);
  const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
  if (direction.status === "fallback_codex_completed") {
    if (direction.codexFallback?.inputSha256 !== inputSha256) {
      throw new Error("Completed Codex fallback is bound to a different input hash");
    }
    const completedAt = String((direction.codexFallback as Record<string, unknown> | undefined)?.completedAt ?? new Date().toISOString());
    if (routing.fallback?.status !== "completed") {
      await writeJsonAtomic(routingPath, {
        ...routing,
        fallback: { ...routing.fallback, status: "completed", directionSha256: inputSha256, completedAt },
      });
    }
    if (project.workflowStatus === "plan_ready") {
      project.workflowStatus = "visual_direction_ready";
      project.updatedAt = completedAt;
      await writeJsonAtomic(projectPath, project);
    }
    return { status: "fallback_codex_completed", shots: direction.codexFallback?.shotDirections?.length ?? 0 } as const;
  }
  if (direction.status !== "fallback_codex_pending") {
    throw new Error(`complete-kimi-fallback requires fallback_codex_pending status, got ${direction.status}`);
  }
  const failures = direction.failureHistory ?? [];
  const failuresMatchPreparedTask =
    failures.length === 2 &&
    failures[0]?.attempt === "initial" &&
    failures[1]?.attempt === "retry" &&
    failures.every((failure) =>
      failure.taskId === direction.taskId &&
      failure.inputHash === direction.inputHash &&
      failure.packetSha256 === direction.packetSha256
    );
  if (!failuresMatchPreparedTask || routing.fallback?.status !== "pending") {
    throw new Error("Codex fallback requires evidence of the initial failure and the only retry failure");
  }
  const fallback = JSON.parse(inputBytes.toString("utf8")) as CodexFallbackInput;
  if (!fallback.reviewer?.trim() || !fallback.rationale?.trim()) {
    throw new Error("Codex fallback requires reviewer and rationale");
  }
  if (!Array.isArray(fallback.shotDirections)) throw new Error("Codex fallback shotDirections must be an array");
  const expectedShotIds = new Set(routing.selectedShotIds);
  const actualShotIds = new Set<string>();
  for (const shot of fallback.shotDirections) {
    if (!expectedShotIds.has(shot.shotId)) throw new Error(`Codex fallback contains unselected shot: ${shot.shotId}`);
    if (actualShotIds.has(shot.shotId)) throw new Error(`Duplicate Codex fallback shot: ${shot.shotId}`);
    actualShotIds.add(shot.shotId);
    for (const [key, value] of Object.entries({
      composition: shot.composition,
      hierarchy: shot.hierarchy,
      palette: shot.palette,
      motionEntry: shot.motion?.entry,
      motionDevelopment: shot.motion?.development,
      motionConclusion: shot.motion?.conclusion,
    })) {
      if (typeof value !== "string" || !value.trim()) throw new Error(`Codex fallback ${shot.shotId} requires ${key}`);
    }
    if (!Array.isArray(shot.timingAnchors) || shot.timingAnchors.length === 0 || shot.timingAnchors.some((item) => !item?.trim())) {
      throw new Error(`Codex fallback ${shot.shotId} requires timingAnchors`);
    }
    if (
      !Array.isArray(shot.acceptanceFrames) ||
      shot.acceptanceFrames.length < 3 ||
      shot.acceptanceFrames.length > 5 ||
      shot.acceptanceFrames.some((item) => !item?.trim())
    ) {
      throw new Error(`Codex fallback ${shot.shotId} requires 3 to 5 acceptanceFrames`);
    }
  }
  const missing = [...expectedShotIds].filter((shotId) => !actualShotIds.has(shotId));
  if (missing.length > 0) throw new Error(`Codex fallback is incomplete; missing shots: ${missing.join(", ")}`);
  confirmProtectedConstraints(fallback as unknown as KimiReview);
  const completedAt = new Date().toISOString();
  await writeJsonAtomic(directionPath, {
    ...direction,
    status: "fallback_codex_completed",
    codexFallback: {
      reviewer: fallback.reviewer.trim(),
      rationale: fallback.rationale.trim(),
      inputPath,
      inputSha256,
      shotDirections: fallback.shotDirections,
      constraintConfirmation: fallback.constraintConfirmation,
      completedAt,
    },
  });
  await writeJsonAtomic(routingPath, {
    ...routing,
    fallback: {
      ...routing.fallback,
      status: "completed",
      directionSha256: inputSha256,
      completedAt,
    },
  });
  if (project.workflowStatus === "plan_ready") {
    project.workflowStatus = "visual_direction_ready";
    project.updatedAt = completedAt;
    await writeJsonAtomic(projectPath, project);
  }
  return { status: "fallback_codex_completed", shots: fallback.shotDirections.length } as const;
}

export async function completeKimiFallback(input: Parameters<typeof completeKimiFallbackUnlocked>[0]) {
  return withKimiMutationLocks(input.projectDir, "complete-kimi-fallback", () => completeKimiFallbackUnlocked(input));
}

async function decideKimiReviewUnlocked(input: { projectDir: string; inputPath: string }) {
  const directionPath = path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection);
  const direction = await readJson<Record<string, unknown> & {
    status: string;
    suggestions: Array<{ shotId: string }>;
    decisions: Array<Record<string, unknown>>;
  }>(directionPath);
  if (direction.status !== "received") {
    throw new Error(`decide-kimi-review requires received status, got ${direction.status}`);
  }
  const review = await readJson<KimiDecisionInput>(path.resolve(input.inputPath));
  if (!review.reviewer?.trim()) throw new Error("Kimi decision review requires a reviewer");
  if (!Array.isArray(review.decisions)) throw new Error("Kimi decisions must be an array");
  const suggestionIds = new Set(direction.suggestions.map((suggestion) => suggestion.shotId));
  const decisions = new Map<string, KimiDecisionInput["decisions"][number]>();
  for (const decision of review.decisions) {
    if (!suggestionIds.has(decision.shotId)) throw new Error(`Unknown Kimi suggestion shot: ${decision.shotId}`);
    if (decisions.has(decision.shotId)) throw new Error(`Duplicate Kimi decision: ${decision.shotId}`);
    if (!new Set<KimiDecision>(["accept", "adjust", "reject"]).has(decision.decision)) {
      throw new Error(`Invalid Kimi decision for ${decision.shotId}: ${decision.decision}`);
    }
    if (!decision.rationale?.trim()) throw new Error(`Kimi decision ${decision.shotId} requires a rationale`);
    decisions.set(decision.shotId, decision);
  }
  const missing = [...suggestionIds].filter((shotId) => !decisions.has(shotId));
  if (missing.length > 0) throw new Error(`Kimi decision review is incomplete; missing shots: ${missing.join(", ")}`);
  const recorded = [...decisions.values()].map((decision) => ({
    ...decision,
    rationale: decision.rationale.trim(),
    reviewer: review.reviewer.trim(),
    decidedAt: new Date().toISOString(),
  }));
  const values = recorded.map((decision) => decision.decision);
  const status = values.every((decision) => decision === "accept")
    ? "accepted"
    : values.every((decision) => decision === "reject")
      ? "rejected"
      : "partially_accepted";
  await writeJson(directionPath, { ...direction, status, decisions: recorded });
  return {
    status,
    accepted: values.filter((decision) => decision === "accept").length,
    adjusted: values.filter((decision) => decision === "adjust").length,
    rejected: values.filter((decision) => decision === "reject").length,
  };
}

export async function decideKimiReview(input: Parameters<typeof decideKimiReviewUnlocked>[0]) {
  return withKimiMutationLocks(input.projectDir, "decide-kimi-review", () => decideKimiReviewUnlocked(input));
}

async function acceptKimiSceneUnlocked(input: {
  projectDir: string;
  shotId: string;
  implementationPath: string;
  beforeFramePath: string;
  afterFramePath: string;
  reviewer: string;
  attribution:
    | "kimi_independently_completed"
    | "codex_repaired_after_kimi"
    | "codex_implemented_from_kimi_advice";
}) {
  if (
    !new Set([
      "kimi_independently_completed",
      "codex_repaired_after_kimi",
      "codex_implemented_from_kimi_advice",
    ]).has(input.attribution)
  ) {
    throw new Error(`Invalid Kimi scene attribution: ${input.attribution}`);
  }
  if (!input.reviewer.trim()) throw new Error("Kimi scene acceptance requires a reviewer");
  const directionPath = path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection);
  const routing = await readJson<VisualRoutingRecord>(path.join(input.projectDir, ARTIFACT_FILES.visualRouting));
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  const direction = await readJson<Record<string, unknown> & {
    status: string;
    decisions: Array<{ shotId: string; decision: KimiDecision }>;
    acceptedScenes?: Array<Record<string, unknown> & { shotId: string }>;
  }>(directionPath);
  if (!new Set(["accepted", "partially_accepted"]).has(direction.status)) {
    throw new Error(`accept-kimi-scene requires accepted or partially_accepted direction, got ${direction.status}`);
  }
  try {
    await assertPrivacyEvidenceCurrent(input.projectDir, project, routing);
  } catch (error) {
    await writeJson(directionPath, { ...direction, status: "stale", staleReason: "privacy_evidence_changed" });
    throw error;
  }
  const decision = direction.decisions.find((item) => item.shotId === input.shotId);
  if (!decision || decision.decision === "reject") {
    throw new Error(`Shot ${input.shotId} does not have an accepted or adjusted Kimi decision`);
  }
  const currentEditPlanHash = createHash("sha256")
    .update(await readFile(path.join(input.projectDir, ARTIFACT_FILES.editPlan)))
    .digest("hex");
  if (currentEditPlanHash !== routing.editPlanHash) {
    await writeJson(directionPath, { ...direction, status: "stale", staleReason: "edit_plan_changed" });
    throw new Error("Kimi scene acceptance is stale: edit-plan.json changed after visual routing");
  }
  const implementationPath = path.resolve(input.implementationPath);
  const beforeFramePath = path.resolve(input.beforeFramePath);
  const afterFramePath = path.resolve(input.afterFramePath);
  for (const filePath of [implementationPath, beforeFramePath, afterFramePath]) {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new Error(`Kimi scene evidence does not exist: ${filePath}`);
    }
    if (!fileStat.isFile()) throw new Error(`Kimi scene evidence is not a file: ${filePath}`);
  }
  const record = {
    shotId: input.shotId,
    decision: decision.decision,
    attribution: input.attribution,
    reviewer: input.reviewer.trim(),
    implementationPath,
    implementationSha256: await fileHash(implementationPath),
    beforeFramePath,
    beforeFrameSha256: await fileHash(beforeFramePath),
    afterFramePath,
    afterFrameSha256: await fileHash(afterFramePath),
    acceptedAt: new Date().toISOString(),
  };
  const acceptedScenes = [...(direction.acceptedScenes ?? [])];
  const index = acceptedScenes.findIndex((item) => item.shotId === input.shotId);
  if (index >= 0) acceptedScenes[index] = record;
  else acceptedScenes.push(record);
  await writeJson(directionPath, { ...direction, acceptedScenes });
  return { shotId: input.shotId, attribution: input.attribution, implementationSha256: record.implementationSha256 };
}

export async function acceptKimiScene(input: Parameters<typeof acceptKimiSceneUnlocked>[0]) {
  return withKimiMutationLocks(input.projectDir, "accept-kimi-scene", () => acceptKimiSceneUnlocked(input));
}
