import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";

interface JianyingHandoffInput {
  videoPath: string;
  subtitlePath: string;
  assetPaths: string[];
  decisionPaths: string[];
  manifestPaths: string[];
  targetApplication?: string;
}

type HandoffRole = "video" | "subtitle" | "asset" | "decision" | "manifest";

interface CopyRequest {
  role: HandoffRole;
  sourcePath: string;
  folder: string;
}

interface HandoffFile {
  role: HandoffRole;
  relativePath: string;
  sourcePath: string;
  sizeBytes: number;
  sha256: string;
}

interface ExistingManifest {
  desktopImportStatus?: string;
  targetApplication?: string;
  project?: { projectId?: string };
  files: HandoffFile[];
  controlFiles?: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
  [key: string]: unknown;
}

async function assertFile(filePath: string): Promise<{ path: string; sizeBytes: number }> {
  const resolved = path.resolve(filePath);
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    throw new Error(`Handoff file does not exist: ${resolved}`);
  }
  if (!fileStat.isFile()) throw new Error(`Handoff path is not a file: ${resolved}`);
  return { path: resolved, sizeBytes: fileStat.size };
}

function assertNonEmptyStringArray(value: unknown, key: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${key} must be a non-empty array of file paths`);
  }
}

function validateMp4(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== ".mp4") throw new Error("videoPath must be an MP4 file");
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", filePath],
    { encoding: "utf8", windowsHide: true },
  );
  if (probe.status !== 0) throw new Error(`videoPath is not a readable MP4: ${probe.stderr.trim() || "ffprobe failed"}`);
  const payload = JSON.parse(probe.stdout) as { streams?: Array<{ codec_type?: string }> };
  const streamTypes = new Set(payload.streams?.map((stream) => stream.codec_type));
  if (!streamTypes.has("video") || !streamTypes.has("audio")) {
    throw new Error("videoPath must contain both video and audio streams");
  }
}

async function validateSrt(filePath: string): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== ".srt") throw new Error("subtitlePath must be an SRT file");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filePath));
  } catch {
    throw new Error("subtitlePath must be valid UTF-8 SRT text");
  }
  if (!/(?:^|\r?\n)\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}\r?\n\S/m.test(text)) {
    throw new Error("subtitlePath does not contain a valid SRT cue");
  }
}

function comparableFiles(files: HandoffFile[]): string[] {
  return files
    .map((file) => `${file.role}\u0000${file.relativePath.toLowerCase()}\u0000${file.sha256}`)
    .sort();
}

export async function prepareJianyingHandoff(input: {
  projectDir: string;
  inputPath: string;
  outputDir: string;
}) {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  const config = await readJson<JianyingHandoffInput>(path.resolve(input.inputPath));
  if (typeof config.videoPath !== "string" || !config.videoPath.trim()) throw new Error("videoPath is required");
  if (typeof config.subtitlePath !== "string" || !config.subtitlePath.trim()) throw new Error("subtitlePath is required");
  assertNonEmptyStringArray(config.assetPaths, "assetPaths");
  assertNonEmptyStringArray(config.decisionPaths, "decisionPaths");
  assertNonEmptyStringArray(config.manifestPaths, "manifestPaths");
  const canonicalAssetsManifest = path.resolve(input.projectDir, "assets.json").toLowerCase();
  if (!config.manifestPaths.some((manifestPath) => path.resolve(manifestPath).toLowerCase() === canonicalAssetsManifest)) {
    throw new Error("manifestPaths must include this project's assets.json with source and rights evidence");
  }

  const requests: CopyRequest[] = [
    { role: "video", sourcePath: config.videoPath, folder: "video" },
    { role: "subtitle", sourcePath: config.subtitlePath, folder: "subtitles" },
    ...config.assetPaths.map((sourcePath) => ({ role: "asset" as const, sourcePath, folder: "assets" })),
    ...config.decisionPaths.map((sourcePath) => ({ role: "decision" as const, sourcePath, folder: "decisions" })),
    ...config.manifestPaths.map((sourcePath) => ({ role: "manifest" as const, sourcePath, folder: "manifests" })),
  ];

  const outputDir = path.resolve(input.outputDir);
  const destinations = new Set<string>();
  const files: HandoffFile[] = [];
  for (const request of requests) {
    const source = await assertFile(request.sourcePath);
    const relativePath = path.join(request.folder, path.basename(source.path)).replaceAll("\\", "/");
    const destinationKey = relativePath.toLowerCase();
    if (destinations.has(destinationKey)) throw new Error(`Duplicate handoff destination: ${relativePath}`);
    if (source.path.toLowerCase() === path.join(outputDir, relativePath).toLowerCase()) {
      throw new Error(`Handoff source and destination are identical: ${source.path}`);
    }
    destinations.add(destinationKey);
    files.push({
      role: request.role,
      relativePath,
      sourcePath: source.path,
      sizeBytes: source.sizeBytes,
      sha256: await sha256File(source.path),
    });
  }
  validateMp4(files.find((file) => file.role === "video")!.sourcePath);
  await validateSrt(files.find((file) => file.role === "subtitle")!.sourcePath);
  const targetApplication = config.targetApplication ?? "剪映专业版";
  const readmeContent = `# 剪映接力包\n\n本目录已完成文件与 SHA-256 清单准备，但**不代表已完成剪映桌面导入**，也不承诺第三方可编辑工程转换。\n\n- 项目：${project.title}\n- 当前状态：${project.workflowStatus}\n- 目标应用：${targetApplication}\n- 桌面导入状态：not_tested\n\n请只在全新临时草稿中执行真实导入，并把结果另行记录为桌面 smoke 证据。\n`;
  const readmeEvidence = {
    relativePath: "README.md",
    sizeBytes: Buffer.byteLength(readmeContent, "utf8"),
    sha256: createHash("sha256").update(readmeContent, "utf8").digest("hex"),
  };

  let outputExists = false;
  try {
    const existingOutput = await stat(outputDir);
    if (!existingOutput.isDirectory()) throw new Error(`Handoff output exists and is not a directory: ${outputDir}`);
    outputExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (outputExists) {
    const outputStat = await stat(outputDir);
    if (!outputStat.isDirectory()) throw new Error(`Handoff output exists and is not a directory: ${outputDir}`);
    const existingManifestPath = path.join(outputDir, "jianying-handoff.json");
    const existing = await readJson<ExistingManifest>(existingManifestPath);
    if (!Array.isArray(existing.files) || existing.files.length === 0) {
      throw new Error("Existing handoff manifest has no files");
    }
    if (existing.project?.projectId !== project.projectId || existing.targetApplication !== targetApplication) {
      throw new Error("Handoff output belongs to a different project or target application");
    }
    if (JSON.stringify(comparableFiles(existing.files)) !== JSON.stringify(comparableFiles(files))) {
      throw new Error("Handoff output already exists for a different file set");
    }
    for (const file of existing.files) {
      const packagedPath = path.resolve(outputDir, file.relativePath);
      let packagedHash: string | null = null;
      let packagedSize: number | null = null;
      try {
        const packagedStat = await stat(packagedPath);
        if (packagedStat.isFile()) {
          packagedSize = packagedStat.size;
          packagedHash = await sha256File(packagedPath);
        }
      } catch {
        packagedHash = null;
      }
      if (packagedHash !== file.sha256 || packagedSize !== file.sizeBytes) {
        await writeJson(existingManifestPath, {
          ...existing,
          status: "invalidated",
          desktopImportStatus: "invalidated",
          invalidatedAt: new Date().toISOString(),
          invalidatedReason: `packaged_file_changed:${file.relativePath}`,
        });
        throw new Error(`Existing handoff package file changed; desktop smoke invalidated: ${file.relativePath}`);
      }
    }
    const existingReadmeEvidence = existing.controlFiles?.find((file) => file.relativePath === "README.md");
    let actualReadmeHash: string | null = null;
    let actualReadmeSize: number | null = null;
    try {
      const readmePath = path.join(outputDir, "README.md");
      const readmeStat = await stat(readmePath);
      if (readmeStat.isFile()) {
        actualReadmeSize = readmeStat.size;
        actualReadmeHash = await sha256File(readmePath);
      }
    } catch {
      actualReadmeHash = null;
    }
    if (
      actualReadmeHash !== readmeEvidence.sha256 ||
      actualReadmeSize !== readmeEvidence.sizeBytes ||
      (existingReadmeEvidence !== undefined &&
        (existingReadmeEvidence.sha256 !== readmeEvidence.sha256 ||
          existingReadmeEvidence.sizeBytes !== readmeEvidence.sizeBytes))
    ) {
      await writeJson(existingManifestPath, {
        ...existing,
        status: "invalidated",
        desktopImportStatus: "invalidated",
        invalidatedAt: new Date().toISOString(),
        invalidatedReason: "control_file_changed:README.md",
      });
      throw new Error("Existing handoff README changed; desktop smoke invalidated: README.md");
    }
    if (!existingReadmeEvidence) {
      existing.controlFiles = [readmeEvidence];
      await writeJson(existingManifestPath, {
        ...existing,
        controlFiles: existing.controlFiles,
        evidenceUpgradedAt: new Date().toISOString(),
      });
    }
    return {
      outputDir,
      manifestPath: path.join(outputDir, "jianying-handoff.json"),
      fileCount: files.length,
      idempotent: true,
      desktopImportStatus: existing.desktopImportStatus ?? "not_tested",
    };
  }

  const manifest = {
    schemaVersion: "1.0.0",
    status: "prepared_not_imported",
    desktopImportStatus: "not_tested",
    editableProjectConversionGuaranteed: false,
    targetApplication,
    project: {
      projectId: project.projectId,
      title: project.title,
      workflowStatus: project.workflowStatus,
    },
    files,
    controlFiles: [readmeEvidence],
    preparedAt: new Date().toISOString(),
    requiredManualChecks: [
      "在全新临时草稿中导入 MP4 和 SRT",
      "核对字幕编码、断句、时间线和画幅",
      "确认素材授权与字体/音乐许可",
      "不得把本交付包描述为第三方可编辑工程转换",
    ],
  };

  await mkdir(path.dirname(outputDir), { recursive: true });
  const tempDir = await mkdtemp(path.join(path.dirname(outputDir), `.${path.basename(outputDir)}.tmp-`));
  try {
    for (const file of files) {
      const destination = path.join(tempDir, file.relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.sourcePath, destination);
      if ((await sha256File(destination)) !== file.sha256) {
        throw new Error(`Copied handoff file failed hash verification: ${file.relativePath}`);
      }
    }
    await writeFile(path.join(tempDir, "README.md"), readmeContent, "utf8");
    await writeJson(path.join(tempDir, "jianying-handoff.json"), manifest);
    await rename(tempDir, outputDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    outputDir,
    manifestPath: path.join(outputDir, "jianying-handoff.json"),
    fileCount: files.length,
    idempotent: false,
    desktopImportStatus: "not_tested",
  };
}
