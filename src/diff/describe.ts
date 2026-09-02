// 素净中文描述：把专业 diff 翻译成人话。
import type { Issue } from "../types.js";

/** 分类主色（图钉/区块用） */
export const CAT_COLOR: Record<string, string> = {
  geometry: "#2563eb", // 蓝
  color: "#dc2626", // 红
  typography: "#7c3aed", // 紫
  radius: "#0891b2", // 青
  border: "#0e7490", // 深青
  grid: "#059669", // 绿
  token: "#d97706", // 琥珀
  existence: "#db2777", // 粉
  other: "#6b7280",
};

export const CAT_TITLE: Record<string, string> = {
  geometry: "位置与尺寸",
  color: "颜色",
  typography: "字体排版",
  radius: "圆角",
  border: "边框",
  grid: "间距栅格",
  token: "颜色规范",
  existence: "缺失与多余",
  other: "其他",
};

const WEIGHT_NAME: Record<string, string> = {
  "300": "细体",
  "400": "常规",
  "500": "中等",
  "600": "半粗",
  "700": "粗体",
};

/** 从 selector 推断元素角色 */
function roleOf(selector?: string): string {
  const s = (selector || "").toLowerCase();
  if (/btn|button/.test(s)) return "按钮";
  if (/checkbox|radio|switch/.test(s)) return "选择框";
  if (/input|textbox|field/.test(s)) return "输入框";
  if (/\bh[1-6]\b|title|heading/.test(s)) return "标题";
  if (/img|image|photo|banner/.test(s)) return "图片";
  if (/logo|icon|avatar|svg/.test(s)) return "图标";
  if (/label|span|\bp\b|text|desc/.test(s)) return "文字";
  return "元素";
}

const px = (v: string) => (v.endsWith("px") ? v : v);

/**
 * 显示用数值收敛。只作用于给人看的字符串，比对阈值走的是原始数值，不经过这里。
 *
 * 两种 Figma 自带的噪声：
 * - `9.140000343322754` 这类浮点尾巴 —— 报告里读它没有意义，收到 2 位小数。
 * - 圆角的 `16777200`(≈2^24) 是 Figma 表示「全圆角」的哨兵值，印出来像坏数据。
 *   这条只在圆角属性上生效：别的属性上一个大数是真的大，不能替换成文案。
 */
export function trimNums(s: string | undefined, property?: string): string {
  if (!s) return s ?? "";
  let out = s.replace(/-?\d+\.\d{3,}/g, (m) => String(Math.round(Number(m) * 100) / 100));
  if (property && /radius/i.test(property)) {
    out = out.replace(/(^|[^\d.])(\d{5,})(?![\d.])/g, (_m, pre: string, num: string) =>
      Number(num) >= 9999 ? `${pre}全圆角` : `${pre}${num}`
    );
  }
  // 四角/四边写法里各值相同的话，`8/8/8/8` 缩成 `8` —— CSS 简写本来就这么读。
  // 只对纯数值/关键字生效，图层名里带斜杠不能被并掉。
  const parts = out.split("/");
  if (parts.length > 1 && parts.every((p) => /^(-?[\d.]+(px|%)?|全圆角)$/.test(p) && p === parts[0])) {
    return parts[0];
  }
  return out;
}

/** 单条 issue → 一句人话 */
export function describeIssuePlain(i: Issue): string {
  const role = roleOf(i.selector);
  const d = trimNums(i.designValue.trim(), i.property);
  const a = trimNums(i.actualValue.trim(), i.property);
  const delta = trimNums(i.delta)?.replace(/[Δ]/g, "差 ") ?? "";

  switch (`${i.category}/${i.property}`) {
    case "color/background-color":
      return `${role}背景色不对：设计稿是 ${d}，页面用的是 ${a}`;
    case "color/color":
      return `${role}文字颜色不对：设计稿是 ${d}，页面用的是 ${a}`;
    case "typography/font-size":
      return `${role}字号不一致：设计稿 ${px(d)}，页面 ${px(a)}${delta ? `（${delta}）` : ""}`;
    case "typography/font-weight":
      return `${role}粗细不一致：设计稿是${WEIGHT_NAME[d] ?? d}(${d})，页面是${WEIGHT_NAME[a] ?? a}(${a})`;
    case "typography/line-height":
      return `${role}行高不一致：设计稿 ${px(d)}，页面 ${px(a)}${delta ? `（${delta}）` : ""}`;
    case "typography/font-family":
      return `${role}字体不一致：设计稿用「${d}」，页面显示为「${a}」（可能字体未加载）`;
    case "geometry/w":
      return `${role}宽度不一致：设计稿 ${px(d)}，页面 ${px(a)}${delta ? `（${delta}）` : ""}`;
    case "geometry/h":
      return `${role}高度不一致：设计稿 ${px(d)}，页面 ${px(a)}${delta ? `（${delta}）` : ""}`;
    case "geometry/x":
    case "geometry/y":
    case "geometry/padding-left":
    case "geometry/padding-top":
      // 位置类的说明在比对时已写明基准（相对父级还是前一个元素），直接沿用，
      // 二次转述只会丢掉基准信息，让人误以为是绝对坐标。
      return `${role}${i.message}`;
    case "geometry/gap":
      return `子元素之间的间距不一致：设计稿留 ${px(d)}，页面只留 ${px(a)}`;
    case "radius/border-radius":
      return `${role}圆角不一致：设计稿 ${d.replace(/\//g, " ")}，页面 ${a.replace(/\//g, " ")}`;
    case "border/border-width":
      return `${role}边框粗细不一致：设计稿 ${d}，页面 ${a}`;
    case "border/border-color":
      return `${role}边框颜色不一致：设计稿是 ${d}，页面用的是 ${a}`;
    default:
      break;
  }

  switch (i.category) {
    case "grid":
      return `${role}的间距没有落在 4/8 的倍数上：当前是 ${a}`;
    case "token":
      return `${role}用了不规范的写死颜色 ${a}，应该改用设计规范里的标准色`;
    case "existence":
      if (i.property === "element") return `设计稿里的「${i.designValue.replace(/"/g, "")}」在页面上没有找到`;
      return `页面上多了个「${i.actualValue.replace(/"/g, "")}」，设计稿里没有它`;
    default:
      return `${role}的 ${i.property} 不一致：设计稿 ${d}，页面 ${a}${delta ? `（${delta}）` : ""}`;
  }
}

/** 组悬停摘要：最多3句 + 省略提示 */
export function describeGroupTip(issues: Issue[]): string {
  const lines = issues.slice(0, 3).map(describeIssuePlain);
  if (issues.length > 3) lines.push(`……还有 ${issues.length - 3} 条，点击看详情`);
  return lines.join("\n");
}
