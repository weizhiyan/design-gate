// 配对置信度上浮 + 顺序矛盾标记：验证「依据不牢的结论不许定成 error」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTrees } from "../src/diff/match.js";
import { compareTrees } from "../src/diff/compare.js";
import { loadSpec } from "../src/rules/spec.js";
import type { StyleNode } from "../src/types.js";
import { sn } from "./helpers.js";

const spec = await loadSpec();

const root = (children: StyleNode[]): StyleNode =>
  sn("root", { x: 0, y: 0, w: 600, h: 400 }, { children });

const run = (design: StyleNode, code: StyleNode) => {
  const m = matchTrees(design, code);
  return { m, ...compareTrees(m, { spec }) };
};

test("低置信度配对：结论降级为 warning，并带上配对分数", () => {
  const design = root([
    sn("blockA", { x: 0, y: 0, w: 100, h: 100 }, { kind: "box", style: { backgroundColor: "#ff0000" } }),
  ]);
  const code = root([
    sn("div.a", { x: 60, y: 60, w: 100, h: 100 }, { kind: "box", style: { backgroundColor: "#00ff00" } }),
  ]);

  const { m, issues, needsReview } = run(design, code);
  const pair = m.pairs.find((p) => p.design.id === "blockA");
  assert.ok(pair, "两个盒子应配上对");
  assert.ok(pair.score < 0.55, `置信度应偏低，实际 ${pair.score}`);

  const mine = issues.filter((i) => i.designNodeName === "blockA");
  assert.ok(mine.length >= 2, "位置与颜色都应有偏差");
  assert.equal(
    mine.filter((i) => i.severity === "error").length,
    0,
    "配对不可信时不允许出现 error"
  );
  assert.equal(mine[0].suspectPair, true);
  assert.equal(mine[0].matchScore, pair.score);
  assert.equal(mine[0].matchMethod, "geometry");
  assert.equal(needsReview, true);
});

test("高置信度配对：真实偏差仍然是 error", () => {
  const design = root([
    sn("blockA", { x: 0, y: 0, w: 100, h: 100 }, { kind: "box", style: { backgroundColor: "#ff0000" } }),
  ]);
  const code = root([
    sn("div.a", { x: 0, y: 0, w: 100, h: 100 }, { kind: "box", style: { backgroundColor: "#00ff00" } }),
  ]);

  const { m, issues } = run(design, code);
  assert.equal(m.pairs.find((p) => p.design.id === "blockA")?.score, 1);
  const color = issues.find((i) => i.category === "color");
  assert.equal(color?.severity, "error");
  assert.equal(color?.suspectPair, undefined);
});

test("顺序与设计相反：两侧都标注，交人工判断但不降级", () => {
  const design = sn("root", { x: 0, y: 0, w: 400, h: 300 }, {
    children: [
      sn("甲", { x: 0, y: 0, w: 100, h: 20 }, { text: "甲", kind: "text" }),
      sn("乙", { x: 0, y: 50, w: 100, h: 20 }, { text: "乙", kind: "text" }),
    ],
  });
  const code = sn("root", { x: 0, y: 0, w: 400, h: 300 }, {
    children: [
      sn("p.a", { x: 0, y: 50, w: 100, h: 20 }, { text: "甲", kind: "text" }),
      sn("p.b", { x: 0, y: 0, w: 100, h: 20 }, { text: "乙", kind: "text" }),
    ],
  });

  const { m, issues, needsReview } = run(design, code);
  assert.equal(m.pairs.every((p) => p.method !== "geometry" || p.score === 1), true, "应靠文本锚点配对");

  const a = issues.find((i) => i.designNodeName === "甲");
  const b = issues.find((i) => i.designNodeName === "乙");
  assert.equal(a?.orderConflict, "乙");
  assert.equal(b?.orderConflict, "甲");
  assert.equal(a?.severity, "error", "顺序错本身是确定的问题，不该降级");
  assert.equal(needsReview, true);
});

test("顺序一致时不产生顺序标记", () => {
  const mk = (y2: number) =>
    sn("root", { x: 0, y: 0, w: 400, h: 300 }, {
      children: [
        sn("甲", { x: 0, y: 0, w: 100, h: 20 }, { text: "甲", kind: "text" }),
        sn("乙", { x: 0, y: y2, w: 100, h: 20 }, { text: "乙", kind: "text" }),
      ],
    });
  const { issues } = run(mk(50), mk(80));
  assert.ok(issues.length > 0, "间隔变化应被发现");
  assert.equal(issues.some((i) => i.orderConflict), false);
});
