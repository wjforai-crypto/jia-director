import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ARTIFACT_FILES, type VideoProject } from "./contracts.js";
import { readJson } from "./json-store.js";
import { recordVersion } from "./review-gates.js";

interface AssetRecord { path: string; role: string }
interface CutOperation {
  id: string;
  kind: "speech" | "pause";
  decision: string;
  sourceIn: number;
  sourceOut: number;
  targetDuration?: number;
  transcript?: string;
}
interface CutPlan { reviewStatus: string; operations: CutOperation[] }
interface RenderClip { sourceIn: number; sourceOut: number; operation?: CutOperation }

function formatTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function buildClips(operations: CutOperation[]): RenderClip[] {
  const clips: RenderClip[] = [];
  for (const operation of [...operations].sort((left, right) => left.sourceIn - right.sourceIn)) {
    if (operation.decision === "drop") continue;
    if (operation.kind === "speech" && operation.decision === "keep") {
      clips.push({ sourceIn: operation.sourceIn, sourceOut: operation.sourceOut, operation });
    } else if (operation.kind === "pause" && operation.decision === "keep") {
      clips.push({ sourceIn: operation.sourceIn, sourceOut: operation.sourceOut });
    } else if (operation.kind === "pause" && operation.decision === "compress") {
      const duration = operation.sourceOut - operation.sourceIn;
      const targetDuration = operation.targetDuration ?? 0.25;
      const trimEachSide = (duration - targetDuration) / 2;
      clips.push({ sourceIn: operation.sourceIn + trimEachSide, sourceOut: operation.sourceOut - trimEachSide });
    }
  }
  return clips;
}

function buildSrt(clips: RenderClip[]): string {
  const entries: string[] = [];
  let timeline = 0;
  let index = 1;
  for (const clip of clips) {
    const duration = clip.sourceOut - clip.sourceIn;
    if (clip.operation?.transcript?.trim()) {
      entries.push(`${index}\n${formatTimestamp(timeline)} --> ${formatTimestamp(timeline + duration)}\n${clip.operation.transcript.trim()}\n`);
      index += 1;
    }
    timeline += duration;
  }
  return `${entries.join("\n")}\n`;
}

function runFfmpeg(sourcePath: string, clips: RenderClip[], outputPath: string): void {
  const filters: string[] = [];
  const concatInputs: string[] = [];
  clips.forEach((clip, index) => {
    const start = clip.sourceIn.toFixed(3);
    const end = clip.sourceOut.toFixed(3);
    filters.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`);
    filters.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filters.push(`${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
  filters.push("[acat]loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-i", sourcePath,
      "-filter_complex", filters.join(";"), "-map", "[vcat]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-y", outputPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`FFmpeg rough render failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

export async function renderRough(input: { projectDir: string; outputPath: string; srtPath: string; label: string }) {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  if (!new Set(["visual_direction_ready", "draft1_pending_user", "revision_in_progress"]).has(project.workflowStatus)) {
    throw new Error(`render-rough requires visual_direction_ready, draft1_pending_user, or revision_in_progress; got ${project.workflowStatus}`);
  }
  const cutPlan = await readJson<CutPlan>(path.join(input.projectDir, ARTIFACT_FILES.cutPlan));
  if (cutPlan.reviewStatus !== "approved") throw new Error(`render-rough requires an approved cut plan, got ${cutPlan.reviewStatus}`);
  const assets = await readJson<{ assets: AssetRecord[] }>(path.join(input.projectDir, ARTIFACT_FILES.assets));
  const source = assets.assets.find((asset) => asset.role === "a-roll");
  if (!source) throw new Error("render-rough requires a registered a-roll asset");
  const clips = buildClips(cutPlan.operations);
  if (clips.length === 0) throw new Error("render-rough has no retained media clips");

  const outputPath = path.resolve(input.outputPath);
  const srtPath = path.resolve(input.srtPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(srtPath), { recursive: true });
  const temporaryOutput = `${outputPath}.partial.mp4`;
  await rm(temporaryOutput, { force: true });
  try {
    runFfmpeg(source.path, clips, temporaryOutput);
    await rename(temporaryOutput, outputPath);
  } catch (error) {
    await rm(temporaryOutput, { force: true });
    throw error;
  }
  await writeFile(srtPath, buildSrt(clips), "utf8");
  const version = await recordVersion({ projectDir: input.projectDir, stage: "draft1", filePath: outputPath, label: input.label });
  return { outputPath, srtPath, clipCount: clips.length, versionId: version.versionId, sha256: version.sha256 };
}
