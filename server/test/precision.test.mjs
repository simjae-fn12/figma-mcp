import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "../../plugin/node_modules/esbuild/lib/main.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, executeSaveScreenshots } from "../dist/tools.js";
import { validateRpc } from "../dist/schema.js";

async function cleanup(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Unsafe test cleanup path");
  await rm(target, { recursive: true, force: true });
}
const buildDir = await mkdtemp(path.join(tmpdir(), "figma-precision-tests-"));
async function pluginModule(name) {
  const outfile = path.join(buildDir, name + ".mjs");
  buildSync({
    entryPoints: [
      new URL(`../../plugin/src/main/${name}.ts`, import.meta.url).pathname.replace(
        /^\/(\w:)/,
        "$1"
      ),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  return import(pathToFileURL(outfile));
}
const { serializeNode } = await pluginModule("serializer");
const { designContext } = await pluginModule("design-context");
const { exportNode, withTimeout } = await pluginModule("export");
test.after(async () => cleanup(buildDir, tmpdir()));
const base = (id, extra = {}) => ({
  id,
  name: id,
  type: "FRAME",
  visible: true,
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  children: [],
  ...extra,
});

test("mixed borders preserve each side and fractional source dimensions", () => {
  const n = serializeNode(
    base("1:1", {
      width: 707.8967895507812,
      strokeWeight: Symbol("mixed"),
      strokeTopWeight: 1,
      strokeRightWeight: 0,
      strokeBottomWeight: 2,
      strokeLeftWeight: 0,
    })
  );
  assert.equal(n.styles.strokeWeight, "mixed");
  assert.deepEqual(n.styles.strokeWeights, { top: 1, right: 0, bottom: 2, left: 0 });
  assert.equal(n.bounds.width, 707.8967895507812);
});

test("text ranges keep UTF-16 indices, fonts, bindings and percentage units", () => {
  const seg = {
    start: 0,
    end: 3,
    characters: "A😀",
    fontName: { family: "Pretendard", style: "Bold" },
    fontSize: 32,
    fontWeight: 700,
    fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }],
    letterSpacing: { unit: "PERCENT", value: -2 },
    lineHeight: { unit: "PERCENT", value: 125 },
    boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "v1" } },
  };
  const n = serializeNode(
    base("1:2", {
      type: "TEXT",
      characters: "A😀B",
      fontName: Symbol("mixed"),
      fontSize: Symbol("mixed"),
      fontWeight: Symbol("mixed"),
      lineHeight: Symbol("mixed"),
      letterSpacing: Symbol("mixed"),
      getStyledTextSegments: () => [
        seg,
        { ...seg, start: 3, end: 4, characters: "B", fontSize: 16, fontWeight: 400 },
      ],
    })
  );
  assert.equal(n.textSegments[0].end, 3);
  assert.equal(n.textSegments[1].start, 3);
  assert.equal(n.textSegments[0].letterSpacingPx, -0.64);
  assert.equal(n.textSegments[0].lineHeightPx, 40);
  assert.equal(n.textSegments[1].fontWeight, 400);
  assert.equal(n.textSegments[0].boundVariables.fontSize.id, "v1");
  assert.equal(n.styles.fontFamily, "mixed");
  assert.doesNotThrow(() => JSON.stringify(n));
});

test("depth is applied before visiting child styles and hidden nodes are optional", () => {
  const child = base("2:2", { visible: false });
  Object.defineProperty(child, "fills", {
    get() {
      throw Error("must not inspect deep child");
    },
  });
  assert.equal(
    serializeNode(base("2:1", { children: [child] }), { depth: 0, includeHidden: true }).childCount,
    1
  );
  assert.equal(serializeNode(base("2:1", { children: [child] }), { depth: 0 }).childCount, 0);
});

test("context reports truncation, resolves variables per consumer and documents components", async () => {
  globalThis.figma = {
    variables: {
      getVariableByIdAsync: async () => ({
        id: "v1",
        name: "spacing",
        variableCollectionId: "c1",
        valuesByMode: { desktop: 66 },
        resolveForConsumer: (n) => ({ value: n.id === "3:2" ? 66 : 32, resolvedType: "FLOAT" }),
      }),
    },
  };
  const child = base("3:2", {
    type: "INSTANCE",
    boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "v1" } },
    getCSSAsync: async () => ({ gap: "66px" }),
    getMainComponentAsync: async () => ({
      id: "c:1",
      name: "Accordion",
      key: "key",
      description: "Expandable",
      componentPropertyDefinitions: {},
      documentationLinks: [],
    }),
  });
  const r = await designContext([base("3:1", { children: [child, base("3:3")] })], {
    depth: 10,
    maxNodes: 2,
    includeHidden: false,
    includeCss: true,
  });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.omittedNodeIds, ["3:3"]);
  assert.equal(r.nodeCount, 2);
  assert.equal(r.components["c:1"].description, "Expandable");
  assert.equal(r.context[0].children[0].resolvedVariables.v1.value, 66);
  assert.equal(r.context[0].children[0].css.gap, "66px");
});

test("export rejects empty and oversized images and deduplicates pending exports", async () => {
  await assert.rejects(
    exportNode(base("4:1", { exportAsync: async () => new Uint8Array() }), { format: "PNG" }),
    /empty/
  );
  await assert.rejects(
    exportNode(base("4:2", { width: 10000, height: 10000 }), { format: "PNG" }),
    /32 million/
  );
  let calls = 0,
    resolve;
  const n = base("4:3", {
    exportAsync: () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
  });
  const a = exportNode(n, { format: "SVG" }),
    b = exportNode(n, { format: "SVG" });
  resolve(new Uint8Array([1, 2]));
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  await assert.rejects(withTimeout(new Promise(() => {}), "fixture export", 5), /timed out/);
});

test("follower validation preserves precise-context options and image hash", () => {
  const r = validateRpc("get_precision_context", ["127:9260"], {
    depth: 20,
    maxNodes: 500,
    includeCss: true,
  });
  assert.equal(r.error, null);
  assert.equal(r.params.maxNodes, 500);
  assert.equal(r.params.includeCss, true);
  assert.equal(validateRpc("get_image", undefined, { imageHash: "abc" }).params.imageHash, "abc");
  assert.ok(validateRpc("get_screenshot", ["1:1"], { scale: 0 }).error);
});

test("MCP context targets exact node and image saves preserve bytes without overwriting", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".precision-test-"));
  let sent;
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  const node = {
    sendWithParams: async (...args) => {
      sent = args;
      return {
        data:
          args[0] === "get_image"
            ? { base64: bytes.toString("base64"), width: 1, height: 1 }
            : { ok: true },
      };
    },
  };
  const server = new McpServer({ name: "precision-test", version: "1" });
  registerTools(server, node, 0);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    await client.callTool({
      name: "get_design_context",
      arguments: { nodeId: "127:9260", fileKey: "file", depth: 20 },
    });
    assert.deepEqual(sent, ["get_precision_context", ["127:9260"], { depth: 20 }, "file"]);
    const outputPath = path.join(dir, "asset.png");
    const first = await client.callTool({
      name: "save_image",
      arguments: { imageHash: "abc", outputPath },
    });
    assert.ok(!first.isError);
    assert.deepEqual(await readFile(outputPath), bytes);
    assert.equal(JSON.parse(first.content[0].text).sha256.length, 64);
    const second = await client.callTool({
      name: "save_image",
      arguments: { imageHash: "abc", outputPath },
    });
    assert.equal(second.isError, true);
    const outside = await client.callTool({
      name: "save_image",
      arguments: { imageHash: "abc", outputPath: "../outside.png" },
    });
    assert.equal(outside.isError, true);
  } finally {
    await client.close();
    await server.close();
    await cleanup(dir, process.cwd());
  }
});

test("screenshot batch reports partial failure and never saves empty bytes", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".precision-test-"));
  const sender = {
    sendWithParams: async (_t, ids) => ({
      data: {
        exports: [
          {
            nodeId: ids[0],
            nodeName: "test",
            width: 1,
            height: 1,
            format: "SVG",
            base64: ids[0] === "5:1" ? Buffer.from("<svg/>").toString("base64") : "",
          },
        ],
      },
    }),
  };
  try {
    const r = await executeSaveScreenshots(sender, [
      { nodeId: "5:1", outputPath: path.join(dir, "ok.svg") },
      { nodeId: "5:2", outputPath: path.join(dir, "empty.svg") },
    ]);
    assert.equal(r.succeeded, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.hasErrors, true);
    await assert.rejects(readFile(path.join(dir, "empty.svg")), /ENOENT/);
  } finally {
    await cleanup(dir, process.cwd());
  }
});

test("variant metadata uses the parent component-set definitions", async () => {
  const variant = {
    id: "variant:1",
    name: "open",
    description: "",
    documentationLinks: [],
    parent: {
      type: "COMPONENT_SET",
      id: "set:1",
      name: "Accordion",
      description: "Expandable rows",
      documentationLinks: [],
      componentPropertyDefinitions: { Open: { type: "BOOLEAN" } },
    },
  };
  Object.defineProperty(variant, "componentPropertyDefinitions", {
    get() {
      throw new Error("not available for variants");
    },
  });
  const instance = base("6:1", { type: "INSTANCE", getMainComponentAsync: async () => variant });
  const r = await designContext([instance], {
    depth: 5,
    maxNodes: 20,
    includeHidden: false,
    includeCss: false,
  });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.components["variant:1"].description, "Expandable rows");
  assert.equal(r.components["variant:1"].componentPropertyDefinitions.Open.type, "BOOLEAN");
});
