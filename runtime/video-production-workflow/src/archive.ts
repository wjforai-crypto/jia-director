import { stat } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FILES, REFERENCE_ARTIFACT_FILES, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";
import {
  appliedRecreationBindingErrors,
  type EditPlanWithRecreation,
  type RecreationPlanArtifact,
} from "./reference-recreation.js";
import { acceptedBrollArchiveEntries, brollArchiveErrors } from "./broll-handoff.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface ArchiveInput {
  entries: Array<{ group: string; path: string; label?: string }>;
}

interface ArchiveManifest {
  schemaVersion: string;
  status: string;
  requiredGroups: string[];
  entries: Array<Record<string, unknown>>;
}

export async function archiveProject(input: { projectDir: string; inputPath: string }) {
  return withProjectStateLock(input.projectDir, "archive-project", () => archiveProjectLocked(input));
}

async function archiveProjectLocked(input: { projectDir: string; inputPath: string }) {
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  if (project.workflowStatus !== "final_confirmed") {
    throw new Error(`archive requires final_confirmed, got ${project.workflowStatus}`);
  }
  if (project.artifacts.recreationPlan === REFERENCE_ARTIFACT_FILES.recreationPlan) {
    try {
      const journal = await readJson<{ status?: string }>(path.join(input.projectDir, "recreation-application.json"));
      if (journal.status === "pending" || journal.status === "rollback_pending") {
        throw new Error(`archive is blocked by an unresolved recreation application transaction: ${journal.status}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const recreationPlan = await readJson<RecreationPlanArtifact>(
      path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan),
    );
    const hasActiveApplication = recreationPlan.applications.some((application) => !application.revokedAt);
    if (hasActiveApplication && recreationPlan.status !== "applied") {
      throw new Error("archive is blocked because an applied recreation plan was later withdrawn or became stale");
    }
    if (recreationPlan.status === "applied") {
      const editPlan = await readJson<EditPlanWithRecreation>(path.join(input.projectDir, ARTIFACT_FILES.editPlan));
      const bindingErrors = appliedRecreationBindingErrors(recreationPlan, editPlan);
      if (bindingErrors.length > 0) {
        throw new Error(`archive is blocked by invalid recreation bindings: ${bindingErrors.join("; ")}`);
      }
    }
  }
  const brollErrors = await brollArchiveErrors(input.projectDir);
  if (brollErrors.length > 0) {
    throw new Error(`archive is blocked by unresolved or invalid B-roll handoffs: ${brollErrors.join("; ")}`);
  }
  const manifestPath = path.join(input.projectDir, ARTIFACT_FILES.archiveManifest);
  const manifest = await readJson<ArchiveManifest>(manifestPath);
  const request = await readJson<ArchiveInput>(path.resolve(input.inputPath));
  if (!Array.isArray(request.entries)) throw new Error("Archive input entries must be an array");
  const providedGroups = new Set(request.entries.map((entry) => entry.group));
  const missing = manifest.requiredGroups.filter((group) => !providedGroups.has(group));
  if (missing.length > 0) throw new Error(`Missing required archive groups: ${missing.join(", ")}`);

  const verifiedEntries = [];
  const verifiedPaths = new Set<string>();
  for (const entry of request.entries) {
    if (!manifest.requiredGroups.includes(entry.group)) throw new Error(`Unknown archive group: ${entry.group}`);
    const filePath = path.resolve(entry.path);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new Error(`Archive entry does not exist: ${filePath}`);
    }
    if (!fileStat.isFile()) throw new Error(`Archive entry must be a file: ${filePath}`);
    verifiedEntries.push({
      group: entry.group,
      label: entry.label ?? path.basename(filePath),
      path: filePath,
      sizeBytes: fileStat.size,
      sha256: await sha256File(filePath),
    });
    verifiedPaths.add(path.resolve(filePath).toLowerCase());
  }
  for (const entry of await acceptedBrollArchiveEntries(input.projectDir)) {
    if (verifiedPaths.has(path.resolve(entry.path).toLowerCase())) continue;
    verifiedEntries.push(entry);
    verifiedPaths.add(path.resolve(entry.path).toLowerCase());
  }
  await writeJson(manifestPath, {
    ...manifest,
    status: "archived",
    entries: verifiedEntries,
    archivedAt: new Date().toISOString(),
  });
  project.workflowStatus = "archived";
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return { status: "archived", entries: verifiedEntries.length };
}
