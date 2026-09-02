// 相对几何：把「绝对坐标差」换成「局部关系差」。
//
// 绝对坐标比对有一个结构性缺陷：父容器偏移 87px，它的每个后代都会各报一次同样的
// 87px —— 一个根因被放大成十几条问题，修复者无法判断该改哪一处。
// 这里把位置重新表达为只跟邻居有关的量：
//   · 相对父级（最近的双侧都成立的祖先配对）的内偏移
//   · 与前序兄弟的间隔（同轴上不重叠时才顺延）
// 于是「谁把版面推歪了」只会在真正发生偏移的那一层报一次，后面跟随的元素间隔正确 → 无问题。
import type { MatchPair, MatchResult, StyleNode } from "../types.js";

/** 关系一致性容差（px）：小于此值视为同一条关系 */
const EPS = 0.5;
/** 触发「整体偏移归因到父级」的最少子元素数 */
const INSET_MIN_CHILDREN = 2;
/**
 * 父级 gap 差到多大才出结论（px）。compare.ts 的 gap 检查与本文件的 collapseGap
 * 必须用同一个数：抑制兄弟间隔的前提是父级真的会替它出一条结论，
 * 两处若各写一个字面量就会漂出「兄弟被抑制、父级又没报」的静默盲区。
 */
export const GAP_REPORT_MIN = 1.5;

type Axis = "x" | "y";

/** 单轴上的一条局部关系 */
export interface AxisRel {
  /** 实现 − 设计（带符号）；0 附近表示这条关系是对的 */
  delta: number;
  /** 设计侧关系值 */
  design: number;
  /** 实现侧关系值 */
  actual: number;
  /** 基准来源：父级内偏移 / 与前序兄弟的间隔 / 无（根节点或已归因到父级） */
  base: "parent" | "sibling" | "none";
  /** 基准节点名（报告文案用） */
  baseName: string;
}

/** 一组子元素在某轴上的整体偏移（根因在父容器自身） */
export interface GroupInset {
  delta: number;
  design: number;
  actual: number;
  count: number;
}

export interface RelGeo {
  x: AxisRel;
  y: AxisRel;
  /** 作为父级时：全部子元素在该轴上整体同向偏移 → 归因到自己的内边距/对齐 */
  insetX?: GroupInset;
  insetY?: GroupInset;
  /**
   * 宽/高的差值可由父级的尺寸差完全解释（两端内边距都对得上，典型是 width:100%）。
   * 此时再报一次子元素的尺寸，只是把父级的一处问题重复一遍。
   */
  stretchW?: boolean;
  stretchH?: boolean;
  /**
   * 与该兄弟元素的前后顺序在两侧相反。
   * 这要么是排版顺序真的错了，要么是这两个元素被配错了对 —— 两种都需要人工确认。
   */
  orderConflict?: string;
}

const emptyAxis = (): AxisRel => ({ delta: 0, design: 0, actual: 0, base: "none", baseName: "" });

function parentMap(root: StyleNode): Map<StyleNode, StyleNode> {
  const m = new Map<StyleNode, StyleNode>();
  const walk = (n: StyleNode) => {
    for (const c of n.children) {
      m.set(c, n);
      walk(c);
    }
  };
  walk(root);
  return m;
}

function isAncestor(a: StyleNode, n: StyleNode, parents: Map<StyleNode, StyleNode>): boolean {
  let cur = parents.get(n);
  while (cur) {
    if (cur === a) return true;
    cur = parents.get(cur);
  }
  return false;
}

const start = (n: StyleNode, axis: Axis): number => (axis === "x" ? n.rect.x : n.rect.y);
const size = (n: StyleNode, axis: Axis): number => (axis === "x" ? n.rect.w : n.rect.h);
const end = (n: StyleNode, axis: Axis): number => start(n, axis) + size(n, axis);

/**
 * 为每个匹配对计算局部位置关系。返回 Map 以设计节点为键（配对是 1:1）。
 * 根节点没有基准，不在返回值中。
 */
export function relativeGeometry(match: MatchResult): Map<StyleNode, RelGeo> {
  const out = new Map<StyleNode, RelGeo>();
  if (!match.pairs.length) return out;

  const rootPair = match.pairs[0];
  const parentD = parentMap(rootPair.design);
  const parentC = parentMap(rootPair.code);
  const codeOf = new Map<StyleNode, StyleNode>();
  for (const p of match.pairs) codeOf.set(p.design, p.code);

  // 分组：每个配对挂到最近的「设计侧是祖先、实现侧也是祖先」的配对下。
  // 两侧同时成立才算锚点 —— 否则一侧的层级被折叠时会拿到错误的基准。
  const anchors = new Map<StyleNode, MatchPair>();
  const groups = new Map<StyleNode, MatchPair[]>();
  for (const p of match.pairs) {
    if (p === rootPair) continue;
    let anchor: MatchPair | null = null;
    for (let cur = parentD.get(p.design); cur; cur = parentD.get(cur)) {
      const cc = codeOf.get(cur);
      if (cc && cc !== p.code && isAncestor(cc, p.code, parentC)) {
        anchor = { design: cur, code: cc, method: "geometry", score: 1 };
        break;
      }
    }
    if (!anchor) anchor = rootPair;
    anchors.set(anchor.design, anchor);
    const arr = groups.get(anchor.design) ?? [];
    arr.push(p);
    groups.set(anchor.design, arr);
  }

  const slot = (n: StyleNode): RelGeo => {
    let g = out.get(n);
    if (!g) {
      g = { x: emptyAxis(), y: emptyAxis() };
      out.set(n, g);
    }
    return g;
  };

  for (const [anchorDesign, kids] of groups) {
    const anchor = anchors.get(anchorDesign)!;
    for (const axis of ["x", "y"] as Axis[]) {
      const rels = axisRelations(anchor, kids, axis);
      const inset = collapseInset(rels);
      if (inset) {
        // 整体偏移的根因是父容器，子元素在该轴上的关系视为已解释
        for (const r of rels) {
          if (r.rel.base !== "parent") continue;
          r.rel.base = "none";
          r.rel.delta = 0;
        }
        const ag = slot(anchor.design);
        if (axis === "x") ag.insetX = inset;
        else ag.insetY = inset;
      }
      collapseGap(anchor, rels);
      for (const r of rels) {
        const g = slot(r.pair.design);
        if (axis === "x") {
          g.x = r.rel;
          g.stretchW = r.stretch;
        } else {
          g.y = r.rel;
          g.stretchH = r.stretch;
        }
        if (r.conflict) g.orderConflict = r.conflict;
      }
    }
  }

  return out;
}

interface KidRel {
  pair: MatchPair;
  rel: AxisRel;
  stretch: boolean;
  conflict?: string;
}

/** 同一父级下、同一轴上的关系序列（按设计侧顺序） */
function axisRelations(anchor: MatchPair, kids: MatchPair[], axis: Axis): KidRel[] {
  const sorted = [...kids].sort((a, b) => start(a.design, axis) - start(b.design, axis));
  const out: KidRel[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    // 顺延基准：两侧都排在它前面且不重叠的最近兄弟。
    // 横向排布的一行元素在 y 轴上互相重叠，不会串成链 —— 只有真正的流式前后关系才顺延。
    let base: MatchPair | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const q = sorted[j];
      if (
        start(p.design, axis) - end(q.design, axis) >= -EPS &&
        start(p.code, axis) - end(q.code, axis) >= -EPS
      ) {
        base = q;
        break;
      }
    }
    // 两端内边距都对 → 该轴的尺寸差完全来自父级（width/height:100%），不重复上报
    const nearD = start(p.design, axis) - start(anchor.design, axis);
    const nearC = start(p.code, axis) - start(anchor.code, axis);
    const farD = end(anchor.design, axis) - end(p.design, axis);
    const farC = end(anchor.code, axis) - end(p.code, axis);
    const stretch = Math.abs(nearC - nearD) <= EPS && Math.abs(farC - farD) <= EPS;

    const rel = base
      ? mkRel(
          start(p.design, axis) - end(base.design, axis),
          start(p.code, axis) - end(base.code, axis),
          "sibling",
          base.design.name
        )
      : mkRel(nearD, nearC, "parent", anchor.design.name);
    out.push({ pair: p, rel, stretch });
  }
  markOrderConflicts(out, axis);
  return out;
}

/**
 * 顺序矛盾：设计里 A 在 B 前面，实现里却反过来。
 * 两个方向的解释都成立（排版顺序错了 / 这两个元素被配错了对），所以两边都标记，交给人判断。
 */
function markOrderConflicts(rels: KidRel[], axis: Axis): void {
  for (let i = 0; i < rels.length; i++) {
    for (let j = i + 1; j < rels.length; j++) {
      const a = rels[i].pair;
      const b = rels[j].pair;
      // rels 已按设计侧升序：i 必然不晚于 j，只需看实现侧是否反了
      if (start(a.design, axis) - start(b.design, axis) > -EPS) continue;
      if (start(a.code, axis) - start(b.code, axis) <= EPS) continue;
      rels[i].conflict ??= b.design.name;
      rels[j].conflict ??= a.design.name;
    }
  }
}

function mkRel(design: number, actual: number, base: AxisRel["base"], baseName: string): AxisRel {
  return {
    delta: Math.round((actual - design) * 10) / 10,
    design: Math.round(design * 10) / 10,
    actual: Math.round(actual * 10) / 10,
    base,
    baseName,
  };
}

/**
 * 若父级下所有「以父级为基准」的子元素同向偏移同样的量，根因就在父容器自身
 * （内边距或对齐方式），不该让每个子元素各报一次。
 */
function collapseInset(rels: { pair: MatchPair; rel: AxisRel }[]): GroupInset | null {
  const own = rels.filter((r) => r.rel.base === "parent");
  if (own.length < INSET_MIN_CHILDREN) return null;
  const deltas = own.map((r) => r.rel.delta);
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  if (max - min > EPS * 2 || Math.abs(avg) <= EPS) return null;
  // 取离父级边最近的那个子元素作为「有效内边距」的代表值
  const rep = own.reduce((a, b) => (b.rel.design < a.rel.design ? b : a));
  return {
    delta: Math.round(avg * 10) / 10,
    design: rep.rel.design,
    actual: rep.rel.actual,
    count: own.length,
  };
}

/**
 * 父级 gap 写错时，它下面每一个后续兄弟的间隔都差同样的量 —— 那是**同一个** gap
 * 属性的投影，不是 N 个独立缺陷。compare.ts 已经会在父级上报一条 `geometry/gap`，
 * 这里把被它解释掉的兄弟关系置为 none，一个根因只留一条结论。
 *
 * 逐条判定而不是「全部匹配才折叠」：某个子元素若额外还有自己的 margin 错误，
 * 它的 delta 就对不上 gap 差，那一条要留下来 —— 整组退回 N+1 条反而更糟。
 *
 * 只看 `base === "sibling"`：链首那个子元素以父级为基准，它的偏移是内边距不是 gap，
 * 归 collapseInset 管。gap 也只沿主轴生效 —— 交叉轴上的子元素互相重叠、串不成
 * 兄弟链（见 axisRelations），所以这里不需要知道主轴是哪一根。
 */
function collapseGap(anchor: MatchPair, rels: KidRel[]): void {
  const designGap = anchor.design.layout?.gap;
  const codeGap = anchor.code.layout?.gap;
  if (designGap === undefined || codeGap === undefined) return;
  const gapDelta = codeGap - designGap;
  // 父级不会出结论时不能抑制，否则这处偏差彻底消失
  if (Math.abs(gapDelta) < GAP_REPORT_MIN) return;
  for (const r of rels) {
    if (r.rel.base !== "sibling") continue;
    if (Math.abs(r.rel.delta - gapDelta) > EPS) continue;
    r.rel.base = "none";
    r.rel.delta = 0;
  }
}
