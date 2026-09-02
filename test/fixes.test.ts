// 修复清单：粘给 AI 就能执行，所以「不可执行的输出」等于缺陷 —— 空代码块、无单位数值、
// 同属性互相覆盖，三者都会让接收方改错或改不动。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixesText } from "../src/report/fixes.js";
import type { Issue } from "../src/types.js";

const iss = (over: Partial<Issue>): Issue => ({
  id: "ISS-001",
  severity: "error",
  category: "geometry",
  property: "w",
  designValue: "320px",
  actualValue: "310px",
  delta: "Δ10px",
  message: "几何位置/尺寸偏差",
  selector: "div.card",
  ...over,
});

/**
 * CSS 注释结构体检：从左到右扫一遍，报告所有结构问题。
 * 两条性质分开断言 —— 裸闭合决定「还能不能解析」，嵌套开启决定「块边界是不是作者以为的那个」。
 */
function commentProblems(css: string): string[] {
  const bad: string[] = [];
  let open = -1;
  for (let k = 0; k < css.length - 1; k++) {
    const two = css.slice(k, k + 2);
    if (two === "/*") {
      if (open < 0) open = k;
      else bad.push(`第 ${k} 字符处在未闭合的注释（起于 ${open}）内又开了一个 /*`);
      k++;
    } else if (two === "*/") {
      if (open >= 0) open = -1;
      else bad.push(`第 ${k} 字符处出现裸闭合符，前面没有对应的 /*`);
      k++;
    }
  }
  if (open >= 0) bad.push(`起于 ${open} 的注释没有闭合`);
  return bad;
}

test("尺寸偏差写成 width/height，不再落成空代码块", () => {
  const txt = buildFixesText([iss({}), iss({ property: "h", designValue: "96px", actualValue: "58px" })]);
  assert.match(txt, /width: 320px;/);
  assert.match(txt, /height: 96px;/);
  assert.equal(/\{\s*\}/.test(txt), false, "不应出现空的 CSS 块");
});

test("圆角补上 px：裸数字是无效声明", () => {
  const txt = buildFixesText([
    iss({ category: "radius", property: "border-radius", designValue: "8/8/8/8", actualValue: "6/6/6/6" }),
  ]);
  assert.match(txt, /border-radius: 8px;/);
});

test("token 问题给出 var(--x)，而不是被整条丢掉", () => {
  const txt = buildFixesText([
    iss({
      category: "token",
      property: "color",
      designValue: "(token 表内)",
      actualValue: "#9ca3af",
      delta: undefined,
      message: "硬编码色值 #9ca3af 不在 tokens 表中（应使用 var(--text-muted)）",
    }),
  ]);
  assert.match(txt, /color: var\(--text-muted\);/);
});

test("同一属性只留一条，token 版胜出", () => {
  const txt = buildFixesText([
    iss({ category: "color", property: "background-color", designValue: "#2563eb", actualValue: "#2536eb" }),
    iss({
      category: "token",
      property: "background-color",
      designValue: "(token 表内)",
      actualValue: "#2536eb",
      delta: undefined,
      message: "硬编码色值 #2536eb 不在 tokens 表中（应使用 var(--primary)）",
    }),
  ]);
  assert.equal(txt.match(/background-color:/g)?.length, 1);
  assert.match(txt, /background-color: var\(--primary\);/);
});

test("只有增删项时不伪造代码块，但增删清单仍要给出", () => {
  const txt = buildFixesText([
    iss({ category: "existence", property: "element", designValue: '"✓ 优先支持"', actualValue: "缺失", selector: undefined }),
  ]);
  assert.equal(/\{/.test(txt), false, "没有可改的声明就不该出现 CSS 块");
  assert.match(txt, /缺少: ✓ 优先支持/);
});

test("整份清单是合法 CSS：注释不嵌套、不留裸闭合", () => {
  const txt = buildFixesText([
    iss({}),
    iss({ category: "existence", property: "element", designValue: '"✓ 优先支持"', actualValue: "缺失", selector: undefined }),
    iss({ category: "existence", property: "element", designValue: '"图标 a*/b"', actualValue: "缺失", selector: undefined }),
    iss({ category: "existence", property: "extra-element", designValue: "无", actualValue: '"多余徽章"', selector: "span.badge" }),
  ]);
  assert.deepEqual(commentProblems(txt), [], `注释结构非法，粘进 CSS 会丢规则：\n${txt}`);
  // 图层名自带的闭合符必须被打断 —— 它正是「提前把块关掉」的那个元凶
  assert.equal(txt.includes("a*/b"), false, "图层名里的 */ 没有转义");
  assert.match(txt, /a\* \/b/);
  assert.match(txt, /多余: 多余徽章 @ span\.badge/);
});

test("只有增删项、且只有多出项时也要闭合", () => {
  const txt = buildFixesText([
    iss({ category: "existence", property: "extra-element", designValue: "无", actualValue: '"孤儿节点"', selector: "div.orphan" }),
  ]);
  assert.deepEqual(commentProblems(txt), [], txt);
});

test("四角不同的圆角要铺开成四值简写，不能只取第一个角", () => {
  const txt = buildFixesText([
    iss({ category: "radius", property: "border-radius", designValue: "8/8/0/0", actualValue: "8/8/8/8", delta: "Δ8px" }),
  ]);
  // 只写 `border-radius: 8px` 会把下面两个角一起改圆 —— 跟设计稿正好相反
  assert.match(txt, /border-radius: 8px 8px 0px 0px;/);
});

test("圆角的浮点尾巴不进 CSS", () => {
  const txt = buildFixesText([
    iss({
      category: "radius",
      property: "border-radius",
      designValue: "9.140000343322754/9.140000343322754/9.140000343322754/9.140000343322754",
      actualValue: "8/8/8/8",
      delta: "Δ1.1px",
    }),
  ]);
  assert.match(txt, /border-radius: 9\.14px;/);
  assert.equal(/\d\.\d{4,}/.test(txt), false, `修复清单里仍有浮点尾巴：\n${txt}`);
});
