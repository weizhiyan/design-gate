// 降噪机制的行为锁。
// X501 那轮真实页面出了 605 条 warning、494 个图钉、206 对置信度不足的配对，报告因此
// 不可读。下面每条用例锁的都是当时的一个直接对策 —— 回归了，噪声就整批回来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchTrees } from "../src/diff/match.js";
import { compareTrees } from "../src/diff/compare.js";
import { loadSpec } from "../src/rules/spec.js";
import { buildQuestions } from "../src/rules/questions.js";
import { foldPins, MAX_MARKERS, type Pin } from "../src/report/markers.js";
import type { Issue, Severity, StyleNode } from "../src/types.js";
import { sn } from "./helpers.js";

const spec = await loadSpec();

const root = (id: string, w: number, h: number, children: StyleNode[]): StyleNode =>
  sn(id, { x: 0, y: 0, w, h }, { children });

/** 一行 = 外层盒子 + 一个文本单元格。重复列表识别靠的正是这种「同构兄弟」形状 */
const row = (id: string, y: number, text: string): StyleNode =>
  sn(id, { x: 0, y, w: 400, h: 40 }, {
    children: [sn(`${id}-cell`, { x: 12, y: y + 10, w: 200, h: 20 }, { kind: "text", text })],
  });

const list = (id: string, rows: StyleNode[]): StyleNode =>
  sn(id, { x: 0, y: 0, w: 400, h: rows.length * 40 }, { children: rows });

const pairFor = (m: ReturnType<typeof matchTrees>, designId: string) =>
  m.pairs.find((p) => p.design.id === designId);

/** 造一条最小 Issue：只测公式与聚类，不走 compareTrees */
const iss = (over: Partial<Issue>): Issue => ({
  id: "ISS-000",
  severity: "warning",
  category: "existence",
  property: "extra-element",
  designValue: "—",
  actualValue: "div",
  message: "m",
  ...over,
});

// ---------- 1. 重复列表模板化 ----------

test("重复列表：设计 3 行 / 实现 6 行 → 按下标对齐，多出的行收成一条结论", () => {
  const design = root("d-root", 400, 300, [
    list("d-list", [row("d-row-1", 0, "行1"), row("d-row-2", 40, "行2"), row("d-row-3", 80, "行3")]),
  ]);
  const code = root("c-root", 400, 300, [
    list("c-list", [1, 2, 3, 4, 5, 6].map((n) => row(`c-row-${n}`, (n - 1) * 40, `行${n}`))),
  ]);
  const m = matchTrees(design, code);

  for (const n of [1, 2, 3]) {
    const p = pairFor(m, `d-row-${n}`);
    assert.equal(p?.code.id, `c-row-${n}`, `设计第 ${n} 行应配到实现第 ${n} 行`);
    assert.equal(p?.method, "structure");
    assert.equal(p?.score, 0.9);
  }
  // 多出的 3 行整体退出匹配池：留在池里会被几何匹配乱配，二次制造假偏差
  assert.equal(
    m.unmatchedCode.some((n) => /^c-row-[456]$/.test(n.id)),
    false,
    "多出的行不应再作为「实现多出的元素」逐行上报"
  );
  assert.equal(m.surplus?.length, 1);
  assert.equal(m.surplus![0].side, "code");
  assert.equal(m.surplus![0].designRows, 3);
  assert.equal(m.surplus![0].codeRows, 6);
  assert.match(m.surplus![0].sample, /行4/);

  const { issues } = compareTrees(m, { spec });
  const rowCount = issues.filter((i) => i.property === "row-count");
  assert.equal(rowCount.length, 1, "行数差只出一条结论");
  assert.equal(rowCount[0].delta, "Δ3 行");
  assert.equal(issues.filter((i) => i.property === "extra-element").length, 0);
  assert.equal(issues.filter((i) => i.property === "element").length, 0);
});

test("重复列表按流向轴对齐：横向排列时 y 抖动不会让整排错位", () => {
  const btn = (id: string, x: number, y: number, text: string): StyleNode =>
    sn(id, { x, y, w: 100, h: 40 }, {
      children: [sn(`${id}-t`, { x: x + 10, y: y + 10, w: 80, h: 20 }, { kind: "text", text })],
    });
  const bar = (id: string, kids: StyleNode[]): StyleNode =>
    sn(id, { x: 0, y: 0, w: 400, h: 60 }, { children: kids });

  const design = root("d-root", 400, 200, [
    bar("d-bar", [btn("d-btn-1", 0, 0, "A"), btn("d-btn-2", 100, 0, "B"), btn("d-btn-3", 200, 0, "C")]),
  ]);
  // y 抖 12/0/6：若按 y 排序，实现侧顺序会变成 2→3→1，第一个就配错。
  // 文本也故意两侧不同（A/B/C vs X/Y/Z），文本锚点救不回来 —— 只有轴向正确才配得对。
  const code = root("c-root", 400, 200, [
    bar("c-bar", [btn("c-btn-1", 0, 12, "X"), btn("c-btn-2", 100, 0, "Y"), btn("c-btn-3", 200, 6, "Z")]),
  ]);
  const m = matchTrees(design, code);

  for (const n of [1, 2, 3]) {
    const p = pairFor(m, `d-btn-${n}`);
    assert.equal(p?.code.id, `c-btn-${n}`);
    assert.equal(p?.method, "structure");
  }
});

/** 卡片文本叶子：形状签名相同，只有字号字重把它们区分开 */
const txt = (
  id: string,
  y: number,
  h: number,
  fontSize: number,
  fontWeight: number,
  text: string
): StyleNode =>
  sn(id, { x: 0, y, w: 272, h }, { kind: "text", text, style: { fontSize, fontWeight } });

test("重复列表不误判：卡片里字号各异的文本叶子不是列表", () => {
  // 一张定价卡：标题 / 价格 / 描述 —— 三个连续文本叶子，纯形状签名完全一致
  const design = root("d-card", 320, 340, [
    txt("d-title", 0, 28, 20, 600, "专业版"),
    txt("d-price", 40, 40, 32, 700, "¥99 /月"),
    txt("d-desc", 92, 20, 14, 400, "适合5-10人团队使用"),
  ]);
  // 实现多画了一个角标 → 实现侧 4 个连续文本叶子、设计侧 3 个。只按形状签名的话，
  // 这就成了「设计 3 行 / 实现 4 行」的列表：按下标对齐后标题配到价格、价格配到描述，
  // 整张卡的结论全是错位造出来的假偏差。行模板必须连字体档位一起同构才算同一个模板。
  const code = root("c-card", 320, 340, [
    txt("c-badge", -10, 20, 12, 400, "限时优惠"),
    txt("c-title", 0, 28, 20, 600, "专业版"),
    txt("c-price", 40, 40, 32, 700, "¥99 /月"),
    txt("c-desc", 92, 20, 14, 400, "适合5-10人团队使用"),
  ]);
  const m = matchTrees(design, code);

  assert.equal(m.surplus?.length, 0, "这不是列表，不该出行数差");
  for (const [d, c] of [
    ["d-title", "c-title"],
    ["d-price", "c-price"],
    ["d-desc", "c-desc"],
  ]) {
    assert.equal(pairFor(m, d)?.code.id, c, `${d} 必须配到 ${c}，不能整排错位一格`);
  }
  assert.equal(
    m.unmatchedCode.some((n) => n.id === "c-badge"),
    true,
    "角标是实现多出的元素，不是列表里多出的一行"
  );
});

// ---------- 2. 大结构体闸门 ----------

test("大结构体闸门：占了半张画布的块不会被套到根容器上", () => {
  const design = root("d-root", 1920, 970, [sn("d-band", { x: 0, y: 0, w: 1920, h: 598 })]);
  const code = root("c-root", 1920, 970, [sn("c-app", { x: 0, y: 0, w: 1920, h: 970 })]);
  const m = matchTrees(design, code);
  // 这一对几何分 0.427：过得了 0.35 候选线，两条边长比（1.0 / 0.62）也都过 0.6，
  // 唯一挡住它的是 BIG_SCORE_MIN。这类配对错一次，整棵子树的偏差全是假的。
  assert.equal(pairFor(m, "d-band"), undefined);
  assert.equal(m.unmatchedDesign.some((n) => n.id === "d-band"), true);
});

test("大结构体闸门只挡低分：尺寸接近时照常配对", () => {
  const design = root("d-root", 1920, 970, [sn("d-band", { x: 0, y: 0, w: 1920, h: 900 })]);
  const code = root("c-root", 1920, 970, [sn("c-app", { x: 0, y: 0, w: 1920, h: 970 })]);
  const m = matchTrees(design, code);
  assert.equal(pairFor(m, "d-band")?.code.id, "c-app");
});

// ---------- 3. 第三方浮层默认豁免 ----------

test("默认豁免：第三方浮层不再算「实现多出的元素」", async () => {
  assert.deepEqual(
    ["BMap_", "el-popper", "el-input__suffix"].map((s) =>
      (spec.exemptions ?? []).some((e) => e.selector === s)
    ),
    [true, true, true]
  );

  const m = matchTrees(
    root("d-root", 400, 300, []),
    root("c-root", 400, 300, [sn("html>body>div.BMap_mask", { x: 0, y: 0, w: 400, h: 300 })])
  );
  const on = compareTrees(m, { spec }).issues.filter((i) => i.property === "extra-element");
  assert.equal(on.length, 1);
  assert.equal(on[0].severity, "info", "命中默认豁免就不该占用户注意力");
  assert.match(on[0].message, /豁免/);

  // 项目显式关掉默认豁免时，同一个元素要恢复成 warning
  const dir = await mkdtemp(path.join(tmpdir(), "dg-spec-"));
  const p = path.join(dir, "design-spec.yaml");
  await writeFile(p, "defaultExemptions: false\n", "utf8");
  const bare = await loadSpec(p);
  assert.equal(bare.exemptions?.length, 0);
  const off = compareTrees(m, { spec: bare }).issues.filter((i) => i.property === "extra-element");
  assert.equal(off[0].severity, "warning");
});

// ---------- 4. 按根因聚类成几个问题 ----------

test("问题聚类：几十条同因结论收成一个问题", () => {
  const qs = buildQuestions(
    Array.from({ length: 40 }, (_, n) => iss({ id: `ISS-${n}`, selector: `div.n${n}` }))
  );
  assert.equal(qs.length, 1, "40 条「页面多出元素」只该问一次");
  assert.equal(qs[0].issueIds.length, 40, "一答要落到它覆盖的全部结论上");
  assert.equal(qs[0].options.length, 3);
});

test("问题聚类：不足 3 条的同因结论不单独占一问", () => {
  const ff = (n: number) =>
    iss({
      id: `ISS-f${n}`,
      category: "typography",
      property: "font-family",
      designValue: "Inter",
      actualValue: "Arial",
    });
  assert.equal(buildQuestions([ff(1), ff(2)]).length, 0, "两条直接看报告更快");
  assert.equal(buildQuestions([ff(1), ff(2), ff(3)]).length, 1);
});

test("问题聚类：行数差最先问，且总数不超过 8", () => {
  const rows = Array.from({ length: 10 }, (_, n) =>
    iss({
      id: `ISS-r${n}`,
      property: "row-count",
      designValue: "5 行",
      actualValue: "14 行",
      designNodeName: `列表${n}`,
    })
  );
  const extra = Array.from({ length: 20 }, (_, n) => iss({ id: `ISS-x${n}`, selector: `div.x${n}` }));
  const qs = buildQuestions([...extra, ...rows]);
  assert.equal(qs.length, 8, "再多用户就开始乱点了");
  assert.match(qs[0].title, /列表行数/, "行数差的答案能改变最多结论，排最前");
  assert.equal(qs.every((q) => q.issueIds.length > 0), true);
});

test("问题聚类：配对未确认单独成一问，且必须带 downgradedFrom", () => {
  const weak = [1, 2, 3].map((n) =>
    iss({
      id: `ISS-w${n}`,
      severity: "info",
      downgradedFrom: "warning",
      suspectPair: true,
      category: "geometry",
      property: "x",
      selector: `div.w${n}`,
    })
  );
  assert.equal(buildQuestions(weak).length, 1);
  assert.equal(buildQuestions(weak)[0].issueIds.length, 3);
  // 豁免、「文本已在页面出现」这类普通 info 不是待确认配对，不该冒出来问
  const plain = weak.map((i) => ({ ...i, downgradedFrom: undefined, suspectPair: undefined }));
  assert.equal(buildQuestions(plain).length, 0);
});

// ---------- 5. 图钉合并与截断 ----------

const pin = (
  key: string,
  [x, y, w, h]: [number, number, number, number],
  ids: string[],
  severity: Severity = "warning"
): Pin => ({
  marker: {
    key,
    selector: key,
    severity,
    cats: ["geometry"],
    count: ids.length,
    x,
    y,
    w,
    h,
    tip: "",
    issueIds: ids,
  },
  issues: ids.map((id) =>
    iss({
      id,
      severity,
      category: "geometry",
      property: "w",
      designValue: "10px",
      actualValue: "12px",
      selector: key,
    })
  ),
});

test("图钉合并：套壳链画在同一个框上，只留最外层一个钉", () => {
  const out = foldPins([
    pin("div.card", [0, 0, 100, 50], ["A"]),
    pin("div.card>div.inner", [0, 0, 100, 50], ["B"]),
    pin("div.card>div.inner>div.body", [0, 0, 100, 50], ["C"], "error"),
  ]);
  assert.equal(out.length, 1, "三个几乎重合的框在图上就是一个框");
  assert.equal(out[0].key, "div.card");
  assert.equal(out[0].count, 3);
  assert.deepEqual([...out[0].issueIds].sort(), ["A", "B", "C"], "结论 id 要一路带到祖先");
  assert.equal(out[0].severity, "error", "后代里有 error，合并后的钉也是 error");
  assert.match(out[0].tip, /宽度不一致/, "悬停摘要在合并完成后才生成");
});

test("图钉合并：框差得多就不是同一个框，各留一个钉", () => {
  const out = foldPins([
    pin("div.card", [0, 0, 100, 100], ["A"]),
    pin("div.card>div.inner", [0, 0, 100, 80], ["B"]), // IoU 0.8，低于 0.9
  ]);
  assert.equal(out.length, 2);
});

test("图钉合并不丢结论 id", () => {
  const out = foldPins([
    pin("div.a", [0, 0, 50, 50], ["1", "2"]),
    pin("div.a>div.b", [0, 0, 50, 50], ["3"]),
    pin("div.c", [200, 0, 50, 50], ["4"]),
  ]);
  assert.deepEqual(out.flatMap((mk) => mk.issueIds).sort(), ["1", "2", "3", "4"]);
});

test("图钉截断：超出上限时先留 error", () => {
  const out = foldPins(
    Array.from({ length: 150 }, (_, n) =>
      pin(`div.p${n}`, [n, n, 10, 10], [`ISS-${n}`], n % 30 === 0 ? "error" : "warning")
    )
  );
  assert.equal(out.length, MAX_MARKERS, "494 个钉铺在一张图上，图本身就看不见了");
  assert.equal(out.slice(0, 5).every((mk) => mk.severity === "error"), true);
  assert.equal(out.filter((mk) => mk.severity === "error").length, 5, "截掉的只能是 warning");
});
