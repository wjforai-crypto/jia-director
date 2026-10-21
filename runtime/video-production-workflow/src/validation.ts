import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import contractBundle from "../schemas/contracts.schema.json" with { type: "json" };
import { ARTIFACT_FILES, REFERENCE_ARTIFACT_FILES, type VideoProject } from "./contracts.js";
import { readJson } from "./json-store.js";
import {
  referenceAnalysisSemanticErrors,
  verifyReferenceAnalysis,
  type ReferenceAnalysisArtifact,
} from "./reference-analysis.js";
import {
  appliedRecreationArtifactErrors,
  recreationPlanSemanticErrors,
  verifyRecreationPlan,
  type RecreationPlanArtifact,
} from "./reference-recreation.js";
import { discoverBrollHandoffPaths, validateBrollHandoffs } from "./broll-handoff.js";

const definitions = contractBundle.$defs;
const schemaByFile = {
  "project.json": definitions.project,
  [ARTIFACT_FILES.assets]: definitions.assets,
  [ARTIFACT_FILES.transcript]: definitions.transcript,
  [ARTIFACT_FILES.cutPlan]: definitions.cutPlan,
  [ARTIFACT_FILES.editPlan]: definitions.editPlan,
  [ARTIFACT_FILES.visualRouting]: definitions.visualRouting,
  [ARTIFACT_FILES.kimiVisualDirection]: definitions.kimiVisualDirection,
  [ARTIFACT_FILES.review]: definitions.review,
  [ARTIFACT_FILES.archiveManifest]: definitions.archiveManifest,
} as const;

const optionalSchemaByArtifact = {
  referenceAnalysis: {
    expectedFile: REFERENCE_ARTIFACT_FILES.referenceAnalysis,
    schema: definitions.referenceAnalysis,
  },
  recreationPlan: {
    expectedFile: REFERENCE_ARTIFACT_FILES.recreationPlan,
    schema: definitions.recreationPlan,
  },
} as const;

function describeErrors(fileName: string, errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${fileName}: ${location} ${error.message ?? "is invalid"}`;
  });
}

export async function validateProjectArtifacts(projectDir: string) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && Number.isFinite(Date.parse(value)),
  });
  const errors: string[] = [];
  let filesChecked = 0;
  let referenceAnalysis: ReferenceAnalysisArtifact | undefined;
  let recreationPlan: RecreationPlanArtifact | undefined;
  for (const [fileName, schema] of Object.entries(schemaByFile)) {
    const payload = await readJson<unknown>(path.join(projectDir, fileName));
    const validate = ajv.compile(schema);
    if (!validate(payload)) errors.push(...describeErrors(fileName, validate.errors));
    filesChecked += 1;
  }
  const project = await readJson<VideoProject>(path.join(projectDir, "project.json"));
  for (const [artifactKey, definition] of Object.entries(optionalSchemaByArtifact)) {
    const declaredFile = project.artifacts[artifactKey as keyof typeof optionalSchemaByArtifact];
    if (!declaredFile) continue;
    if (declaredFile !== definition.expectedFile) {
      errors.push(`project.json: /artifacts/${artifactKey} must be ${definition.expectedFile}`);
      continue;
    }
    const payload = await readJson<unknown>(path.join(projectDir, declaredFile));
    const validate = ajv.compile(definition.schema);
    if (!validate(payload)) {
      errors.push(...describeErrors(declaredFile, validate.errors));
    } else if (artifactKey === "referenceAnalysis") {
      referenceAnalysis = payload as unknown as ReferenceAnalysisArtifact;
    } else if (artifactKey === "recreationPlan") {
      recreationPlan = payload as unknown as RecreationPlanArtifact;
    }
    filesChecked += 1;
  }
  if (referenceAnalysis) {
    try {
      errors.push(...referenceAnalysisSemanticErrors(referenceAnalysis).map((error) => `${REFERENCE_ARTIFACT_FILES.referenceAnalysis}: ${error}`));
      await verifyReferenceAnalysis(projectDir);
    } catch (error) {
      errors.push(`${REFERENCE_ARTIFACT_FILES.referenceAnalysis}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (recreationPlan) {
    try {
      errors.push(...recreationPlanSemanticErrors(
        recreationPlan,
        referenceAnalysis,
        project.aspectRatio,
        project.platform,
      ).map((error) => `${REFERENCE_ARTIFACT_FILES.recreationPlan}: ${error}`));
      await verifyRecreationPlan(projectDir);
    } catch (error) {
      errors.push(`${REFERENCE_ARTIFACT_FILES.recreationPlan}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const journal = await readJson<{ status?: string } & Record<string, unknown>>(
      path.join(projectDir, "recreation-application.json"),
    );
    const validateJournal = ajv.compile(definitions.recreationApplication);
    if (!validateJournal(journal)) {
      errors.push(...describeErrors("recreation-application.json", validateJournal.errors));
    }
    filesChecked += 1;
    if (journal.status === "pending") {
      errors.push("recreation-application.json: pending transaction must be recovered by rerunning the same apply-recreation input or rolled back by requesting recreation revision");
    }
    if (journal.status === "rollback_pending") {
      errors.push("recreation-application.json: rollback_pending transaction must be completed by rerunning review-recreation --decision revise");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`recreation-application.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (recreationPlan) {
    try {
      const editPlan = await readJson<Parameters<typeof appliedRecreationArtifactErrors>[2]>(
        path.join(projectDir, ARTIFACT_FILES.editPlan),
      );
      errors.push(...(await appliedRecreationArtifactErrors(projectDir, recreationPlan, editPlan))
        .map((error) => `edit-plan.json: ${error}`));
    } catch (error) {
      errors.push(`edit-plan.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const handoffPaths = await discoverBrollHandoffPaths(projectDir);
    const validateHandoff = ajv.compile(definitions.brollHandoff);
    const validateResult = ajv.compile(definitions.brollResult);
    for (const handoffPath of handoffPaths) {
      const label = path.relative(projectDir, handoffPath).replaceAll("\\", "/") || path.basename(handoffPath);
      try {
        const handoff = await readJson<{ resultPath?: string }>(handoffPath);
        if (!validateHandoff(handoff)) errors.push(...describeErrors(label, validateHandoff.errors));
        filesChecked += 1;
        if (handoff.resultPath) {
          const resultPath = path.isAbsolute(handoff.resultPath)
            ? handoff.resultPath
            : path.resolve(path.dirname(handoffPath), handoff.resultPath);
          const resultLabel = path.relative(projectDir, resultPath).replaceAll("\\", "/") || path.basename(resultPath);
          const result = await readJson<unknown>(resultPath);
          if (!validateResult(result)) errors.push(...describeErrors(resultLabel, validateResult.errors));
          filesChecked += 1;
        }
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const semantic = await validateBrollHandoffs(projectDir);
    errors.push(...semantic.errors.map((error) => `B-roll handoff: ${error}`));
  } catch (error) {
    errors.push(`B-roll handoff validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (errors.length > 0) {
    throw new Error(`Contract validation failed:\n${errors.join("\n")}`);
  }
  return { valid: true, filesChecked };
}
