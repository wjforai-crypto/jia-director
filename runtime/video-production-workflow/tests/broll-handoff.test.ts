import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import contractBundle from "../schemas/contracts.schema.json" with { type: "json" };
import { initProject } from "../src/project.js";
import { ingestAsset, sha256File } from "../src/media.js";
import { analyzeReference, reviewReference } from "../src/reference-analysis.js";
import { applyRecreation, createRecreationPlan, reviewRecreation } from "../src/reference-recreation.js";
import { archiveProject } from "../src/archive.js";
import { confirmVersion, recordVersion } from "../src/review-gates.js";
import { validateProjectArtifacts } from "../src/validation.js";
import {
  approveBrollHandoff,
  brollArchiveErrors,
  claimBrollExecution,
  importBrollResult,
  prepareBrollHandoff,
  reconcileBrollExecutionClaim,
  reviewBrollResult,
  validateBrollHandoffs,
} from "../src/broll-handoff.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function runCliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function fixtureVideo(filePath: string, color = "navy", duration = "1.2"): void {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=24:d=${duration}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", filePath],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
}

function fixtureFrame(filePath: string, color: string): void {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180`, "-frames:v", "1", "-y", filePath],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
}

function referenceInput() {
  return {
    sourceUrl: "https://example.test/reference",
    acquisition: { method: "user_provided", tool: "fixture", retrievedAt: "2026-09-27T00:00:00.000Z" },
    intendedUse: "analysis_and_original_recreation",
    rightsNotes: ["只借鉴结构，不复制受保护表达"],
    referenceVerbatimTranscript: {
      language: "zh",
      reviewStatus: "human_verified",
      segments: [{ start: 0, end: 1, text: "原片台词", speaker: "原作者", confidence: 1 }],
      words: [{ start: 0, end: 1, text: "原片台词", confidence: 1 }],
    },
    shots: [{
      slug: "reference-shot",
      sourceIn: 0,
      sourceOut: 1,
      shotSize: "中景",
      composition: "主体居中",
      cameraPosition: "平视",
      cameraMovement: "固定",
      subjectAction: "看向镜头",
      visualFunction: "提出问题",
      transitionIn: "直接开场",
      transitionOut: "硬切",
      audio: { dialogue: "原片台词", sfx: [], musicCue: "无" },
      confidence: 1,
    }],
    editGrammar: {
      hook: "第一拍提出问题",
      structure: ["问题", "回答"],
      pacing: "克制",
      captions: "两行以内",
      transitions: "硬切",
      broll: "关键词出现时覆盖",
      motionGraphics: "少量",
      soundDesign: "轻提示",
      music: "无",
    },
    transferablePatterns: [{ name: "问题钩子", evidence: ["reference-shot"], adaptation: "替换为自有问题" }],
    protectedElements: ["原作者台词"],
    unknowns: [],
  };
}

function recreationInput() {
  return {
    brief: {
      audience: "保险从业者",
      objective: "展示自有工作方法",
      platform: "视频号",
      aspectRatio: "16:9",
      durationSeconds: 2,
      tone: "具体",
      facts: ["只使用自有内容"],
      brandRules: ["字幕不遮挡主体"],
    },
    adaptationPolicy: {
      mode: "structure_recreation",
      borrowedMechanisms: ["问题钩子"],
      mustReplace: ["原作者台词"],
      replacementMap: [{
        sourceElement: "原作者台词",
        action: "replace",
        replacement: "改为原创台词：我只看一个方法。",
        verification: "逐字稿人工核对",
        targetPaths: ["/targetVerbatimScript/0/text"],
        replacementAnchors: ["我只看一个方法"],
      }],
      authorizationEvidence: [],
    },
    creativeOptions: [
      { slug: "a", name: "实拍版", coreIdea: "实拍", referenceUse: "借鉴结构", visualApproach: "桌面", productionCost: "低", risk: "低", fit: "高" },
      { slug: "b", name: "卡片版", coreIdea: "卡片", referenceUse: "借鉴节奏", visualApproach: "卡片", productionCost: "低", risk: "低", fit: "高" },
    ],
    selectedOptionSlug: "a",
    scriptOutline: [{ slug: "line", purpose: "说明方法", referenceMechanism: "问题钩子", targetMessage: "看方法" }],
    targetVerbatimScript: [{ slug: "line", sectionSlug: "line", text: "我只看一个方法。", purpose: "说明方法", delivery: "平稳" }],
    shootingPlan: [{
      slug: "shot",
      timelineIn: 0,
      timelineOut: 2,
      lineSlugs: ["line"],
      referenceShotSlugs: ["reference-shot"],
      scene: "自有书桌",
      framing: "中景",
      composition: "主体居中",
      cameraPosition: "平视",
      cameraMovement: "固定",
      subjectAction: "手部勾选卡片",
      performance: "本人出镜",
      props: ["卡片"],
      lighting: "柔光",
      audioCapture: "领夹麦",
      continuity: "动作连续",
    }],
    editBlueprint: [{
      shootingShotSlug: "shot",
      referenceMechanisms: ["问题钩子"],
      cutStrategy: "直接进入",
      pacing: "两秒",
      brollSlots: [{
        trigger: "方法",
        purpose: "展示方法",
        visual: "俯拍桌面，手部勾选卡片",
        sourceStrategy: "generated_after_approval",
        sourcePlan: { provenance: "待生成", rightsStatus: "pending_generation" },
        generation: {
          executor: "minimax-broll-generator",
          model: "MiniMax-H3",
          mode: "T2VA",
          prompt: "16:9 写实俯拍桌面，成年人的手依次勾选三张自有工作卡片，动作清楚，画面不出现品牌 Logo。",
        },
        durationSeconds: 2,
        reviewBeforeUse: true,
      }],
      motionGraphics: [],
      sfx: [],
      music: { cue: "无", mood: "克制", change: "无" },
      transition: "硬切",
      keyFrames: ["开场", "结束"],
      acceptance: ["动作清楚"],
    }],
  };
}

async function setupApprovedPlan(tempRoot: string) {
  const projectDir = path.join(tempRoot, "project");
  const referencePath = path.join(tempRoot, "reference.mp4");
  fixtureVideo(referencePath);
  await initProject({ projectDir, title: "B-roll handoff fixture", lane: "speech", sourcePath: path.join(tempRoot, "target.mp4"), platform: "视频号", aspectRatio: "16:9" });
  const ingested = await ingestAsset({ projectDir, assetPath: referencePath, role: "reference", provenance: "public-reference" });
  const analysisInputPath = path.join(tempRoot, "reference.json");
  await writeFile(analysisInputPath, `${JSON.stringify(referenceInput(), null, 2)}\n`, "utf8");
  await analyzeReference({ projectDir, assetId: ingested.assetId, inputPath: analysisInputPath });
  await reviewReference({ projectDir, decision: "approve", reviewer: "王杰", authority: "user" });
  const planInputPath = path.join(tempRoot, "plan-input.json");
  await writeFile(planInputPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
  await createRecreationPlan({ projectDir, inputPath: planInputPath });
  await reviewRecreation({ projectDir, decision: "approve", reviewer: "王杰", authority: "user" });
  const plan = JSON.parse(await readFile(path.join(projectDir, "recreation-plan.json"), "utf8")) as { editBlueprint: Array<{ brollSlots: Array<{ id: string }> }> };
  return { projectDir, referencePath, slotId: plan.editBlueprint[0].brollSlots[0].id };
}

async function applyApprovedPlan(projectDir: string, tempRoot: string): Promise<void> {
  const projectPath = path.join(projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "plan_ready";
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

  const plan = JSON.parse(await readFile(path.join(projectDir, "recreation-plan.json"), "utf8"));
  const line = plan.targetVerbatimScript[0];
  const transcriptPath = path.join(projectDir, "transcript.json");
  await writeFile(transcriptPath, `${JSON.stringify({
    schemaVersion: "1.0.0",
    sourceAssetId: "asset_target_recording",
    engine: "human-verified-test",
    language: "zh",
    segments: [{ id: "seg_target_line", text: line.text, start: 0, end: 2, wordIds: [] }],
    words: [],
  }, null, 2)}\n`, "utf8");

  const cutPlanPath = path.join(projectDir, "cut-plan.json");
  await writeFile(cutPlanPath, `${JSON.stringify({
    schemaVersion: "1.0.0",
    transcriptHash: await sha256File(transcriptPath),
    reviewStatus: "approved",
    operations: [{ id: "op_target_line", kind: "speech", decision: "keep", segmentId: "seg_target_line", transcript: line.text }],
  }, null, 2)}\n`, "utf8");

  const editPlanPath = path.join(projectDir, "edit-plan.json");
  await writeFile(editPlanPath, `${JSON.stringify({
    schemaVersion: "1.0.0",
    cutPlanHash: await sha256File(cutPlanPath),
    reviewStatus: "ready",
    shots: [{ id: "shot_target_line", cutOperationId: "op_target_line", voiceover: line.text, semanticIntent: "目标方法", visualRole: "a-roll" }],
  }, null, 2)}\n`, "utf8");

  const mappingPath = path.join(tempRoot, `recreation-application-${Date.now()}.json`);
  await writeFile(mappingPath, `${JSON.stringify({
    recreationPlanContentHash: plan.contentHash,
    targetTranscriptHash: await sha256File(transcriptPath),
    cutPlanHash: await sha256File(cutPlanPath),
    editPlanHash: await sha256File(editPlanPath),
    reviewer: "Codex",
    mappings: [{ recreationShotId: plan.shootingPlan[0].id, editShotId: "shot_target_line" }],
  }, null, 2)}\n`, "utf8");
  await applyRecreation({ projectDir, inputPath: mappingPath });
}

async function archiveFixture(projectDir: string, tempRoot: string): Promise<void> {
  const groups = ["source", "editable_project", "preview", "review_evidence", "asset_manifest", "readme"];
  const entries = [];
  for (const group of groups) {
    const filePath = path.join(tempRoot, `archive-${group}.txt`);
    await writeFile(filePath, group, "utf8");
    entries.push({ group, path: filePath });
  }
  const inputPath = path.join(tempRoot, "archive-input.json");
  await writeFile(inputPath, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  await archiveProject({ projectDir, inputPath });
}

async function createExternalResult(tempRoot: string, handoff: { handoffId: string; inputHash: string; claimHash: string }) {
  const videoPath = path.join(tempRoot, "generated.mp4");
  fixtureVideo(videoPath, "green", "1.5");
  const framePaths = ["frame-a.png", "frame-b.png", "frame-c.png"].map((name) => path.join(tempRoot, name));
  fixtureFrame(framePaths[0], "red");
  fixtureFrame(framePaths[1], "blue");
  fixtureFrame(framePaths[2], "yellow");
  const manifestPath = path.join(tempRoot, "minimax-result.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: "1.0.0",
    kind: "minimax-broll-result",
    handoffId: handoff.handoffId,
    inputHash: handoff.inputHash,
    handoffContentHash: handoff.inputHash,
    executionClaimHash: handoff.claimHash,
    video: { path: videoPath, sha256: await sha256File(videoPath) },
    keyframes: framePaths.map((framePath, index) => ({ timeSeconds: index * 0.5, path: framePath, sha256: "" })),
  }, null, 2)}\n`, "utf8");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { keyframes: Array<{ sha256: string }> };
  for (const [index, framePath] of framePaths.entries()) manifest.keyframes[index].sha256 = await sha256File(framePath);
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: "1.0.0",
    kind: "minimax-broll-result",
    handoffId: handoff.handoffId,
    inputHash: handoff.inputHash,
    handoffContentHash: handoff.inputHash,
    executionClaimHash: handoff.claimHash,
    video: { path: videoPath, sha256: await sha256File(videoPath) },
    keyframes: framePaths.map((framePath, index) => ({ timeSeconds: index * 0.5, path: framePath, sha256: manifest.keyframes[index].sha256 })),
  }, null, 2)}\n`, "utf8");
  return { manifestPath, videoPath, framePaths };
}

interface ResultReviewFixtureSource {
  resultContentHash: string;
  content: {
    handoffContentHash: string;
    video: { sha256: string };
    keyframes: Array<{ sha256: string }>;
  };
}

function acceptanceReviewFixture(result: ResultReviewFixtureSource, reviewedAt = "2026-09-27T00:00:00.000Z") {
  return {
    decision: "accept",
    reviewer: "王杰",
    authority: "user",
    resultContentHash: result.resultContentHash,
    handoffContentHash: result.content.handoffContentHash,
    videoSha256: result.content.video.sha256,
    keyframeSha256: result.content.keyframes.map((frame) => frame.sha256),
    reviewedAt,
    notes: null,
    rights: {
      status: "confirmed_for_project_use",
      basis: "测试权利确认",
      confirmedBy: "王杰",
      confirmedAt: reviewedAt,
    },
  };
}

interface RegistrationFixtureHandoff {
  handoffId: string;
  inputHash: string;
  content: {
    slot: { id: string };
    plan: { contentHash: string };
  };
}

function assetRegistrationFixture(
  result: ResultReviewFixtureSource & { handoffId: string },
  handoff: RegistrationFixtureHandoff,
  registeredAt = "2026-09-27T00:00:01.000Z",
) {
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

async function prepareAndApprove(tempRoot: string) {
  const setup = await setupApprovedPlan(tempRoot);
  const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
  const approved = await approveBrollHandoff({
    projectDir: setup.projectDir,
    handoffPath: prepared.handoffPath,
    slotId: setup.slotId,
    reviewer: "王杰",
    authority: "user",
    handoffContentHash: prepared.contentHash,
  });
  const claim = await claimBrollExecution({
    projectDir: setup.projectDir,
    handoffPath: prepared.handoffPath,
    executor: "minimax-broll-generator",
    claimedBy: "test-controlled-executor",
  });
  return { ...setup, ...prepared, approved, ...claim };
}

test("prepares a deterministic, hash-bound handoff and approval for one generated slot", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-prepare-"));
  try {
    const first = await prepareAndApprove(tempRoot);
    const second = await prepareBrollHandoff({ projectDir: first.projectDir, slotId: first.slotId });
    assert.equal(second.handoffId, first.handoffId);
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(second.idempotent, true);
    const handoff = JSON.parse(await readFile(first.handoffPath, "utf8"));
    assert.equal(handoff.content.project.projectId.length > 0, true);
    assert.equal(handoff.content.plan.contentHash.length, 64);
    assert.equal(handoff.content.slot.id, first.slotId);
    assert.equal(handoff.content.generation.promptHash.length, 64);
    assert.equal(handoff.content.generation.payloadHash.length, 64);
    assert.equal(handoff.content.generation.aspectRatio, "16:9");
    assert.equal(handoff.content.referenceAssets.every((asset: { path: string; sha256: string }) => path.isAbsolute(asset.path) && asset.sha256.length === 64), true);
    assert.equal(handoff.approval.handoffContentHash, first.contentHash);
    assert.equal(handoff.approval.slotId, first.slotId);
    assert.equal(handoff.approval.reviewedHandoffSha256.length, 64);
    assert.deepEqual(await validateBrollHandoffs(first.projectDir), { filesChecked: 1, errors: [] });
    const projectValidation = await validateProjectArtifacts(first.projectDir);
    assert.equal(projectValidation.valid, true);

    handoff.preparedAt = "2026-09-28T00:00:00.000Z";
    await writeFile(first.handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
    const tampered = await validateBrollHandoffs(first.projectDir);
    assert.match(tampered.errors.join("\n"), /exact handoff file reviewed/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("public B-roll JSON Schema enforces approval and execution-claim state invariants", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-schema-state-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    const pending = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addFormat("date-time", { type: "string", validate: (value: string) => Number.isFinite(Date.parse(value)) });
    const validate = ajv.compile(contractBundle.$defs.brollHandoff);
    assert.equal(validate(pending), true, JSON.stringify(validate.errors));

    const forgedApproved = structuredClone(pending);
    forgedApproved.status = "approved";
    assert.equal(validate(forgedApproved), false);

    const forgedClaimed = structuredClone(pending);
    forgedClaimed.status = "execution_claimed";
    forgedClaimed.approval = {
      decision: "approve",
      reviewer: "王杰",
      authority: "user",
      slotId: pending.content.slot.id,
      handoffContentHash: pending.contentHash,
      reviewedHandoffSha256: "0".repeat(64),
      approvedAt: "2026-09-27T00:00:00.000Z",
    };
    forgedClaimed.execution = { status: "claimed", attempts: 0 };
    assert.equal(validate(forgedClaimed), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("public B-roll result schema treats acceptance pending registration as a durable review journal only", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-acceptance-schema-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    const pending = JSON.parse(await readFile(imported.resultPath, "utf8"));
    const handoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addFormat("date-time", { type: "string", validate: (value: string) => Number.isFinite(Date.parse(value)) });
    const validate = ajv.compile(contractBundle.$defs.brollResult);

    const acceptancePending = structuredClone(pending);
    acceptancePending.status = "acceptance_pending_registration";
    acceptancePending.review = acceptanceReviewFixture(acceptancePending);
    acceptancePending.assetRegistration = null;
    assert.equal(validate(acceptancePending), true, JSON.stringify(validate.errors));

    const withoutReview = structuredClone(acceptancePending);
    withoutReview.review = null;
    assert.equal(validate(withoutReview), false, "acceptance intent must retain its hash-bound user review");

    const withoutRights = structuredClone(acceptancePending);
    withoutRights.review.rights = null;
    assert.equal(validate(withoutRights), false, "acceptance intent must retain explicit project-use rights");

    const prematurelyRegistered = structuredClone(acceptancePending);
    prematurelyRegistered.assetRegistration = assetRegistrationFixture(prematurelyRegistered, handoff);
    assert.equal(validate(prematurelyRegistered), false, "the journal state must not claim registration before the transaction completes");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI exposes the B-roll prepare, approval, and project validation gates", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-cli-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const preparedProcess = runCli([
      "prepare-broll-handoff", "--project", setup.projectDir, "--slot-id", setup.slotId,
    ]);
    assert.equal(preparedProcess.status, 0, preparedProcess.stderr);
    const prepared = JSON.parse(preparedProcess.stdout);
    assert.equal(prepared.ok, true);
    const approvedProcess = runCli([
      "approve-broll-handoff", "--project", setup.projectDir, "--handoff", prepared.handoffPath,
      "--slot-id", setup.slotId, "--content-hash", prepared.contentHash,
      "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(approvedProcess.status, 0, approvedProcess.stderr);
    const claimedProcess = runCli([
      "claim-broll-execution", "--project", setup.projectDir, "--handoff", prepared.handoffPath,
      "--executor", "minimax-broll-generator", "--claimed-by", "cli-test-executor",
    ]);
    assert.equal(claimedProcess.status, 0, claimedProcess.stderr);
    assert.equal(JSON.parse(claimedProcess.stdout).claimHash.length, 64);
    const validationProcess = runCli(["validate", "--project", setup.projectDir]);
    assert.equal(validationProcess.status, 0, validationProcess.stderr);
    assert.equal(JSON.parse(validationProcess.stdout).ok, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("user approval alone cannot authorize import before a fresh execution claim", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-unclaimed-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const external = await createExternalResult(tempRoot, { ...prepared, claimHash: "0".repeat(64) });
    await assert.rejects(
      () => importBrollResult({ projectDir: setup.projectDir, inputPath: external.manifestPath, handoffPath: prepared.handoffPath }),
      /cannot be imported from handoff status approved/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("concurrent execution claims serialize so only one caller receives paid-request authority", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-concurrent-claim-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const outcomes = await Promise.allSettled([
      claimBrollExecution({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        executor: "minimax-broll-generator",
        claimedBy: "parallel-executor-a",
      }),
      claimBrollExecution({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        executor: "minimax-broll-generator",
        claimedBy: "parallel-executor-b",
      }),
    ]);
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof claimBrollExecution>>> => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0].reason), /owned by another executor or caller/i);
    const stored = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    assert.equal(stored.execution.claim.claimHash, fulfilled[0].value.claimHash);
    assert.equal(fulfilled[0].value.idempotent, false);
    assert.equal(["parallel-executor-a", "parallel-executor-b"].includes(stored.execution.claim.claimedBy), true);
    await assert.rejects(() => readFile(path.join(setup.projectDir, ".video-flow-project-state.lock"), "utf8"), /ENOENT/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("independent CLI processes share one project-level paid-execution gate", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-cross-process-claim-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const base = [
      "claim-broll-execution", "--project", setup.projectDir, "--handoff", prepared.handoffPath,
      "--executor", "minimax-broll-generator",
    ];
    const outcomes = await Promise.all([
      runCliAsync([...base, "--claimed-by", "independent-cli-a"]),
      runCliAsync([...base, "--claimed-by", "independent-cli-b"]),
    ]);
    const succeeded = outcomes.filter((outcome) => outcome.status === 0);
    const failed = outcomes.filter((outcome) => outcome.status !== 0);
    assert.equal(succeeded.length, 1, JSON.stringify(outcomes));
    assert.equal(failed.length, 1, JSON.stringify(outcomes));
    assert.match(failed[0].stderr, /owned by another executor or caller/i);
    const claim = JSON.parse(succeeded[0].stdout);
    const stored = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    assert.equal(stored.execution.claim.claimHash, claim.claimHash);
    assert.equal(["independent-cli-a", "independent-cli-b"].includes(stored.execution.claim.claimedBy), true);
    await assert.rejects(() => readFile(path.join(setup.projectDir, ".video-flow-project-state.lock"), "utf8"), /ENOENT/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("an abandoned project lock fails closed instead of being deleted automatically", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-abandoned-lock-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const lockPath = path.join(setup.projectDir, ".video-flow-project-state.lock");
    const abandoned = {
      token: "abandoned-test-lock",
      pid: 2147483647,
      createdAt: "2026-09-27T00:00:00.000Z",
      operation: "interrupted-paid-execution",
    };
    await writeFile(lockPath, `${JSON.stringify(abandoned)}\n`, "utf8");
    await assert.rejects(
      () => claimBrollExecution({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        executor: "minimax-broll-generator",
        claimedBy: "must-not-run",
      }),
      /requires operator reconciliation|fail-closed/i,
    );
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), abandoned);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plan withdrawal and a separate-process claim share the same project gate", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-withdraw-claim-race-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const [claimOutcome, withdrawalOutcome] = await Promise.all([
      runCliAsync([
        "claim-broll-execution", "--project", setup.projectDir, "--handoff", prepared.handoffPath,
        "--executor", "minimax-broll-generator", "--claimed-by", "separate-paid-executor",
      ]),
      runCliAsync([
        "review-recreation", "--project", setup.projectDir, "--decision", "revise",
        "--reviewer", "王杰", "--authority", "user", "--notes", "撤回方案并阻止尚未开始的付费生成",
      ]),
    ]);
    assert.notEqual(claimOutcome.status === 0 && withdrawalOutcome.status === 0, true, "claim and withdrawal must never both commit");
    if (claimOutcome.status === 0) {
      assert.notEqual(withdrawalOutcome.status, 0);
      assert.match(withdrawalOutcome.stderr, /active.*claim|execution claim|reconcil/i);
      const claim = JSON.parse(claimOutcome.stdout) as { claimHash: string };
      await reconcileBrollExecutionClaim({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        claimHash: claim.claimHash,
        outcome: "confirmed_not_submitted",
        reconciledBy: "Codex",
        authority: "operator",
        reason: "并发测试确认执行器未向供应商提交请求",
      });
      await reviewRecreation({
        projectDir: setup.projectDir,
        decision: "revise",
        reviewer: "王杰",
        authority: "user",
        notes: "claim 收口后撤回方案",
      });
    } else {
      assert.equal(withdrawalOutcome.status, 0, withdrawalOutcome.stderr);
      assert.match(claimOutcome.stderr, /user-approved|approved|stale|needs_revision/i);
    }
    const handoff = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    assert.equal(handoff.status, "stale");
    assert.equal(handoff.execution.status, "not_started");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("an active paid execution claim blocks plan withdrawal until no-submission reconciliation", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-active-claim-withdrawal-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const claim = await claimBrollExecution({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "controlled-paid-executor",
    });

    await assert.rejects(
      () => reviewRecreation({
        projectDir: setup.projectDir,
        decision: "revise",
        reviewer: "王杰",
        authority: "user",
        notes: "先撤回方案",
      }),
      /active.*claim|execution claim|reconcil/i,
    );
    const stillApproved = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    assert.equal(stillApproved.status, "approved");
    const stillClaimed = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    assert.equal(stillClaimed.status, "execution_claimed");
    assert.equal(stillClaimed.execution.claim.claimHash, claim.claimHash);

    await reconcileBrollExecutionClaim({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      claimHash: claim.claimHash,
      outcome: "confirmed_not_submitted",
      reconciledBy: "Codex",
      authority: "operator",
      reason: "已核对受控执行器日志，确认尚未向供应商提交请求",
    });
    const revised = await reviewRecreation({
      projectDir: setup.projectDir,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      notes: "确认未提交付费请求后撤回方案",
    });
    assert.equal(revised.status, "needs_revision");
    const stale = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    assert.equal(stale.status, "stale");
    assert.equal(stale.execution.status, "not_started");
    assert.equal(stale.execution.reconciledClaims.at(-1).claim.claimHash, claim.claimHash);
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 1, errors: [] });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("execution claim rechecks privacy and supports explicit no-submission reconciliation without losing audit history", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-claim-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const projectPath = path.join(setup.projectDir, "project.json");
    const originalProject = await readFile(projectPath, "utf8");
    const privacyChanged = JSON.parse(originalProject);
    privacyChanged.privacy.cloudAllowed = false;
    await writeFile(projectPath, `${JSON.stringify(privacyChanged, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => claimBrollExecution({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        executor: "minimax-broll-generator",
        claimedBy: "controlled-executor",
      }),
      /does not allow external B-roll generation|privacy|drifted/i,
    );
    await writeFile(projectPath, originalProject, "utf8");

    const first = await claimBrollExecution({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "controlled-executor",
    });
    const repeated = await claimBrollExecution({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "controlled-executor",
    });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.claimHash, first.claimHash);
    await assert.rejects(
      () => claimBrollExecution({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        executor: "minimax-broll-generator",
        claimedBy: "parallel-executor",
      }),
      /owned by another executor or caller/i,
    );
    await assert.rejects(
      () => reconcileBrollExecutionClaim({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        claimHash: "f".repeat(64),
        outcome: "confirmed_not_submitted",
        reconciledBy: "Codex",
        authority: "operator",
        reason: "受控执行器在发出请求前退出",
      }),
      /bind the active claimHash/i,
    );
    await reconcileBrollExecutionClaim({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      claimHash: first.claimHash,
      outcome: "confirmed_not_submitted",
      reconciledBy: "Codex",
      authority: "operator",
      reason: "已核对日志，受控执行器在发出请求前退出",
    });
    const second = await claimBrollExecution({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "controlled-executor",
    });
    assert.notEqual(second.claimHash, first.claimHash);
    const handoff = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    assert.equal(handoff.execution.claim.sequence, 2);
    assert.equal(handoff.execution.reconciledClaims[0].claim.claimHash, first.claimHash);
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 1, errors: [] });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("revising a recreation plan makes its approved unexecuted B-roll handoff stale", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-stale-plan-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    await reviewRecreation({
      projectDir: setup.projectDir,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      notes: "替换仿拍方案",
    });
    const handoff = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    assert.equal(handoff.status, "stale");
    assert.equal(handoff.approval.handoffContentHash, prepared.contentHash);
    assert.equal(handoff.staleEvidence.invalidatedPlanContentHash, handoff.content.plan.contentHash);
    await assert.rejects(
      () => claimBrollExecution({
        projectDir: setup.projectDir,
        handoffPath: prepared.handoffPath,
        executor: "minimax-broll-generator",
        claimedBy: "controlled-executor",
      }),
      /requires recreation-plan status approved\/applied|stale/i,
    );
    assert.deepEqual((await validateBrollHandoffs(setup.projectDir)).errors, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plan replacement preserves a rejected B-roll revision chain as non-executable historical evidence", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-stale-revision-chain-"));
  try {
    const base = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, base);
    const imported = await importBrollResult({
      projectDir: base.projectDir,
      inputPath: external.manifestPath,
      handoffPath: base.handoffPath,
    });
    await reviewBrollResult({
      projectDir: base.projectDir,
      handoffPath: base.handoffPath,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
      notes: "动作节奏需要重做",
    });
    const child = await prepareBrollHandoff({
      projectDir: base.projectDir,
      slotId: base.slotId,
      revisionOf: base.handoffId,
      revisionReason: "动作节奏需要重做",
      revisionPrompt: "16:9 写实俯拍桌面，右手缓慢勾选三张无品牌卡片，每次笔尖落下后停顿半秒，动作连续完整。",
    });
    await approveBrollHandoff({
      projectDir: base.projectDir,
      handoffPath: child.handoffPath,
      slotId: base.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: child.contentHash,
    });
    const childClaim = await claimBrollExecution({
      projectDir: base.projectDir,
      handoffPath: child.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "revision-chain-executor",
    });
    await assert.rejects(
      () => reviewRecreation({
        projectDir: base.projectDir,
        decision: "revise",
        reviewer: "王杰",
        authority: "user",
        notes: "整体方案更换",
      }),
      /active.*claim|execution claim|reconcil/i,
    );
    await reconcileBrollExecutionClaim({
      projectDir: base.projectDir,
      handoffPath: child.handoffPath,
      claimHash: childClaim.claimHash,
      outcome: "confirmed_not_submitted",
      reconciledBy: "Codex",
      authority: "operator",
      reason: "已核对日志，修订镜头尚未向供应商提交请求",
    });
    await reviewRecreation({
      projectDir: base.projectDir,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      notes: "整体方案更换",
    });
    const baseRecord = JSON.parse(await readFile(base.handoffPath, "utf8"));
    const childRecord = JSON.parse(await readFile(child.handoffPath, "utf8"));
    assert.equal(baseRecord.status, "stale");
    assert.equal(baseRecord.resultContentHash, imported.resultContentHash);
    assert.equal(childRecord.status, "stale");
    assert.equal(childRecord.content.revision.previousHandoffId, base.handoffId);
    assert.equal(childRecord.execution.status, "not_started");
    assert.equal(childRecord.execution.reconciledClaims.at(-1).claim.claimHash, childClaim.claimHash);
    assert.deepEqual((await validateBrollHandoffs(base.projectDir)).errors, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sensitive projects cannot prepare an external MiniMax B-roll handoff", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-privacy-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.privacy = {
      classification: "sensitive",
      containsSensitiveData: true,
      redacted: false,
      cloudAllowed: false,
      externalProcessingAuthorization: {
        status: "pending",
        authorizedBy: null,
        scope: [],
        verifiedBy: null,
        verifiedAt: null,
        redactionEvidence: null,
      },
    };
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId }),
      /Sensitive projects cannot create a MiniMax B-roll handoff/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("B-roll handoff mutations are closed after final confirmation or archive", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-closed-project-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "final_confirmed";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId }),
      /got final_confirmed/i,
    );
    project.workflowStatus = "archived";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId }),
      /got archived/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("final confirmation waits until every generated B-roll slot has an accepted asset", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-final-gate-"));
  try {
    const base = await setupApprovedPlan(tempRoot);
    await applyApprovedPlan(base.projectDir, tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: base.projectDir, slotId: base.slotId });
    await approveBrollHandoff({
      projectDir: base.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: base.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });
    const claim = await claimBrollExecution({
      projectDir: base.projectDir,
      handoffPath: prepared.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "test-controlled-executor",
    });
    const setup = { ...base, ...prepared, ...claim };
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "internal_review_passed";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const candidatePath = path.join(tempRoot, "final-candidate.mp4");
    await writeFile(candidatePath, "hash-bound-final-candidate", "utf8");
    const candidate = await recordVersion({
      projectDir: setup.projectDir,
      stage: "final_candidate",
      filePath: candidatePath,
      label: "第二稿待确认",
    });
    const reviewPath = path.join(setup.projectDir, "review.json");
    const beforeProject = await readFile(projectPath, "utf8");
    const beforeReview = await readFile(reviewPath, "utf8");

    await assert.rejects(
      () => confirmVersion({
        projectDir: setup.projectDir,
        gate: "final",
        versionId: candidate.versionId,
        decision: "approve",
        reviewer: "王杰",
      }),
      /active.*claim|execution claim|unresolved.*B-roll/i,
    );
    assert.equal(await readFile(projectPath, "utf8"), beforeProject);
    assert.equal(await readFile(reviewPath, "utf8"), beforeReview);

    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
      rightsConfirmed: true,
      rightsBasis: "测试生成素材已获本项目使用授权",
    });
    await confirmVersion({
      projectDir: setup.projectDir,
      gate: "final",
      versionId: candidate.versionId,
      decision: "approve",
      reviewer: "王杰",
    });
    const finalized = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(finalized.workflowStatus, "final_confirmed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("handoffs use one project-local canonical path and forged accepted states fail validation", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-path-state-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const outsidePath = path.join(tempRoot, "outside-handoff.json");
    await assert.rejects(
      () => prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId, outputPath: outsidePath }),
      /unique canonical path/i,
    );
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: prepared.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: prepared.contentHash,
    });

    const approvedBytes = await readFile(prepared.handoffPath, "utf8");
    const forgedOperatorApproval = JSON.parse(approvedBytes);
    forgedOperatorApproval.approval.authority = "operator";
    forgedOperatorApproval.approval.reviewer = "";
    await writeFile(prepared.handoffPath, `${JSON.stringify(forgedOperatorApproval, null, 2)}\n`, "utf8");
    const invalidApproval = await validateBrollHandoffs(setup.projectDir);
    assert.match(invalidApproval.errors.join("\n"), /approval is not bound/i);
    await writeFile(prepared.handoffPath, approvedBytes, "utf8");

    await writeFile(outsidePath, await readFile(prepared.handoffPath));
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    const canonicalRegistrations = [...project.artifacts.brollHandoffs];
    project.artifacts.brollHandoffs.push(path.relative(setup.projectDir, outsidePath));
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => validateProjectArtifacts(setup.projectDir),
      /must stay inside/i,
    );

    project.artifacts.brollHandoffs = canonicalRegistrations;
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const forged = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    forged.status = "accepted";
    forged.approval = null;
    delete forged.resultPath;
    delete forged.resultContentHash;
    await writeFile(prepared.handoffPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
    const semantic = await validateBrollHandoffs(setup.projectDir);
    assert.match(semantic.errors.join("\n"), /lacks user approval evidence/i);
    await assert.rejects(
      () => validateProjectArtifacts(setup.projectDir),
      /lacks user approval evidence/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a forged canonical directory cannot invent another payable handoff identity for the same content", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-forged-id-"));
  try {
    const setup = await setupApprovedPlan(tempRoot);
    const prepared = await prepareBrollHandoff({ projectDir: setup.projectDir, slotId: setup.slotId });
    const forged = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
    forged.handoffId = "BRL-AAAAAAAAAAAAAAAAAAAAAAAA";
    const forgedDir = path.join(setup.projectDir, ".handoff", "broll", forged.handoffId);
    await mkdir(forgedDir, { recursive: true });
    await writeFile(path.join(forgedDir, "broll-handoff.json"), `${JSON.stringify(forged, null, 2)}\n`, "utf8");
    const validation = await validateBrollHandoffs(setup.projectDir);
    assert.match(validation.errors.join("\n"), /handoffId is not deterministic/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("import verifies ffprobe, video hash, and three distinct keyframes; duplicate import is resumable but not replaceable", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-import-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({ projectDir: setup.projectDir, inputPath: external.manifestPath, handoffPath: setup.handoffPath });
    assert.equal(imported.status, "pending_user_review");
    assert.equal(imported.idempotent, false);

    const importedRecord = JSON.parse(await readFile(imported.resultPath, "utf8")) as {
      status: string;
      review: unknown;
      assetRegistration: unknown;
      content: { keyframes: Array<{ path: string; sha256: string }> };
    };
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addFormat("date-time", { type: "string", validate: (value: string) => Number.isFinite(Date.parse(value)) });
    const validateResult = ajv.compile(contractBundle.$defs.brollResult);
    assert.equal(validateResult(importedRecord), true, JSON.stringify(validateResult.errors));
    const forgedRevision = structuredClone(importedRecord);
    forgedRevision.status = "needs_revision";
    assert.equal(validateResult(forgedRevision), false, "needs_revision must include a bound revise review");
    const forgedAcceptance = structuredClone(importedRecord);
    forgedAcceptance.status = "accepted";
    assert.equal(validateResult(forgedAcceptance), false, "accepted must include user review, rights, and asset registration");
    for (const [index, frame] of importedRecord.content.keyframes.entries()) {
      assert.match(path.relative(path.dirname(setup.handoffPath), frame.path).replaceAll("\\", "/"), /^verified-keyframes\//);
      assert.notEqual(frame.sha256, await sha256File(external.framePaths[index]));
    }

    const interruptedHandoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    interruptedHandoff.status = "execution_claimed";
    interruptedHandoff.execution.status = "claimed";
    interruptedHandoff.execution.attempts = 0;
    delete interruptedHandoff.execution.importedAt;
    delete interruptedHandoff.resultPath;
    delete interruptedHandoff.resultContentHash;
    await writeFile(setup.handoffPath, `${JSON.stringify(interruptedHandoff, null, 2)}\n`, "utf8");
    const resumed = await importBrollResult({ projectDir: setup.projectDir, inputPath: external.manifestPath, handoffPath: setup.handoffPath });
    assert.equal(resumed.idempotent, true);
    assert.equal(resumed.resultContentHash, imported.resultContentHash);
    const recoveredHandoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    assert.equal(recoveredHandoff.status, "result_pending_user_review");
    assert.equal(recoveredHandoff.resultContentHash, imported.resultContentHash);
    assert.equal(recoveredHandoff.execution.status, "returned");

    const changedVideo = path.join(tempRoot, "changed.mp4");
    fixtureVideo(changedVideo, "red", "1.5");
    const changedManifest = path.join(tempRoot, "duplicate.json");
    await writeFile(changedManifest, `${JSON.stringify({
      handoffId: setup.handoffId,
      inputHash: setup.inputHash,
      video: { path: changedVideo, sha256: await sha256File(changedVideo) },
      keyframes: external.framePaths.map((framePath, index) => ({ timeSeconds: index * 0.5, path: framePath, sha256: "" })),
    }, null, 2)}\n`, "utf8");
    const changed = JSON.parse(await readFile(changedManifest, "utf8")) as { keyframes: Array<{ sha256: string }> };
    for (const [index, framePath] of external.framePaths.entries()) changed.keyframes[index].sha256 = await sha256File(framePath);
    await writeFile(changedManifest, `${JSON.stringify({
      handoffId: setup.handoffId,
      inputHash: setup.inputHash,
      video: { path: changedVideo, sha256: await sha256File(changedVideo) },
      keyframes: external.framePaths.map((framePath, index) => ({ timeSeconds: index * 0.5, path: framePath, sha256: changed.keyframes[index].sha256 })),
    }, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => importBrollResult({ projectDir: setup.projectDir, inputPath: changedManifest, handoffPath: setup.handoffPath }),
      /different imported result|duplicate generation/i,
    );
    const handoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    assert.equal(handoff.execution.attempts, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("approved prompt or reference bytes drifting after preparation blocks external import", async (context) => {
  for (const target of ["prompt", "reference"] as const) {
    await context.test(target, async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), `video-flow-broll-drift-${target}-`));
      try {
        const setup = await prepareAndApprove(tempRoot);
        const planPath = path.join(setup.projectDir, "recreation-plan.json");
        const plan = JSON.parse(await readFile(planPath, "utf8"));
        if (target === "prompt") {
          plan.editBlueprint[0].brollSlots[0].generation.prompt = "已漂移的提示词";
          await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        } else {
          await writeFile(setup.referencePath, Buffer.from("reference-byte-drift"));
        }
        const external = await createExternalResult(tempRoot, setup);
        await assert.rejects(
          () => importBrollResult({ projectDir: setup.projectDir, inputPath: external.manifestPath, handoffPath: setup.handoffPath }),
          /stale|changed|drifted/i,
        );
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("an explicit canonical result path cannot bypass a missing approved import binding", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-review-binding-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    await applyApprovedPlan(setup.projectDir, tempRoot);
    assert.match((await brollArchiveErrors(setup.projectDir)).join("\n"), /result_pending_user_review/i);
    const handoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    handoff.status = "pending_user_approval";
    handoff.approval = null;
    handoff.execution = { status: "not_started", attempts: 0 };
    delete handoff.resultPath;
    delete handoff.resultContentHash;
    await writeFile(setup.handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => reviewBrollResult({
        projectDir: setup.projectDir,
        handoffPath: setup.handoffPath,
        resultPath: imported.resultPath,
        decision: "accept",
        reviewer: "王杰",
        authority: "user",
        resultContentHash: imported.resultContentHash,
      }),
      /current approved, imported handoff\/result binding/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("idempotent import cannot promote a forged accepted result without hash-bound user review", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-forged-result-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    const result = JSON.parse(await readFile(imported.resultPath, "utf8"));
    result.status = "accepted";
    result.review = null;
    await writeFile(imported.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => importBrollResult({
        projectDir: setup.projectDir,
        inputPath: external.manifestPath,
        handoffPath: setup.handoffPath,
      }),
      /lacks an accept review/i,
    );
    const reviewedAt = "2026-09-27T00:00:00.000Z";
    result.review = {
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: result.resultContentHash,
      handoffContentHash: result.content.handoffContentHash,
      videoSha256: result.content.video.sha256,
      keyframeSha256: result.content.keyframes.map((frame: { sha256: string }) => frame.sha256),
      reviewedAt,
      notes: null,
      rights: {
        status: "confirmed_for_project_use",
        basis: "测试权利确认",
        confirmedBy: "王杰",
        confirmedAt: reviewedAt,
      },
    };
    result.assetRegistration = null;
    await writeFile(imported.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => importBrollResult({
        projectDir: setup.projectDir,
        inputPath: external.manifestPath,
        handoffPath: setup.handoffPath,
      }),
      /lacks (?:its |a structured )asset registration/i,
    );
    const handoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    assert.equal(handoff.status, "result_pending_user_review");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("accepted results with malformed asset registrations never promote their handoff", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-malformed-registration-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    const pending = JSON.parse(await readFile(imported.resultPath, "utf8"));
    const handoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    const accepted = structuredClone(pending);
    accepted.status = "accepted";
    accepted.review = acceptanceReviewFixture(accepted);
    accepted.assetRegistration = assetRegistrationFixture(accepted, handoff);

    const wrongSlot = structuredClone(accepted.assetRegistration);
    wrongSlot.slotId = wrongSlot.slotId === `broll_${"0".repeat(20)}`
      ? `broll_${"1".repeat(20)}`
      : `broll_${"0".repeat(20)}`;
    const wrongResultHash = structuredClone(accepted.assetRegistration);
    wrongResultHash.resultContentHash = "0".repeat(64);
    const variants: Array<{ name: string; registration: unknown; omit?: boolean }> = [
      { name: "missing", registration: undefined, omit: true },
      { name: "empty object", registration: {} },
      { name: "string", registration: "not-a-registration" },
      { name: "wrong slot", registration: wrongSlot },
      { name: "wrong result hash", registration: wrongResultHash },
    ];

    for (const variant of variants) {
      const forged = structuredClone(accepted);
      if (variant.omit) delete forged.assetRegistration;
      else forged.assetRegistration = variant.registration;
      await writeFile(imported.resultPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
      await assert.rejects(
        () => importBrollResult({
          projectDir: setup.projectDir,
          inputPath: external.manifestPath,
          handoffPath: setup.handoffPath,
        }),
        /asset registration|assetRegistration|registered asset|slot|resultContentHash|stale/i,
        variant.name,
      );
      const unchangedHandoff = JSON.parse(await readFile(setup.handoffPath, "utf8"));
      assert.equal(unchangedHandoff.status, "result_pending_user_review", variant.name);
      assert.equal(unchangedHandoff.resultContentHash, imported.resultContentHash, variant.name);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("acceptance intent can resume asset registration but cannot be changed to revise", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-acceptance-resume-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    const acceptancePending = JSON.parse(await readFile(imported.resultPath, "utf8"));
    acceptancePending.status = "acceptance_pending_registration";
    acceptancePending.review = acceptanceReviewFixture(acceptancePending);
    acceptancePending.assetRegistration = null;
    await writeFile(imported.resultPath, `${JSON.stringify(acceptancePending, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => reviewBrollResult({
        projectDir: setup.projectDir,
        handoffPath: setup.handoffPath,
        decision: "revise",
        reviewer: "王杰",
        authority: "user",
        resultContentHash: imported.resultContentHash,
        notes: "不得覆盖已经记录的接受意图",
      }),
      /acceptance was already recorded|registration must be completed|already recorded/i,
    );

    const resumed = await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
      rightsConfirmed: true,
      rightsBasis: "测试权利确认",
    });
    assert.equal(resumed.status, "accepted");
    assert.equal(resumed.idempotent, true);
    const result = JSON.parse(await readFile(imported.resultPath, "utf8"));
    assert.equal(result.status, "accepted");
    assert.equal(result.assetRegistration.slotId, setup.slotId);
    const assets = JSON.parse(await readFile(path.join(setup.projectDir, "assets.json"), "utf8"));
    const asset = assets.assets.find((candidate: { assetId: string }) => candidate.assetId === result.assetRegistration.assetId);
    assert.equal(asset.brollBindings.filter((binding: { handoffId: string }) => binding.handoffId === setup.handoffId).length, 1);
    assert.equal((JSON.parse(await readFile(setup.handoffPath, "utf8")) as { status: string }).status, "accepted");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("acceptance recovery reuses the existing asset binding timestamp without duplication", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-acceptance-assets-recovery-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
      rightsConfirmed: true,
      rightsBasis: "MiniMax 生成内容按当前账户条款确认可用于本项目",
    });
    const accepted = JSON.parse(await readFile(imported.resultPath, "utf8"));
    const originalRegisteredAt = accepted.assetRegistration.registeredAt;
    const assetId = accepted.assetRegistration.assetId;

    accepted.status = "acceptance_pending_registration";
    accepted.assetRegistration = null;
    await writeFile(imported.resultPath, `${JSON.stringify(accepted, null, 2)}\n`, "utf8");
    const recovered = await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
    });
    assert.equal(recovered.status, "accepted");
    assert.equal(recovered.idempotent, true);

    const repeated = await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
    });
    assert.equal(repeated.idempotent, true);
    const result = JSON.parse(await readFile(imported.resultPath, "utf8"));
    assert.equal(result.assetRegistration.registeredAt, originalRegisteredAt);
    const assets = JSON.parse(await readFile(path.join(setup.projectDir, "assets.json"), "utf8"));
    const asset = assets.assets.find((candidate: { assetId: string }) => candidate.assetId === assetId);
    const bindings = asset.brollBindings.filter((binding: { handoffId: string }) => binding.handoffId === setup.handoffId);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].registeredAt, originalRegisteredAt);
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 2, errors: [] });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("result stays pending until user review; accept/revise bind the returned hashes without touching Edit Plan", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-review-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const beforeEditPlan = await readFile(path.join(setup.projectDir, "edit-plan.json"), "utf8");
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({ projectDir: setup.projectDir, inputPath: external.manifestPath, handoffPath: setup.handoffPath });
    assert.equal(imported.status, "pending_user_review");
    const revised = await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
      notes: "关键帧需要重做",
    });
    assert.equal(revised.status, "needs_revision");
    assert.equal(await readFile(path.join(setup.projectDir, "edit-plan.json"), "utf8"), beforeEditPlan);
    const resultPath = path.join(path.dirname(setup.handoffPath), "broll-result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.review.videoSha256.length, 64);
    assert.equal(result.review.keyframeSha256.length >= 3, true);
    assert.equal(result.status, "needs_revision");
    assert.equal((JSON.parse(await readFile(setup.handoffPath, "utf8")) as { status: string }).status, "needs_revision");
    await assert.rejects(
      () => reviewBrollResult({
        projectDir: setup.projectDir,
        handoffPath: setup.handoffPath,
        decision: "accept",
        reviewer: "王杰",
        authority: "user",
        resultContentHash: imported.resultContentHash,
      }),
      /cannot later be accepted unchanged/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a rejected result can create one controlled, newly approved revision handoff without branching", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-revision-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({ projectDir: setup.projectDir, inputPath: external.manifestPath, handoffPath: setup.handoffPath });
    await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
      notes: "动作不够清楚，需要重新生成",
    });

    await assert.rejects(
      () => prepareBrollHandoff({
        projectDir: setup.projectDir,
        slotId: setup.slotId,
        revisionOf: setup.handoffId,
        revisionReason: "动作不够清楚，需要重新生成",
      }),
      /complete revised prompt/i,
    );
    const previousRecord = JSON.parse(await readFile(setup.handoffPath, "utf8"));
    const revisedPrompt = "16:9 写实俯拍桌面，成年人右手从画面右侧进入，依次勾选三张无品牌工作卡片；每次笔尖必须触碰方框后停顿 0.3 秒，三次动作完整可见，镜头固定，不出现 Logo。";

    const revised = await prepareBrollHandoff({
      projectDir: setup.projectDir,
      slotId: setup.slotId,
      revisionOf: setup.handoffId,
      revisionReason: "动作不够清楚，需要重新生成",
      revisionPrompt: revisedPrompt,
    });
    assert.notEqual(revised.handoffId, setup.handoffId);
    assert.equal(revised.status, "pending_user_approval");
    const revisedRecord = JSON.parse(await readFile(revised.handoffPath, "utf8"));
    assert.equal(revisedRecord.content.revision.sequence, 1);
    assert.equal(revisedRecord.content.revision.previousHandoffId, setup.handoffId);
    assert.equal(revisedRecord.content.revision.previousResultContentHash, imported.resultContentHash);
    assert.equal(revisedRecord.content.revision.previousGenerationPayloadHash, previousRecord.content.generation.payloadHash);
    assert.notEqual(revisedRecord.content.generation.promptHash, previousRecord.content.generation.promptHash);
    assert.notEqual(revisedRecord.content.generation.payloadHash, previousRecord.content.generation.payloadHash);

    const repeated = await prepareBrollHandoff({
      projectDir: setup.projectDir,
      slotId: setup.slotId,
      revisionOf: setup.handoffId,
      revisionReason: "动作不够清楚，需要重新生成",
      revisionPrompt: revisedPrompt,
    });
    assert.equal(repeated.handoffId, revised.handoffId);
    assert.equal(repeated.idempotent, true);
    const replacementPrompt = "16:9 写实俯拍桌面，成年人右手握黑色签字笔从画面右侧进入；镜头固定，按从左到右的顺序勾选三张无品牌工作卡片，每次勾选后停顿 0.5 秒，最后手掌离开画面，所有动作完整可见。";
    await assert.rejects(
      () => prepareBrollHandoff({
        projectDir: setup.projectDir,
        slotId: setup.slotId,
        revisionOf: setup.handoffId,
        revisionReason: "换一个不同理由并行重试",
        revisionPrompt: replacementPrompt,
      }),
      /different revision child/i,
    );
    const replacement = await prepareBrollHandoff({
      projectDir: setup.projectDir,
      slotId: setup.slotId,
      revisionOf: setup.handoffId,
      revisionReason: "用户在审批前要求把动作停顿改为半秒",
      revisionPrompt: replacementPrompt,
      supersedePendingRevision: true,
    });
    assert.notEqual(replacement.handoffId, revised.handoffId);
    const superseded = JSON.parse(await readFile(revised.handoffPath, "utf8"));
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.supersession.supersededByHandoffId, replacement.handoffId);
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 4, errors: [] });

    await approveBrollHandoff({
      projectDir: setup.projectDir,
      handoffPath: replacement.handoffPath,
      slotId: setup.slotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: replacement.contentHash,
    });
    const replacementClaim = await claimBrollExecution({
      projectDir: setup.projectDir,
      handoffPath: replacement.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "test-replacement-executor",
    });
    const replacementRoot = await mkdtemp(path.join(tempRoot, "replacement-"));
    const replacementExternal = await createExternalResult(replacementRoot, { ...replacement, claimHash: replacementClaim.claimHash });
    const replacementImported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: replacementExternal.manifestPath,
      handoffPath: replacement.handoffPath,
    });
    await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: replacement.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: replacementImported.resultContentHash,
      rightsConfirmed: true,
      rightsBasis: "MiniMax 生成内容按当前账户条款确认可用于本项目",
    });
    assert.match((await brollArchiveErrors(setup.projectDir)).join("\n"), /not applied to the Edit Plan/i);
    await applyApprovedPlan(setup.projectDir, tempRoot);
    assert.deepEqual(await brollArchiveErrors(setup.projectDir), []);
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 5, errors: [] });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("accepted B-roll is registered as a hash-bound slot asset while the main timeline stays unchanged", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-asset-registration-"));
  try {
    const setup = await prepareAndApprove(tempRoot);
    const editPlanPath = path.join(setup.projectDir, "edit-plan.json");
    const beforeEditPlan = await readFile(editPlanPath, "utf8");
    const external = await createExternalResult(tempRoot, setup);
    const imported = await importBrollResult({
      projectDir: setup.projectDir,
      inputPath: external.manifestPath,
      handoffPath: setup.handoffPath,
    });
    await assert.rejects(
      () => reviewBrollResult({
        projectDir: setup.projectDir,
        handoffPath: setup.handoffPath,
        decision: "accept",
        reviewer: "王杰",
        authority: "user",
        resultContentHash: imported.resultContentHash,
      }),
      /explicit user rights confirmation/i,
    );
    const accepted = await reviewBrollResult({
      projectDir: setup.projectDir,
      handoffPath: setup.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: imported.resultContentHash,
      rightsConfirmed: true,
      rightsBasis: "MiniMax 生成内容按当前账户条款确认可用于本项目",
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(await readFile(editPlanPath, "utf8"), beforeEditPlan);

    const result = JSON.parse(await readFile(imported.resultPath, "utf8"));
    assert.equal(result.assetRegistration.slotId, setup.slotId);
    assert.equal(result.assetRegistration.resultContentHash, imported.resultContentHash);
    const assetsPath = path.join(setup.projectDir, "assets.json");
    const assets = JSON.parse(await readFile(assetsPath, "utf8"));
    const asset = assets.assets.find((item: { assetId: string }) => item.assetId === result.assetRegistration.assetId);
    assert.equal(asset.role, "b-roll");
    assert.equal(asset.sha256, result.content.video.sha256);
    assert.equal(asset.brollBindings.some((binding: { handoffId: string }) => binding.handoffId === setup.handoffId), true);
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 2, errors: [] });
    assert.match((await brollArchiveErrors(setup.projectDir)).join("\n"), /not applied to the Edit Plan/i);
    await applyApprovedPlan(setup.projectDir, tempRoot);
    assert.deepEqual(await brollArchiveErrors(setup.projectDir), []);
    assert.equal((await validateProjectArtifacts(setup.projectDir)).valid, true);

    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "final_confirmed";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 2, errors: [] });
    assert.deepEqual(await brollArchiveErrors(setup.projectDir), []);
    await archiveFixture(setup.projectDir, tempRoot);
    assert.equal((JSON.parse(await readFile(projectPath, "utf8")) as { workflowStatus: string }).workflowStatus, "archived");
    const archiveManifest = JSON.parse(await readFile(path.join(setup.projectDir, "archive-manifest.json"), "utf8"));
    const archivedBroll = archiveManifest.entries.filter((entry: { group: string }) => entry.group === "generated_broll");
    assert.equal(archivedBroll.some((entry: { path: string; sha256: string }) => entry.path === result.content.video.path && entry.sha256 === result.content.video.sha256), true);
    assert.equal(archivedBroll.some((entry: { path: string }) => entry.path === imported.resultPath), true);
    assert.equal(archivedBroll.length >= 7, true);
    assert.deepEqual(await validateBrollHandoffs(setup.projectDir), { filesChecked: 2, errors: [] });

    asset.brollBindings = [];
    await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`, "utf8");
    const stale = await validateBrollHandoffs(setup.projectDir);
    assert.match(stale.errors.join("\n"), /lacks its slot\/result binding/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("B-roll from a replaced recreation plan remains valid historical evidence but cannot satisfy the current plan", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-broll-historical-plan-"));
  try {
    const old = await prepareAndApprove(tempRoot);
    const oldExternal = await createExternalResult(tempRoot, old);
    const oldImported = await importBrollResult({
      projectDir: old.projectDir,
      inputPath: oldExternal.manifestPath,
      handoffPath: old.handoffPath,
    });
    await reviewBrollResult({
      projectDir: old.projectDir,
      handoffPath: old.handoffPath,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: oldImported.resultContentHash,
      notes: "旧方案镜头作废，改用新方案",
    });
    await reviewRecreation({
      projectDir: old.projectDir,
      decision: "revise",
      reviewer: "王杰",
      authority: "user",
      notes: "更换当前仿拍方案",
    });

    const newInput = structuredClone(recreationInput());
    newInput.editBlueprint[0].brollSlots[0].generation.prompt = "16:9 写实侧俯拍，成年人把三张自有方法卡片依次推入画面中央，卡片无品牌标志，动作边界清楚，最后三张卡片整齐排列。";
    const newInputPath = path.join(tempRoot, "new-plan-input.json");
    await writeFile(newInputPath, `${JSON.stringify(newInput, null, 2)}\n`, "utf8");
    await createRecreationPlan({ projectDir: old.projectDir, inputPath: newInputPath });
    await reviewRecreation({ projectDir: old.projectDir, decision: "approve", reviewer: "王杰", authority: "user" });
    const currentPlan = JSON.parse(await readFile(path.join(old.projectDir, "recreation-plan.json"), "utf8"));
    const currentSlotId = currentPlan.editBlueprint[0].brollSlots[0].id;
    await applyApprovedPlan(old.projectDir, tempRoot);

    const historicalValidation = await validateBrollHandoffs(old.projectDir);
    assert.deepEqual(historicalValidation.errors, []);
    const missingCurrent = (await brollArchiveErrors(old.projectDir)).join("\n");
    assert.match(missingCurrent, new RegExp(currentSlotId));
    assert.match(missingCurrent, /no accepted B-roll result/i);
    assert.doesNotMatch(missingCurrent, new RegExp(`${old.handoffId} is needs_revision`));

    const current = await prepareBrollHandoff({ projectDir: old.projectDir, slotId: currentSlotId });
    await approveBrollHandoff({
      projectDir: old.projectDir,
      handoffPath: current.handoffPath,
      slotId: currentSlotId,
      reviewer: "王杰",
      authority: "user",
      handoffContentHash: current.contentHash,
    });
    const currentClaim = await claimBrollExecution({
      projectDir: old.projectDir,
      handoffPath: current.handoffPath,
      executor: "minimax-broll-generator",
      claimedBy: "test-current-plan-executor",
    });
    const currentRoot = await mkdtemp(path.join(tempRoot, "current-plan-"));
    const currentExternal = await createExternalResult(currentRoot, { ...current, claimHash: currentClaim.claimHash });
    const currentImported = await importBrollResult({
      projectDir: old.projectDir,
      inputPath: currentExternal.manifestPath,
      handoffPath: current.handoffPath,
    });
    await reviewBrollResult({
      projectDir: old.projectDir,
      handoffPath: current.handoffPath,
      decision: "accept",
      reviewer: "王杰",
      authority: "user",
      resultContentHash: currentImported.resultContentHash,
      rightsConfirmed: true,
      rightsBasis: "MiniMax 生成内容按当前账户条款确认可用于本项目",
    });
    assert.deepEqual((await validateBrollHandoffs(old.projectDir)).errors, []);
    assert.deepEqual(await brollArchiveErrors(old.projectDir), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
