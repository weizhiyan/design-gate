// 匹配与存在性判定：验证 kind 约束与「文本存在性」兜底。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTrees } from "../src/diff/match.js";
import { compareTrees } from "../src/diff/compare.js";
import { loadSpec } from "../src/rules/spec.js";
import type { StyleNode } from "../src/types.js";
import { sn } from "./helpers.js";

const spec = await loadSpec();

const tree = (children: StyleNode[]): StyleNode =>
  sn("root", { x: 0, y: 0, w: 200, h: 100 }, { children });

test("同位的图标与普通盒子不应配对（kind 约束）", () => {
  const design = tree([sn("icon", { x: 0, y: 0, w: 16, h: 16 }, { kind: "icon" })]);
  const code = tree([sn("span.ant-checkbox", { x: 0, y: 0, w: 16, h: 16 }, { kind: "box" })]);

  const m = matchTrees(design, code);
  assert.equal(m.pairs.length, 1, "只应有强制配对的根节点");
  assert.equal(m.unmatchedDesign[0]?.id, "icon");
  assert.equal(m.unmatchedCode[0]?.id, "span.ant-checkbox");
});

test("同位的图标与 svg 正常配对", () => {
  const design = tree([sn("icon", { x: 0, y: 0, w: 16, h: 16 }, { kind: "icon" })]);
  const code = tree([sn("svg", { x: 0, y: 0, w: 16, h: 16 }, { kind: "icon" })]);

  const m = matchTrees(design, code);
  assert.equal(m.pairs.length, 2);
  assert.equal(m.unmatchedDesign.length, 0);
});

test("设计文本已在页面出现（伪元素/占位符）→ info，不计入门禁", () => {
  const design = tree([sn("d-star", { x: 0, y: 0, w: 8, h: 16 }, { text: "*", kind: "text" })]);
  const code = tree([
    sn("label", { x: 100, y: 0, w: 80, h: 16 }, { text: "用户名", auxText: "*", kind: "text" }),
  ]);

  const m = matchTrees(design, code);
  const { issues } = compareTrees(m, { spec });
  const ex = issues.filter((i) => i.category === "existence" && i.property === "element");
  assert.equal(ex.length, 1);
  assert.equal(ex[0].severity, "info", "文字在页面上存在，不应算缺失");
});

test("设计文本确实不在页面上 → 仍然是 error", () => {
  const design = tree([sn("d-x", { x: 0, y: 0, w: 80, h: 16 }, { text: "优先支持", kind: "text" })]);
  const code = tree([sn("p", { x: 100, y: 0, w: 80, h: 16 }, { text: "别的文字", kind: "text" })]);

  const m = matchTrees(design, code);
  const { issues } = compareTrees(m, { spec });
  const ex = issues.filter((i) => i.category === "existence" && i.property === "element");
  assert.equal(ex.length, 1);
  assert.equal(ex[0].severity, "error");
});

test("未匹配的图标降级为 warning（粒度差异不等于缺失）", () => {
  const design = tree([sn("d-icon", { x: 0, y: 0, w: 16, h: 16 }, { kind: "icon" })]);
  const code = tree([sn("div", { x: 150, y: 80, w: 40, h: 20 }, { kind: "box" })]);

  const m = matchTrees(design, code);
  const { issues } = compareTrees(m, { spec });
  const ex = issues.filter((i) => i.category === "existence" && i.property === "element");
  assert.equal(ex.length, 1);
  assert.equal(ex[0].severity, "warning");
});
