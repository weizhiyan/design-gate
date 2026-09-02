import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFigmaNode } from "../src/figma/client.js";

test("宿主传入 Figma 快照时不需要 URL 或 FIGMA_TOKEN", async () => {
  const snapshot = {
    nodes: {
      "2173:3310": {
        document: {
          id: "2173:3310",
          name: "工作台",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 1663, height: 1080 },
          children: [],
        },
      },
    },
  };

  const result = await loadFigmaNode(undefined, undefined, snapshot);

  assert.equal(result.document.id, "2173:3310");
  assert.equal(result.document.name, "工作台");
  assert.equal(result.source, "宿主传入的 Figma 快照");
});

test("figmaJson 仍兼容本地节点 JSON 字符串文件", async () => {
  const result = await loadFigmaNode(undefined, "test/fixtures/figma-node.json");
  assert.equal(result.document.name, "fixture");
  assert.match(result.source, /缓存文件/);
});
