import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REFERENCE_ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { sha256Canonical } from "./canonical-json.js";
import { readJson, writeJson, writeJsonAtomic } from "./json-store.js";
import { sha256File } from "./media.js";
import { withProjectStateLock } from "./project-state-lock.js";

type ReferenceReviewStatus = "asr_unreviewed" | "asr_corrected" | "human_verified";

interface ReferenceAsset {
  assetId: string;
  path: string;
  role: string;
  sha256: string;
  provenance: string;
  rights?: { status?: string };
  media?: {
    durationSeconds?: number;
    formatName?: string | null;
    video?: { codec?: string | null; width?: number | null; height?: number | null; fps?: number | null } | null;
    audio?: { codec?: string | null; sampleRate?: number | null; channels?: number | null } | null;
  };
}

interface TranscriptItemInput {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  confidence?: number | null;
}

interface ReferenceShotInput {
  slug: string;
  sourceIn: number;
  sourceOut: number;
  shotSize: string;
  composition: string;
  cameraPosition: string;
  cameraMovement: string;
  subjectAction: string;
  visualFunction: string;
  onScreenText?: string[];
  transitionIn: string;
  transitionOut: string;
  audio: { dialogue: string; sfx?: string[]; musicCue: string };
  evidence?: string[];
  confidence: number;
}

interface ReferenceAnalysisInput {
  sourceUrl?: string;
  acquisition: {
    method: "user_provided" | "approved_downloader" | "local_capture";
    tool: string;
    retrievedAt: string;
  };
  intendedUse: "analysis_only" | "analysis_and_original_recreation" | "authorized_close_recreation";
  rightsNotes: string[];
  referenceVerbatimTranscript: {
    language: string;
    reviewStatus: ReferenceReviewStatus;
    segments: TranscriptItemInput[];
    words?: TranscriptItemInput[];
  };
  shots: ReferenceShotInput[];
  editGrammar: {
    hook: string;
    structure: string[];
    pacing: string;
    captions: string;
    transitions: string;
    broll: string;
    motionGraphics: string;
    soundDesign: string;
    music: string;
  };
  transferablePatterns: Array<{ name: string; evidence: string[]; adaptation: string }>;
  protectedElements: string[];
  unknowns?: string[];
}

export interface ReferenceAnalysisArtifact {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "reference-video-analysis";
  status: "needs_review" | "approved" | "needs_revision" | "stale";
  source: {
    assetId: string;
    path: string;
    sha256: string;
    assetEvidenceHash: string;
    sourceUrl: string | null;
    provenance: string;
    rightsStatus: string;
    intendedUse: ReferenceAnalysisInput["intendedUse"];
    rightsNotes: string[];
    acquisition: ReferenceAnalysisInput["acquisition"];
    privacyClassification: VideoProject["privacy"]["classification"];
    media: ReferenceAsset["media"];
  };
  referenceVerbatimTranscript: {
    language: string;
    reviewStatus: ReferenceReviewStatus;
    fullText: string;
    segments: Array<TranscriptItemInput & { id: string }>;
    words: Array<TranscriptItemInput & { id: string }>;
  };
  shots: Array<ReferenceShotInput & { id: string }>;
  editGrammar: ReferenceAnalysisInput["editGrammar"];
  transferablePatterns: ReferenceAnalysisInput["transferablePatterns"];
  protectedElements: string[];
  unknowns: string[];
  inputHash: string;
  contentHash: string;
  approvedContentHash: string | null;
  reviews: Array<Record<string, unknown>>;
  generatedAt: string;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text`);
  return value.normalize("NFC").trim();
}

function textArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function finiteTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return Number(value.toFixed(3));
}

function confidence(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between zero and one`);
  }
  return Number(value.toFixed(6));
}

function normalizeTranscriptComparison(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/(?<=\d)[.,](?=\d)/gu, "小数点")
    .replace(/[%％]/gu, "百分号")
    .replace(/[+＋]/gu, "加号")
    .replace(/[-−]/gu, "减号")
    .replace(/[$＄]/gu, "美元符号")
    .replace(/[¥￥]/gu, "人民币符号")
    .replace(/[€]/gu, "欧元符号")
    .replace(/[£]/gu, "英镑符号")
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function normalizeTranscriptItems(
  items: TranscriptItemInput[] | undefined,
  prefix: "rseg" | "rword",
  asset: ReferenceAsset,
  label: string,
) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  let previousEnd = -1;
  return items.map((item, index) => {
    assertRecord(item, `${label}[${index}]`);
    const start = finiteTime(item.start, `${label}[${index}].start`);
    const end = finiteTime(item.end, `${label}[${index}].end`);
    if (end <= start) throw new Error(`${label}[${index}] must end after it starts`);
    const duration = Number(asset.media?.durationSeconds ?? 0);
    if (duration > 0 && end > duration + 0.25) throw new Error(`${label}[${index}] extends past the registered media duration`);
    if (start + 0.001 < previousEnd) throw new Error(`${label} must be ordered without overlaps`);
    previousEnd = end;
    const itemText = text(item.text, `${label}[${index}].text`);
    const speaker = item.speaker ? text(item.speaker, `${label}[${index}].speaker`) : null;
    const normalized = {
      start,
      end,
      text: itemText,
      speaker,
      confidence: confidence(item.confidence, `${label}[${index}].confidence`),
    };
    return {
      id: `${prefix}_${sha256Canonical([asset.assetId, asset.sha256, start, end, itemText, index]).slice(0, 20)}`,
      ...normalized,
    };
  });
}

function normalizeInput(
  raw: ReferenceAnalysisInput,
  asset: ReferenceAsset,
  privacyClassification: VideoProject["privacy"]["classification"],
): Omit<ReferenceAnalysisArtifact, "schemaVersion" | "kind" | "status" | "inputHash" | "contentHash" | "approvedContentHash" | "reviews" | "generatedAt"> {
  assertRecord(raw, "Reference analysis input");
  const allowedUses = new Set(["analysis_only", "analysis_and_original_recreation", "authorized_close_recreation"]);
  if (!allowedUses.has(raw.intendedUse)) throw new Error(`Unsupported reference intendedUse: ${String(raw.intendedUse)}`);
  const rightsNotes = textArray(raw.rightsNotes, "rightsNotes");
  assertRecord(raw.acquisition, "acquisition");
  const acquisitionMethods = new Set(["user_provided", "approved_downloader", "local_capture"]);
  if (!acquisitionMethods.has(raw.acquisition.method)) {
    throw new Error(`Unsupported acquisition method: ${String(raw.acquisition.method)}`);
  }
  const retrievedAt = text(raw.acquisition.retrievedAt, "acquisition.retrievedAt");
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error("acquisition.retrievedAt must be an ISO-8601 timestamp");
  const acquisition = {
    method: raw.acquisition.method,
    tool: text(raw.acquisition.tool, "acquisition.tool"),
    retrievedAt: new Date(retrievedAt).toISOString(),
  };
  assertRecord(raw.referenceVerbatimTranscript, "referenceVerbatimTranscript");
  const language = text(raw.referenceVerbatimTranscript.language, "referenceVerbatimTranscript.language");
  const allowedReview = new Set<ReferenceReviewStatus>(["asr_unreviewed", "asr_corrected", "human_verified"]);
  if (!allowedReview.has(raw.referenceVerbatimTranscript.reviewStatus)) {
    throw new Error(`Unsupported transcript reviewStatus: ${String(raw.referenceVerbatimTranscript.reviewStatus)}`);
  }
  const segments = normalizeTranscriptItems(raw.referenceVerbatimTranscript.segments, "rseg", asset, "referenceVerbatimTranscript.segments");
  const words = normalizeTranscriptItems(raw.referenceVerbatimTranscript.words, "rword", asset, "referenceVerbatimTranscript.words");
  for (const word of words) {
    if (!segments.some((segment) => word.start + 0.001 >= segment.start && word.end <= segment.end + 0.001)) {
      throw new Error(`Reference word ${word.text} is not contained in any transcript segment`);
    }
  }
  for (const segment of segments) {
    const segmentWords = words.filter((word) => word.start + 0.001 >= segment.start && word.end <= segment.end + 0.001);
    const reconstructed = normalizeTranscriptComparison(segmentWords.map((word) => word.text).join(""));
    if (reconstructed !== normalizeTranscriptComparison(segment.text)) {
      throw new Error(`Reference words do not reconstruct transcript segment: ${segment.text}`);
    }
  }

  if (!Array.isArray(raw.shots) || raw.shots.length === 0) throw new Error("shots must be a non-empty array");
  const slugs = new Set<string>();
  let previousOut = -1;
  const duration = Number(asset.media?.durationSeconds ?? 0);
  const shots = raw.shots.map((shot, index) => {
    assertRecord(shot, `shots[${index}]`);
    const slug = text(shot.slug, `shots[${index}].slug`);
    if (slugs.has(slug)) throw new Error(`Duplicate reference shot slug: ${slug}`);
    slugs.add(slug);
    const sourceIn = finiteTime(shot.sourceIn, `shots[${index}].sourceIn`);
    const sourceOut = finiteTime(shot.sourceOut, `shots[${index}].sourceOut`);
    if (sourceOut <= sourceIn) throw new Error(`Reference shot ${slug} must end after it starts`);
    if (sourceIn + 0.001 < previousOut) throw new Error(`Reference shots overlap before ${slug}`);
    if (duration > 0 && sourceOut > duration + 0.25) throw new Error(`Reference shot ${slug} extends past the registered media duration`);
    previousOut = sourceOut;
    assertRecord(shot.audio, `shots[${index}].audio`);
    const normalized: ReferenceShotInput = {
      slug,
      sourceIn,
      sourceOut,
      shotSize: text(shot.shotSize, `shots[${index}].shotSize`),
      composition: text(shot.composition, `shots[${index}].composition`),
      cameraPosition: text(shot.cameraPosition, `shots[${index}].cameraPosition`),
      cameraMovement: text(shot.cameraMovement, `shots[${index}].cameraMovement`),
      subjectAction: text(shot.subjectAction, `shots[${index}].subjectAction`),
      visualFunction: text(shot.visualFunction, `shots[${index}].visualFunction`),
      onScreenText: textArray(shot.onScreenText ?? [], `shots[${index}].onScreenText`, true),
      transitionIn: text(shot.transitionIn, `shots[${index}].transitionIn`),
      transitionOut: text(shot.transitionOut, `shots[${index}].transitionOut`),
      audio: {
        dialogue: text(shot.audio.dialogue, `shots[${index}].audio.dialogue`),
        sfx: textArray(shot.audio.sfx ?? [], `shots[${index}].audio.sfx`, true),
        musicCue: text(shot.audio.musicCue, `shots[${index}].audio.musicCue`),
      },
      evidence: textArray(shot.evidence ?? [], `shots[${index}].evidence`, true),
      confidence: confidence(shot.confidence, `shots[${index}].confidence`) ?? 0,
    };
    return {
      id: `rshot_${sha256Canonical([asset.assetId, asset.sha256, sourceIn, sourceOut, slug, normalized.visualFunction]).slice(0, 20)}`,
      ...normalized,
    };
  });

  assertRecord(raw.editGrammar, "editGrammar");
  const editGrammar = {
    hook: text(raw.editGrammar.hook, "editGrammar.hook"),
    structure: textArray(raw.editGrammar.structure, "editGrammar.structure"),
    pacing: text(raw.editGrammar.pacing, "editGrammar.pacing"),
    captions: text(raw.editGrammar.captions, "editGrammar.captions"),
    transitions: text(raw.editGrammar.transitions, "editGrammar.transitions"),
    broll: text(raw.editGrammar.broll, "editGrammar.broll"),
    motionGraphics: text(raw.editGrammar.motionGraphics, "editGrammar.motionGraphics"),
    soundDesign: text(raw.editGrammar.soundDesign, "editGrammar.soundDesign"),
    music: text(raw.editGrammar.music, "editGrammar.music"),
  };

  if (!Array.isArray(raw.transferablePatterns) || raw.transferablePatterns.length === 0) {
    throw new Error("transferablePatterns must be a non-empty array");
  }
  const transferablePatterns = raw.transferablePatterns.map((pattern, index) => {
    assertRecord(pattern, `transferablePatterns[${index}]`);
    const evidence = textArray(pattern.evidence, `transferablePatterns[${index}].evidence`);
    for (const slug of evidence) {
      if (!slugs.has(slug)) throw new Error(`Unknown reference shot slug in transferablePatterns: ${slug}`);
    }
    return {
      name: text(pattern.name, `transferablePatterns[${index}].name`),
      evidence,
      adaptation: text(pattern.adaptation, `transferablePatterns[${index}].adaptation`),
    };
  });

  return {
    source: {
      assetId: asset.assetId,
      path: path.resolve(asset.path),
      sha256: asset.sha256,
      assetEvidenceHash: referenceAssetEvidenceHash(asset),
      sourceUrl: raw.sourceUrl ? text(raw.sourceUrl, "sourceUrl") : null,
      provenance: asset.provenance,
      rightsStatus: asset.rights?.status ?? "unverified",
      intendedUse: raw.intendedUse,
      rightsNotes,
      acquisition,
      privacyClassification,
      media: asset.media,
    },
    referenceVerbatimTranscript: {
      language,
      reviewStatus: raw.referenceVerbatimTranscript.reviewStatus,
      fullText: segments.map((segment) => segment.text).join(""),
      segments,
      words,
    },
    shots,
    editGrammar,
    transferablePatterns,
    protectedElements: textArray(raw.protectedElements, "protectedElements"),
    unknowns: textArray(raw.unknowns ?? [], "unknowns", true),
  };
}

export function referenceAnalysisContent(analysis: ReferenceAnalysisArtifact) {
  return {
    source: analysis.source,
    referenceVerbatimTranscript: analysis.referenceVerbatimTranscript,
    shots: analysis.shots,
    editGrammar: analysis.editGrammar,
    transferablePatterns: analysis.transferablePatterns,
    protectedElements: analysis.protectedElements,
    unknowns: analysis.unknowns,
  };
}

export function currentReferenceContentHash(analysis: ReferenceAnalysisArtifact): string {
  return sha256Canonical(referenceAnalysisContent(analysis));
}

export function hasCurrentReferenceUserApproval(analysis: ReferenceAnalysisArtifact): boolean {
  return analysis.reviews.some((review) =>
    review.decision === "approve"
    && review.authority === "user"
    && review.contentHash === analysis.contentHash
    && review.sourceSha256 === analysis.source.sha256,
  );
}

export function referenceAnalysisSemanticErrors(analysis: ReferenceAnalysisArtifact): string[] {
  const errors: string[] = [];
  if (currentReferenceContentHash(analysis) !== analysis.contentHash) errors.push("contentHash does not match the current reference analysis content");
  const duration = Number(analysis.source.media?.durationSeconds ?? 0);
  const validateIntervals = (
    items: Array<{ start?: number; end?: number; sourceIn?: number; sourceOut?: number }>,
    label: string,
    startKey: "start" | "sourceIn",
    endKey: "end" | "sourceOut",
  ) => {
    let previousEnd = -1;
    for (const [index, item] of items.entries()) {
      const start = Number(item[startKey]);
      const end = Number(item[endKey]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        errors.push(`${label}[${index}] has invalid timing`);
        continue;
      }
      if (start + 0.001 < previousEnd) errors.push(`${label}[${index}] overlaps the previous item`);
      if (duration > 0 && end > duration + 0.25) errors.push(`${label}[${index}] exceeds the media duration`);
      previousEnd = end;
    }
  };
  validateIntervals(analysis.referenceVerbatimTranscript.segments, "referenceVerbatimTranscript.segments", "start", "end");
  validateIntervals(analysis.referenceVerbatimTranscript.words, "referenceVerbatimTranscript.words", "start", "end");
  validateIntervals(analysis.shots, "shots", "sourceIn", "sourceOut");
  for (const [index, word] of analysis.referenceVerbatimTranscript.words.entries()) {
    if (!analysis.referenceVerbatimTranscript.segments.some((segment) => word.start + 0.001 >= segment.start && word.end <= segment.end + 0.001)) {
      errors.push(`referenceVerbatimTranscript.words[${index}] is outside all transcript segments`);
    }
  }
  for (const [index, segment] of analysis.referenceVerbatimTranscript.segments.entries()) {
    const segmentWords = analysis.referenceVerbatimTranscript.words.filter(
      (word) => word.start + 0.001 >= segment.start && word.end <= segment.end + 0.001,
    );
    if (
      normalizeTranscriptComparison(segmentWords.map((word) => word.text).join(""))
      !== normalizeTranscriptComparison(segment.text)
    ) {
      errors.push(`referenceVerbatimTranscript.segments[${index}] does not match its word-level evidence`);
    }
  }
  if (analysis.status === "approved") {
    if (analysis.approvedContentHash !== analysis.contentHash) errors.push("approvedContentHash does not match contentHash");
    if (!hasCurrentReferenceUserApproval(analysis)) errors.push("approved status lacks a current hash-bound user approval record");
    if (analysis.referenceVerbatimTranscript.words.length === 0) errors.push("approved analysis lacks word-level transcript evidence");
  }
  if (analysis.status !== "approved" && analysis.approvedContentHash !== null) {
    errors.push("non-approved analysis must not retain approvedContentHash");
  }
  return errors;
}

function escapeCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function analysisMarkdown(analysis: ReferenceAnalysisArtifact): string {
  const shotRows = analysis.shots.map((shot) =>
    `| ${escapeCell(`${shot.sourceIn.toFixed(3)}–${shot.sourceOut.toFixed(3)}`)} | ${escapeCell(shot.visualFunction)} | ${escapeCell(`${shot.shotSize}；${shot.composition}`)} | ${escapeCell(`${shot.cameraPosition}；${shot.cameraMovement}`)} | ${escapeCell(shot.subjectAction)} | ${escapeCell(shot.onScreenText?.join(" / ") ?? "")} | ${escapeCell(`${shot.transitionIn} → ${shot.transitionOut}`)} | ${escapeCell(`${shot.audio.sfx?.join(" / ") || "无"}；${shot.audio.musicCue}`)} |`,
  );
  const transcriptRows = analysis.referenceVerbatimTranscript.segments.map((segment) =>
    `| ${escapeCell(`${segment.start.toFixed(3)}–${segment.end.toFixed(3)}`)} | ${escapeCell(segment.speaker ?? "未标注")} | ${escapeCell(segment.text)} | ${escapeCell(segment.confidence ?? "未提供")} |`,
  );
  const wordRows = analysis.referenceVerbatimTranscript.words.map((word) =>
    `| ${escapeCell(`${word.start.toFixed(3)}–${word.end.toFixed(3)}`)} | ${escapeCell(word.speaker ?? "未标注")} | ${escapeCell(word.text)} | ${escapeCell(word.confidence ?? "未提供")} |`,
  );
  return [
    "# 参考视频事实分析",
    "",
    `- 参考素材：\`${analysis.source.assetId}\``,
    `- SHA-256：\`${analysis.source.sha256}\``,
    `- 用途边界：${analysis.source.intendedUse}`,
    `- 逐字稿状态：${analysis.referenceVerbatimTranscript.reviewStatus}`,
    "",
    "## 原片逐字稿（证据，不是目标脚本）",
    "",
    "| 时间 | 说话人 | 原片原话 | 置信度 |",
    "| --- | --- | --- | --- |",
    ...transcriptRows,
    "",
    "### 词级时间码证据",
    "",
    "| 时间 | 说话人 | 词 / 字块 | 置信度 |",
    "| --- | --- | --- | --- |",
    ...wordRows,
    "",
    "## 逐镜头拆解",
    "",
    "| 时间 | 画面职责 | 景别与构图 | 机位与运镜 | 人物动作 | 屏幕文字 | 转场 | SFX / 音乐 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...shotRows,
    "",
    "## 可借鉴机制",
    "",
    ...analysis.transferablePatterns.map((item) => `- ${item.name}：${item.adaptation}（证据镜头：${item.evidence.join("、")}）`),
    "",
    "## 默认禁止复制",
    "",
    ...analysis.protectedElements.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

async function loadReferenceAsset(projectDir: string, assetId: string): Promise<ReferenceAsset> {
  const assets = await readJson<{ assets: ReferenceAsset[] }>(path.join(projectDir, "assets.json"));
  const asset = assets.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) throw new Error(`Unknown reference asset: ${assetId}`);
  const roles = Array.isArray((asset as ReferenceAsset & { roles?: string[] }).roles)
    ? (asset as ReferenceAsset & { roles: string[] }).roles
    : [asset.role];
  if (!roles.includes("reference")) throw new Error(`Asset ${assetId} is not registered with role=reference`);
  return asset;
}

function referenceAssetEvidenceHash(asset: ReferenceAsset): string {
  return sha256Canonical({
    assetId: asset.assetId,
    path: path.resolve(asset.path),
    sha256: asset.sha256,
    provenance: asset.provenance,
    rightsStatus: asset.rights?.status ?? "unverified",
    media: asset.media ?? null,
  });
}

interface AnalyzeReferenceInput {
  projectDir: string;
  assetId: string;
  inputPath: string;
}

export async function analyzeReference(input: AnalyzeReferenceInput) {
  return withProjectStateLock(input.projectDir, "analyze-reference", () => analyzeReferenceLocked(input));
}

async function assertNoDependentRecreationPlan(projectDir: string, action: string): Promise<void> {
  try {
    const recreation = await readJson<{ status?: string }>(
      path.join(projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan),
    );
    if (new Set(["pending_user_review", "approved", "applied"]).has(String(recreation.status))) {
      throw new Error(
        `${action} requires the dependent recreation plan to be withdrawn first; `
        + `current recreation plan status is ${String(recreation.status)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function analyzeReferenceLocked(input: AnalyzeReferenceInput) {
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  if (project.workflowStatus === "archived") throw new Error("analyze-reference cannot change an archived project");
  await assertNoDependentRecreationPlan(input.projectDir, "analyze-reference");
  const asset = await loadReferenceAsset(input.projectDir, input.assetId);
  if (!asset.media?.video || !asset.media.durationSeconds || asset.media.durationSeconds <= 0) {
    throw new Error("analyze-reference requires a registered, playable video stream");
  }
  const currentHash = await sha256File(asset.path);
  if (currentHash !== asset.sha256) throw new Error("Registered reference video changed before analysis; ingest it again");
  const rawText = await readFile(path.resolve(input.inputPath), "utf8");
  const raw = JSON.parse(rawText) as ReferenceAnalysisInput;
  const normalized = normalizeInput(raw, asset, project.privacy.classification);
  const inputHash = sha256Canonical(raw);
  const contentHash = sha256Canonical(normalized);
  const artifact: ReferenceAnalysisArtifact = {
    schemaVersion: SCHEMA_VERSION,
    kind: "reference-video-analysis",
    status: "needs_review",
    ...normalized,
    inputHash,
    contentHash,
    approvedContentHash: null,
    reviews: [],
    generatedAt: new Date().toISOString(),
  };
  const artifactPath = path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.referenceAnalysis);
  await writeJsonAtomic(artifactPath, artifact);
  await writeFile(path.join(input.projectDir, "reference-analysis.md"), `${analysisMarkdown(artifact)}\n`, "utf8");
  project.artifacts.referenceAnalysis = REFERENCE_ARTIFACT_FILES.referenceAnalysis;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return {
    assetId: asset.assetId,
    transcriptSegments: artifact.referenceVerbatimTranscript.segments.length,
    transcriptWords: artifact.referenceVerbatimTranscript.words.length,
    shots: artifact.shots.length,
    contentHash,
    status: artifact.status,
  };
}

export async function verifyReferenceAnalysis(projectDir: string): Promise<ReferenceAnalysisArtifact> {
  const artifactPath = path.join(projectDir, REFERENCE_ARTIFACT_FILES.referenceAnalysis);
  const analysis = await readJson<ReferenceAnalysisArtifact>(artifactPath);
  const contentHash = currentReferenceContentHash(analysis);
  if (contentHash !== analysis.contentHash) throw new Error("Reference analysis content drifted; rerun analyze-reference and review it again");
  const asset = await loadReferenceAsset(projectDir, analysis.source.assetId);
  if (
    asset.sha256 !== analysis.source.sha256
    || referenceAssetEvidenceHash(asset) !== analysis.source.assetEvidenceHash
    || (await sha256File(asset.path)) !== analysis.source.sha256
  ) {
    throw new Error("The reference video changed after analysis; previous evidence is stale");
  }
  const semanticErrors = referenceAnalysisSemanticErrors(analysis);
  if (semanticErrors.length > 0) {
    throw new Error(`Reference analysis is semantically invalid: ${semanticErrors.join("; ")}`);
  }
  const reviewPath = path.join(projectDir, "reference-analysis.md");
  const expectedReview = `${analysisMarkdown(analysis)}\n`;
  let actualReview: string;
  try {
    actualReview = await readFile(reviewPath, "utf8");
  } catch {
    throw new Error("Reference analysis review artifact is missing or unreadable");
  }
  if (actualReview !== expectedReview) {
    throw new Error("Reference analysis review artifact drifted from the hash-bound JSON contract");
  }
  return analysis;
}

interface ReferenceReviewInput {
  projectDir: string;
  decision: "approve" | "revise";
  reviewer: string;
  authority: "user" | "operator";
  notes?: string;
}

export async function reviewReference(input: ReferenceReviewInput) {
  return withProjectStateLock(input.projectDir, "review-reference", () => reviewReferenceLocked(input));
}

async function reviewReferenceLocked(input: ReferenceReviewInput) {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  if (project.workflowStatus === "archived") throw new Error("review-reference cannot change an archived project");
  const reviewer = text(input.reviewer, "reviewer");
  const analysis = await verifyReferenceAnalysis(input.projectDir);
  if (input.decision === "approve" && input.authority !== "user") {
    throw new Error("Reference approval is a user gate; operator review may only request revision");
  }
  if (input.decision === "revise") {
    await assertNoDependentRecreationPlan(input.projectDir, "Reference approval withdrawal");
    const { assertNoActiveBrollExecutionClaims } = await import("./broll-handoff.js");
    await assertNoActiveBrollExecutionClaims(input.projectDir, "Reference approval withdrawal");
  }
  if (input.decision === "approve" && analysis.referenceVerbatimTranscript.reviewStatus === "asr_unreviewed") {
    throw new Error("Reference approval requires the verbatim transcript to be corrected or human verified");
  }
  if (input.decision === "approve" && analysis.referenceVerbatimTranscript.words.length === 0) {
    throw new Error("Reference approval requires word-level transcript evidence");
  }
  const reviewedAt = new Date().toISOString();
  analysis.reviews.push({
    decision: input.decision,
    reviewer,
    authority: input.authority,
    notes: input.notes?.trim() || null,
    contentHash: analysis.contentHash,
    sourceSha256: analysis.source.sha256,
    reviewArtifactSha256: await sha256File(path.join(input.projectDir, "reference-analysis.md")),
    reviewedAt,
  });
  analysis.status = input.decision === "approve" ? "approved" : "needs_revision";
  analysis.approvedContentHash = input.decision === "approve" ? analysis.contentHash : null;
  await writeJsonAtomic(path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.referenceAnalysis), analysis);
  return { status: analysis.status, contentHash: analysis.contentHash, reviewer, reviewedAt };
}
