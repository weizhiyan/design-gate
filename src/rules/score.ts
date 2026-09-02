// 评分与门禁：唯一实现。
// engine（首次验收）与 report/html 的 recalcSummary（裁决后重算）都调这里 ——
// 公式抄成两份的下场是改了一处、另一处继续按旧标尺打分，而两个分数都会出现在报告里。
import type { Issue, VerifyResult } from "../types.js";

/** 元素上出现 error 的扣分权重（满权：这个元素不算做对） */
const ERROR_WEIGHT = 1;
/** 只有 warning 的元素扣 0.4：偏差真实存在，但不至于判定这个元素做错了 */
const WARNING_WEIGHT = 0.4;
/**
 * 允许存在警告的元素数上限。
 *
 * 单位是「元素」而不是「警告条数」：一处 gap 失误会同时投影成父级 gap、栅格违规、
 * 若干兄弟间隔，按条数算的话一个失误就吃掉整个预算。按元素算，这个预算才对得上
 * 它想表达的意思 —— 「有几处地方做错了」。
 */
const WARN_ELEMENT_BUDGET = 3;

/**
 * 一条 issue 归属的元素键。
 *
 * 与报告大图上的标记钉分组用同一套规则（engine 里的图钉分组直接调这个函数）——
 * 两处口径一旦分叉，「3 个元素有警告」就会和图上看到的钉子数量对不上。
 */
export function issueElementKey(i: Issue): string {
  return i.selector || `__design_${i.designNodeId || i.id}`;
}

/** 分母口径：这次实际比对过的元素数 */
export interface ScoreCounts {
  matched: number;
  unmatchedDesign: number;
  unmatchedCode: number;
  needsReview: boolean;
}

export interface ScoreOutcome {
  score: number;
  status: VerifyResult["status"];
  errors: number;
  warnings: number;
  info: number;
}

/**
 * 分数 = 干净元素占比。
 *
 * 旧公式 `100 − errors×10 − warnings×2` 在 10 个 error 之后恒为 0：真实页面从 56 条
 * 修到 12 条，分数一动不动，修复过程完全读不出进展。改成「出问题的元素占被检查元素
 * 的比例」，修一个就升一点；同一元素上叠多少条结论只按最高严重度计一次，免得
 * 「这个元素被查得更细」被读成「这个元素问题更严重」。
 *
 * info 不计分：那是豁免过的、或已被人工裁决为可接受的。
 */
export function scoreAndStatus(issues: Issue[], counts: ScoreCounts): ScoreOutcome {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const info = issues.filter((i) => i.severity === "info").length;

  const worst = new Map<string, "error" | "warning">();
  for (const i of issues) {
    if (i.severity === "info") continue;
    const key = issueElementKey(i);
    if (i.severity === "error") worst.set(key, "error");
    else if (!worst.has(key)) worst.set(key, "warning");
  }
  let errorElements = 0;
  let warningElements = 0;
  for (const sev of worst.values()) {
    if (sev === "error") errorElements++;
    else warningElements++;
  }

  const units = Math.max(1, counts.matched + counts.unmatchedDesign + counts.unmatchedCode);
  const penalty = errorElements * ERROR_WEIGHT + warningElements * WARNING_WEIGHT;
  const score = Math.max(0, Math.round(100 * (1 - penalty / units)));

  // 门禁：有 error 一律不通过（与旧行为一致），警告预算改按元素计
  let status: VerifyResult["status"];
  if (errors > 0 || warningElements > WARN_ELEMENT_BUDGET) status = "FAIL";
  else if (counts.needsReview && errors + warnings > 0) status = "NEEDS_REVIEW";
  else status = "PASS";

  return { score, status, errors, warnings, info };
}
