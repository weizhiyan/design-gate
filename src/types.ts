// design-gate 共享类型契约
// 两侧数据源（Figma / DOM）统一折叠为 StyleNode 树后进行比对。

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeStyle {
  backgroundColor?: string; // #RRGGBB 或 #RRGGBBAA
  textColor?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  lineHeight?: number; // px
  letterSpacing?: number; // px
  borderRadius?: number[]; // [tl, tr, br, bl]
  borderWidth?: number;
  borderColor?: string;
  opacity?: number; // 0-1
}

export interface NodeLayout {
  gap?: number;
  padding?: [number, number, number, number]; // [t, r, b, l]
}

/**
 * 元素语义类别 —— 两侧共用的"什么算一个元素"的本体论。
 *
 * 设计侧与实现侧对"元素"的切分粒度天然不同（Figma 一个图标是 N 个 VECTOR 子图形，
 * DOM 里是一个 <svg>）。若不先统一粒度，这些结构性差异会以「设计有码无」的
 * 假阳性形式流到 diff 层。kind 把两侧折叠到同一粒度，并作为匹配的类别约束。
 */
export type NodeKind =
  | "icon" // 矢量图标：设计侧 VECTOR 子树 / 实现侧 <svg>、图标字体，整体视为一个原子
  | "image" // 位图/渐变填充：设计侧 IMAGE|GRADIENT fill / 实现侧 <img>、background-image
  | "text" // 承载文本
  | "box"; // 纯容器/装饰盒子

export interface StyleNode {
  id: string; // 设计侧: figma node id(冒号格式) / 实现侧: CSS selector
  name: string; // 设计侧: 图层名 / 实现侧: tag.class
  type: string; // FRAME | TEXT | INSTANCE ... / div | span ...
  kind?: NodeKind; // 语义类别（两侧统一粒度后的类型）
  text?: string; // 归一化后的直接文本
  /** 实现侧：伪元素等「可见但不是文本节点」的附加文本（必填星号、角标…） */
  auxText?: string;
  rect: Rect;
  style: NodeStyle;
  layout?: NodeLayout;
  dfId?: string; // DOM 侧 data-df-id 显式标注，对应设计节点 id
  children: StyleNode[];
}

export type Severity = "error" | "warning" | "info";

export type IssueCategory =
  | "geometry"
  | "color"
  | "typography"
  | "radius"
  | "border"
  | "grid"
  | "token"
  | "existence"
  | "other";

export interface Issue {
  id: string;
  severity: Severity;
  category: IssueCategory;
  property: string; // width / background-color / font-size ...
  designValue: string;
  actualValue: string;
  delta?: string;
  selector?: string; // 实现侧定位
  designNodeId?: string; // Figma 节点 id（可直接跳转）
  designNodeName?: string;
  message: string;
  /**
   * 该结论所依据的配对置信度（0-1）与配对方式。
   * 低置信度意味着「实现错了」和「我们比错了元素」无法区分，结论只能是待确认。
   */
  matchScore?: number;
  matchMethod?: MatchPair["method"];
  /** 配对可疑：置信度过低，结论不足以判定实现缺陷 */
  suspectPair?: boolean;
  /**
   * 因配对置信度不足而被压低的原severity。**只记置信度降级，不记豁免** ——
   * 豁免是「这条本就不该计分」，而这里是「等你确认配对无误就该恢复」：
   * finalize 收到 confirmed 时据此把严重度还原并重新计分。
   */
  downgradedFrom?: Severity;
  /** 与该兄弟元素的前后顺序和设计稿相反（排版顺序错了 或 配对错了） */
  orderConflict?: string;
  /** finalize 裁决补充 */
  verified?: boolean; // 用户已确认为真问题
  adjudication?: string; // 裁决备注（豁免理由/误报说明）
}

export interface DecisionRecord {
  id: string;
  verdict: "confirmed" | "accept" | "reject";
  note?: string;
  at: string;
}

/** 大图标注钉：一个元素一组问题 */
export interface Marker {
  key: string; // 分组键（selector 或 __design_xxx）
  selector?: string;
  severity: Severity; // 组内最高级别
  cats: IssueCategory[]; // 涉及类别（用于筛选）
  count: number;
  x: number; // CSS px，相对截图原点
  y: number;
  w: number;
  h: number;
  tip: string; // 悬停摘要（多行）
  issueIds: string[];
}

export interface MatchPair {
  design: StyleNode;
  code: StyleNode;
  /**
   * structure: 重复列表按下标对齐（父级已配对 + 兄弟同构）——
   * 列表行之间几何差异极小，几何评分在这里必然乱配，结构下标才是唯一可靠信号。
   */
  method: "df-id" | "text" | "geometry" | "structure";
  score: number;
}

/**
 * 重复列表的行数差 —— 一个原因，一条结论。
 *
 * 设计稿画 5 行示意、页面渲染 14 行真实数据是常态，不是缺陷。逐行报的话
 * 会同时产出 N 条「设计有码无」和 M 条「码有设计无」，还会把多出来的行喂给
 * 几何匹配去乱配，二次制造假的偏差结论。这里把整组行数差收成一条待裁决项。
 */
export interface SurplusGroup {
  /** code: 实现比设计多渲染了行；design: 设计稿画了但页面没渲染 */
  side: "code" | "design";
  /** 列表容器（两侧各一个，用于定位与文案） */
  designParent: StyleNode;
  codeParent: StyleNode;
  /** 设计侧模板行数 / 实现侧渲染行数 */
  designRows: number;
  codeRows: number;
  /** 多出来的那些行（已从 unmatched 名单中剔除，只以本组的形式出现一次） */
  rows: StyleNode[];
  /** 样例行描述（给人看「多出来的是什么」） */
  sample: string;
}

export interface MatchResult {
  pairs: MatchPair[];
  unmatchedDesign: StyleNode[];
  unmatchedCode: StyleNode[];
  /** 重复列表行数差（逐行结论已被折叠进这里） */
  surplus?: SurplusGroup[];
}

/**
 * 需要用户裁决的一个问题 —— 按根因聚类后的产物，不是单条结论。
 *
 * 705 条 warning 逐条问用户等于没问。聚类后同一个根因只问一次，
 * 用户答一次落到它下面的全部 issueIds 上。
 */
export interface Question {
  id: string; // Q1, Q2 ...
  /** 一句话问题（弹窗标题） */
  title: string;
  /** 证据：命中数量、样例、为什么无法自动判定 */
  detail: string;
  /** 这一问覆盖的结论 id —— finalize_report 收到 Q1 的裁决即应用到全部 */
  issueIds: string[];
  /** 选项文案（A/B/C 的具体含义按问题类型定制） */
  options: { verdict: "confirmed" | "accept" | "reject"; label: string }[];
}

export interface VerifySummary {
  total: number;
  errors: number;
  warnings: number;
  info: number;
  matched: number;
  unmatchedDesign: number;
  unmatchedCode: number;
  needsReview: boolean;
}

export interface VerifyMeta {
  figmaUrl?: string;
  webUrl: string;
  /** 项目名（目录名与 HTML 文件名的来源）。finalize 重出报告时靠它拼回同一个文件名 */
  projectName?: string;
  viewport: string;
  timestamp: string;
  durationMs: number;
  designScreenshotPath?: string;
  actualScreenshotPath?: string;
  /** 元素级裁剪对比图: selector -> 图片相对路径 */
  cropsActual?: Record<string, string>;
  cropsDesign?: Record<string, string>;
  /** 叠加大图的 CSS 尺寸（标记钉百分比定位基准） */
  cssW?: number;
  cssH?: number;
  /** 设计稿画布的 CSS 尺寸。与 cssW/cssH 不等时，叠加层要按真实比例放，不能拉满 */
  designW?: number;
  designH?: number;
  /** 大图标注钉 */
  markers?: Marker[];
}

export interface VerifyResult {
  status: "PASS" | "FAIL" | "NEEDS_REVIEW";
  score: number; // 0-100
  summary: VerifySummary;
  issues: Issue[];
  meta: VerifyMeta;
  decisions?: DecisionRecord[];
  /** 按根因聚类的待裁决问题（AI 据此逐条问用户，而不是念 700 条 warning） */
  questions?: Question[];
  /** 纯净修复清单（可直接粘贴给 AI 执行） */
  fixesText?: string;
}

export interface ToleranceBand {
  warn: number;
  error: number;
}

export interface Exemption {
  selector?: string;
  designNodeName?: string;
  property?: string;
  reason: string;
}

export interface DesignSpec {
  grid?: number[]; // 允许的间距倍数，如 [4, 8]
  gridApply?: ("gap" | "padding")[];
  tolerances?: {
    geometry?: ToleranceBand; // px
    colorDeltaE?: ToleranceBand;
    radiusDelta?: ToleranceBand; // px
    lineHeightDelta?: number; // px
    opacityDelta?: number;
  };
  requireTokens?: boolean; // 禁止硬编码色值（必须命中 tokens 表）
  tokens?: Record<string, string>; // token 名 -> 颜色值
  exemptions?: Exemption[];
  /** 关掉内置的第三方组件内部结构豁免（默认开）。见 rules/spec.ts 的 DEFAULT_EXEMPTIONS */
  defaultExemptions?: boolean;
}
