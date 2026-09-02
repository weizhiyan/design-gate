import type { NodeKind, NodeLayout, NodeStyle, StyleNode } from "../types.js";

/** 矢量图形类型：这些节点在 DOM 里不会有独立元素，只是 <svg> 内部的 path */
const VECTOR_LIKE = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "REGULAR_POLYGON",
  "ELLIPSE",
]);

/** 分组容器类型：本身不产生视觉，只承载子节点 */
const GROUP_LIKE = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SECTION"]);

/** 图标尺寸上限（px）。超过此尺寸的矢量子树不整体折叠，避免把并列的多个图标合成一个。 */
const ICON_MAX = 64;

/** 背景层判定：子节点覆盖父盒子的面积比例阈值 */
const BACKDROP_COVERAGE = 0.92;

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

function toHex(c: FigmaColor): string | undefined {
  if (!c) return undefined;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  const base = `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
  const a = c.a ?? 1;
  return a < 1 ? `${base}${ch(a)}` : base;
}

/** 取第一个可见的纯色 fill */
function solidFill(node: any): string | undefined {
  for (const f of node.fills ?? []) {
    if (f.visible === false || f.type !== "SOLID") continue;
    return toHex(f.color);
  }
  return undefined;
}

/** 是否存在可见的位图/渐变填充（这类填充在 DOM 里通常是 background-image，而非独立元素） */
function hasPaintedFill(node: any): boolean {
  for (const f of node.fills ?? []) {
    if (f.visible === false) continue;
    if (f.type === "IMAGE" || String(f.type ?? "").startsWith("GRADIENT")) return true;
  }
  return false;
}

/** 子树是否只含矢量图形（无 TEXT，且至少有一个矢量节点） */
function isVectorOnlySubtree(node: any): boolean {
  let sawVector = false;
  const walk = (n: any): boolean => {
    const t = String(n.type ?? "");
    if (t === "TEXT") return false;
    if (VECTOR_LIKE.has(t)) sawVector = true;
    else if (!GROUP_LIKE.has(t)) return false; // RECTANGLE/SLICE 等不算矢量组成部分
    for (const c of n.children ?? []) {
      if (c.visible === false) continue;
      if (!walk(c)) return false;
    }
    return true;
  };
  return walk(node) && sawVector;
}

/**
 * 矢量原子判定：返回该节点应折叠成的 kind，或 null 表示不折叠。
 *
 * - 图标尺寸内的矢量子树 → "icon"，整体折叠为一个叶子（对应 DOM 的一个 <svg>）
 * - 超尺寸的裸矢量节点   → "image"，视为插画/图形整体
 * - 超尺寸的矢量容器     → null，继续递归，避免把并列的多个图标合成一个
 */
function vectorAtomKind(node: any, bb: FigmaBBox): NodeKind | null {
  const t = String(node.type ?? "");
  const isLeafVector = VECTOR_LIKE.has(t);
  const withinIconSize = (bb.width ?? 0) <= ICON_MAX && (bb.height ?? 0) <= ICON_MAX;

  if (isLeafVector) return withinIconSize ? "icon" : "image";
  if (!isVectorOnlySubtree(node)) return null;
  return withinIconSize ? "icon" : null;
}

function strokeStyle(node: any): Pick<NodeStyle, "borderWidth" | "borderColor"> {
  for (const s of node.strokes ?? []) {
    if (s.visible === false || s.type !== "SOLID") continue;
    const w = typeof node.strokeWeight === "number" ? node.strokeWeight : 1;
    if (w <= 0) break;
    return { borderWidth: w, borderColor: toHex(s.color) };
  }
  return {};
}

function radiusOf(node: any): number[] | undefined {
  if (typeof node.rectangleCornerRadii === "object" && node.rectangleCornerRadii?.length === 4) {
    return node.rectangleCornerRadii as number[];
  }
  if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
    const r = node.cornerRadius;
    return [r, r, r, r];
  }
  return undefined;
}

function layoutOf(node: any): NodeLayout | undefined {
  if (!node.layoutMode || node.layoutMode === "NONE") return undefined;
  const layout: NodeLayout = {};
  if (typeof node.itemSpacing === "number" && node.itemSpacing > 0) layout.gap = node.itemSpacing;
  const pad: [number, number, number, number] = [
    node.paddingTop ?? 0,
    node.paddingRight ?? 0,
    node.paddingBottom ?? 0,
    node.paddingLeft ?? 0,
  ];
  if (pad.some((p) => p > 0)) layout.padding = pad;
  return Object.keys(layout).length ? layout : undefined;
}

interface FigmaBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function convertNode(node: any): StyleNode | null {
  if (node.visible === false) return null;

  const bb: FigmaBBox | undefined = node.absoluteBoundingBox;
  if (!bb) return null;

  const isText = node.type === "TEXT";
  const style: NodeStyle = {};

  if (isText) {
    style.textColor = solidFill(node);
    const s = node.style ?? {};
    if (typeof s.fontSize === "number") style.fontSize = s.fontSize;
    if (typeof s.fontWeight === "number") style.fontWeight = s.fontWeight;
    else if (typeof s.fontPostScriptName === "string") {
      const m = s.fontPostScriptName.match(/(\d+)$/);
      if (m) style.fontWeight = parseInt(m[1], 10);
    }
    if (typeof s.fontFamily === "string") style.fontFamily = s.fontFamily;
    // 行高：仅在设计师显式设过时才产出。Figma 的 lineHeightUnit="INTRINSIC_%" 表示
    // AUTO（字体固有行距），此时 lineHeightPx 只是渲染结果而非设计决定，其 CSS 对等物
    // 是 line-height:normal —— 实现侧对 normal 同样跳过（dom-extract），两侧才对称。
    if (typeof s.lineHeightPx === "number" && s.lineHeightUnit !== "INTRINSIC_%") {
      style.lineHeight = round1(s.lineHeightPx);
    }
    if (typeof s.letterSpacing === "number" && s.letterSpacing !== 0) style.letterSpacing = s.letterSpacing;
  } else {
    style.backgroundColor = solidFill(node);
    Object.assign(style, strokeStyle(node));
  }

  const radii = radiusOf(node);
  if (radii) style.borderRadius = radii;
  if (typeof node.opacity === "number" && node.opacity < 1) style.opacity = Math.round(node.opacity * 100) / 100;

  // 矢量原子折叠：图标在 Figma 里是 N 个 VECTOR 子图形，在 DOM 里是一个 <svg>。
  // 若逐个 VECTOR 参与比对，既产生结构上不可能满足的「设计有码无」，
  // 又会抢占真实元素的匹配位。此处在设计侧就折叠到与 DOM 相同的粒度。
  const atom = vectorAtomKind(node, bb);
  if (atom) {
    return {
      id: String(node.id),
      name: String(node.name ?? node.type),
      type: String(node.type),
      kind: atom,
      rect: { x: round1(bb.x), y: round1(bb.y), w: round1(bb.width), h: round1(bb.height) },
      style,
      children: [],
    };
  }

  const children: StyleNode[] = [];
  for (const child of node.children ?? []) {
    const converted = convertNode(child);
    if (converted) children.push(converted);
  }

  const text = isText
    ? String(node.characters ?? "").replace(/\s+/g, " ").trim() || undefined
    : collectDirectText(node);

  // 背景层吸收：满铺的装饰矩形/图片层在 DOM 里是父元素的 background，不是独立元素。
  // 保留为节点会稳定产出一条无法修复的「设计有码无」。
  absorbBackdrop(bb, style, children);

  // 容器吸收唯一文本子节点（对齐 DOM 模型：文本挂在带样式的元素上）
  if (!text && children.length === 1 && children[0].type === "TEXT" && children[0].text) {
    const t = children[0];
    const contained =
      t.rect.x >= round1(bb.x - 1) &&
      t.rect.y >= round1(bb.y - 1) &&
      t.rect.x + t.rect.w <= round1(bb.x + (bb.width ?? 0) + 1) &&
      t.rect.y + t.rect.h <= round1(bb.y + (bb.height ?? 0) + 1);
    if (contained) {
      const merged: StyleNode = { ...children[0] };
      merged.id = String(node.id);
      merged.name = String(node.name ?? node.type);
      merged.type = String(node.type);
      merged.kind = "text";
      merged.rect = {
        x: round1(bb.x),
        y: round1(bb.y),
        w: round1(bb.width),
        h: round1(bb.height),
      };
      // 容器自身样式优先，文本样式补齐
      merged.style = { ...t.style, ...stripUndefined(style) };
      if (style.backgroundColor && !merged.style.backgroundColor) merged.style.backgroundColor = style.backgroundColor;
      if (radii && !merged.style.borderRadius) merged.style.borderRadius = radii;
      merged.layout = layoutOf(node);
      return merged;
    }
  }

  // 折叠纯容器: 无样式贡献 + 单子节点且盒子重合 → 用子节点替代自身
  if (!text && children.length === 1 && !hasVisualContribution(style)) {
    const only = children[0];
    if (
      Math.abs(bb.x - only.rect.x) < 0.5 &&
      Math.abs(bb.y - only.rect.y) < 0.5 &&
      Math.abs((bb.width ?? 0) - only.rect.w) < 0.5 &&
      Math.abs((bb.height ?? 0) - only.rect.h) < 0.5
    ) {
      only.id = node.id;
      only.name = node.name || only.name;
      return only;
    }
  }

  return {
    id: String(node.id),
    name: String(node.name ?? node.type),
    type: String(node.type),
    kind: text ? "text" : hasPaintedFill(node) ? "image" : "box",
    text,
    rect: { x: round1(bb.x), y: round1(bb.y), w: round1(bb.width), h: round1(bb.height) },
    style,
    layout: layoutOf(node),
    children,
  };
}

/**
 * 把满铺的装饰子节点（背景色块 / 位图层）吸收进父节点的样式，并从 children 中移除。
 *
 * 判定要求全部满足：叶子、无文本、只贡献填充（无边框无圆角）、覆盖父盒子面积 ≥92%、与父盒子基本同位。
 * "只贡献填充"这一条用来区分背景层和真实控件——带边框/圆角的满铺矩形通常是输入框、
 * 卡片这类在 DOM 里确实存在对应元素的节点，不能吸收。
 */
function absorbBackdrop(bb: FigmaBBox, style: NodeStyle, children: StyleNode[]): void {
  const pw = bb.width ?? 0;
  const ph = bb.height ?? 0;
  if (pw <= 0 || ph <= 0) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (c.text || c.children.length) continue;
    if (c.kind === "icon") continue; // 图标不是背景
    if (c.style.borderWidth || c.style.borderRadius) continue; // 有描边/圆角 → 视为真实控件
    const coverage = (c.rect.w * c.rect.h) / (pw * ph);
    const aligned =
      Math.abs(c.rect.x - bb.x) <= Math.max(1, pw * 0.02) &&
      Math.abs(c.rect.y - bb.y) <= Math.max(1, ph * 0.02);
    if (coverage < BACKDROP_COVERAGE || coverage > 1.08 || !aligned) continue;
    if (!style.backgroundColor && c.style.backgroundColor) style.backgroundColor = c.style.backgroundColor;
    children.splice(i, 1);
  }
}

function hasVisualContribution(style: NodeStyle): boolean {
  return Boolean(
    style.backgroundColor ||
      style.borderRadius ||
      style.borderWidth ||
      (style.opacity !== undefined && style.opacity < 1)
  );
}

/** 容器节点的直接文本（Figma 中文本通常是独立 TEXT 子节点，此处仅兜底） */
function collectDirectText(_node: any): string | undefined {
  return undefined;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function stripUndefined<T extends object>(o: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Figma 文档节点 → 比对用样式树。
 * 同时把坐标系归一到该 frame 自身原点（消除页面内绝对偏移）。
 */
export function figmaToStyleTree(document_: any): StyleNode {
  const root = convertNode(document_);
  if (!root) throw new Error("Figma 节点无法转换为样式树（缺少 absoluteBoundingBox 或不可见）");
  normalize(root);
  return root;
}

/** 将整棵树的坐标平移，使根节点位于 (0,0)，并四舍五入到 0.1px */
export function normalize(tree: StyleNode): void {
  const ox = tree.rect.x;
  const oy = tree.rect.y;
  const walk = (n: StyleNode) => {
    n.rect.x = round1(n.rect.x - ox);
    n.rect.y = round1(n.rect.y - oy);
    n.children.forEach(walk);
  };
  walk(tree);
}
