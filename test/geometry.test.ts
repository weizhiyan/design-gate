// 相对几何：验证「一个根因只报一次」。
// 这些用例是 ① 的核心断言 —— 绝对坐标比对会让父级的一次偏移在每个后代身上重复出现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTrees } from "../src/diff/match.js";
import { compareTrees } from "../src/diff/compare.js";
import { relativeGeometry } from "../src/diff/geometry.js";
import { loadSpec } from "../src/rules/spec.js";
import type { StyleNode } from "../src/types.js";
import { sn } from "./helpers.js";

const spec = await loadSpec();

/** 造一棵「根 > 面板 > N 个文本行」的树；panelX 控制面板整体位置 */
function page(panelX: number, panelY: number, rows: [string, number][]): StyleNode {
  return sn("root", { x: 0, y: 0, w: 600, h: 400 }, {
    children: [
      sn("panel", { x: panelX, y: panelY, w: 300, h: 200 }, {
        kind: "box",
        children: rows.map(([t, dy]) =>
          sn(t, { x: panelX + 20, y: panelY + dy, w: 200, h: 20 }, { text: t, kind: "text" })
        ),
      }),
    ],
  });
}

const geoIssues = (design: StyleNode, code: StyleNode) => {
  const m = matchTrees(design, code);
  const { issues } = compareTrees(m, { spec });
  return issues.filter((i) => i.category === "geometry" && (i.property === "x" || i.property === "y"));
};

test("父级整体偏移只报父级一次，后代不重复上报", () => {
  const rows: [string, number][] = [["甲", 10], ["乙", 50], ["丙", 90], ["丁", 130]];
  const design = page(100, 40, rows);
  const code = page(187, 40, rows); // 面板整体右移 87px，内部关系不变

  const issues = geoIssues(design, code);
  assert.equal(issues.length, 1, `应只有 1 条位置问题，实际: ${issues.map((i) => i.designNodeName).join(",")}`);
  assert.equal(issues[0].designNodeName, "panel");
  assert.equal(issues[0].property, "x");
  assert.equal(issues[0].delta, "Δ87px");
});

test("同一父级下的一个元素移位，只报它自己", () => {
  const design = page(100, 40, [["甲", 10], ["乙", 50], ["丙", 90]]);
  const code = page(100, 40, [["甲", 10], ["乙", 70], ["丙", 110]]); // 乙下移 20，丙跟着走

  const issues = geoIssues(design, code);
  assert.equal(issues.length, 1, `应只报乙，实际: ${issues.map((i) => i.designNodeName).join(",")}`);
  assert.equal(issues[0].designNodeName, "乙");
  assert.equal(issues[0].property, "y");
  assert.equal(issues[0].delta, "Δ20px");
});

test("兄弟间隔用「上一个元素的下边缘」度量，前面的元素变高不算后面的错", () => {
  const design = sn("root", { x: 0, y: 0, w: 400, h: 300 }, {
    children: [
      sn("a", { x: 0, y: 0, w: 100, h: 40 }, { kind: "box" }),
      sn("b", { x: 0, y: 60, w: 100, h: 40 }, { kind: "box" }),
    ],
  });
  // a 高了 20px，b 保持 20px 间隔顺延下移 → 只应报 a 的高度
  const code = sn("root", { x: 0, y: 0, w: 400, h: 300 }, {
    children: [
      sn("a", { x: 0, y: 0, w: 100, h: 60 }, { kind: "box" }),
      sn("b", { x: 0, y: 80, w: 100, h: 40 }, { kind: "box" }),
    ],
  });

  const m = matchTrees(design, code);
  const { issues } = compareTrees(m, { spec });
  const geo = issues.filter((i) => i.category === "geometry");
  assert.equal(geo.length, 1);
  assert.equal(geo[0].designNodeName, "a");
  assert.equal(geo[0].property, "h");
});

test("横向一行的元素在 y 轴上不串成链（各自对父级度量）", () => {
  const mk = (y2: number) =>
    sn("root", { x: 0, y: 0, w: 400, h: 200 }, {
      children: [
        sn("btn1", { x: 0, y: 0, w: 80, h: 30 }, { kind: "box" }),
        sn("btn2", { x: 100, y: y2, w: 80, h: 30 }, { kind: "box" }),
        sn("btn3", { x: 200, y: 0, w: 80, h: 30 }, { kind: "box" }),
      ],
    });

  const issues = geoIssues(mk(0), mk(12)); // 只有 btn2 掉下去 12px
  assert.equal(issues.length, 1, `实际: ${issues.map((i) => `${i.designNodeName}/${i.property}`).join(",")}`);
  assert.equal(issues[0].designNodeName, "btn2");
  assert.equal(issues[0].property, "y");
});

test("子元素整体同向偏移 → 归因到父容器内边距，只报一条", () => {
  const rows: [string, number][] = [["甲", 10], ["乙", 50], ["丙", 90]];
  const design = page(100, 40, rows);
  const code = page(100, 40, rows);
  // 面板位置不变，内部三行各自右移 12px（等效于 padding-left 变大）
  for (const row of code.children[0].children) row.rect.x += 12;

  const m = matchTrees(design, code);
  const { issues } = compareTrees(m, { spec });
  const geo = issues.filter((i) => i.category === "geometry");
  assert.equal(geo.length, 1, `实际: ${geo.map((i) => `${i.designNodeName}/${i.property}`).join(",")}`);
  assert.equal(geo[0].property, "padding-left");
  assert.equal(geo[0].designNodeName, "panel");
  assert.match(geo[0].message, /3 个子元素/);
});

test("relativeGeometry 不给根节点基准", () => {
  const design = page(100, 40, [["甲", 10]]);
  const m = matchTrees(design, page(100, 40, [["甲", 10]]));
  const rel = relativeGeometry(m);
  assert.equal(rel.get(m.pairs[0].design), undefined, "根节点无父级，不应有相对关系");
  assert.ok(rel.size > 0);
});

/**
 * 造一棵「根 > 列表容器 > 3 个纵向排列的行」的树。
 * gap 决定行间距，extraLastY 给最后一行额外加一段偏移（用于验证逐条判定）。
 */
function stack(gap: number, extraLastY = 0): StyleNode {
  const names = ["甲", "乙", "丙"];
  let y = 50;
  const rows = names.map((t, idx) => {
    const row = sn(t, { x: 120, y: y + (idx === names.length - 1 ? extraLastY : 0), w: 200, h: 20 }, {
      text: t,
      kind: "text",
    });
    y += 20 + gap;
    return row;
  });
  return sn("root", { x: 0, y: 0, w: 600, h: 400 }, {
    children: [
      sn("list", { x: 100, y: 40, w: 300, h: 200 }, { kind: "box", layout: { gap }, children: rows }),
    ],
  });
}

test("父级 gap 写错：只报容器一条，不再逐个兄弟报间隔、也不补一句栅格", () => {
  const m = matchTrees(stack(12), stack(10));
  const { issues } = compareTrees(m, { spec });

  const gapIssues = issues.filter((i) => i.property === "gap");
  assert.equal(gapIssues.length, 1, `gap 应只有 1 条结论，实际: ${gapIssues.map((i) => `${i.category}/${i.designNodeName}`).join(",")}`);
  assert.equal(gapIssues[0].category, "geometry");
  assert.equal(gapIssues[0].designNodeName, "list");
  assert.equal(gapIssues[0].delta, "Δ2px");

  // 10 不在 4/8 栅格上，但「改成 12」这一条已经涵盖了它 —— 同一个数值不说两遍
  assert.deepEqual(issues.filter((i) => i.category === "grid"), []);
  // 兄弟间隔差正是父级 gap 差的投影，不该让每一行各报一次
  assert.deepEqual(
    issues.filter((i) => i.category === "geometry" && i.property === "y").map((i) => i.designNodeName),
    []
  );
  assert.equal(issues.length, 1, `实际: ${issues.map((i) => `${i.category}/${i.property}@${i.designNodeName}`).join(",")}`);
});

test("子元素自己另有偏移时不被 gap 结论吞掉（逐条判定，不是整组折叠）", () => {
  const m = matchTrees(stack(12), stack(10, 10));
  const { issues } = compareTrees(m, { spec });

  assert.deepEqual(
    issues.map((i) => `${i.category}/${i.property}@${i.designNodeName}`).sort(),
    ["geometry/gap@list", "geometry/y@丙"],
    "丙 比 gap 差多偏了 10px，那一份必须留下"
  );
  assert.equal(issues.find((i) => i.designNodeName === "丙")!.delta, "Δ8px");
});
