import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { DesignSpec, Severity, ToleranceBand } from "../types.js";

export const DEFAULT_SPEC: {
  grid: number[];
  gridApply: ("gap" | "padding")[];
  tolerances: NonNullable<DesignSpec["tolerances"]> & {
    geometry: ToleranceBand;
    colorDeltaE: ToleranceBand;
    radiusDelta: ToleranceBand;
    lineHeightDelta: number;
    opacityDelta: number;
  };
  requireTokens: boolean;
} = {
  grid: [4, 8],
  gridApply: ["gap", "padding"],
  tolerances: {
    geometry: { warn: 2, error: 8 },
    colorDeltaE: { warn: 2.3, error: 5 },
    radiusDelta: { warn: 1, error: 3 },
    lineHeightDelta: 2,
    opacityDelta: 0.02,
  },
  requireTokens: false,
};

/**
 * 内置豁免：第三方组件的**内部结构**。
 *
 * 这些节点在设计稿里根本不存在，也不该存在 —— 地图瓦片图层、浮层容器、
 * 输入框内部的后缀图标，都是组件库自己渲染出来的。X501 那轮 427 条存在性问题里
 * 相当一部分就是它们，逐条要求用户裁决等于把「用了组件库」当成缺陷。
 *
 * 只降级为 info 并写明理由，不是静默丢弃 —— 报告末尾仍能翻到它们。
 * 不想要这层默认可以在 design-spec.yaml 里 `defaultExemptions: false`。
 *
 * 注意 selector 是完整路径（`html>body>div#app>...`），没有 `*` 的模式走
 * 子串匹配，正是这里要的；写成 `BMap_*` 反而会变成「必须以此开头」而永不命中。
 */
export const DEFAULT_EXEMPTIONS: NonNullable<DesignSpec["exemptions"]> = [
  { selector: "BMap_", reason: "百度地图内部图层（内置默认豁免）" },
  // 也覆盖 #el-popper-container-xxxx（子串匹配）
  { selector: "el-popper", reason: "Element Plus 浮层容器（内置默认豁免）" },
  { selector: "el-input__suffix", reason: "Element Plus 输入框内部图标（内置默认豁免）" },
];

export interface ResolvedSpec {
  grid: number[];
  gridApply: ("gap" | "padding")[];
  tolerances: {
    geometry: ToleranceBand;
    colorDeltaE: ToleranceBand;
    radiusDelta: ToleranceBand;
    lineHeightDelta: number;
    opacityDelta: number;
  };
  requireTokens: boolean;
  tokens: Map<string, string>;
  tokenValues: Set<string>;
  exemptions: DesignSpec["exemptions"];
}

export async function loadSpec(specPath?: string): Promise<ResolvedSpec> {
  let userSpec: DesignSpec = {};
  if (specPath) {
    const raw = await readFile(specPath, "utf8");
    userSpec = yaml.load(raw) as DesignSpec;
  }
  const tokens = new Map<string, string>(Object.entries(userSpec.tokens ?? {}));
  // token 值归一为小写 hex 集合，用于硬编码检测
  const tokenValues = new Set<string>();
  for (const v of tokens.values()) {
    const normalized = normalizeColorValue(v);
    if (normalized) tokenValues.add(normalized);
  }

  return {
    grid: userSpec.grid ?? DEFAULT_SPEC.grid,
    gridApply: userSpec.gridApply ?? DEFAULT_SPEC.gridApply,
    tolerances: {
      geometry: userSpec.tolerances?.geometry ?? DEFAULT_SPEC.tolerances.geometry,
      colorDeltaE: userSpec.tolerances?.colorDeltaE ?? DEFAULT_SPEC.tolerances.colorDeltaE,
      radiusDelta: userSpec.tolerances?.radiusDelta ?? DEFAULT_SPEC.tolerances.radiusDelta,
      lineHeightDelta: userSpec.tolerances?.lineHeightDelta ?? DEFAULT_SPEC.tolerances.lineHeightDelta,
      opacityDelta: userSpec.tolerances?.opacityDelta ?? DEFAULT_SPEC.tolerances.opacityDelta,
    },
    requireTokens: userSpec.requireTokens ?? DEFAULT_SPEC.requireTokens,
    tokens,
    tokenValues,
    // 用户条目排在前面：同一个 selector 两边都命中时，报告里应该显示用户自己写的理由
    exemptions:
      userSpec.defaultExemptions === false
        ? (userSpec.exemptions ?? [])
        : [...(userSpec.exemptions ?? []), ...DEFAULT_EXEMPTIONS],
  };
}

function normalizeColorValue(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return s; // rgb() 等原样保存
}

/** 数值是否落在栅格倍数上（±0.51px 容差） */
export function onGrid(value: number, grid: number[]): boolean {
  return grid.some((unit) => Math.abs(value / unit - Math.round(value / unit)) * unit < 0.51);
}

export function bandSeverity(delta: number, band: ToleranceBand): Severity | null {
  if (delta >= band.error) return "error";
  if (delta >= band.warn) return "warning";
  return null;
}
