#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { initProject } from "./project.js";
import type { PrivacyClassification, ProjectPriority, VideoLane } from "./contracts.js";
import { routeVisual } from "./visual-routing.js";
import { acceptKimiScene, completeKimiFallback, decideKimiReview, importKimiReview, prepareKimi, recordKimiFailure } from "./kimi-handoff.js";
import { ingestAsset } from "./media.js";
import { confirmVersion, recordInternalReview, recordVersion } from "./review-gates.js";
import { validateProjectArtifacts } from "./validation.js";
import { transcribeProject } from "./transcription.js";
import { createCutPlan } from "./cut-plan.js";
import { reviewTranscript } from "./transcript-review.js";
import { reviewCutPlan } from "./cut-review.js";
import { createEditPlan } from "./edit-plan.js";
import { renderRough } from "./rough-render.js";
import { qaMedia } from "./media-qa.js";
import { createProductPlan } from "./product-plan.js";
import { archiveProject } from "./archive.js";
import { prepareJianyingHandoff } from "./jianying-handoff.js";
import { recordPrivacyReview } from "./privacy-review.js";
import { probeMechanicalCandidates } from "./mechanical-candidates.js";
import { analyzeReference, reviewReference } from "./reference-analysis.js";
import { applyRecreation, createRecreationPlan, reviewRecreation } from "./reference-recreation.js";
import { approveBrollHandoff, claimBrollExecution, importBrollResult, prepareBrollHandoff, reconcileBrollExecutionClaim, reviewBrollResult } from "./broll-handoff.js";
import { getPrimaryGeneration, preparePrimaryGeneration } from "./primary-generation.js";
import { downloadMinimaxPrimary, queryMinimaxPrimary, submitMinimaxPrimary } from "./minimax-primary-executor.js";

function parseArgs(args: string[]): { command: string; options: Map<string, string> } {
  const [command = "", ...rest] = args;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    options.set(key.slice(2), value);
  }
  return { command, options };
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function reviewAuthority(options: Map<string, string>): "user" | "operator" {
  const authority = required(options, "authority");
  if (authority !== "user" && authority !== "operator") {
    throw new Error(`Unsupported review authority: ${authority}`);
  }
  return authority;
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "prepare-primary-generation") {
    const result = await preparePrimaryGeneration({projectDir:required(options,"project"),inputPath:required(options,"input")});
    process.stdout.write(`${JSON.stringify({ok:true,contractHash:result.contractHash,budgetCapCny:result.budgetCapCny,quotedTotalCny:result.jobs.reduce((s,j)=>s+j.maxCostCents,0)/100,jobs:result.jobs.map(j=>({id:j.id,payloadHash:j.payloadHash,maxCostCny:j.maxCostCents/100}))})}\n`);
    return;
  }
  if (command === "primary-generation-status") {
    const {contract,ledger} = await getPrimaryGeneration({projectDir:required(options,"project")});
    process.stdout.write(`${JSON.stringify({ok:true,contractHash:contract.contractHash,budgetCapCny:contract.budgetCapCny,quotedTotalCny:contract.jobs.reduce((s,j)=>s+j.maxCostCents,0)/100,claims:ledger.claims})}\n`);
    return;
  }
  if (command === "submit-primary-generation") {
    const result = await submitMinimaxPrimary({projectDir:required(options,"project"),jobId:required(options,"job"),contractHash:required(options,"contract-hash")});
    process.stdout.write(`${JSON.stringify({ok:true,...result})}\n`);
    return;
  }
  if (command === "query-primary-generation") {
    const {jobId,taskId,status,claimHash} = await queryMinimaxPrimary({projectDir:required(options,"project"),jobId:required(options,"job")});
    process.stdout.write(`${JSON.stringify({ok:true,jobId,taskId,status,claimHash})}\n`);
    return;
  }
  if (command === "download-primary-generation") {
    const result = await downloadMinimaxPrimary({projectDir:required(options,"project"),jobId:required(options,"job"),outputPath:required(options,"output")});
    process.stdout.write(`${JSON.stringify({ok:true,...result})}\n`);
    return;
  }
  if (command === "init") {
    const lane = required(options, "lane") as VideoLane;
    if (!new Set(["speech", "product-demo", "hybrid"]).has(lane)) {
      throw new Error(`Unsupported lane: ${lane}`);
    }

    const project = await initProject({
      projectDir: required(options, "project"),
      title: required(options, "title"),
      lane,
      sourcePath: required(options, "source"),
      priority: options.get("priority") as ProjectPriority | undefined,
      privacy: options.get("privacy") as PrivacyClassification | undefined,
      platform: options.get("platform"),
      aspectRatio: options.get("aspect-ratio"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, projectId: project.projectId })}\n`);
    return;
  }

  if (command === "route-visual") {
    const routing = await routeVisual({
      projectDir: required(options, "project"),
      scores: {
        critical: Number(required(options, "critical")),
        abstract: Number(required(options, "abstract")),
        information: Number(required(options, "information")),
        brand: Number(required(options, "brand")),
        assetGap: Number(required(options, "asset-gap")),
      },
      selectedShotIds: (options.get("selected-shots") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      explicit: options.get("explicit") === "true",
    });
    process.stdout.write(`${JSON.stringify({ ok: true, decision: routing.decision, score: routing.score.total })}\n`);
    return;
  }

  if (command === "prepare-kimi") {
    const prepared = await prepareKimi({
      projectDir: required(options, "project"),
      outputPath: required(options, "output"),
      frames: (options.get("frames") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      resumeSessionId: options.get("session"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...prepared })}\n`);
    return;
  }

  if (command === "import-kimi-review") {
    const imported = await importKimiReview({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...imported })}\n`);
    return;
  }

  if (command === "record-kimi-failure") {
    const recorded = await recordKimiFailure({
      projectDir: required(options, "project"),
      attempt: required(options, "attempt") as "initial" | "retry",
      reason: required(options, "reason") as "timeout" | "rate_limited" | "invalid_output" | "unavailable",
      detail: required(options, "detail"),
      startedAt: required(options, "started-at"),
      endedAt: required(options, "ended-at"),
      launcherExitStatus: Number(required(options, "launcher-exit-status")),
      rawReportPath: required(options, "raw-report"),
      sessionId: options.get("session"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...recorded })}\n`);
    return;
  }

  if (command === "complete-kimi-fallback") {
    const completed = await completeKimiFallback({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...completed })}\n`);
    return;
  }

  if (command === "decide-kimi-review") {
    const decided = await decideKimiReview({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...decided })}\n`);
    return;
  }

  if (command === "accept-kimi-scene") {
    const accepted = await acceptKimiScene({
      projectDir: required(options, "project"),
      shotId: required(options, "shot-id"),
      implementationPath: required(options, "file"),
      beforeFramePath: required(options, "before-frame"),
      afterFramePath: required(options, "after-frame"),
      reviewer: required(options, "reviewer"),
      attribution: required(options, "attribution") as
        | "kimi_independently_completed"
        | "codex_repaired_after_kimi"
        | "codex_implemented_from_kimi_advice",
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...accepted })}\n`);
    return;
  }

  if (command === "ingest") {
    const ingested = await ingestAsset({
      projectDir: required(options, "project"),
      assetPath: required(options, "asset"),
      role: required(options, "role"),
      provenance: required(options, "provenance"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...ingested })}\n`);
    return;
  }

  if (command === "record-version") {
    const version = await recordVersion({
      projectDir: required(options, "project"),
      stage: required(options, "stage") as "draft1" | "draft2" | "final_candidate",
      filePath: required(options, "file"),
      label: required(options, "label"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, versionId: version.versionId, sha256: version.sha256 })}\n`);
    return;
  }

  if (command === "confirm") {
    const confirmation = await confirmVersion({
      projectDir: required(options, "project"),
      gate: required(options, "gate") as "initial" | "final",
      versionId: required(options, "version-id"),
      decision: required(options, "decision") as "approve" | "revise",
      reviewer: required(options, "reviewer"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, confirmation })}\n`);
    return;
  }

  if (command === "record-review") {
    const review = await recordInternalReview({
      projectDir: required(options, "project"),
      versionId: required(options, "version-id"),
      decision: required(options, "decision") as "pass" | "fail",
      reviewer: required(options, "reviewer"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, review })}\n`);
    return;
  }

  if (command === "validate") {
    const validation = await validateProjectArtifacts(required(options, "project"));
    process.stdout.write(`${JSON.stringify({ ok: true, ...validation })}\n`);
    return;
  }

  if (command === "transcribe") {
    const transcription = await transcribeProject({
      projectDir: required(options, "project"),
      engine: required(options, "engine") as "import" | "whisper",
      inputPath: options.get("input"),
      language: options.get("language"),
      whisperCli: options.get("whisper-cli"),
      model: options.get("model"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...transcription })}\n`);
    return;
  }

  if (command === "plan-cut") {
    const plan = await createCutPlan({
      projectDir: required(options, "project"),
      strategy: required(options, "strategy"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...plan })}\n`);
    return;
  }

  if (command === "review-transcript") {
    const review = await reviewTranscript({ projectDir: required(options, "project"), inputPath: required(options, "input") });
    process.stdout.write(`${JSON.stringify({ ok: true, ...review })}\n`);
    return;
  }

  if (command === "review-cut") {
    const review = await reviewCutPlan({ projectDir: required(options, "project"), inputPath: required(options, "input") });
    process.stdout.write(`${JSON.stringify({ ok: true, ...review })}\n`);
    return;
  }

  if (command === "plan-edit") {
    const plan = await createEditPlan(required(options, "project"));
    process.stdout.write(`${JSON.stringify({ ok: true, ...plan })}\n`);
    return;
  }

  if (command === "plan-product") {
    const plan = await createProductPlan({ projectDir: required(options, "project"), inputPath: required(options, "input") });
    process.stdout.write(`${JSON.stringify({ ok: true, ...plan })}\n`);
    return;
  }

  if (command === "render-rough") {
    const rendered = await renderRough({
      projectDir: required(options, "project"),
      outputPath: required(options, "output"),
      srtPath: required(options, "srt"),
      label: required(options, "label"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...rendered })}\n`);
    return;
  }

  if (command === "qa-media") {
    const report = await qaMedia({
      projectDir: required(options, "project"),
      versionId: required(options, "version-id"),
      reportPath: options.get("report") ?? required(options, "output"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, passed: report.passed, versionId: report.versionId })}\n`);
    return;
  }

  if (command === "archive") {
    const archived = await archiveProject({ projectDir: required(options, "project"), inputPath: required(options, "input") });
    process.stdout.write(`${JSON.stringify({ ok: true, ...archived })}\n`);
    return;
  }

  if (command === "prepare-jianying") {
    const prepared = await prepareJianyingHandoff({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
      outputDir: required(options, "output"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...prepared })}\n`);
    return;
  }

  if (command === "record-privacy-review") {
    const recorded = await recordPrivacyReview({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...recorded })}\n`);
    return;
  }

  if (command === "probe-mechanical") {
    const engine = required(options, "engine");
    if (engine !== "auto-editor") throw new Error(`Unsupported mechanical candidate engine: ${engine}`);
    const artifact = await probeMechanicalCandidates({
      projectDir: required(options, "project"),
      executablePath: required(options, "executable"),
      expectedExecutableSha256: required(options, "expected-sha256"),
      outputPath: required(options, "output"),
      edit: options.get("edit"),
      margin: options.get("margin"),
      smooth: options.get("smooth"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, authority: artifact.authority, candidates: artifact.candidates.length })}\n`);
    return;
  }

  if (command === "analyze-reference") {
    const analysis = await analyzeReference({
      projectDir: required(options, "project"),
      assetId: required(options, "asset-id"),
      inputPath: required(options, "input"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...analysis })}\n`);
    return;
  }

  if (command === "review-reference") {
    const decision = required(options, "decision");
    if (decision !== "approve" && decision !== "revise") throw new Error(`Unsupported reference review decision: ${decision}`);
    const review = await reviewReference({
      projectDir: required(options, "project"),
      decision,
      reviewer: required(options, "reviewer"),
      authority: reviewAuthority(options),
      notes: options.get("notes"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...review })}\n`);
    return;
  }

  if (command === "plan-recreation") {
    const plan = await createRecreationPlan({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...plan })}\n`);
    return;
  }

  if (command === "review-recreation") {
    const decision = required(options, "decision");
    if (decision !== "approve" && decision !== "revise") throw new Error(`Unsupported recreation review decision: ${decision}`);
    const review = await reviewRecreation({
      projectDir: required(options, "project"),
      decision,
      reviewer: required(options, "reviewer"),
      authority: reviewAuthority(options),
      notes: options.get("notes"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...review })}\n`);
    return;
  }

  if (command === "apply-recreation") {
    const applied = await applyRecreation({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...applied })}\n`);
    return;
  }

  if (command === "prepare-broll-handoff") {
    const prepared = await prepareBrollHandoff({
      projectDir: required(options, "project"),
      slotId: required(options, "slot-id"),
      outputPath: options.get("output"),
      revisionOf: options.get("revision-of"),
      revisionReason: options.get("revision-reason"),
      revisionPrompt: options.get("revision-prompt-file")
        ? await readFile(options.get("revision-prompt-file")!, "utf8")
        : undefined,
      supersedePendingRevision: options.get("supersede-pending-revision") === "true",
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...prepared })}\n`);
    return;
  }

  if (command === "approve-broll-handoff") {
    if (!options.get("handoff") && !options.get("handoff-id")) {
      throw new Error("approve-broll-handoff requires --handoff or --handoff-id");
    }
    const approved = await approveBrollHandoff({
      projectDir: required(options, "project"),
      handoffPath: options.get("handoff"),
      handoffId: options.get("handoff-id"),
      slotId: required(options, "slot-id"),
      reviewer: required(options, "reviewer"),
      authority: reviewAuthority(options),
      handoffContentHash: required(options, "content-hash"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...approved })}\n`);
    return;
  }

  if (command === "claim-broll-execution") {
    if (!options.get("handoff") && !options.get("handoff-id")) {
      throw new Error("claim-broll-execution requires --handoff or --handoff-id");
    }
    const ttlText = options.get("ttl-seconds");
    const claimed = await claimBrollExecution({
      projectDir: required(options, "project"),
      handoffPath: options.get("handoff"),
      handoffId: options.get("handoff-id"),
      executor: required(options, "executor"),
      claimedBy: required(options, "claimed-by"),
      ttlSeconds: ttlText === undefined ? undefined : Number(ttlText),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...claimed })}\n`);
    return;
  }

  if (command === "reconcile-broll-execution") {
    if (!options.get("handoff") && !options.get("handoff-id")) {
      throw new Error("reconcile-broll-execution requires --handoff or --handoff-id");
    }
    const outcome = required(options, "outcome");
    if (outcome !== "confirmed_not_submitted") {
      throw new Error(`Unsupported B-roll execution reconciliation outcome: ${outcome}`);
    }
    const reconciled = await reconcileBrollExecutionClaim({
      projectDir: required(options, "project"),
      handoffPath: options.get("handoff"),
      handoffId: options.get("handoff-id"),
      claimHash: required(options, "claim-hash"),
      outcome,
      reconciledBy: required(options, "reviewer"),
      authority: reviewAuthority(options),
      reason: required(options, "reason"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...reconciled })}\n`);
    return;
  }

  if (command === "import-broll-result") {
    const imported = await importBrollResult({
      projectDir: required(options, "project"),
      inputPath: required(options, "input"),
      handoffPath: options.get("handoff"),
      handoffId: options.get("handoff-id"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...imported })}\n`);
    return;
  }

  if (command === "review-broll-result") {
    if (!options.get("handoff") && !options.get("handoff-id")) {
      throw new Error("review-broll-result requires --handoff or --handoff-id");
    }
    const decision = required(options, "decision");
    if (decision !== "accept" && decision !== "revise") throw new Error(`Unsupported B-roll result decision: ${decision}`);
    const reviewed = await reviewBrollResult({
      projectDir: required(options, "project"),
      resultPath: options.get("result"),
      handoffPath: options.get("handoff"),
      handoffId: options.get("handoff-id"),
      decision,
      reviewer: required(options, "reviewer"),
      authority: reviewAuthority(options),
      resultContentHash: required(options, "result-hash"),
      notes: options.get("notes"),
      rightsConfirmed: options.get("rights-confirmed") === "true",
      rightsBasis: options.get("rights-basis"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...reviewed })}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command || "<none>"}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
