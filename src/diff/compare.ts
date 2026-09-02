import { deltaE2000, formatColor, parseColor, toHex6 } from "./color.js";
import { GAP_REPORT_MIN, relativeGeometry, type AxisRel, type RelGeo } from "./geometry.js";
import type {
  Exemption,
  Issue,
  IssueCategory,
  MatchPair,
  MatchResult,
  Severity,
  StyleNode,
} from "../types.js";
import type { ResolvedSpec } from "../rules/spec.js";
import { bandSeverity, onGrid } from "../rules/spec.js";

const fmt = (v: number | undefined): string =>
  v === undefined ? "—" : `${Math.round(v * 10) / 10}px`;

/**
 * 几何配对的置信度下限。低于此值时，「实现错了」与「我们比错了元素」无法区分，
 * 这种前提下把结论定成 error 等于把匹配算法的失败算到前端头上。
 */
const LOW_CONFIDENCE = 0.55;
/**
 * 更低的一档：配对本身就还没确认，任何属性差异都读不出「实现对不对」。
 * 这一档不计分、只作为「请先确认这是同一个元素」的待确认项出现 ——
 * X501 那轮 206 对低于 0.5 的配对，逐条按 warning 报出来是 400 多条纯噪声。
 */
const WEAK_CONFIDENCE = 0.4;

export interface CompareOptions {
  spec: ResolvedSpec;
}

/** 当前配对的可信度上下文：push 用它给每条结论标注依据强度 */
interface PairContext {
  score: number;
  method: MatchPair["method"];
  suspect: boolean;
  /** 置信度低于 WEAK_CONFIDENCE：结论只能是「先确认配对」，不参与计分 */
  weak: boolean;
  orderConflict?: string;
}

/**
 * 确定性比对：匹配对逐属性 diff + 未匹配元素存在性检查。
 * 全部为固定代码测量，零 AI 参与。
 */
export function compareTrees(match: MatchResult, opts: CompareOptions): { issues: Issue[]; needsReview: boolean } {
  const issues: Issue[] = [];
  let needsReview = false;
  const { spec } = opts;
  let seq = 0;
  let ctx: PairContext | null = null;
  /**
   * 已出过结论的「设计节点 + 属性」。栅格检查据此让路：同一个数值不说两遍。
   * 键用设计节点 id 而非 selector —— 存在性问题的 selector 可能为空。
   */
  const reportedProps = new Set<string>();

  const push = (
    severity: Severity | null,
    category: IssueCategory,
    property: string,
    designValue: string,
    actualValue: string,
    d: StyleNode,
    c: StyleNode | undefined,
    delta: string | undefined,
    message?: string
  ) => {
    if (!severity) return;
    const exempt = findExemption(spec.exemptions ?? [], c?.id, d.name, property);
    // 只记「因为不确定配对而压低」的那种降级：确认配对无误后要还原并重新计分。
    // 豁免不记 —— 那是「这条本就不该计分」，没有可还原的原状。
    let downgradedFrom: Severity | undefined;
    if (exempt) severity = "info";
    // 配对都还没确认，属性差异读不出「实现对不对」→ 不计分，只作为待确认项
    else if (ctx?.weak) {
      downgradedFrom = severity;
      severity = "info";
    }
    // 依据不可靠时不出 error：先确认配对，再谈实现对不对
    else if (ctx?.suspect && severity === "error") {
      downgradedFrom = severity;
      severity = "warning";
    }
    const id = `ISS-${String(++seq).padStart(3, "0")}`;
    const suffix = exempt ? `（豁免: ${exempt.reason}）` : "";
    issues.push({
      id,
      severity,
      category,
      property,
      designValue,
      actualValue,
      delta,
      selector: c?.id,
      designNodeId: d.id,
      designNodeName: d.name,
      message: (message ?? defaultMessage(category)) + suffix,
      matchScore: ctx?.score,
      matchMethod: ctx?.method,
      suspectPair: ctx?.suspect || ctx?.weak || undefined,
      downgradedFrom,
      orderConflict: ctx?.orderConflict,
    });
    reportedProps.add(`${d.id}|${property}`);
    if (!exempt && (ctx?.suspect || ctx?.orderConflict)) needsReview = true;
  };

  // 位置关系预计算：一次遍历得出「相对父级/前序兄弟」的局部关系，
  // 供下面逐节点比对使用（绝对坐标只用于尺寸和存在性）。
  const rel = relativeGeometry(match);

  for (const pair of match.pairs) {
    const g = rel.get(pair.design);
    ctx = {
      score: pair.score,
      method: pair.method,
      suspect: pair.method === "geometry" && pair.score < LOW_CONFIDENCE,
      weak: pair.method === "geometry" && pair.score < WEAK_CONFIDENCE,
      orderConflict: g?.orderConflict,
    };
    compareNode(pair.design, pair.code);
  }
  ctx = null; // 存在性问题不来自任何配对

  // 存在性检查：设计有代码无（error，仅叶子/文本节点），代码多出（warning，仅无匹配后代的节点）
  //
  // 文本存在性用「页面上有没有这段文字」判定，而不是「有没有 1:1 的节点」：
  // 占位符、::before 星号、被合并到父元素的文本，都会让匹配落空但文字确实在页面上。
  // 这类情况报 error 会让门禁永远无法变绿，且 AI 改 CSS 也修不掉。
  const codeTexts: string[] = [];
  const addCodeText = (s?: string) => {
    if (s) codeTexts.push(s.toLowerCase());
  };
  const indexCodeSubtree = (n: StyleNode): void => {
    addCodeText(n.text);
    addCodeText(n.auxText);
    n.children.forEach(indexCodeSubtree);
  };
  for (const p of match.pairs) {
    addCodeText(p.code.text);
    addCodeText(p.code.auxText);
  }
  for (const c of match.unmatchedCode) indexCodeSubtree(c);

  const textPresentInCode = (raw: string): boolean => {
    const t = raw.toLowerCase().trim();
    if (!t) return false;
    for (const c of codeTexts) {
      if (c === t) return true;
      if (t.length >= 2 && (c.includes(t) || t.includes(c))) return true;
    }
    return false;
  };

  for (const d of match.unmatchedDesign) {
    const isLeaf = d.children.length === 0;
    if (!isLeaf && !d.text) continue;
    if (d.text && textPresentInCode(d.text)) {
      push(
        "info",
        "existence",
        "element",
        describe(d),
        "文本已在页面中出现",
        d,
        undefined,
        undefined,
        "设计文本在页面上存在，但未与该设计节点一一对应（多因占位符/伪元素/文本被合并到父元素），通常不是缺陷"
      );
      continue;
    }
    // 图标/图片的结构对应天然宽松（可能实现为 CSS 背景或图标字体，不产生独立盒子），
    // 未匹配只降级为 warning，避免把粒度差异当成缺失。
    const sev: Severity = d.kind === "icon" || d.kind === "image" ? "warning" : "error";
    push(sev, "existence", "element", describe(d), "缺失", d, undefined, undefined, "设计中存在但未找到对应实现");
  }
  const matchedCodeIds = new Set(match.pairs.map((p) => p.code.id));
  const hasMatchedDescendant = (n: StyleNode): boolean => {
    if (matchedCodeIds.has(n.id)) return true;
    return n.children.some(hasMatchedDescendant);
  };
  for (const c of match.unmatchedCode) {
    if (hasMatchedDescendant(c)) continue; // 子树里有匹配的就只报更精确的层级
    push(
      "warning",
      "existence",
      "extra-element",
      "—",
      describe(c),
      placeholderDesign(c),
      c,
      undefined,
      "实现中存在但设计稿中未定义的元素"
    );
  }

  // 重复列表的行数差：一个根因一条结论。
  // 逐行报会同时产出 N 条「设计有码无」+ M 条「码有设计无」，还会把多出的行喂给
  // 几何匹配去乱配，二次制造假偏差。这里收成一条待裁决项。
  for (const s of match.surplus ?? []) {
    const diff = Math.abs(s.codeRows - s.designRows);
    const msg =
      s.side === "code"
        ? `列表「${s.codeParent.name}」实现渲染 ${s.codeRows} 行、设计稿画了 ${s.designRows} 行。设计稿常只画示意行、真实数据更多 —— 若是这种情况判「可接受」；若确实多渲染了不该有的行则判「确认」。多出的 ${diff} 行样例：${s.sample}`
        : `列表「${s.codeParent.name}」设计稿画了 ${s.designRows} 行、实现只渲染 ${s.codeRows} 行。可能是数据没到位，也可能是设计稿的示意行本就不需要全部实现。缺的 ${diff} 行样例：${s.sample}`;
    push(
      "warning",
      "existence",
      "row-count",
      `${s.designRows} 行`,
      `${s.codeRows} 行`,
      s.designParent,
      s.codeParent,
      `Δ${diff} 行`,
      msg
    );
  }

  return { issues, needsReview };

  // ---------- 单节点属性比对 ----------
  function compareNode(d: StyleNode, c: StyleNode): void {
    // 几何
    const tolGeo = spec.tolerances.geometry!;
    const g = rel.get(d);
    const dw = Math.abs(c.rect.w - d.rect.w);
    const dh = Math.abs(c.rect.h - d.rect.h);

    // 纯文本节点跳过宽高比对：Figma 文本框紧贴内容，DOM 块级元素自动撑满容器，
    // 宽高天然不可比（字体属性与位置才是有效信号）。
    const pureTextBox =
      !!d.text &&
      !!c.text &&
      !d.style.backgroundColor &&
      !c.style.backgroundColor &&
      !d.style.borderWidth &&
      !c.style.borderWidth;

    // 位置用局部关系（相对父级内偏移 / 与前序兄弟的间隔），不用绝对坐标：
    // 绝对坐标会让父级的一处偏移在每个后代身上重复上报。
    // 尺寸差若能被父级的尺寸差完全解释（两端内边距都对），同样只报父级那一处。
    const dims: [string, number][] = [
      ["x", g ? Math.abs(g.x.delta) : 0],
      ["y", g ? Math.abs(g.y.delta) : 0],
      ...(!pureTextBox
        ? ([
            ["w", g?.stretchW ? 0 : dw],
            ["h", g?.stretchH ? 0 : dh],
          ] as [string, number][])
        : []),
    ];
    const geoMax = Math.max(...dims.map(([, v]) => v));
    if (geoMax >= tolGeo.warn) {
      const sev = bandSeverity(geoMax, tolGeo);
      const [prop] = dims.find(([, v]) => v === geoMax)!;
      if (prop === "x" || prop === "y") {
        const axis = prop === "x" ? g!.x : g!.y;
        push(
          sev,
          "geometry",
          prop,
          fmt(axis.design),
          fmt(axis.actual),
          d,
          c,
          `Δ${round1(axis.delta)}px`,
          relMessage(prop, axis)
        );
      } else {
        push(
          sev,
          "geometry",
          prop,
          fmt(prop === "w" ? d.rect.w : d.rect.h),
          fmt(prop === "w" ? c.rect.w : c.rect.h),
          d,
          c,
          `Δ${round1(prop === "w" ? dw : dh)}px`
        );
      }
    }
    // 子元素整体同向偏移 → 根因在本容器，只报一次
    checkInset(d, c, g, tolGeo);

    // 颜色（两侧统一成 hex 再入报告：DOM 侧的 rgb() 与设计侧的 #xxxxxx 并排，人眼比不出来）
    const tolColor = spec.tolerances.colorDeltaE!;
    const bgDe = deltaE2000(d.style.backgroundColor, c.style.backgroundColor);
    if (bgDe !== null && bgDe >= tolColor.warn && d.style.backgroundColor && c.style.backgroundColor) {
      push(sevOf(bgDe, tolColor), "color", "background-color", formatColor(d.style.backgroundColor), formatColor(c.style.backgroundColor), d, c, `ΔE ${round2(bgDe)}`);
    }
    const txDe = deltaE2000(d.style.textColor, c.style.textColor);
    if (txDe !== null && txDe >= tolColor.warn && d.style.textColor && c.style.textColor && (d.text || d.style.fontSize !== undefined)) {
      push(sevOf(txDe, tolColor), "color", "color", formatColor(d.style.textColor), formatColor(c.style.textColor), d, c, `ΔE ${round2(txDe)}`);
    }

    // 字体
    if (d.style.fontSize !== undefined && c.style.fontSize !== undefined) {
      const dfd = Math.abs(d.style.fontSize - c.style.fontSize);
      if (dfd >= 0.6) {
        const sev: Severity = dfd >= 1.5 ? "error" : "warning";
        push(sev, "typography", "font-size", fmt(d.style.fontSize), fmt(c.style.fontSize), d, c, `Δ${round1(dfd)}px`);
      }
    }
    if (d.style.fontWeight !== undefined && c.style.fontWeight !== undefined && d.style.fontWeight !== c.style.fontWeight) {
      const diff = Math.abs(d.style.fontWeight - c.style.fontWeight);
      push(diff > 100 ? "error" : "warning", "typography", "font-weight", String(d.style.fontWeight), String(c.style.fontWeight), d, c, `Δ${diff}`);
    }
    if (d.style.fontFamily && c.style.fontFamily) {
      const a = d.style.fontFamily.toLowerCase();
      const b = c.style.fontFamily.toLowerCase();
      if (!b.includes(a.split(" ")[0]) && !a.includes(b.split(" ")[0])) {
        push("warning", "typography", "font-family", d.style.fontFamily, c.style.fontFamily, d, c, undefined);
      }
    }
    if (d.style.lineHeight !== undefined && c.style.lineHeight !== undefined) {
      const lhd = Math.abs(d.style.lineHeight - c.style.lineHeight);
      if (lhd >= spec.tolerances.lineHeightDelta!) {
        const sev: Severity = lhd >= spec.tolerances.lineHeightDelta! * 2 ? "error" : "warning";
        push(sev, "typography", "line-height", fmt(d.style.lineHeight), fmt(c.style.lineHeight), d, c, `Δ${round1(lhd)}px`);
      }
    }

    // 圆角
    if (d.style.borderRadius && c.style.borderRadius) {
      const maxR = Math.max(...d.style.borderRadius.map((r, i) => Math.abs(r - (c.style.borderRadius![i] ?? r))));
      const tolR = spec.tolerances.radiusDelta!;
      if (maxR >= tolR.warn) {
        push(bandSeverity(maxR, tolR), "radius", "border-radius", d.style.borderRadius.join("/"), c.style.borderRadius.join("/"), d, c, `Δ${round1(maxR)}px`);
      }
    }

    // 边框
    if ((d.style.borderWidth ?? 0) > 0 && c.style.borderWidth !== undefined) {
      const bd = Math.abs((d.style.borderWidth ?? 0) - c.style.borderWidth);
      if (bd >= 0.75) {
        push(bd >= 1.5 ? "error" : "warning", "border", "border-width", fmt(d.style.borderWidth), fmt(c.style.borderWidth), d, c, `Δ${round1(bd)}px`);
      }
      const bcDe = deltaE2000(d.style.borderColor, c.style.borderColor);
      if (bcDe !== null && bcDe >= tolColor.error!) {
        push("warning", "border", "border-color", formatColor(d.style.borderColor), formatColor(c.style.borderColor), d, c, `ΔE ${round2(bcDe)}`);
      }
    }

    // 布局间距（gap 数值对比）
    if (d.layout?.gap !== undefined && c.layout?.gap !== undefined) {
      const gd = Math.abs(d.layout.gap - c.layout.gap);
      if (gd >= GAP_REPORT_MIN) {
        push(gd >= 4 ? "error" : "warning", "geometry", "gap", fmt(d.layout.gap), fmt(c.layout.gap), d, c, `Δ${round1(gd)}px`);
      }
    }

    // 栅格 + token 合规
    checkGrid(d, c);
    checkTokens(d, c);
  }

  function checkInset(
    d: StyleNode,
    c: StyleNode,
    g: RelGeo | undefined,
    tolGeo: { warn: number; error: number }
  ): void {
    const cases: [string, RelGeo["insetX"], string][] = [
      ["padding-left", g?.insetX, "水平"],
      ["padding-top", g?.insetY, "垂直"],
    ];
    for (const [prop, inset, dir] of cases) {
      if (!inset || Math.abs(inset.delta) < tolGeo.warn) continue;
      push(
        bandSeverity(Math.abs(inset.delta), tolGeo),
        "geometry",
        prop,
        fmt(inset.design),
        fmt(inset.actual),
        d,
        c,
        `Δ${round1(inset.delta)}px`,
        `内部 ${inset.count} 个子元素整体${dir}偏移同样的量 —— 根因在本容器的内边距或对齐方式，改这一处即可`
      );
    }
  }

  function checkGrid(d: StyleNode, c: StyleNode): void {
    const grid = spec.grid!;
    const checks: [string, number | undefined, number | undefined][] = [];
    if (spec.gridApply!.includes("gap")) {
      checks.push(["gap", d.layout?.gap, c.layout?.gap]);
    }
    if (spec.gridApply!.includes("padding")) {
      const dp = d.layout?.padding;
      const cp = c.layout?.padding;
      if (dp || cp) {
        const names = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
        names.forEach((name, i) => checks.push([name, dp?.[i], cp?.[i]]));
      }
    }
    for (const [prop, dv, cv] of checks) {
      if (dv === undefined && cv === undefined) continue;
      // 已经报过「gap 应为 12，实际 10」就不再补一句「10 不在 4/8 栅格上」：
      // 改成 12 顺带就落回栅格，两条结论只有一处可改。
      // 设计稿自己不在栅格上（两侧同值）时几何不出结论，这条仍会报 —— 那才是栅格检查的独有价值。
      if (reportedProps.has(`${d.id}|${prop}`)) continue;
      if (cv !== undefined && !onGrid(cv, grid)) {
        push(
          "warning",
          "grid",
          prop,
          dv === undefined ? "—" : fmt(dv),
          fmt(cv),
          d,
          c,
          `不在 ${grid.join("/")} 的倍数上`
        );
      }
    }
  }

  /**
   * token 合规。
   *
   * 注意：这里**故意不查 `reportedProps`**。它发的属性名与上面的颜色比对完全相同
   * （`background-color` / `color` / `border-color`），顺手把栅格那道闸扩过来很自然，
   * 但那会在「色值错了、而且还是硬编码」时吞掉 token 结论 —— 而 token 结论带的
   * `应使用 var(--xxx)` 恰恰是两条里更可执行的那一条。
   * 栅格是「同一个数值的另一种说法」，token 是「另一件事」。
   */
  function checkTokens(d: StyleNode, c: StyleNode): void {
    if (!spec.requireTokens) return;
    const props: ("backgroundColor" | "textColor" | "borderColor")[] = ["backgroundColor", "textColor", "borderColor"];
    for (const p of props) {
      // textColor 只在实际承载文本的节点上检查（容器会继承默认色，属噪声）
      if (p === "textColor" && !c.text) continue;
      const actual = c.style[p];
      if (!actual) continue;
      const parsed = parseColor(actual);
      if (!parsed || parsed.a === 0) continue;
      const hex = toHex6(parsed.r, parsed.g, parsed.b);
      if (spec.tokenValues.has(hex)) continue;

      // 找最接近的 token 给修复建议
      let nearestName = "";
      let nearestDe = Infinity;
      for (const [name, value] of spec.tokens) {
        const de = deltaE2000(value, actual);
        if (de !== null && de < nearestDe) {
          nearestDe = de;
          nearestName = name;
        }
      }
      const suggestion =
        nearestName && nearestDe < 20
          ? `应使用 var(--${nearestName})`
          : "未找到接近的 token，请确认是否新增 token 或修改色值";

      push(
        "error",
        "token",
        p === "backgroundColor" ? "background-color" : p === "textColor" ? "color" : "border-color",
        "(token 表内)",
        hex,
        d,
        c,
        undefined,
        `硬编码色值 ${hex} 不在 tokens 表中（${suggestion}）`
      );
    }
  }

  function sevOf(de: number, band: { warn: number; error: number }): Severity {
    return de >= band.error ? "error" : "warning";
  }
}

/** 位置类问题的说明：明确写出这条偏移是相对谁量出来的，避免被当成绝对坐标去改 */
function relMessage(prop: "x" | "y", axis: AxisRel): string {
  const dir = prop === "x" ? "水平" : "垂直";
  const edge = prop === "x" ? "左" : "上";
  if (axis.base === "sibling") {
    return `${dir}间隔偏差：与前一个元素「${axis.baseName}」之间应留 ${fmt(axis.design)}，实际 ${fmt(axis.actual)}`;
  }
  return `${dir}位置偏差：相对父级「${axis.baseName}」的${edge}偏移应为 ${fmt(axis.design)}，实际 ${fmt(axis.actual)}`;
}

function defaultMessage(category: IssueCategory): string {  switch (category) {
    case "geometry":
      return "几何位置/尺寸偏差";
    case "color":
      return "颜色偏差";
    case "typography":
      return "字体排版偏差";
    case "radius":
      return "圆角偏差";
    case "border":
      return "边框偏差";
    case "grid":
      return "间距不符合栅格规范";
    case "token":
      return "违反设计 Token 规范";
    default:
      return "与设计稿不一致";
  }
}

function findExemption(exemptions: NonNullable<ResolvedSpec["exemptions"]>, selector: string | undefined, nodeName: string, property: string): Exemption | null {
  for (const e of exemptions) {
    if (e.selector && selector && selectorMatches(selector, e.selector)) {
      if (!e.property || e.property === property) return e;
    }
    if (e.designNodeName && e.designNodeName === nodeName) {
      if (!e.property || e.property === property) return e;
    }
  }
  return null;
}

function selectorMatches(selector: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : "\\" + ch)) + "$");
    return re.test(selector);
  }
  return selector === pattern || selector.includes(pattern);
}

function describe(n: StyleNode): string {
  return n.text ? `"${truncate(n.text, 24)}"` : `${n.type} "${truncate(n.name, 24)}"`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 代码多出的元素没有对应设计节点，用占位对象承载定位信息 */
function placeholderDesign(c: StyleNode): StyleNode {
  return {
    id: "",
    name: "(无对应设计节点)",
    type: "",
    rect: c.rect,
    style: {},
    children: [],
  };
}
