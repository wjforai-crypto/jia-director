import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";

interface ProjectStateLockOwner {
  token: string;
  pid: number;
  createdAt: string;
  operation: string;
}

interface ProjectStateLockContextEntry {
  token: string;
  operation: string;
  active: boolean;
}

const PROJECT_STATE_LOCK_FILE = ".video-flow-project-state.lock";
const projectLockContext = new AsyncLocalStorage<Map<string, ProjectStateLockContextEntry>>();

export function projectStateLockPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), PROJECT_STATE_LOCK_FILE);
}

export function assertProjectStateLockHeld(projectDir: string, operation: string): void {
  const lockPath = projectStateLockPath(projectDir);
  const entry = projectLockContext.getStore()?.get(lockPath);
  if (!entry?.active) {
    throw new Error(`${operation} requires the current project-state lock`);
  }
}

async function readProjectLockOwner(lockPath: string): Promise<Partial<ProjectStateLockOwner> | null> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as Partial<ProjectStateLockOwner>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {};
  }
}

async function removeOwnedProjectLock(lockPath: string, token: string): Promise<void> {
  const current = await readProjectLockOwner(lockPath);
  if (current === null) return;
  if (current.token !== token) {
    throw new Error(`Project state lock ownership changed unexpectedly; refusing to remove ${lockPath}`);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(lockPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if ((code === "EPERM" || code === "EBUSY") && attempt < 4) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Serialize project mutations that can change paid-execution preconditions,
 * artifact bindings, workflow state, or shared registries. The lock is
 * deliberately fail-closed. A crash may leave the owner file behind; later
 * callers stop for operator reconciliation instead of guessing whether an
 * external request or cross-file commit already happened.
 *
 * Nested calls in the same awaited transaction are re-entrant. The shared
 * context entry is marked inactive before the filesystem lease is released,
 * so timers or promises that outlive their parent cannot reuse stale authority.
 */
export async function withProjectStateLock<T>(
  projectDir: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = projectStateLockPath(projectDir);
  const inherited = projectLockContext.getStore();
  const inheritedEntry = inherited?.get(lockPath);
  if (inheritedEntry?.active) {
    throw new Error(
      `Nested project-state transition ${operation} is not allowed while ${inheritedEntry.operation} holds the lock; `
      + "call a lock-asserting internal helper from the existing transaction instead",
    );
  }

  const owner: ProjectStateLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    operation,
  };
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(lockPath, "wx");
      created = true;
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      acquired = true;
      break;
    } catch (error) {
      if (created) {
        await handle?.close().catch(() => undefined);
        handle = undefined;
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } finally {
      await handle?.close();
    }
  }
  if (!acquired) {
    const current = await readProjectLockOwner(lockPath);
    const ownerDescription = current
      ? `pid=${String(current.pid ?? "unknown")}, operation=${String(current.operation ?? "unknown")}, createdAt=${String(current.createdAt ?? "unknown")}`
      : "owner evidence unavailable";
    throw new Error(
      `Project state is busy or requires operator reconciliation (${ownerDescription}); `
      + `the lock remains fail-closed at ${lockPath}`,
    );
  }

  const context = new Map(inherited ?? []);
  const contextEntry: ProjectStateLockContextEntry = { token: owner.token, operation, active: true };
  context.set(lockPath, contextEntry);
  let actionError: unknown;
  try {
    const value = await projectLockContext.run(context, action);
    contextEntry.active = false;
    try {
      await removeOwnedProjectLock(lockPath, owner.token);
    } catch (cleanupError) {
      throw new Error(
        `Project state transition may have completed, but its lock could not be released: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    return value;
  } catch (error) {
    actionError = error;
    contextEntry.active = false;
    try {
      await removeOwnedProjectLock(lockPath, owner.token);
    } catch (cleanupError) {
      if (actionError instanceof Error && actionError.cause === undefined) actionError.cause = cleanupError;
    }
    throw actionError;
  }
}
