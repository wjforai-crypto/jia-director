import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function createProject(tempRoot: string, privacy: "internal" | "sensitive" = "internal") {
  const projectDir = path.join(tempRoot, `project-${privacy}`);
  const init = runCli([
    "init",
    "--project",
    projectDir,
    "--title",
    "视觉路由测试",
    "--lane",
    "product-demo",
    "--source",
    path.join(tempRoot, "source.mp4"),
    "--privacy",
    privacy,
  ]);
  assert.equal(init.status, 0, init.stderr);
  const projectPath = path.join(projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "plan_ready";
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  return projectDir;
}

test("route-visual keeps low-complexity work with Codex and advances the gate", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-route-low-"));
  try {
    const projectDir = await createProject(tempRoot);
    const result = runCli([
      "route-visual",
      "--project",
      projectDir,
      "--critical",
      "1",
      "--abstract",
      "1",
      "--information",
      "1",
      "--brand",
      "1",
      "--asset-gap",
      "1",
      "--selected-shots",
      "shot-01",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(routing.score.total, 5);
    assert.equal(routing.decision, "codex");
    assert.deepEqual(routing.selectedShotIds, ["shot-01"]);
    assert.equal(project.workflowStatus, "visual_direction_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("route-visual requires Kimi advice at the six-point threshold", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-route-kimi-"));
  try {
    const projectDir = await createProject(tempRoot);
    const result = runCli([
      "route-visual",
      "--project",
      projectDir,
      "--critical",
      "2",
      "--abstract",
      "1",
      "--information",
      "1",
      "--brand",
      "1",
      "--asset-gap",
      "1",
      "--selected-shots",
      "hero,proof",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(routing.score.total, 6);
    assert.equal(routing.decision, "kimi_advice_required");
    assert.deepEqual(routing.selectedShotIds, ["hero", "proof"]);
    assert.equal(project.workflowStatus, "plan_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("route-visual blocks unredacted sensitive projects before Kimi", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-route-sensitive-"));
  try {
    const projectDir = await createProject(tempRoot, "sensitive");
    const result = runCli([
      "route-visual",
      "--project",
      projectDir,
      "--critical",
      "2",
      "--abstract",
      "2",
      "--information",
      "2",
      "--brand",
      "2",
      "--asset-gap",
      "2",
      "--selected-shots",
      "hero",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routing.score.total, 10);
    assert.equal(routing.decision, "blocked_sensitive");
    assert.equal(routing.privacyBlocked, true);
    assert.deepEqual(routing.privacyBlockReasons, [
      "unredacted_sensitive_data",
      "external_processing_not_authorized",
      "cloud_processing_not_allowed",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("authorized sensitive routing requires reviewed redaction evidence", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-route-sensitive-authorized-"));
  try {
    const projectDir = await createProject(tempRoot, "sensitive");
    const sourcePath = path.join(tempRoot, "source.mp4");
    await writeFile(sourcePath, "客户张三 保单 123", "utf8");
    const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    await writeFile(path.join(projectDir, "assets.json"), `${JSON.stringify({
      schemaVersion: "1.0.0",
      assets: [{ assetId: "asset_sensitive", path: sourcePath, sha256: sourceSha256, role: "a-roll" }],
    }, null, 2)}\n`, "utf8");
    const redactedPlanPath = path.join(tempRoot, "edit-plan.redacted.json");
    await writeFile(redactedPlanPath, `${JSON.stringify({ shots: [{ id: "hero", voiceover: "客户信息已脱敏" }] }, null, 2)}\n`, "utf8");
    const approvedOutputs: Array<{ kind: string; path: string }> = [{ kind: "edit_plan", path: redactedPlanPath }];
    for (let index = 1; index <= 6; index += 1) {
      const framePath = path.join(tempRoot, `redacted-${index}.png`);
      await writeFile(framePath, `redacted-frame-${index}`, "utf8");
      approvedOutputs.push({ kind: "frame", path: framePath });
    }
    const privacyInput = path.join(tempRoot, "privacy-review.json");
    await writeFile(privacyInput, `${JSON.stringify({
      authorizationStatus: "authorized",
      authorizedBy: "data-owner",
      scope: ["kimi_visual_direction"],
      verifiedBy: "Codex",
      redaction: {
        performedBy: "operator",
        reviewedBy: "Codex",
        sourceAssetId: "asset_sensitive",
        approvedOutputs,
      },
    }, null, 2)}\n`, "utf8");
    const privacy = runCli(["record-privacy-review", "--project", projectDir, "--input", privacyInput]);
    assert.equal(privacy.status, 0, privacy.stderr);

    const route = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "2", "--abstract", "2", "--information", "2", "--brand", "2", "--asset-gap", "2",
      "--selected-shots", "hero",
    ]);
    assert.equal(route.status, 0, route.stderr);
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(routing.decision, "kimi_advice_required");
    assert.equal(routing.privacyBlocked, false);
    assert.deepEqual(routing.privacyBlockReasons, []);
    assert.match(project.privacy.externalProcessingAuthorization.redactionEvidence.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(project.privacy.externalProcessingAuthorization.redactionEvidence.sourceAssetId, "asset_sensitive");
    assert.equal(project.privacy.externalProcessingAuthorization.redactionEvidence.approvedOutputs.length, 7);
    assert.ok(project.privacy.externalProcessingAuthorization.redactionEvidence.approvedOutputs.every(
      (output: { sha256: string }) => /^[a-f0-9]{64}$/.test(output.sha256),
    ));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("route-visual fails closed when sensitive privacy fields contradict each other", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-route-privacy-contradiction-"));
  try {
    const projectDir = await createProject(tempRoot, "sensitive");
    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.privacy.containsSensitiveData = false;
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const result = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "2", "--abstract", "2", "--information", "2", "--brand", "2", "--asset-gap", "2",
      "--selected-shots", "hero",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routing.decision, "blocked_sensitive");
    assert.equal(routing.privacyBlocked, true);
    assert.ok(routing.privacyBlockReasons.includes("privacy_contract_sensitive_classification_mismatch"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("route-visual preserves call usage and permits only an unused post-draft rescue", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-route-post-draft-"));
  try {
    const projectDir = await createProject(tempRoot);
    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "draft1_pending_user";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

    const first = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "2", "--abstract", "2", "--information", "1", "--brand", "1", "--asset-gap", "0",
      "--selected-shots", "hero",
    ]);
    assert.equal(first.status, 0, first.stderr);
    const routingPath = path.join(projectDir, "visual-routing.json");
    const routing = JSON.parse(await readFile(routingPath, "utf8"));
    assert.equal(routing.callsUsed, 0);
    routing.callsUsed = 1;
    await writeFile(routingPath, `${JSON.stringify(routing, null, 2)}\n`, "utf8");

    const blocked = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "2", "--abstract", "2", "--information", "1", "--brand", "1", "--asset-gap", "0",
      "--selected-shots", "hero",
    ]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /call remains unused/i);
    const preserved = JSON.parse(await readFile(routingPath, "utf8"));
    assert.equal(preserved.callsUsed, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("route-visual permits an unused rescue after a rejected draft2 enters revision", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-route-revision-rescue-"));
  try {
    const projectDir = await createProject(tempRoot);
    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "revision_in_progress";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

    const result = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "2", "--abstract", "1", "--information", "1", "--brand", "2", "--asset-gap", "0",
      "--selected-shots", "hero,turn,close",
      "--explicit", "true",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    const unchangedProject = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(routing.decision, "kimi_advice_required");
    assert.equal(routing.callsUsed, 0);
    assert.equal(unchangedProject.workflowStatus, "revision_in_progress");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
