import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertProjectStateLockHeld,
  projectStateLockPath,
  withProjectStateLock,
} from "../src/project-state-lock.js";

test("nested project-state transactions are rejected before child work can outlive the owner", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "video-flow-project-lock-nested-"));
  try {
    let childEntered = false;
    await withProjectStateLock(projectDir, "outer-transaction", async () => {
      assertProjectStateLockHeld(projectDir, "test internal mutation");
      await assert.rejects(
        () => withProjectStateLock(projectDir, "unawaited-child", async () => {
          childEntered = true;
        }),
        /Nested project-state transition unawaited-child is not allowed/i,
      );
      assert.equal(childEntered, false);
    });
    assert.throws(
      () => assertProjectStateLockHeld(projectDir, "test internal mutation"),
      /requires the current project-state lock/i,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("the neutral project-state lock does not grant stale authority to detached async work", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "video-flow-project-lock-context-"));
  const lockPath = projectStateLockPath(projectDir);
  try {
    assert.equal(path.basename(lockPath), ".video-flow-project-state.lock");
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
    let detachedEntered = false;
    let detachedWork!: Promise<void>;

    await withProjectStateLock(projectDir, "parent-transaction", async () => {
      const owner = JSON.parse(await readFile(lockPath, "utf8"));
      assert.equal(owner.operation, "parent-transaction");
      detachedWork = (async () => {
        await detachedGate;
        await withProjectStateLock(projectDir, "detached-work", async () => {
          detachedEntered = true;
        });
      })();
    });

    await withProjectStateLock(projectDir, "next-transaction", async () => {
      const owner = JSON.parse(await readFile(lockPath, "utf8"));
      assert.equal(owner.operation, "next-transaction");
      releaseDetached();
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      assert.equal(detachedEntered, false, "detached work must wait for the new filesystem lock owner");
    });

    await detachedWork;
    assert.equal(detachedEntered, true);
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/i);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
