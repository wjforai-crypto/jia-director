import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { reviewTranscript } from "../src/transcript-review.js";

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
      "color=c=black:s=320x240:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=16000",
      "-t",
      "2",
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

test("review-transcript preserves ASR evidence and stable word IDs while applying audited corrections", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-transcript-review-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const sourcePath = path.join(tempRoot, "source.mp4");
    const whisperPath = path.join(tempRoot, "whisper.json");
    const reviewPath = path.join(tempRoot, "review.json");
    createFixture(sourcePath);

    assert.equal(
      runCli(["init", "--project", projectDir, "--title", "转写校正", "--lane", "speech", "--source", sourcePath]).status,
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
          {
            offsets: { from: 0, to: 1800 },
            text: "打过卖铁抽钱给你治病",
            tokens: [
              { text: "打过卖铁", offsets: { from: 100, to: 800 }, p: 0.4 },
              { text: "抽钱", offsets: { from: 800, to: 1100 }, p: 0.3 },
              { text: "给你治病", offsets: { from: 1100, to: 1700 }, p: 0.9 },
            ],
          },
        ],
      })}\n`,
      "utf8",
    );
    assert.equal(
      runCli(["transcribe", "--project", projectDir, "--engine", "import", "--input", whisperPath]).status,
      0,
    );

    const before = JSON.parse(await readFile(path.join(projectDir, "transcript.json"), "utf8"));
    const wordIds = before.words.map((word: { id: string }) => word.id);
    await writeFile(
      reviewPath,
      `${JSON.stringify({
        sourceContentHash: before.contentHash,
        reviewer: "Codex",
        evidenceSources: ["whisper.cpp-small", "faster-whisper-large-v3", "audio-review"],
        corrections: [
          {
            segmentId: before.segments[0].id,
            text: "砸锅卖铁凑钱给你治病",
            reason: "Two-model ASR comparison plus local audio review",
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = runCli(["review-transcript", "--project", projectDir, "--input", reviewPath]);
    assert.equal(result.status, 0, result.stderr);
    const after = JSON.parse(await readFile(path.join(projectDir, "transcript.json"), "utf8"));
    assert.equal(after.segments[0].asrText, "打过卖铁抽钱给你治病");
    assert.equal(after.segments[0].text, "砸锅卖铁凑钱给你治病");
    assert.deepEqual(after.words.map((word: { id: string }) => word.id), wordIds);
    assert.equal(after.asrReviewStatus, "reviewed");
    assert.equal(after.reviewHistory.length, 1);
    assert.equal(after.reviewHistory[0].sourceContentHash, before.contentHash);
    assert.notEqual(after.contentHash, before.contentHash);
    assert.equal(after.asrContentHash, before.contentHash);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("review-transcript rejects stale input hashes without changing the transcript", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-transcript-stale-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const sourcePath = path.join(tempRoot, "source.mp4");
    const whisperPath = path.join(tempRoot, "whisper.json");
    const reviewPath = path.join(tempRoot, "review.json");
    createFixture(sourcePath);
    assert.equal(
      runCli(["init", "--project", projectDir, "--title", "过期校正", "--lane", "speech", "--source", sourcePath]).status,
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
          { offsets: { from: 0, to: 1000 }, text: "原文", tokens: [{ text: "原文", offsets: { from: 0, to: 900 }, p: 0.9 }] },
        ],
      })}\n`,
      "utf8",
    );
    assert.equal(runCli(["transcribe", "--project", projectDir, "--engine", "import", "--input", whisperPath]).status, 0);
    const beforeBytes = await readFile(path.join(projectDir, "transcript.json"));
    await writeFile(
      reviewPath,
      `${JSON.stringify({
        sourceContentHash: createHash("sha256").update("stale").digest("hex"),
        reviewer: "Codex",
        evidenceSources: ["manual"],
        corrections: [{ segmentId: "missing", text: "修改", reason: "test" }],
      })}\n`,
      "utf8",
    );
    const result = runCli(["review-transcript", "--project", projectDir, "--input", reviewPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale/i);
    assert.deepEqual(await readFile(path.join(projectDir, "transcript.json")), beforeBytes);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("review-transcript requires recreation withdrawal before changing a planned transcript", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-transcript-recreation-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const reviewPath = path.join(tempRoot, "review.json");
    const transcriptPath = path.join(projectDir, "transcript.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "project.json"),
      `${JSON.stringify({ workflowStatus: "plan_ready" }, null, 2)}\n`,
      "utf8",
    );
    const transcript = {
      segments: [{ id: "seg_1", text: "原始逐字稿" }],
      words: [{ id: "w_1", text: "原始逐字稿", start: 0, end: 1 }],
      contentHash: createHash("sha256").update("current-transcript").digest("hex"),
      asrReviewStatus: "reviewed",
    };
    await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(projectDir, "cut-plan.json"),
      `${JSON.stringify({ reviewStatus: "approved" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "recreation-plan.json"),
      `${JSON.stringify({ status: "approved" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      reviewPath,
      `${JSON.stringify({
        sourceContentHash: transcript.contentHash,
        reviewer: "Codex",
        evidenceSources: ["manual"],
        corrections: [{ segmentId: "seg_1", text: "校正后的逐字稿", reason: "人工核对" }],
      }, null, 2)}\n`,
      "utf8",
    );
    const beforeBytes = await readFile(transcriptPath);

    await assert.rejects(
      () => reviewTranscript({ projectDir, inputPath: reviewPath }),
      /review-recreation.*revise/i,
    );
    assert.deepEqual(await readFile(transcriptPath), beforeBytes);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
