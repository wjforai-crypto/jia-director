import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("init creates the complete versioned project contract", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-init-"));
  const projectDir = path.join(tempRoot, "sample-project");
  const sourcePath = path.join(tempRoot, "source.mp4");

  try {
    const result = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "保险夫妻口播基准",
      "--lane",
      "speech",
      "--source",
      sourcePath,
    ]);

    assert.equal(result.status, 0, result.stderr);

    const expectedFiles = [
      "project.json",
      "assets.json",
      "transcript.json",
      "cut-plan.json",
      "edit-plan.json",
      "visual-routing.json",
      "kimi-visual-direction.json",
      "review.json",
      "archive-manifest.json",
    ];

    for (const fileName of expectedFiles) {
      const payload = JSON.parse(await readFile(path.join(projectDir, fileName), "utf8"));
      assert.equal(payload.schemaVersion, "1.0.0", `${fileName} is not versioned`);
    }

    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.title, "保险夫妻口播基准");
    assert.equal(project.lane, "speech");
    assert.equal(project.workflowStatus, "intake");
    assert.equal(project.priority, "standard");
    assert.equal(project.privacy.classification, "internal");
    assert.equal(project.privacy.externalProcessingAuthorization.status, "not_required");
    assert.equal(project.artifacts.transcript, "transcript.json");
    assert.match(project.projectId, /^vf_[a-f0-9]{16}$/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("init is deterministic for the same title, lane, and source", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-id-"));
  const sourcePath = path.join(tempRoot, "source.mp4");

  try {
    const ids: string[] = [];
    for (const name of ["one", "two"]) {
      const projectDir = path.join(tempRoot, name);
      const result = runCli([
        "init",
        "--project",
        projectDir,
        "--title",
        "同一个项目",
        "--lane",
        "speech",
        "--source",
        sourcePath,
      ]);
      assert.equal(result.status, 0, result.stderr);
      const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
      ids.push(project.projectId);
    }

    assert.equal(ids[0], ids[1]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("schema validation remains compatible with a 1.0 project created before authorization metadata", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-legacy-project-"));
  try {
    const projectDir = path.join(tempRoot, "legacy");
    const init = runCli([
      "init", "--project", projectDir, "--title", "Legacy 1.0", "--lane", "speech",
      "--source", path.join(tempRoot, "source.mp4"),
    ]);
    assert.equal(init.status, 0, init.stderr);
    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    delete project.privacy.externalProcessingAuthorization;
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const validated = runCli(["validate", "--project", projectDir]);
    assert.equal(validated.status, 0, validated.stderr);
    project.workflowStatus = "plan_ready";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const routed = runCli([
      "route-visual", "--project", projectDir,
      "--critical", "1", "--abstract", "1", "--information", "1", "--brand", "1", "--asset-gap", "1",
      "--selected-shots", "legacy-shot",
    ]);
    assert.equal(routed.status, 0, routed.stderr);
    const routing = JSON.parse(await readFile(path.join(projectDir, "visual-routing.json"), "utf8"));
    assert.equal(routing.decision, "codex");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
