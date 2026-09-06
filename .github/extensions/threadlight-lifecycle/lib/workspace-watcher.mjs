import { watch } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const WATCH_ROOTS = [
  ".",
  "specs",
  "specs/sample-data",
  ".threadlight",
  ".azure",
  "docs",
  "docs/threadlight-customize",
  "infra",
  "src",
  "src/agent",
  "src/bot",
  "src/triggers",
  "src/workspace",
  ".github",
  ".github/workflows",
  "tests",
  "router-bench-out",
];

export async function watchWorkspace(
  workspace,
  onChange,
  {
    debounceMs = 150,
    onError = (error) =>
      queueMicrotask(() => {
        throw error;
      }),
  } = {},
) {
  const watchers = new Map();
  let timer = null;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    timer = null;
    const acquired = [...watchers.values()];
    watchers.clear();
    const errors = [];
    for (const watcher of acquired) {
      try {
        watcher.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Workspace watcher cleanup failed");
    }
  }

  function isIgnorableAzureError(error) {
    return (
      error?.code === "ENOENT" ||
      error?.code === "ENOTDIR" ||
      error?.code === "EACCES" ||
      error?.code === "EPERM"
    );
  }

  async function attachRoots() {
    for (const root of WATCH_ROOTS) {
      if (closed) return;
      const target = path.join(workspace, root);
      let attached;
      try {
        attached = await attachTarget(target, {
          rejectSymlinks: root === ".azure",
          requireDirectory: root === ".azure",
        });
      } catch (error) {
        if (root === ".azure" && isIgnorableAzureError(error)) {
          continue;
        }
        throw error;
      }
      if (!closed && root === ".azure") {
        if (!attached) {
          continue;
        }
        await attachAzureEnvDirs(target);
      }
    }
  }

  async function attachTarget(target, { rejectSymlinks = false, requireDirectory = false } = {}) {
    if (closed) return false;
    if (watchers.has(target)) {
      return true;
    }

    try {
      await access(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }

    if (rejectSymlinks || requireDirectory) {
      const details = await lstat(target);
      if (details.isSymbolicLink()) {
        return false;
      }
      if (requireDirectory && !details.isDirectory()) {
        return false;
      }
    }

    // Other attachment passes or close() may have completed during the awaits.
    if (closed) return false;
    if (watchers.has(target)) return true;
    const watcher = watch(target, { persistent: false }, (eventType, filename) => {
      void schedule(target, filename);
    });
    watchers.set(target, watcher);
    return true;
  }

  async function attachAzureEnvDirs(azureRoot) {
    if (closed) return;
    let entries;
    try {
      entries = await readdir(azureRoot, { withFileTypes: true });
    } catch (error) {
      if (isIgnorableAzureError(error)) {
        return;
      }
      throw error;
    }

    if (closed) return;
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            await attachTarget(path.join(azureRoot, entry.name), { rejectSymlinks: true });
          } catch (error) {
            if (isIgnorableAzureError(error)) {
              return;
            }
            throw error;
          }
        }),
    );
  }

  async function shouldIgnoreEvent(target, filename) {
    const workspaceTarget = path.resolve(workspace);
    if (path.resolve(target) !== workspaceTarget) {
      return false;
    }
    try {
      const azdRootDetails = await lstat(path.join(workspace, ".azure"));
      const unusableAzdRoot =
        azdRootDetails.isSymbolicLink() || !azdRootDetails.isDirectory();
      if (!unusableAzdRoot) {
        return false;
      }
      if (filename == null) {
        return azdRootDetails.isSymbolicLink();
      }
      const relative = filename.toString().split(path.sep).join("/");
      return relative === ".azure" || relative.startsWith(".azure/");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async function schedule(target, filename) {
    if (closed) return;
    try {
      if (await shouldIgnoreEvent(target, filename)) return;
    } catch (error) {
      if (!closed) await onError(error);
      return;
    }
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (closed) return;
      try {
        await attachRoots();
        if (!closed) await onChange();
      } catch (error) {
        if (!closed) await onError(error);
      }
    }, debounceMs);
  }

  try {
    await attachRoots();
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Workspace watcher initialization and cleanup failed",
      );
    }
    throw error;
  }

  return { close };
}
