import path from "node:path";
import type { VideoProject } from "./contracts.js";
import { readJson } from "./json-store.js";
import { sha256File } from "./media.js";

export type RedactionOutput = {
  kind: "frame" | "edit_plan" | "proxy";
  path: string;
  sha256: string;
};

export type RedactionEvidence = {
  performedBy: string;
  reviewedBy: string;
  sourceAssetId: string;
  sourcePath: string;
  sourceSha256: string;
  approvedOutputs: RedactionOutput[];
};

interface AssetRecord {
  assetId: string;
  path: string;
  sha256: string;
  role?: string;
}

export function isSensitiveProject(project: VideoProject): boolean {
  return project.privacy.classification === "sensitive" || project.privacy.containsSensitiveData;
}

export function privacyContractIssues(project: VideoProject): string[] {
  const issues: string[] = [];
  const authorization = project.privacy.externalProcessingAuthorization;
  if (project.privacy.classification === "sensitive" && !project.privacy.containsSensitiveData) {
    issues.push("sensitive_classification_mismatch");
  }
  if (authorization?.status === "authorized") {
    if (!authorization.authorizedBy?.trim()) issues.push("authorized_by_missing");
    if (!authorization.verifiedBy?.trim()) issues.push("authorization_verifier_missing");
    if (!authorization.verifiedAt?.trim()) issues.push("authorization_timestamp_missing");
    if (authorization.scope.length === 0) issues.push("authorization_scope_missing");
  }
  return issues;
}

export async function assertCurrentSensitiveEvidence(
  projectDir: string,
  project: VideoProject,
): Promise<RedactionEvidence | null> {
  const contractIssues = privacyContractIssues(project);
  if (contractIssues.length > 0) {
    throw new Error(`Privacy contract is inconsistent: ${contractIssues.join(", ")}`);
  }
  if (!isSensitiveProject(project)) return null;
  const authorization = project.privacy.externalProcessingAuthorization;
  const evidence = authorization?.redactionEvidence;
  if (
    !project.privacy.redacted ||
    !project.privacy.cloudAllowed ||
    authorization?.status !== "authorized" ||
    !authorization.scope.includes("kimi_visual_direction") ||
    !evidence
  ) {
    throw new Error("Sensitive Kimi handoff is not currently authorized with reviewed redaction evidence");
  }
  if (
    !evidence.performedBy.trim() ||
    !evidence.reviewedBy.trim() ||
    evidence.performedBy.trim().toLowerCase() === evidence.reviewedBy.trim().toLowerCase()
  ) {
    throw new Error("Sensitive redaction evidence requires different performer and reviewer");
  }
  const approvedFrames = evidence.approvedOutputs.filter((output) => output.kind === "frame");
  if (approvedFrames.length < 6) {
    throw new Error("Sensitive redaction evidence requires at least 6 approved frames");
  }
  if (new Set(approvedFrames.map((output) => output.sha256)).size !== approvedFrames.length) {
    throw new Error("Sensitive redaction evidence requires unique approved frame content");
  }
  if (evidence.approvedOutputs.filter((output) => output.kind === "edit_plan").length !== 1) {
    throw new Error("Sensitive redaction evidence requires exactly one approved edit plan");
  }

  const assets = await readJson<{ assets: AssetRecord[] }>(path.join(projectDir, "assets.json"));
  const sourceAsset = assets.assets.find((asset) => asset.assetId === evidence.sourceAssetId);
  if (!sourceAsset) throw new Error(`Sensitive source asset is no longer registered: ${evidence.sourceAssetId}`);
  const registeredPath = path.resolve(sourceAsset.path);
  const projectSourcePath = path.resolve(project.source.path);
  const evidenceSourcePath = path.resolve(evidence.sourcePath);
  if (
    sourceAsset.role !== "a-roll" ||
    registeredPath.toLowerCase() !== projectSourcePath.toLowerCase() ||
    evidenceSourcePath.toLowerCase() !== projectSourcePath.toLowerCase()
  ) {
    throw new Error("Sensitive source evidence is not bound to the registered project a-roll");
  }
  const currentSourceHash = await sha256File(projectSourcePath);
  if (currentSourceHash !== sourceAsset.sha256 || currentSourceHash !== evidence.sourceSha256) {
    throw new Error("Sensitive source changed after privacy review");
  }
  const seenOutputPaths = new Set<string>();
  for (const output of evidence.approvedOutputs) {
    const outputPath = path.resolve(output.path);
    const outputKey = outputPath.toLowerCase();
    if (seenOutputPaths.has(outputKey)) throw new Error(`Duplicate approved redacted output: ${outputPath}`);
    seenOutputPaths.add(outputKey);
    const outputHash = await sha256File(outputPath);
    if (outputHash !== output.sha256) {
      throw new Error(`Approved redacted output changed after privacy review: ${output.path}`);
    }
    if (outputKey === projectSourcePath.toLowerCase() || outputHash === currentSourceHash) {
      throw new Error(`Approved redacted output is identical to the sensitive source: ${output.path}`);
    }
  }
  return evidence;
}
