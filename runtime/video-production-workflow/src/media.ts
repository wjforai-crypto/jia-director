import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { readJson, writeJsonAtomic } from "./json-store.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface AssetsFile {
  schemaVersion: string;
  assets: Array<Record<string, unknown> & { assetId: string }>;
}

export interface SourceAsset {
  assetId: string;
  path: string;
  role: string;
  sha256: string;
}

function sourcePathKey(filePath: string) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function loadCurrentSourceAsset(projectDir: string, project: VideoProject): Promise<SourceAsset> {
  const { assets } = await readJson<{ assets: SourceAsset[] }>(path.join(projectDir, ARTIFACT_FILES.assets));
  const source = project.source;
  const hash = await sha256File(source.path);
  const matches = assets.filter(asset => asset.role === "a-roll" && asset.sha256 === hash);
  const current = source.assetId
    ? matches.find(asset => asset.assetId === source.assetId)
    : matches.find(asset => sourcePathKey(asset.path) === sourcePathKey(source.path)) ?? matches[0];
  if (!current) throw new Error("Current source must match a registered a-roll asset. Register the changed source before continuing.");
  return { ...current, path: source.path };
}

interface ProbeStream {
  codec_type?: "video" | "audio";
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
  };
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseRate(value?: string): number | null {
  if (!value) return null;
  const [numeratorText, denominatorText = "1"] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

function probeMedia(filePath: string) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,channel_layout",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr.trim() || "unknown error"}`);
  }
  const payload = JSON.parse(result.stdout) as ProbeOutput;
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const audio = payload.streams?.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds: Number(payload.format?.duration ?? 0),
    formatName: payload.format?.format_name ?? null,
    video: video
      ? {
          codec: video.codec_name ?? null,
          width: video.width ?? null,
          height: video.height ?? null,
          fps: parseRate(video.avg_frame_rate ?? video.r_frame_rate),
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name ?? null,
          sampleRate: Number(audio.sample_rate ?? 0) || null,
          channels: audio.channels ?? null,
          channelLayout: audio.channel_layout ?? null,
        }
      : null,
  };
}

export async function ingestAsset(input: {
  projectDir: string;
  assetPath: string;
  role: string;
  provenance: string;
}) {
  return withProjectStateLock(input.projectDir, "ingest-asset", () => ingestAssetLocked(input));
}

async function ingestAssetLocked(input: {
  projectDir: string;
  assetPath: string;
  role: string;
  provenance: string;
}) {
  const resolvedPath = path.resolve(input.assetPath);
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    throw new Error(`Asset does not exist: ${resolvedPath}`);
  }
  if (!fileStat.isFile()) throw new Error(`Asset is not a file: ${resolvedPath}`);

  const sha256 = await sha256File(resolvedPath);
  const assetId = `asset_${sha256.slice(0, 16)}`;
  const assetsPath = path.join(input.projectDir, ARTIFACT_FILES.assets);
  const assetsFile = await readJson<AssetsFile>(assetsPath);
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  const previous = project.source.assetId ?? assetsFile.assets.find(asset =>
    asset.role === "a-roll" && typeof asset.path === "string" &&
    sourcePathKey(asset.path) === sourcePathKey(project.source.path))?.assetId;
  const selectSource = () => {
    project.source = { path: resolvedPath, assetId };
    if (project.workflowStatus === "intake" || previous !== assetId) project.workflowStatus = "source_registered";
    project.updatedAt = new Date().toISOString();
  };
  const existing = assetsFile.assets.find((asset) => asset.assetId === assetId);
  if (existing) {
    const existingRole = typeof existing.role === "string" ? existing.role : "supplemental";
    const existingRoles = Array.isArray(existing.roles)
      ? existing.roles.filter((role): role is string => typeof role === "string")
      : [existingRole];
    const roles = [...new Set([...existingRoles, input.role])];
    const roleAdded = roles.length !== existingRoles.length;
    existing.roles = roles;
    if (input.role === "a-roll") existing.role = "a-roll";
    if (roleAdded || existing.role !== existingRole) await writeJsonAtomic(assetsPath, assetsFile);

    if (input.role === "a-roll") {
      selectSource();
      await writeJsonAtomic(projectPath, project);
    }
    return { assetId, duplicate: true, roles, media: existing.media ?? null };
  }

  const media = probeMedia(resolvedPath);
  assetsFile.assets.push({
    assetId,
    path: resolvedPath,
    fileName: path.basename(resolvedPath),
    role: input.role,
    roles: [input.role],
    provenance: input.provenance,
    sha256,
    sizeBytes: fileStat.size,
    media,
    rights: { status: new Set(["user-owned", "licensed", "licensed-reference"]).has(input.provenance) ? "cleared" : "unverified" },
    cloudProcessing: [],
    registeredAt: new Date().toISOString(),
  });
  assetsFile.schemaVersion = SCHEMA_VERSION;
  await writeJsonAtomic(assetsPath, assetsFile);

  if (input.role === "a-roll") selectSource();
  project.updatedAt = new Date().toISOString();
  await writeJsonAtomic(projectPath, project);
  return { assetId, duplicate: false, media };
}
