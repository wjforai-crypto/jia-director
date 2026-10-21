import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function createTestMp4(filePath: string): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "0.4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", filePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
}

async function createProjectAndInput(tempRoot: string) {
  const projectDir = path.join(tempRoot, "project");
  const videoPath = path.join(tempRoot, "draft1.mp4");
  createTestMp4(videoPath);
  const init = runCli([
    "init", "--project", projectDir, "--title", "Jianying test", "--lane", "speech", "--source", videoPath,
  ]);
  assert.equal(init.status, 0, init.stderr);
  const projectPath = path.join(projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "draft1_pending_user";
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  const srtPath = path.join(tempRoot, "draft1.srt");
  await writeFile(srtPath, "1\n00:00:00,000 --> 00:00:00,300\n测试\n", "utf8");
  const inputPath = path.join(tempRoot, "handoff-input.json");
  const config = {
    videoPath,
    subtitlePath: srtPath,
    assetPaths: [videoPath],
    decisionPaths: [path.join(projectDir, "cut-plan.json")],
    manifestPaths: [path.join(projectDir, "assets.json")],
    targetApplication: "剪映专业版 10.7.0.14095",
  };
  await writeFile(inputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { projectDir, projectPath, videoPath, srtPath, inputPath, config };
}

test("prepare-jianying atomically creates a hash-bound package without changing workflow state", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-jianying-"));
  try {
    const setup = await createProjectAndInput(tempRoot);
    const outputDir = path.join(tempRoot, "handoff");
    const result = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(result.status, 0, result.stderr);

    const manifestPath = path.join(outputDir, "jianying-handoff.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.status, "prepared_not_imported");
    assert.equal(manifest.desktopImportStatus, "not_tested");
    assert.equal(manifest.editableProjectConversionGuaranteed, false);
    assert.equal(manifest.project.workflowStatus, "draft1_pending_user");
    assert.equal(manifest.files.length, 5);
    assert.ok(manifest.files.every((entry: { sha256: string }) => /^[a-f0-9]{64}$/.test(entry.sha256)));
    assert.equal((await stat(path.join(outputDir, "video", "draft1.mp4"))).isFile(), true);
    assert.match(await readFile(path.join(outputDir, "README.md"), "utf8"), /不代表已完成剪映桌面导入/);

    manifest.desktopImportStatus = "passed";
    manifest.desktopImportEvidence = { reviewer: "Codex", note: "test sentinel" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const rerun = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(rerun.status, 0, rerun.stderr);
    const manifestAfterRerun = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifestAfterRerun.desktopImportStatus, "passed");
    assert.equal(manifestAfterRerun.desktopImportEvidence.note, "test sentinel");

    await writeFile(path.join(outputDir, "subtitles", "draft1.srt"), "tampered package copy", "utf8");
    const tampered = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /desktop smoke invalidated/i);
    const invalidated = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(invalidated.status, "invalidated");
    assert.equal(invalidated.desktopImportStatus, "invalidated");
    assert.equal(invalidated.invalidatedReason, "packaged_file_changed:subtitles/draft1.srt");

    const projectAfter = JSON.parse(await readFile(setup.projectPath, "utf8"));
    assert.equal(projectAfter.workflowStatus, "draft1_pending_user");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-jianying requires real MP4, UTF-8 SRT, assets, decisions, and assets manifest", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-jianying-invalid-"));
  try {
    const setup = await createProjectAndInput(tempRoot);
    const outputDir = path.join(tempRoot, "handoff");

    await writeFile(setup.inputPath, `${JSON.stringify({ ...setup.config, assetPaths: [] }, null, 2)}\n`, "utf8");
    const emptyAssets = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(emptyAssets.status, 1);
    assert.match(emptyAssets.stderr, /assetPaths must be a non-empty array/i);

    const fakeMp4 = path.join(tempRoot, "fake.mp4");
    await writeFile(fakeMp4, "not media", "utf8");
    await writeFile(setup.inputPath, `${JSON.stringify({ ...setup.config, videoPath: fakeMp4 }, null, 2)}\n`, "utf8");
    const fakeVideo = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(fakeVideo.status, 1);
    assert.match(fakeVideo.stderr, /not a readable MP4/i);

    const invalidSrt = path.join(tempRoot, "invalid.srt");
    await writeFile(invalidSrt, "字幕但没有时间码", "utf8");
    await writeFile(setup.inputPath, `${JSON.stringify({ ...setup.config, subtitlePath: invalidSrt }, null, 2)}\n`, "utf8");
    const badSubtitle = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(badSubtitle.status, 1);
    assert.match(badSubtitle.stderr, /valid SRT cue/i);

    await assert.rejects(stat(outputDir), /ENOENT/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-jianying invalidates desktop evidence when the safety README changes", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-jianying-readme-"));
  try {
    const setup = await createProjectAndInput(tempRoot);
    const outputDir = path.join(tempRoot, "handoff");
    const prepared = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const manifestPath = path.join(outputDir, "jianying-handoff.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.controlFiles[0].relativePath, "README.md");
    assert.match(manifest.controlFiles[0].sha256, /^[a-f0-9]{64}$/);
    await writeFile(path.join(outputDir, "README.md"), "已经完成剪映导入", "utf8");
    const rerun = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(rerun.status, 1);
    assert.match(rerun.stderr, /README changed; desktop smoke invalidated/i);
    const invalidated = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(invalidated.desktopImportStatus, "invalidated");
    assert.equal(invalidated.invalidatedReason, "control_file_changed:README.md");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare-jianying refuses a missing required subtitle before creating output", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-jianying-missing-"));
  try {
    const setup = await createProjectAndInput(tempRoot);
    await writeFile(setup.inputPath, `${JSON.stringify({
      ...setup.config,
      subtitlePath: path.join(tempRoot, "missing.srt"),
    }, null, 2)}\n`, "utf8");
    const outputDir = path.join(tempRoot, "handoff");
    const result = runCli(["prepare-jianying", "--project", setup.projectDir, "--input", setup.inputPath, "--output", outputDir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not exist/i);
    await assert.rejects(stat(outputDir), /ENOENT/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
