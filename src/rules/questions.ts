import type { Issue, Question } from "../types.js";

/**
 * 把待裁决结论按**根因**聚类成几个问题。
 *
 * 为什么必须聚类：X501 那轮 605 条 warning，逐条问用户等于没问 —— 人念到第 20 条
 * 就开始乱点，而这 605 条背后其实只有十来个原因（设计稿画 5 行示意/页面渲染 14 行、
 * 字体没装、一片配对没配上…）。同一个原因问一次，用户答一次落到它下面的全部结论上。
 *
 * 什么该进这里：**只有人能回答**的问题 —— 元素多了少了、行数差、字体替换是不是环境所限。
 * 什么不该进：几何数值、硬编码色值这类 AI 直接改代码就能收敛的，进修复循环，不占用户注意力。
 */

/** 一轮对话最多问这么多。再多用户就开始乱点了，剩下的留在报告里翻 */
const MAX_QUESTIONS = 8;
/** 几条同因结论才值得合成一问。低于此数直接看报告更快 */
const MIN_CLUSTER = 3;

/** 三个选项的语义固定（对应 DecisionRecord.verdict），文案按问题类型定制 */
const opts = (confirmed: string, accept: string, reject: string): Question["options"] => [
  { verdict: "confirmed", label: confirmed },
  { verdict: "accept", label: accept },
  { verdict: "reject", label: reject },
];

interface Draft {
  /** 排序优先级：小的先问。按「答案能改变多少结论」排，不按条数排 */
  prio: number;
  title: string;
  detail: string;
  issueIds: string[];
  options: Question["options"];
}

/** 样例：给人看「是哪些」，不列全 —— 全列就退化成念清单了 */
function samples(list: Issue[], pick: (i: Issue) => string | undefined, n = 4): string {
  const names = [...new Set(list.map(pick).filter((s): s is string => !!s))];
  const shown = names.slice(0, n).map((s) => (s.length > 20 ? s.slice(0, 20) + "…" : s));
  return shown.join("、") + (list.length > shown.length ? ` … 共 ${list.length} 处` : "");
}

function groupBy(list: Issue[], key: (i: Issue) => string): Map<string, Issue[]> {
  const m = new Map<string, Issue[]>();
  for (const i of list) {
    const k = key(i);
    const arr = m.get(k);
    if (arr) arr.push(i);
    else m.set(k, [i]);
  }
  return m;
}

export function buildQuestions(issues: Issue[]): Question[] {
  const drafts: Draft[] = [];
  const active = issues.filter((i) => i.severity !== "info");
  const ex = (property: string, sev?: Issue["severity"]) =>
    active.filter(
      (i) => i.category === "existence" && i.property === property && (!sev || i.severity === sev)
    );

  // 1. 列表行数差：一个列表一问。设计稿画示意行 vs 真实数据，只有产品自己知道
  for (const i of ex("row-count")) {
    drafts.push({
      prio: 1,
      title: `列表行数与设计稿不一致：设计 ${i.designValue} / 实现 ${i.actualValue}（${i.designNodeName}）`,
      detail: i.message,
      issueIds: [i.id],
      options: opts(
        "实现有误，行数应与设计一致",
        "设计稿只是画示意行，真实数据行数不同属正常",
        "误报：这两个不是同一个列表"
      ),
    });
  }

  // 2. 设计有、页面找不到（文本已在页面出现的那些已在 compare 里降成 info，不在此列）
  const missing = ex("element", "error");
  if (missing.length) {
    drafts.push({
      prio: 2,
      title: `${missing.length} 个设计元素在页面上找不到对应实现`,
      detail:
        `样例：${samples(missing, (i) => i.designNodeName)}。\n` +
        "无法自动判定的原因：「漏做了」和「产品后来砍掉了」在数据上长得一样 —— " +
        "两者都是设计稿有、页面没有。这一问的答案决定它们算不算缺陷。",
      issueIds: missing.map((i) => i.id),
      options: opts(
        "确认漏做了，需要补上",
        "设计稿画了但产品已砍掉/本轮不做",
        "误报：页面上其实有，只是实现方式不同（合并进父元素、伪元素等）"
      ),
    });
  }

  // 3. 图标/图片单独一问：它们的结构对应天然宽松，答案往往与 2 不同
  const missingGraphic = ex("element", "warning");
  if (missingGraphic.length) {
    drafts.push({
      prio: 4,
      title: `${missingGraphic.length} 个图标/图片未找到独立的实现元素`,
      detail:
        `样例：${samples(missingGraphic, (i) => i.designNodeName)}。\n` +
        "无法自动判定的原因：图标常实现为 CSS 背景图或图标字体，不产生独立盒子 —— " +
        "这时页面上看得见，但结构上确实找不到对应节点。",
      issueIds: missingGraphic.map((i) => i.id),
      options: opts(
        "确认缺图标，需要补上",
        "已用背景图/图标字体实现，结构差异可接受",
        "误报：不该按元素比对（装饰性图形）"
      ),
    });
  }

  // 4. 页面多出的元素
  const extra = ex("extra-element");
  if (extra.length) {
    drafts.push({
      prio: 3,
      title: `页面上有 ${extra.length} 个设计稿里没有的元素`,
      detail:
        `样例：${samples(extra, (i) => i.selector)}。\n` +
        "无法自动判定的原因：可能是组件库自己渲染的内部结构、也可能是设计稿之后加的需求，" +
        "还可能是真的多做了。三种情况在 DOM 里没有区别。",
      issueIds: extra.map((i) => i.id),
      options: opts(
        "确认多做了，应该删掉",
        "组件库内部结构/设计稿之后新增的需求，可接受",
        "误报：设计稿里有，只是没配上"
      ),
    });
  }

  // 5. 配对没确认的那一批：不先答这一问，下面的数值差异读不出「实现对不对」
  const weak = issues.filter((i) => i.severity === "info" && i.downgradedFrom && i.suspectPair);
  if (weak.length >= MIN_CLUSTER) {
    drafts.push({
      prio: 5,
      title: `${weak.length} 条结论的元素配对置信度不足，需先确认比的是不是同一个元素`,
      detail:
        `涉及元素样例：${samples(weak, (i) => i.selector ?? i.designNodeName)}。\n` +
        "无法自动判定的原因：置信度低的时候，「实现画错了」与「我们比错了元素」在数值上无法区分。" +
        "这些结论已暂时降级为待确认、不计入分数；确认配对无误后会恢复原本的严重度。",
      issueIds: weak.map((i) => i.id),
      options: opts(
        "配对没错，按真实偏差处理（恢复严重度并计分）",
        "配对没错，但这些偏差可以接受",
        "误报：配错了元素，这些结论不成立"
      ),
    });
  }

  // 6-8. 全局性的排版替换：多处同一个替换 = 一处全局设置，不是逐处写错
  const typo = active.filter((i) => i.category === "typography");
  const pushTypo = (
    prio: number,
    list: Issue[],
    label: string,
    why: string,
    confirmed: string,
    accept: string
  ) => {
    if (list.length < MIN_CLUSTER) return;
    const i0 = list[0];
    drafts.push({
      prio,
      title: `${label}：设计 ${i0.designValue} → 实际 ${i0.actualValue}，命中 ${list.length} 处`,
      detail: `样例：${samples(list, (i) => i.selector)}。\n${why}`,
      issueIds: list.map((i) => i.id),
      options: opts(confirmed, accept, "误报：这些元素本就不该按设计稿这一项比对"),
    });
  };
  for (const [, list] of groupBy(
    typo.filter((i) => i.property === "font-family"),
    (i) => `${i.designValue}→${i.actualValue}`
  )) {
    pushTypo(
      6,
      list,
      "字体族不一致",
      "多处同一替换通常是字体没加载或运行环境没装这个字体，而不是逐处写错。",
      "确认应改成设计稿的字体",
      "环境所限（系统缺字体/授权问题），可接受"
    );
  }
  for (const [, list] of groupBy(
    typo.filter((i) => i.property === "font-weight"),
    (i) => `${i.designValue}→${i.actualValue}`
  )) {
    pushTypo(
      7,
      list,
      "字重不一致",
      "同一组替换成片出现，一般是一处全局字重设置，改一处即可全部收敛。",
      "确认应改成设计稿的字重",
      "可变字体/字形不全导致的落档，可接受"
    );
  }
  for (const [, list] of groupBy(
    typo.filter((i) => i.property === "line-height"),
    (i) => i.delta ?? ""
  )) {
    pushTypo(
      8,
      list,
      "行高整体偏差",
      "偏差量完全一致说明是同一处全局行高基准，不是逐处调错。",
      "确认应按设计稿改行高",
      "行高基准不同但视觉可接受"
    );
  }

  return drafts
    .sort((a, b) => a.prio - b.prio || b.issueIds.length - a.issueIds.length)
    .slice(0, MAX_QUESTIONS)
    .map((d, n) => ({
      id: `Q${n + 1}`,
      title: d.title,
      detail: d.detail,
      issueIds: d.issueIds,
      options: d.options,
    }));
}
