import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function requireUnreadableDirectory(t, directory) {
  try {
    await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
  t.skip(`chmod(000) did not deny directory access on ${process.platform} for the current user`);
  return false;
}

export function denyDirectoryAccess(
  t,
  directory,
  code,
  methods = ["lstat", "realpath", "stat", "readdir", "readFile"],
) {
  const deniedRoot = path.resolve(directory);
  const deniedCalls = [];
  for (const method of methods) {
    const original = fs[method];
    t.mock.method(fs, method, async (file, ...args) => {
      const candidate = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
      if (candidate === deniedRoot || candidate.startsWith(`${deniedRoot}${path.sep}`)) {
        deniedCalls.push({ method, path: candidate });
        throw Object.assign(new Error("Access denied by filesystem fixture"), { code });
      }
      return original(file, ...args);
    });
  }
  // The reader imports named built-in exports; keep them in sync with the mock.
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return deniedCalls;
}
