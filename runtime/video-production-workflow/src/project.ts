import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_FILES,
  SCHEMA_VERSION,
  type PrivacyClassification,
  type ProjectPriority,
  type VideoLane,
  type VideoProject,
} from "./contracts.js";
import { createHash } from "node:crypto";
import { readJson } from "./json-store.js";
import { withProjectStateLock } from "./project-state-lock.js";

export interface InitProjectInput {
  projectDir: string;
  title: string;
  lane: VideoLane;
  sourcePath: string;
  priority?: ProjectPriority;
  privacy?: PrivacyClassification;
  platform?: string;
  aspectRatio?: string;
}

function stableProjectId(input: Pick<InitProjectInput, "title" | "lane" | "sourcePath">): string {
  const identity = JSON.stringify({
    title: input.title.trim(),
    lane: input.lane,
    sourcePath: path.resolve(input.sourcePath).toLowerCase(),
  });
  return `vf_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function initProject(input: InitProjectInput): Promise<VideoProject> {
  await mkdir(input.projectDir, { recursive: true });
  return withProjectStateLock(input.projectDir, "init-project", () => initProjectLocked(input));
}

async function initProjectLocked(input: InitProjectInput): Promise<VideoProject> {
  const projectFile = path.join(input.projectDir, "project.json");
  const files = new Set(await readdir(input.projectDir));
  const artifacts = Object.values(ARTIFACT_FILES);
  if (files.has("project.json")) {
    const existing = await readJson<VideoProject>(projectFile);
    if (existing.projectId !== stableProjectId(input)) throw new Error("Project directory already belongs to a different project");
    if (artifacts.some(file => !files.has(file))) throw new Error("Existing project has missing records; restore them before continuing");
    return existing;
  }
  if (artifacts.some(file => files.has(file))) {
    throw new Error("Project directory contains existing records without project.json; restore the original project instead of reinitializing");
  }
  const now = new Date().toISOString();
  const privacy = input.privacy ?? "internal";
  const project: VideoProject = {
    schemaVersion: SCHEMA_VERSION,
    projectId: stableProjectId(input),
    title: input.title.trim(),
    lane: input.lane,
    priority: input.priority ?? "standard",
    platform: input.platform ?? (input.lane === "speech" ? "视频号" : "课程/产品演示"),
    aspectRatio: input.aspectRatio ?? (input.lane === "speech" ? "9:16" : "16:9"),
    workflowStatus: "intake",
    privacy: {
      classification: privacy,
      containsSensitiveData: privacy === "sensitive",
      redacted: false,
      cloudAllowed: privacy !== "sensitive",
      externalProcessingAuthorization: {
        status: privacy === "sensitive" ? "pending" : "not_required",
        authorizedBy: null,
        scope: [],
        verifiedBy: null,
        verifiedAt: null,
        redactionEvidence: null,
      },
    },
    source: { path: path.resolve(input.sourcePath) },
    artifacts: ARTIFACT_FILES,
    createdAt: now,
    updatedAt: now,
  };

  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.assets), {
    schemaVersion: SCHEMA_VERSION,
    assets: [],
  });
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.transcript), {
    schemaVersion: SCHEMA_VERSION,
    sourceAssetId: null,
    engine: null,
    language: null,
    segments: [],
    words: [],
  });
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.cutPlan), {
    schemaVersion: SCHEMA_VERSION,
    transcriptHash: null,
    operations: [],
    reviewStatus: "not_started",
  });
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.editPlan), {
    schemaVersion: SCHEMA_VERSION,
    cutPlanHash: null,
    shots: [],
    reviewStatus: "not_started",
  });
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.visualRouting), {
    schemaVersion: SCHEMA_VERSION,
    score: null,
    threshold: 6,
    decision: "not_scored",
    selectedShotIds: [],
    callsUsed: 0,
    maxCalls: project.priority === "flagship" ? 2 : 1,
    privacyBlocked: project.privacy.containsSensitiveData && !project.privacy.redacted,
  });
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.kimiVisualDirection), {
    schemaVersion: SCHEMA_VERSION,
    status: "not_requested",
    inputHash: null,
    sessionId: null,
    suggestions: [],
    decisions: [],
  });
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.review), {
    schemaVersion: SCHEMA_VERSION,
    versions: [],
    confirmations: [],
  });
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.archiveManifest), {
    schemaVersion: SCHEMA_VERSION,
    status: "pending",
    requiredGroups: ["source", "editable_project", "preview", "review_evidence", "asset_manifest", "readme"],
    entries: [],
  });

  await writeJson(projectFile, project);
  return project;
}
