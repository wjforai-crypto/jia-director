import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function createVisualReadyProject(tempRoot: string) {
  const projectDir = path.join(tempRoot, "project");
  const init = runCli([
    "init",
    "--project",
    projectDir,
    "--title",
    "审片门测试",
    "--lane",
    "speech",
    "--source",
    path.join(tempRoot, "source.mp4"),
  ]);
  assert.equal(init.status, 0, init.stderr);
  const projectPath = path.join(projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "visual_direction_ready";
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  return projectDir;
}

function parseStdout(result: ReturnType<typeof runCli>) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("two-stage user confirmation is hash-bound and cannot be skipped", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-review-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const draft1Path = path.join(tempRoot, "draft1.mp4");
    const draft2Path = path.join(tempRoot, "draft2.mp4");
    await writeFile(draft1Path, "draft-one", "utf8");
    await writeFile(draft2Path, "draft-two", "utf8");

    const draft1 = parseStdout(
      runCli([
        "record-version",
        "--project",
        projectDir,
        "--stage",
        "draft1",
        "--file",
        draft1Path,
        "--label",
        "初稿待确认",
      ]),
    );
    let project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "draft1_pending_user");

    const prematureFinal = runCli([
      "confirm",
      "--project",
      projectDir,
      "--gate",
      "final",
      "--version-id",
      draft1.versionId,
      "--decision",
      "approve",
      "--reviewer",
      "Wang Jie",
    ]);
    assert.equal(prematureFinal.status, 1);
    assert.match(prematureFinal.stderr, /draft2_pending_user/);

    parseStdout(
      runCli([
        "confirm",
        "--project",
        projectDir,
        "--gate",
        "initial",
        "--version-id",
        draft1.versionId,
        "--decision",
        "approve",
        "--reviewer",
        "Wang Jie",
      ]),
    );
    project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "draft1_approved");

    parseStdout(
      runCli([
        "record-review",
        "--project",
        projectDir,
        "--version-id",
        draft1.versionId,
        "--decision",
        "pass",
        "--reviewer",
        "Codex",
      ]),
    );
    project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "internal_review_passed");

    const draft2 = parseStdout(
      runCli([
        "record-version",
        "--project",
        projectDir,
        "--stage",
        "final_candidate",
        "--file",
        draft2Path,
        "--label",
        "第二稿待确认",
      ]),
    );
    project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "draft2_pending_user");

    await writeFile(draft2Path, "draft-two-was-modified", "utf8");
    const staleConfirmation = runCli([
      "confirm",
      "--project",
      projectDir,
      "--gate",
      "final",
      "--version-id",
      draft2.versionId,
      "--decision",
      "approve",
      "--reviewer",
      "Wang Jie",
    ]);
    assert.equal(staleConfirmation.status, 1);
    assert.match(staleConfirmation.stderr, /hash mismatch/i);
    project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "draft2_pending_user");

    const review = JSON.parse(await readFile(path.join(projectDir, "review.json"), "utf8"));
    assert.equal(review.versions.find((version: { versionId: string }) => version.versionId === draft2.versionId).evidenceStatus, "invalidated");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a final candidate registration never marks the project final", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-no-auto-final-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const filePath = path.join(tempRoot, "candidate.mp4");
    await writeFile(filePath, "candidate", "utf8");
    const result = runCli([
      "record-version",
      "--project",
      projectDir,
      "--stage",
      "final_candidate",
      "--file",
      filePath,
      "--label",
      "最终候选",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /internal_review_passed/);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.notEqual(project.workflowStatus, "final_confirmed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Codex can replace a pending draft before user review and the older draft is superseded", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-replace-draft-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const firstPath = path.join(tempRoot, "draft1-v1.mp4");
    const secondPath = path.join(tempRoot, "draft1-v2.mp4");
    await writeFile(firstPath, "first", "utf8");
    await writeFile(secondPath, "second", "utf8");
    const first = parseStdout(
      runCli(["record-version", "--project", projectDir, "--stage", "draft1", "--file", firstPath, "--label", "初稿 v1"]),
    );
    const second = parseStdout(
      runCli(["record-version", "--project", projectDir, "--stage", "draft1", "--file", secondPath, "--label", "初稿 v2"]),
    );
    assert.notEqual(first.versionId, second.versionId);
    const review = JSON.parse(await readFile(path.join(projectDir, "review.json"), "utf8"));
    assert.equal(review.versions.find((version: { versionId: string }) => version.versionId === first.versionId).userStatus, "superseded");
    assert.equal(review.versions.find((version: { versionId: string }) => version.versionId === second.versionId).userStatus, "pending");
    const staleConfirmation = runCli([
      "confirm", "--project", projectDir, "--gate", "initial", "--version-id", first.versionId,
      "--decision", "approve", "--reviewer", "王杰",
    ]);
    assert.equal(staleConfirmation.status, 1);
    assert.match(staleConfirmation.stderr, /unique pending version|superseded/i);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "draft1_pending_user");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("invalidated version bytes cannot be re-registered as fresh review evidence", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-invalidated-version-reuse-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const candidatePath = path.join(tempRoot, "invalidated-draft.mp4");
    await writeFile(candidatePath, "same-old-bytes", "utf8");
    const recorded = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft1", "--file", candidatePath, "--label", "旧初稿",
    ]));
    const projectPath = path.join(projectDir, "project.json");
    const reviewPath = path.join(projectDir, "review.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "revision_in_progress";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    const invalidated = review.versions.find((version: { versionId: string }) => version.versionId === recorded.versionId);
    invalidated.evidenceStatus = "invalidated";
    invalidated.userStatus = "revision_requested";
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    const reused = runCli([
      "record-version", "--project", projectDir, "--stage", "draft1", "--file", candidatePath, "--label", "伪装成新初稿",
    ]);
    assert.equal(reused.status, 1);
    assert.match(reused.stderr, /already registered|invalidated evidence|render changed bytes/i);
    const crossStageReuse = runCli([
      "record-version", "--project", projectDir, "--stage", "draft2", "--file", candidatePath, "--label", "换 stage 复活旧字节",
    ]);
    assert.equal(crossStageReuse.status, 1);
    assert.match(crossStageReuse.stderr, /stale evidence|render changed bytes|switching stage/i);
    const after = JSON.parse(await readFile(reviewPath, "utf8"));
    const sameVersion = after.versions.filter((version: { versionId: string }) => version.versionId === recorded.versionId);
    assert.equal(sameVersion.length, 1);
    assert.equal(sameVersion[0].evidenceStatus, "invalidated");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("record-version resumes the project state after the review record was written first", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-version-write-recovery-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const candidatePath = path.join(tempRoot, "recoverable-draft.mp4");
    await writeFile(candidatePath, "recoverable-draft-bytes", "utf8");
    const first = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft1", "--file", candidatePath, "--label", "可恢复初稿",
    ]));
    const projectPath = path.join(projectDir, "project.json");
    const interruptedProject = JSON.parse(await readFile(projectPath, "utf8"));
    interruptedProject.workflowStatus = "visual_direction_ready";
    await writeFile(projectPath, `${JSON.stringify(interruptedProject, null, 2)}\n`, "utf8");

    const resumed = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft1", "--file", candidatePath, "--label", "可恢复初稿",
    ]));
    assert.equal(resumed.versionId, first.versionId);
    const recoveredProject = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(recoveredProject.workflowStatus, "draft1_pending_user");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("confirm resumes the project state after confirmation evidence was written first", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-confirm-write-recovery-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const candidatePath = path.join(tempRoot, "confirm-recovery.mp4");
    await writeFile(candidatePath, "confirm-recovery-bytes", "utf8");
    const candidate = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft1", "--file", candidatePath, "--label", "初稿确认恢复",
    ]));
    const confirmArgs = [
      "confirm", "--project", projectDir, "--gate", "initial", "--version-id", candidate.versionId,
      "--decision", "approve", "--reviewer", "王杰",
    ];
    parseStdout(runCli(confirmArgs));
    const projectPath = path.join(projectDir, "project.json");
    const interrupted = JSON.parse(await readFile(projectPath, "utf8"));
    interrupted.workflowStatus = "draft1_pending_user";
    await writeFile(projectPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    parseStdout(runCli(confirmArgs));
    const recovered = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(recovered.workflowStatus, "draft1_approved");
    const review = JSON.parse(await readFile(path.join(projectDir, "review.json"), "utf8"));
    assert.equal(review.confirmations.filter((item: { versionId: string }) => item.versionId === candidate.versionId).length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("internal review resumes the project state without duplicating review evidence", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-internal-review-recovery-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const candidatePath = path.join(tempRoot, "internal-review-recovery.mp4");
    await writeFile(candidatePath, "internal-review-recovery-bytes", "utf8");
    const candidate = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft1", "--file", candidatePath, "--label", "内审恢复初稿",
    ]));
    parseStdout(runCli([
      "confirm", "--project", projectDir, "--gate", "initial", "--version-id", candidate.versionId,
      "--decision", "approve", "--reviewer", "王杰",
    ]));
    const reviewArgs = [
      "record-review", "--project", projectDir, "--version-id", candidate.versionId,
      "--decision", "pass", "--reviewer", "Codex",
    ];
    parseStdout(runCli(reviewArgs));
    const projectPath = path.join(projectDir, "project.json");
    const interrupted = JSON.parse(await readFile(projectPath, "utf8"));
    interrupted.workflowStatus = "draft1_approved";
    await writeFile(projectPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    parseStdout(runCli(reviewArgs));
    const recovered = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(recovered.workflowStatus, "internal_review_passed");
    const review = JSON.parse(await readFile(path.join(projectDir, "review.json"), "utf8"));
    assert.equal(review.internalReviews.filter((item: { versionId: string }) => item.versionId === candidate.versionId).length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("an internal-review failure makes the same candidate ineligible for a later pass", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-review-fail-reuse-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "revision_in_progress";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const candidatePath = path.join(tempRoot, "failed-draft2.mp4");
    await writeFile(candidatePath, "failed-draft2-bytes", "utf8");
    const candidate = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft2", "--file", candidatePath, "--label", "待内审第二稿",
    ]));
    const failed = runCli([
      "record-review", "--project", projectDir, "--version-id", candidate.versionId,
      "--decision", "fail", "--reviewer", "Codex",
    ]);
    assert.equal(failed.status, 0, failed.stderr);
    const reused = runCli([
      "record-review", "--project", projectDir, "--version-id", candidate.versionId,
      "--decision", "pass", "--reviewer", "Codex",
    ]);
    assert.equal(reused.status, 1);
    assert.match(reused.stderr, /newly registered pending candidate|rejected evidence cannot be reused/i);
    const review = JSON.parse(await readFile(path.join(projectDir, "review.json"), "utf8"));
    assert.equal(review.versions.find((version: { versionId: string }) => version.versionId === candidate.versionId).userStatus, "revision_requested");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a rejected draft2 must be replaced and the new hash must pass internal review before returning to the user", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-revision-draft2-"));
  try {
    const projectDir = await createVisualReadyProject(tempRoot);
    const projectPath = path.join(projectDir, "project.json");
    const reviewPath = path.join(projectDir, "review.json");
    const rejectedPath = path.join(tempRoot, "rejected.mp4");
    const revisedOldPath = path.join(tempRoot, "revised-old.mp4");
    const revisedPath = path.join(tempRoot, "revised.mp4");
    await writeFile(rejectedPath, "rejected", "utf8");
    await writeFile(revisedOldPath, "revised-old", "utf8");
    await writeFile(revisedPath, "revised", "utf8");

    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "revision_in_progress";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.versions.push({
      versionId: "version_draft2_rejected",
      stage: "draft2",
      label: "rejected",
      filePath: rejectedPath,
      sha256: "unused-for-guard",
      sizeBytes: 8,
      evidenceStatus: "valid",
      userStatus: "revision_requested",
      recordedAt: new Date().toISOString(),
    });
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    const stalePass = runCli([
      "record-review", "--project", projectDir, "--version-id", "version_draft2_rejected",
      "--decision", "pass", "--reviewer", "Codex",
    ]);
    assert.equal(stalePass.status, 1);
    assert.match(stalePass.stderr, /rejected evidence cannot be reused/i);

    const revisedOld = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft2", "--file", revisedOldPath,
      "--label", "横屏修订第二稿旧候选",
    ]));
    const revised = parseStdout(runCli([
      "record-version", "--project", projectDir, "--stage", "draft2", "--file", revisedPath,
      "--label", "横屏修订第二稿",
    ]));
    let currentProject = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(currentProject.workflowStatus, "revision_in_progress");
    const revisedReview = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.equal(revisedReview.versions.find((item: {versionId: string}) => item.versionId === revisedOld.versionId).userStatus, "superseded");
    assert.equal(revisedReview.versions.find((item: {versionId: string}) => item.versionId === revised.versionId).userStatus, "pending");

    parseStdout(runCli([
      "record-review", "--project", projectDir, "--version-id", revised.versionId,
      "--decision", "pass", "--reviewer", "Codex",
    ]));
    currentProject = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(currentProject.workflowStatus, "draft2_pending_user");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
