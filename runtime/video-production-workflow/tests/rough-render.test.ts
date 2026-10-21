import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function createFixture(filePath: string) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x240:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=4",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("approved cut decisions render a real draft, SRT, edit plan, and hash-bound review version", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-render-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const sourcePath = path.join(tempRoot, "source.mp4");
    const whisperPath = path.join(tempRoot, "whisper.json");
    const cutReviewPath = path.join(tempRoot, "cut-review.json");
    const outputPath = path.join(tempRoot, "draft1.mp4");
    const srtPath = path.join(tempRoot, "draft1.srt");
    createFixture(sourcePath);

    assert.equal(
      runCli(["init", "--project", projectDir, "--title", "真实粗剪", "--lane", "speech", "--source", sourcePath]).status,
      0,
    );
    assert.equal(
      runCli([
        "ingest",
        "--project",
        projectDir,
        "--asset",
        sourcePath,
        "--role",
        "a-roll",
        "--provenance",
        "user-owned",
      ]).status,
      0,
    );
    await writeFile(
      whisperPath,
      `${JSON.stringify({
        result: { language: "zh" },
        transcription: [
          { offsets: { from: 0, to: 1000 }, text: "第一句", tokens: [{ text: "第一句", offsets: { from: 50, to: 950 }, p: 0.9 }] },
          { offsets: { from: 1000, to: 2000 }, text: "错误重说", tokens: [{ text: "错误重说", offsets: { from: 1050, to: 1950 }, p: 0.9 }] },
          { offsets: { from: 3000, to: 4000 }, text: "最终句", tokens: [{ text: "最终句", offsets: { from: 3050, to: 3950 }, p: 0.9 }] },
        ],
      })}\n`,
      "utf8",
    );
    assert.equal(runCli(["transcribe", "--project", projectDir, "--engine", "import", "--input", whisperPath]).status, 0);
    assert.equal(runCli(["plan-cut", "--project", projectDir, "--strategy", "semantic+silence"]).status, 0);

    const cutPlanPath = path.join(projectDir, "cut-plan.json");
    const cutPlan = JSON.parse(await readFile(cutPlanPath, "utf8"));
    const speech = cutPlan.operations.filter((operation: { kind: string }) => operation.kind === "speech");
    const pause = cutPlan.operations.find((operation: { kind: string }) => operation.kind === "pause");
    await writeFile(
      cutReviewPath,
      `${JSON.stringify({
        sourceCutPlanHash: sha256(await readFile(cutPlanPath)),
        reviewer: "Codex",
        decisions: [
          { operationId: speech[0].id, decision: "keep", reason: "完整开场" },
          { operationId: speech[1].id, decision: "drop", reason: "错误重说" },
          { operationId: speech[2].id, decision: "keep", reason: "采用正确表达" },
          { operationId: pause.id, decision: "compress", targetDuration: 0.25, reason: "缩短空白" },
        ],
      })}\n`,
      "utf8",
    );
    assert.equal(runCli(["review-cut", "--project", projectDir, "--input", cutReviewPath]).status, 0);
    assert.equal(runCli(["plan-edit", "--project", projectDir]).status, 0);
    assert.equal(
      runCli([
        "route-visual",
        "--project",
        projectDir,
        "--critical",
        "1",
        "--abstract",
        "0",
        "--information",
        "0",
        "--brand",
        "1",
        "--asset-gap",
        "0",
        "--selected-shots",
        "",
      ]).status,
      0,
    );

    const render = runCli([
      "render-rough",
      "--project",
      projectDir,
      "--output",
      outputPath,
      "--srt",
      srtPath,
      "--label",
      "初稿粗剪",
    ]);
    assert.equal(render.status, 0, render.stderr);
    const payload = JSON.parse(render.stdout);
    assert.equal(payload.ok, true);
    assert.match(payload.versionId, /^version_draft1_/);

    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath], {
      encoding: "utf8",
    });
    assert.equal(probe.status, 0, probe.stderr);
    const duration = Number(probe.stdout.trim());
    assert.ok(duration >= 1.9 && duration <= 2.4, `unexpected duration ${duration}`);
    const srt = await readFile(srtPath, "utf8");
    assert.match(srt, /第一句/);
    assert.match(srt, /最终句/);
    assert.doesNotMatch(srt, /错误重说/);

    const editPlan = JSON.parse(await readFile(path.join(projectDir, "edit-plan.json"), "utf8"));
    assert.equal(editPlan.reviewStatus, "ready");
    assert.equal(editPlan.shots.length, 2);
    assert.ok(editPlan.shots.every((shot: { id: string }) => /^shot_[a-f0-9]{16}$/.test(shot.id)));
    const review = JSON.parse(await readFile(path.join(projectDir, "review.json"), "utf8"));
    assert.equal(review.versions.length, 1);
    assert.equal(review.versions[0].sha256, sha256(await readFile(outputPath)));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "draft1_pending_user");

    const mediaHashBeforeQa = sha256(await readFile(outputPath));
    const unsafeQa = runCli([
      "qa-media",
      "--project",
      projectDir,
      "--version-id",
      review.versions[0].versionId,
      "--output",
      outputPath,
    ]);
    assert.equal(unsafeQa.status, 1);
    assert.match(unsafeQa.stderr, /report path must not overwrite the media/i);
    assert.equal(sha256(await readFile(outputPath)), mediaHashBeforeQa);

    const qaPath = path.join(tempRoot, "qa.json");
    const qa = runCli([
      "qa-media",
      "--project",
      projectDir,
      "--version-id",
      review.versions[0].versionId,
      "--output",
      qaPath,
    ]);
    assert.equal(qa.status, 0, qa.stderr);
    const qaReport = JSON.parse(await readFile(qaPath, "utf8"));
    assert.equal(qaReport.passed, true);
    assert.equal(qaReport.checks.audioSampleRate.passed, true);
    assert.equal(qaReport.checks.audioVideoSync.passed, true);
    assert.equal(qaReport.checks.integratedLoudness.passed, true);
    assert.equal(qaReport.checks.truePeak.passed, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
