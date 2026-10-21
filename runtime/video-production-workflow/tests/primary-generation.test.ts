import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initProject } from "../src/project.js";
import { createEditPlan } from "../src/edit-plan.js";
import { readJson, writeJsonAtomic } from "../src/json-store.js";
import { sha256Canonical } from "../src/canonical-json.js";
import { withProjectStateLock } from "../src/project-state-lock.js";
import {
  claimPrimaryGeneration, getPrimaryGeneration, importPrimaryGeneration, preparePrimaryGeneration,
  recordPrimaryFailure, recordPrimaryTask, submitPrimaryGeneration,
  PRIMARY_GENERATION_ENDPOINT, PRIMARY_GENERATION_FILE, PRIMARY_GENERATION_LEDGER_FILE,
  PRIMARY_GENERATION_PRICING_SOURCE, type PrimaryGenerationContract,
} from "../src/primary-generation.js";

async function fixture(durations = [10, 10, 10]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-generation-test-"));
  const projectDir = path.join(root, "project");
  const sourcePath = path.join(root, "source.txt");
  await writeFile(sourcePath, "This fixture never submits a paid request.\n");
  const project = await initProject({ projectDir, sourcePath, title: "Primary video contract", lane: "hybrid", privacy: "public", aspectRatio: "16:9" });
  project.workflowStatus = "plan_ready";
  await writeJsonAtomic(path.join(projectDir, "project.json"), project);
  await writeJsonAtomic(path.join(projectDir, "cut-plan.json"), {
    schemaVersion: "1.0", reviewStatus: "approved", operations: durations.map((duration, index) => ({
      id: `op_${index}`, kind: "speech", decision: "keep", sourceIn: index * 20, sourceOut: index * 20 + duration, transcript: `Original scene ${index}`,
    })),
  });
  await createEditPlan(projectDir);
  const editPlan = await readJson<{ shots: Array<{ id: string }> }>(path.join(projectDir, "edit-plan.json"));
  const request = {
    budgetCapCny: 10,
    authorization: { authorizedBy: "user", evidence: ["我授权在这次完整主场景视频生成中使用不超过10元预算。"], scope: "paid_generation_within_budget" },
    pricing: { sourceUrl: PRIMARY_GENERATION_PRICING_SOURCE, checkedAt: new Date().toISOString(), unitPriceCny: 0.33 },
    jobs: durations.map((duration, index) => ({
      id: `scene_${index}`, shotIds: [editPlan.shots[index].id], endpoint: PRIMARY_GENERATION_ENDPOINT,
      payload: { model: "MiniMax-H3-Max", content: [{ type: "text", text: `A clear original cinematic scene number ${index}` }],
        resolution: "480P", duration, ratio: "16:9", extra: { prompt_expansion_mode: "disabled" }, aigc_watermark: false },
    })),
  };
  const inputPath = path.join(root, "request.json");
  await writeJsonAtomic(inputPath, request);
  return {
    root, projectDir, inputPath, request,
    saveInput: () => writeJsonAtomic(inputPath, request),
    prepare: () => preparePrimaryGeneration({ projectDir, inputPath }),
    cleanup: async () => {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
      assert.ok(relative.startsWith("primary-generation-test-") && !relative.includes(path.sep));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function claimInput(setup: { projectDir: string }, contract: PrimaryGenerationContract, index = 0) {
  return { projectDir: setup.projectDir, jobId: contract.jobs[index].id, contractHash: contract.contractHash, executor: "test-no-network" };
}

function makeVideo(filePath: string, duration = 10, size = "848x480") {
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=navy:s=${size}:r=5`,
    "-t", String(duration), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "-y", filePath],
  { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

test("freeze real plan shots and 3x10 seconds as exactly 990 cents; repeated prepare preserves original contract", async () => {
  const setup = await fixture();
  try {
    const contract = await setup.prepare();
    assert.equal(contract.jobs.reduce((sum, job) => sum + job.maxCostCents, 0), 990);
    assert.equal(contract.budgetCapCents, 1000);
    assert.deepEqual(contract.jobs.map((job) => job.maxCostCents), [330, 330, 330]);
    assert.equal(contract.authorization.scope, "paid_generation_within_budget");
    assert.equal("approvedContractHash" in contract.authorization, false);
    const original = await readFile(path.join(setup.projectDir, PRIMARY_GENERATION_FILE), "utf8");
    assert.deepEqual(await setup.prepare(), contract);
    assert.equal(await readFile(path.join(setup.projectDir, PRIMARY_GENERATION_FILE), "utf8"), original);
    for (let index = 0; index < 3; index += 1) {
      const claimed = await claimPrimaryGeneration(claimInput(setup, contract, index));
      assert.equal(claimed.reservedCents, 330);
      assert.equal(claimed.reservedCny, 3.3);
      assert.deepEqual(claimed.payload, contract.jobs[index].payload);
    }
    const state = await getPrimaryGeneration(setup);
    assert.equal(state.ledger.reservedCents, 990);
    assert.ok(state.ledger.claims.every((claim) => claim.state === "submitting"));
  } finally { await setup.cleanup(); }
});

test("31 seconds exceeds 10 CNY without rounding; a fake lower price cannot bypass the cap", async () => {
  const setup = await fixture([10, 10, 11]);
  try {
    await assert.rejects(setup.prepare(), /exceed.*budget/);
    setup.request.pricing.unitPriceCny = 0.01;
    await setup.saveInput();
    await assert.rejects(setup.prepare(), /fixed 0\.33/);
    setup.request.pricing.unitPriceCny = 0.33;
    setup.request.budgetCapCny = 10.23;
    await setup.saveInput();
    await assert.rejects(setup.prepare(), /cannot exceed 10/);
  } finally { await setup.cleanup(); }
});

test("reject incomplete or unapproved effective payloads, unknown keys, media, price sources and empty user evidence", async () => {
  const setup = await fixture([10]);
  try {
    const original = structuredClone(setup.request);
    const cases: Array<[string, (value: any) => void, RegExp]> = [
      ["unknown payload", (value) => { value.jobs[0].payload.seed = 8; }, /unknown key/],
      ["audio extra", (value) => { value.jobs[0].payload.extra.audio = true; }, /unknown key/],
      ["resolution", (value) => { value.jobs[0].payload.resolution = "1080P"; }, /480P/],
      ["content media", (value) => { value.jobs[0].payload.content[0] = { type: "image", text: "x" }; }, /text-only/],
      ["blank prompt", (value) => { value.jobs[0].payload.content[0].text = " "; }, /non-empty/],
      ["missing watermark", (value) => { delete value.jobs[0].payload.aigc_watermark; }, /requires aigc_watermark/],
      ["enabled expansion", (value) => { value.jobs[0].payload.extra.prompt_expansion_mode = "enabled"; }, /disabled/],
      ["endpoint", (value) => { value.jobs[0].endpoint = "https://api.minimax.io/v2/video_generation"; }, /official MiniMax/],
      ["price source", (value) => { value.pricing.sourceUrl = "https://example.org/price"; }, /official source/],
      ["missing evidence", (value) => { value.authorization.evidence = []; }, /must not be empty/],
      ["blank evidence", (value) => { value.authorization.evidence = [" "]; }, /non-empty/],
      ["hash approval claim", (value) => { value.authorization.approvedContractHash = "fake"; }, /unknown key/],
      ["wrong shot", (value) => { value.jobs[0].shotIds = ["invented-shot"]; }, /missing edit-plan shot/],
      ["short duration", (value) => { value.jobs[0].payload.duration = 4; }, /between 5 and 15/],
    ];
    for (const [label, mutate, expected] of cases) {
      const value = structuredClone(original);
      mutate(value);
      await writeJsonAtomic(setup.inputPath, value);
      await assert.rejects(setup.prepare(), expected, label);
    }
  } finally { await setup.cleanup(); }
});

test("block sensitive/cloud-denied projects and non-planning workflow states", async () => {
  const setup = await fixture([10]);
  try {
    const projectPath = path.join(setup.projectDir, "project.json");
    const original = await readJson<any>(projectPath);
    for (const mutate of [
      (project: any) => { project.privacy.classification = "sensitive"; project.privacy.containsSensitiveData = true; },
      (project: any) => { project.privacy.cloudAllowed = false; },
      (project: any) => { project.privacy.externalProcessingAuthorization.status = "denied"; },
      (project: any) => { project.workflowStatus = "intake"; },
    ]) {
      const project = structuredClone(original);
      mutate(project);
      await writeJsonAtomic(projectPath, project);
      await assert.rejects(setup.prepare(), /Sensitive|privacy policy|requires plan_ready/);
    }
  } finally { await setup.cleanup(); }
});

test("concurrent claims reserve once and all duplicate states remain blocked", async () => {
  const setup = await fixture([10]);
  try {
    const contract = await setup.prepare();
    const results = await Promise.allSettled([claimPrimaryGeneration(claimInput(setup, contract)), claimPrimaryGeneration(claimInput(setup, contract))]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const claim = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof claimPrimaryGeneration>>>).value;
    await recordPrimaryFailure({ ...setup, jobId: claim.jobId, claimHash: claim.claimHash, reason: "HTTP response was lost; billing outcome unknown" });
    const state = await getPrimaryGeneration(setup);
    assert.equal(state.ledger.reservedCents, 330);
    assert.equal(state.ledger.claims[0].state, "unknown");
    await assert.rejects(claimPrimaryGeneration(claimInput(setup, contract)), /already claimed.*unknown/);
    await assert.rejects(recordPrimaryTask({ ...setup, jobId: claim.jobId, claimHash: claim.claimHash, taskId: "retry-task" }), /operator reconciliation/);
    assert.equal((await getPrimaryGeneration(setup)).ledger.reservedCents, 330);
  } finally { await setup.cleanup(); }
});

test("reject contract, payload, project, edit-plan, privacy and ledger tampering before claiming", async () => {
  const cases: Array<[string, (setup: Awaited<ReturnType<typeof fixture>>) => Promise<void>, RegExp]> = [
    ["payload", async (setup) => {
      const file = path.join(setup.projectDir, PRIMARY_GENERATION_FILE);
      const contract = await readJson<any>(file);
      contract.jobs[0].payload.content[0].text = "A changed prompt";
      await writeJsonAtomic(file, contract);
    }, /payload|hash mismatch/],
    ["contract", async (setup) => {
      const file = path.join(setup.projectDir, PRIMARY_GENERATION_FILE);
      const contract = await readJson<any>(file);
      contract.authorization.evidence[0] = "Other authorization";
      await writeJsonAtomic(file, contract);
    }, /contract hash mismatch/],
    ["edit plan", async (setup) => { await appendFile(path.join(setup.projectDir, "edit-plan.json"), "\n"); }, /edit-plan changed/],
    ["privacy", async (setup) => {
      const file = path.join(setup.projectDir, "project.json");
      const project = await readJson<any>(file);
      project.privacy.redacted = true;
      await writeJsonAtomic(file, project);
    }, /privacy changed/],
    ["project", async (setup) => {
      const file = path.join(setup.projectDir, "project.json");
      const project = await readJson<any>(file);
      project.title = "Different project content";
      await writeJsonAtomic(file, project);
    }, /project content changed/],
    ["ledger", async (setup) => {
      const file = path.join(setup.projectDir, PRIMARY_GENERATION_LEDGER_FILE);
      const ledger = await readJson<any>(file);
      ledger.updatedAt = "2026-01-01T00:00:00.000Z";
      await writeJsonAtomic(file, ledger);
    }, /ledger hash mismatch/],
  ];
  for (const [label, mutate, expected] of cases) {
    const setup = await fixture([10]);
    try {
      const contract = await setup.prepare();
      await mutate(setup);
      await assert.rejects(claimPrimaryGeneration(claimInput(setup, contract)), expected, label);
      await assert.rejects(getPrimaryGeneration(setup), expected, label);
    } finally { await setup.cleanup(); }
  }
});

test("timestamp-only asset registration permits remaining jobs; changing input never replaces frozen authorization", async () => {
  const setup = await fixture();
  try {
    const contract = await setup.prepare();
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = await readJson<any>(projectPath);
    project.updatedAt = new Date(Date.now() + 1000).toISOString();
    project.workflowStatus = "visual_direction_ready";
    await writeJsonAtomic(projectPath, project);
    await claimPrimaryGeneration(claimInput(setup, contract));
    setup.request.jobs[1].payload.content[0].text = "A changed authorized request";
    await setup.saveInput();
    await assert.rejects(setup.prepare(), /refusing to overwrite/);
    assert.equal((await getPrimaryGeneration(setup)).contract.contractHash, contract.contractHash);
  } finally { await setup.cleanup(); }
});

test("task ids are bound and idempotent; media import probes actual dimensions/duration and preserves assets", async () => {
  const setup = await fixture([10, 10]);
  try {
    const contract = await setup.prepare();
    const claim = await claimPrimaryGeneration(claimInput(setup, contract));
    const taskInput = { ...setup, jobId: claim.jobId, claimHash: claim.claimHash, taskId: "task_1" };
    await recordPrimaryTask(taskInput);
    assert.deepEqual(await recordPrimaryTask(taskInput), (await getPrimaryGeneration(setup)).ledger.claims[0]);
    await assert.rejects(recordPrimaryTask({ ...taskInput, taskId: "conflicting-task" }), /conflicts/);
    const otherClaim = await claimPrimaryGeneration(claimInput(setup, contract, 1));
    await assert.rejects(recordPrimaryTask({ ...setup, jobId: otherClaim.jobId, claimHash: otherClaim.claimHash, taskId: "task_1" }), /another job/);
    const validPath = path.join(setup.root, "video.mp4");
    const shortPath = path.join(setup.root, "short.mp4");
    const lowPath = path.join(setup.root, "low.mp4");
    makeVideo(validPath);
    makeVideo(shortPath, 9);
    makeVideo(lowPath, 10, "640x360");
    await assert.rejects(importPrimaryGeneration({ ...taskInput, taskId: "wrong-task", videoPath: validPath }), /does not match/);
    await assert.rejects(importPrimaryGeneration({ ...taskInput, videoPath: shortPath }), /duration differs/);
    await assert.rejects(importPrimaryGeneration({ ...taskInput, videoPath: lowPath }), /480P/);
    const assetsBefore = await readFile(path.join(setup.projectDir, "assets.json"), "utf8");
    const receipt = await importPrimaryGeneration({ ...taskInput, videoPath: validPath });
    assert.equal(receipt.probe.video.height, 480);
    assert.equal(receipt.probe.video.width, 848);
    assert.ok(Math.abs(receipt.probe.durationSeconds - 10) < 0.01);
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await importPrimaryGeneration({ ...taskInput, videoPath: validPath }), receipt);
    assert.equal(await readFile(path.join(setup.projectDir, "assets.json"), "utf8"), assetsBefore);
    await assert.rejects(claimPrimaryGeneration(claimInput(setup, contract)), /already claimed.*imported/);
    await appendFile(validPath, "changed-file-content");
    await assert.rejects(importPrimaryGeneration({ ...taskInput, videoPath: validPath }), /imported result changed/);
  } finally { await setup.cleanup(); }
});

test("missing ledger fails closed instead of restoring an empty reservation", async () => {
  const setup = await fixture([10]);
  try {
    const contract = await setup.prepare();
    await claimPrimaryGeneration(claimInput(setup, contract));
    await rm(path.join(setup.projectDir, PRIMARY_GENERATION_LEDGER_FILE));
    await assert.rejects(setup.prepare(), /ENOENT/);
    await assert.rejects(claimPrimaryGeneration(claimInput(setup, contract)), /ENOENT/);
  } finally { await setup.cleanup(); }
});

test("submit callback runs once under the project lock; failure retains full reservation and cannot be retried", async () => {
  const setup = await fixture([10]);
  try {
    const contract = await setup.prepare();
    let calls = 0;
    let callbackEntered!: () => void;
    const entered = new Promise<void>((resolve) => { callbackEntered = resolve; });
    let releaseCallback!: () => void;
    const release = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const submitted = submitPrimaryGeneration(claimInput(setup, contract), async (claim) => {
      calls += 1;
      const current = await getPrimaryGeneration(setup);
      assert.equal(current.ledger.claims[0].claimHash, claim.claimHash);
      assert.equal(current.ledger.claims[0].state, "submitting");
      callbackEntered();
      await release;
      throw new Error("network timeout, provider billing unknown");
    });
    await entered;
    let mutationEntered = false;
    const mutation = withProjectStateLock(setup.projectDir, "concurrent-verified-mutation", async () => {
      mutationEntered = true;
      assert.equal((await getPrimaryGeneration(setup)).ledger.claims[0].state, "unknown");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(mutationEntered, false);
    releaseCallback();
    await assert.rejects(submitted, /network timeout/);
    await mutation;
    assert.equal(calls, 1);
    assert.equal((await getPrimaryGeneration(setup)).ledger.reservedCents, 330);
    await assert.rejects(submitPrimaryGeneration(claimInput(setup, contract), async () => { calls += 1; return "retry"; }), /already claimed/);
    assert.equal(calls, 1);
  } finally { await setup.cleanup(); }
});

test("successful submit records only its returned task and rejects provider-side payload/contract drift", async () => {
  const setup = await fixture([10, 10]);
  try {
    const contract = await setup.prepare();
    const success = await submitPrimaryGeneration(claimInput(setup, contract), async (claim) => {
      assert.equal(claim.endpoint, PRIMARY_GENERATION_ENDPOINT);
      assert.deepEqual(claim.payload, contract.jobs[0].payload);
      return "task-success";
    });
    assert.equal(success.taskId, "task-success");
    assert.equal((await getPrimaryGeneration(setup)).ledger.claims[0].state, "submitted");
    await assert.rejects(submitPrimaryGeneration(claimInput(setup, contract, 1), async () => {
      const projectPath = path.join(setup.projectDir, "project.json");
      const project = await readJson<any>(projectPath);
      project.title = "Illicit callback mutation";
      await writeJsonAtomic(projectPath, project);
      return "task-might-have-billed";
    }), /project content changed/);
    const ledger = await readJson<any>(path.join(setup.projectDir, PRIMARY_GENERATION_LEDGER_FILE));
    assert.equal(ledger.claims[1].state, "unknown");
    assert.equal(ledger.reservedCents, 660);
    const { ledgerHash, ...body } = ledger;
    assert.equal(ledgerHash, sha256Canonical(body));
  } finally { await setup.cleanup(); }
});
