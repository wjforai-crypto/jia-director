import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { canonicalJson } from "./canonical-json.js";
import { readJson } from "./json-store.js";
import { sha256File } from "./media.js";

export interface AssetRecord {
  assetId: string;
  path: string;
  role: string;
  sha256: string;
  media?: { durationSeconds?: number };
}

interface AssetsFile {
  assets: AssetRecord[];
}

interface AutoEditorClip {
  src: string;
  start: number;
  dur: number;
  offset: number;
  stream: number;
  effects?: string[];
}

interface AutoEditorTimelineV3 {
  version: string;
  templateFile?: string;
  timebase: string;
  v: AutoEditorClip[][];
  a: AutoEditorClip[][];
  transitions?: unknown;
}

export interface MechanicalCandidate {
  candidateId: string;
  kind: "keep_candidate" | "cut_candidate";
  sourceStartFrame: number;
  sourceEndFrameExclusive: number;
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartFrame?: number;
  reason: string;
}

export interface MechanicalCandidateArtifact {
  schemaVersion: typeof SCHEMA_VERSION;
  authority: "candidate_only";
  mayMutateCutPlan: false;
  provider: {
    name: "auto-editor";
    version: string;
    executablePath: string;
    executableSha256: string;
    isolatedCopy: true;
  };
  source: {
    assetId: string;
    path: string;
    sha256: string;
    durationSeconds: number;
  };
  parameters: {
    edit: string;
    margin: string;
    smooth: string;
  };
  timebase: string;
  rawTimeline: { path: string; sha256: string };
  candidates: MechanicalCandidate[];
  generatedAt: string;
}

function parseTimebase(value: string): number {
  const [numeratorText, denominatorText = "1"] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error(`Invalid auto-editor timebase: ${value}`);
  }
  return numerator / denominator;
}

function stableCandidateId(input: object): string {
  return `mechanical_${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex").slice(0, 24)}`;
}

function normalizedPath(filePath: string): string {
  return path.resolve(filePath).replaceAll("/", "\\").toLowerCase();
}

export function selectCurrentSourceAsset(assets: AssetRecord[], currentSourcePath: string): AssetRecord {
  const matches = assets.filter(
    (asset) => asset.role === "a-roll" && normalizedPath(asset.path) === normalizedPath(currentSourcePath),
  );
  if (matches.length !== 1) {
    throw new Error(`Mechanical candidate probe requires exactly one registered a-roll matching project.source.path; found ${matches.length}`);
  }
  return matches[0]!;
}

function assertPlainClip(clip: AutoEditorClip, expectedSourcePath: string): void {
  if (![clip.start, clip.dur, clip.offset, clip.stream].every((value) => Number.isInteger(value) && value >= 0) || clip.dur <= 0) {
    throw new Error("auto-editor timeline contains non-Natural or zero-duration clip fields");
  }
  if (clip.stream !== 0) throw new Error("Mechanical candidate adapter accepts only source stream 0");
  if (clip.effects !== undefined) throw new Error("Mechanical candidate adapter rejects v3 clip effects");
  if (normalizedPath(clip.src) !== normalizedPath(expectedSourcePath)) {
    throw new Error(`auto-editor timeline references an unexpected source: ${clip.src}`);
  }
}

function clipIdentity(clip: AutoEditorClip) {
  return {
    src: normalizedPath(clip.src),
    start: clip.start,
    dur: clip.dur,
    offset: clip.offset,
    stream: clip.stream,
  };
}

function sameClipMap(left: AutoEditorClip[], right: AutoEditorClip[]): boolean {
  return canonicalJson(left.map(clipIdentity)) === canonicalJson(right.map(clipIdentity));
}

export function buildMechanicalCandidates(input: {
  timeline: AutoEditorTimelineV3;
  timelineSourcePath?: string;
  sourcePath: string;
  sourceSha256: string;
  sourceDurationSeconds: number;
  executableSha256: string;
  parameters: { edit: string; margin: string; smooth: string };
}): { timebase: string; candidates: MechanicalCandidate[] } {
  if (input.timeline.version !== "3") throw new Error(`Expected auto-editor v3 timeline, got ${input.timeline.version}`);
  if (input.timeline.transitions !== undefined) throw new Error("Mechanical candidate adapter rejects v3 transitions");
  if (input.timeline.v.length !== 1 || !input.timeline.v[0] || input.timeline.v[0].length === 0) {
    throw new Error("Mechanical candidate adapter requires exactly one non-empty video track");
  }
  if (input.timeline.a.length !== 1 || !input.timeline.a[0] || input.timeline.a[0].length === 0) {
    throw new Error("Mechanical candidate adapter requires exactly one non-empty audio track");
  }

  const timelineSourcePath = input.timelineSourcePath ?? input.sourcePath;
  if (input.timeline.templateFile && normalizedPath(input.timeline.templateFile) !== normalizedPath(timelineSourcePath)) {
    throw new Error("auto-editor templateFile does not match the isolated source");
  }
  const clips = input.timeline.v[0];
  const audioClips = input.timeline.a[0];
  for (const clip of [...clips, ...audioClips]) assertPlainClip(clip, timelineSourcePath);
  if (!sameClipMap(clips, audioClips)) throw new Error("auto-editor audio/video candidate maps differ");

  const fps = parseTimebase(input.timeline.timebase);
  const totalFrames = Math.round(input.sourceDurationSeconds * fps);
  const candidates: MechanicalCandidate[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const clip of clips) {
    if (clip.start !== outputCursor) throw new Error("auto-editor output clips are not contiguous from frame zero");
    if (clip.offset < sourceCursor) throw new Error("auto-editor timeline reorders or overlaps source intervals");
    if (clip.offset > sourceCursor) {
      candidates.push(makeCandidate("cut_candidate", sourceCursor, clip.offset, fps, input, undefined));
    }
    const sourceEnd = clip.offset + clip.dur;
    if (sourceEnd > totalFrames) throw new Error("auto-editor timeline extends beyond the registered source duration");
    candidates.push(makeCandidate("keep_candidate", clip.offset, sourceEnd, fps, input, clip.start));
    sourceCursor = sourceEnd;
    outputCursor += clip.dur;
  }
  if (sourceCursor < totalFrames) {
    candidates.push(makeCandidate("cut_candidate", sourceCursor, totalFrames, fps, input, undefined));
  }
  return { timebase: input.timeline.timebase, candidates };
}

function makeCandidate(
  kind: MechanicalCandidate["kind"],
  startFrame: number,
  endFrame: number,
  fps: number,
  input: {
    sourceSha256: string;
    executableSha256: string;
    parameters: { edit: string; margin: string; smooth: string };
  },
  outputStartFrame: number | undefined,
): MechanicalCandidate {
  const identity = {
    sourceSha256: input.sourceSha256,
    executableSha256: input.executableSha256,
    parameters: input.parameters,
    kind,
    startFrame,
    endFrame,
  };
  return {
    candidateId: stableCandidateId(identity),
    kind,
    sourceStartFrame: startFrame,
    sourceEndFrameExclusive: endFrame,
    sourceStartMs: Math.round((startFrame / fps) * 1000),
    sourceEndMs: Math.round((endFrame / fps) * 1000),
    ...(outputStartFrame === undefined ? {} : { outputStartFrame }),
    reason: kind === "cut_candidate" ? "Mechanical inactive interval; semantic review required" : "Mechanical active interval; retained by provider",
  };
}

async function assertDedicatedOutput(projectDir: string, outputPath: string): Promise<string> {
  const projectRoot = path.resolve(projectDir);
  const resolved = path.resolve(outputPath);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Mechanical candidate output must be a dedicated file inside the project directory");
  }
  if (!/^mechanical-candidates(?:[._-][a-z0-9_-]+)*\.json$/i.test(path.basename(resolved))) {
    throw new Error("Mechanical candidate output must be named mechanical-candidates*.json");
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const [realProjectRoot, realOutputParent] = await Promise.all([realpath(projectRoot), realpath(path.dirname(resolved))]);
  const realRelative = path.relative(realProjectRoot, realOutputParent);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Mechanical candidate output parent resolves outside the project directory");
  }
  const existing = await lstat(resolved).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && existing.nlink > 1)) {
    throw new Error("Mechanical candidate output cannot be a symbolic link or hard link");
  }
  return resolved;
}

async function snapshotProtectedFiles(projectDir: string): Promise<Map<string, string>> {
  const files = ["project.json", ...Object.values(ARTIFACT_FILES)].map((fileName) => path.join(projectDir, fileName));
  const result = new Map<string, string>();
  for (const filePath of files) result.set(filePath, await sha256File(filePath));
  return result;
}

async function assertProtectedFilesUnchanged(before: Map<string, string>): Promise<void> {
  for (const [filePath, expected] of before) {
    const actual = await sha256File(filePath);
    if (actual !== expected) throw new Error(`auto-editor changed a protected workflow contract: ${filePath}`);
  }
}

async function writeJsonReplaceAtomic(filePath: string, payload: unknown): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${suffix}`);
  const backupPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.previous-${suffix}`);
  let movedExisting = false;
  try {
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (await lstat(filePath).catch(() => null)) {
      await rename(filePath, backupPath);
      movedExisting = true;
    }
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      if (movedExisting) await rename(backupPath, filePath).catch(() => undefined);
      throw error;
    }
    if (movedExisting) await rm(backupPath, { force: true }).catch(() => undefined);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function cleanVersion(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function probeMechanicalCandidates(input: {
  projectDir: string;
  executablePath: string;
  expectedExecutableSha256: string;
  outputPath: string;
  edit?: string;
  margin?: string;
  smooth?: string;
}): Promise<MechanicalCandidateArtifact> {
  const executablePath = path.resolve(input.executablePath);
  const executableStat = await stat(executablePath).catch(() => null);
  if (!executableStat?.isFile()) throw new Error(`auto-editor executable does not exist: ${executablePath}`);
  const executableSha256 = await sha256File(executablePath);
  if (executableSha256 !== input.expectedExecutableSha256.toLowerCase()) {
    throw new Error(`auto-editor SHA-256 mismatch: expected ${input.expectedExecutableSha256.toLowerCase()}, got ${executableSha256}`);
  }

  const outputPath = await assertDedicatedOutput(input.projectDir, input.outputPath);
  const [project, assets] = await Promise.all([
    readJson<VideoProject>(path.join(input.projectDir, "project.json")),
    readJson<AssetsFile>(path.join(input.projectDir, ARTIFACT_FILES.assets)),
  ]);
  const source = selectCurrentSourceAsset(assets.assets, project.source.path);
  const sourcePath = path.resolve(source.path);
  const sourceHashBefore = await sha256File(sourcePath);
  if (sourceHashBefore !== source.sha256) throw new Error("Registered a-roll hash no longer matches the source file");
  const durationSeconds = Number(source.media?.durationSeconds ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Registered a-roll has no valid duration");

  const parameters = {
    edit: input.edit ?? "audio:-35dB",
    margin: input.margin ?? "0",
    smooth: input.smooth ?? "0",
  };
  const beforeContracts = await snapshotProtectedFiles(input.projectDir);
  const outputDir = path.dirname(outputPath);
  const tempDir = await mkdtemp(path.join(outputDir, ".video-flow-auto-editor-"));
  const executableExtension = path.extname(executablePath) || ".exe";
  const versionExecutablePath = path.join(tempDir, `auto-editor-version${executableExtension}`);
  const stagedExecutablePath = path.join(tempDir, `auto-editor-probe${executableExtension}`);
  const stagedSourcePath = path.join(tempDir, `source${path.extname(sourcePath) || ".mp4"}`);
  const tempRawPath = path.join(tempDir, "timeline.v3");
  let operationError: Error | null = null;
  let prepared: { version: string; normalized: ReturnType<typeof buildMechanicalCandidates>; rawSha256: string } | null = null;

  try {
    try {
      await copyFile(executablePath, versionExecutablePath);
      if ((await sha256File(versionExecutablePath)) !== executableSha256) {
        throw new Error("Isolated auto-editor version copy failed hash verification");
      }
      const versionResult = spawnSync(versionExecutablePath, ["--version"], {
        cwd: tempDir,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      if (versionResult.error || versionResult.status !== 0) throw new Error("Unable to verify auto-editor version before the probe");
      const version = cleanVersion(versionResult.stdout || versionResult.stderr || "unknown");

      await Promise.all([copyFile(executablePath, stagedExecutablePath), copyFile(sourcePath, stagedSourcePath)]);
      const [stagedExecutableSha256, stagedSourceSha256] = await Promise.all([
        sha256File(stagedExecutablePath),
        sha256File(stagedSourcePath),
      ]);
      if (stagedExecutableSha256 !== executableSha256 || stagedSourceSha256 !== sourceHashBefore) {
        throw new Error("Isolated auto-editor probe copies failed hash verification");
      }

      const result = spawnSync(
        stagedExecutablePath,
        [
          stagedSourcePath,
          "--edit",
          parameters.edit,
          "--margin",
          parameters.margin,
          "--smooth",
          parameters.smooth,
          "--export",
          "v3",
          "-o",
          tempRawPath,
          "--no-cache",
          "--no-open",
        ],
        { cwd: tempDir, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const [stagedExecutableSha256After, stagedSourceSha256After] = await Promise.all([
        sha256File(stagedExecutablePath),
        sha256File(stagedSourcePath),
      ]);
      if (stagedExecutableSha256After !== executableSha256 || stagedSourceSha256After !== sourceHashBefore) {
        throw new Error("Isolated auto-editor probe copies changed during execution");
      }
      if (result.error) throw new Error(`auto-editor probe failed: ${result.error.message}`);
      if (result.status !== 0) {
        throw new Error(`auto-editor probe failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
      }

      const timeline = JSON.parse(await readFile(tempRawPath, "utf8")) as AutoEditorTimelineV3;
      const normalized = buildMechanicalCandidates({
        timeline,
        timelineSourcePath: stagedSourcePath,
        sourcePath,
        sourceSha256: source.sha256,
        sourceDurationSeconds: durationSeconds,
        executableSha256,
        parameters,
      });
      prepared = { version, normalized, rawSha256: await sha256File(tempRawPath) };
    } catch (error) {
      operationError = asError(error);
    }

    let integrityError: Error | null = null;
    try {
      await assertProtectedFilesUnchanged(beforeContracts);
      const sourceHashAfter = await sha256File(sourcePath);
      if (sourceHashAfter !== sourceHashBefore) throw new Error("auto-editor changed the registered source file");
    } catch (error) {
      integrityError = asError(error);
    }
    if (integrityError) {
      throw new Error(`Mechanical candidate integrity breach: ${integrityError.message}${operationError ? `; operation error: ${operationError.message}` : ""}`);
    }
    if (operationError) throw operationError;
    if (!prepared) throw new Error("Mechanical candidate probe produced no validated result");

    const rawTimelinePath = outputPath.replace(/\.json$/i, `.auto-editor.${prepared.rawSha256.slice(0, 16)}.v3`);
    const existingRaw = await lstat(rawTimelinePath).catch(() => null);
    if (existingRaw?.isSymbolicLink() || (existingRaw && existingRaw.nlink > 1)) {
      throw new Error("Raw auto-editor timeline cannot be a symbolic link or hard link");
    }
    try {
      await copyFile(tempRawPath, rawTimelinePath, constants.COPYFILE_EXCL);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || (await sha256File(rawTimelinePath)) !== prepared.rawSha256) throw error;
    }

    const artifact: MechanicalCandidateArtifact = {
      schemaVersion: SCHEMA_VERSION,
      authority: "candidate_only",
      mayMutateCutPlan: false,
      provider: { name: "auto-editor", version: prepared.version, executablePath, executableSha256, isolatedCopy: true },
      source: { assetId: source.assetId, path: sourcePath, sha256: source.sha256, durationSeconds },
      parameters,
      timebase: prepared.normalized.timebase,
      rawTimeline: { path: rawTimelinePath, sha256: prepared.rawSha256 },
      candidates: prepared.normalized.candidates,
      generatedAt: new Date().toISOString(),
    };
    await writeJsonReplaceAtomic(outputPath, artifact);
    return artifact;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
