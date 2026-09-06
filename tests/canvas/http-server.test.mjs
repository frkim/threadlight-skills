import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLoopbackServer } from "../../.github/extensions/threadlight-lifecycle/lib/http-server.mjs";

test("loopback server protects APIs while serving static Canvas assets", async () => {
  const webRoot = new URL(
    `./.tmp-http-server-${process.pid}-${Date.now()}/`,
    import.meta.url,
  );
  const intents = [];
  let server;

  await mkdir(webRoot, { recursive: true });
  await writeFile(
    new URL("index.html", webRoot),
    "<!doctype html><title>Canvas</title>",
    "utf8",
  );

  try {
    server = await createLoopbackServer({
      webRoot,
      token: "test-token",
      getModel: async () => ({ phases: [] }),
      onIntent: async (intent) => intents.push(intent),
    });

    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+/);

    const unauthenticatedModel = await fetch(
      new URL("/api/model", server.origin),
    );
    assert.equal(unauthenticatedModel.status, 401);

    const index = await fetch(server.url);
    assert.equal(index.status, 200);
    assert.match(
      index.headers.get("content-security-policy"),
      /default-src 'self'/,
    );
    assert.match(await index.text(), /Canvas/);

    const intent = { type: "prepare_handoff" };
    const intentResponse = await fetch(
      new URL("/api/intent?token=test-token", server.origin),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      },
    );
    assert.equal(intentResponse.status, 202);
    assert.deepEqual(await intentResponse.json(), { accepted: true });
    assert.deepEqual(intents, [intent]);

    const traversal = await fetch(
      new URL("/..%2F..%2Fplugin.json?token=test-token", server.origin),
    );
    assert.equal(traversal.status, 404);
  } finally {
    await server?.close();
    await rm(webRoot, { recursive: true, force: true });
  }
});

test("loopback server can bind an explicit loopback port", async () => {
  const webRoot = new URL(
    `./.tmp-http-server-port-${process.pid}-${Date.now()}/`,
    import.meta.url,
  );
  let server;

  await mkdir(webRoot, { recursive: true });
  await writeFile(
    new URL("index.html", webRoot),
    "<!doctype html><title>Canvas</title>",
    "utf8",
  );

  try {
    server = await createLoopbackServer({
      webRoot,
      port: 4191,
      getModel: async () => ({ phases: [] }),
      onIntent: async () => {},
    });

    assert.equal(server.origin, "http://127.0.0.1:4191");
    assert.equal(new URL(server.url).port, "4191");
  } finally {
    await server?.close();
    await rm(webRoot, { recursive: true, force: true });
  }
});

for (const rootType of ["file URL", "native string"]) {
  test(`loopback server serves ${rootType} roots with spaces and encoded characters`, async () => {
    const webRoot = new URL(
      `./.fixture-http-root-${process.pid}-${Date.now()}/Canvas%20assets%20%2523%20%23%20%C3%BC/`,
      import.meta.url,
    );
    const fixtureRoot = new URL("../", webRoot);
    let server;

    await mkdir(webRoot, { recursive: true });
    await writeFile(new URL("index.html", webRoot), "<title>Encoded root</title>", "utf8");
    await writeFile(new URL("app.js", webRoot), "window.canvasReady = true;", "utf8");
    await writeFile(new URL("outside.json", fixtureRoot), '{"private":true}', "utf8");

    try {
      server = await createLoopbackServer({
        webRoot: rootType === "file URL" ? webRoot : fileURLToPath(webRoot),
        getModel: async () => ({ phases: [] }),
        onIntent: async () => {},
      });

      const index = await fetch(server.url);
      assert.equal(index.status, 200);
      assert.equal(await index.text(), "<title>Encoded root</title>");

      const asset = await fetch(new URL("/app.js", server.origin));
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type"), /javascript/);
      assert.equal(await asset.text(), "window.canvasReady = true;");

      for (const pathname of ["/..%2Foutside.json", "/..%5Coutside.json"]) {
        const traversal = await fetch(new URL(pathname, server.origin));
        assert.equal(traversal.status, 404);
      }
    } finally {
      await server?.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
}
