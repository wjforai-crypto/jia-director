export const SCHEMA_VERSION = "1.0.0" as const;

export const ARTIFACT_FILES = {
  assets: "assets.json",
  transcript: "transcript.json",
  cutPlan: "cut-plan.json",
  editPlan: "edit-plan.json",
  visualRouting: "visual-routing.json",
  kimiVisualDirection: "kimi-visual-direction.json",
  review: "review.json",
  archiveManifest: "archive-manifest.json",
} as const;

export const REFERENCE_ARTIFACT_FILES = {
  referenceAnalysis: "reference-analysis.json",
  recreationPlan: "recreation-plan.json",
} as const;

export type ProjectArtifacts = {
  -readonly [Key in keyof typeof ARTIFACT_FILES]: (typeof ARTIFACT_FILES)[Key];
} & {
  -readonly [Key in keyof typeof REFERENCE_ARTIFACT_FILES]?: (typeof REFERENCE_ARTIFACT_FILES)[Key];
} & {
  brollHandoffs?: string[];
};

export const WORKFLOW_STATUSES = [
  "intake",
  "source_registered",
  "plan_ready",
  "visual_direction_ready",
  "draft1_pending_user",
  "draft1_approved",
  "revision_in_progress",
  "internal_review_passed",
  "draft2_pending_user",
  "final_confirmed",
  "archived",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type VideoLane = "speech" | "product-demo" | "hybrid";
export type ProjectPriority = "standard" | "flagship";
export type PrivacyClassification = "public" | "internal" | "sensitive";

export interface VideoProject {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  title: string;
  lane: VideoLane;
  priority: ProjectPriority;
  platform: string;
  aspectRatio: string;
  workflowStatus: WorkflowStatus;
  privacy: {
    classification: PrivacyClassification;
    containsSensitiveData: boolean;
    redacted: boolean;
    cloudAllowed: boolean;
    externalProcessingAuthorization?: {
      status: "not_required" | "pending" | "authorized" | "denied";
      authorizedBy: string | null;
      scope: string[];
      verifiedBy: string | null;
      verifiedAt: string | null;
      redactionEvidence: null | {
        performedBy: string;
        reviewedBy: string;
        sourceAssetId: string;
        sourcePath: string;
        sourceSha256: string;
        approvedOutputs: Array<{
          kind: "frame" | "edit_plan" | "proxy";
          path: string;
          sha256: string;
        }>;
        reviewedAt: string;
      };
    };
  };
  source: {
    path: string;
  };
  brief?: Record<string, unknown>;
  artifacts: ProjectArtifacts;
  createdAt: string;
  updatedAt: string;
}
