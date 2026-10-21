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
      "color=c=black:s=320x240:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=16000",
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

test("transcribe import normalizes stable word timestamps and plan-cut never auto-drops speech", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-transcript-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const sourcePath = path.join(tempRoot, "source.mp4");
    const whisperPath = path.join(tempRoot, "whisper.json");
    createFixture(sourcePath);
    const init = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "逐字稿测试",
      "--lane",
      "speech",
      "--source",
      sourcePath,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const ingest = runCli([
      "ingest",
      "--project",
      projectDir,
      "--asset",
      sourcePath,
      "--role",
      "a-roll",
      "--provenance",
      "user-owned",
    ]);
    assert.equal(ingest.status, 0, ingest.stderr);

    await writeFile(
      whisperPath,
      `${JSON.stringify({
        result: { language: "zh" },
        transcription: [
          {
            offsets: { from: 0, to: 2000 },
            text: "我想买个保险",
            tokens: [
              { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.9 },
              { text: "我", offsets: { from: 100, to: 300 }, p: 0.98 },
              { text: "想", offsets: { from: 300, to: 500 }, p: 0.95 },
              { text: "买", offsets: { from: 500, to: 700 }, p: 0.91 },
              { text: "个", offsets: { from: 700, to: 900 }, p: 0.88 },
              { text: "保险", offsets: { from: 900, to: 1400 }, p: 0.93 },
              { text: " ", offsets: { from: 1400, to: 1400 }, p: 0.5 },
            ],
          },
          {
            offsets: { from: 3000, to: 4000 },
            text: "但是要先沟通",
            tokens: [
              { text: "但是", offsets: { from: 3000, to: 3300 }, p: 0.12 },
              { text: "要先", offsets: { from: 3300, to: 3600 }, p: 0.82 },
              { text: "沟通", offsets: { from: 3600, to: 3950 }, p: 0.9 },
              { text: "[_TT_200]", offsets: { from: 4000, to: 4000 }, p: 0.1 },
            ],
          },
        ],
      })}\n`,
      "utf8",
    );

    const transcribe = runCli([
      "transcribe",
      "--project",
      projectDir,
      "--engine",
      "import",
      "--input",
      whisperPath,
    ]);
    assert.equal(transcribe.status, 0, transcribe.stderr);
    const transcript = JSON.parse(await readFile(path.join(projectDir, "transcript.json"), "utf8"));
    assert.equal(transcript.engine, "import-whisper-json");
    assert.equal(transcript.language, "zh");
    assert.equal(transcript.segments.length, 2);
    assert.equal(transcript.words.length, 8);
    assert.ok(transcript.words.every((word: { id: string }) => /^w_[a-f0-9]{24}$/.test(word.id)));
    assert.equal(transcript.words[0].text, "我");
    assert.equal(transcript.words[0].start, 0.1);
    assert.equal(transcript.words[0].end, 0.3);
    assert.equal(transcript.asrReviewStatus, "needs_review");
    assert.equal(transcript.lowConfidenceWordIds.length, 1);

    const firstWordIds = transcript.words.map((word: { id: string }) => word.id);
    const repeat = runCli([
      "transcribe",
      "--project",
      projectDir,
      "--engine",
      "import",
      "--input",
      whisperPath,
    ]);
    assert.equal(repeat.status, 0, repeat.stderr);
    const repeatedTranscript = JSON.parse(await readFile(path.join(projectDir, "transcript.json"), "utf8"));
    assert.deepEqual(
      repeatedTranscript.words.map((word: { id: string }) => word.id),
      firstWordIds,
    );

    const cut = runCli([
      "plan-cut",
      "--project",
      projectDir,
      "--strategy",
      "semantic+silence",
    ]);
    assert.equal(cut.status, 0, cut.stderr);
    const cutPlan = JSON.parse(await readFile(path.join(projectDir, "cut-plan.json"), "utf8"));
    const speechOperations = cutPlan.operations.filter((operation: { kind: string }) => operation.kind === "speech");
    const pauseOperations = cutPlan.operations.filter((operation: { kind: string }) => operation.kind === "pause");
    assert.equal(speechOperations.length, 2);
    assert.ok(speechOperations.every((operation: { decision: string }) => operation.decision === "keep"));
    assert.equal(pauseOperations.length, 1);
    assert.equal(pauseOperations[0].decision, "compress_candidate");
    assert.equal(cutPlan.reviewStatus, "needs_review");
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "plan_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
