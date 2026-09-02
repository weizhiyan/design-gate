// 此文件会被序列化后注入浏览器执行，必须是零依赖的自包含函数。
// 遍历 DOM，采集每个元素的几何 + computedStyle + 直接文本，折叠纯包装层。
// 注意：extract 运行在浏览器上下文，内部刻意使用宽松类型。

export interface DomExtractNode {
  id: string; // 生成的 selector
  name: string;
  type: string;
  kind?: "icon" | "image" | "text" | "box";
  text?: string;
  /** 伪元素等「可见但不是文本节点」的附加文本（必填星号、角标…） */
  auxText?: string;
  dfId?: string;
  rect: { x: number; y: number; w: number; h: number };
  style: Record<string, unknown>;
  layout?: { gap?: number; padding?: [number, number, number, number] };
  children: DomExtractNode[];
}

export function domExtractSource(selector: string | null): string {
  // 注入前补一个 __name 恒等实现：esbuild/tsx 在 keepNames 下会把函数包成
  // __name(fn, "fn")，而该 helper 不存在于浏览器里。补上后，「自包含」这个前提
  // 在 tsc 与 tsx 两条编译链下都成立（tsc 产物用不到它，留着无副作用）。
  return `(()=>{const __name=(f)=>f;return (${extract.toString()})(${JSON.stringify(selector ?? null)})})()`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function extract(rootSelector: string | null): DomExtractNode | null {
  // 与设计侧保持一致的图标尺寸上限（src/figma/adapter.ts ICON_MAX）
  const ICON_MAX = 64;
  const px = (v: any): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
  };
  const norm = (s: any): string => String(s || "").replace(/\s+/g, " ").trim();

  const rootEl: any = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!rootEl) throw new Error("选择器未命中任何元素: " + rootSelector);
  const sx = window.scrollX || 0;
  const sy = window.scrollY || 0;

  /**
   * 伪元素文本：Ant Design 的必填星号、多数「角标/前缀」都是 ::before/::after 的 content。
   * 它们在页面上可见，却不是文本节点，不采集就会让设计稿里对应的文本报「实现缺失」。
   * 图标字体的私用区码位（U+E000–U+F8FF）不算文本，跳过。
   */
  function pseudoText(el: any): string {
    let out = "";
    for (const which of ["::before", "::after"]) {
      let c: string;
      try {
        c = String(getComputedStyle(el, which).content || "");
      } catch {
        continue;
      }
      if (!c || c === "none" || c === "normal") continue;
      const m = c.match(/^"((?:[^"\\]|\\.)*)"$/) || c.match(/^'((?:[^'\\]|\\.)*)'$/);
      if (!m) continue;
      const s = m[1].replace(/\\(.)/g, "$1");
      if (!s.trim()) continue;
      if (isGlyphOnly(s)) continue; // 纯图标字形，不是可读文本
      out += (out ? " " : "") + s;
    }
    return out;
  }

  /** 是否全部由图标字体私用区码位（U+E000–U+F8FF）构成 */
  function isGlyphOnly(s: string): boolean {
    let sawGlyph = false;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code === 32 || code === 9) continue;
      if (code >= 0xe000 && code <= 0xf8ff) {
        sawGlyph = true;
        continue;
      }
      return false;
    }
    return sawGlyph;
  }

  /** 占位符是可见文本，但不是文本节点（value 为空时才显示） */
  function placeholderText(el: any): string {
    const tag = String(el.tagName).toLowerCase();
    if (tag !== "input" && tag !== "textarea") return "";
    if (el.value) return "";
    return norm(el.getAttribute("placeholder"));
  }

  function selectorFor(el: any): string {
    if (el.id) return "#" + el.id;
    const parts: string[] = [];
    let cur: any = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      let part = String(cur.tagName).toLowerCase();
      if (cur.classList && cur.classList.length) part += "." + Array.from(cur.classList).slice(0, 2).join(".");
      const parent = cur.parentElement;
      if (parent) {
        const same: any[] = Array.from(parent.children).filter((c: any) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function isTransparent(color: any): boolean {
    if (!color) return true;
    if (color === "transparent") return true;
    const m = String(color).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?\s*\)/);
    if (m && parseFloat(m[4] || "1") === 0) return true;
    return false;
  }

  function build(el: any): DomExtractNode | null {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1 && !el.children.length) return null;

    const tag = String(el.tagName).toLowerCase();
    // <svg> 视为原子：设计侧一个图标是 N 个 VECTOR 子图形，这里同样折叠成一个节点，
    // 两侧粒度才对得上。不下钻 path/g/defs（它们在设计侧已被折叠掉）。
    const isSvg = tag === "svg";
    const atomic = isSvg || tag === "img" || tag === "canvas" || tag === "video";

    let directText = "";
    for (const n of el.childNodes as any[]) {
      if (n.nodeType === 3) directText += n.textContent;
    }
    directText = norm(directText);
    if (!directText) directText = norm(placeholderText(el));
    const auxText = norm(pseudoText(el));

    const radii = [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ].map(px);

    const borderWidths = [
      cs.borderTopWidth,
      cs.borderRightWidth,
      cs.borderBottomWidth,
      cs.borderLeftWidth,
    ].map(px);
    const borderStyles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
    let maxBorder = 0;
    for (let i = 0; i < 4; i++) {
      if (borderStyles[i] !== "none" && borderStyles[i] !== "hidden") maxBorder = Math.max(maxBorder, borderWidths[i]);
    }

    const style: any = {};
    const bg = cs.backgroundColor;
    if (!isTransparent(bg)) style.backgroundColor = bg;
    style.textColor = cs.color;
    style.fontSize = px(cs.fontSize);
    style.fontWeight = parseInt(cs.fontWeight, 10) || 400;
    style.fontFamily = String(cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
    if (cs.lineHeight && cs.lineHeight !== "normal") style.lineHeight = px(cs.lineHeight);
    if (cs.letterSpacing && cs.letterSpacing !== "normal" && px(cs.letterSpacing) !== 0) style.letterSpacing = px(cs.letterSpacing);
    if (radii.some((v) => v > 0)) style.borderRadius = radii;
    if (maxBorder > 0) {
      style.borderWidth = maxBorder;
      style.borderColor = cs.borderTopColor;
    }
    const op = parseFloat(cs.opacity);
    if (op < 1) style.opacity = op;

    let layout: any;
    const display = cs.display || "";
    if (display.includes("flex") || display.includes("grid")) {
      const gaps = [cs.columnGap, cs.rowGap].map(px).filter((v) => v > 0);
      if (gaps.length) layout = { ...layout, gap: Math.min.apply(null, gaps) };
    }
    const pads = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px);
    if (pads.some((v) => v > 0)) layout = { ...layout, padding: pads };

    const children: DomExtractNode[] = [];
    if (!atomic) {
      for (const child of el.children as any[]) {
        const built = build(child);
        if (built) children.push(built);
      }
    }

    const w = Math.round(r.width * 10) / 10;
    const h = Math.round(r.height * 10) / 10;
    const kind: DomExtractNode["kind"] = isSvg
      ? w <= ICON_MAX && h <= ICON_MAX
        ? "icon"
        : "image"
      : tag === "img" || tag === "canvas" || tag === "video"
        ? "image"
        : directText
          ? "text"
          : "box";

    const node = {
      id: selectorFor(el),
      name: String(el.tagName).toLowerCase() + (el.classList.length ? "." + el.classList[0] : ""),
      type: String(el.tagName).toLowerCase(),
      kind,
      text: directText || undefined,
      auxText: auxText || undefined,
      dfId: el.getAttribute("data-df-id") || undefined,
      rect: {
        x: Math.round((r.left + sx) * 10) / 10,
        y: Math.round((r.top + sy) * 10) / 10,
        w,
        h,
      },
      style,
      layout,
      children,
    } as DomExtractNode;

    // 折叠冗余包装层：单子节点、盒子重合、自身无文本无样式贡献
    const s = node.style as any;
    if (
      !node.text &&
      !node.dfId &&
      children.length === 1 &&
      !s.backgroundColor &&
      !s.borderRadius &&
      !s.borderWidth &&
      s.opacity === undefined
    ) {
      const c = children[0];
      const sameBox =
        Math.abs(node.rect.x - c.rect.x) < 0.5 &&
        Math.abs(node.rect.y - c.rect.y) < 0.5 &&
        Math.abs(node.rect.w - c.rect.w) < 0.5 &&
        Math.abs(node.rect.h - c.rect.h) < 0.5;
      if (sameBox) return c;
    }

    return node;
  }

  return build(rootEl);
}
