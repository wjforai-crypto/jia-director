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

test("validate checks every project artifact against the versioned JSON contract", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-validate-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const init = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "合同校验测试",
      "--lane",
      "speech",
      "--source",
      path.join(tempRoot, "source.mp4"),
    ]);
    assert.equal(init.status, 0, init.stderr);
    const result = runCli(["validate", "--project", projectDir]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.valid, true);
    assert.equal(output.filesChecked, 9);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validate rejects an invented completed state", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-invalid-state-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const init = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "错误状态测试",
      "--lane",
      "speech",
      "--source",
      path.join(tempRoot, "source.mp4"),
    ]);
    assert.equal(init.status, 0, init.stderr);
    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "completed";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const result = runCli(["validate", "--project", projectDir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /project\.json/);
    assert.match(result.stderr, /workflowStatus/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
