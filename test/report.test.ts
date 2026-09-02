// 报告渲染：验证配对可信度确实出现在人眼看到的那一层（只在 JSON 里等于没说）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeReport } from "../src/report/html.js";
import type { Issue, Marker, VerifyResult } from "../src/types.js";

const issue = (over: Partial<Issue>): Issue => ({
  id: "ISS-001",
  severity: "warning",
  category: "color",
  property: "background-color",
  designValue: "#ff0000",
  actualValue: "#00ff00",
  message: "颜色偏差",
  selector: "div.a",
  designNodeName: "主按钮",
  ...over,
});

const result = (issues: Issue[]): VerifyResult => ({
  status: "FAIL",
  score: 60,
  summary: {
    total: issues.length,
    errors: 0,
    warnings: issues.length,
    info: 0,
    matched: 3,
    unmatchedDesign: 0,
    unmatchedCode: 0,
    needsReview: true,
  },
  issues,
  meta: { webUrl: "http://localhost", viewport: "1440x900", timestamp: "2026-01-01", durationMs: 1 },
});

async function render(issues: Issue[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dg-report-"));
  try {
    const { reportPath } = await writeReport(result(issues), dir);
    return await readFile(reportPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("低置信度配对在报告里写明前提，而不是只留在 JSON 里", async () => {
  const html = await render([issue({ suspectPair: true, matchScore: 0.42, matchMethod: "geometry" })]);
  assert.match(html, /配对待确认/);
  assert.match(html, /配对置信度仅 42%/);
  assert.match(html, /主按钮/);
});

test("顺序矛盾在报告里说清两种可能", async () => {
  const html = await render([issue({ orderConflict: "副标题" })]);
  assert.match(html, /前后顺序和设计稿相反/);
  assert.match(html, /副标题/);
});

test("配对可靠时不出现多余提示", async () => {
  const html = await render([issue({ matchScore: 1, matchMethod: "text" })]);
  assert.equal(/配对待确认/.test(html), false);
});

// ---- 单屏标注版报告：编号、框色、单舞台 ----

const marker = (key: string, x: number, y: number, over: Partial<Marker> = {}): Marker => ({
  key,
  selector: key,
  severity: "warning",
  cats: ["color"],
  count: 1,
  x,
  y,
  w: 100,
  h: 30,
  tip: key,
  issueIds: ["ISS-001"],
  ...over,
});

/** 带图钉的报告（原 render 的 fixture 没有 markers，走的是"图上无标注"那条路） */
async function renderStage(issues: Issue[], markers: Marker[], meta: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dg-stage-"));
  const r = result(issues);
  r.meta = { ...r.meta, markers, cssW: 1000, cssH: 800, actualScreenshotPath: "/tmp/actual.png", ...meta };
  try {
    const { reportPath } = await writeReport(r, dir);
    return await readFile(reportPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 按文档顺序取出 [data-n, data-key]；类名要整词匹配，否则 item-head 之类会混进来 */
const seq = (html: string, cls: string): [string, string][] =>
  [...html.matchAll(new RegExp(`<div class="${cls}(?:"| [^"]*")[^>]*>`, "g"))].map((m) => [
    /data-n="([^"]*)"/.exec(m[0])![1],
    /data-key="([^"]*)"/.exec(m[0])![1],
  ]);

test("角标从 1 开始、按阅读顺序编号，与输入顺序无关", async () => {
  const issues = [
    issue({ id: "a", selector: "div.a" }),
    issue({ id: "b", selector: "div.b" }),
    issue({ id: "c", selector: "div.c" }),
  ];
  // 故意乱序喂：a 在同一行的右边、b 在左边、c 在下一行
  const html = await renderStage(issues, [
    marker("div.c", 10, 200),
    marker("div.a", 300, 40),
    marker("div.b", 100, 44),
  ]);
  assert.deepEqual(seq(html, "anno"), [
    ["1", "div.b"],
    ["2", "div.a"],
    ["3", "div.c"],
  ]);
  // 右侧列表必须同序 —— 「图上第 N 个」就是「右侧第 N 张」是这套编号的全部意义
  assert.deepEqual(seq(html, "item"), seq(html, "anno"));
});

test("框色只按严重度，标注标签里不写死任何颜色", async () => {
  const html = await renderStage(
    // 用字号类问题，避免 designValue 本身就是色值把下面的断言弄脏
    [
      issue({
        selector: "div.a",
        severity: "error",
        category: "typography",
        property: "font-size",
        designValue: "16px",
        actualValue: "14px",
      }),
    ],
    [marker("div.a", 10, 10, { severity: "error", cats: ["typography"] })]
  );
  const tag = /<div class="anno[^>]*>/.exec(html)![0];
  assert.match(tag, /data-sev="error"/);
  assert.equal(/#[0-9a-f]{3,8}/i.test(tag), false, `标注不该带内联色值：${tag}`);
  // 严重度→颜色的映射只在样式表里出现一次
  assert.match(html, /\.anno\[data-sev="error"\][^}]*#dc2626/);
  assert.match(html, /\.anno\[data-sev="warning"\][^}]*#d97706/);
});

test("每个元素带上「这一类问题的严重度」，供筛选时重算框色", async () => {
  const html = await renderStage(
    [
      issue({ id: "g", selector: "div.a", severity: "error", category: "geometry", property: "x" }),
      issue({ id: "c", selector: "div.a", severity: "warning", category: "color" }),
    ],
    [marker("div.a", 10, 10, { severity: "error", cats: ["geometry", "color"] })]
  );
  const tag = /<div class="anno[^>]*>/.exec(html)![0];
  assert.match(tag, /data-sev-all="error"/, "不筛选时取组内最高严重度");
  assert.match(tag, /&quot;geometry&quot;:&quot;error&quot;/);
  assert.match(tag, /&quot;color&quot;:&quot;warning&quot;/, "颜色问题只是警告，切到颜色视图不该顶红框");
});

test("三个类别共用一个舞台，不再每类一屏", async () => {
  const html = await renderStage(
    [
      issue({ id: "a", selector: "div.a", category: "geometry", property: "x" }),
      issue({ id: "b", selector: "div.b", category: "color" }),
      issue({ id: "c", selector: "div.c", category: "radius", property: "border-radius" }),
    ],
    [marker("div.a", 10, 10), marker("div.b", 10, 60), marker("div.c", 10, 120)]
  );
  assert.equal(html.match(/class="stage"/g)!.length, 1);
  assert.equal(html.match(/<img class="layer"/g)!.length, 1);
  // 筛选器把每个类别都列出来
  for (const t of ["位置与尺寸", "颜色", "圆角"]) assert.match(html, new RegExp(`data-cat="[a-z]+"[^>]*>[^<]*<i[^>]*></i>${t}`));
});

test("实现里找不到的元素只进列表，不占编号", async () => {
  const html = await renderStage(
    [issue({ id: "a", selector: "div.a" }), issue({ id: "x", selector: undefined, designNodeId: "1:9" })],
    [marker("div.a", 10, 10)]
  );
  assert.match(html, /图上无标注 · 1 处/);
  assert.deepEqual(seq(html, "anno"), [["1", "div.a"]]);
  assert.deepEqual(seq(html, "item"), [
    ["1", "div.a"],
    ["", "__design_1:9"],
  ]);
});

test("只出浅色：深色底不再出现在报告里", async () => {
  const html = await renderStage([issue({ selector: "div.a" })], [marker("div.a", 10, 10)]);
  // 旧版深色主题的页面底 / 面板底 / 卡片底
  for (const dark of ["#0b1020", "#111827", "#0f172a", "#1e293b", "#374151"]) {
    assert.equal(html.includes(dark), false, `残留深色底 ${dark}`);
  }
  assert.match(html, /body \{[^}]*background:#f1f5f9/, "页面底必须是浅灰");
  assert.match(html, /\.canvas-wrap \{[^}]*background:#fff/, "舞台面板底必须是白");
});

test("越出截图的元素（top 负值的徽章）裁进画布，而不是整框下移", async () => {
  // 徽章 y=-10、高 25 → 画布内只剩 0..15
  const html = await renderStage([issue({ selector: "div.badge" })], [marker("div.badge", 252, -10, { w: 68, h: 25 })]);
  const tag = /<div class="anno[^>]*>/.exec(html)![0];
  assert.match(tag, /top:0\.000%/);
  assert.match(tag, /height:1\.875%/, "15/800=1.875%，不是 25/800");
  // 右侧越界同理：252+68=320 > 1000 时不裁，这里 x 没越界所以宽度原样
  assert.match(tag, /left:25\.200%;/);
  assert.match(tag, /width:6\.800%/);
});

const withDesign = { designScreenshotPath: "/tmp/design.png" };

// ---- 叠加层比例：画布不等宽时不许把设计稿拉满 ----

test("设计稿比实现宽时，叠加层按真实比例放大而不是拉满", async () => {
  const html = await renderStage([issue({ selector: "div.a" })], [marker("div.a", 10, 10)], {
    ...withDesign,
    designW: 1032,
    designH: 800,
  });
  // 1032/1000 = 103.2%：设计稿的 32px 多余宽度必须看得见，不能被压回 1000
  assert.match(html, /class="design-layer"><img[^>]*style="width:103\.200%"/);
  assert.match(html, /画布尺寸不同：设计 1032×800 · 实现 1000×800/);
});

test("画布尺寸一致时不写多余的行内宽度、也不提示", async () => {
  const html = await renderStage([issue({ selector: "div.a" })], [marker("div.a", 10, 10)], {
    ...withDesign,
    designW: 1000,
    designH: 800,
  });
  assert.equal(/class="design-layer"><img[^>]*style=/.test(html), false);
  assert.equal(/画布尺寸不同/.test(html), false);
});
