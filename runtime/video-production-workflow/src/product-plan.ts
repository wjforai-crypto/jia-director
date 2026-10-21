import path from "node:path";
import { ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";
import { sha256Canonical } from "./canonical-json.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface ProductPlanShotInput {
  slug: string;
  timelineIn: number;
  timelineOut: number;
  semanticIntent: string;
  visualRole: string;
  onScreenText?: string[];
  triggerWords?: string[];
  protectedRegions?: string[];
  acceptance?: string[];
}

interface ProductPlanInput {
  brief: Record<string, unknown>;
  durationSeconds: number;
  shots: ProductPlanShotInput[];
}

function payloadHash(payload: unknown): string {
  return sha256Canonical(payload);
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text`);
}

function normalizePlan(plan: ProductPlanInput): ProductPlanInput {
  if (!plan || typeof plan !== "object") throw new Error("Product plan must be a JSON object");
  if (!plan.brief || typeof plan.brief !== "object" || Array.isArray(plan.brief)) {
    throw new Error("Product plan requires a brief object");
  }
  if (!Number.isFinite(plan.durationSeconds) || plan.durationSeconds <= 0) {
    throw new Error("Product plan durationSeconds must be greater than zero");
  }
  if (!Array.isArray(plan.shots) || plan.shots.length === 0) throw new Error("Product plan requires at least one shot");

  const seenSlugs = new Set<string>();
  const shots = plan.shots.map((shot, index) => {
    assertText(shot.slug, `shots[${index}].slug`);
    assertText(shot.semanticIntent, `shots[${index}].semanticIntent`);
    assertText(shot.visualRole, `shots[${index}].visualRole`);
    if (seenSlugs.has(shot.slug)) throw new Error(`Duplicate product shot slug: ${shot.slug}`);
    seenSlugs.add(shot.slug);
    if (!Number.isFinite(shot.timelineIn) || !Number.isFinite(shot.timelineOut) || shot.timelineOut <= shot.timelineIn) {
      throw new Error(`Invalid product shot timing: ${shot.slug}`);
    }
    const expectedIn = index === 0 ? 0 : plan.shots[index - 1].timelineOut;
    if (Math.abs(shot.timelineIn - expectedIn) > 0.001) {
      throw new Error(`Product shot timeline has a gap or overlap before ${shot.slug}`);
    }
    return {
      slug: shot.slug.trim(),
      timelineIn: Number(shot.timelineIn.toFixed(3)),
      timelineOut: Number(shot.timelineOut.toFixed(3)),
      semanticIntent: shot.semanticIntent.trim(),
      visualRole: shot.visualRole.trim(),
      onScreenText: [...(shot.onScreenText ?? [])],
      triggerWords: [...(shot.triggerWords ?? [])],
      protectedRegions: [...(shot.protectedRegions ?? [])],
      acceptance: [...(shot.acceptance ?? [])],
    };
  });
  if (Math.abs(shots.at(-1)!.timelineOut - plan.durationSeconds) > 0.001) {
    throw new Error("Product shot timeline has a gap or overlap at the composition end");
  }
  return { brief: plan.brief, durationSeconds: Number(plan.durationSeconds.toFixed(3)), shots };
}

function shotId(shot: ProductPlanShotInput): string {
  return `shot_${payloadHash([
    shot.slug,
    shot.timelineIn,
    shot.timelineOut,
    shot.semanticIntent,
    shot.visualRole,
    shot.onScreenText ?? [],
  ]).slice(0, 16)}`;
}

export async function createProductPlan(input: { projectDir: string; inputPath: string }) {
  return withProjectStateLock(input.projectDir, "create-product-plan", () => createProductPlanLocked(input));
}

async function createProductPlanLocked(input: { projectDir: string; inputPath: string }) {
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  if (!new Set(["product-demo", "hybrid"]).has(project.lane)) {
    throw new Error(`plan-product requires product-demo or hybrid lane, got ${project.lane}`);
  }
  if (project.workflowStatus !== "source_registered") {
    throw new Error(`plan-product requires source_registered, got ${project.workflowStatus}`);
  }
  const normalized = normalizePlan(await readJson<ProductPlanInput>(path.resolve(input.inputPath)));
  const planInputHash = payloadHash(normalized);

  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.transcript), {
    schemaVersion: SCHEMA_VERSION,
    sourceAssetId: null,
    engine: "not_applicable",
    language: null,
    segments: [],
    words: [],
    reviewStatus: "not_applicable",
    reason: "Product-demo direct planning does not invent speech evidence",
  });
  const cutPlanPath = path.join(input.projectDir, ARTIFACT_FILES.cutPlan);
  await writeJson(cutPlanPath, {
    schemaVersion: SCHEMA_VERSION,
    strategy: "product-demo-direct",
    transcriptHash: null,
    planInputHash,
    operations: [],
    reviewStatus: "not_applicable",
    invariants: { lockedTimeline: true, transcriptInvented: false },
  });
  const shots = normalized.shots.map((shot) => ({
    id: shotId(shot),
    slug: shot.slug,
    timelineIn: shot.timelineIn,
    timelineOut: shot.timelineOut,
    semanticIntent: shot.semanticIntent,
    visualRole: shot.visualRole,
    voiceover: "",
    onScreenText: shot.onScreenText,
    triggerWords: shot.triggerWords,
    protectedRegions: shot.protectedRegions,
    acceptance: shot.acceptance,
  }));
  await writeJson(path.join(input.projectDir, ARTIFACT_FILES.editPlan), {
    schemaVersion: SCHEMA_VERSION,
    cutPlanHash: await sha256File(cutPlanPath),
    planInputHash,
    durationSeconds: normalized.durationSeconds,
    shots,
    reviewStatus: "ready",
    mode: "product-demo-direct",
  });

  project.brief = normalized.brief;
  project.workflowStatus = "plan_ready";
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return { shots: shots.length, durationSeconds: normalized.durationSeconds, planInputHash };
}
