import { createIntentBroker } from "./intents.mjs";
import { createLoopbackServer } from "./http-server.mjs";

const PHASES = [
  "design",
  "build-deploy",
  "discover",
  "protect-govern",
  "improve",
  "handoff",
];

const OPEN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    phase: { type: "string", enum: PHASES },
  },
  additionalProperties: false,
};

const NO_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const PREPARE_INTENT_SCHEMA = {
  type: "object",
  required: ["intent"],
  properties: {
    intent: { type: "object" },
  },
  additionalProperties: false,
};

function requireInstance(instances, instanceId) {
  const instance = instances.get(instanceId);
  if (!instance?.ready || instance.closed) {
    throw new Error(`Unknown Canvas instance: ${instanceId}`);
  }
  return instance;
}

function describeInstance(instance) {
  return {
    url: instance.server.url,
    title: "Threadlight Lifecycle",
    status: instance.model.summary,
  };
}

function closeResources(instance) {
  instance.disposal ??= (async () => {
    const errors = [];
    for (const resource of [instance.watcher, instance.server]) {
      try {
        await resource?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Canvas resource cleanup failed");
    }
  })();
  return instance.disposal;
}

export function createLifecycleCanvas({
  createCanvas,
  webRoot,
  getSession,
  projectWorkspace,
  watchWorkspace,
  createServer = createLoopbackServer,
} = {}) {
  const instances = new Map();

  function isCurrent(instance, generation) {
    return !instance.closed && instance.generation === generation;
  }

  async function reportRefreshError(instance, error, generation) {
    if (!isCurrent(instance, generation)) {
      return;
    }
    instance.model = {
      ...instance.model,
      summary: "Workspace refresh failed",
      errors: [
        ...(Array.isArray(instance.model.errors) ? instance.model.errors : []),
        {
          code: "workspace-refresh-failed",
          path: null,
          message: error.message,
        },
      ],
    };
    instance.server.publish();
    try {
      await instance.session.log(
        `Threadlight Canvas refresh failed: ${error.message}`,
        { level: "error" },
      );
    } catch (logError) {
      if (isCurrent(instance, generation)) {
        throw logError;
      }
    }
  }

  async function refresh(instance, { propagateError = false } = {}) {
    if (instance.closed) {
      return;
    }
    const generation = ++instance.generation;
    let model;
    try {
      model = await projectWorkspace(instance.workspace);
    } catch (error) {
      if (isCurrent(instance, generation)) {
        await reportRefreshError(instance, error, generation);
        if (propagateError && isCurrent(instance, generation)) {
          throw error;
        }
      }
      return;
    }
    if (isCurrent(instance, generation)) {
      instance.model = model;
      instance.server.publish();
    }
  }

  function ensureOpen(instance) {
    if (instance.closed) {
      throw instance.cancellation;
    }
  }

  async function initialize(instance, resolve, reject) {
    try {
      ensureOpen(instance);
      const model = await projectWorkspace(instance.workspace);
      ensureOpen(instance);
      instance.model = model;
      instance.server = await createServer({
        webRoot,
        getModel: async () => instance.model,
        onIntent: (intent) => instance.broker.submit(intent),
      });
      ensureOpen(instance);
      instance.watcher = await watchWorkspace(
        instance.workspace,
        // Handle projection failures here, while their refresh generation is known.
        () => refresh(instance),
        {
          onError: (error) => {
            if (instance.closed) {
              return;
            }
            return reportRefreshError(instance, error, ++instance.generation);
          },
        },
      );
      ensureOpen(instance);
      instance.ready = true;
      resolve(describeInstance(instance));
    } catch (error) {
      instance.closed = true;
      ++instance.generation;
      try {
        await closeResources(instance);
      } catch (cleanupError) {
        error = new AggregateError(
          [error, cleanupError],
          "Canvas initialization and resource cleanup failed",
        );
      }
      if (instances.get(instance.instanceId) === instance) {
        instances.delete(instance.instanceId);
      }
      reject(error);
    }
  }

  return createCanvas({
    id: "threadlight-lifecycle",
    displayName: "Threadlight Lifecycle",
    description:
      "Start and inspect a Threadlight pilot by outcome without needing skill names.",
    inputSchema: OPEN_INPUT_SCHEMA,
    actions: [
      {
        name: "refresh",
        description: "Refresh the Threadlight lifecycle workspace projection.",
        inputSchema: NO_INPUT_SCHEMA,
        handler: async ({ instanceId }) => {
          const instance = requireInstance(instances, instanceId);
          await refresh(instance, { propagateError: true });
          return { status: instance.model.summary };
        },
      },
      {
        name: "prepare_intent",
        description: "Validate a Canvas intent and prepare it in chat.",
        inputSchema: PREPARE_INTENT_SCHEMA,
        handler: async ({ instanceId, input }) => {
          const instance = requireInstance(instances, instanceId);
          return instance.broker.submit(input?.intent);
        },
      },
    ],
    open: async (context) => {
      if (context.host?.capabilities?.canvases === false) {
        return {
          title: "Threadlight Lifecycle",
          status: "Canvas rendering unavailable",
        };
      }

      const existingInstance = instances.get(context.instanceId);
      if (existingInstance) {
        return existingInstance.ready
          ? describeInstance(existingInstance)
          : existingInstance.opening;
      }

      const workspace = context.session?.workingDirectory;
      if (!workspace) {
        throw new Error("Canvas session has no working directory");
      }

      const session = getSession();
      if (!session) {
        throw new Error("Extension session is not attached");
      }

      const broker = createIntentBroker({
        send: (payload) => session.send(payload),
      });
      const instance = {
        instanceId: context.instanceId,
        workspace,
        session,
        broker,
        model: undefined,
        server: undefined,
        watcher: undefined,
        generation: 0,
        ready: false,
        closed: false,
        cancellation: Object.assign(
          new Error(`Canvas opening cancelled: ${context.instanceId}`),
          { name: "AbortError" },
        ),
      };
      let resolveOpening;
      instance.opening = new Promise((resolve, reject) => {
        resolveOpening = resolve;
        instance.rejectOpening = reject;
      });
      instances.set(context.instanceId, instance);
      instance.initialization = Promise.resolve().then(() =>
        initialize(instance, resolveOpening, instance.rejectOpening),
      );
      return instance.opening;
    },
    onClose: async ({ instanceId }) => {
      const instance = instances.get(instanceId);
      if (!instance) {
        return;
      }

      instances.delete(instanceId);
      instance.closed = true;
      ++instance.generation;
      instance.rejectOpening(instance.cancellation);
      await instance.initialization;
      await closeResources(instance);
    },
  });
}
