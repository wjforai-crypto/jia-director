import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256Canonical } from "./canonical-json.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface AssetRecord {
  assetId: string;
  path: string;
  role: string;
  sha256: string;
}

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  p?: number;
}

interface WhisperSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: WhisperToken[];
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperSegment[];
}

function stableId(prefix: string, parts: unknown[]): string {
  const digest = sha256Canonical(parts).slice(0, 24);
  return `${prefix}_${digest}`;
}

function isSpokenToken(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !/^\[_.*\]$/.test(trimmed);
}

function normalizeWhisper(payload: WhisperJson, sourceAsset: AssetRecord, engine: string) {
  const words: Array<Record<string, unknown> & { id: string; start: number; end: number; text: string; confidence: number | null }> = [];
  const segments = (payload.transcription ?? []).map((segment, segmentIndex) => {
    const segmentStart = Number(segment.offsets?.from ?? 0) / 1000;
    const segmentEnd = Number(segment.offsets?.to ?? 0) / 1000;
    const wordIds: string[] = [];
    for (const [tokenIndex, token] of (segment.tokens ?? []).entries()) {
      const text = token.text?.normalize("NFC").trim() ?? "";
      if (!isSpokenToken(text)) continue;
      const startMilliseconds = Number(token.offsets?.from ?? segment.offsets?.from ?? 0);
      const endMilliseconds = Number(token.offsets?.to ?? segment.offsets?.to ?? 0);
      const start = startMilliseconds / 1000;
      const end = endMilliseconds / 1000;
      const id = stableId("w", [sourceAsset.assetId, startMilliseconds, endMilliseconds, text, segmentIndex, tokenIndex]);
      const confidence = typeof token.p === "number" ? Number(token.p.toFixed(6)) : null;
      words.push({ id, text, start, end, confidence, speaker: null, sourceAssetId: sourceAsset.assetId });
      wordIds.push(id);
    }
    return {
      id: stableId("seg", [sourceAsset.assetId, segmentStart, segmentEnd, segment.text ?? "", segmentIndex]),
      text: segment.text?.normalize("NFC").trim() ?? "",
      start: segmentStart,
      end: segmentEnd,
      speaker: null,
      wordIds,
      sourceAssetId: sourceAsset.assetId,
    };
  });
  if (new Set(words.map((word) => word.id)).size !== words.length) {
    throw new Error("Stable word ID collision detected; transcription was not written");
  }
  const lowConfidenceWordIds = words
    .filter((word) => word.confidence !== null && word.confidence < 0.2)
    .map((word) => word.id);
  const contentHash = sha256Canonical({ segments, words });
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceAssetId: sourceAsset.assetId,
    sourceAssetHash: sourceAsset.sha256,
    engine,
    language: payload.result?.language ?? "unknown",
    segments,
    words,
    lowConfidenceWordIds,
    asrReviewStatus: lowConfidenceWordIds.length > 0 ? "needs_review" : "review_pending",
    contentHash,
    generatedAt: new Date().toISOString(),
  };
}

function runProcess(executable: string, args: string[], label: string): void {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
  }
}

async function loadSourceAsset(projectDir: string): Promise<AssetRecord> {
  const assets = await readJson<{ assets: AssetRecord[] }>(path.join(projectDir, ARTIFACT_FILES.assets));
  const source = assets.assets.find((asset) => asset.role === "a-roll");
  if (!source) throw new Error("transcribe requires a registered a-roll asset");
  return source;
}

export async function transcribeProject(input: {
  projectDir: string;
  engine: "import" | "whisper";
  inputPath?: string;
  language?: string;
  whisperCli?: string;
  model?: string;
}) {
  return withProjectStateLock(input.projectDir, "transcribe-project", () => transcribeProjectLocked(input));
}

async function transcribeProjectLocked(input: {
  projectDir: string;
  engine: "import" | "whisper";
  inputPath?: string;
  language?: string;
  whisperCli?: string;
  model?: string;
}) {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  if (project.workflowStatus !== "source_registered") {
    throw new Error(`transcribe requires source_registered, got ${project.workflowStatus}`);
  }
  const sourceAsset = await loadSourceAsset(input.projectDir);
  let whisperJsonPath: string;
  let engineName: string;

  if (input.engine === "import") {
    if (!input.inputPath) throw new Error("transcribe --engine import requires --input");
    whisperJsonPath = path.resolve(input.inputPath);
    engineName = "import-whisper-json";
  } else {
    const whisperCli = input.whisperCli ?? "E:\\AI-workspace\\tools\\whisper.cpp\\v1.9.1\\whisper-cli.exe";
    const model = input.model ?? path.join(process.env.USERPROFILE ?? "", ".cache", "hyperframes", "whisper", "models", "ggml-small.bin");
    const cacheDir = path.join(input.projectDir, ".cache", "transcribe");
    await mkdir(cacheDir, { recursive: true });
    const wavPath = path.join(cacheDir, `${sourceAsset.assetId}.wav`);
    const outputPrefix = path.join(cacheDir, `${sourceAsset.assetId}-whisper`);
    runProcess(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", sourceAsset.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wavPath],
      "ffmpeg audio extraction",
    );
    runProcess(
      whisperCli,
      ["-m", model, "-f", wavPath, "-l", input.language ?? "zh", "-sow", "-ojf", "-of", outputPrefix, "-np"],
      "whisper.cpp transcription",
    );
    whisperJsonPath = `${outputPrefix}.json`;
    engineName = "whisper.cpp-v1.9.1-small";
  }

  const payload = await readJson<WhisperJson>(whisperJsonPath);
  const normalized = normalizeWhisper(payload, sourceAsset, engineName);
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.transcript), normalized);
  return {
    engine: normalized.engine,
    words: normalized.words.length,
    segments: normalized.segments.length,
    asrReviewStatus: normalized.asrReviewStatus,
  };
}
