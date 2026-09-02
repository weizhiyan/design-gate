import type { MatchPair, MatchResult, NodeKind, StyleNode, SurplusGroup } from "../types.js";

interface FlatNode {
  node: StyleNode;
  cx: number;
  cy: number;
}

/** 重复组的最小行数。2 会把「左右两栏」误判成列表，3 起才稳。 */
const MIN_REPEAT_ROWS = 3;
/** 同构签名的比较深度：够区分行模板，又不至于被行内一处空文本拆散整组 */
const SIG_DEPTH = 3;
/** 两组重复行认作同一个列表的最低重合度（首行或整组取高者） */
const GROUP_IOU_MIN = 0.35;
/** 面积占画布这个比例以上的节点算「承重结构」，走相容闸门。半屏以下是普通组件，不设闸 */
const BIG_AREA_RATIO = 0.5;
/** 大结构体两侧宽/高的最小比值。低于此值不是样式偏差，是配错了元素 */
const BIG_SIZE_RATIO = 0.6;
/** 大结构体额外要求的置信度下限 */
const BIG_SCORE_MIN = 0.5;

/**
 * 语义类别相容度：图形（图标/图片）与文本/盒子几乎不可能是同一个元素。
 * 缺这一层约束时，纯几何评分会把「锁图标」配到恰好同位的 checkbox 容器上，
 * 一次错配同时污染两条结论（假偏差 + 假缺失）。
 */
function kindPenalty(a: NodeKind | undefined, b: NodeKind | undefined): number {
  if (!a || !b || a === b) return 1;
  const graphic = (k: NodeKind) => k === "icon" || k === "image";
  if (graphic(a) && graphic(b)) return 1; // 图标 ↔ 图片：粒度差异，允许
  if (graphic(a) !== graphic(b)) return 0.3;
  return 1; // text ↔ box：已由文本项单独处理
}

function flatten(root: StyleNode): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (n: StyleNode) => {
    out.push({ node: n, cx: n.rect.x + n.rect.w / 2, cy: n.rect.y + n.rect.h / 2 });
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function normId(id: string | undefined): string | undefined {
  return id?.replace(/-/g, ":");
}

function ratio(a: number, b: number): number {
  const hi = Math.max(a, b);
  return hi <= 0 ? 1 : Math.min(a, b) / hi;
}

/**
 * 大结构体的相容闸门。
 *
 * 几何评分对大盒子太宽容：`#app`(1920x970) 与一条 1920x598 的头部色块，
 * 中心距近、宽度完全一致，综合分 0.356 仍能过 0.35 的门槛 —— 于是根容器被配到
 * 色块上，一次性产出「高 598 应为 970」和「底色 #1640b2 应为 #f1f1f5」两条假结论，
 * 且这两条会排在报告最前面（面积最大）。
 *
 * 承重结构差 1.6 倍不可能是样式偏差；而配错一个大盒子的代价是整份报告最显眼的
 * 两条假结论，所以对它同时要求更高的置信度。小元素不设这道闸
 * （8px 徽章 vs 12px 徽章是真实偏差，不是错配）。
 */
function bigNodeGate(a: StyleNode, b: StyleNode, refArea: number, score: number): boolean {
  const big = Math.max(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
  if (big < refArea * BIG_AREA_RATIO) return true;
  return (
    ratio(a.rect.w, b.rect.w) >= BIG_SIZE_RATIO &&
    ratio(a.rect.h, b.rect.h) >= BIG_SIZE_RATIO &&
    score >= BIG_SCORE_MIN
  );
}

/**
 * 结构签名 —— 「这是同一个行模板」的判据。
 * 只看 kind、字体档位与子节点形状，**不看文本内容**：列表行之间文本必然不同，
 * 那正是它们同构的证明，不是差异。
 */
const sigMemo = new WeakMap<StyleNode, string>();
function shapeSig(n: StyleNode, depth: number): string {
  if (depth === SIG_DEPTH) {
    const hit = sigMemo.get(n);
    if (hit) return hit;
  }
  const self = (n.kind ?? (n.text ? "text" : "box")) + typeSig(n);
  const sig =
    depth <= 0 || !n.children.length
      ? self
      : `${self}(${n.children.map((c) => shapeSig(c, depth - 1)).join(",")})`;
  if (depth === SIG_DEPTH) sigMemo.set(n, sig);
  return sig;
}

/**
 * 字体档位指纹。列表行之间**样式一致、文本不同**；卡片里的标题/价格/描述恰好相反 ——
 * 同为文本叶子（纯形状签名完全相同），但字号字重各不一样。
 *
 * 少了这一道，冒烟卡片的 徽章/标题/价格/描述 四个文本叶子会被当成一个 4 行列表，
 * 与设计侧的 标题/价格/描述 3 行按下标对齐 —— 于是标题配到价格、价格配到描述，
 * 整张卡片的结论全是错位造出来的假偏差。行模板必须连字体一起同构才算同一个模板。
 *
 * 方向上宁可漏判：漏了只是退回逐行上报（吵，但结论是真的），误判是整棵子树全错。
 */
function typeSig(n: StyleNode): string {
  const { fontSize, fontWeight } = n.style;
  if (fontSize === undefined && fontWeight === undefined) return "";
  return `#${fontSize ?? "?"}/${fontWeight ?? "?"}`;
}

interface RepeatGroup {
  parent: StyleNode;
  rows: StyleNode[];
  /** 列表的流向。横排一行按 y 排会被行内 12px 的错位打乱顺序，必须按流向排 */
  axis: "x" | "y";
  box: { x: number; y: number; w: number; h: number };
}

/** 流向取跨度更大的那根轴；相等按纵向（纵向列表更常见） */
function flowAxis(rows: StyleNode[]): "x" | "y" {
  const cx = rows.map((r) => r.rect.x + r.rect.w / 2);
  const cy = rows.map((r) => r.rect.y + r.rect.h / 2);
  const spanX = Math.max(...cx) - Math.min(...cx);
  const spanY = Math.max(...cy) - Math.min(...cy);
  return spanX > spanY ? "x" : "y";
}

function sortByAxis(rows: StyleNode[], axis: "x" | "y"): StyleNode[] {
  return [...rows].sort((a, b) =>
    axis === "y" ? a.rect.y - b.rect.y || a.rect.x - b.rect.x : a.rect.x - b.rect.x || a.rect.y - b.rect.y
  );
}

function unionBox(rows: StyleNode[]) {
  const x1 = Math.min(...rows.map((r) => r.rect.x));
  const y1 = Math.min(...rows.map((r) => r.rect.y));
  const x2 = Math.max(...rows.map((r) => r.rect.x + r.rect.w));
  const y2 = Math.max(...rows.map((r) => r.rect.y + r.rect.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function iou(a: { x: number; y: number; w: number; h: number }, b: typeof a): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni <= 0 ? 0 : inter / uni;
}

/** 全树扫描重复组。不要求父级已配对 —— 两侧折叠粒度不同，中间层往往配不上。 */
function collectRepeatGroups(root: StyleNode): RepeatGroup[] {
  const out: RepeatGroup[] = [];
  const walk = (n: StyleNode) => {
    const kids = n.children;
    let i = 0;
    while (i < kids.length) {
      const sig = shapeSig(kids[i], SIG_DEPTH);
      let j = i + 1;
      while (j < kids.length && shapeSig(kids[j], SIG_DEPTH) === sig) j++;
      if (j - i >= MIN_REPEAT_ROWS) {
        const raw = kids.slice(i, j);
        const axis = flowAxis(raw);
        out.push({ parent: n, rows: sortByAxis(raw, axis), axis, box: unionBox(raw) });
      }
      i = j;
    }
    kids.forEach(walk);
  };
  walk(root);
  return out;
}

/** 列表行按视觉顺序排。Figma 的 children 是 z-order，不排会把第 1 行配到第 5 行。 */
function byPos(a: StyleNode, b: StyleNode): number {
  return a.rect.y - b.rect.y || a.rect.x - b.rect.x;
}

/** 「多出来的是什么」—— 取行内第一段文本，没有文本就用图层名 */
function describeRow(n: StyleNode): string {
  const stack = [n];
  while (stack.length) {
    const cur = stack.shift()!;
    const t = (cur.text ?? "").trim();
    if (t) return t.length > 24 ? `${t.slice(0, 24)}…` : t;
    stack.push(...cur.children);
  }
  return n.name;
}

/**
 * 设计树 ↔ 实现树 多信号匹配（确定性）：
 * 1. 根节点强制配对（坐标系已归一）
 * 2. data-df-id 显式标注直连
 * 3. 重复列表按结构下标对齐，行数差折叠成一条 surplus
 * 4. 文本锚点 + 几何综合评分，贪心全局分配
 */
export function matchTrees(design: StyleNode, code: StyleNode): MatchResult {
  const dList = flatten(design);
  const cList = flatten(code);
  const pairs: MatchPair[] = [];
  const surplus: SurplusGroup[] = [];
  const dTaken = new Array(dList.length).fill(false);
  const cTaken = new Array(cList.length).fill(false);
  const dIdx = new Map<StyleNode, number>();
  const cIdx = new Map<StyleNode, number>();
  dList.forEach((f, i) => dIdx.set(f.node, i));
  cList.forEach((f, i) => cIdx.set(f.node, i));
  const takeD = (i: number) => (dTaken[i] = true);
  const takeC = (i: number) => (cTaken[i] = true);

  // 1. 根节点
  pairs.push({ design: dList[0].node, code: cList[0].node, method: "geometry", score: 1 });
  takeD(0);
  takeC(0);

  const diag = Math.max(
    Math.hypot(design.rect.w, design.rect.h),
    Math.hypot(code.rect.w, code.rect.h),
    1
  );
  const refArea = Math.min(
    Math.max(design.rect.w * design.rect.h, 1),
    Math.max(code.rect.w * code.rect.h, 1)
  );
  const geoScore = (a: FlatNode, b: FlatNode) => {
    const dist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const proximity = Math.exp((-8 * dist) / diag);
    const sizeDiff =
      (Math.abs(a.node.rect.w - b.node.rect.w) + Math.abs(a.node.rect.h - b.node.rect.h)) /
      (a.node.rect.w + a.node.rect.h + 1);
    return proximity * (1 - Math.min(1, sizeDiff));
  };

  const designById = new Map<string, { flat: FlatNode; idx: number }>();
  dList.forEach((f, i) => designById.set(normId(f.node.id) ?? f.node.id, { flat: f, idx: i }));
  const codeByDfId = new Map<string, { flat: FlatNode; idx: number }>();
  cList.forEach((f, i) => {
    const key = normId(f.node.dfId);
    if (key) codeByDfId.set(key, { flat: f, idx: i });
  });

  // 2. df-id 显式标注
  for (const [id, cf] of codeByDfId) {
    const df = designById.get(id);
    if (!df || dTaken[df.idx] || cTaken[cf.idx]) continue;
    pairs.push({ design: df.flat.node, code: cf.flat.node, method: "df-id", score: 1 });
    takeD(df.idx);
    takeC(cf.idx);
  }

  // 3. 重复列表：同构行之间几何差异极小，几何评分在这里必然乱配，只有下标可靠
  const addPair = (d: StyleNode, c: StyleNode, method: MatchPair["method"], score: number) => {
    const di = dIdx.get(d);
    const ci = cIdx.get(c);
    if (di === undefined || ci === undefined || dTaken[di] || cTaken[ci]) return false;
    pairs.push({ design: d, code: c, method, score });
    takeD(di);
    takeC(ci);
    return true;
  };
  const takeSubtree = (n: StyleNode, taken: boolean[], idx: Map<StyleNode, number>) => {
    const i = idx.get(n);
    if (i !== undefined) taken[i] = true;
    n.children.forEach((k) => takeSubtree(k, taken, idx));
  };
  /** 行内继续按下标下潜 —— 只在重复行内部这么做，那里文本不同是合法的 */
  const descendStructural = (d: StyleNode, c: StyleNode) => {
    const dk = [...d.children].sort(byPos);
    const ck = [...c.children].sort(byPos);
    if (!dk.length || dk.length !== ck.length) return;
    if (dk.some((n, i) => kindPenalty(n.kind, ck[i].kind) < 1)) return;
    dk.forEach((n, i) => {
      if (addPair(n, ck[i], "structure", 0.9)) descendStructural(n, ck[i]);
    });
  };
  const alignGroup = (dg: RepeatGroup, cg: RepeatGroup) => {
    // 流向由设计侧（真值）决定，两侧同轴排序后才谈得上「第 i 行对第 i 行」
    const drows = sortByAxis(dg.rows, dg.axis);
    const crows = sortByAxis(cg.rows, dg.axis);
    const n = Math.min(drows.length, crows.length);
    for (let i = 0; i < n; i++) {
      if (addPair(drows[i], crows[i], "structure", 0.9)) descendStructural(drows[i], crows[i]);
    }
    if (drows.length === crows.length) return;
    const side = crows.length > n ? "code" : "design";
    const rows = (side === "code" ? crows : drows).slice(n);
    const taken = side === "code" ? cTaken : dTaken;
    const idx = side === "code" ? cIdx : dIdx;
    rows.forEach((r) => takeSubtree(r, taken, idx));
    surplus.push({
      side,
      designParent: dg.parent,
      codeParent: cg.parent,
      designRows: drows.length,
      codeRows: crows.length,
      rows,
      sample: rows.slice(0, 3).map(describeRow).join(" / "),
    });
  };

  const byArea = (a: RepeatGroup, b: RepeatGroup) => b.box.w * b.box.h - a.box.w * a.box.h;
  const dGroups = collectRepeatGroups(design).sort(byArea);
  const cGroups = collectRepeatGroups(code).sort(byArea);
  const usedGroup = new Set<RepeatGroup>();
  const free = (g: RepeatGroup, taken: boolean[], idx: Map<StyleNode, number>) =>
    g.rows.every((r) => {
      const i = idx.get(r);
      return i !== undefined && !taken[i];
    });
  for (const dg of dGroups) {
    if (!free(dg, dTaken, dIdx)) continue; // 已被外层列表整体消化（嵌套列表）
    let best: RepeatGroup | undefined;
    let bestScore = 0;
    for (const cg of cGroups) {
      if (usedGroup.has(cg) || !free(cg, cTaken, cIdx)) continue;
      // 首行 IoU 与整组 IoU 取高者：行数不等时整组框会错开，首行才是稳定锚点
      const s = Math.max(iou(dg.box, cg.box), iou(dg.rows[0].rect, cg.rows[0].rect));
      if (s > bestScore) {
        bestScore = s;
        best = cg;
      }
    }
    if (!best || bestScore < GROUP_IOU_MIN) continue;
    usedGroup.add(best);
    alignGroup(dg, best);
  }

  // 4. 文本锚点 + 几何评分，贪心全局分配
  const cands: { di: number; ci: number; score: number; textMatch: boolean }[] = [];
  for (let di = 0; di < dList.length; di++) {
    if (dTaken[di]) continue;
    const d = dList[di];
    for (let ci = 0; ci < cList.length; ci++) {
      if (cTaken[ci]) continue;
      const c = cList[ci];
      const textEqual =
        !!d.node.text && !!c.node.text && d.node.text.toLowerCase() === c.node.text.toLowerCase();
      let score = geoScore(d, c);
      if (textEqual) score = 0.7 + 0.3 * score;
      else if (d.node.text || c.node.text) {
        // 一方有文本另一方没有 → 大概率不是同一元素，压低分
        score *= 0.5;
      }
      score *= kindPenalty(d.node.kind, c.node.kind);
      if (score < (textEqual ? 0.4 : 0.35)) continue;
      if (!bigNodeGate(d.node, c.node, refArea, score)) continue;
      cands.push({ di, ci, score, textMatch: textEqual });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.di - b.di || a.ci - b.ci);
  for (const cand of cands) {
    if (dTaken[cand.di] || cTaken[cand.ci]) continue;
    takeD(cand.di);
    takeC(cand.ci);
    pairs.push({
      design: dList[cand.di].node,
      code: cList[cand.ci].node,
      method: cand.textMatch ? "text" : "geometry",
      score: Math.round(cand.score * 1000) / 1000,
    });
  }

  const unmatchedDesign = dList.filter((_, i) => !dTaken[i]).map((f) => f.node);
  const unmatchedCode = cList.filter((_, i) => !cTaken[i]).map((f) => f.node);
  return { pairs, unmatchedDesign, unmatchedCode, surplus };
}
