import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function prepareRoutedProject(tempRoot: string) {
  const projectDir = path.join(tempRoot, "project");
  const init = runCli([
    "init",
    "--project",
    projectDir,
    "--title",
    "工作台软件演示",
    "--lane",
    "product-demo",
    "--source",
    path.join(tempRoot, "screen-recording.mp4"),
    "--priority",
    "flagship",
  ]);
  assert.equal(init.status, 0, init.stderr);

  const projectPath = path.join(projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "plan_ready";
  project.brief = {
    audience: "独立创作者",
    objective: "理解工作台如何统一管理视频项目",
    brandRules: "深色界面，蓝紫强调色，一屏一个视觉中心",
  };
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

  await writeFile(
    path.join(projectDir, "edit-plan.json"),
    `${JSON.stringify(
      {
        schemaVersion: "1.0.0",
        cutPlanHash: null,
        reviewStatus: "ready",
        shots: [
          {
            id: "hero",
            semanticIntent: "让观众理解工作台是控制中枢",
            visualRole: "product-ui",
            voiceover: "所有视频工具，都从同一个项目入口调度。",
            protectedRegions: ["bottom-captions"],
          },
          {
            id: "unused",
            semanticIntent: "不应发送给 Kimi",
            visualRole: "a-roll",
            voiceover: "隐藏内容",
            protectedRegions: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const route = runCli([
    "route-visual",
    "--project",
    projectDir,
    "--critical",
    "2",
    "--abstract",
    "1",
    "--information",
    "1",
    "--brand",
    "2",
    "--asset-gap",
    "1",
    "--selected-shots",
    "hero",
  ]);
  assert.equal(route.status, 0, route.stderr);
  return projectDir;
}

async function writeReviewFrames(tempRoot: string) {
  const frames: string[] = [];
  for (let index = 1; index <= 6; index += 1) {
    const framePath = path.join(tempRoot, `hero-${String(index).padStart(2, "0")}.png`);
    await writeFile(framePath, `frame-${index}`, "utf8");
    frames.push(framePath);
  }
  return frames;
}

async function writeFailureEvidence(
  projectDir: string,
  attempt: "initial" | "retry",
  content: string,
  startedAt: string,
  endedAt: string,
  launcherExitStatus: number,
  sessionId?: string,
) {
  const rawReportPath = path.join(projectDir, `kimi-raw-report-${attempt}.txt`);
  await writeFile(rawReportPath, `${content}\n`, "utf8");
  return [
    "--started-at", startedAt,
    "--ended-at", endedAt,
    "--launcher-exit-status", String(launcherExitStatus),
    "--raw-report", rawReportPath,
    ...(sessionId ? ["--session", sessionId] : []),
  ];
}

test("prepare-kimi writes a bounded advice-only task packet", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-packet-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    await writeFile(path.join(projectDir, ".prepare-kimi.lock"), `${JSON.stringify({
      pid: 2147483647,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`, "utf8");
    const result = runCli([
      "prepare-kimi",
      "--project",
      projectDir,
      "--output",
      outputPath,
      "--frames",
      frames.join(","),
    ]);
    assert.equal(result.status, 0, result.stderr);

    const packet = await readFile(path.join(projectDir, "kimi-task-packet.txt"), "utf8");
    assert.match(packet, /Task ID: KIMI-VISUAL-/);
    assert.match(packet, /Allowed files:/);
    assert.match(packet, /incoming-kimi-review\.json/);
    assert.match(packet, /Forbidden files\/areas:/);
    assert.match(packet, /hero-01\.png/);
    assert.match(packet, /所有视频工具，都从同一个项目入口调度/);
    assert.doesNotMatch(packet, /隐藏内容/);
    assert.match(packet, /Do not modify script, facts, timeline, or brand constraints/i);

    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.equal(direction.status, "prepared");
    assert.match(direction.inputHash, /^[a-f0-9]{64}$/);
    assert.equal(direction.outputPath, outputPath);
    assert.equal(direction.callNumber, 1);
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routing.callsUsed, 1);

    const duplicate = runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    const routingAfterDuplicate = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routingAfterDuplicate.callsUsed, 1);

    const changedOutput = runCli([
      "prepare-kimi", "--project", projectDir,
      "--output", path.join(projectDir, "incoming-kimi-review-changed.json"),
      "--frames", frames.join(","),
    ]);
    assert.notEqual(changedOutput.status, 0);
    const directionAfterChangedOutput = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.equal(directionAfterChangedOutput.outputPath, outputPath);
    assert.equal(directionAfterChangedOutput.packetSha256, direction.packetSha256);

    await writeFile(direction.packetPath, "Allowed files: everything\nForbidden files/areas: none\n", "utf8");
    const repaired = runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]);
    assert.equal(repaired.status, 0, repaired.stderr);
    const repairedPacket = await readFile(direction.packetPath, "utf8");
    assert.match(repairedPacket, /Forbidden files\/areas: Do not modify source media/);
    assert.doesNotMatch(repairedPacket, /Forbidden files\/areas: none/);
    const repairedDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.equal(
      repairedDirection.packetSha256,
      createHash("sha256").update(repairedPacket, "utf8").digest("hex"),
    );
    const routingAfterRepair = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routingAfterRepair.callsUsed, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Kimi mutations respect the neutral project-state lock before changing review state", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-project-lock-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    const prepared = runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    await writeFile(outputPath, `${JSON.stringify({
      sessionId: "locked-review-session",
      inputHash: direction.inputHash,
      suggestions: [{ shotId: "hero", why: "Improve hierarchy" }],
      constraintConfirmation: {
        scriptUnchanged: true,
        factsUnchanged: true,
        timelineUnchanged: true,
        brandConstraintsPreserved: true,
      },
    }, null, 2)}\n`, "utf8");
    const imported = runCli(["import-kimi-review", "--project", projectDir, "--input", outputPath]);
    assert.equal(imported.status, 0, imported.stderr);

    const decisionsPath = path.join(tempRoot, "locked-decisions.json");
    await writeFile(decisionsPath, `${JSON.stringify({
      reviewer: "Codex",
      decisions: [{ shotId: "hero", decision: "accept", rationale: "Approved under the lock test" }],
    }, null, 2)}\n`, "utf8");
    const projectLockPath = path.join(projectDir, ".video-flow-project-state.lock");
    await writeFile(projectLockPath, `${JSON.stringify({
      token: "independent-live-owner",
      pid: process.pid,
      operation: "independent-project-mutation",
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");

    const blocked = runCli(["decide-kimi-review", "--project", projectDir, "--input", decisionsPath]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Project state is busy or requires operator reconciliation/i);
    const unchanged = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.equal(unchanged.status, "received");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("record-kimi-failure authorizes one retry of the same prepared packet without consuming another call", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-failure-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    const prepared = runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);

    await writeFile(outputPath, "{}\n", "utf8");
    const rejectedImport = runCli(["import-kimi-review", "--project", projectDir, "--input", outputPath]);
    assert.notEqual(rejectedImport.status, 0);
    const rawReportPath = path.join(projectDir, "kimi-raw-report-initial.txt");
    await writeFile(rawReportPath, "Kimi exited successfully but returned an invalid review schema.\n", "utf8");

    const recorded = runCli([
      "record-kimi-failure",
      "--project", projectDir,
      "--attempt", "initial",
      "--reason", "invalid_output",
      "--detail", "import-kimi-review rejected the returned schema",
      "--started-at", "2026-08-10T01:00:00.000Z",
      "--ended-at", "2026-08-10T01:00:05.000Z",
      "--launcher-exit-status", "0",
      "--raw-report", rawReportPath,
      "--session", "session-failure-evidence",
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(recorded.stdout), {
      ok: true,
      status: "prepared",
      nextAction: "retry_same_packet",
      retriesRemaining: 1,
    });

    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(direction.status, "prepared");
    assert.equal(direction.retryState, "authorized");
    assert.equal(direction.failureHistory.length, 1);
    assert.equal(direction.failureHistory[0].attempt, "initial");
    assert.equal(direction.failureHistory[0].packetSha256, direction.packetSha256);
    assert.equal(direction.failureHistory[0].elapsedMs, 5000);
    assert.equal(direction.failureHistory[0].launcherExitStatus, 0);
    assert.equal(direction.failureHistory[0].sessionId, "session-failure-evidence");
    assert.match(direction.failureHistory[0].rawReportSha256, /^[a-f0-9]{64}$/);
    assert.match(direction.failureHistory[0].outputSha256, /^[a-f0-9]{64}$/);
    assert.equal(routing.callsUsed, 1);

    const reroute = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "0", "--abstract", "0", "--information", "0", "--brand", "0", "--asset-gap", "0",
      "--selected-shots", "hero",
    ]);
    assert.notEqual(reroute.status, 0);
    assert.match(reroute.stderr, /prepared Kimi handoff/);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "plan_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Kimi retry is rejected when a hash-bound review frame changes after the initial failure", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-retry-drift-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    assert.equal(runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]).status, 0);
    const initialEvidence = await writeFailureEvidence(
      projectDir, "initial", "Initial invalid result.",
      "2026-08-10T01:10:00.000Z", "2026-08-10T01:10:02.000Z", 0,
    );
    assert.equal(runCli([
      "record-kimi-failure", "--project", projectDir, "--attempt", "initial",
      "--reason", "invalid_output", "--detail", "invalid initial result", ...initialEvidence,
    ]).status, 0);

    await writeFile(frames[0], "changed-after-authorization", "utf8");
    const retryEvidence = await writeFailureEvidence(
      projectDir, "retry", "Retry must not be accepted after input drift.",
      "2026-08-10T01:11:00.000Z", "2026-08-10T01:11:02.000Z", 1,
    );
    const retry = runCli([
      "record-kimi-failure", "--project", projectDir, "--attempt", "retry",
      "--reason", "unavailable", "--detail", "input drift should block retry", ...retryEvidence,
    ]);
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /handoff frame changed/);
    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.equal(direction.status, "prepared");
    assert.equal(direction.failureHistory.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("import-kimi-review rejects a valid response when the prepared handoff frames have drifted", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-import-drift-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    assert.equal(runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]).status, 0);
    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    await writeFile(frames[0], "drifted-before-valid-import", "utf8");
    await writeFile(outputPath, `${JSON.stringify({
      sessionId: "session-valid-but-stale",
      inputHash: direction.inputHash,
      suggestions: [{ shotId: "hero", composition: "valid shape but stale inputs" }],
      constraintConfirmation: {
        scriptUnchanged: true,
        factsUnchanged: true,
        timelineUnchanged: true,
        brandConstraintsPreserved: true,
      },
    }, null, 2)}\n`, "utf8");
    const imported = runCli(["import-kimi-review", "--project", projectDir, "--input", outputPath]);
    assert.notEqual(imported.status, 0);
    assert.match(imported.stderr, /handoff frame changed/);
    const staleDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(staleDirection.status, "stale");
    assert.equal(staleDirection.staleReason, "handoff_evidence_changed");
    assert.equal(project.workflowStatus, "plan_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a failed Kimi retry enters pending Codex fallback and cannot be retried a third time", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-fallback-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    const prepared = runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const initialEvidence = await writeFailureEvidence(
      projectDir, "initial", "Initial response failed schema validation.",
      "2026-08-10T02:00:00.000Z", "2026-08-10T02:00:02.000Z", 0, "session-fallback",
    );
    const initial = runCli([
      "record-kimi-failure", "--project", projectDir, "--attempt", "initial",
      "--reason", "invalid_output", "--detail", "returned JSON did not satisfy the review contract",
      ...initialEvidence,
    ]);
    assert.equal(initial.status, 0, initial.stderr);

    const retryEvidence = await writeFailureEvidence(
      projectDir, "retry", "Controlled retry returned no usable result.",
      "2026-08-10T02:01:00.000Z", "2026-08-10T02:01:03.000Z", 1, "session-fallback",
    );
    const retry = runCli([
      "record-kimi-failure", "--project", projectDir, "--attempt", "retry",
      "--reason", "unavailable", "--detail", "controlled retry returned no usable result",
      ...retryEvidence,
    ]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout), {
      ok: true,
      status: "fallback_codex_pending",
      nextAction: "record_codex_fallback",
      retriesRemaining: 0,
    });

    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(direction.status, "fallback_codex_pending");
    assert.equal(direction.retryState, "exhausted");
    assert.equal(direction.failureHistory.length, 2);
    assert.equal(direction.failureHistory[1].attempt, "retry");
    assert.equal(direction.failureHistory[1].packetSha256, direction.packetSha256);
    assert.equal(routing.callsUsed, 1);
    assert.equal(routing.fallback.target, "codex");
    assert.equal(routing.fallback.status, "pending");
    assert.equal(routing.fallback.failureCount, 2);
    assert.equal(project.workflowStatus, "plan_ready");

    const reroute = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "0", "--abstract", "0", "--information", "0", "--brand", "0", "--asset-gap", "0",
      "--selected-shots", "hero",
    ]);
    assert.notEqual(reroute.status, 0);
    assert.match(reroute.stderr, /fallback_codex_pending/);
    const routingAfterReroute = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routingAfterReroute.fallback.status, "pending");

    const thirdAttempt = runCli([
      "record-kimi-failure", "--project", projectDir, "--attempt", "retry",
      "--reason", "unavailable", "--detail", "must not be accepted",
      ...retryEvidence,
    ]);
    assert.notEqual(thirdAttempt.status, 0);
    assert.match(thirdAttempt.stderr, /fallback_codex_pending/);

    const prepareAgain = runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]);
    assert.notEqual(prepareAgain.status, 0);
    assert.match(prepareAgain.stderr, /pending Codex fallback/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Codex fallback completes the visual gate only with a hash-bound direction for every selected shot", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-codex-fallback-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    assert.equal(runCli([
      "prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", frames.join(","),
    ]).status, 0);
    const initialEvidence = await writeFailureEvidence(
      projectDir, "initial", "Initial launcher timeout.",
      "2026-08-10T03:00:00.000Z", "2026-08-10T03:02:00.000Z", 7,
    );
    assert.equal(runCli([
      "record-kimi-failure", "--project", projectDir, "--attempt", "initial",
      "--reason", "timeout", "--detail", "initial external attempt timed out",
      ...initialEvidence,
    ]).status, 0);
    const retryEvidence = await writeFailureEvidence(
      projectDir, "retry", "Retry returned malformed JSON.",
      "2026-08-10T03:03:00.000Z", "2026-08-10T03:03:04.000Z", 0,
    );
    assert.equal(runCli([
      "record-kimi-failure", "--project", projectDir, "--attempt", "retry",
      "--reason", "invalid_output", "--detail", "retry returned malformed JSON",
      ...retryEvidence,
    ]).status, 0);

    const fallbackPath = path.join(projectDir, "codex-visual-fallback.json");
    await writeFile(fallbackPath, `${JSON.stringify({
      reviewer: "Codex",
      rationale: "External visual direction remained unusable after the only retry.",
      shotDirections: [{
        shotId: "hero",
        composition: "Real Workbench panel on the left; responsibility chain on the right.",
        hierarchy: "Evidence, score, advisory Kimi node, final Codex decision node.",
        palette: "Use only the project brand tokens.",
        motion: {
          entry: "Establish the evidence panel.",
          development: "Reveal score and advisory node in semantic order.",
          conclusion: "Land on the Codex responsibility node and hold.",
        },
        timingAnchors: ["visual scoring explanation"],
        acceptanceFrames: ["evidence established", "advice is subordinate", "Codex is the endpoint"],
      }],
      constraintConfirmation: {
        scriptUnchanged: true,
        factsUnchanged: true,
        timelineUnchanged: true,
        brandConstraintsPreserved: true,
      },
    }, null, 2)}\n`, "utf8");

    const editPlanPath = path.join(projectDir, "edit-plan.json");
    const originalEditPlan = await readFile(editPlanPath, "utf8");
    await writeFile(editPlanPath, `${originalEditPlan.trimEnd()} \n`, "utf8");
    const stale = runCli([
      "complete-kimi-fallback", "--project", projectDir, "--input", fallbackPath,
    ]);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /Edit Plan changed/);
    const staleProject = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(staleProject.workflowStatus, "plan_ready");
    await writeFile(editPlanPath, originalEditPlan, "utf8");

    const completed = runCli([
      "complete-kimi-fallback", "--project", projectDir, "--input", fallbackPath,
    ]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(JSON.parse(completed.stdout), {
      ok: true,
      status: "fallback_codex_completed",
      shots: 1,
    });

    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(direction.status, "fallback_codex_completed");
    assert.match(direction.codexFallback.inputSha256, /^[a-f0-9]{64}$/);
    assert.equal(direction.codexFallback.shotDirections[0].shotId, "hero");
    assert.equal(routing.fallback.status, "completed");
    assert.equal(project.workflowStatus, "visual_direction_ready");
    const validation = runCli(["validate", "--project", projectDir]);
    assert.equal(validation.status, 0, validation.stderr);

    routing.fallback.status = "pending";
    await writeFile(path.join(projectDir, "visual-routing.json"), `${JSON.stringify(routing, null, 2)}\n`, "utf8");
    project.workflowStatus = "plan_ready";
    await writeFile(path.join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const repeated = runCli([
      "complete-kimi-fallback", "--project", projectDir, "--input", fallbackPath,
    ]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), {
      ok: true,
      status: "fallback_codex_completed",
      shots: 1,
    });
    const recoveredRouting = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const recoveredProject = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(recoveredRouting.fallback.status, "completed");
    assert.equal(recoveredProject.workflowStatus, "visual_direction_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("flagship second call must resume the original Kimi session and keeps the draft gate", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-continuation-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const incomingPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    const first = runCli(["prepare-kimi", "--project", projectDir, "--output", incomingPath, "--frames", frames.join(",")]);
    assert.equal(first.status, 0, first.stderr);
    const firstDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    await writeFile(incomingPath, `${JSON.stringify({
      sessionId: "session-original",
      inputHash: firstDirection.inputHash,
      suggestions: [{ shotId: "hero", why: "first" }],
      constraintConfirmation: {
        scriptUnchanged: true,
        factsUnchanged: true,
        timelineUnchanged: true,
        brandConstraintsPreserved: true,
      },
    })}\n`, "utf8");
    const imported = runCli(["import-kimi-review", "--project", projectDir, "--input", incomingPath]);
    assert.equal(imported.status, 0, imported.stderr);

    const secondFrames: string[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const framePath = path.join(tempRoot, `second-${index}.png`);
      await writeFile(framePath, `second-frame-${index}`, "utf8");
      secondFrames.push(framePath);
    }
    const withoutSession = runCli([
      "prepare-kimi", "--project", projectDir, "--output", incomingPath, "--frames", secondFrames.join(","),
    ]);
    assert.equal(withoutSession.status, 1);
    assert.match(withoutSession.stderr, /resume the previous sessionId/i);

    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "draft1_pending_user";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const second = runCli([
      "prepare-kimi", "--project", projectDir, "--output", incomingPath, "--frames", secondFrames.join(","),
      "--session", "session-original",
    ]);
    assert.equal(second.status, 0, second.stderr);
    const secondDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(secondDirection.expectedSessionId, "session-original");
    assert.equal(secondDirection.callNumber, 2);
    assert.equal(secondDirection.priorReviews.length, 1);
    assert.equal(routing.callsUsed, 2);

    await writeFile(incomingPath, `${JSON.stringify({
      sessionId: "different-session",
      inputHash: secondDirection.inputHash,
      suggestions: [{ shotId: "hero", why: "second" }],
      constraintConfirmation: {
        scriptUnchanged: true,
        factsUnchanged: true,
        timelineUnchanged: true,
        brandConstraintsPreserved: true,
      },
    })}\n`, "utf8");
    const wrongSession = runCli(["import-kimi-review", "--project", projectDir, "--input", incomingPath]);
    assert.equal(wrongSession.status, 1);
    assert.match(wrongSession.stderr, /different sessionId/i);

    const corrected = JSON.parse(await readFile(incomingPath, "utf8"));
    corrected.sessionId = "session-original";
    await writeFile(incomingPath, `${JSON.stringify(corrected, null, 2)}\n`, "utf8");
    const accepted = runCli(["import-kimi-review", "--project", projectDir, "--input", incomingPath]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const projectAfter = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(projectAfter.workflowStatus, "draft1_pending_user");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("import-kimi-review validates constraints and advances the visual gate", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-import-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const incomingPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    const prepare = runCli(["prepare-kimi", "--project", projectDir, "--output", incomingPath, "--frames", frames.join(",")]);
    assert.equal(prepare.status, 0, prepare.stderr);
    const preparedDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));

    await writeFile(
      incomingPath,
      `${JSON.stringify(
        {
          sessionId: "kimi-session-001",
          inputHash: preparedDirection.inputHash,
          suggestions: [
            {
              shotId: "hero",
              why: "核心中枢需要先建立单一视觉中心",
              composition: "中央工作台卡片，左右工具节点向中心收束",
              hierarchy: "标题 > 工作台 > 外部工具",
              palette: "沿用深色底与蓝紫强调色",
              motion: {
                entry: "工具节点轻微浮入",
                development: "连线依次汇聚",
                conclusion: "工作台卡片稳定停留",
              },
              timingAnchors: ["所有视频工具", "同一个项目入口"],
              assets: ["工作台真实截图"],
              risks: ["节点过多会稀释主视觉"],
              acceptanceFrames: ["工具尚未汇聚", "汇聚过程", "结论停留"],
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
      )}\n`,
      "utf8",
    );

    const result = runCli([
      "import-kimi-review",
      "--project",
      projectDir,
      "--input",
      incomingPath,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(direction.status, "received");
    assert.equal(direction.sessionId, "kimi-session-001");
    assert.equal(direction.suggestions[0].shotId, "hero");
    assert.equal(routing.callsUsed, 1);
    assert.equal(project.workflowStatus, "visual_direction_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("import-kimi-review rejects a response that changes protected decisions", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-reject-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const incomingPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    const prepare = runCli(["prepare-kimi", "--project", projectDir, "--output", incomingPath, "--frames", frames.join(",")]);
    assert.equal(prepare.status, 0, prepare.stderr);
    const preparedDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    await writeFile(
      incomingPath,
      `${JSON.stringify({
        sessionId: "unsafe",
        inputHash: preparedDirection.inputHash,
        suggestions: [{ shotId: "hero" }],
        constraintConfirmation: {
          scriptUnchanged: false,
          factsUnchanged: true,
          timelineUnchanged: true,
          brandConstraintsPreserved: true,
        },
      })}\n`,
      "utf8",
    );

    const result = runCli(["import-kimi-review", "--project", projectDir, "--input", incomingPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /protected constraints/i);

    await writeFile(incomingPath, `${JSON.stringify({
      sessionId: "wrong-keys",
      inputHash: preparedDirection.inputHash,
      suggestions: [{ shotId: "hero" }],
      constraintConfirmation: { a: true, b: true, c: true, d: true },
    })}\n`, "utf8");
    const wrongKeys = runCli(["import-kimi-review", "--project", projectDir, "--input", incomingPath]);
    assert.equal(wrongKeys.status, 1);
    assert.match(wrongKeys.stderr, /protected constraints/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-kimi refuses protected contracts and non-dedicated output paths", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-output-boundary-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const frames = await writeReviewFrames(tempRoot);
    const protectedOutput = runCli([
      "prepare-kimi", "--project", projectDir, "--output", path.join(projectDir, "project.json"),
      "--frames", frames.join(","),
    ]);
    assert.equal(protectedOutput.status, 1);
    assert.match(protectedOutput.stderr, /dedicated incoming-kimi-review/i);
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routing.callsUsed, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-kimi requires 6-12 existing review frames and hashes their content", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-frames-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const outputPath = path.join(projectDir, "incoming-kimi-review.json");
    const framePath = path.join(tempRoot, "one.png");
    await writeFile(framePath, "one", "utf8");
    const result = runCli(["prepare-kimi", "--project", projectDir, "--output", outputPath, "--frames", framePath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /6 to 12/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-kimi rejects different frame paths with duplicate content", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-duplicate-frames-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const frames: string[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const framePath = path.join(tempRoot, `duplicate-${index}.png`);
      await writeFile(framePath, "same-frame-content", "utf8");
      frames.push(framePath);
    }
    const result = runCli([
      "prepare-kimi", "--project", projectDir, "--output", path.join(projectDir, "incoming-kimi-review-duplicate.json"), "--frames", frames.join(","),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unique content/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sensitive Kimi handoff accepts only hash-bound redacted files in an isolated bundle", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-sensitive-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const sourcePath = path.join(tempRoot, "sensitive-source.txt");
    await writeFile(sourcePath, "客户张三 保单号 123456", "utf8");
    const init = runCli([
      "init", "--project", projectDir, "--title", "敏感保险项目", "--lane", "speech",
      "--source", sourcePath, "--privacy", "sensitive",
    ]);
    assert.equal(init.status, 0, init.stderr);
    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "plan_ready";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    await writeFile(path.join(projectDir, "assets.json"), `${JSON.stringify({
      schemaVersion: "1.0.0",
      assets: [{ assetId: "asset_sensitive", path: sourcePath, sha256: sourceSha256, role: "a-roll" }],
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(projectDir, "edit-plan.json"), `${JSON.stringify({
      shots: [{ id: "hero", voiceover: "原始计划只在本地保留" }],
    }, null, 2)}\n`, "utf8");
    const redactedPlanPath = path.join(tempRoot, "edit-plan.redacted.json");
    await writeFile(redactedPlanPath, `${JSON.stringify({
      shots: [{ id: "hero", voiceover: "保险信息已脱敏" }],
    }, null, 2)}\n`, "utf8");
    const approvedFrames: string[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const framePath = path.join(tempRoot, `approved-${index}.png`);
      await writeFile(framePath, `approved-redacted-frame-${index}`, "utf8");
      approvedFrames.push(framePath);
    }
    const privacyInput = path.join(tempRoot, "privacy-review.json");
    await writeFile(privacyInput, `${JSON.stringify({
      authorizationStatus: "authorized",
      authorizedBy: "data-owner",
      scope: ["kimi_visual_direction"],
      verifiedBy: "Codex",
      redaction: {
        performedBy: "operator",
        reviewedBy: "Codex",
        sourceAssetId: "asset_sensitive",
        approvedOutputs: [
          { kind: "edit_plan", path: redactedPlanPath },
          ...approvedFrames.map((framePath) => ({ kind: "frame", path: framePath })),
        ],
      },
    }, null, 2)}\n`, "utf8");
    const privacy = runCli(["record-privacy-review", "--project", projectDir, "--input", privacyInput]);
    assert.equal(privacy.status, 0, privacy.stderr);
    const route = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "2", "--abstract", "2", "--information", "2", "--brand", "1", "--asset-gap", "1",
      "--selected-shots", "hero",
    ]);
    assert.equal(route.status, 0, route.stderr);

    const unapprovedFrame = path.join(tempRoot, "unapproved.png");
    await writeFile(unapprovedFrame, "not reviewed", "utf8");
    const rejected = runCli([
      "prepare-kimi", "--project", projectDir, "--output", path.join(tempRoot, "incoming-kimi-review-sensitive.json"),
      "--frames", [...approvedFrames.slice(0, 5), unapprovedFrame].join(","),
    ]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /not an approved redacted output/i);

    const prepared = runCli([
      "prepare-kimi", "--project", projectDir, "--output", path.join(tempRoot, "incoming-kimi-review-sensitive.json"),
      "--frames", approvedFrames.join(","),
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.match(direction.packetPath.replaceAll("\\", "/"), /\.handoff\/kimi\/redacted-/);
    assert.equal(path.dirname(direction.outputPath), path.dirname(direction.packetPath));
    const packet = await readFile(direction.packetPath, "utf8");
    assert.match(packet, /redacted-sensitive-project/);
    assert.match(packet, /保险信息已脱敏/);
    assert.doesNotMatch(packet, /客户张三|保单号 123456|原始计划只在本地保留/);

    await writeFile(direction.outputPath, `${JSON.stringify({
      sessionId: "sensitive-session",
      inputHash: direction.inputHash,
      suggestions: [{ shotId: "hero", why: "redacted" }],
      constraintConfirmation: {
        scriptUnchanged: true,
        factsUnchanged: true,
        timelineUnchanged: true,
        brandConstraintsPreserved: true,
      },
    })}\n`, "utf8");
    const imported = runCli(["import-kimi-review", "--project", projectDir, "--input", direction.outputPath]);
    assert.equal(imported.status, 0, imported.stderr);
    const decisionsPath = path.join(tempRoot, "sensitive-decisions.json");
    await writeFile(decisionsPath, `${JSON.stringify({
      reviewer: "Codex",
      decisions: [{ shotId: "hero", decision: "accept", rationale: "Advice remains inside the approved scope" }],
    }, null, 2)}\n`, "utf8");
    const decided = runCli(["decide-kimi-review", "--project", projectDir, "--input", decisionsPath]);
    assert.equal(decided.status, 0, decided.stderr);

    await writeFile(privacyInput, `${JSON.stringify({
      authorizationStatus: "denied",
      authorizedBy: "data-owner",
      scope: ["kimi_visual_direction"],
      verifiedBy: "Codex",
    }, null, 2)}\n`, "utf8");
    const revoked = runCli(["record-privacy-review", "--project", projectDir, "--input", privacyInput]);
    assert.equal(revoked.status, 0, revoked.stderr);
    const sceneFile = path.join(tempRoot, "hero.html");
    const beforeFrame = path.join(tempRoot, "before.png");
    const afterFrame = path.join(tempRoot, "after.png");
    await writeFile(sceneFile, "<section>hero</section>", "utf8");
    await writeFile(beforeFrame, "before", "utf8");
    await writeFile(afterFrame, "after", "utf8");
    const stale = runCli([
      "accept-kimi-scene", "--project", projectDir, "--shot-id", "hero", "--file", sceneFile,
      "--before-frame", beforeFrame, "--after-frame", afterFrame, "--reviewer", "Codex",
      "--attribution", "codex_implemented_from_kimi_advice",
    ]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /privacy evidence changed|not currently authorized/i);
    const staleDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.equal(staleDirection.status, "stale");
    assert.equal(staleDirection.staleReason, "privacy_evidence_changed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Codex decisions and accepted scene evidence are recorded with current hashes", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-kimi-accept-"));
  try {
    const projectDir = await prepareRoutedProject(tempRoot);
    const incomingPath = path.join(projectDir, "incoming-kimi-review.json");
    const frames = await writeReviewFrames(tempRoot);
    const prepare = runCli(["prepare-kimi", "--project", projectDir, "--output", incomingPath, "--frames", frames.join(",")]);
    assert.equal(prepare.status, 0, prepare.stderr);
    const preparedDirection = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    await writeFile(
      incomingPath,
      `${JSON.stringify({
        sessionId: "kimi-session-accept",
        inputHash: preparedDirection.inputHash,
        suggestions: [{ shotId: "hero", why: "Improve hierarchy" }],
        constraintConfirmation: {
          scriptUnchanged: true,
          factsUnchanged: true,
          timelineUnchanged: true,
          brandConstraintsPreserved: true,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const imported = runCli(["import-kimi-review", "--project", projectDir, "--input", incomingPath]);
    assert.equal(imported.status, 0, imported.stderr);

    const decisionsPath = path.join(tempRoot, "decisions.json");
    await writeFile(decisionsPath, `${JSON.stringify({ reviewer: "Codex", decisions: [{ shotId: "hero", decision: "adjust", rationale: "Keep the hierarchy but simplify the motion" }] }, null, 2)}\n`, "utf8");
    const decided = runCli(["decide-kimi-review", "--project", projectDir, "--input", decisionsPath]);
    assert.equal(decided.status, 0, decided.stderr);

    const sceneFile = path.join(tempRoot, "hero.html");
    const beforeFrame = path.join(tempRoot, "before.png");
    const afterFrame = path.join(tempRoot, "after.png");
    await writeFile(sceneFile, "<section>hero</section>", "utf8");
    await writeFile(beforeFrame, "before", "utf8");
    await writeFile(afterFrame, "after", "utf8");
    const accepted = runCli([
      "accept-kimi-scene", "--project", projectDir, "--shot-id", "hero", "--file", sceneFile,
      "--before-frame", beforeFrame, "--after-frame", afterFrame, "--reviewer", "Codex",
      "--attribution", "codex_implemented_from_kimi_advice",
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const direction = JSON.parse(await readFile(path.join(projectDir, "kimi-visual-direction.json"), "utf8"));
    assert.equal(direction.status, "partially_accepted");
    assert.equal(direction.decisions[0].decision, "adjust");
    assert.match(direction.acceptedScenes[0].implementationSha256, /^[a-f0-9]{64}$/);
    assert.match(direction.acceptedScenes[0].beforeFrameSha256, /^[a-f0-9]{64}$/);
    assert.match(direction.acceptedScenes[0].afterFrameSha256, /^[a-f0-9]{64}$/);
    assert.equal(direction.acceptedScenes[0].attribution, "codex_implemented_from_kimi_advice");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
