import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { watchWorkspace } from "../../.github/extensions/threadlight-lifecycle/lib/workspace-watcher.mjs";

const SCRATCH_ROOT = path.resolve(".test-workspaces");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createWatcherHarness(t) {
  const root = path.resolve("virtual-watcher-workspace");
  const available = new Set([root]);
  const resources = [];
  const scheduled = [];
  const timerWaiters = [];
  const harness = {
    root,
    available,
    resources,
    scheduled,
    async access(target) {
      if (!available.has(target)) {
        throw Object.assign(new Error("Missing fixture path"), { code: "ENOENT" });
      }
    },
    async lstat(target) {
      await harness.access(target);
      return { isSymbolicLink: () => false, isDirectory: () => true };
    },
    fire(resource = resources[0]) {
      const timer = deferred();
      timerWaiters.push(timer.resolve);
      resource.callback("rename", "router-bench-out");
      return timer.promise;
    },
  };
  t.mock.method(fsPromises, "access", (target) => harness.access(target));
  t.mock.method(fsPromises, "lstat", (target) => harness.lstat(target));
  t.mock.method(fsPromises, "readdir", async () => []);
  t.mock.method(fs, "watch", (target, options, callback) => {
    const resource = {
      target,
      callback,
      closeCount: 0,
      close() {
        this.closeCount += 1;
        if (this.closeError) throw this.closeError;
      },
    };
    resources.push(resource);
    return resource;
  });
  t.mock.method(globalThis, "setTimeout", (callback) => {
    const timer = { callback, cleared: false };
    scheduled.push(timer);
    timerWaiters.shift()?.(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (timer) timer.cleared = true;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return harness;
}

test("watcher initialization failure closes acquired watches and permits retry", async (t) => {
  const harness = createWatcherHarness(t);
  const error = Object.assign(new Error("Denied specs"), { code: "EACCES" });
  const access = harness.access;
  harness.access = async (target) => {
    if (target === path.join(harness.root, "specs")) throw error;
    return access(target);
  };

  await assert.rejects(watchWorkspace(harness.root, async () => {}), error);
  assert.equal(harness.resources.length, 1);
  assert.equal(harness.resources[0].closeCount, 1);

  harness.access = access;
  const watcher = await watchWorkspace(harness.root, async () => {});
  watcher.close();
  assert.deepEqual(harness.resources.map((resource) => resource.closeCount), [1, 1]);
});

test("watcher close is terminal while new-root access is pending", async (t) => {
  const harness = createWatcherHarness(t);
  let refreshes = 0;
  const watcher = await watchWorkspace(harness.root, async () => { refreshes += 1; });
  const target = path.join(harness.root, "router-bench-out");
  const entered = deferred();
  const release = deferred();
  const access = harness.access;
  harness.available.add(target);
  harness.access = async (candidate) => {
    if (candidate === target) {
      entered.resolve();
      await release.promise;
    }
    return access(candidate);
  };

  const timer = await harness.fire();
  const running = timer.callback();
  await entered.promise;
  watcher.close();
  release.resolve();
  await running;
  watcher.close();
  assert.equal(harness.resources.length, 1);
  assert.equal(harness.resources[0].closeCount, 1);
  assert.equal(refreshes, 0);
});

test("overlapping attachment passes acquire only one watch per root", async (t) => {
  const harness = createWatcherHarness(t);
  const watcher = await watchWorkspace(harness.root, async () => {});
  const target = path.join(harness.root, "router-bench-out");
  const entries = [deferred(), deferred()];
  const release = deferred();
  const access = harness.access;
  let arrivals = 0;
  harness.available.add(target);
  harness.access = async (candidate) => {
    if (candidate === target) {
      entries[arrivals++].resolve();
      await release.promise;
    }
    return access(candidate);
  };

  const first = (await harness.fire()).callback();
  await entries[0].promise;
  const second = (await harness.fire()).callback();
  await entries[1].promise;
  release.resolve();
  await Promise.all([first, second]);
  watcher.close();
  assert.equal(harness.resources.filter((resource) => resource.target === target).length, 1);
  assert.ok(harness.resources.every((resource) => resource.closeCount === 1));
});

test("close during asynchronous event filtering cannot schedule more work", async (t) => {
  const harness = createWatcherHarness(t);
  const watcher = await watchWorkspace(harness.root, async () => {});
  const entered = deferred();
  const release = deferred();
  harness.lstat = async () => {
    entered.resolve();
    await release.promise;
    return { isSymbolicLink: () => false, isDirectory: () => true };
  };
  harness.resources[0].callback("rename", "specs");
  await entered.promise;
  watcher.close();
  release.resolve();
  // Wait for the deferred lstat and its schedule continuation, not a wall clock.
  await release.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.scheduled.length, 0);
});

test("partial setup preserves the setup error and closes all watches despite cleanup errors", async (t) => {
  const harness = createWatcherHarness(t);
  harness.available.add(path.join(harness.root, "specs"));
  const setupError = new Error("Attachment failed");
  const cleanupError = new Error("Close failed");
  const access = harness.access;
  harness.access = async (target) => {
    if (target === path.join(harness.root, ".threadlight")) {
      harness.resources[0].closeError = cleanupError;
      throw setupError;
    }
    return access(target);
  };

  await assert.rejects(
    watchWorkspace(harness.root, async () => {}),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], setupError);
      assert.deepEqual(error.errors[1].errors, [cleanupError]);
      return true;
    },
  );
  assert.equal(harness.resources.length, 2);
  assert.ok(harness.resources.every((resource) => resource.closeCount === 1));
});

test("watcher close attempts every resource once even when one close fails", async (t) => {
  const harness = createWatcherHarness(t);
  harness.available.add(path.join(harness.root, "specs"));
  const watcher = await watchWorkspace(harness.root, async () => {});
  const error = new Error("Close failed");
  harness.resources[0].closeError = error;

  assert.throws(watcher.close, (failure) => {
    assert.deepEqual(failure.errors, [error]);
    return true;
  });
  watcher.close();
  assert.ok(harness.resources.every((resource) => resource.closeCount === 1));
});

test("event-filter errors are reported without scheduling or unhandled rejection", async (t) => {
  const harness = createWatcherHarness(t);
  const reported = deferred();
  const watcher = await watchWorkspace(harness.root, async () => {}, {
    onError: reported.resolve,
  });
  const error = new Error("Metadata failed");
  harness.lstat = async () => { throw error; };
  harness.resources[0].callback("rename", "specs");

  assert.equal(await reported.promise, error);
  assert.equal(harness.scheduled.length, 0);
  watcher.close();
});

test("events identifying a non-directory .azure root are ignored", async (t) => {
  const harness = createWatcherHarness(t);
  const watcher = await watchWorkspace(harness.root, async () => {
    assert.fail("An ignored event must not refresh the workspace");
  });
  const inspected = deferred();
  harness.lstat = async () => {
    inspected.resolve();
    return { isSymbolicLink: () => false, isDirectory: () => false };
  };
  harness.resources[0].callback("change", ".azure");
  await inspected.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.scheduled.length, 0);
  watcher.close();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRefreshCount(getCount, expected, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (getCount() < expected) {
    if (Date.now() - startedAt >= timeoutMs) {
      assert.fail(
        `Timed out waiting for ${expected} refresh(es); received ${getCount()}`,
      );
    }
    await delay(10);
  }
}

async function waitForRefreshAndSettle(getCount, expected, debounceMs = 40) {
  await waitForRefreshCount(getCount, expected);
  await delay(debounceMs * 2);
  assert.equal(getCount(), expected);
}

async function createScratchWorkspace(name) {
  const workspace = path.join(
    SCRATCH_ROOT,
    `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(workspace, { recursive: true });
  return workspace;
}

test("workspace watcher attaches newly created roots before publishing debounced refreshes", async () => {
  const root = await createScratchWorkspace("workspace-watcher");
  let watcher;
  let refreshes = 0;

  try {
    watcher = await watchWorkspace(
      root,
      async () => {
        refreshes += 1;
      },
      { debounceMs: 40 },
    );

    await mkdir(path.join(root, "specs"));
    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n");
    await writeFile(path.join(root, "specs", "manifest.json"), "{}\n");
    await waitForRefreshCount(() => refreshes, 1);
    // Any duplicate callback from this burst is due within one debounce window.
    await delay(80);

    assert.equal(refreshes, 1);

    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n\nUpdated\n");
    await waitForRefreshCount(() => refreshes, 2);

    assert.equal(refreshes, 2);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace watcher refreshes Improve and Handoff evidence", async () => {
  const root = await createScratchWorkspace("workspace-watcher-evidence");
  let watcher;
  let refreshes = 0;

  try {
    watcher = await watchWorkspace(
      root,
      async () => {
        refreshes += 1;
      },
      { debounceMs: 40 },
    );

    await mkdir(path.join(root, "tests"));
    await mkdir(path.join(root, "router-bench-out"));
    await waitForRefreshCount(() => refreshes, 1);
    await delay(80);

    await writeFile(
      path.join(root, "tests", "production-readiness-manifest.json"),
      "{}\n",
    );
    await waitForRefreshCount(() => refreshes, 2);

    await writeFile(
      path.join(root, "router-bench-out", "learnings-1.md"),
      "# Learnings\n",
    );
    await waitForRefreshCount(() => refreshes, 3);

    assert.equal(refreshes, 3);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace watcher refreshes when azd env evidence appears under .azure", async () => {
  const root = await createScratchWorkspace("workspace-watcher-azure-env");
  let watcher;
  let refreshes = 0;
  const debounceMs = 40;

  try {
    watcher = await watchWorkspace(
      root,
      async () => {
        refreshes += 1;
      },
      { debounceMs },
    );

    await mkdir(path.join(root, ".azure"));
    await waitForRefreshAndSettle(() => refreshes, 1, debounceMs);

    await mkdir(path.join(root, ".azure", "dev"));
    await waitForRefreshAndSettle(() => refreshes, 2, debounceMs);

    await writeFile(
      path.join(root, ".azure", "dev", ".env"),
      "AGENT_FQDN=threadlight-dev.example.com\n",
    );
    await waitForRefreshCount(() => refreshes, 3);

    await writeFile(
      path.join(root, ".azure", "dev", ".env"),
      "AGENT_FQDN=threadlight-prod.example.com\n",
    );
    await waitForRefreshCount(() => refreshes, 4);

    assert.equal(refreshes, 4);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace watcher ignores symlinked .azure roots", async () => {
  const root = await createScratchWorkspace("workspace-watcher-azure-symlink");
  const external = await createScratchWorkspace("workspace-watcher-azure-external");
  let watcher;
  let refreshes = 0;

  try {
    await mkdir(path.join(external, "dev"), { recursive: true });
    await symlink(external, path.join(root, ".azure"));

    watcher = await watchWorkspace(
      root,
      async () => {
        refreshes += 1;
      },
      { debounceMs: 40 },
    );

    await delay(120);
    const baseline = refreshes;

    await writeFile(
      path.join(external, "dev", ".env"),
      "AGENT_FQDN=threadlight-dev.example.com\n",
    );
    await delay(120);

    assert.equal(refreshes, baseline);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("workspace watcher handles .azure files and still refreshes other roots", async () => {
  const root = await createScratchWorkspace("workspace-watcher-azure-file");
  let watcher;
  let updatedSpecRefreshes = 0;
  const errors = [];
  const debounceMs = 40;

  try {
    await writeFile(path.join(root, ".azure"), "not a directory\n");
    await mkdir(path.join(root, "specs"));
    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n");

    watcher = await watchWorkspace(
      root,
      async () => {
        const spec = await fsPromises.readFile(path.join(root, "specs", "SPEC.md"), "utf8");
        if (spec.includes("Updated")) updatedSpecRefreshes += 1;
      },
      {
        debounceMs,
        onError: async (error) => {
          errors.push(error);
        },
      },
    );

    await writeFile(path.join(root, ".azure"), "still not a directory\n");
    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n\nUpdated\n");
    // OS watchers can coalesce or duplicate unrelated events; assert the
    // observed document state, not an exact operating-system event count.
    await waitForRefreshCount(() => updatedSpecRefreshes, 1);

    assert.deepEqual(errors, []);
    assert.ok(updatedSpecRefreshes >= 1);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace watcher ignores unreadable .azure roots and still watches other roots", async () => {
  const root = await createScratchWorkspace("workspace-watcher-azure-unreadable");
  let watcher;
  let refreshes = 0;
  const errors = [];
  const debounceMs = 40;

  try {
    await mkdir(path.join(root, ".azure"));
    await chmod(path.join(root, ".azure"), 0o000);
    await mkdir(path.join(root, "specs"));
    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n");

    watcher = await watchWorkspace(
      root,
      async () => {
        refreshes += 1;
      },
      {
        debounceMs,
        onError: async (error) => {
          errors.push(error);
        },
      },
    );

    await delay(120);
    const baseline = refreshes;
    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n\nUpdated\n");
    await waitForRefreshCount(() => refreshes, baseline + 1);
    await delay(debounceMs * 2);

    assert.deepEqual(errors, []);
    assert.ok(refreshes >= baseline + 1);
  } finally {
    await chmod(path.join(root, ".azure"), 0o755).catch(() => {});
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace watcher ignores unreadable azd env directories and still watches other roots", async () => {
  const root = await createScratchWorkspace("workspace-watcher-azure-env-unreadable");
  let watcher;
  let refreshes = 0;
  const errors = [];
  const debounceMs = 40;

  try {
    await mkdir(path.join(root, ".azure", "dev"), { recursive: true });
    await chmod(path.join(root, ".azure", "dev"), 0o000);
    await mkdir(path.join(root, "specs"));
    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n");

    watcher = await watchWorkspace(
      root,
      async () => {
        refreshes += 1;
      },
      {
        debounceMs,
        onError: async (error) => {
          errors.push(error);
        },
      },
    );

    await delay(120);
    const baseline = refreshes;
    await writeFile(path.join(root, "specs", "SPEC.md"), "# Pilot\n\nUpdated\n");
    await waitForRefreshCount(() => refreshes, baseline + 1);
    await delay(debounceMs * 2);

    assert.deepEqual(errors, []);
    assert.ok(refreshes >= baseline + 1);
  } finally {
    await chmod(path.join(root, ".azure", "dev"), 0o755).catch(() => {});
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});
