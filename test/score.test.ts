// 评分与门禁：这个文件测的是公式本身，不走 compareTrees。
// 旧公式 `100 − errors×10 − warnings×2` 从第 10 个 error 起恒为 0 —— 真实页面
// 从 56 条修到 12 条，分数一动不动。下面每条用例都是在钉住「修了就能看出来」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueElementKey, scoreAndStatus } from "../src/rules/score.js";
import { recalcSummary } from "../src/report/html.js";
import type { Issue, VerifyResult } from "../src/types.js";

const issue = (over: Partial<Issue>): Issue => ({
  id: "ISS-001",
  severity: "error",
  category: "geometry",
  property: "x",
  designValue: "100",
  actualValue: "120",
  message: "位置偏差",
  selector: "div.a",
  designNodeName: "节点",
  ...over,
});

/** 造 n 个各自独立元素上的问题（selector 各不相同） */
const spread = (n: number, over: Partial<Issue> = {}): Issue[] =>
  Array.from({ length: n }, (_, k) => issue({ id: `ISS-${k}`, selector: `div.n${k}`, ...over }));

/** 分母：matched + 两侧未匹配 */
const counts = (matched: number, needsReview = false) => ({
  matched,
  unmatchedDesign: 0,
  unmatchedCode: 0,
  needsReview,
});

test("修掉问题分数必须上升（旧公式在这一段是平的）", () => {
  const all = spread(20);
  const scores = [20, 12, 6, 2, 0].map((left) => scoreAndStatus(all.slice(0, left), counts(40)).score);
  for (let k = 1; k < scores.length; k++) {
    assert.ok(scores[k] > scores[k - 1], `修到剩 ${[20, 12, 6, 2, 0][k]} 条时分数应更高，实际序列: ${scores.join(" → ")}`);
  }
  assert.equal(scores.at(-1), 100, "全部修完应满分");
});

test("20 个 error 不再被压成 0", () => {
  const { score } = scoreAndStatus(spread(20), counts(40));
  assert.equal(score, 50, "20/40 个元素有 error → 一半干净");
});

test("同一元素上叠多少条结论都只算一次（查得细 ≠ 问题更严重）", () => {
  const one = scoreAndStatus([issue({})], counts(10));
  const five = scoreAndStatus(
    [
      issue({ id: "a", property: "x" }),
      issue({ id: "b", property: "y" }),
      issue({ id: "c", property: "w", severity: "warning" }),
      issue({ id: "d", category: "color", property: "color", severity: "warning" }),
      issue({ id: "e", category: "grid", property: "gap", severity: "warning" }),
    ],
    counts(10)
  );
  assert.equal(five.score, one.score, "同一个 selector 上的 5 条与 1 条扣分相同");
  assert.equal(five.errors, 2, "条数统计照实：5 条里 2 条是 error");
  assert.equal(five.warnings, 3);
});

test("同一元素混合严重度时按最高的算", () => {
  const key = "div.same";
  const mixed = scoreAndStatus(
    [issue({ id: "w", severity: "warning", selector: key }), issue({ id: "e", severity: "error", selector: key })],
    counts(10)
  );
  const onlyError = scoreAndStatus([issue({ selector: key })], counts(10));
  assert.equal(mixed.score, onlyError.score);
});

test("info 不计分：豁免与人工裁决通过的不该继续压分", () => {
  const { score, status, info } = scoreAndStatus(spread(5, { severity: "info" }), counts(10));
  assert.equal(score, 100);
  assert.equal(status, "PASS");
  assert.equal(info, 5);
});

test("门禁：警告预算按元素算，不按条数算", () => {
  // 6 条警告但只落在 2 个元素上 —— 按旧的「警告条数 > 3」会误判 FAIL
  const twoElements = [
    ...Array.from({ length: 3 }, (_, k) => issue({ id: `a${k}`, severity: "warning", selector: "div.a", property: `p${k}` })),
    ...Array.from({ length: 3 }, (_, k) => issue({ id: `b${k}`, severity: "warning", selector: "div.b", property: `p${k}` })),
  ];
  assert.notEqual(scoreAndStatus(twoElements, counts(10)).status, "FAIL", "2 个元素有警告，在预算内");

  // 4 个元素各一条警告 → 超出预算（上限 3）
  assert.equal(scoreAndStatus(spread(4, { severity: "warning" }), counts(10)).status, "FAIL");
  assert.notEqual(scoreAndStatus(spread(3, { severity: "warning" }), counts(10)).status, "FAIL");
});

test("门禁：有 error 一律 FAIL；needsReview 只在没有 error 时改变结论", () => {
  assert.equal(scoreAndStatus([issue({})], counts(10)).status, "FAIL");
  assert.equal(scoreAndStatus([issue({})], counts(10, true)).status, "FAIL", "error 优先于 needsReview");
  assert.equal(scoreAndStatus(spread(1, { severity: "warning" }), counts(10, true)).status, "NEEDS_REVIEW");
  assert.equal(scoreAndStatus([], counts(10, true)).status, "PASS", "没有问题就没什么可复核的");
});

test("没有 selector 的问题（设计有、实现无）按设计节点各算一个元素", () => {
  const missing = [
    issue({ id: "m1", severity: "error", category: "existence", selector: undefined, designNodeId: "1:10" }),
    issue({ id: "m2", severity: "error", category: "existence", selector: undefined, designNodeId: "1:11" }),
  ];
  assert.equal(issueElementKey(missing[0]), "__design_1:10");
  assert.notEqual(issueElementKey(missing[0]), issueElementKey(missing[1]), "两个缺失元素不能被并成一个");
  assert.equal(scoreAndStatus(missing, counts(8)).score, 75, "8 个单位里 2 个不干净");
});

test("recalcSummary 与 engine 走同一个公式，裁决后不会出现两个分数", () => {
  const issues = [
    issue({ id: "e1" }),
    issue({ id: "w1", severity: "warning", selector: "div.b" }),
    issue({ id: "i1", severity: "info", selector: "div.c" }),
  ];
  const result: VerifyResult = {
    status: "PASS",
    score: 999,
    summary: {
      total: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      matched: 6,
      unmatchedDesign: 1,
      unmatchedCode: 1,
      needsReview: false,
    },
    issues,
    meta: { webUrl: "http://localhost", viewport: "1440x900", timestamp: "2026-01-01", durationMs: 1 },
  };
  recalcSummary(result);

  const direct = scoreAndStatus(issues, counts(6));
  const expected = scoreAndStatus(issues, { matched: 6, unmatchedDesign: 1, unmatchedCode: 1, needsReview: false });
  assert.equal(result.score, expected.score);
  assert.equal(result.status, expected.status);
  assert.equal(result.summary.errors, expected.errors);
  assert.equal(result.summary.warnings, expected.warnings);
  assert.equal(result.summary.info, expected.info);
  assert.equal(result.summary.total, 3, "total 是条数，含 info");
  assert.notEqual(result.score, direct.score, "分母含两侧未匹配，recalc 必须用 summary 里的口径");
});
