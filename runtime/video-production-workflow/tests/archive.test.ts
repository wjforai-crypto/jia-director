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
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], { cwd: repoRoot, encoding: "utf8" });
}

async function finalConfirmedProject(tempRoot: string) {
  const projectDir = path.join(tempRoot, "project");
  const init = runCli([
    "init", "--project", projectDir, "--title", "Archive test", "--lane", "product-demo", "--source", path.join(tempRoot, "source.mp4"),
  ]);
  assert.equal(init.status, 0, init.stderr);
  const projectPath = path.join(projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "final_confirmed";
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  return projectDir;
}

test("archive verifies every required group, hashes entries, and is the only path to archived", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-archive-"));
  try {
    const projectDir = await finalConfirmedProject(tempRoot);
    const groups = ["source", "editable_project", "preview", "review_evidence", "asset_manifest", "readme"];
    const entries = [];
    for (const group of groups) {
      const filePath = path.join(tempRoot, `${group}.txt`);
      await writeFile(filePath, group, "utf8");
      entries.push({ group, path: filePath });
    }
    const inputPath = path.join(tempRoot, "archive-input.json");
    await writeFile(inputPath, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
    const result = runCli(["archive", "--project", projectDir, "--input", inputPath]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(path.join(projectDir, "archive-manifest.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(manifest.status, "archived");
    assert.equal(manifest.entries.length, groups.length);
    assert.ok(manifest.entries.every((entry: { sha256: string }) => /^[a-f0-9]{64}$/.test(entry.sha256)));
    assert.equal(project.workflowStatus, "archived");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("archive fails when a required group is missing", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-archive-missing-"));
  try {
    const projectDir = await finalConfirmedProject(tempRoot);
    const filePath = path.join(tempRoot, "source.txt");
    await writeFile(filePath, "source", "utf8");
    const inputPath = path.join(tempRoot, "archive-input.json");
    await writeFile(inputPath, `${JSON.stringify({ entries: [{ group: "source", path: filePath }] }, null, 2)}\n`, "utf8");
    const result = runCli(["archive", "--project", projectDir, "--input", inputPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required archive groups/i);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "final_confirmed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
