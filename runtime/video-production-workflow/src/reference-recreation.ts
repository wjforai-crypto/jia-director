import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REFERENCE_ARTIFACT_FILES, SCHEMA_VERSION, type VideoProject } from "./contracts.js";
import { sha256Canonical } from "./canonical-json.js";
import { readJson, writeJson, writeJsonAtomic } from "./json-store.js";
import {
  hasCurrentReferenceUserApproval,
  verifyReferenceAnalysis,
  type ReferenceAnalysisArtifact,
} from "./reference-analysis.js";
import { sha256File } from "./media.js";
import { withProjectStateLock } from "./project-state-lock.js";

type RecreationMode = "mechanism_only" | "structure_recreation" | "authorized_close_recreation";

interface RecreationPlanInput {
  brief: {
    audience: string;
    objective: string;
    platform: string;
    aspectRatio: string;
    durationSeconds: number;
    tone: string;
    facts: string[];
    brandRules: string[];
  };
  adaptationPolicy: {
    mode: RecreationMode;
    borrowedMechanisms: string[];
    mustReplace: string[];
    replacementMap: Array<{
      sourceElement: string;
      action: "replace" | "licensed_reuse";
      replacement: string;
      verification: string;
      targetPaths: string[];
      replacementAnchors: string[];
    }>;
    authorizationEvidence: Array<{
      path: string;
      sha256: string;
      referenceAssetSha256: string;
      authorizedBy: string;
      rightsHolder: string;
      authorizedElements: string[];
      verifiedBy: string;
      verifiedAt: string;
      scope: string[];
    }>;
  };
  creativeOptions: Array<{
    slug: string;
    name: string;
    coreIdea: string;
    referenceUse: string;
    visualApproach: string;
    productionCost: string;
    risk: string;
    fit: string;
  }>;
  selectedOptionSlug: string;
  scriptOutline: Array<{
    slug: string;
    purpose: string;
    referenceMechanism: string;
    targetMessage: string;
  }>;
  targetVerbatimScript: Array<{
    slug: string;
    sectionSlug: string;
    text: string;
    purpose: string;
    delivery: string;
  }>;
  shootingPlan: Array<{
    slug: string;
    timelineIn: number;
    timelineOut: number;
    lineSlugs: string[];
    referenceShotSlugs?: string[];
    scene: string;
    framing: string;
    composition: string;
    cameraPosition: string;
    cameraMovement: string;
    subjectAction: string;
    performance: string;
    props: string[];
    lighting: string;
    audioCapture: string;
    continuity: string;
    alternatives?: string[];
  }>;
  editBlueprint: Array<{
    shootingShotSlug: string;
    referenceMechanisms: string[];
    cutStrategy: string;
    pacing: string;
    brollSlots?: Array<{
      trigger: string;
      purpose: string;
      visual: string;
      sourceStrategy: "self_recorded" | "licensed_stock" | "generated_after_approval";
      sourcePlan: {
        provenance: string;
        rightsStatus: "user_owned" | "licensed" | "pending_generation";
        licenseEvidencePath?: string | null;
        licenseEvidenceSha256?: string | null;
        assetId?: string | null;
        assetSha256?: string | null;
      };
      generation?: null | {
        executor: string;
        model: string;
        mode: string;
        prompt: string;
        promptHash?: string;
        approvalStatus?: "pending_plan_review";
      };
      durationSeconds: number;
      reviewBeforeUse: true;
    }>;
    motionGraphics?: Array<{
      trigger: string;
      purpose: string;
      visual: string;
      durationSeconds: number;
    }>;
    sfx?: Array<{ trigger: string; sound: string; mix: string }>;
    music: { cue: string; mood: string; change: string };
    transition: string;
    keyFrames: string[];
    acceptance: string[];
  }>;
}

interface NormalizedScriptLine {
  id: string;
  slug: string;
  sectionSlug: string;
  text: string;
  purpose: string;
  delivery: string;
}

type NormalizedShootingShot = RecreationPlanInput["shootingPlan"][number] & {
  id: string;
  lineIds: string[];
  referenceShotIds: string[];
};

type InputBrollSlot = NonNullable<RecreationPlanInput["editBlueprint"][number]["brollSlots"]>[number];

type NormalizedBlueprint = Omit<RecreationPlanInput["editBlueprint"][number], "brollSlots"> & {
  shootingShotId: string;
  brollSlots: Array<InputBrollSlot & { id: string }>;
};

export interface RecreationPlanArtifact {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "reference-video-recreation-plan";
  status: "pending_user_review" | "approved" | "needs_revision" | "stale" | "applied";
  referenceAnalysisContentHash: string;
  referenceAssetHash: string;
  briefHash: string;
  brief: RecreationPlanInput["brief"];
  adaptationPolicy: RecreationPlanInput["adaptationPolicy"];
  creativeOptions: RecreationPlanInput["creativeOptions"];
  selectedOptionSlug: string;
  scriptOutline: RecreationPlanInput["scriptOutline"];
  targetVerbatimScript: NormalizedScriptLine[];
  shootingPlan: NormalizedShootingShot[];
  editBlueprint: NormalizedBlueprint[];
  inputHash: string;
  contentHash: string;
  approvedContentHash: string | null;
  reviews: Array<Record<string, unknown>>;
  applications: RecreationApplicationRecord[];
  generatedAt: string;
}

interface RecreationApplicationRecord {
  contentHash: string;
  targetTranscriptHash: string;
  cutPlanHash: string;
  editPlanBeforeHash: string;
  editPlanAfterHash: string;
  referenceBindingsHash: string;
  mappings: RecreationApplicationInput["mappings"];
  reviewer: string;
  appliedAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text`);
  return value.normalize("NFC").trim();
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = text(value, label);
  if (!ISO_DATE_TIME.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
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

function normalizeComparison(value: string): string {
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
    .replace(/[\p{P}\p{S}\p{Cf}\s]/gu, "");
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) throw new Error(`Replacement target path must be a JSON Pointer: ${pointer}`);
  let current = root;
  for (const token of pointer.slice(1).split("/").map(decodeJsonPointerToken)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) {
        throw new Error(`Replacement target path does not resolve: ${pointer}`);
      }
      current = current[Number(token)];
      continue;
    }
    if (!current || typeof current !== "object" || !(token in current)) {
      throw new Error(`Replacement target path does not resolve: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function replacementTargetErrors(
  replacementMap: RecreationPlanInput["adaptationPolicy"]["replacementMap"],
  targetDocument: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const allowedRoots = new Set(["brief", "scriptOutline", "targetVerbatimScript", "shootingPlan", "editBlueprint"]);
  for (const [index, mapping] of replacementMap.entries()) {
    if (!Array.isArray(mapping.targetPaths) || mapping.targetPaths.length === 0) {
      errors.push(`replacementMap[${index}] must bind at least one target path`);
      continue;
    }
    const seen = new Set<string>();
    const targetValues: string[] = [];
    for (const pointer of mapping.targetPaths) {
      if (seen.has(pointer)) {
        errors.push(`replacementMap[${index}] duplicates target path ${pointer}`);
        continue;
      }
      seen.add(pointer);
      const root = pointer.split("/")[1] ?? "";
      if (!allowedRoots.has(root)) {
        errors.push(`replacementMap[${index}] target path is outside approved target fields: ${pointer}`);
        continue;
      }
      try {
        const value = resolveJsonPointer(targetDocument, pointer);
        const candidate = normalizeComparison(typeof value === "string" ? value : JSON.stringify(value));
        targetValues.push(candidate);
        if (mapping.action === "replace") {
          const source = normalizeComparison(mapping.sourceElement);
          if (source.length >= 2 && candidate.includes(source)) {
            errors.push(`replacementMap[${index}] target ${pointer} still contains protected element ${mapping.sourceElement}`);
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (mapping.action === "replace") {
      const replacement = normalizeComparison(mapping.replacement);
      for (const anchor of mapping.replacementAnchors) {
        const normalizedAnchor = normalizeComparison(anchor);
        if (normalizedAnchor.length < 3) {
          errors.push(`replacementMap[${index}] replacement anchor must contain at least three meaningful characters: ${anchor}`);
        } else if (!replacement.includes(normalizedAnchor)) {
          errors.push(`replacementMap[${index}] replacement anchor is not declared by replacement text: ${anchor}`);
        } else if (!targetValues.some((candidate) => candidate.includes(normalizedAnchor))) {
          errors.push(`replacementMap[${index}] target paths do not evidence replacement anchor: ${anchor}`);
        }
      }
    }
  }
  return errors;
}

interface WordingCandidate {
  label: string;
  value: string;
}

function assertOriginalWording(
  targetCandidates: WordingCandidate[],
  analysis: ReferenceAnalysisArtifact,
  mode: RecreationMode,
): void {
  if (mode === "authorized_close_recreation") return;
  const referenceTexts = [
    analysis.referenceVerbatimTranscript.fullText,
    ...analysis.referenceVerbatimTranscript.segments.map((segment) => segment.text),
    ...analysis.shots.flatMap((shot) => shot.onScreenText ?? []),
    ...analysis.protectedElements,
  ]
    .map(normalizeComparison)
    .filter((value) => value.length >= 6);
  const targetTexts = targetCandidates
    .map((candidate) => ({ label: candidate.label, value: normalizeComparison(candidate.value) }))
    .filter((candidate) => candidate.value.length >= 6);
  for (const targetEntry of targetTexts) {
    const target = targetEntry.value;
    const copied = referenceTexts.find((reference) => {
      if (target === reference && target.length >= 6) return true;
      const shorter = target.length <= reference.length ? target : reference;
      const longer = target.length <= reference.length ? reference : target;
      if (shorter.length >= 8 && longer.includes(shorter)) return true;
      const threshold = 10;
      if (target.length < threshold || reference.length < threshold) return false;
      const [scan, lookup] = target.length <= reference.length ? [target, reference] : [reference, target];
      for (let index = 0; index <= scan.length - threshold; index += 1) {
        if (lookup.includes(scan.slice(index, index + threshold))) return true;
      }
      return false;
    });
    if (copied) {
      throw new Error(`Target line ${targetEntry.label} copies reference wording without close-recreation authorization`);
    }
  }
}

function normalizePlan(
  raw: RecreationPlanInput,
  analysis: ReferenceAnalysisArtifact,
  projectDir: string,
  expectedAspectRatio: string,
  expectedPlatform: string,
) {
  assertRecord(raw, "Recreation plan input");
  assertRecord(raw.brief, "brief");
  const durationSeconds = finiteTime(raw.brief.durationSeconds, "brief.durationSeconds");
  if (durationSeconds <= 0) throw new Error("brief.durationSeconds must be greater than zero");
  const brief: RecreationPlanInput["brief"] = {
    audience: text(raw.brief.audience, "brief.audience"),
    objective: text(raw.brief.objective, "brief.objective"),
    platform: text(raw.brief.platform, "brief.platform"),
    aspectRatio: text(raw.brief.aspectRatio, "brief.aspectRatio"),
    durationSeconds,
    tone: text(raw.brief.tone, "brief.tone"),
    facts: textArray(raw.brief.facts, "brief.facts"),
    brandRules: textArray(raw.brief.brandRules, "brief.brandRules"),
  };
  if (brief.aspectRatio !== expectedAspectRatio) {
    throw new Error(`Recreation aspect ratio ${brief.aspectRatio} does not match project output ${expectedAspectRatio}`);
  }
  if (brief.platform !== expectedPlatform) {
    throw new Error(`Recreation platform ${brief.platform} does not match project platform ${expectedPlatform}`);
  }

  assertRecord(raw.adaptationPolicy, "adaptationPolicy");
  const allowedModes = new Set<RecreationMode>(["mechanism_only", "structure_recreation", "authorized_close_recreation"]);
  if (!allowedModes.has(raw.adaptationPolicy.mode)) throw new Error(`Unsupported adaptation mode: ${String(raw.adaptationPolicy.mode)}`);
  const authorizationEvidence = Array.isArray(raw.adaptationPolicy.authorizationEvidence)
    ? raw.adaptationPolicy.authorizationEvidence.map((evidence, index) => {
        assertRecord(evidence, `adaptationPolicy.authorizationEvidence[${index}]`);
        const evidenceHash = text(evidence.sha256, `adaptationPolicy.authorizationEvidence[${index}].sha256`).toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(evidenceHash)) {
          throw new Error(`adaptationPolicy.authorizationEvidence[${index}].sha256 must be lowercase SHA-256`);
        }
        return {
          path: path.resolve(projectDir, text(evidence.path, `adaptationPolicy.authorizationEvidence[${index}].path`)),
          sha256: evidenceHash,
          referenceAssetSha256: text(
            evidence.referenceAssetSha256,
            `adaptationPolicy.authorizationEvidence[${index}].referenceAssetSha256`,
          ).toLowerCase(),
          authorizedBy: text(evidence.authorizedBy, `adaptationPolicy.authorizationEvidence[${index}].authorizedBy`),
          rightsHolder: text(evidence.rightsHolder, `adaptationPolicy.authorizationEvidence[${index}].rightsHolder`),
          authorizedElements: textArray(
            evidence.authorizedElements,
            `adaptationPolicy.authorizationEvidence[${index}].authorizedElements`,
          ),
          verifiedBy: text(evidence.verifiedBy, `adaptationPolicy.authorizationEvidence[${index}].verifiedBy`),
          verifiedAt: isoTimestamp(evidence.verifiedAt, `adaptationPolicy.authorizationEvidence[${index}].verifiedAt`),
          scope: textArray(evidence.scope, `adaptationPolicy.authorizationEvidence[${index}].scope`),
        };
      })
    : [];
  const replacementInputs = raw.adaptationPolicy.replacementMap;
  if (!Array.isArray(replacementInputs) || replacementInputs.length === 0) {
    throw new Error("adaptationPolicy.replacementMap must be a non-empty array");
  }
  const requiredReplacementSources = new Set([
    ...analysis.protectedElements,
    ...textArray(raw.adaptationPolicy.mustReplace, "adaptationPolicy.mustReplace"),
  ]);
  const replacementSources = new Set<string>();
  const replacementMap = replacementInputs.map((entry, index) => {
    assertRecord(entry, `adaptationPolicy.replacementMap[${index}]`);
    const sourceElement = text(entry.sourceElement, `adaptationPolicy.replacementMap[${index}].sourceElement`);
    if (!requiredReplacementSources.has(sourceElement)) {
      throw new Error(`replacementMap contains an element not declared by the analysis or mustReplace: ${sourceElement}`);
    }
    if (replacementSources.has(sourceElement)) throw new Error(`replacementMap duplicates sourceElement: ${sourceElement}`);
    replacementSources.add(sourceElement);
    if (entry.action !== "replace" && entry.action !== "licensed_reuse") {
      throw new Error(`Unsupported replacement action for ${sourceElement}: ${String(entry.action)}`);
    }
    if (entry.action === "licensed_reuse" && raw.adaptationPolicy.mode !== "authorized_close_recreation") {
      throw new Error(`licensed_reuse is only allowed in authorized_close_recreation: ${sourceElement}`);
    }
    const replacement = text(entry.replacement, `adaptationPolicy.replacementMap[${index}].replacement`);
    if (entry.action === "replace" && normalizeComparison(replacement) === normalizeComparison(sourceElement)) {
      throw new Error(`replacementMap must materially replace: ${sourceElement}`);
    }
    return {
      sourceElement,
      action: entry.action,
      replacement,
      verification: text(entry.verification, `adaptationPolicy.replacementMap[${index}].verification`),
      targetPaths: textArray(entry.targetPaths, `adaptationPolicy.replacementMap[${index}].targetPaths`),
      replacementAnchors: textArray(entry.replacementAnchors, `adaptationPolicy.replacementMap[${index}].replacementAnchors`),
    };
  });
  const uncoveredReplacementSources = [...requiredReplacementSources].filter((item) => !replacementSources.has(item));
  if (uncoveredReplacementSources.length > 0) {
    throw new Error(`replacementMap does not cover: ${uncoveredReplacementSources.join(", ")}`);
  }
  const mustReplace = textArray(raw.adaptationPolicy.mustReplace, "adaptationPolicy.mustReplace");
  const adaptationPolicy = {
    mode: raw.adaptationPolicy.mode,
    borrowedMechanisms: textArray(raw.adaptationPolicy.borrowedMechanisms, "adaptationPolicy.borrowedMechanisms"),
    mustReplace,
    replacementMap,
    authorizationEvidence,
  };
  if (adaptationPolicy.mode === "authorized_close_recreation" && adaptationPolicy.authorizationEvidence.length === 0) {
    throw new Error("authorized_close_recreation requires authorizationEvidence");
  }
  if (adaptationPolicy.mode === "authorized_close_recreation") {
    if (analysis.source.intendedUse !== "authorized_close_recreation") {
      throw new Error("authorized_close_recreation requires the approved reference analysis to authorize close recreation");
    }
    if (analysis.source.rightsStatus !== "cleared") {
      throw new Error("authorized_close_recreation requires a reference asset with cleared rights");
    }
    if (!adaptationPolicy.authorizationEvidence.some((evidence) => evidence.scope.includes("close_recreation"))) {
      throw new Error("authorized_close_recreation requires evidence scope close_recreation");
    }
    for (const evidence of adaptationPolicy.authorizationEvidence) {
      if (!/^[a-f0-9]{64}$/.test(evidence.referenceAssetSha256)) {
        throw new Error("authorizationEvidence.referenceAssetSha256 must be lowercase SHA-256");
      }
      if (evidence.referenceAssetSha256 !== analysis.source.sha256) {
        throw new Error("authorization evidence is not bound to the current reference asset");
      }
    }
    for (const mapping of adaptationPolicy.replacementMap) {
      if (
        mapping.action === "licensed_reuse"
        && !adaptationPolicy.authorizationEvidence.some((evidence) =>
          evidence.scope.includes("close_recreation") && evidence.authorizedElements.includes(mapping.sourceElement),
        )
      ) {
        throw new Error(`licensed_reuse is not authorized for sourceElement: ${mapping.sourceElement}`);
      }
    }
  }

  if (!Array.isArray(raw.creativeOptions) || raw.creativeOptions.length < 2 || raw.creativeOptions.length > 3) {
    throw new Error("creativeOptions must contain two or three user-reviewable options");
  }
  const optionSlugs = new Set<string>();
  const creativeOptions = raw.creativeOptions.map((option, index) => {
    assertRecord(option, `creativeOptions[${index}]`);
    const slug = text(option.slug, `creativeOptions[${index}].slug`);
    if (optionSlugs.has(slug)) throw new Error(`Duplicate creative option slug: ${slug}`);
    optionSlugs.add(slug);
    return {
      slug,
      name: text(option.name, `creativeOptions[${index}].name`),
      coreIdea: text(option.coreIdea, `creativeOptions[${index}].coreIdea`),
      referenceUse: text(option.referenceUse, `creativeOptions[${index}].referenceUse`),
      visualApproach: text(option.visualApproach, `creativeOptions[${index}].visualApproach`),
      productionCost: text(option.productionCost, `creativeOptions[${index}].productionCost`),
      risk: text(option.risk, `creativeOptions[${index}].risk`),
      fit: text(option.fit, `creativeOptions[${index}].fit`),
    };
  });
  const selectedOptionSlug = text(raw.selectedOptionSlug, "selectedOptionSlug");
  if (!optionSlugs.has(selectedOptionSlug)) throw new Error(`selectedOptionSlug does not match a creative option: ${selectedOptionSlug}`);

  if (!Array.isArray(raw.scriptOutline) || raw.scriptOutline.length === 0) throw new Error("scriptOutline must be a non-empty array");
  const sectionSlugs = new Set<string>();
  const scriptOutline = raw.scriptOutline.map((section, index) => {
    assertRecord(section, `scriptOutline[${index}]`);
    const slug = text(section.slug, `scriptOutline[${index}].slug`);
    if (sectionSlugs.has(slug)) throw new Error(`Duplicate script section slug: ${slug}`);
    sectionSlugs.add(slug);
    return {
      slug,
      purpose: text(section.purpose, `scriptOutline[${index}].purpose`),
      referenceMechanism: text(section.referenceMechanism, `scriptOutline[${index}].referenceMechanism`),
      targetMessage: text(section.targetMessage, `scriptOutline[${index}].targetMessage`),
    };
  });

  if (!Array.isArray(raw.targetVerbatimScript) || raw.targetVerbatimScript.length === 0) {
    throw new Error("targetVerbatimScript must be a non-empty array");
  }
  const lineSlugs = new Set<string>();
  const targetVerbatimScript = raw.targetVerbatimScript.map((line, index) => {
    assertRecord(line, `targetVerbatimScript[${index}]`);
    const slug = text(line.slug, `targetVerbatimScript[${index}].slug`);
    if (lineSlugs.has(slug)) throw new Error(`Duplicate target script line slug: ${slug}`);
    lineSlugs.add(slug);
    const sectionSlug = text(line.sectionSlug, `targetVerbatimScript[${index}].sectionSlug`);
    if (!sectionSlugs.has(sectionSlug)) throw new Error(`Unknown script section for target line ${slug}: ${sectionSlug}`);
    const lineText = text(line.text, `targetVerbatimScript[${index}].text`);
    return {
      id: `tline_${sha256Canonical([slug, sectionSlug, lineText, index]).slice(0, 20)}`,
      slug,
      sectionSlug,
      text: lineText,
      purpose: text(line.purpose, `targetVerbatimScript[${index}].purpose`),
      delivery: text(line.delivery, `targetVerbatimScript[${index}].delivery`),
    };
  });
  const lineBySlug = new Map(targetVerbatimScript.map((line) => [line.slug, line]));
  const referenceShotBySlug = new Map(analysis.shots.map((shot) => [shot.slug, shot]));

  if (!Array.isArray(raw.shootingPlan) || raw.shootingPlan.length === 0) throw new Error("shootingPlan must be a non-empty array");
  const shootingSlugs = new Set<string>();
  let expectedIn = 0;
  const shootingPlan = raw.shootingPlan.map((shot, index) => {
    assertRecord(shot, `shootingPlan[${index}]`);
    const slug = text(shot.slug, `shootingPlan[${index}].slug`);
    if (shootingSlugs.has(slug)) throw new Error(`Duplicate shooting shot slug: ${slug}`);
    shootingSlugs.add(slug);
    const timelineIn = finiteTime(shot.timelineIn, `shootingPlan[${index}].timelineIn`);
    const timelineOut = finiteTime(shot.timelineOut, `shootingPlan[${index}].timelineOut`);
    if (timelineOut <= timelineIn) throw new Error(`Shooting shot ${slug} must end after it starts`);
    if (Math.abs(timelineIn - expectedIn) > 0.001) throw new Error(`Shooting timeline has a gap or overlap before ${slug}`);
    expectedIn = timelineOut;
    const sourceLineSlugs = textArray(shot.lineSlugs, `shootingPlan[${index}].lineSlugs`);
    const lineIds = sourceLineSlugs.map((lineSlug) => {
      const line = lineBySlug.get(lineSlug);
      if (!line) throw new Error(`Unknown target line slug in shootingPlan: ${lineSlug}`);
      return line.id;
    });
    const referenceShotSlugs = textArray(shot.referenceShotSlugs ?? [], `shootingPlan[${index}].referenceShotSlugs`, true);
    const referenceShotIds = referenceShotSlugs.map((referenceSlug) => {
      const referenceShot = referenceShotBySlug.get(referenceSlug);
      if (!referenceShot) throw new Error(`Unknown reference shot slug in shootingPlan: ${referenceSlug}`);
      return referenceShot.id;
    });
    const normalized = {
      slug,
      timelineIn,
      timelineOut,
      lineSlugs: sourceLineSlugs,
      lineIds,
      referenceShotSlugs,
      referenceShotIds,
      scene: text(shot.scene, `shootingPlan[${index}].scene`),
      framing: text(shot.framing, `shootingPlan[${index}].framing`),
      composition: text(shot.composition, `shootingPlan[${index}].composition`),
      cameraPosition: text(shot.cameraPosition, `shootingPlan[${index}].cameraPosition`),
      cameraMovement: text(shot.cameraMovement, `shootingPlan[${index}].cameraMovement`),
      subjectAction: text(shot.subjectAction, `shootingPlan[${index}].subjectAction`),
      performance: text(shot.performance, `shootingPlan[${index}].performance`),
      props: textArray(shot.props, `shootingPlan[${index}].props`),
      lighting: text(shot.lighting, `shootingPlan[${index}].lighting`),
      audioCapture: text(shot.audioCapture, `shootingPlan[${index}].audioCapture`),
      continuity: text(shot.continuity, `shootingPlan[${index}].continuity`),
      alternatives: textArray(shot.alternatives ?? [], `shootingPlan[${index}].alternatives`, true),
    };
    return {
      id: `tshot_${sha256Canonical([slug, timelineIn, timelineOut, lineIds, referenceShotIds, normalized.composition]).slice(0, 20)}`,
      ...normalized,
    };
  });
  if (Math.abs(expectedIn - durationSeconds) > 0.001) throw new Error("Shooting timeline must end at brief.durationSeconds");
  const lineUseCounts = new Map(targetVerbatimScript.map((line) => [line.id, 0]));
  for (const shot of shootingPlan) {
    for (const lineId of shot.lineIds) lineUseCounts.set(lineId, (lineUseCounts.get(lineId) ?? 0) + 1);
  }
  const invalidLineCoverage = [...lineUseCounts.entries()].filter(([, count]) => count !== 1);
  if (invalidLineCoverage.length > 0) {
    throw new Error(`Every target line must appear in exactly one shooting shot: ${invalidLineCoverage.map(([id, count]) => `${id}=${count}`).join(", ")}`);
  }
  const shootingBySlug = new Map(shootingPlan.map((shot) => [shot.slug, shot]));

  if (!Array.isArray(raw.editBlueprint) || raw.editBlueprint.length !== shootingPlan.length) {
    throw new Error("editBlueprint must contain exactly one entry for every shooting shot");
  }
  const blueprintSlugs = new Set<string>();
  const editBlueprint = raw.editBlueprint.map((blueprint, index) => {
    assertRecord(blueprint, `editBlueprint[${index}]`);
    const shootingShotSlug = text(blueprint.shootingShotSlug, `editBlueprint[${index}].shootingShotSlug`);
    if (blueprintSlugs.has(shootingShotSlug)) throw new Error(`Duplicate edit blueprint for ${shootingShotSlug}`);
    blueprintSlugs.add(shootingShotSlug);
    const shootingShot = shootingBySlug.get(shootingShotSlug);
    if (!shootingShot) throw new Error(`Unknown shootingShotSlug in editBlueprint: ${shootingShotSlug}`);
    if (!Array.isArray(blueprint.brollSlots ?? [])) throw new Error(`editBlueprint[${index}].brollSlots must be an array`);
    const brollSlots = (blueprint.brollSlots ?? []).map((slot, slotIndex) => {
      assertRecord(slot, `editBlueprint[${index}].brollSlots[${slotIndex}]`);
      const duration = finiteTime(slot.durationSeconds, `editBlueprint[${index}].brollSlots[${slotIndex}].durationSeconds`);
      if (duration <= 0) throw new Error(`B-roll slot duration must be greater than zero for ${shootingShotSlug}`);
      if (slot.reviewBeforeUse !== true) throw new Error(`B-roll slot ${shootingShotSlug}/${slotIndex} requires reviewBeforeUse=true`);
      const allowedSourceStrategies = new Set(["self_recorded", "licensed_stock", "generated_after_approval"]);
      if (!allowedSourceStrategies.has(slot.sourceStrategy)) {
        throw new Error(`Unsupported B-roll sourceStrategy for ${shootingShotSlug}/${slotIndex}: ${String(slot.sourceStrategy)}`);
      }
      assertRecord(slot.sourcePlan, `editBlueprint[${index}].brollSlots[${slotIndex}].sourcePlan`);
      const allowedRights = new Set(["user_owned", "licensed", "pending_generation"]);
      if (!allowedRights.has(slot.sourcePlan.rightsStatus)) {
        throw new Error(`Unsupported B-roll rightsStatus for ${shootingShotSlug}/${slotIndex}: ${String(slot.sourcePlan.rightsStatus)}`);
      }
      const sourcePlan = {
        provenance: text(slot.sourcePlan.provenance, `editBlueprint[${index}].brollSlots[${slotIndex}].sourcePlan.provenance`),
        rightsStatus: slot.sourcePlan.rightsStatus,
        licenseEvidencePath: slot.sourcePlan.licenseEvidencePath
          ? path.resolve(projectDir, text(slot.sourcePlan.licenseEvidencePath, `editBlueprint[${index}].brollSlots[${slotIndex}].sourcePlan.licenseEvidencePath`))
          : null,
        licenseEvidenceSha256: slot.sourcePlan.licenseEvidenceSha256
          ? text(
              slot.sourcePlan.licenseEvidenceSha256,
              `editBlueprint[${index}].brollSlots[${slotIndex}].sourcePlan.licenseEvidenceSha256`,
            ).toLowerCase()
          : null,
        assetId: slot.sourcePlan.assetId ? text(slot.sourcePlan.assetId, `editBlueprint[${index}].brollSlots[${slotIndex}].sourcePlan.assetId`) : null,
        assetSha256: slot.sourcePlan.assetSha256
          ? text(slot.sourcePlan.assetSha256, `editBlueprint[${index}].brollSlots[${slotIndex}].sourcePlan.assetSha256`).toLowerCase()
          : null,
      };
      if (sourcePlan.assetSha256 && !/^[a-f0-9]{64}$/.test(sourcePlan.assetSha256)) {
        throw new Error(`B-roll assetSha256 must be lowercase SHA-256 for ${shootingShotSlug}/${slotIndex}`);
      }
      if (sourcePlan.licenseEvidenceSha256 && !/^[a-f0-9]{64}$/.test(sourcePlan.licenseEvidenceSha256)) {
        throw new Error(`B-roll licenseEvidenceSha256 must be lowercase SHA-256 for ${shootingShotSlug}/${slotIndex}`);
      }
      if (sourcePlan.assetSha256 && !sourcePlan.assetId) {
        throw new Error(`B-roll assetSha256 requires assetId for ${shootingShotSlug}/${slotIndex}`);
      }
      if (
        slot.sourceStrategy === "licensed_stock"
        && (
          !sourcePlan.licenseEvidencePath
          || !sourcePlan.licenseEvidenceSha256
          || !sourcePlan.assetId
          || !sourcePlan.assetSha256
          || sourcePlan.rightsStatus !== "licensed"
        )
      ) {
        throw new Error(`licensed_stock B-roll requires licensed rights, license evidence, and a registered asset ID/hash for ${shootingShotSlug}/${slotIndex}`);
      }
      let generation: null | {
        executor: string;
        model: string;
        mode: string;
        prompt: string;
        promptHash: string;
        approvalStatus: "pending_plan_review";
      } = null;
      if (slot.sourceStrategy === "generated_after_approval") {
        assertRecord(slot.generation, `editBlueprint[${index}].brollSlots[${slotIndex}].generation`);
        const prompt = text(slot.generation.prompt, `editBlueprint[${index}].brollSlots[${slotIndex}].generation.prompt`);
        generation = {
          executor: text(slot.generation.executor, `editBlueprint[${index}].brollSlots[${slotIndex}].generation.executor`),
          model: text(slot.generation.model, `editBlueprint[${index}].brollSlots[${slotIndex}].generation.model`),
          mode: text(slot.generation.mode, `editBlueprint[${index}].brollSlots[${slotIndex}].generation.mode`),
          prompt,
          promptHash: sha256Canonical(prompt),
          approvalStatus: "pending_plan_review",
        };
        if (sourcePlan.rightsStatus !== "pending_generation") {
          throw new Error(`Generated B-roll requires rightsStatus=pending_generation for ${shootingShotSlug}/${slotIndex}`);
        }
      } else if (slot.generation) {
        throw new Error(`Only generated_after_approval B-roll may include generation settings for ${shootingShotSlug}/${slotIndex}`);
      }
      const trigger = text(slot.trigger, `editBlueprint[${index}].brollSlots[${slotIndex}].trigger`);
      const purpose = text(slot.purpose, `editBlueprint[${index}].brollSlots[${slotIndex}].purpose`);
      const visual = text(slot.visual, `editBlueprint[${index}].brollSlots[${slotIndex}].visual`);
      return {
        id: `broll_${sha256Canonical([shootingShot.id, trigger, purpose, visual, slotIndex]).slice(0, 20)}`,
        trigger,
        purpose,
        visual,
        sourceStrategy: slot.sourceStrategy,
        sourcePlan,
        generation,
        durationSeconds: duration,
        reviewBeforeUse: true as const,
      };
    });
    const motionGraphics = (blueprint.motionGraphics ?? []).map((slot, slotIndex) => {
      assertRecord(slot, `editBlueprint[${index}].motionGraphics[${slotIndex}]`);
      return {
        trigger: text(slot.trigger, `editBlueprint[${index}].motionGraphics[${slotIndex}].trigger`),
        purpose: text(slot.purpose, `editBlueprint[${index}].motionGraphics[${slotIndex}].purpose`),
        visual: text(slot.visual, `editBlueprint[${index}].motionGraphics[${slotIndex}].visual`),
        durationSeconds: finiteTime(slot.durationSeconds, `editBlueprint[${index}].motionGraphics[${slotIndex}].durationSeconds`),
      };
    });
    const sfx = (blueprint.sfx ?? []).map((slot, slotIndex) => {
      assertRecord(slot, `editBlueprint[${index}].sfx[${slotIndex}]`);
      return {
        trigger: text(slot.trigger, `editBlueprint[${index}].sfx[${slotIndex}].trigger`),
        sound: text(slot.sound, `editBlueprint[${index}].sfx[${slotIndex}].sound`),
        mix: text(slot.mix, `editBlueprint[${index}].sfx[${slotIndex}].mix`),
      };
    });
    assertRecord(blueprint.music, `editBlueprint[${index}].music`);
    return {
      shootingShotSlug,
      shootingShotId: shootingShot.id,
      referenceMechanisms: textArray(blueprint.referenceMechanisms, `editBlueprint[${index}].referenceMechanisms`),
      cutStrategy: text(blueprint.cutStrategy, `editBlueprint[${index}].cutStrategy`),
      pacing: text(blueprint.pacing, `editBlueprint[${index}].pacing`),
      brollSlots,
      motionGraphics,
      sfx,
      music: {
        cue: text(blueprint.music.cue, `editBlueprint[${index}].music.cue`),
        mood: text(blueprint.music.mood, `editBlueprint[${index}].music.mood`),
        change: text(blueprint.music.change, `editBlueprint[${index}].music.change`),
      },
      transition: text(blueprint.transition, `editBlueprint[${index}].transition`),
      keyFrames: textArray(blueprint.keyFrames, `editBlueprint[${index}].keyFrames`),
      acceptance: textArray(blueprint.acceptance, `editBlueprint[${index}].acceptance`),
    };
  });

  const targetDocument = { brief, scriptOutline, targetVerbatimScript, shootingPlan, editBlueprint };
  const targetErrors = replacementTargetErrors(adaptationPolicy.replacementMap, targetDocument);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("; "));

  assertOriginalWording([
    ...targetVerbatimScript.map((line) => ({ label: `targetVerbatimScript.${line.slug}`, value: line.text })),
    {
      label: "combined-target-script",
      value: targetVerbatimScript.map((line) => line.text).join(""),
    },
    ...scriptOutline.map((section) => ({
      label: `scriptOutline.${section.slug}.targetMessage`,
      value: section.targetMessage,
    })),
    ...shootingPlan.flatMap((shot) => [
      { label: `shootingPlan.${shot.slug}.scene`, value: shot.scene },
      { label: `shootingPlan.${shot.slug}.framing`, value: shot.framing },
      { label: `shootingPlan.${shot.slug}.composition`, value: shot.composition },
      { label: `shootingPlan.${shot.slug}.cameraPosition`, value: shot.cameraPosition },
      { label: `shootingPlan.${shot.slug}.cameraMovement`, value: shot.cameraMovement },
      { label: `shootingPlan.${shot.slug}.subjectAction`, value: shot.subjectAction },
      { label: `shootingPlan.${shot.slug}.performance`, value: shot.performance },
      ...shot.props.map((value, index) => ({ label: `shootingPlan.${shot.slug}.props[${index}]`, value })),
      { label: `shootingPlan.${shot.slug}.lighting`, value: shot.lighting },
      { label: `shootingPlan.${shot.slug}.audioCapture`, value: shot.audioCapture },
      { label: `shootingPlan.${shot.slug}.continuity`, value: shot.continuity },
      ...shot.alternatives.map((value, index) => ({ label: `shootingPlan.${shot.slug}.alternatives[${index}]`, value })),
    ]),
    ...editBlueprint.flatMap((blueprint) => [
      ...(blueprint.brollSlots ?? []).map((slot, index) => ({
        label: `editBlueprint.${blueprint.shootingShotSlug}.brollSlots[${index}].visual`,
        value: slot.visual,
      })),
      ...(blueprint.motionGraphics ?? []).map((slot, index) => ({
        label: `editBlueprint.${blueprint.shootingShotSlug}.motionGraphics[${index}].visual`,
        value: slot.visual,
      })),
      ...(blueprint.brollSlots ?? []).flatMap((slot, index) => slot.generation
        ? [{
            label: `editBlueprint.${blueprint.shootingShotSlug}.brollSlots[${index}].generation.prompt`,
            value: slot.generation.prompt,
          }]
        : []),
      ...(blueprint.sfx ?? []).map((slot, index) => ({
        label: `editBlueprint.${blueprint.shootingShotSlug}.sfx[${index}]`,
        value: `${slot.sound} ${slot.mix}`,
      })),
      { label: `editBlueprint.${blueprint.shootingShotSlug}.music`, value: `${blueprint.music.cue} ${blueprint.music.mood} ${blueprint.music.change}` },
      { label: `editBlueprint.${blueprint.shootingShotSlug}.transition`, value: blueprint.transition },
    ]),
  ], analysis, adaptationPolicy.mode);

  return { brief, adaptationPolicy, creativeOptions, selectedOptionSlug, scriptOutline, targetVerbatimScript, shootingPlan, editBlueprint };
}

export function recreationPlanContent(plan: RecreationPlanArtifact) {
  return {
    referenceAnalysisContentHash: plan.referenceAnalysisContentHash,
    referenceAssetHash: plan.referenceAssetHash,
    briefHash: plan.briefHash,
    brief: plan.brief,
    adaptationPolicy: plan.adaptationPolicy,
    creativeOptions: plan.creativeOptions,
    selectedOptionSlug: plan.selectedOptionSlug,
    scriptOutline: plan.scriptOutline,
    targetVerbatimScript: plan.targetVerbatimScript,
    shootingPlan: plan.shootingPlan,
    editBlueprint: plan.editBlueprint,
  };
}

function hasCurrentRecreationUserApproval(plan: RecreationPlanArtifact): boolean {
  return plan.reviews.some((review) =>
    review.decision === "approve"
    && review.authority === "user"
    && review.contentHash === plan.contentHash
    && review.referenceAnalysisContentHash === plan.referenceAnalysisContentHash,
  );
}

export function recreationPlanSemanticErrors(
  plan: RecreationPlanArtifact,
  analysis?: ReferenceAnalysisArtifact,
  expectedAspectRatio?: string,
  expectedPlatform?: string,
): string[] {
  const errors: string[] = [];
  if (sha256Canonical(recreationPlanContent(plan)) !== plan.contentHash) errors.push("contentHash does not match the current recreation plan content");
  if (expectedAspectRatio && plan.brief.aspectRatio !== expectedAspectRatio) {
    errors.push(`brief.aspectRatio ${plan.brief.aspectRatio} does not match project output ${expectedAspectRatio}`);
  }
  if (expectedPlatform && plan.brief.platform !== expectedPlatform) {
    errors.push(`brief.platform ${plan.brief.platform} does not match project platform ${expectedPlatform}`);
  }
  const optionSlugs = new Set(plan.creativeOptions.map((option) => option.slug));
  if (plan.creativeOptions.length < 2 || plan.creativeOptions.length > 3 || optionSlugs.size !== plan.creativeOptions.length) {
    errors.push("creativeOptions must contain two or three unique options");
  }
  if (!optionSlugs.has(plan.selectedOptionSlug)) errors.push("selectedOptionSlug does not match a creative option");
  const lineIds = new Set(plan.targetVerbatimScript.map((line) => line.id));
  if (lineIds.size !== plan.targetVerbatimScript.length) errors.push("targetVerbatimScript contains duplicate line IDs");
  const shotIds = new Set(plan.shootingPlan.map((shot) => shot.id));
  if (shotIds.size !== plan.shootingPlan.length) errors.push("shootingPlan contains duplicate shot IDs");
  let expectedIn = 0;
  const lineUseCounts = new Map([...lineIds].map((lineId) => [lineId, 0]));
  for (const [index, shot] of plan.shootingPlan.entries()) {
    if (!Number.isFinite(shot.timelineIn) || !Number.isFinite(shot.timelineOut) || shot.timelineOut <= shot.timelineIn) {
      errors.push(`shootingPlan[${index}] has invalid timing`);
    }
    if (Math.abs(shot.timelineIn - expectedIn) > 0.001) errors.push(`shootingPlan[${index}] has a gap or overlap`);
    expectedIn = shot.timelineOut;
    for (const lineId of shot.lineIds) {
      if (!lineIds.has(lineId)) errors.push(`shootingPlan[${index}] references unknown target line ${lineId}`);
      else lineUseCounts.set(lineId, (lineUseCounts.get(lineId) ?? 0) + 1);
    }
  }
  for (const [lineId, count] of lineUseCounts) {
    if (count !== 1) errors.push(`target line ${lineId} must appear in exactly one shooting shot, got ${count}`);
  }
  if (Math.abs(expectedIn - plan.brief.durationSeconds) > 0.001) errors.push("shootingPlan does not end at brief.durationSeconds");
  const blueprintShotIds = new Set<string>();
  const brollIds = new Set<string>();
  for (const [index, blueprint] of plan.editBlueprint.entries()) {
    if (!shotIds.has(blueprint.shootingShotId)) errors.push(`editBlueprint[${index}] references unknown shooting shot`);
    if (blueprintShotIds.has(blueprint.shootingShotId)) errors.push(`editBlueprint[${index}] duplicates a shooting shot`);
    blueprintShotIds.add(blueprint.shootingShotId);
    for (const [slotIndex, slot] of (blueprint.brollSlots ?? []).entries()) {
      if (!/^broll_[a-f0-9]{20}$/.test(slot.id)) errors.push(`editBlueprint[${index}].brollSlots[${slotIndex}] has invalid stable ID`);
      if (brollIds.has(slot.id)) errors.push(`editBlueprint[${index}].brollSlots[${slotIndex}] duplicates B-roll ID ${slot.id}`);
      brollIds.add(slot.id);
      if (slot.reviewBeforeUse !== true) errors.push(`editBlueprint[${index}].brollSlots[${slotIndex}] must require preview review`);
      if (slot.sourceStrategy === "licensed_stock") {
        if (
          slot.sourcePlan.rightsStatus !== "licensed"
          || !slot.sourcePlan.licenseEvidencePath
          || !slot.sourcePlan.licenseEvidenceSha256
          || !slot.sourcePlan.assetId
          || !slot.sourcePlan.assetSha256
        ) {
          errors.push(`editBlueprint[${index}].brollSlots[${slotIndex}] lacks hash-bound license evidence or registered asset`);
        }
      }
      if (slot.sourceStrategy === "generated_after_approval") {
        if (!slot.generation) errors.push(`editBlueprint[${index}].brollSlots[${slotIndex}] lacks generation settings`);
        else if (sha256Canonical(slot.generation.prompt) !== slot.generation.promptHash) {
          errors.push(`editBlueprint[${index}].brollSlots[${slotIndex}] promptHash is stale`);
        }
      }
    }
  }
  if (blueprintShotIds.size !== shotIds.size) errors.push("editBlueprint does not cover every shooting shot exactly once");
  if (plan.adaptationPolicy.mode === "authorized_close_recreation") {
    if (plan.adaptationPolicy.authorizationEvidence.length === 0) errors.push("authorized close recreation lacks authorization evidence");
    for (const [index, evidence] of plan.adaptationPolicy.authorizationEvidence.entries()) {
      if (!evidence.authorizedBy?.trim()) errors.push(`authorizationEvidence[${index}] lacks authorizedBy`);
      if (!evidence.rightsHolder?.trim()) errors.push(`authorizationEvidence[${index}] lacks rightsHolder`);
      if (!Array.isArray(evidence.authorizedElements) || evidence.authorizedElements.length === 0) {
        errors.push(`authorizationEvidence[${index}] lacks authorizedElements`);
      }
      if (analysis && evidence.referenceAssetSha256 !== analysis.source.sha256) {
        errors.push(`authorizationEvidence[${index}] is not bound to the current reference asset`);
      }
      if (!evidence.verifiedBy?.trim()) errors.push(`authorizationEvidence[${index}] lacks verifiedBy`);
      if (!ISO_DATE_TIME.test(evidence.verifiedAt) || !Number.isFinite(Date.parse(evidence.verifiedAt))) {
        errors.push(`authorizationEvidence[${index}] has invalid verifiedAt`);
      }
      if (!evidence.scope.includes("close_recreation")) errors.push(`authorizationEvidence[${index}] lacks close_recreation scope`);
    }
    if (analysis && (analysis.source.intendedUse !== "authorized_close_recreation" || analysis.source.rightsStatus !== "cleared")) {
      errors.push("authorized close recreation is incompatible with the reference rights contract");
    }
  }
  if (analysis) {
    if (analysis.source.intendedUse === "analysis_only") errors.push("reference intendedUse=analysis_only forbids a recreation plan");
    if (analysis.contentHash !== plan.referenceAnalysisContentHash) errors.push("referenceAnalysisContentHash is stale");
    if (analysis.source.sha256 !== plan.referenceAssetHash) errors.push("referenceAssetHash is stale");
    const referenceShotIds = new Set(analysis.shots.map((shot) => shot.id));
    for (const [index, shot] of plan.shootingPlan.entries()) {
      for (const referenceShotId of shot.referenceShotIds) {
        if (!referenceShotIds.has(referenceShotId)) errors.push(`shootingPlan[${index}] references unknown reference shot ${referenceShotId}`);
      }
    }
    const requiredReplacementSources = new Set([...analysis.protectedElements, ...plan.adaptationPolicy.mustReplace]);
    const mappedReplacementSources = new Set<string>();
    for (const [index, mapping] of plan.adaptationPolicy.replacementMap.entries()) {
      if (!requiredReplacementSources.has(mapping.sourceElement)) {
        errors.push(`replacementMap[${index}] references undeclared source element ${mapping.sourceElement}`);
      }
      if (mappedReplacementSources.has(mapping.sourceElement)) errors.push(`replacementMap duplicates ${mapping.sourceElement}`);
      mappedReplacementSources.add(mapping.sourceElement);
      if (mapping.action === "licensed_reuse" && plan.adaptationPolicy.mode !== "authorized_close_recreation") {
        errors.push(`replacementMap[${index}] uses licensed_reuse outside authorized_close_recreation`);
      }
      if (
        mapping.action === "licensed_reuse"
        && !plan.adaptationPolicy.authorizationEvidence.some((evidence) =>
          evidence.scope.includes("close_recreation") && evidence.authorizedElements.includes(mapping.sourceElement),
        )
      ) {
        errors.push(`replacementMap[${index}] licensed_reuse is not authorized for ${mapping.sourceElement}`);
      }
      if (mapping.action === "replace" && normalizeComparison(mapping.replacement) === normalizeComparison(mapping.sourceElement)) {
        errors.push(`replacementMap[${index}] does not materially replace ${mapping.sourceElement}`);
      }
    }
    for (const sourceElement of requiredReplacementSources) {
      if (!mappedReplacementSources.has(sourceElement)) errors.push(`replacementMap does not cover ${sourceElement}`);
    }
    errors.push(...replacementTargetErrors(plan.adaptationPolicy.replacementMap, {
      brief: plan.brief,
      scriptOutline: plan.scriptOutline,
      targetVerbatimScript: plan.targetVerbatimScript,
      shootingPlan: plan.shootingPlan,
      editBlueprint: plan.editBlueprint,
    }));
    try {
      assertOriginalWording([
        ...plan.targetVerbatimScript.map((line) => ({ label: `targetVerbatimScript.${line.slug}`, value: line.text })),
        { label: "combined-target-script", value: plan.targetVerbatimScript.map((line) => line.text).join("") },
        ...plan.scriptOutline.map((section) => ({
          label: `scriptOutline.${section.slug}.targetMessage`,
          value: section.targetMessage,
        })),
        ...plan.shootingPlan.flatMap((shot) => [
          { label: `shootingPlan.${shot.slug}.scene`, value: shot.scene },
          { label: `shootingPlan.${shot.slug}.framing`, value: shot.framing },
          { label: `shootingPlan.${shot.slug}.composition`, value: shot.composition },
          { label: `shootingPlan.${shot.slug}.cameraPosition`, value: shot.cameraPosition },
          { label: `shootingPlan.${shot.slug}.cameraMovement`, value: shot.cameraMovement },
          { label: `shootingPlan.${shot.slug}.subjectAction`, value: shot.subjectAction },
          { label: `shootingPlan.${shot.slug}.performance`, value: shot.performance },
          ...shot.props.map((value, itemIndex) => ({ label: `shootingPlan.${shot.slug}.props[${itemIndex}]`, value })),
          { label: `shootingPlan.${shot.slug}.lighting`, value: shot.lighting },
          { label: `shootingPlan.${shot.slug}.audioCapture`, value: shot.audioCapture },
          { label: `shootingPlan.${shot.slug}.continuity`, value: shot.continuity },
          ...(shot.alternatives ?? []).map((value, itemIndex) => ({ label: `shootingPlan.${shot.slug}.alternatives[${itemIndex}]`, value })),
        ]),
        ...plan.editBlueprint.flatMap((blueprint) => [
          ...(blueprint.brollSlots ?? []).map((slot, index) => ({
            label: `editBlueprint.${blueprint.shootingShotSlug}.brollSlots[${index}].visual`,
            value: slot.visual,
          })),
          ...(blueprint.motionGraphics ?? []).map((slot, index) => ({
            label: `editBlueprint.${blueprint.shootingShotSlug}.motionGraphics[${index}].visual`,
            value: slot.visual,
          })),
          ...(blueprint.brollSlots ?? []).flatMap((slot, index) => slot.generation
            ? [{
                label: `editBlueprint.${blueprint.shootingShotSlug}.brollSlots[${index}].generation.prompt`,
                value: slot.generation.prompt,
              }]
            : []),
          ...(blueprint.sfx ?? []).map((slot, index) => ({
            label: `editBlueprint.${blueprint.shootingShotSlug}.sfx[${index}]`,
            value: `${slot.sound} ${slot.mix}`,
          })),
          { label: `editBlueprint.${blueprint.shootingShotSlug}.music`, value: `${blueprint.music.cue} ${blueprint.music.mood} ${blueprint.music.change}` },
          { label: `editBlueprint.${blueprint.shootingShotSlug}.transition`, value: blueprint.transition },
        ]),
      ], analysis, plan.adaptationPolicy.mode);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (plan.status === "approved" || plan.status === "applied") {
    if (plan.approvedContentHash !== plan.contentHash) errors.push("approvedContentHash does not match contentHash");
    if (!hasCurrentRecreationUserApproval(plan)) errors.push("approved/applied status lacks a current hash-bound user approval record");
  }
  if (!new Set(["approved", "applied"]).has(plan.status) && plan.approvedContentHash !== null) {
    errors.push("non-approved recreation plan must not retain approvedContentHash");
  }
  return errors;
}

function escapeCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function recreationMarkdown(plan: RecreationPlanArtifact): string {
  const lineById = new Map(plan.targetVerbatimScript.map((line) => [line.id, line]));
  const blueprintByShotId = new Map(plan.editBlueprint.map((blueprint) => [blueprint.shootingShotId, blueprint]));
  const rows = plan.shootingPlan.map((shot) => {
    const lines = shot.lineIds.map((id) => lineById.get(id)?.text ?? "").join("<br>");
    const blueprint = blueprintByShotId.get(shot.id)!;
    const broll = blueprint.brollSlots?.map((slot) => `${slot.id}｜${slot.trigger}：${slot.visual}（${slot.purpose}）`).join("<br>") || "无";
    const mg = blueprint.motionGraphics?.map((slot) => `${slot.trigger}：${slot.visual}`).join("<br>") || "无";
    const sound = [
      ...(blueprint.sfx?.map((slot) => `${slot.trigger}：${slot.sound}，${slot.mix}`) ?? []),
      `音乐：${blueprint.music.cue}；${blueprint.music.change}`,
    ].join("<br>");
    return `| ${escapeCell(`${shot.timelineIn.toFixed(3)}–${shot.timelineOut.toFixed(3)}`)} | ${escapeCell(lines)} | ${escapeCell(`${shot.performance}；${shot.subjectAction}`)} | ${escapeCell(`${shot.framing}；${shot.composition}；${shot.cameraPosition}；${shot.cameraMovement}`)} | ${escapeCell(broll)} | ${escapeCell(mg)} | ${escapeCell(sound)} | ${escapeCell(blueprint.referenceMechanisms.join(" / "))} | ${escapeCell(blueprint.acceptance.join(" / "))} |`;
  });
  const shootingDetailRows = plan.shootingPlan.map((shot) =>
    `| ${escapeCell(`${shot.timelineIn.toFixed(3)}–${shot.timelineOut.toFixed(3)}`)} | ${escapeCell(shot.scene)} | ${escapeCell(`${shot.framing}；${shot.composition}`)} | ${escapeCell(`${shot.cameraPosition}；${shot.cameraMovement}`)} | ${escapeCell(`${shot.performance}；${shot.subjectAction}`)} | ${escapeCell(shot.props.join(" / "))} | ${escapeCell(shot.lighting)} | ${escapeCell(shot.audioCapture)} | ${escapeCell(shot.continuity)} | ${escapeCell((shot.alternatives ?? []).join(" / ") || "无")} |`,
  );
  const brollReviewRows = plan.editBlueprint.flatMap((blueprint) => blueprint.brollSlots.map((slot) => {
    const sourceEvidence = [
      `provenance=${slot.sourcePlan.provenance}`,
      `rights=${slot.sourcePlan.rightsStatus}`,
      slot.sourcePlan.licenseEvidencePath ? `license=${slot.sourcePlan.licenseEvidencePath}` : null,
      slot.sourcePlan.licenseEvidenceSha256 ? `licenseHash=${slot.sourcePlan.licenseEvidenceSha256}` : null,
      slot.sourcePlan.assetId ? `asset=${slot.sourcePlan.assetId}` : null,
      slot.sourcePlan.assetSha256 ? `assetHash=${slot.sourcePlan.assetSha256}` : null,
    ].filter(Boolean).join("<br>");
    const generation = slot.generation
      ? [
          `executor=${slot.generation.executor}`,
          `model=${slot.generation.model}`,
          `mode=${slot.generation.mode}`,
          `status=${slot.generation.approvalStatus}`,
          `promptHash=${slot.generation.promptHash}`,
          `完整提示词：${slot.generation.prompt}`,
        ].join("<br>")
      : "不生成";
    return `| ${escapeCell(slot.id)} | ${escapeCell(blueprint.shootingShotSlug)} | ${escapeCell(slot.trigger)} | ${escapeCell(slot.purpose)} | ${escapeCell(slot.visual)} | ${escapeCell(slot.durationSeconds)} | ${escapeCell(slot.sourceStrategy)} | ${escapeCell(sourceEvidence)} | ${escapeCell(generation)} | ${slot.reviewBeforeUse ? "必须预览后使用" : "禁止"} |`;
  }));
  const replacementRows = plan.adaptationPolicy.replacementMap.map((item) =>
    `| ${escapeCell(item.sourceElement)} | ${escapeCell(item.action)} | ${escapeCell(item.replacement)} | ${escapeCell(item.replacementAnchors.join("<br>"))} | ${escapeCell(item.targetPaths.join("<br>"))} | ${escapeCell(item.verification)} |`,
  );
  return [
    "# 参考视频原创仿拍拍摄与剪辑表",
    "",
    `- 模式：${plan.adaptationPolicy.mode}`,
    `- 平台 / 画幅：${plan.brief.platform} / ${plan.brief.aspectRatio}`,
    `- 目标时长：${plan.brief.durationSeconds} 秒`,
    `- 目标：${plan.brief.objective}`,
    `- 本次审批内容哈希：\`${plan.contentHash}\``,
    "",
    "## 方案选择",
    "",
    "| 方案 | 核心思路 | 如何借鉴参考片 | 视觉路径 | 成本 | 风险 | 适配度 | 选择 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...plan.creativeOptions.map((option) => `| ${escapeCell(option.name)} | ${escapeCell(option.coreIdea)} | ${escapeCell(option.referenceUse)} | ${escapeCell(option.visualApproach)} | ${escapeCell(option.productionCost)} | ${escapeCell(option.risk)} | ${escapeCell(option.fit)} | ${option.slug === plan.selectedOptionSlug ? "已选" : "备选"} |`),
    "",
    "> 原片逐字稿只用于证据分析；下表“目标逐字稿”才是本次拍摄提词稿。",
    "",
    "| 时间 | 目标逐字稿 | 表演与动作 | 景别、构图、机位与运镜 | B-roll | MG 动效 | SFX / 配乐 | 借鉴机制 | 验收 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## 完整拍摄执行表",
    "",
    "| 时间 | 场景 | 景别与构图 | 机位与运镜 | 表演与动作 | 道具 | 光线 | 收音 | 连续性 | 备选方案 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...shootingDetailRows,
    "",
    "## B-roll 资产与生成提示词审批表",
    "",
    "> `pending_plan_review` 只代表提示词方案待审，不代表素材已经生成或验收。",
    "",
    "| 槽位 ID | 镜头 | 触发词 | 目的 | 具体画面 | 秒数 | 来源策略 | 来源、授权与资产哈希 | 生成执行器、模型、模式与完整提示词 | 使用门 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...(brollReviewRows.length > 0 ? brollReviewRows : ["| 无 | - | - | - | - | - | - | - | - | - |"]),
    "",
    "## 受保护元素替换与授权核对",
    "",
    "| 原片元素 / 必须替换项 | 动作 | 新片替代方案 | 可核验替代锚点 | 实际目标字段 | 验收方法 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...replacementRows,
    "",
    "## 关键审核帧",
    "",
    ...plan.editBlueprint.flatMap((blueprint) => blueprint.keyFrames.map((frame) => `- ${blueprint.shootingShotSlug}：${frame}`)),
    "",
  ].join("\n");
}

function teleprompterText(plan: RecreationPlanArtifact): string {
  return plan.targetVerbatimScript.map((line) => line.text).join("\n\n");
}

async function verifyAuthorizationEvidence(
  evidenceItems: RecreationPlanInput["adaptationPolicy"]["authorizationEvidence"],
  referenceAssetSha256: string,
): Promise<void> {
  for (const evidence of evidenceItems) {
    if (!evidence.authorizedBy?.trim()) throw new Error(`Authorization evidence lacks authorizedBy: ${evidence.path}`);
    if (!evidence.verifiedBy?.trim()) throw new Error(`Authorization evidence lacks verifiedBy: ${evidence.path}`);
    if (!ISO_DATE_TIME.test(evidence.verifiedAt) || !Number.isFinite(Date.parse(evidence.verifiedAt))) {
      throw new Error(`Authorization evidence has invalid verifiedAt: ${evidence.path}`);
    }
    if (!evidence.scope.includes("close_recreation")) {
      throw new Error(`Authorization evidence lacks close_recreation scope: ${evidence.path}`);
    }
    if (evidence.referenceAssetSha256 !== referenceAssetSha256) {
      throw new Error(`Authorization evidence is not bound to the current reference asset: ${evidence.path}`);
    }
    if (!evidence.rightsHolder?.trim() || evidence.authorizedElements.length === 0) {
      throw new Error(`Authorization evidence lacks rightsHolder or authorizedElements: ${evidence.path}`);
    }
    let actualHash: string;
    try {
      actualHash = await sha256File(evidence.path);
    } catch {
      throw new Error(`Authorization evidence does not exist or is unreadable: ${evidence.path}`);
    }
    if (actualHash !== evidence.sha256) {
      throw new Error(`Authorization evidence hash changed: ${evidence.path}`);
    }
  }
}

async function verifyBrollSourceEvidence(projectDir: string, editBlueprint: NormalizedBlueprint[]): Promise<void> {
  const assets = await readJson<{
    assets: Array<{ assetId: string; path: string; sha256: string; rights?: { status?: string } }>;
  }>(path.join(projectDir, "assets.json"));
  for (const blueprint of editBlueprint) {
    for (const slot of blueprint.brollSlots) {
      if (slot.sourceStrategy !== "licensed_stock") continue;
      const evidencePath = slot.sourcePlan.licenseEvidencePath;
      const expectedHash = slot.sourcePlan.licenseEvidenceSha256;
      const assetId = slot.sourcePlan.assetId;
      const assetSha256 = slot.sourcePlan.assetSha256;
      if (!evidencePath || !expectedHash || !assetId || !assetSha256) {
        throw new Error(`Licensed B-roll ${slot.id} requires hash-bound license evidence and a registered asset`);
      }
      let actualHash: string;
      try {
        actualHash = await sha256File(evidencePath);
      } catch {
        throw new Error(`Licensed B-roll evidence does not exist or is unreadable: ${evidencePath}`);
      }
      if (actualHash !== expectedHash) {
        throw new Error(`Licensed B-roll evidence hash changed: ${evidencePath}`);
      }
      const asset = assets.assets.find((candidate) => candidate.assetId === assetId);
      if (!asset) throw new Error(`Licensed B-roll asset is not registered: ${assetId}`);
      if (asset.sha256 !== assetSha256) throw new Error(`Licensed B-roll asset registry hash differs for ${assetId}`);
      if (asset.rights?.status !== "cleared") throw new Error(`Licensed B-roll asset rights are not cleared: ${assetId}`);
      let currentAssetHash: string;
      try {
        currentAssetHash = await sha256File(asset.path);
      } catch {
        throw new Error(`Licensed B-roll asset does not exist or is unreadable: ${asset.path}`);
      }
      if (currentAssetHash !== assetSha256) throw new Error(`Licensed B-roll asset hash changed: ${asset.path}`);
    }
  }
}

interface CreateRecreationPlanInput {
  projectDir: string;
  inputPath: string;
}

export async function createRecreationPlan(input: CreateRecreationPlanInput) {
  return withProjectStateLock(input.projectDir, "create-recreation-plan", () => createRecreationPlanLocked(input));
}

async function createRecreationPlanLocked(input: CreateRecreationPlanInput) {
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  if (project.workflowStatus === "archived") throw new Error("plan-recreation cannot change an archived project");
  const existingJournal = await readOptionalJson<RecreationApplicationJournal>(
    path.join(input.projectDir, "recreation-application.json"),
  );
  if (existingJournal?.status === "pending") {
    throw new Error("plan-recreation cannot replace a plan while a recreation application transaction is pending");
  }
  const existingPlan = await readOptionalJson<RecreationPlanArtifact>(
    path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan),
  );
  if (existingPlan && new Set(["approved", "applied"]).has(existingPlan.status)) {
    throw new Error(`plan-recreation cannot replace an ${existingPlan.status} plan; request revision first`);
  }
  const analysis = await verifyReferenceAnalysis(input.projectDir);
  if (
    analysis.status !== "approved"
    || analysis.approvedContentHash !== analysis.contentHash
    || !hasCurrentReferenceUserApproval(analysis)
  ) {
    throw new Error("plan-recreation requires an approved current reference analysis");
  }
  if (analysis.source.intendedUse === "analysis_only") {
    throw new Error("plan-recreation is not allowed because the approved reference is restricted to analysis_only");
  }
  const raw = await readJson<RecreationPlanInput>(path.resolve(input.inputPath));
  const normalized = normalizePlan(raw, analysis, input.projectDir, project.aspectRatio, project.platform);
  if (normalized.adaptationPolicy.mode === "authorized_close_recreation") {
    await verifyAuthorizationEvidence(normalized.adaptationPolicy.authorizationEvidence, analysis.source.sha256);
  }
  await verifyBrollSourceEvidence(input.projectDir, normalized.editBlueprint);
  const semantic = {
    referenceAnalysisContentHash: analysis.contentHash,
    referenceAssetHash: analysis.source.sha256,
    briefHash: sha256Canonical(normalized.brief),
    ...normalized,
  };
  const artifact: RecreationPlanArtifact = {
    schemaVersion: SCHEMA_VERSION,
    kind: "reference-video-recreation-plan",
    status: "pending_user_review",
    ...semantic,
    inputHash: sha256Canonical(raw),
    contentHash: sha256Canonical(semantic),
    approvedContentHash: null,
    reviews: existingPlan?.reviews ?? [],
    applications: existingPlan?.applications ?? [],
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan), artifact);
  await writeFile(path.join(input.projectDir, "recreation-board.md"), `${recreationMarkdown(artifact)}\n`, "utf8");
  await writeFile(path.join(input.projectDir, "teleprompter.txt"), `${teleprompterText(artifact)}\n`, "utf8");
  project.artifacts.recreationPlan = REFERENCE_ARTIFACT_FILES.recreationPlan;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return {
    status: artifact.status,
    contentHash: artifact.contentHash,
    targetLines: artifact.targetVerbatimScript.length,
    shootingShots: artifact.shootingPlan.length,
    editBlueprints: artifact.editBlueprint.length,
  };
}

export async function verifyRecreationPlan(projectDir: string): Promise<RecreationPlanArtifact> {
  const planPath = path.join(projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan);
  const plan = await readJson<RecreationPlanArtifact>(planPath);
  const currentHash = sha256Canonical(recreationPlanContent(plan));
  if (currentHash !== plan.contentHash) {
    throw new Error("Recreation plan content drifted; regenerate and review it again");
  }
  const analysis = await verifyReferenceAnalysis(projectDir);
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  if (
    analysis.contentHash !== plan.referenceAnalysisContentHash
    || analysis.source.sha256 !== plan.referenceAssetHash
    || analysis.status !== "approved"
    || analysis.approvedContentHash !== analysis.contentHash
    || !hasCurrentReferenceUserApproval(analysis)
  ) {
    throw new Error("Recreation plan is stale because its reference analysis changed or approval was withdrawn");
  }
  if (analysis.source.intendedUse === "analysis_only") {
    throw new Error("Recreation plan is stale because the reference is restricted to analysis_only");
  }
  if (plan.brief.aspectRatio !== project.aspectRatio) {
    throw new Error("Recreation plan is stale because its aspect ratio no longer matches the project output");
  }
  if (plan.brief.platform !== project.platform) {
    throw new Error("Recreation plan is stale because its platform no longer matches the project platform");
  }
  if (plan.adaptationPolicy.mode === "authorized_close_recreation") {
    await verifyAuthorizationEvidence(plan.adaptationPolicy.authorizationEvidence, analysis.source.sha256);
  }
  await verifyBrollSourceEvidence(projectDir, plan.editBlueprint);
  const semanticErrors = recreationPlanSemanticErrors(plan, analysis, project.aspectRatio, project.platform);
  if (semanticErrors.length > 0) {
    throw new Error(`Recreation plan is semantically invalid: ${semanticErrors.join("; ")}`);
  }
  const expectedBoard = `${recreationMarkdown(plan)}\n`;
  const expectedTeleprompter = `${teleprompterText(plan)}\n`;
  const boardPath = path.join(projectDir, "recreation-board.md");
  const teleprompterPath = path.join(projectDir, "teleprompter.txt");
  let actualBoard: string;
  let actualTeleprompter: string;
  try {
    [actualBoard, actualTeleprompter] = await Promise.all([
      readFile(boardPath, "utf8"),
      readFile(teleprompterPath, "utf8"),
    ]);
  } catch {
    throw new Error("Recreation review board or teleprompter is missing or unreadable");
  }
  if (actualBoard !== expectedBoard || actualTeleprompter !== expectedTeleprompter) {
    throw new Error("Recreation review board or teleprompter drifted from the hash-bound JSON contract");
  }
  return plan;
}

interface ReviewDependencyFile {
  versions: Array<{
    versionId?: string;
    evidenceStatus?: string;
    userStatus?: string;
    [key: string]: unknown;
  }>;
  dependencyInvalidations?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function removeRecreationBindings(editPlan: EditPlanWithRecreation, planContentHash: string): boolean {
  let changed = false;
  for (const shot of editPlan.shots) {
    if (shot.referenceRecreation?.planContentHash === planContentHash) {
      delete shot.referenceRecreation;
      changed = true;
    }
  }
  if (editPlan.referenceRecreationApplication?.planContentHash === planContentHash) {
    delete editPlan.referenceRecreationApplication;
    changed = true;
  }
  return changed;
}

async function invalidateDownstreamRecreationEvidence(input: {
  projectDir: string;
  project: VideoProject;
  planContentHash: string;
  reviewer: string;
  invalidatedAt: string;
  reason: string;
}): Promise<void> {
  const downstreamStatuses = new Set([
    "visual_direction_ready",
    "draft1_pending_user",
    "draft1_approved",
    "revision_in_progress",
    "internal_review_passed",
    "draft2_pending_user",
    "final_confirmed",
  ]);
  if (downstreamStatuses.has(input.project.workflowStatus)) {
    input.project.workflowStatus = "revision_in_progress";
    input.project.updatedAt = input.invalidatedAt;
    await writeJsonAtomic(path.join(input.projectDir, "project.json"), input.project);
  }
  const reviewPath = path.join(input.projectDir, "review.json");
  const review = await readOptionalJson<ReviewDependencyFile>(reviewPath);
  if (!review) return;
  for (const version of review.versions ?? []) {
    version.evidenceStatus = "invalidated";
    if (version.userStatus === "confirmed" || version.userStatus === "pending") {
      version.userStatus = "revision_requested";
    }
  }
  const priorInvalidations = review.dependencyInvalidations ?? [];
  review.dependencyInvalidations = priorInvalidations.some(
    (record) => record.dependency === "recreation-plan.json" && record.planContentHash === input.planContentHash,
  )
    ? priorInvalidations
    : [
        ...priorInvalidations,
        {
          dependency: "recreation-plan.json",
          planContentHash: input.planContentHash,
          reviewer: input.reviewer,
          invalidatedAt: input.invalidatedAt,
          reason: input.reason,
        },
      ];
  await writeJsonAtomic(reviewPath, review);
}

async function rollbackPendingRecreationApplication(input: {
  projectDir: string;
  project: VideoProject;
  plan: RecreationPlanArtifact;
  journal: RecreationApplicationJournal;
  reviewer: string;
  authority: "user" | "operator";
  reviewedAt: string;
  notes?: string;
}): Promise<boolean> {
  if (input.journal.planContentHash !== input.plan.contentHash) {
    throw new Error("Cannot revise recreation while a different application transaction is pending");
  }
  const editPlanPath = path.join(input.projectDir, "edit-plan.json");
  const journalPath = path.join(input.projectDir, "recreation-application.json");
  const editPlan = await readJson<EditPlanWithRecreation>(editPlanPath);
  const currentFileHash = await sha256File(editPlanPath);
  const currentContentHash = sha256Canonical(editPlan);
  let rollbackPlan: EditPlanWithRecreation | null = null;

  if (input.journal.status === "pending") {
    if (currentFileHash === input.journal.editPlanBeforeHash) {
      await writeJsonAtomic(journalPath, {
        ...input.journal,
        status: "rolled_back",
        rolledBackBy: input.reviewer,
        rolledBackAt: input.reviewedAt,
      });
      return false;
    }
    if (currentContentHash !== input.journal.proposedEditPlanContentHash) {
      throw new Error("Pending recreation application cannot be rolled back because edit-plan.json is in an unknown state");
    }
    const projectionHash = sha256Canonical(referenceBindingProjection(editPlan, input.journal.mappings));
    if (
      editPlan.referenceRecreationApplication?.planContentHash !== input.plan.contentHash
      || editPlan.referenceRecreationApplication.referenceBindingsHash !== input.journal.referenceBindingsHash
      || projectionHash !== input.journal.referenceBindingsHash
    ) {
      throw new Error("Pending recreation application cannot be rolled back because its bindings differ from the journal");
    }
    const provisionalApplication: RecreationApplicationRecord = {
      contentHash: input.plan.contentHash,
      targetTranscriptHash: input.journal.targetTranscriptHash,
      cutPlanHash: input.journal.cutPlanHash,
      editPlanBeforeHash: input.journal.editPlanBeforeHash,
      editPlanAfterHash: currentFileHash,
      referenceBindingsHash: input.journal.referenceBindingsHash,
      mappings: input.journal.mappings,
      reviewer: input.journal.reviewer,
      appliedAt: input.journal.startedAt,
    };
    const provisionalPlan: RecreationPlanArtifact = {
      ...input.plan,
      status: "applied",
      applications: [
        ...input.plan.applications.filter((record) => record.contentHash !== input.plan.contentHash || Boolean(record.revokedAt)),
        provisionalApplication,
      ],
    };
    const bindingErrors = appliedRecreationBindingErrors(provisionalPlan, editPlan);
    if (bindingErrors.length > 0) {
      throw new Error(`Pending recreation application cannot be rolled back because its bindings are invalid: ${bindingErrors.join("; ")}`);
    }
    rollbackPlan = structuredClone(editPlan);
    removeRecreationBindings(rollbackPlan, input.plan.contentHash);
  } else if (input.journal.status === "rollback_pending") {
    const rollbackHash = input.journal.rollbackEditPlanContentHash;
    if (!rollbackHash) throw new Error("Rollback transaction lacks rollbackEditPlanContentHash");
    if (currentContentHash === rollbackHash) {
      await invalidateDownstreamRecreationEvidence({
        projectDir: input.projectDir,
        project: input.project,
        planContentHash: input.plan.contentHash,
        reviewer: input.reviewer,
        invalidatedAt: input.reviewedAt,
        reason: input.notes?.trim() || "仿拍方案撤回，依赖该方案的审片证据失效",
      });
      await writeJsonAtomic(journalPath, {
        ...input.journal,
        status: "rolled_back",
        rolledBackBy: input.reviewer,
        rolledBackAt: input.reviewedAt,
      });
      return true;
    }
    if (currentContentHash !== input.journal.proposedEditPlanContentHash) {
      throw new Error("Recreation rollback cannot resume because edit-plan.json is in an unknown state");
    }
    rollbackPlan = structuredClone(editPlan);
    removeRecreationBindings(rollbackPlan, input.plan.contentHash);
  } else {
    return false;
  }

  const rollbackReviewer = input.journal.status === "rollback_pending"
    ? text(input.journal.rollbackReviewer, "rollbackReviewer")
    : input.reviewer;
  const rollbackAuthority = input.journal.status === "rollback_pending"
    ? input.journal.rollbackAuthority
    : input.authority;
  if (rollbackAuthority !== "user" && rollbackAuthority !== "operator") {
    throw new Error("Recreation rollback journal has invalid rollbackAuthority");
  }
  const rollbackRequestedAt = input.journal.status === "rollback_pending"
    ? isoTimestamp(input.journal.rollbackRequestedAt, "rollbackRequestedAt")
    : input.reviewedAt;
  const rollbackNotes = input.journal.status === "rollback_pending"
    ? input.journal.rollbackNotes ?? null
    : input.notes?.trim() || null;
  rollbackPlan.referenceRecreationRevocation = {
    planContentHash: input.plan.contentHash,
    reviewer: rollbackReviewer,
    authority: rollbackAuthority,
    notes: rollbackNotes,
    revokedAt: rollbackRequestedAt,
  };

  await invalidateDownstreamRecreationEvidence({
    projectDir: input.projectDir,
    project: input.project,
    planContentHash: input.plan.contentHash,
    reviewer: input.reviewer,
    invalidatedAt: input.reviewedAt,
    reason: input.notes?.trim() || "仿拍方案撤回，依赖该方案的审片证据失效",
  });
  const rollbackContentHash = sha256Canonical(rollbackPlan);
  if (
    input.journal.status === "rollback_pending"
    && rollbackContentHash !== input.journal.rollbackEditPlanContentHash
  ) {
    throw new Error("Recreation rollback target no longer matches the journal");
  }
  await writeJsonAtomic(journalPath, {
    ...input.journal,
    status: "rollback_pending",
    rollbackEditPlanContentHash: rollbackContentHash,
    rollbackStartedAt: input.reviewedAt,
    rollbackReviewer,
    rollbackAuthority,
    rollbackNotes,
    rollbackRequestedAt,
  });
  await writeJsonAtomic(editPlanPath, rollbackPlan);
  await writeJsonAtomic(journalPath, {
    ...input.journal,
    status: "rolled_back",
    rollbackEditPlanContentHash: rollbackContentHash,
    rolledBackBy: input.reviewer,
    rolledBackAt: input.reviewedAt,
  });
  return true;
}

interface RecreationReviewInput {
  projectDir: string;
  decision: "approve" | "revise";
  reviewer: string;
  authority: "user" | "operator";
  notes?: string;
}

export async function reviewRecreation(input: RecreationReviewInput) {
  return withProjectStateLock(input.projectDir, "review-recreation", () => reviewRecreationLocked(input));
}

async function reviewRecreationLocked(input: RecreationReviewInput) {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  if (project.workflowStatus === "archived") throw new Error("review-recreation cannot change an archived project");
  const reviewer = text(input.reviewer, "reviewer");
  const plan = await verifyRecreationPlan(input.projectDir);
  if (input.decision === "revise") {
    const { assertNoActiveBrollExecutionClaims } = await import("./broll-handoff.js");
    await assertNoActiveBrollExecutionClaims(input.projectDir, "Recreation plan withdrawal");
  }
  if (input.decision === "approve" && input.authority !== "user") {
    throw new Error("Recreation approval is a user gate; operator review may only request revision");
  }
  const reviewedAt = new Date().toISOString();
  const applicationJournal = await readOptionalJson<RecreationApplicationJournal>(
    path.join(input.projectDir, "recreation-application.json"),
  );
  if (
    input.decision === "approve"
    && applicationJournal
    && new Set(["pending", "rollback_pending"]).has(applicationJournal.status)
  ) {
    throw new Error("Cannot approve a recreation plan while its application transaction is unresolved");
  }
  if (plan.status === "applied" && input.decision === "approve") {
    throw new Error("An applied recreation plan is already approved; create a revised plan instead of approving it again");
  }
  let pendingBindingsRemoved = false;
  if (
    input.decision === "revise"
    && applicationJournal
    && new Set(["pending", "rollback_pending"]).has(applicationJournal.status)
  ) {
    pendingBindingsRemoved = await rollbackPendingRecreationApplication({
      projectDir: input.projectDir,
      project,
      plan,
      journal: applicationJournal,
      reviewer,
      authority: input.authority,
      reviewedAt,
      notes: input.notes,
    });
  }
  if (
    input.decision === "revise"
    && applicationJournal?.status === "rolled_back"
    && plan.status === "applied"
  ) {
    if (applicationJournal.planContentHash !== plan.contentHash) {
      throw new Error("Cannot finish recreation revocation because the rolled-back journal belongs to another plan");
    }
    if (!applicationJournal.rollbackEditPlanContentHash) {
      throw new Error("Cannot finish recreation revocation because the rolled-back journal lacks its Edit Plan hash");
    }
    const editPlan = await readJson<EditPlanWithRecreation>(path.join(input.projectDir, "edit-plan.json"));
    if (sha256Canonical(editPlan) !== applicationJournal.rollbackEditPlanContentHash) {
      throw new Error("Cannot finish recreation revocation because the rolled-back Edit Plan drifted");
    }
    if (
      editPlan.referenceRecreationApplication?.planContentHash === plan.contentHash
      || editPlan.shots.some((shot) => shot.referenceRecreation?.planContentHash === plan.contentHash)
    ) {
      throw new Error("Cannot finish recreation revocation because the rolled-back Edit Plan still contains active bindings");
    }
    await invalidateDownstreamRecreationEvidence({
      projectDir: input.projectDir,
      project,
      planContentHash: plan.contentHash,
      reviewer,
      invalidatedAt: reviewedAt,
      reason: input.notes?.trim() || "仿拍方案撤回，依赖该方案的审片证据失效",
    });
    pendingBindingsRemoved = true;
  }
  if (
    input.decision === "revise"
    && applicationJournal?.status === "completed"
    && plan.status === "applied"
    && !pendingBindingsRemoved
  ) {
    const editPlanPath = path.join(input.projectDir, "edit-plan.json");
    const editPlan = await readJson<EditPlanWithRecreation>(editPlanPath);
    const hasActiveBindings = editPlan.referenceRecreationApplication?.planContentHash === plan.contentHash
      || editPlan.shots.some((shot) => shot.referenceRecreation?.planContentHash === plan.contentHash);
    if (!hasActiveBindings) {
      const revocation = editPlan.referenceRecreationRevocation;
      if (!revocation || revocation.planContentHash !== plan.contentHash) {
        throw new Error("Applied recreation lost its Edit Plan bindings without a recoverable revocation record");
      }
      const rollbackReviewer = text(revocation.reviewer, "referenceRecreationRevocation.reviewer");
      const rollbackAuthority = revocation.authority;
      if (rollbackAuthority !== "user" && rollbackAuthority !== "operator") {
        throw new Error("referenceRecreationRevocation.authority must be user or operator");
      }
      const rollbackRequestedAt = isoTimestamp(revocation.revokedAt, "referenceRecreationRevocation.revokedAt");
      const rollbackNotes = typeof revocation.notes === "string" ? revocation.notes : null;
      const rollbackEditPlanContentHash = sha256Canonical(editPlan);
      await invalidateDownstreamRecreationEvidence({
        projectDir: input.projectDir,
        project,
        planContentHash: plan.contentHash,
        reviewer: rollbackReviewer,
        invalidatedAt: rollbackRequestedAt,
        reason: rollbackNotes || "仿拍方案撤回，依赖该方案的审片证据失效",
      });
      await writeJsonAtomic(path.join(input.projectDir, "recreation-application.json"), {
        ...applicationJournal,
        status: "rolled_back",
        rollbackEditPlanContentHash,
        rollbackStartedAt: rollbackRequestedAt,
        rollbackReviewer,
        rollbackAuthority,
        rollbackNotes,
        rollbackRequestedAt,
        rolledBackBy: rollbackReviewer,
        rolledBackAt: rollbackRequestedAt,
      });
      pendingBindingsRemoved = true;
    }
  }
  if (plan.status === "applied" && input.decision === "revise" && !pendingBindingsRemoved) {
    if (!applicationJournal || applicationJournal.status !== "completed" || applicationJournal.planContentHash !== plan.contentHash) {
      throw new Error("Cannot revoke applied recreation without its completed application journal");
    }
    const editPlanPath = path.join(input.projectDir, "edit-plan.json");
    const journalPath = path.join(input.projectDir, "recreation-application.json");
    const editPlan = await readJson<EditPlanWithRecreation>(editPlanPath);
    const bindingErrors = appliedRecreationBindingErrors(plan, editPlan);
    if (bindingErrors.length > 0) {
      throw new Error(`Cannot revoke applied recreation because its bindings are invalid: ${bindingErrors.join("; ")}`);
    }
    await invalidateDownstreamRecreationEvidence({
      projectDir: input.projectDir,
      project,
      planContentHash: plan.contentHash,
      reviewer,
      invalidatedAt: reviewedAt,
      reason: input.notes?.trim() || "仿拍方案撤回，依赖该方案的审片证据失效",
    });
    removeRecreationBindings(editPlan, plan.contentHash);
    editPlan.referenceRecreationRevocation = {
      planContentHash: plan.contentHash,
      reviewer,
      authority: input.authority,
      notes: input.notes?.trim() || null,
      revokedAt: reviewedAt,
    };
    const rollbackEditPlanContentHash = sha256Canonical(editPlan);
    const rollbackNotes = input.notes?.trim() || null;
    await writeJsonAtomic(journalPath, {
      ...applicationJournal,
      status: "rollback_pending",
      rollbackEditPlanContentHash,
      rollbackStartedAt: reviewedAt,
      rollbackReviewer: reviewer,
      rollbackAuthority: input.authority,
      rollbackNotes,
      rollbackRequestedAt: reviewedAt,
    });
    await writeJsonAtomic(editPlanPath, editPlan);
    await writeJsonAtomic(journalPath, {
      ...applicationJournal,
      status: "rolled_back",
      rollbackEditPlanContentHash,
      rollbackStartedAt: reviewedAt,
      rollbackReviewer: reviewer,
      rollbackAuthority: input.authority,
      rollbackNotes,
      rollbackRequestedAt: reviewedAt,
      rolledBackBy: reviewer,
      rolledBackAt: reviewedAt,
    });
    pendingBindingsRemoved = true;
  }
  if (input.decision === "revise" && (plan.status === "applied" || pendingBindingsRemoved)) {
    for (const application of plan.applications) {
      if (application.contentHash === plan.contentHash && !application.revokedAt) {
        application.revokedAt = reviewedAt;
        application.revokedBy = reviewer;
      }
    }
  }
  if (input.decision === "revise") {
    // Keep the B-roll module out of this module's static dependency graph while
    // still revoking every paid-execution path before the plan becomes mutable.
    const { invalidateBrollHandoffsForPlanWithinProjectLock } = await import("./broll-handoff.js");
    await invalidateBrollHandoffsForPlanWithinProjectLock({
      projectDir: input.projectDir,
      planContentHash: plan.contentHash,
      invalidatedAt: reviewedAt,
    });
  }
  plan.reviews.push({
    decision: input.decision,
    reviewer,
    authority: input.authority,
    notes: input.notes?.trim() || null,
    contentHash: plan.contentHash,
    referenceAnalysisContentHash: plan.referenceAnalysisContentHash,
    reviewBoardSha256: await sha256File(path.join(input.projectDir, "recreation-board.md")),
    teleprompterSha256: await sha256File(path.join(input.projectDir, "teleprompter.txt")),
    reviewedAt,
  });
  plan.status = input.decision === "approve" ? "approved" : "needs_revision";
  plan.approvedContentHash = input.decision === "approve" ? plan.contentHash : null;
  await writeJsonAtomic(path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan), plan);
  return { status: plan.status, contentHash: plan.contentHash, reviewer, reviewedAt };
}

interface RecreationApplicationInput {
  recreationPlanContentHash: string;
  targetTranscriptHash: string;
  cutPlanHash: string;
  editPlanHash: string;
  reviewer: string;
  mappings: Array<{ recreationShotId: string; editShotId: string }>;
}

interface RecreationApplicationJournal {
  schemaVersion: typeof SCHEMA_VERSION;
  status: "pending" | "rollback_pending" | "completed" | "rolled_back";
  planContentHash: string;
  targetTranscriptHash: string;
  cutPlanHash: string;
  editPlanBeforeHash: string;
  proposedEditPlanContentHash: string;
  referenceBindingsHash: string;
  mappings: RecreationApplicationInput["mappings"];
  reviewer: string;
  startedAt: string;
  editPlanAfterHash?: string;
  completedAt?: string;
  rollbackEditPlanContentHash?: string;
  rollbackStartedAt?: string;
  rollbackReviewer?: string;
  rollbackAuthority?: "user" | "operator";
  rollbackNotes?: string | null;
  rollbackRequestedAt?: string;
  rolledBackBy?: string;
  rolledBackAt?: string;
}

export interface EditPlanWithRecreation {
  reviewStatus: string;
  cutPlanHash?: unknown;
  shots: Array<Record<string, unknown> & { id: string; referenceRecreation?: Record<string, unknown> }>;
  referenceRecreationApplication?: {
    planContentHash?: string;
    referenceAnalysisContentHash?: string;
    mappings?: RecreationApplicationInput["mappings"];
    referenceBindingsHash?: string;
    reviewer?: string;
    appliedAt?: string;
  };
  referenceRecreationRevocation?: Record<string, unknown>;
  [key: string]: unknown;
}

function buildReferenceRecreationBinding(
  plan: RecreationPlanArtifact,
  recreationShotId: string,
): Record<string, unknown> {
  const recreationShot = plan.shootingPlan.find((shot) => shot.id === recreationShotId);
  const blueprint = plan.editBlueprint.find((item) => item.shootingShotId === recreationShotId);
  if (!recreationShot || !blueprint) throw new Error(`Cannot build recreation binding for unknown shot: ${recreationShotId}`);
  return {
    planContentHash: plan.contentHash,
    recreationShotId,
    targetLineIds: recreationShot.lineIds,
    referenceShotIds: recreationShot.referenceShotIds,
    shooting: {
      scene: recreationShot.scene,
      framing: recreationShot.framing,
      composition: recreationShot.composition,
      cameraPosition: recreationShot.cameraPosition,
      cameraMovement: recreationShot.cameraMovement,
      subjectAction: recreationShot.subjectAction,
      performance: recreationShot.performance,
      props: recreationShot.props,
      lighting: recreationShot.lighting,
      audioCapture: recreationShot.audioCapture,
      continuity: recreationShot.continuity,
      alternatives: recreationShot.alternatives,
    },
    referenceMechanisms: blueprint.referenceMechanisms,
    cutStrategy: blueprint.cutStrategy,
    pacing: blueprint.pacing,
    brollSlots: blueprint.brollSlots,
    motionGraphics: blueprint.motionGraphics,
    sfx: blueprint.sfx,
    music: blueprint.music,
    transition: blueprint.transition,
    keyFrames: blueprint.keyFrames,
    acceptance: blueprint.acceptance,
  };
}

function referenceBindingProjection(
  editPlan: EditPlanWithRecreation,
  mappings: RecreationApplicationInput["mappings"],
): Array<{ editShotId: string; referenceRecreation: Record<string, unknown> | null }> {
  const shotById = new Map(editPlan.shots.map((shot) => [shot.id, shot]));
  return mappings
    .map((mapping) => ({
      editShotId: mapping.editShotId,
      referenceRecreation: shotById.get(mapping.editShotId)?.referenceRecreation ?? null,
    }))
    .sort((left, right) => left.editShotId.localeCompare(right.editShotId));
}

export function appliedRecreationBindingErrors(
  plan: RecreationPlanArtifact,
  editPlan: EditPlanWithRecreation,
): string[] {
  const errors: string[] = [];
  const topLevel = editPlan.referenceRecreationApplication;
  if (plan.status !== "applied") {
    if (topLevel?.planContentHash === plan.contentHash) errors.push("withdrawn recreation plan is still active in the Edit Plan");
    return errors;
  }
  const activeApplications = plan.applications.filter(
    (record) => record.contentHash === plan.contentHash && !record.revokedAt,
  );
  if (activeApplications.length !== 1) {
    return [`applied recreation plan must have exactly one active application record, got ${activeApplications.length}`];
  }
  const activeApplication = activeApplications[0];
  const mappings = activeApplication.mappings as RecreationApplicationInput["mappings"] | undefined;
  if (!Array.isArray(mappings) || !topLevel || topLevel.planContentHash !== plan.contentHash) {
    return ["applied recreation plan is not bound to the current Edit Plan"];
  }
  if (!sameApplicationMappings(mappings, topLevel.mappings ?? [])) errors.push("Edit Plan application mappings differ from the approved application record");
  const expectedShotIds = new Set(plan.shootingPlan.map((shot) => shot.id));
  const recreationShotIds = new Set(mappings.map((mapping) => mapping.recreationShotId));
  const editShotIds = new Set(mappings.map((mapping) => mapping.editShotId));
  if (
    mappings.length !== plan.shootingPlan.length
    || recreationShotIds.size !== mappings.length
    || editShotIds.size !== mappings.length
    || [...expectedShotIds].some((id) => !recreationShotIds.has(id))
  ) {
    errors.push("Edit Plan application mappings do not cover every recreation shot exactly once");
  }
  const shotById = new Map(editPlan.shots.map((shot) => [shot.id, shot]));
  for (const mapping of mappings) {
    const actual = shotById.get(mapping.editShotId)?.referenceRecreation;
    let expected: Record<string, unknown>;
    try {
      expected = buildReferenceRecreationBinding(plan, mapping.recreationShotId);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!actual || sha256Canonical(actual) !== sha256Canonical(expected)) {
      errors.push(`Edit Plan recreation binding drifted for shot ${mapping.editShotId}`);
    }
  }
  const mappedEditShotIds = new Set(mappings.map((mapping) => mapping.editShotId));
  for (const shot of editPlan.shots) {
    if (
      shot.referenceRecreation?.planContentHash === plan.contentHash
      && !mappedEditShotIds.has(shot.id)
    ) {
      errors.push(`Edit Plan contains an unmapped recreation binding for shot ${shot.id}`);
    }
  }
  const projectionHash = sha256Canonical(referenceBindingProjection(editPlan, mappings));
  if (topLevel.referenceBindingsHash !== projectionHash) errors.push("Edit Plan referenceBindingsHash is stale");
  if (activeApplication.referenceBindingsHash !== projectionHash) errors.push("application referenceBindingsHash is stale");
  return errors;
}

export async function appliedRecreationArtifactErrors(
  projectDir: string,
  plan: RecreationPlanArtifact,
  editPlan: EditPlanWithRecreation,
): Promise<string[]> {
  const errors = appliedRecreationBindingErrors(plan, editPlan);
  if (plan.status !== "applied") return errors;
  const activeApplications = plan.applications.filter(
    (record) => record.contentHash === plan.contentHash && !record.revokedAt,
  );
  if (activeApplications.length !== 1) return errors;

  const application = activeApplications[0];
  const transcriptPath = path.join(projectDir, "transcript.json");
  const cutPlanPath = path.join(projectDir, "cut-plan.json");
  try {
    const [actualTranscriptHash, actualCutPlanHash, transcript, cutPlan] = await Promise.all([
      sha256File(transcriptPath),
      sha256File(cutPlanPath),
      readJson<{ segments?: Array<{ id?: string; text?: string }> }>(transcriptPath),
      readJson<{
        transcriptHash?: string;
        operations?: Array<{
          id?: string;
          kind?: string;
          decision?: string;
          segmentId?: string;
          transcript?: string;
        }>;
      }>(cutPlanPath),
    ]);
    if (application.targetTranscriptHash !== actualTranscriptHash) {
      errors.push("active recreation application targetTranscriptHash is stale");
    }
    if (application.cutPlanHash !== actualCutPlanHash) {
      errors.push("active recreation application cutPlanHash is stale");
    }
    if (cutPlan.transcriptHash !== actualTranscriptHash) {
      errors.push("cut-plan.json does not bind the current transcript.json hash");
    }
    if (editPlan.cutPlanHash !== actualCutPlanHash) {
      errors.push("edit-plan.json does not bind the current cut-plan.json hash");
    }
    errors.push(...targetSpeechBindingErrors({
      plan,
      transcript,
      cutPlan,
      editPlan,
      mappings: application.mappings,
    }));
  } catch (error) {
    errors.push(`cannot revalidate applied recreation source contracts: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameApplicationMappings(
  left: RecreationApplicationInput["mappings"],
  right: RecreationApplicationInput["mappings"],
): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function targetSpeechBindingErrors(input: {
  plan: RecreationPlanArtifact;
  transcript: { segments?: Array<{ id?: string; text?: string }> };
  cutPlan: {
    operations?: Array<{
      id?: string;
      kind?: string;
      decision?: string;
      segmentId?: string;
      transcript?: string;
    }>;
  };
  editPlan: EditPlanWithRecreation;
  mappings: RecreationApplicationInput["mappings"];
}): string[] {
  const errors: string[] = [];
  const lineById = new Map(input.plan.targetVerbatimScript.map((line) => [line.id, line]));
  const recreationShotById = new Map(input.plan.shootingPlan.map((shot) => [shot.id, shot]));
  const editShotById = new Map(input.editPlan.shots.map((shot) => [shot.id, shot]));
  const cutOperationById = new Map((input.cutPlan.operations ?? []).map((operation) => [operation.id, operation]));
  const transcriptSegmentById = new Map((input.transcript.segments ?? []).map((segment) => [segment.id, segment]));
  for (const mapping of input.mappings) {
    const recreationShot = recreationShotById.get(mapping.recreationShotId);
    const editShot = editShotById.get(mapping.editShotId);
    if (!recreationShot || !editShot) continue;
    const targetText = recreationShot.lineIds.map((lineId) => lineById.get(lineId)?.text ?? "").join("");
    const voiceover = typeof editShot.voiceover === "string" ? editShot.voiceover : "";
    if (!voiceover || normalizeComparison(voiceover) !== normalizeComparison(targetText)) {
      errors.push(`Edit shot ${mapping.editShotId} voiceover does not match its approved target verbatim line(s)`);
    }
    const cutOperationId = typeof editShot.cutOperationId === "string" ? editShot.cutOperationId : "";
    const operation = cutOperationById.get(cutOperationId);
    if (!cutOperationId || !operation || operation.kind !== "speech" || operation.decision !== "keep") {
      errors.push(`Edit shot ${mapping.editShotId} is not bound to a kept speech Cut Plan operation`);
      continue;
    }
    const operationText = typeof operation.transcript === "string" ? operation.transcript : "";
    if (normalizeComparison(operationText) !== normalizeComparison(voiceover)) {
      errors.push(`Edit shot ${mapping.editShotId} voiceover differs from its Cut Plan operation`);
    }
    const segment = transcriptSegmentById.get(operation.segmentId);
    if (!segment || typeof segment.text !== "string") {
      errors.push(`Cut Plan operation ${cutOperationId} is not bound to a current Transcript segment`);
    } else if (normalizeComparison(segment.text) !== normalizeComparison(operationText)) {
      errors.push(`Cut Plan operation ${cutOperationId} text differs from its Transcript segment`);
    }
  }
  return errors;
}

interface ApplyRecreationInput {
  projectDir: string;
  inputPath: string;
}

export async function applyRecreation(input: ApplyRecreationInput) {
  return withProjectStateLock(input.projectDir, "apply-recreation", () => applyRecreationLocked(input));
}

async function applyRecreationLocked(input: ApplyRecreationInput) {
  const project = await readJson<VideoProject>(path.join(input.projectDir, "project.json"));
  if (project.workflowStatus !== "plan_ready") {
    throw new Error(`apply-recreation requires plan_ready, got ${project.workflowStatus}`);
  }
  const plan = await verifyRecreationPlan(input.projectDir);
  if (
    plan.approvedContentHash !== plan.contentHash
    || !hasCurrentRecreationUserApproval(plan)
  ) {
    throw new Error("apply-recreation requires a current user-approved recreation plan");
  }
  const application = await readJson<RecreationApplicationInput>(path.resolve(input.inputPath));
  if (application.recreationPlanContentHash !== plan.contentHash) {
    throw new Error("Recreation application is stale: content hash does not match the approved plan");
  }
  const reviewer = text(application.reviewer, "reviewer");
  for (const [field, value] of Object.entries({
    targetTranscriptHash: application.targetTranscriptHash,
    cutPlanHash: application.cutPlanHash,
    editPlanHash: application.editPlanHash,
  })) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Recreation application ${field} must be lowercase SHA-256`);
    }
  }
  if (!Array.isArray(application.mappings) || application.mappings.length !== plan.shootingPlan.length) {
    throw new Error("Recreation application must map every shooting shot exactly once");
  }
  const planShotById = new Map(plan.shootingPlan.map((shot) => [shot.id, shot]));
  const blueprintByShotId = new Map(plan.editBlueprint.map((blueprint) => [blueprint.shootingShotId, blueprint]));
  const seenPlanShots = new Set<string>();
  const seenEditShots = new Set<string>();
  const editPlanPath = path.join(input.projectDir, "edit-plan.json");
  const transcriptPath = path.join(input.projectDir, "transcript.json");
  const cutPlanPath = path.join(input.projectDir, "cut-plan.json");
  const journalPath = path.join(input.projectDir, "recreation-application.json");
  const actualTranscriptHash = await sha256File(transcriptPath);
  const actualCutPlanHash = await sha256File(cutPlanPath);
  const actualEditPlanHash = await sha256File(editPlanPath);
  if (application.targetTranscriptHash !== actualTranscriptHash) {
    throw new Error("Recreation application is stale: target transcript changed");
  }
  if (application.cutPlanHash !== actualCutPlanHash) {
    throw new Error("Recreation application is stale: cut plan changed");
  }
  const transcript = await readJson<{ segments?: Array<{ id?: string; text?: string }> }>(transcriptPath);
  const cutPlan = await readJson<{
    transcriptHash?: string;
    operations?: Array<{
      id?: string;
      kind?: string;
      decision?: string;
      segmentId?: string;
      transcript?: string;
    }>;
  }>(cutPlanPath);
  if (cutPlan.transcriptHash !== actualTranscriptHash) {
    throw new Error("apply-recreation requires cut-plan.json to bind the current transcript.json hash");
  }
  const editPlan = await readJson<EditPlanWithRecreation>(editPlanPath);
  if (editPlan.reviewStatus !== "ready") throw new Error(`apply-recreation requires a ready edit plan, got ${editPlan.reviewStatus}`);
  if (editPlan.cutPlanHash !== actualCutPlanHash) {
    throw new Error("apply-recreation requires edit-plan.json to bind the current cut-plan.json hash");
  }
  const editShotById = new Map(editPlan.shots.map((shot) => [shot.id, shot]));
  const normalizedMappings = application.mappings.map((mapping, index) => {
    assertRecord(mapping, `mappings[${index}]`);
    const recreationShotId = text(mapping.recreationShotId, `mappings[${index}].recreationShotId`);
    const editShotId = text(mapping.editShotId, `mappings[${index}].editShotId`);
    if (seenPlanShots.has(recreationShotId)) throw new Error(`Duplicate recreation shot mapping: ${recreationShotId}`);
    if (seenEditShots.has(editShotId)) throw new Error(`Duplicate edit shot mapping: ${editShotId}`);
    seenPlanShots.add(recreationShotId);
    seenEditShots.add(editShotId);
    if (!planShotById.has(recreationShotId)) throw new Error(`Unknown recreation shot: ${recreationShotId}`);
    if (!editShotById.has(editShotId)) throw new Error(`Unknown edit shot: ${editShotId}`);
    if (!blueprintByShotId.has(recreationShotId)) throw new Error(`Missing edit blueprint for recreation shot: ${recreationShotId}`);
    return { recreationShotId, editShotId };
  });
  application.mappings = normalizedMappings;
  const missingPlanShots = [...planShotById.keys()].filter((id) => !seenPlanShots.has(id));
  if (missingPlanShots.length > 0) throw new Error(`Missing recreation shot mappings: ${missingPlanShots.join(", ")}`);
  const speechBindingErrors = targetSpeechBindingErrors({ plan, transcript, cutPlan, editPlan, mappings: application.mappings });
  if (speechBindingErrors.length > 0) {
    throw new Error(`Recreation application does not bind the approved target script to the current recording: ${speechBindingErrors.join("; ")}`);
  }

  const existingJournal = await readOptionalJson<RecreationApplicationJournal>(journalPath);
  if (existingJournal?.status === "rollback_pending") {
    throw new Error("A recreation application rollback is pending; rerun review-recreation --decision revise to finish it");
  }
  if (existingJournal?.status === "pending") {
    const matchesPending = existingJournal.planContentHash === plan.contentHash
      && existingJournal.targetTranscriptHash === application.targetTranscriptHash
      && existingJournal.cutPlanHash === application.cutPlanHash
      && existingJournal.editPlanBeforeHash === application.editPlanHash
      && existingJournal.reviewer === reviewer
      && sameApplicationMappings(existingJournal.mappings, application.mappings);
    if (!matchesPending) {
      throw new Error("A different recreation application is pending; resolve it before applying another mapping");
    }
    if (actualEditPlanHash !== existingJournal.editPlanBeforeHash) {
      if (sha256Canonical(editPlan) !== existingJournal.proposedEditPlanContentHash) {
        throw new Error("Pending recreation application cannot be recovered because edit-plan.json is in an unknown state");
      }
      if (plan.status !== "approved" && plan.status !== "applied") {
        throw new Error("Pending recreation application cannot be recovered because the plan approval was withdrawn");
      }
      const editPlanAfterHash = actualEditPlanHash;
      const referenceBindingsHash = editPlan.referenceRecreationApplication?.referenceBindingsHash;
      if (!referenceBindingsHash) {
        throw new Error("Pending recreation application lacks referenceBindingsHash in edit-plan.json");
      }
      if (referenceBindingsHash !== existingJournal.referenceBindingsHash) {
        throw new Error("Pending recreation application referenceBindingsHash differs from its journal");
      }
      const appliedAt = existingJournal.startedAt;
      const provisionalApplication: RecreationApplicationRecord = {
        contentHash: plan.contentHash,
        targetTranscriptHash: actualTranscriptHash,
        cutPlanHash: actualCutPlanHash,
        editPlanBeforeHash: existingJournal.editPlanBeforeHash,
        editPlanAfterHash,
        referenceBindingsHash,
        mappings: application.mappings,
        reviewer,
        appliedAt,
      };
      const alreadyRecorded = plan.applications.some((record) =>
        record.contentHash === plan.contentHash
        && record.editPlanAfterHash === editPlanAfterHash
        && sameApplicationMappings(record.mappings, application.mappings),
      );
      const provisionalPlan: RecreationPlanArtifact = {
        ...plan,
        status: "applied",
        applications: alreadyRecorded ? plan.applications : [...plan.applications, provisionalApplication],
      };
      const recoveryErrors = appliedRecreationBindingErrors(provisionalPlan, editPlan);
      if (recoveryErrors.length > 0) {
        throw new Error(`Pending recreation application bindings are invalid: ${recoveryErrors.join("; ")}`);
      }
      if (!alreadyRecorded) {
        plan.applications.push(provisionalApplication);
      }
      plan.status = "applied";
      await writeJsonAtomic(path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan), plan);
      await writeJsonAtomic(journalPath, {
        ...existingJournal,
        status: "completed",
        editPlanAfterHash,
        completedAt: new Date().toISOString(),
      });
      return {
        appliedShots: application.mappings.length,
        planContentHash: plan.contentHash,
        editPlanAfterHash,
        reviewer,
        appliedAt,
        recovered: true,
      };
    }
  }
  if (plan.status !== "approved") {
    throw new Error("apply-recreation requires an approved plan unless it is recovering the same pending transaction");
  }
  if (application.editPlanHash !== actualEditPlanHash) {
    throw new Error("Recreation application is stale: edit plan changed");
  }

  for (const mapping of application.mappings) {
    const editShot = editShotById.get(mapping.editShotId)!;
    editShot.referenceRecreation = buildReferenceRecreationBinding(plan, mapping.recreationShotId);
  }
  const appliedAt = new Date().toISOString();
  const referenceBindingsHash = sha256Canonical(referenceBindingProjection(editPlan, application.mappings));
  editPlan.referenceRecreationApplication = {
    planContentHash: plan.contentHash,
    referenceAnalysisContentHash: plan.referenceAnalysisContentHash,
    mappings: application.mappings,
    referenceBindingsHash,
    reviewer,
    appliedAt,
  };
  delete editPlan.referenceRecreationRevocation;
  const journalBase = {
    schemaVersion: SCHEMA_VERSION,
    status: "pending",
    planContentHash: plan.contentHash,
    targetTranscriptHash: actualTranscriptHash,
    cutPlanHash: actualCutPlanHash,
    editPlanBeforeHash: actualEditPlanHash,
    proposedEditPlanContentHash: sha256Canonical(editPlan),
    referenceBindingsHash,
    mappings: application.mappings,
    reviewer,
    startedAt: appliedAt,
  };
  await writeJsonAtomic(journalPath, journalBase);
  await writeJsonAtomic(editPlanPath, editPlan);
  const editPlanAfterHash = await sha256File(editPlanPath);
  plan.status = "applied";
  plan.applications.push({
    contentHash: plan.contentHash,
    targetTranscriptHash: actualTranscriptHash,
    cutPlanHash: actualCutPlanHash,
    editPlanBeforeHash: actualEditPlanHash,
    editPlanAfterHash,
    referenceBindingsHash,
    mappings: application.mappings,
    reviewer,
    appliedAt,
  });
  await writeJsonAtomic(path.join(input.projectDir, REFERENCE_ARTIFACT_FILES.recreationPlan), plan);
  await writeJsonAtomic(journalPath, { ...journalBase, status: "completed", editPlanAfterHash, completedAt: new Date().toISOString() });
  return { appliedShots: application.mappings.length, planContentHash: plan.contentHash, editPlanAfterHash, reviewer, appliedAt };
}
