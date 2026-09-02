// 纯净修复代码块生成：无废话，可直接粘贴给 AI 执行。
import type { Issue } from "../types.js";
import { trimNums } from "../diff/describe.js";

/** 一条待修复声明。prop 用于同属性去重，token 版优先（token 名同时满足数值与规范两条）。 */
interface Decl {
  prop: string;
  line: string;
  fromToken: boolean;
}

/** 裸数字补上 px：Figma 的圆角等字段是纯数值，直接写进 CSS 是无效声明 */
function withPx(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
}

/**
 * 圆角的四角值 → CSS。Figma 的 rectangleCornerRadii 是
 * [左上, 右上, 右下, 左下]，跟 CSS `border-radius` 简写同序，可以直接铺开。
 * 以前只取第一个角，`8/8/0/0` 会被写成 `border-radius: 8px`，把下面两个角改错。
 */
function radiusCss(v: string): string {
  const parts = v.split("/");
  if (parts.length !== 4) return withPx(parts[0]);
  return parts.every((p) => p === parts[0]) ? withPx(parts[0]) : parts.map(withPx).join(" ");
}

/** 从 issue 提取 CSS 属性修复行 */
function extractTargetValue(i: Issue): Decl | null {
  // 走一遍 trimNums：Figma 的 9.140000343322754 直接写进 CSS 没人想要，
  // 收到 2 位小数是精度归一，渲染结果一致（不带 property，所以不会译成文案，CSS 仍然合法）。
  const v = trimNums(i.designValue.trim());
  const now = trimNums(i.actualValue, i.property);
  // 键名必须与 compare.ts 实际写入的 property 一致：尺寸是 w/h，不是 width/height
  const cssPropMap: Record<string, string> = {
    w: "width",
    h: "height",
    x: "margin-left",
    y: "margin-top",
    gap: "gap",
    "padding-top": "padding-top",
    "padding-right": "padding-right",
    "padding-bottom": "padding-bottom",
    "padding-left": "padding-left",
    "background-color": "background-color",
    color: "color",
    "border-color": "border-color",
    "font-size": "font-size",
    "font-weight": "font-weight",
    "font-family": "font-family",
    "line-height": "line-height",
    "letter-spacing": "letter-spacing",
    "border-radius": "border-radius",
    "border-width": "border-width",
  };
  const prop = cssPropMap[i.property];
  if (!prop) return null;

  // token 类问题的目标值不是设计稿数值，而是消息里给出的那个 token 名。
  // 不提取的话这类问题在修复清单里会整条消失（只剩一个空的 CSS 块）。
  if (i.category === "token") {
    const m = i.message.match(/var\(--[\w-]+\)/);
    if (!m) return null;
    return { prop, line: `  ${prop}: ${m[0]}; /* 现:${now} 为硬编码 */`, fromToken: true };
  }

  if (v === "—" || v === "(token 表内)") return null;
  const value = prop === "border-radius" ? radiusCss(v) : v;
  // x/y 的数值是「相对父级或前一个元素」的局部偏移（不是绝对坐标），
  // 用 margin 表达只是最常见的一种实现方式，flex/居中布局要换成对应写法。
  const note =
    prop === "margin-left" || prop === "margin-top"
      ? ` /* 相对偏移量；若用 flex/居中布局请改对应属性，现:${now} */`
      : i.delta
        ? ` /* 现:${now} ${trimNums(i.delta)} */`
        : ` /* 现:${now} */`;
  return { prop, line: `  ${prop}: ${value};${note}`, fromToken: false };
}

/** 同一属性只保留一条：token 版覆盖数值版（var(--x) 本身就是设计稿那个色值） */
function dedupe(list: Issue[]): string[] {
  const byProp = new Map<string, Decl>();
  for (const i of list) {
    const d = extractTargetValue(i);
    if (!d) continue;
    const prev = byProp.get(d.prop);
    if (!prev || (d.fromToken && !prev.fromToken)) byProp.set(d.prop, d);
  }
  return [...byProp.values()].map((d) => d.line);
}

/**
 * 注释文本消毒：CSS 注释靠 `*` 紧跟 `/` 闭合，图层名里带这两个字符就能提前把块关掉，
 * 后面的行全部漏成待解析的 CSS。顺带去掉引号（存在性问题的值本身带引号）。
 */
function safeComment(s: string): string {
  return s.replace(/\*\//g, "* /").replace(/"/g, "");
}

/** 生成修复清单：按元素聚合的 CSS 形式代码块 */
export function buildFixesText(issues: Issue[], title = "design-gate 修复清单"): string {
  const fixable = issues.filter((i) => i.selector && i.category !== "existence");

  const bySelector = new Map<string, Issue[]>();
  for (const i of fixable) {
    const arr = bySelector.get(i.selector!) ?? [];
    arr.push(i);
    bySelector.set(i.selector!, arr);
  }

  // 先算出每个元素真正要改的声明，再决定要不要给它留一个代码块。
  // 空的 `selector { }` 会让人以为「这里要改点什么但工具没说」，比不写更糟。
  const blocks: [string, string[]][] = [];
  for (const [sel, list] of bySelector) {
    const decls = dedupe(list);
    if (decls.length) blocks.push([sel, decls]);
  }

  const missing = issues.filter((i) => i.category === "existence" && i.property === "element");
  const extra = issues.filter((i) => i.category === "existence" && i.property === "extra-element");

  const lines: string[] = [];

  /**
   * 增删清单的注释块：整块只开一次 `/*`，末尾闭合一次。
   *
   * CSS 不支持嵌套注释 —— 块内每一行都不能再出现 `/*`，否则 header 会和第一条被吃成
   * 同一个注释，末尾那个闭合符号变成裸 token，整段解析失败。改用 JSDoc 式的续行，
   * 增、删两个分支走同一个 helper（原先只有「缺失」分支 push 了闭合，两边不对称）。
   */
  const listBlock = (heading: string, items: string[]): void => {
    lines.push(`\n/* ---- ${heading} ----`);
    for (const it of items) lines.push(` *   ${safeComment(it)}`);
    lines.push(` */`);
  };

  if (!blocks.length) {
    if (!missing.length && !extra.length) {
      return `/* ${title}: 该分类无需修改 CSS（或仅有元素增删类问题） */`;
    }
    lines.push(`/* ===== ${title} · 无需改 CSS，见下方增删项 ===== */`);
  } else {
    const covered = blocks.reduce((n, [, d]) => n + d.length, 0);
    lines.push(`/* ===== ${title} · 共 ${blocks.length} 个元素 / ${covered} 条可直接改的声明 ===== */`);
    let n = 0;
    for (const [sel, decls] of blocks) {
      n++;
      lines.push(`\n/* ${n}. ${sel.split(" > ").slice(-2).join(" > ")} */`);
      lines.push(`${sel} {`);
      lines.push(...decls);
      lines.push(`}`);
    }
  }

  if (missing.length) {
    listBlock(
      "设计有但实现缺失（需补充）",
      missing.map((i) => `缺少: ${i.designValue}`)
    );
  }
  if (extra.length) {
    listBlock(
      "实现多出（与设计稿核对是否删除）",
      extra.map((i) => `多余: ${i.actualValue} @ ${i.selector}`)
    );
  }
  return lines.join("\n");
}
