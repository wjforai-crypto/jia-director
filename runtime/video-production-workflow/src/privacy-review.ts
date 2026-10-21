import path from "node:path";
import type { VideoProject } from "./contracts.js";
import { readJson, writeJson } from "./json-store.js";
import { sha256File } from "./media.js";
import { isSensitiveProject, privacyContractIssues } from "./privacy-policy.js";
import { withProjectStateLock } from "./project-state-lock.js";

interface PrivacyReviewInput {
  authorizationStatus: "authorized" | "denied";
  authorizedBy: string;
  scope: string[];
  verifiedBy: string;
  redaction?: {
    performedBy: string;
    reviewedBy: string;
    sourceAssetId: string;
    approvedOutputs: Array<{ kind: "frame" | "edit_plan" | "proxy"; path: string }>;
  };
}

interface AssetRecord {
  assetId: string;
  path: string;
  sha256: string;
  role?: string;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export async function recordPrivacyReview(input: { projectDir: string; inputPath: string }) {
  return withProjectStateLock(input.projectDir, "record-privacy-review", () => recordPrivacyReviewLocked(input));
}

async function recordPrivacyReviewLocked(input: { projectDir: string; inputPath: string }) {
  const projectPath = path.join(input.projectDir, "project.json");
  const project = await readJson<VideoProject>(projectPath);
  const contractIssues = privacyContractIssues(project);
  if (contractIssues.length > 0) {
    throw new Error(`Privacy contract is inconsistent: ${contractIssues.join(", ")}`);
  }
  const { assertNoActiveBrollExecutionClaims } = await import("./broll-handoff.js");
  await assertNoActiveBrollExecutionClaims(input.projectDir, "Privacy authorization mutation");
  const review = await readJson<PrivacyReviewInput>(path.resolve(input.inputPath));
  if (!new Set(["authorized", "denied"]).has(review.authorizationStatus)) {
    throw new Error("authorizationStatus must be authorized or denied");
  }
  if (
    review.authorizationStatus === "authorized" &&
    !new Set(["intake", "source_registered", "plan_ready"]).has(project.workflowStatus)
  ) {
    throw new Error(`authorization must be recorded before visual routing; got ${project.workflowStatus}`);
  }
  if (review.authorizationStatus === "denied" && project.workflowStatus === "archived") {
    throw new Error("archived privacy evidence is immutable");
  }
  const authorizedBy = nonEmpty(review.authorizedBy, "authorizedBy");
  const verifiedBy = nonEmpty(review.verifiedBy, "verifiedBy");
  if (!Array.isArray(review.scope) || review.scope.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("scope must be an array of non-empty strings");
  }

  let redactionEvidence = null;
  if (review.authorizationStatus === "authorized" && isSensitiveProject(project)) {
    if (project.workflowStatus !== "plan_ready") {
      throw new Error(`Authorized sensitive handoff evidence requires plan_ready, got ${project.workflowStatus}`);
    }
    if (!review.scope.includes("kimi_visual_direction")) {
      throw new Error("Sensitive Kimi authorization scope must include kimi_visual_direction");
    }
    if (!review.redaction) throw new Error("Authorized sensitive work requires redaction evidence");
    const performedBy = nonEmpty(review.redaction.performedBy, "redaction.performedBy");
    const reviewedBy = nonEmpty(review.redaction.reviewedBy, "redaction.reviewedBy");
    if (performedBy.toLowerCase() === reviewedBy.toLowerCase()) {
      throw new Error("Sensitive redaction requires an independent reviewer");
    }
    const sourceAssetId = nonEmpty(review.redaction.sourceAssetId, "redaction.sourceAssetId");
    const assets = await readJson<{ assets: AssetRecord[] }>(path.join(input.projectDir, "assets.json"));
    const sourceAsset = assets.assets.find((asset) => asset.assetId === sourceAssetId);
    if (!sourceAsset) throw new Error(`Unknown registered source asset: ${sourceAssetId}`);
    const sourcePath = path.resolve(sourceAsset.path);
    if (
      sourceAsset.role !== "a-roll" ||
      sourcePath.toLowerCase() !== path.resolve(project.source.path).toLowerCase()
    ) {
      throw new Error("Sensitive redaction source must be the registered project a-roll");
    }
    const sourceSha256 = await sha256File(sourcePath);
    if (sourceSha256 !== sourceAsset.sha256) {
      throw new Error("Registered sensitive source hash changed before redaction review");
    }
    if (!Array.isArray(review.redaction.approvedOutputs) || review.redaction.approvedOutputs.length === 0) {
      throw new Error("Sensitive redaction requires approved output files");
    }
    const seenPaths = new Set<string>();
    const approvedOutputs = [];
    for (const [index, output] of review.redaction.approvedOutputs.entries()) {
      if (!new Set(["frame", "edit_plan", "proxy"]).has(output.kind)) {
        throw new Error(`redaction.approvedOutputs[${index}].kind is invalid`);
      }
      const outputPath = path.resolve(nonEmpty(output.path, `redaction.approvedOutputs[${index}].path`));
      if (seenPaths.has(outputPath.toLowerCase())) throw new Error(`Duplicate approved output path: ${outputPath}`);
      seenPaths.add(outputPath.toLowerCase());
      const outputSha256 = await sha256File(outputPath);
      if (outputSha256 === sourceSha256 || outputPath.toLowerCase() === sourcePath.toLowerCase()) {
        throw new Error(`Approved redacted output is identical to the sensitive source: ${outputPath}`);
      }
      approvedOutputs.push({ kind: output.kind, path: outputPath, sha256: outputSha256 });
    }
    if (approvedOutputs.filter((output) => output.kind === "frame").length < 6) {
      throw new Error("Sensitive Kimi handoff requires at least 6 reviewed redacted frames");
    }
    if (approvedOutputs.filter((output) => output.kind === "edit_plan").length !== 1) {
      throw new Error("Sensitive Kimi handoff requires exactly one reviewed redacted edit plan");
    }
    redactionEvidence = {
      performedBy,
      reviewedBy,
      sourceAssetId,
      sourcePath,
      sourceSha256,
      approvedOutputs,
      reviewedAt: new Date().toISOString(),
    };
  }

  project.privacy.externalProcessingAuthorization = {
    status: review.authorizationStatus,
    authorizedBy,
    scope: review.scope.map((item) => item.trim()),
    verifiedBy,
    verifiedAt: new Date().toISOString(),
    redactionEvidence,
  };
  project.privacy.redacted = redactionEvidence !== null;
  project.privacy.cloudAllowed =
    !isSensitiveProject(project) ||
    (review.authorizationStatus === "authorized" && redactionEvidence !== null);
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath, project);
  return {
    authorizationStatus: review.authorizationStatus,
    redacted: project.privacy.redacted,
    cloudAllowed: project.privacy.cloudAllowed,
  };
}
