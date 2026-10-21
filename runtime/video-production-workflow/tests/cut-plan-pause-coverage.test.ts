import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function cli(args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "src/cli.ts"), ...args], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("reviewed keep retains short pauses in a real rough render and long compression remains advisory", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "video-pause-coverage-"));
  try {
    const source = path.join(temp, "source.mp4"), project = path.join(temp, "project");
    const fixture = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-n", source], { encoding: "utf8" });
    assert.equal(fixture.status, 0, fixture.stderr);
    cli(["init", "--project", project, "--title", "short-pause-regression", "--lane", "speech", "--source", source]);
    cli(["ingest", "--project", project, "--asset", source, "--role", "a-roll", "--provenance", "user-owned"]);
    const asr = path.join(temp, "fixture.json");
    await writeFile(asr, JSON.stringify({ result: { language: "zh" }, transcription: [
      { offsets: { from: 0, to: 1000 }, text: "第一句", tokens: [{ text: "第一句", offsets: { from: 0, to: 1000 }, p: 0.9 }] },
      { offsets: { from: 1400, to: 2000 }, text: "第二句", tokens: [{ text: "第二句", offsets: { from: 1400, to: 2000 }, p: 0.9 }] },
      { offsets: { from: 2800, to: 4000 }, text: "第三句", tokens: [{ text: "第三句", offsets: { from: 2800, to: 4000 }, p: 0.9 }] },
    ] }));
    cli(["transcribe", "--project", project, "--engine", "import", "--input", asr]);
    cli(["plan-cut", "--project", project, "--strategy", "semantic+silence"]);
    const planPath = path.join(project, "cut-plan.json"), bytes = await readFile(planPath);
    const plan = JSON.parse(bytes.toString("utf8"));
    const pauses = plan.operations.filter((op: { kind: string }) => op.kind === "pause");
    assert.equal(pauses.length, 2);
    assert.equal(pauses[0].decision, "keep");
    assert.equal(pauses[0].originalDuration, 0.4);
    assert.equal(pauses[0].targetDuration, 0.4);
    assert.equal(pauses[1].decision, "compress_candidate");
    assert.equal(pauses[1].targetDuration, 0.25);
    assert.equal(plan.reviewStatus, "needs_review");
    const review = path.join(temp, "review.json");
    await writeFile(review, JSON.stringify({ sourceCutPlanHash: createHash("sha256").update(bytes).digest("hex"), reviewer: "regression-test", decisions: plan.operations.map((op: { id: string }) => ({ operationId: op.id, decision: "keep", reason: "Keep all source intervals for duration regression" })) }));
    cli(["review-cut", "--project", project, "--input", review]);
    cli(["plan-edit", "--project", project]);
    cli(["route-visual", "--project", project, "--critical", "1", "--abstract", "0", "--information", "0", "--brand", "1", "--asset-gap", "0", "--selected-shots", ""]);
    const output = path.join(temp, "rough.mp4"), srt = path.join(temp, "rough.srt");
    cli(["render-rough", "--project", project, "--output", output, "--srt", srt, "--label", "pause-regression"]);
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration,nb_frames", "-of", "json", output], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const video = JSON.parse(probe.stdout).streams[0];
    assert.equal(Number(video.nb_frames), 120, "Unreviewed short gap must not silently vanish");
    assert.ok(Math.abs(Number(video.duration) - 4) < 1 / 30);
    const cues = await readFile(srt, "utf8");
    assert.match(cues, /00:00:01,400 --> 00:00:02,000/);
    const decode = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", output, "-f", "null", "-"], { encoding: "utf8" });
    assert.equal(decode.status, 0, decode.stderr);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
