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

function createFixture(filePath: string, color = "blue", frequency = 440) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x240:r=30:d=1`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=48000:duration=1`,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

test("ingest registers a real media asset with hash and ffprobe evidence", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-ingest-"));
  try {
    const sourcePath = path.join(tempRoot, "source.mp4");
    const projectDir = path.join(tempRoot, "project");
    createFixture(sourcePath);
    const init = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "媒体登记测试",
      "--lane",
      "speech",
      "--source",
      sourcePath,
    ]);
    assert.equal(init.status, 0, init.stderr);

    const result = runCli([
      "ingest",
      "--project",
      projectDir,
      "--asset",
      sourcePath,
      "--role",
      "a-roll",
      "--provenance",
      "user-owned",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const assets = JSON.parse(await readFile(path.join(projectDir, "assets.json"), "utf8"));
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(assets.assets.length, 1);
    assert.match(assets.assets[0].assetId, /^asset_[a-f0-9]{16}$/);
    assert.match(assets.assets[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(assets.assets[0].role, "a-roll");
    assert.equal(assets.assets[0].provenance, "user-owned");
    assert.equal(assets.assets[0].media.video.width, 320);
    assert.equal(assets.assets[0].media.video.height, 240);
    assert.equal(assets.assets[0].media.video.fps, 30);
    assert.equal(assets.assets[0].media.audio.sampleRate, 48000);
    assert.ok(assets.assets[0].media.durationSeconds >= 0.9);
    assert.equal(project.workflowStatus, "source_registered");

    const duplicate = runCli([
      "ingest",
      "--project",
      projectDir,
      "--asset",
      sourcePath,
      "--role",
      "a-roll",
      "--provenance",
      "user-owned",
    ]);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    const afterDuplicate = JSON.parse(await readFile(path.join(projectDir, "assets.json"), "utf8"));
    assert.equal(afterDuplicate.assets.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("ingest of a supplemental asset does not regress an advanced workflow state", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-ingest-state-"));
  try {
    const sourcePath = path.join(tempRoot, "source.mp4");
    const referencePath = path.join(tempRoot, "reference.mp4");
    const projectDir = path.join(tempRoot, "project");
    createFixture(sourcePath);
    createFixture(referencePath, "red", 660);

    const init = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "补充素材状态测试",
      "--lane",
      "product-demo",
      "--source",
      sourcePath,
    ]);
    assert.equal(init.status, 0, init.stderr);

    const source = runCli([
      "ingest",
      "--project",
      projectDir,
      "--asset",
      sourcePath,
      "--role",
      "a-roll",
      "--provenance",
      "user-owned",
    ]);
    assert.equal(source.status, 0, source.stderr);

    const projectPath = path.join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "visual_direction_ready";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

    const supplemental = runCli([
      "ingest",
      "--project",
      projectDir,
      "--asset",
      referencePath,
      "--role",
      "reference",
      "--provenance",
      "user-owned",
    ]);
    assert.equal(supplemental.status, 0, supplemental.stderr);

    const after = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(after.workflowStatus, "visual_direction_ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("ingest of a reference video does not pretend the target a-roll is registered", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-state-"));
  try {
    const targetPath = path.join(tempRoot, "target-not-recorded-yet.mp4");
    const referencePath = path.join(tempRoot, "reference.mp4");
    const projectDir = path.join(tempRoot, "project");
    createFixture(referencePath, "purple", 520);

    const init = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "参考片先行项目",
      "--lane",
      "speech",
      "--source",
      targetPath,
    ]);
    assert.equal(init.status, 0, init.stderr);

    const reference = runCli([
      "ingest",
      "--project",
      projectDir,
      "--asset",
      referencePath,
      "--role",
      "reference",
      "--provenance",
      "public-reference",
    ]);
    assert.equal(reference.status, 0, reference.stderr);

    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "intake");
    assert.equal(project.source.path, path.resolve(targetPath));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("ingest rejects a missing asset without advancing the project", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-ingest-missing-"));
  try {
    const projectDir = path.join(tempRoot, "project");
    const sourcePath = path.join(tempRoot, "missing.mp4");
    const init = runCli([
      "init",
      "--project",
      projectDir,
      "--title",
      "缺失素材测试",
      "--lane",
      "speech",
      "--source",
      sourcePath,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const result = runCli([
      "ingest",
      "--project",
      projectDir,
      "--asset",
      sourcePath,
      "--role",
      "a-roll",
      "--provenance",
      "user-owned",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not exist/i);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.workflowStatus, "intake");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("the same bytes can be promoted from reference evidence to target a-roll without losing the reference role", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-ingest-multi-role-"));
  try {
    const sharedPath = path.join(tempRoot, "shared.mp4");
    const projectDir = path.join(tempRoot, "project");
    createFixture(sharedPath, "yellow", 720);
    const init = runCli([
      "init", "--project", projectDir, "--title", "同文件多角色", "--lane", "speech", "--source", sharedPath,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const reference = runCli([
      "ingest", "--project", projectDir, "--asset", sharedPath, "--role", "reference", "--provenance", "user-owned",
    ]);
    assert.equal(reference.status, 0, reference.stderr);
    const target = runCli([
      "ingest", "--project", projectDir, "--asset", sharedPath, "--role", "a-roll", "--provenance", "user-owned",
    ]);
    assert.equal(target.status, 0, target.stderr);
    assert.equal(JSON.parse(target.stdout).duplicate, true);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    const assets = JSON.parse(await readFile(path.join(projectDir, "assets.json"), "utf8"));
    assert.equal(project.workflowStatus, "source_registered");
    assert.equal(assets.assets.length, 1);
    assert.equal(assets.assets[0].role, "a-roll");
    assert.deepEqual(assets.assets[0].roles.sort(), ["a-roll", "reference"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
