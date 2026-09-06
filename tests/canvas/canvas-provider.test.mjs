import assert from "node:assert/strict";
import test from "node:test";

import { createLifecycleCanvas } from "../../.github/extensions/threadlight-lifecycle/lib/canvas-provider.mjs";

function createHarness({ projectWorkspace, watchWorkspace, createServer, log } = {}) {
  const sent = [];
  const logs = [];
  const projected = [];
  const servers = [];
  const watchers = [];
  const closeEvents = [];
  const canvas = createLifecycleCanvas({
    createCanvas: (options) => options,
    webRoot: new URL("../../.github/extensions/threadlight-lifecycle/web/", import.meta.url),
    getSession: () => ({
      send: async (payload) => {
        sent.push(payload);
      },
      log: async (message, options) => {
        logs.push({ message, options });
        await log?.(message, options);
      },
    }),
    projectWorkspace: async (workspace) => {
      projected.push(workspace);
      if (projectWorkspace) {
        return projectWorkspace(workspace);
      }
      return { summary: `Projected ${workspace}`, phases: [], errors: [] };
    },
    watchWorkspace: async (workspace, callback, options) => {
      const watcher = {
        workspace,
        callback,
        options,
        closed: false,
        closeCount: 0,
        close() {
          this.closed = true;
          this.closeCount += 1;
          closeEvents.push("watcher");
        },
      };
      watchers.push(watcher);
      return watchWorkspace
        ? watchWorkspace(workspace, callback, options, watcher)
        : watcher;
    },
    createServer: async (options) => {
      const server = {
        url: "http://127.0.0.1/fake",
        publishCount: 0,
        closed: false,
        closeCount: 0,
        options,
        publish() {
          assert.equal(this.closed, false, "must not publish after server close");
          this.publishCount += 1;
        },
        async close() {
          this.closed = true;
          this.closeCount += 1;
          closeEvents.push("server");
        },
      };
      servers.push(server);
      return createServer ? createServer(options, server) : server;
    },
  });

  return { canvas, projected, sent, logs, servers, watchers, closeEvents };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function model(summary) {
  return { summary, phases: [], errors: [] };
}

const OPEN_CONTEXT = {
  instanceId: "concurrent",
  session: { workingDirectory: "C:\\pilot" },
};

async function createRefreshHarness(options = {}) {
  const requests = [];
  let first = true;
  const harness = createHarness({
    ...options,
    projectWorkspace: () => {
      if (first) {
        first = false;
        return model("Initial");
      }
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  await harness.canvas.open(OPEN_CONTEXT);
  return { ...harness, requests };
}

async function triggerRefresh(harness, source) {
  if (source === "manual") {
    return harness.canvas.actions[0].handler(OPEN_CONTEXT);
  }
  const watcher = harness.watchers[0];
  try {
    await watcher.callback();
  } catch (error) {
    // Mirror the real watcher's error forwarding, including stale failures.
    await watcher.options.onError(error);
  }
}

test("unsupported hosts report unavailable without starting a server", async () => {
  const { canvas, servers } = createHarness();

  const result = await canvas.open({
    instanceId: "unsupported",
    host: { capabilities: { canvases: false } },
    session: { workingDirectory: "/tmp/pilot" },
  });

  assert.deepEqual(result, {
    title: "Threadlight Lifecycle",
    status: "Canvas rendering unavailable",
  });
  assert.equal(servers.length, 0);
});

test("provider exposes refresh and prepare_intent actions in order", () => {
  const { canvas } = createHarness();

  assert.deepEqual(
    canvas.actions.map((action) => action.name),
    ["refresh", "prepare_intent"],
  );
  assert.equal(canvas.inputSchema.properties.phase.type, "string");
  assert.equal(Object.hasOwn(canvas, "title"), false);
});

test("supported open projects workspace and closes its loopback server and watcher", async () => {
  const { canvas, projected, servers, watchers, closeEvents } = createHarness();

  const result = await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });

  assert.deepEqual(result, {
    url: "http://127.0.0.1/fake",
    title: "Threadlight Lifecycle",
    status: "Projected /tmp/pilot",
  });
  assert.deepEqual(projected, ["/tmp/pilot"]);
  assert.equal(servers.length, 1);
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].workspace, "/tmp/pilot");
  assert.equal(typeof watchers[0].callback, "function");
  assert.equal(watchers[0].options.debounceMs, undefined);
  assert.equal(typeof watchers[0].options.onError, "function");
  assert.equal(typeof servers[0].options.getModel, "function");
  assert.deepEqual(await servers[0].options.getModel(), {
    summary: "Projected /tmp/pilot",
    phases: [],
    errors: [],
  });

  await canvas.onClose({ instanceId: "threadlight-spike" });
  assert.equal(watchers[0].closed, true);
  assert.equal(servers[0].closed, true);
  assert.deepEqual(closeEvents, ["watcher", "server"]);
});

test("supported open reuses an existing instance for the same canvas id", async () => {
  const { canvas, projected, servers, watchers } = createHarness();

  const first = await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });
  const second = await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });

  assert.deepEqual(first, {
    url: "http://127.0.0.1/fake",
    title: "Threadlight Lifecycle",
    status: "Projected /tmp/pilot",
  });
  assert.deepEqual(second, first);
  assert.equal(servers.length, 1);
  assert.equal(watchers.length, 1);
  assert.deepEqual(projected, ["/tmp/pilot"]);

  await canvas.onClose({ instanceId: "threadlight-spike" });
  assert.equal(watchers[0].closed, true);
  assert.equal(servers[0].closed, true);
});

test("watcher callback reprojects the workspace model and publishes it", async () => {
  let projectionCount = 0;
  const { canvas, projected, servers, watchers } = createHarness({
    projectWorkspace: async (workspace) => {
      projectionCount += 1;
      return {
        summary: `Projected ${workspace} #${projectionCount}`,
        phases: [],
        errors: [],
      };
    },
  });

  await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });
  await watchers[0].callback();

  assert.deepEqual(projected, ["/tmp/pilot", "/tmp/pilot"]);
  assert.equal(servers[0].publishCount, 1);
  assert.deepEqual(await servers[0].options.getModel(), {
    summary: "Projected /tmp/pilot #2",
    phases: [],
    errors: [],
  });
});

test("watcher errors become visible model errors and extension logs", async () => {
  const existingError = {
    code: "artifact-parse-failed",
    path: "specs/manifest.json",
    message: "Bad JSON",
  };
  const { canvas, logs, servers, watchers } = createHarness({
    projectWorkspace: async (workspace) => ({
      summary: `Projected ${workspace}`,
      phases: [],
      errors: [existingError],
    }),
  });

  await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });
  await watchers[0].options.onError(new Error("watch blew up"));

  assert.equal(servers[0].publishCount, 1);
  assert.deepEqual(await servers[0].options.getModel(), {
    summary: "Workspace refresh failed",
    phases: [],
    errors: [
      existingError,
      {
        code: "workspace-refresh-failed",
        path: null,
        message: "watch blew up",
      },
    ],
  });
  assert.deepEqual(logs, [
    {
      message: "Threadlight Canvas refresh failed: watch blew up",
      options: { level: "error" },
    },
  ]);
});

test("watcher setup failure closes the server before propagating", async () => {
  const { canvas, servers } = createHarness({
    watchWorkspace: async () => {
      throw new Error("watch unavailable");
    },
  });

  await assert.rejects(
    canvas.open({
      instanceId: "threadlight-spike",
      session: { workingDirectory: "/tmp/pilot" },
    }),
    /watch unavailable/,
  );
  assert.equal(servers.length, 1);
  assert.equal(servers[0].closed, true);
});

test("server intent handler sends exactly one visible chat prompt", async () => {
  const { canvas, sent, servers } = createHarness();

  await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });
  await servers[0].options.onIntent({ type: "prepare_handoff" });

  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]), ["prompt"]);
  assert.match(sent[0].prompt, /^\[Threadlight Canvas intent\]/);
});

test("refresh action reprojects the workspace model and publishes it", async () => {
  const { canvas, projected, servers } = createHarness();

  await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });
  const result = await canvas.actions[0].handler({
    instanceId: "threadlight-spike",
  });

  assert.deepEqual(result, { status: "Projected /tmp/pilot" });
  assert.deepEqual(projected, ["/tmp/pilot", "/tmp/pilot"]);
  assert.equal(servers[0].publishCount, 1);
});

test("prepare_intent action validates and submits through chat", async () => {
  const { canvas, sent } = createHarness();

  await canvas.open({
    instanceId: "threadlight-spike",
    session: { workingDirectory: "/tmp/pilot" },
  });
  const result = await canvas.actions[1].handler({
    instanceId: "threadlight-spike",
    input: { intent: { type: "prepare_handoff" } },
  });

  assert.deepEqual(result, {
    accepted: true,
    intent: { type: "prepare_handoff" },
  });
  assert.equal(sent.length, 1);
});

test("concurrent same-ID opens share initialization and close each resource once", async () => {
  const started = deferred();
  const projection = deferred();
  const { canvas, projected, servers, watchers, closeEvents } = createHarness({
    projectWorkspace: () => {
      started.resolve();
      return projection.promise;
    },
  });
  const first = canvas.open(OPEN_CONTEXT);
  const second = canvas.open(OPEN_CONTEXT);
  await started.promise;
  assert.equal(projected.length, 1);
  assert.equal(servers.length, 0);
  projection.resolve(model("Shared"));

  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, "Shared");
  assert.equal(servers.length, 1);
  assert.equal(watchers.length, 1);

  await Promise.all([
    canvas.onClose(OPEN_CONTEXT),
    canvas.onClose(OPEN_CONTEXT),
  ]);
  assert.deepEqual(closeEvents, ["watcher", "server"]);
  assert.equal(watchers[0].closeCount, 1);
  assert.equal(servers[0].closeCount, 1);
});

test("pending initialization does not block a different instance ID", async () => {
  const started = deferred();
  const release = deferred();
  const { canvas, projected, servers, watchers } = createHarness({
    projectWorkspace: (workspace) => {
      if (workspace === OPEN_CONTEXT.session.workingDirectory) {
        started.resolve();
        return release.promise;
      }
      return model("Independent");
    },
  });
  const first = canvas.open(OPEN_CONTEXT);
  await started.promise;
  const independentContext = {
    instanceId: "independent",
    session: { workingDirectory: "C:\\other-pilot" },
  };
  assert.equal((await canvas.open(independentContext)).status, "Independent");
  assert.equal(projected.length, 2);
  assert.equal(servers.length, 1);
  release.resolve(model("Delayed"));
  assert.equal((await first).status, "Delayed");
  assert.equal(servers.length, 2);
  await Promise.all([
    canvas.onClose(OPEN_CONTEXT),
    canvas.onClose(independentContext),
  ]);
  for (const resource of [...servers, ...watchers]) {
    assert.equal(resource.closeCount, 1);
  }
});

test("closing before initialization starts cancels opening without acquiring resources", async () => {
  const { canvas, projected, servers, watchers } = createHarness();
  const opening = canvas.open(OPEN_CONTEXT);
  const cancelled = assert.rejects(opening, { name: "AbortError" });
  await canvas.onClose(OPEN_CONTEXT);
  await cancelled;
  assert.equal(projected.length, 0);
  assert.equal(servers.length, 0);
  assert.equal(watchers.length, 0);

  await canvas.open(OPEN_CONTEXT);
  assert.equal(servers.length, 1);
  await canvas.onClose(OPEN_CONTEXT);
});

for (const stage of ["projection", "server", "watcher"]) {
  test(`close during ${stage} initialization cancels both opens and disposes late resources`, async () => {
    const started = deferred();
    const release = deferred();
    const block = async (value) => {
      started.resolve();
      await release.promise;
      return value;
    };
    const harness = createHarness({
      projectWorkspace: () => stage === "projection"
        ? block(model("Initial"))
        : model("Initial"),
      createServer: (options, server) => stage === "server" ? block(server) : server,
      watchWorkspace: (workspace, callback, options, watcher) =>
        stage === "watcher" ? block(watcher) : watcher,
    });
    const { canvas, projected, servers, watchers, logs, closeEvents } = harness;
    const first = canvas.open(OPEN_CONTEXT);
    const second = canvas.open(OPEN_CONTEXT);
    const cancelled = Promise.all([
      assert.rejects(first, { name: "AbortError" }),
      assert.rejects(second, { name: "AbortError" }),
    ]);
    await started.promise;
    const closing = canvas.onClose(OPEN_CONTEXT);
    await cancelled;
    if (stage === "watcher") {
      await watchers[0].callback();
      await watchers[0].options.onError(new Error("late watch error"));
      assert.equal(projected.length, 1);
      assert.equal(servers[0].publishCount, 0);
      assert.deepEqual(logs, []);
    }
    release.resolve();
    await closing;
    await canvas.onClose(OPEN_CONTEXT);

    assert.equal(servers.length, stage === "projection" ? 0 : 1);
    assert.equal(watchers.length, stage === "watcher" ? 1 : 0);
    for (const resource of [...servers, ...watchers]) {
      assert.equal(resource.closeCount, 1);
    }
    assert.deepEqual(
      closeEvents,
      stage === "projection" ? [] : stage === "server" ? ["server"] : ["watcher", "server"],
    );
  });

  test(`failed ${stage} initialization rejects shared opens, cleans up, and allows same-ID retry`, async () => {
    const started = deferred();
    const release = deferred();
    let fail = true;
    const maybeFail = async (currentStage, value) => {
      if (fail && stage === currentStage) {
        started.resolve();
        await release.promise;
      }
      return value;
    };
    const { canvas, servers, watchers, closeEvents } = createHarness({
      projectWorkspace: () => maybeFail("projection", model("Ready")),
      createServer: (options, server) => maybeFail("server", server),
      watchWorkspace: (workspace, callback, options, watcher) =>
        maybeFail("watcher", watcher),
    });
    const first = canvas.open(OPEN_CONTEXT);
    const second = canvas.open(OPEN_CONTEXT);
    const failed = Promise.all([
      assert.rejects(first, /initialization failed/),
      assert.rejects(second, /initialization failed/),
    ]);
    await started.promise;
    release.reject(new Error("initialization failed"));
    await failed;
    assert.deepEqual(closeEvents, stage === "watcher" ? ["server"] : []);
    if (stage === "watcher") {
      assert.equal(servers[0].closeCount, 1);
    }

    fail = false;
    assert.equal((await canvas.open(OPEN_CONTEXT)).status, "Ready");
    const server = servers.at(-1);
    const watcher = watchers.at(-1);
    assert.equal(server.closed, false);
    assert.equal(watcher.closed, false);
    await canvas.onClose(OPEN_CONTEXT);
    assert.equal(server.closeCount, 1);
    assert.equal(watcher.closeCount, 1);
  });
}

test("late cancelled setup failure cannot remove a reopened same-ID instance", async () => {
  const started = deferred();
  const release = deferred();
  let firstWatcher = true;
  const { canvas, servers, watchers, logs } = createHarness({
    watchWorkspace: async (workspace, callback, options, watcher) => {
      if (firstWatcher) {
        firstWatcher = false;
        started.resolve();
        await release.promise;
      }
      return watcher;
    },
  });
  const oldOpening = canvas.open(OPEN_CONTEXT);
  const cancelled = assert.rejects(oldOpening, { name: "AbortError" });
  await started.promise;
  const closing = canvas.onClose(OPEN_CONTEXT);
  await cancelled;
  const reopened = await canvas.open(OPEN_CONTEXT);
  release.reject(new Error("cancelled setup failed"));
  await closing;

  assert.equal(servers[0].closeCount, 1);
  assert.equal(servers[1].closeCount, 0);
  assert.equal(watchers[1].closeCount, 0);
  assert.deepEqual(await canvas.open(OPEN_CONTEXT), reopened);
  assert.equal(servers.length, 2);
  assert.deepEqual(logs, []);
  await canvas.onClose(OPEN_CONTEXT);
  assert.equal(servers[1].closeCount, 1);
  assert.equal(watchers[1].closeCount, 1);
});

test("watcher close failure still closes the server once and allows reopening", async () => {
  let firstWatcher = true;
  const { canvas, servers, watchers } = createHarness({
    watchWorkspace: (workspace, callback, options, watcher) => {
      if (firstWatcher) {
        firstWatcher = false;
        const close = watcher.close.bind(watcher);
        watcher.close = () => {
          close();
          throw new Error("watcher close failed");
        };
      }
      return watcher;
    },
  });
  await canvas.open(OPEN_CONTEXT);
  await assert.rejects(canvas.onClose(OPEN_CONTEXT), (error) => {
    assert.equal(error.name, "AggregateError");
    assert.match(error.errors[0].message, /watcher close failed/);
    return true;
  });
  await canvas.onClose(OPEN_CONTEXT);
  assert.equal(watchers[0].closeCount, 1);
  assert.equal(servers[0].closeCount, 1);
  await canvas.open(OPEN_CONTEXT);
  await canvas.onClose(OPEN_CONTEXT);
});

test("initialization cleanup failures preserve the setup error and permit retry", async () => {
  let fail = true;
  const { canvas, servers } = createHarness({
    createServer: (options, server) => {
      if (fail) {
        const close = server.close.bind(server);
        server.close = async () => {
          await close();
          throw new Error("server close failed");
        };
      }
      return server;
    },
    watchWorkspace: (workspace, callback, options, watcher) => {
      if (fail) {
        throw new Error("watcher setup failed");
      }
      return watcher;
    },
  });
  await assert.rejects(canvas.open(OPEN_CONTEXT), (error) => {
    assert.equal(error.name, "AggregateError");
    assert.match(error.errors[0].message, /watcher setup failed/);
    assert.match(error.errors[1].errors[0].message, /server close failed/);
    return true;
  });
  assert.equal(servers[0].closeCount, 1);
  await canvas.onClose(OPEN_CONTEXT);
  assert.equal(servers[0].closeCount, 1);
  fail = false;
  await canvas.open(OPEN_CONTEXT);
  await canvas.onClose(OPEN_CONTEXT);
});

for (const olderSource of ["manual", "watcher"]) {
  for (const newerSource of ["manual", "watcher"]) {
    test(`newer ${newerSource} success wins over late ${olderSource} success`, async () => {
      const harness = await createRefreshHarness();
      const { canvas, servers, requests } = harness;
      const older = triggerRefresh(harness, olderSource);
      const newer = triggerRefresh(harness, newerSource);
      assert.equal(requests.length, 2);
      requests[1].resolve(model("Newest"));
      await newer;
      assert.deepEqual(await servers[0].options.getModel(), model("Newest"));
      requests[0].resolve(model("Older"));
      const olderResult = await older;

      assert.deepEqual(await servers[0].options.getModel(), model("Newest"));
      assert.equal(servers[0].publishCount, 1);
      if (olderSource === "manual") {
        assert.deepEqual(olderResult, { status: "Newest" });
      }
      assert.equal((await canvas.open(OPEN_CONTEXT)).status, "Newest");
      await canvas.onClose(OPEN_CONTEXT);
    });

    test(`newer ${newerSource} success suppresses late ${olderSource} failure`, async () => {
      const harness = await createRefreshHarness();
      const { canvas, servers, logs, requests } = harness;
      const older = triggerRefresh(harness, olderSource);
      const newer = triggerRefresh(harness, newerSource);
      requests[1].resolve(model("Newest"));
      await newer;
      requests[0].reject(new Error("obsolete failure"));
      const olderResult = await older;

      assert.deepEqual(await servers[0].options.getModel(), model("Newest"));
      assert.equal(servers[0].publishCount, 1);
      assert.deepEqual(logs, []);
      if (olderSource === "manual") {
        assert.deepEqual(olderResult, { status: "Newest" });
      }
      await canvas.onClose(OPEN_CONTEXT);
    });
  }
}

test("older refresh cannot publish while the newest refresh is still pending", async () => {
  const harness = await createRefreshHarness();
  const { canvas, servers, requests } = harness;
  const older = triggerRefresh(harness, "watcher");
  const newer = triggerRefresh(harness, "manual");
  requests[0].resolve(model("Obsolete"));
  await older;
  assert.deepEqual(await servers[0].options.getModel(), model("Initial"));
  assert.equal(servers[0].publishCount, 0);
  requests[1].resolve(model("Newest"));
  await newer;
  assert.deepEqual(await servers[0].options.getModel(), model("Newest"));
  await canvas.onClose(OPEN_CONTEXT);
});

for (const outcome of ["success", "failure"]) {
  test(`newest refresh failure is not replaced by older ${outcome}`, async () => {
    const harness = await createRefreshHarness();
    const { canvas, servers, logs, requests } = harness;
    const older = triggerRefresh(harness, "watcher");
    const newer = triggerRefresh(harness, "manual");
    const failed = assert.rejects(newer, /newest failure/);
    requests[1].reject(new Error("newest failure"));
    await failed;
    if (outcome === "success") {
      requests[0].resolve(model("Obsolete"));
    } else {
      requests[0].reject(new Error("obsolete failure"));
    }
    await older;

    const current = await servers[0].options.getModel();
    assert.equal(current.summary, "Workspace refresh failed");
    assert.deepEqual(current.errors.map((error) => error.message), ["newest failure"]);
    assert.equal(servers[0].publishCount, 1);
    assert.equal(logs.length, 1);
    await canvas.onClose(OPEN_CONTEXT);
  });
}

for (const source of ["manual", "watcher"]) {
  test(`active ${source} refresh errors remain visible and logged until recovery`, async () => {
    const harness = await createRefreshHarness();
    const { canvas, servers, logs, requests } = harness;
    const refreshing = triggerRefresh(harness, source);
    const failure = source === "manual"
      ? assert.rejects(refreshing, /current failure/)
      : refreshing;
    requests[0].reject(new Error("current failure"));
    await failure;

    assert.deepEqual(await servers[0].options.getModel(), {
      ...model("Workspace refresh failed"),
      errors: [{
        code: "workspace-refresh-failed",
        path: null,
        message: "current failure",
      }],
    });
    assert.equal(servers[0].publishCount, 1);
    assert.deepEqual(logs, [{
      message: "Threadlight Canvas refresh failed: current failure",
      options: { level: "error" },
    }]);

    const recovery = triggerRefresh(harness, source);
    requests[1].resolve(model("Recovered"));
    await recovery;
    assert.deepEqual(await servers[0].options.getModel(), model("Recovered"));
    assert.equal(servers[0].publishCount, 2);
    await canvas.onClose(OPEN_CONTEXT);
  });

  for (const outcome of ["success", "failure"]) {
    test(`late ${source} ${outcome} after close cannot update, publish, or log`, async () => {
      const harness = await createRefreshHarness();
      const { canvas, servers, watchers, logs, requests, projected } = harness;
      const refreshing = triggerRefresh(harness, source);
      await canvas.onClose(OPEN_CONTEXT);
      if (outcome === "success") {
        requests[0].resolve(model("Too late"));
      } else {
        requests[0].reject(new Error("late failure"));
      }
      await refreshing;
      await watchers[0].callback();
      await watchers[0].options.onError(new Error("closed watcher failure"));

      assert.deepEqual(await servers[0].options.getModel(), model("Initial"));
      assert.equal(servers[0].publishCount, 0);
      assert.deepEqual(logs, []);
      assert.equal(projected.length, 2);
      assert.equal(watchers[0].closeCount, 1);
      assert.equal(servers[0].closeCount, 1);
      await assert.rejects(canvas.actions[0].handler(OPEN_CONTEXT), /Unknown Canvas instance/);
    });
  }
}

test("watcher infrastructure error supersedes an older pending projection failure", async () => {
  const harness = await createRefreshHarness();
  const { canvas, servers, watchers, logs, requests } = harness;
  const refreshing = triggerRefresh(harness, "watcher");
  await watchers[0].options.onError(new Error("watch unavailable"));
  requests[0].reject(new Error("older projection failure"));
  await refreshing;

  const current = await servers[0].options.getModel();
  assert.equal(current.summary, "Workspace refresh failed");
  assert.deepEqual(current.errors.map((error) => error.message), ["watch unavailable"]);
  assert.equal(servers[0].publishCount, 1);
  assert.equal(logs.length, 1);
  await canvas.onClose(OPEN_CONTEXT);
});

test("newer success during error logging prevents an obsolete manual rejection", async () => {
  const logging = deferred();
  const releaseLog = deferred();
  const harness = await createRefreshHarness({
    log: () => {
      logging.resolve();
      return releaseLog.promise;
    },
  });
  const { canvas, servers, requests } = harness;
  const older = triggerRefresh(harness, "manual");
  requests[0].reject(new Error("previously current failure"));
  await logging.promise;
  const newer = triggerRefresh(harness, "watcher");
  requests[1].resolve(model("Recovered"));
  await newer;
  releaseLog.resolve();

  assert.deepEqual(await older, { status: "Recovered" });
  assert.deepEqual(await servers[0].options.getModel(), model("Recovered"));
  assert.equal(servers[0].publishCount, 2);
  await canvas.onClose(OPEN_CONTEXT);
});

for (const source of ["manual", "watcher"]) {
  test(`late ${source} error-log rejection cannot replace a newer success`, async () => {
    const logging = deferred();
    const releaseLog = deferred();
    const harness = await createRefreshHarness({
      log: () => {
        logging.resolve();
        return releaseLog.promise;
      },
    });
    const { canvas, servers, logs, requests } = harness;
    const older = triggerRefresh(harness, source);
    requests[0].reject(new Error("previously current failure"));
    await logging.promise;
    const newer = triggerRefresh(harness, "watcher");
    requests[1].resolve(model("Recovered"));
    await newer;
    releaseLog.reject(new Error("obsolete log failure"));
    await older;

    assert.deepEqual(await servers[0].options.getModel(), model("Recovered"));
    assert.equal(servers[0].publishCount, 2);
    assert.equal(logs.length, 1);
    await canvas.onClose(OPEN_CONTEXT);
  });
}
