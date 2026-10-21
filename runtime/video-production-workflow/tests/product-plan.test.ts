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

async function initSourceRegisteredProject(tempRoot: string) {
  const projectDir = path.join(tempRoot, "project");
  const sourcePath = path.join(tempRoot, "workbench-reference.png");
  await writeFile(sourcePath, "reference", "utf8");
  const init = runCli([
    "init",
    "--project",
    projectDir,
    "--title",
    "Workbench product demo",
    "--lane",
    "product-demo",
    "--source",
    sourcePath,
    "--priority",
    "flagship",
  ]);
  assert.equal(init.status, 0, init.stderr);
  const projectPath = path.join(projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "source_registered";
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  return projectDir;
}

function validPlan() {
  return {
    brief: {
      audience: "Independent creators",
      objective: "Explain the Workbench control-plane role",
      brandRules: ["warm paper background", "forest green", "restrained orange accent"],
      lockedScript: ["The engine stays independent.", "The Workbench makes status visible."],
    },
    durationSeconds: 36,
    shots: [
      {
        slug: "hook",
        timelineIn: 0,
        timelineOut: 6,
        semanticIntent: "Separate the engine from the control plane",
        visualRole: "kinetic-type",
        onScreenText: ["Independent engine", "Visible control plane"],
        protectedRegions: ["title-safe"],
        acceptance: ["The distinction is readable within three seconds"],
      },
      {
        slug: "control-plane",
        timelineIn: 6,
        timelineOut: 36,
        semanticIntent: "Show the real linked project panel and review gates",
        visualRole: "product-ui",
        onScreenText: ["Artifacts", "Kimi routing", "User gates"],
        protectedRegions: ["product-ui", "bottom-captions"],
        acceptance: ["Real UI remains legible at 1920x1080"],
      },
    ],
  };
}

test("plan-product creates deterministic direct edit contracts without inventing a transcript", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-product-plan-"));
  try {
    const projectDir = await initSourceRegisteredProject(tempRoot);
    const planPath = path.join(tempRoot, "plan.json");
    await writeFile(planPath, `${JSON.stringify(validPlan(), null, 2)}\n`, "utf8");

    const first = runCli(["plan-product", "--project", projectDir, "--input", planPath]);
    assert.equal(first.status, 0, first.stderr);
    const editPlan1 = JSON.parse(await readFile(path.join(projectDir, "edit-plan.json"), "utf8"));
    const cutPlan1 = JSON.parse(await readFile(path.join(projectDir, "cut-plan.json"), "utf8"));
    const transcript = JSON.parse(await readFile(path.join(projectDir, "transcript.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));

    assert.equal(project.workflowStatus, "plan_ready");
    assert.deepEqual(project.brief, validPlan().brief);
    assert.equal(transcript.reviewStatus, "not_applicable");
    assert.equal(cutPlan1.strategy, "product-demo-direct");
    assert.equal(cutPlan1.reviewStatus, "not_applicable");
    assert.deepEqual(cutPlan1.operations, []);
    assert.equal(editPlan1.reviewStatus, "ready");
    assert.equal(editPlan1.durationSeconds, 36);
    assert.equal(editPlan1.shots.length, 2);
    assert.match(editPlan1.shots[0].id, /^shot_[a-f0-9]{16}$/);

    project.workflowStatus = "source_registered";
    await writeFile(path.join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const second = runCli(["plan-product", "--project", projectDir, "--input", planPath]);
    assert.equal(second.status, 0, second.stderr);
    const editPlan2 = JSON.parse(await readFile(path.join(projectDir, "edit-plan.json"), "utf8"));
    assert.deepEqual(
      editPlan2.shots.map((shot: { id: string }) => shot.id),
      editPlan1.shots.map((shot: { id: string }) => shot.id),
    );
    assert.equal(editPlan2.planInputHash, editPlan1.planInputHash);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plan-product rejects timeline gaps before changing project state", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-product-gap-"));
  try {
    const projectDir = await initSourceRegisteredProject(tempRoot);
    const broken = validPlan();
    broken.shots[1].timelineIn = 7;
    const planPath = path.join(tempRoot, "broken.json");
    await writeFile(planPath, `${JSON.stringify(broken, null, 2)}\n`, "utf8");
    const result = runCli(["plan-product", "--project", projectDir, "--input", planPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gap or overlap/i);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "source_registered");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
