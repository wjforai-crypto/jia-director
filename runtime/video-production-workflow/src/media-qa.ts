import path from "node:path";
import { spawnSync } from "node:child_process";
import { ARTIFACT_FILES } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface VersionRecord {
  versionId: string;
  filePath: string;
  sha256: string;
}

interface ReviewFile {
  versions: VersionRecord[];
  automaticChecks?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface ProbeStream {
  codec_type: "video" | "audio";
  duration?: string;
  start_time?: string;
  r_frame_rate?: string;
  sample_rate?: string;
}

interface ProbeOutput {
  streams: ProbeStream[];
  format?: { duration?: string };
}

function run(executable: string, args: string[], label: string): string {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return `${result.stdout}\n${result.stderr}`;
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [numerator, denominator = "1"] = rate.split("/");
  return Number(numerator) / Number(denominator);
}

function check(actual: unknown, expected: string, passed: boolean) {
  return { actual, expected, passed };
}

export async function qaMedia(input: { projectDir: string; versionId: string; reportPath: string }) {
  return withProjectStateLock(input.projectDir, "qa-media", () => qaMediaLocked(input));
}

async function qaMediaLocked(input: { projectDir: string; versionId: string; reportPath: string }) {
  const reviewPath = path.join(input.projectDir, ARTIFACT_FILES.review);
  const review = await readJson<ReviewFile>(reviewPath);
  const version = review.versions.find((item) => item.versionId === input.versionId);
  if (!version) throw new Error(`Unknown version: ${input.versionId}`);
  const mediaPath = path.resolve(version.filePath);
  const reportPath = path.resolve(input.reportPath);
  if (mediaPath.toLowerCase() === reportPath.toLowerCase()) {
    throw new Error("QA report path must not overwrite the media version");
  }
  if (path.extname(reportPath).toLowerCase() !== ".json") {
    throw new Error("QA report path must use a .json extension");
  }
  const currentHash = await sha256File(version.filePath);
  if (currentHash !== version.sha256) throw new Error(`Version hash mismatch for ${version.versionId}; QA evidence cannot be attached`);

  const probe = JSON.parse(
    run(
      "ffprobe",
      [
        "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,duration,start_time,r_frame_rate,sample_rate",
        "-of", "json", version.filePath,
      ],
      "ffprobe",
    ),
  ) as ProbeOutput;
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) throw new Error("Media QA requires both video and audio streams");
  const fps = parseRate(video.r_frame_rate);
  const videoDuration = Number(video.duration ?? probe.format?.duration ?? 0);
  const audioDuration = Number(audio.duration ?? probe.format?.duration ?? 0);
  const syncDelta = Math.abs(videoDuration - audioDuration);

  const loudnessOutput = run(
    "ffmpeg",
    [
      "-hide_banner", "-nostats", "-i", version.filePath,
      "-af", "loudnorm=I=-16:TP=-1:LRA=11:print_format=json", "-f", "null", "NUL",
    ],
    "FFmpeg loudness analysis",
  );
  const loudnessMatch = loudnessOutput.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!loudnessMatch) throw new Error("FFmpeg loudness analysis did not return JSON measurements");
  const loudness = JSON.parse(loudnessMatch[0]) as { input_i: string; input_tp: string; input_lra: string };
  const integrated = Number(loudness.input_i);
  const truePeak = Number(loudness.input_tp);

  const eventOutput = run(
    "ffmpeg",
    [
      "-hide_banner", "-nostats", "-i", version.filePath,
      "-vf", "blackdetect=d=0.1:pix_th=0.1,freezedetect=n=-60dB:d=1",
      "-af", "silencedetect=n=-45dB:d=1", "-f", "null", "NUL",
    ],
    "FFmpeg defect scan",
  );
  const blackEvents = [...eventOutput.matchAll(/black_start:[^\r\n]+/g)].map((match) => match[0]);
  const freezeEvents = [...eventOutput.matchAll(/freeze_(?:start|end):[^\r\n]+/g)].map((match) => match[0]);
  const silenceEvents = [...eventOutput.matchAll(/silence_(?:start|end):[^\r\n]+/g)].map((match) => match[0]);

  const checks = {
    hash: check(currentHash, version.sha256, currentHash === version.sha256),
    audioSampleRate: check(Number(audio.sample_rate), "48000 Hz", Number(audio.sample_rate) === 48_000),
    audioVideoSync: check(syncDelta, `<= ${fps > 0 ? 1 / fps : 0} seconds (one frame)`, fps > 0 && syncDelta <= 1 / fps + 0.001),
    integratedLoudness: check(integrated, "-16 LUFS ±1", integrated >= -17 && integrated <= -15),
    truePeak: check(truePeak, "<= -1 dBTP", truePeak <= -1),
    blackFrames: check(blackEvents, "no black intervals >= 0.1 seconds", blackEvents.length === 0),
    frozenFrames: check(freezeEvents, "reported for Codex review", true),
    longSilence: check(silenceEvents, "reported for Codex review", true),
  };
  const blockingChecks = [checks.hash, checks.audioSampleRate, checks.audioVideoSync, checks.integratedLoudness, checks.truePeak, checks.blackFrames];
  const report = {
    versionId: version.versionId,
    versionHash: version.sha256,
    filePath: version.filePath,
    passed: blockingChecks.every((item) => item.passed),
    checks,
    measuredAt: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  review.automaticChecks = [
    ...(review.automaticChecks ?? []).filter((item) => item.versionId !== version.versionId),
    report,
  ];
  await writeJson(reviewPath, review);
  if (!report.passed) {
    const failures = Object.entries(checks).filter(([, value]) => !value.passed).map(([name]) => name);
    throw new Error(`Automatic media QA failed: ${failures.join(", ")}`);
  }
  return report;
}
