import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DecisionRecord, Issue, Marker, Question, VerifyResult } from "../types.js";
import { CAT_COLOR, CAT_TITLE, describeIssuePlain, trimNums } from "../diff/describe.js";
import { issueElementKey, scoreAndStatus } from "../rules/score.js";
import { buildFixesText } from "./fixes.js";
import { reportFileName } from "./naming.js";

const SEV_LABEL: Record<string, string> = { error: "错误", warning: "警告", info: "信息" };
const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
/** 筛选器里的类别顺序 */
const CAT_ORDER = ["color", "typography", "geometry", "radius", "border", "grid", "token", "existence", "other"];
/**
 * 标注框只按严重度上色，类别交给筛选器表达。
 *
 * 一张图上同时跑两套颜色语言（类别色 + 严重度色）时，红框到底是"颜色类问题"还是
 * "错误级问题"没人分得清 —— 现在红=错误、橙=警告，只有一种读法。
 */
const SEV_COLOR: Record<string, string> = { error: "#dc2626", warning: "#d97706" };
const SEV_FILL: Record<string, string> = { error: "rgba(220,38,38,.10)", warning: "rgba(217,119,6,.10)" };
/** 编号排序时，纵向差在这个范围内视为同一行 */
const ROW_TOLERANCE = 12;

function esc(s: string | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function writeReport(result: VerifyResult, outDir: string): Promise<{ reportPath: string; jsonPath: string }> {
  await mkdir(outDir, { recursive: true });
  // HTML 名字从 result 里取，而不是从调用方传 —— finalize_report 只拿到 jsonPath，
  // 靠 meta.projectName 才能覆盖掉同一个草稿文件，而不是在旁边多留一份。
  // result.json 的名字不动：finalize_report(jsonPath) 与冒烟都按这个名字找。
  const reportPath = path.join(outDir, reportFileName(result.meta.projectName));
  const jsonPath = path.join(outDir, "result.json");
  await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  await writeFile(reportPath, renderHtml(result), "utf8");
  return { reportPath, jsonPath };
}

/** finalize 裁决后重算分数与结论（被降级的 info 不计分；公式见 rules/score.ts） */
export function recalcSummary(result: VerifyResult): void {
  const { score, status, errors, warnings, info } = scoreAndStatus(result.issues, {
    matched: result.summary.matched,
    unmatchedDesign: result.summary.unmatchedDesign,
    unmatchedCode: result.summary.unmatchedCode,
    needsReview: result.summary.needsReview,
  });
  result.score = score;
  result.status = status;
  result.summary = { ...result.summary, errors, warnings, info, total: result.issues.length };
}
/**
 * 顶栏那条来源链接的短标签。整条 URL 铺在顶栏里，长度几乎全是路径噪声
 * （`file:///Volumes/…/fixtures/sample.html` 里真正有信息的只有末尾那一截），
 * 而顶栏每多占一行，左边的截图就少一行。全路径挂在 title 上，悬停可看。
 */
function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return decodeURIComponent(u.pathname.split("/").pop() || url);
    // 查询串一律不要：验收页常把 caseId/personId 之类的参数带在后面，又长又不该进标题
    const p = u.pathname === "/" ? "" : u.pathname;
    return u.host + (p.length > 28 ? "…" + p.slice(-27) : p);
  } catch {
    return url.length > 40 ? "…" + url.slice(-39) : url;
  }
}

function statusBadge(status: string): string {
  const map: Record<string, [string, string]> = {
    PASS: ["#16a34a", "✅ 通过"],
    FAIL: ["#dc2626", "❌ 未通过"],
    NEEDS_REVIEW: ["#d97706", "⚠️ 需人工复核"],
  };
  const [bg, text] = map[status] ?? ["#6b7280", status];
  return `<span class="badge" style="background:${bg}">${text}</span>`;
}

/** 一个元素上的一组问题：图上一个框、右侧一张卡片 */
interface Group {
  /** 与 meta.markers[].key 同源（issueElementKey） */
  key: string;
  issues: Issue[];
  /** 组内最高严重度 */
  sev: "error" | "warning";
  cats: string[];
  /** 每个类别在这个元素上的最高严重度：筛选到某类时框色用它 */
  catSev: Record<string, "error" | "warning">;
  marker?: Marker;
  /** 图上的角标序号；无标注的组没有 */
  n?: number;
}
/**
 * 按元素聚合，并给能在图上定位的组编号。
 *
 * 编号一次编定、按阅读顺序（先上后下、同一行先左后右），筛选时只隐藏、不重编 ——
 * 这样"图上的 ⑦"永远是"右侧第 7 张卡片"，用户记住的位置不会因为切了筛选而失效。
 */
function buildGroups(active: Issue[], markers?: Marker[]): { staged: Group[]; loose: Group[] } {
  const map = new Map<string, Group>();
  for (const i of active) {
    const key = issueElementKey(i);
    let g = map.get(key);
    if (!g) {
      g = { key, issues: [], sev: "warning", cats: [], catSev: {} };
      map.set(key, g);
    }
    g.issues.push(i);
    if (i.severity === "error") g.sev = "error";
    if (!g.cats.includes(i.category)) g.cats.push(i.category);
    if (i.severity === "error") g.catSev[i.category] = "error";
    else if (!g.catSev[i.category]) g.catSev[i.category] = "warning";
  }

  const staged: Group[] = [];
  const loose: Group[] = [];
  for (const g of map.values()) {
    const m = markers?.find((mk) => mk.key === g.key);
    if (m) {
      g.marker = m;
      staged.push(g);
    } else {
      loose.push(g);
    }
  }
  staged.sort((a, b) => {
    const A = a.marker!;
    const B = b.marker!;
    return Math.abs(A.y - B.y) > ROW_TOLERANCE ? A.y - B.y : A.x - B.x;
  });
  staged.forEach((g, k) => {
    g.n = k + 1;
  });
  loose.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.issues.length - a.issues.length);
  return { staged, loose };
}

/** 悬停角标时的摘要：首行是编号/条数/类别，其后每行一条结论 */
function groupTip(g: Group): string {
  const cats = g.cats.map((c) => CAT_TITLE[c] ?? c).join(" / ");
  const lines = g.issues.slice(0, 4).map(describeIssuePlain);
  if (g.issues.length > 4) lines.push(`……还有 ${g.issues.length - 4} 条，点角标看右侧卡片`);
  return [`#${g.n} · ${g.issues.length} 条 · ${cats}`, ...lines].join("\n");
}
/**
 * 图上一个标注框 + 左上角角标。
 *
 * 坐标是实现侧的 CSS 像素（marker 取自 codeNode.rect），按截图尺寸换成百分比，
 * 这样叠加层缩放时框跟着走。注意：框始终画在实现坐标上 —— 切到"仅设计稿"时，
 * 两侧画布尺寸不同的那部分对不齐，此时看 .sizewarn 给出的两个尺寸。
 */
function annoHtml(g: Group, cssW: number, cssH: number): string {
  const m = g.marker!;
  // 元素可能越出截图（例如 top:-10px 的角标徽章）。先把矩形裁进画布再换百分比 ——
  // 直接把 top 夹到 0 会让框整体下移，比元素本身高出越界的那一截。
  const x0 = Math.max(0, m.x);
  const y0 = Math.max(0, m.y);
  const x1 = Math.min(cssW, m.x + m.w);
  const y1 = Math.min(cssH, m.y + m.h);
  const pct = (v: number, base: number) => Math.max(0, Math.min(100, (v / base) * 100));
  const L = pct(x0, cssW);
  const T = pct(y0, cssH);
  const W = pct(Math.max(0, x1 - x0), cssW);
  const H = pct(Math.max(0, y1 - y0), cssH);
  // 贴边元素的角标往里收，否则会被画布边缘裁掉一半
  const edge = `${L < 1.2 ? " nx" : ""}${T < 1.2 ? " ny" : ""}`;
  return (
    `<div class="anno${edge}" data-n="${g.n}" data-key="${esc(g.key)}" data-sev="${g.sev}" data-sev-all="${g.sev}"` +
    ` data-cats="${esc(g.cats.join(" "))}" data-catsev="${esc(JSON.stringify(g.catSev))}"` +
    ` data-tip="${esc(groupTip(g))}"` +
    ` style="left:${L.toFixed(3)}%;top:${T.toFixed(3)}%;width:${W.toFixed(3)}%;height:${H.toFixed(3)}%">` +
    `<i class="num">${g.n}</i></div>`
  );
}
/** 右侧一张卡片 = 一个元素上的全部结论 */
function elementItem(g: Group): string {
  const list = g.issues;
  const first = list[0];
  const selShort = first.selector ? first.selector.split(" > ").slice(-2).join(" > ") : "(无对应实现元素)";
  const plainLines = list.map(describeIssuePlain);
  const rawRows = list
    .map(
      (i) =>
        `<div class="raw-row"><span><i>${esc(CAT_TITLE[i.category] ?? "")}</i><code>${esc(i.property)}</code></span>` +
        `<span class="vd">${esc(trimNums(i.designValue, i.property))}</span><span class="arr">→</span>` +
        `<span class="va">${esc(trimNums(i.actualValue, i.property))}</span>${i.delta ? `<b>${esc(trimNums(i.delta))}</b>` : ""}</div>`
    )
    .join("");
  let badge = "";
  if (first.verified || list.some((i) => i.verified)) badge = `<span class="pill pill-ok">已确认</span>`;
  else if (list.some((i) => i.adjudication?.startsWith("[误报"))) badge = `<span class="pill pill-info">误报</span>`;
  else if (list.some((i) => i.adjudication)) badge = `<span class="pill pill-info">已豁免</span>`;

  // 配对可信度：结论的前提是「两侧比的是同一个元素」，前提不牢时必须写在结论旁边，
  // 否则匹配算法的失败会被读成前端的缺陷。
  const suspect = list.find((i) => i.suspectPair);
  const conflict = list.find((i) => i.orderConflict);
  const caveats: string[] = [];
  if (suspect) {
    caveats.push(
      `配对置信度仅 ${Math.round((suspect.matchScore ?? 0) * 100)}%：请先确认页面上这个元素就是设计稿里的「${suspect.designNodeName ?? ""}」，下面的结论已因此降级为待确认`
    );
  }
  if (conflict) {
    caveats.push(
      `它与「${conflict.orderConflict}」的前后顺序和设计稿相反：可能是排版顺序错了，也可能是这两个元素被配错了对`
    );
  }
  const caveatHtml = caveats.length
    ? `<ul class="plain caveat">${caveats.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
    : "";
  const idx = g.n
    ? `<i class="idx">${g.n}</i>`
    : `<i class="idx off" title="实现里找不到对应元素，无法在图上框选">–</i>`;

  return `
  <div class="item flt" data-n="${g.n ?? ""}" data-key="${esc(g.key)}" data-sev="${g.sev}" data-cats="${esc(g.cats.join(" "))}">
    <div class="item-head">
      ${idx}<span class="pill pill-${g.sev}">${SEV_LABEL[g.sev]}</span>${badge}${
        caveats.length ? `<span class="pill pill-info">配对待确认</span>` : ""
      }
      <code class="loc" title="${esc(first.selector ?? "")}">📍 ${esc(selShort)}</code>
      ${list.length > 1 ? `<span class="mini">${list.length} 条</span>` : ""}
    </div>
    <ul class="plain">${plainLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    ${caveatHtml}
    <details class="raw"><summary>精确数值</summary>${rawRows}</details>
  </div>`;
}
/** 左侧唯一的对比舞台：实现截图 + 设计稿叠加层 + 全部标注 */
function stageBlock(
  annos: string,
  actualFile: string,
  designFile: string | undefined,
  size: { cssW: number; cssH: number; designW?: number; designH?: number }
): string {
  // 叠加层按「设计稿画布 ÷ 实现画布」的真实比例放，不能 width:100% 拉满 ——
  // 拉满等于把「宽度差」这类偏差在视觉上抹平，而它恰恰是报告正在报的那条。
  const ratio = size.designW && size.cssW ? size.designW / size.cssW : 1;
  const imgStyle = Math.abs(ratio - 1) > 0.001 ? ` style="width:${(ratio * 100).toFixed(3)}%"` : "";
  const mismatch =
    size.designW && size.designH && (size.designW !== size.cssW || size.designH !== size.cssH)
      ? `<span class="sizewarn">画布尺寸不同：设计 ${size.designW}×${size.designH} · 实现 ${size.cssW}×${size.cssH}` +
        `（叠加层按真实比例对齐左上角，超出部分被裁掉）</span>`
      : "";
  const overlay = designFile
    ? `<div class="design-layer"><img src="${esc(designFile)}" alt="设计稿"${imgStyle}></div><div class="divider"></div>`
    : "";
  return `
    <div class="canvas-wrap">
      <div class="compare" id="compare">
        <div class="stage" id="stage">
          <img class="layer" src="${esc(actualFile)}" alt="实现截图">
          ${overlay}
          ${annos}
        </div>
      </div>
      <div class="under">
        ${
          designFile
            ? `<input type="range" class="slider" id="slider" min="0" max="100" value="55">`
            : `<span class="noimg">缺 design.png：把设计稿导出放进报告目录后重新生成，即可叠加对比</span>`
        }
        <span class="legend">悬停角标看问题 · 点角标跳右侧卡片</span>
        <span class="zoombar">
          <button class="zbtn" id="z-out" title="缩小">−</button>
          <span id="zpct" title="点一下回到 100%（1 截图像素 = 1 屏幕像素）">100%</span>
          <button class="zbtn" id="z-in" title="放大（⌘/Ctrl+滚轮 也可以，放大后可拖拽平移）">+</button>
          <button class="zbtn wide" id="z-fit" title="铺满宽度（双击图片可在 100% 与铺满之间切换）">适应</button>
        </span>
      </div>
      ${mismatch}
    </div>`;
}

/** 裁决动词的短标签。按钮上先出「确认/可接受/误报」，再接问题定制的长文案 */
const VERDICT_TAG: Record<string, string> = {
  confirmed: "确认",
  accept: "可接受",
  reject: "误报",
};

/**
 * 待裁决问题面板。
 *
 * 这些是机器判不了的那一批（设计意图、第三方组件、真实数据行数）。不画出来的话，
 * 直接打开 HTML 的人看到的是一份「已经定论」的清单 —— 而分数里其实还悬着一批
 * 没算完的结论，报告读起来比实际情况更确定。
 *
 * 静态 HTML 没法自己回写 result.json，所以出口是「点选 → 复制成 decisions」：
 * 人不经过 AI 也能把裁决递回 finalize_report。已裁决过的问题回显既有选择。
 */
function questionBlock(qs: Question[], decisions: DecisionRecord[]): string {
  if (!qs.length) return "";
  const done = new Map(decisions.map((d) => [d.id, d]));
  const covered = qs.reduce((n, q) => n + q.issueIds.length, 0);
  const cards = qs
    .map((q) => {
      const d = done.get(q.id);
      const opts = q.options
        .map(
          (o) =>
            `<button class="qopt${d?.verdict === o.verdict ? " on" : ""}" data-v="${o.verdict}">` +
            `<i>${esc(VERDICT_TAG[o.verdict] ?? o.verdict)}</i>${esc(o.label)}</button>`
        )
        .join("");
      return (
        `<div class="qcard" data-q="${esc(q.id)}"${d ? ` data-done="1"` : ""}>` +
        `<div class="qt"><b>${esc(q.id)}</b>${esc(q.title)}` +
        `<span class="qcov">覆盖 ${q.issueIds.length} 条${
          d ? ` · 已裁决为「${esc(VERDICT_TAG[d.verdict] ?? d.verdict)}」` : ""
        }</span></div>` +
        `<div class="qd">${esc(q.detail).replace(/\n/g, "<br>")}</div>` +
        `<div class="qopts">${opts}</div>` +
        `</div>`
      );
    })
    .join("");
  return (
    `<section class="qbox">` +
    `<div class="qhead">🤔 需你裁决 · ${qs.length} 个问题，覆盖 ${covered} 条结论` +
    `<button class="copybtn" onclick="copyDecisions(this)">复制裁决</button></div>` +
    `<div class="qnote">这几处机器判不了，所以它们还挂在分数里。逐个选完点「复制裁决」，` +
    `把那段 JSON 交给 AI 调 finalize_report 即可落正式报告。</div>` +
    cards +
    `</section>`
  );
}

function renderHtml(r: VerifyResult): string {
  const s = r.summary;
  const active = r.issues.filter((i) => i.severity !== "info");
  const dismissed = r.issues.filter((i) => i.severity === "info");
  const decisions = r.decisions ?? [];
  const cssW = r.meta.cssW || 1920;
  const cssH = r.meta.cssH || 1080;
  const designFile = r.meta.designScreenshotPath ? path.basename(r.meta.designScreenshotPath) : undefined;
  const actualFile = r.meta.actualScreenshotPath ? path.basename(r.meta.actualScreenshotPath) : "actual.png";

  const { staged, loose } = buildGroups(active, r.meta.markers);
  const annos = staged.map((g) => annoHtml(g, cssW, cssH)).join("\n          ");
  const total = staged.length + loose.length;

  // 筛选按元素、不按条：一个元素只要含该类问题就整体保留，卡片仍列出它全部的结论。
  // 否则卡片头上那个「N 条」会随筛选说假话。
  const catCount = new Map<string, number>();
  for (const g of [...staged, ...loose]) for (const c of g.cats) catCount.set(c, (catCount.get(c) ?? 0) + 1);
  const catList = [...catCount.keys()].sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
  const filterPills =
    `<button class="fpill on" data-cat="all">全部<b>${total}</b></button>` +
    catList
      .map(
        (c) =>
          `<button class="fpill" data-cat="${esc(c)}"><i class="dot" style="background:${CAT_COLOR[c] ?? "#6b7280"}"></i>` +
          `${esc(CAT_TITLE[c] ?? c)}<b>${catCount.get(c)}</b></button>`
      )
      .join("");
  const cards = staged.map(elementItem).join("\n");
  const looseBlock = loose.length
    ? `<div class="loose-head flt" data-cats="${esc([...new Set(loose.flatMap((g) => g.cats))].join(" "))}">` +
      `图上无标注 · ${loose.length} 处（实现里找不到对应元素，只能列在这里）</div>` +
      loose.map(elementItem).join("\n")
    : "";
  const dismissedBlock = dismissed.length
    ? `<details class="dis"><summary>已豁免 / 误报 / 信息项 · ${dismissed.length} 条（不计分）</summary>` +
      dismissed
        .map(
          (i) =>
            `<div class="drow">${esc(CAT_TITLE[i.category] ?? "")} — ${esc(describeIssuePlain(i))}${
              i.adjudication ? ` <em>· ${esc(i.adjudication)}</em>` : ""
            }</div>`
        )
        .join("") +
      `</details>`
    : "";

  const modeBtn = (mode: string, label: string, needsDesign: boolean) =>
    `<button class="mbtn${(designFile ? mode === "split" : mode === "actual") ? " on" : ""}" data-mode="${mode}"${
      needsDesign && !designFile ? " disabled" : ""
    }>${label}</button>`;
  const modeBtns =
    modeBtn("split", "滑块对比", true) +
    modeBtn("design", "仅设计稿", true) +
    modeBtn("actual", "仅实现", false) +
    modeBtn("fade", "半透明叠加", true);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(r.meta.projectName ? `${r.meta.projectName}验收报告` : "design-gate 验收报告")} — ${esc(r.meta.webUrl)}</title>
<style>
  :root {
    color-scheme:light;
    --line:#deddd6;
    --line-soft:#ecebe5;
    --ink:#1c1c1a;
    --sub:#6d6b64;
    --paper:#fff;
    --soft:#f7f7f3;
    --black:#181816;
    --cream:#f8eedc;
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html,body { height:100%; }
  body { margin:0; font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    background:#f1f5f9; color:var(--ink); display:flex; flex-direction:column; overflow:hidden;
    font-size:13px; -webkit-font-smoothing:antialiased; }

  /* ---------- 顶栏：刻意压成两排 ----------
     第一排 标题+状态+来源链接+计数，第二排 分类筛选+视图开关。顶栏每多一排，
     左边的截图就少一排的高度，而这份报告的主体就是那张图。
     分数环去掉了：门禁结论看「未通过」徽章，差多少看错误/警告数，
     一个 0-100 的分数夹在这两者中间没有新信息，却占掉 44px 的行高。 */
  header { background:#fff; border-bottom:1px solid var(--line); padding:13px 24px 12px; flex:none; }
  .hrow { display:flex; align-items:center; gap:12px; min-width:0; }
  header h1 { font-size:16px; margin:0; font-weight:700; letter-spacing:0; display:flex; align-items:center; gap:9px; min-width:0; }
  /* 项目名可能很长（60 字上限），让它省略号收尾，别把状态徽章挤扁 */
  header h1 .htitle { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .badge { flex:none; padding:4px 10px; border-radius:999px; color:#fff; font-weight:700; font-size:11px;
    letter-spacing:.01em; box-shadow:0 0 0 2px #fff,0 0 0 3px rgba(24,24,22,.12); }
  /* 来源收成一个短链接（全路径在 title 里）；file:// 报告里它也是可点的 */
  .src { flex:none; max-width:30%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    display:inline-flex; align-items:center; min-height:27px; padding:4px 10px; border:1px solid var(--line);
    border-radius:999px; background:#fff; color:var(--black); font-size:11px; text-decoration:none; }
  .src:hover { background:var(--soft); border-color:var(--black); }
  .hstat { flex:none; color:var(--sub); font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:10.5px; letter-spacing:.01em; white-space:nowrap; }
  .ctrls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:12px; padding-top:11px;
    border-top:1px solid var(--line-soft); }
  .fpill { display:inline-flex; align-items:center; gap:6px; font-size:12px; background:#fff; color:var(--ink);
    border:1px solid var(--line); border-radius:999px; padding:6px 11px; cursor:pointer; white-space:nowrap;
    transition:background-color .16s ease,border-color .16s ease,color .16s ease; }
  .fpill:hover { background:var(--soft); border-color:var(--black); }
  .fpill.on { background:var(--black); border-color:var(--black); color:#fff; }
  .fpill b { font-weight:700; opacity:.7; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; }
  .spacer { flex:1; }
  .tg { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:var(--sub); cursor:pointer;
    user-select:none; white-space:nowrap; }
  .tg input { accent-color:var(--black); }
  .seg { display:inline-flex; gap:2px; padding:2px; background:var(--soft); border:1px solid var(--line);
    border-radius:999px; overflow:hidden; }
  .mbtn { font-size:11.5px; background:transparent; color:var(--ink); border:none; border-radius:999px;
    padding:6px 11px; cursor:pointer; white-space:nowrap; transition:background-color .16s ease,color .16s ease; }
  .mbtn:hover { background:#fff; }
  .mbtn.on { background:var(--black); color:#fff; }
  .mbtn:disabled { color:#b9b8b1; background:transparent; cursor:not-allowed; }
  .fpill:focus-visible,.mbtn:focus-visible,.tg input:focus-visible,.zbtn:focus-visible,
  .copybtn:focus-visible,.qopt:focus-visible,.item:focus-visible { outline:2px solid var(--black); outline-offset:2px; }

  /* ---------- 一屏两栏：左舞台 + 右卡片列表 ---------- */
  /* grid-template-rows 必须显式写 minmax(0,1fr)：默认的 auto 行会被卡片列表撑到内容高度，
     整页跟着长出滚动条 —— 一屏的前提是这一行不许比视口高。
     右栏宽度用 clamp 钉一个「够读」的档位而不是 fr：卡片是文字列表，再宽也只是让每行更长；
     左栏宽度却直接决定截图的渲染倍率（.stage img{width:100%}），所以剩下的宽度全归左边。 */
  main.layout { flex:1; min-height:0; overflow:hidden; display:grid; grid-template-rows:minmax(0,1fr);
    grid-template-columns:minmax(0,1fr) clamp(332px,27%,430px); gap:16px; padding:16px 24px 20px; }
  .left-col { display:flex; flex-direction:column; gap:12px; min-width:0; }
  .canvas-wrap { background:#fff; border:1px solid var(--line); border-radius:16px; padding:10px;
    box-shadow:0 5px 18px rgba(24,24,22,.045);
    flex:1; min-height:0; display:flex; flex-direction:column; }
  .compare { position:relative; flex:1; min-height:0; overflow:auto; border:1px solid #f1f1ec; border-radius:10px;
    user-select:none; line-height:0; background:#f7f7f3; }
  .stage { position:relative; line-height:0; }
  .stage img.layer { width:100%; display:block; }
  .design-layer { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
  .design-layer img { position:absolute; top:0; left:0; width:100%; max-width:none; }
  .divider { position:absolute; top:0; bottom:0; width:2px; background:#fff; cursor:ew-resize; z-index:5;
    box-shadow:0 0 0 1px rgba(15,23,42,.28); }
  .divider::after { content:"⇄"; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
    width:26px; height:26px; border-radius:50%; background:#fff; color:#334155; font-size:13px;
    display:flex; align-items:center; justify-content:center; box-shadow:0 1px 6px rgba(15,23,42,.3); }
  .under { display:flex; align-items:center; gap:12px; padding:10px 3px 1px; flex:none; }
  input.slider { flex:1; accent-color:#334155; }
  .legend { color:var(--sub); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px;
    letter-spacing:.02em; white-space:nowrap; }
  .noimg { flex:1; font-size:11px; color:#825500; background:var(--cream); border-radius:999px; padding:5px 10px; }
  /* 缩放条挂在滑块那一排里，不额外占高度。百分比是「截图 CSS 像素 : 屏幕像素」，
     所以 100% 就是 1:1 原始尺寸 —— 报告是拿来量偏差的，倍率必须有确定含义，
     不能是「相对适应宽度的百分比」那种随窗口漂移的数。 */
  .zoombar { flex:none; display:inline-flex; align-items:center; gap:3px; }
  .zbtn { width:28px; height:28px; padding:0; border:1px solid var(--line); background:#fff; color:var(--black);
    border-radius:50%; font-size:14px; line-height:1; cursor:pointer; transition:background-color .16s ease,border-color .16s ease; }
  .zbtn:hover { background:#f1f2ef; border-color:var(--line); }
  .zbtn.wide { width:auto; padding:0 10px; border-radius:999px; font-size:10.5px; }
  #zpct { min-width:42px; text-align:center; font-size:11px; color:var(--sub); cursor:pointer;
    font-variant-numeric:tabular-nums; }
  .compare.pannable { cursor:grab; }
  .compare.panning { cursor:grabbing; }
  .sizewarn { flex:none; margin-top:6px; font-size:10.5px; line-height:1.5; color:#825500;
    background:var(--cream); border:1px solid #ead39c; border-radius:999px; padding:5px 10px; }

  /* ---------- 标注：红框=错误 橙框=警告，角标压在左上角 ---------- */
  /* 平时只描边不填色：标注是嵌套的（根元素那一框罩住整张图），每层都填 10% 红
     会叠成一片粉，"哪一块有问题"就没了。填色留给聚焦时的那一个。 */
  .anno { position:absolute; z-index:6; pointer-events:none; min-width:12px; min-height:12px;
    outline:2px solid var(--ac); border-radius:4px;
    transition:opacity .13s ease, background-color .13s ease; }
  .anno[data-sev="error"] { --ac:${SEV_COLOR.error}; --af:${SEV_FILL.error}; }
  .anno[data-sev="warning"] { --ac:${SEV_COLOR.warning}; --af:${SEV_FILL.warning}; }
  .num { position:absolute; left:0; top:0; transform:translate(-50%,-50%); pointer-events:auto; cursor:pointer;
    min-width:20px; height:20px; padding:0 5px; border-radius:999px; background:var(--ac); color:#fff;
    font-size:11px; font-weight:700; font-style:normal; line-height:1; display:flex; align-items:center;
    justify-content:center; border:1.5px solid #fff; box-shadow:0 1px 4px rgba(15,23,42,.35); }
  .anno.nx .num { transform:translate(0,-50%); }
  .anno.ny .num { transform:translate(-50%,0); }
  .anno.nx.ny .num { transform:none; }
  /* 聚焦：悬停一个标注，其余压暗到只剩存在感；被聚焦的那一个才填色 */
  .stage.dim .anno:not(.focus) { opacity:.12; }
  .anno.focus { z-index:9; outline-width:3px; background:var(--af); }
  .anno.focus .num { box-shadow:0 0 0 3px rgba(255,255,255,.9),0 2px 9px rgba(15,23,42,.45); }
  .stage.no-anno .anno { display:none; }
  .stage.no-num .num { display:none; }
  .anno.pulse .num { animation:npulse .75s ease 2; }
  @keyframes npulse { 50% { box-shadow:0 0 0 9px rgba(37,99,235,.35); } }

  /* ---------- 右栏卡片 ---------- */
  .right-col { display:flex; flex-direction:column; gap:10px; min-height:0; }
  .rhead { display:flex; align-items:baseline; gap:8px; font-size:10.5px; color:var(--sub); flex:none;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.01em; }
  .rhead b { font-family:ui-sans-serif,-apple-system,sans-serif; font-size:15px; color:var(--ink); }
  .right-scroll { flex:1; min-height:0; overflow-y:auto; padding:1px 4px 2px 0;
    display:flex; flex-direction:column; gap:9px; }
  .item { background:#fff; border:1px solid var(--line); border-left:4px solid var(--cc); border-radius:12px;
    padding:11px 13px; cursor:pointer; scroll-margin:12px; transition:border-color .16s ease,box-shadow .16s ease; }
  .item[data-sev="error"] { --cc:${SEV_COLOR.error}; }
  .item[data-sev="warning"] { --cc:${SEV_COLOR.warning}; }
  .item:hover { border-color:var(--black); box-shadow:0 3px 12px rgba(24,24,22,.08); }
  .item.focus { box-shadow:0 0 0 2px var(--black); }
  .item-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .idx { flex:none; width:23px; height:23px; border-radius:999px; background:var(--cc); color:#fff;
    font-size:11px; font-weight:700; font-style:normal; display:flex; align-items:center; justify-content:center; }
  .idx.off { background:#e2e8f0; color:#94a3b8; }
  .pill { font-size:10px; padding:3px 8px; border-radius:999px; font-weight:700; }
  .pill-error { background:#fee2e2; color:#991b1b; }
  .pill-warning { background:#fef3c7; color:#92400e; }
  .pill-info { background:#e2e8f0; color:#475569; }
  .pill-ok { background:#dcfce7; color:#166534; }
  .loc { font-size:10.5px; color:var(--sub); font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
  .mini { margin-left:auto; font-size:10.5px; color:#94a3b8; }
  ul.plain { list-style:none; margin:6px 0 0; padding:0; }
  ul.plain li { font-size:12.5px; line-height:1.62; color:#35342f; padding-left:12px; position:relative; }
  ul.plain li::before { content:""; position:absolute; left:0; top:8px; width:4px; height:4px;
    border-radius:50%; background:var(--cc); }
  ul.caveat li { color:#92400e; }
  ul.caveat li::before { background:#d97706; }
  details.raw { margin-top:8px; padding-top:7px; border-top:1px solid var(--line-soft); }
  details.raw summary { font-size:10.5px; color:var(--sub); cursor:pointer; }
  details.raw summary:hover { color:#2563eb; }
  .raw-row { display:flex; gap:8px; align-items:baseline; font-size:11px; padding:4px 0;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; flex-wrap:wrap; }
  .raw-row i { color:#94a3b8; font-style:normal; margin-right:5px; }
  /* 右栏收窄之后值必须能断行：min-width:0 解开 flex 项的最小内容宽度，
     overflow-wrap:anywhere 兜住 font-family 这种没有断点的长串。 */
  .raw-row > span { min-width:0; overflow-wrap:anywhere; }
  .raw-row .vd { color:#065f46; background:#ecfdf5; padding:0 6px; border-radius:4px; }
  .raw-row .va { color:#7f1d1d; background:#fef2f2; padding:0 6px; border-radius:4px; }
  .raw-row .arr { color:#cbd5e1; }
  .raw-row b { color:#b45309; }
  .loose-head { font-size:10.5px; color:var(--sub); padding:9px 2px 2px; border-top:1px dashed var(--line); }
  /* ---------- 修复代码块：整体弱化，不跟报告抢注意力 ---------- */
  .fixbox { flex:none; height:148px; display:flex; flex-direction:column; background:var(--cream);
    border:1px solid #eadfca; border-radius:14px; padding:10px 13px; }
  .fixhead { display:flex; align-items:center; gap:8px; font-size:10.5px; color:#63533a; margin-bottom:7px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .copybtn { margin-left:auto; background:var(--black); color:#fff; border:1px solid var(--black); border-radius:999px;
    padding:5px 12px; font-size:10.5px; cursor:pointer; }
  .copybtn:hover { background:#35352f; }
  .fixbox pre { margin:0; overflow:auto; font-size:10.5px; line-height:1.65; color:#554934;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }

  /* 待裁决面板：橙色是「悬而未决」，与红=错误、灰=已豁免区分开 */
  .qbox { flex:none; background:#fff3cf; border:1px solid #e7c96e; border-left:4px solid #d08a00;
    border-radius:14px; padding:11px 13px; margin-bottom:9px; }
  .qhead { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; color:#6f4d00; }
  .qnote { font-size:11.5px; line-height:1.6; color:#6d634e; margin:6px 0 3px; }
  .qcard { border-top:1px solid #f1f5f9; margin-top:7px; padding-top:8px; }
  .qcard[data-done] { opacity:.7; }
  .qt { font-size:12.5px; line-height:1.55; color:var(--ink); }
  .qt b { color:#b45309; margin-right:5px; }
  .qcov { color:var(--sub); font-size:11px; margin-left:6px; white-space:nowrap; }
  .qd { font-size:11.5px; line-height:1.65; color:#475569; margin:4px 0 7px; }
  .qopts { display:flex; flex-wrap:wrap; gap:6px; }
  .qopt { display:inline-flex; align-items:center; gap:5px; text-align:left; background:#fffaf0;
    color:#554a35; border:1px solid #decf9c; border-radius:999px; padding:5px 10px;
    font-size:11.5px; font-family:inherit; cursor:pointer; }
  .qopt:hover { background:#fff; border-color:#9f7a1c; }
  .qopt.on { background:var(--black); color:#fff; border-color:var(--black); }
  .qopt i { font-style:normal; font-size:10.5px; opacity:.65; }

  details.dis { background:#fff; border:1px dashed var(--line); border-radius:12px; padding:9px 12px;
    font-size:11.5px; color:var(--sub); flex:none; }
  details.dis summary { cursor:pointer; }
  .drow { padding:5px 0; border-top:1px solid #f1f5f9; font-size:12px; color:#475569; }
  .drow em { color:#94a3b8; font-style:normal; }

  .tip { position:fixed; z-index:99; display:none; max-width:330px; background:var(--black); color:#fff;
    font-size:12px; line-height:1.65; padding:9px 12px; border-radius:10px; border:1px solid var(--black);
    box-shadow:0 6px 18px rgba(24,24,22,.18); pointer-events:none; white-space:pre-line; }
  .tip::first-line { font-weight:600; }

  /* 窄屏放弃一屏，恢复整页滚动 */
  @media (max-width:1080px) {
    body { overflow:auto; }
    header { padding-left:18px; padding-right:18px; }
    main.layout { grid-template-columns:1fr; grid-template-rows:auto; overflow:visible; padding:14px 18px 18px; }
    .canvas-wrap { min-height:60vh; }
    .right-scroll { max-height:none; overflow:visible; }
  }
  @media (max-width:640px) {
    header { padding:12px 14px 11px; }
    .hrow { align-items:flex-start; flex-wrap:wrap; gap:8px; }
    header h1 { flex:1 1 100%; font-size:15px; }
    .src { max-width:48%; }
    .hstat { width:100%; white-space:normal; line-height:1.5; }
    .ctrls { gap:7px; margin-top:10px; padding-top:10px; }
    .ctrls > .spacer { display:none; }
    .tg { order:3; }
    .seg { order:4; width:100%; }
    .mbtn { flex:1; }
    main.layout { padding:10px 12px 14px; gap:10px; }
    .canvas-wrap { border-radius:13px; padding:7px; min-height:52vh; }
    .under { flex-wrap:wrap; gap:8px; }
    .under .slider { flex:1 1 100%; order:0; }
    .legend { flex:1 1 100%; order:1; }
    .zoombar { margin-left:auto; order:2; }
    .noimg { flex:1 1 100%; }
    .fixbox { height:172px; }
  }
</style>
</head>
<body>
<header>
  <div class="hrow">
    <h1><span class="htitle">${esc(r.meta.projectName ? `${r.meta.projectName} 设计验收报告` : "design-gate 设计验收报告")}</span> ${statusBadge(r.status)}</h1>
    <a class="src" target="_blank" href="${esc(r.meta.webUrl)}" title="${esc(r.meta.webUrl)}">${esc(linkLabel(r.meta.webUrl))} ↗</a>${
      r.meta.figmaUrl ? `<a class="src" target="_blank" href="${esc(r.meta.figmaUrl)}">Figma ↗</a>` : ""
    }
    <span class="spacer"></span>
    <span class="hstat">视口 ${esc(r.meta.viewport)} · 匹配 ${s.matched} 对 · 错误 <b style="color:${SEV_COLOR.error}">${s.errors}</b> / 警告 <b style="color:${SEV_COLOR.warning}">${s.warnings}</b>${
      decisions.length ? ` · 已裁决 ${decisions.length}` : ""
    }</span>
  </div>
  <div class="ctrls">
    ${filterPills}
    <span class="spacer"></span>
    <label class="tg"><input type="checkbox" id="tg-anno" checked>显示标注</label>
    <label class="tg"><input type="checkbox" id="tg-num" checked>显示编号</label>
    <div class="seg">${modeBtns}</div>
  </div>
</header>
<main class="layout">
  <div class="left-col">
    ${stageBlock(annos, actualFile, designFile, { cssW, cssH, designW: r.meta.designW, designH: r.meta.designH })}
    <div class="fixbox">
      <div class="fixhead">🛠️ 全量修复代码（与 fixes.txt 同源，不随筛选变化）
        <button class="copybtn" onclick="copyFixes(this)">复制</button></div>
      <pre>${esc(buildFixesText(active, "design-gate 全量修复清单"))}</pre>
    </div>
  </div>
  <div class="right-col">
    <div class="rhead"><b id="shown">${total}</b>/ ${total} 处问题元素
      <span class="spacer"></span><span>编号按阅读顺序，与图上角标一一对应</span></div>
    <div class="right-scroll">
      ${questionBlock(r.questions ?? [], decisions)}
      ${cards}
      ${looseBlock}
      ${dismissedBlock}
    </div>
  </div>
</main>

<div class="tip" id="tip"></div>

<script>
const stage=document.getElementById('stage');
const tip=document.getElementById('tip');

/* ---- 叠加对比：滑块 / 仅设计稿 / 仅实现 / 半透明 ---- */
(function(){
  const compare=document.getElementById('compare');
  const design=compare.querySelector('.design-layer');
  const divider=compare.querySelector('.divider');
  const slider=document.getElementById('slider');
  let dragging=false;
  function setSplit(p){
    if(!design)return;
    design.style.clipPath='inset(0 '+(100-p)+'% 0 0)';
    design.style.opacity='';
    if(divider)divider.style.left=p+'%';
  }
  function setMode(m){
    document.querySelectorAll('.mbtn').forEach(b=>b.classList.toggle('on',b.dataset.mode===m));
    if(!design)return;
    divider.style.display=(m==='split')?'block':'none';
    if(m==='split')setSplit(+slider.value);
    else if(m==='design'){design.style.clipPath='none';design.style.opacity='1';}
    else if(m==='actual')design.style.clipPath='inset(0 100% 0 0)';
    else {design.style.clipPath='none';design.style.opacity='.5';}
  }
  document.querySelectorAll('.mbtn').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  if(slider){
    slider.addEventListener('input',()=>setMode('split'));
    divider.addEventListener('pointerdown',e=>{dragging=true;e.preventDefault();});
    window.addEventListener('pointermove',e=>{
      if(!dragging)return;
      // 用 stage 而不是 compare 的盒子：放大之后 stage 比可视框宽，
      // 拿可视框算百分比会把分割线钉在错的地方
      const box=stage.getBoundingClientRect();
      const p=Math.min(100,Math.max(0,(e.clientX-box.left)/box.width*100));
      slider.value=Math.round(p);setSplit(p);
    });
    window.addEventListener('pointerup',()=>{dragging=false;});
  }
  setMode(design?'split':'actual');
})();
/* ---- 截图缩放：适应宽度 ⇄ 原始像素 ----
   倍率定义成「截图 CSS 像素 : 屏幕像素」，100% 就是 1:1，含义固定、不随窗口漂。
   实现上直接改 stage 的 px 宽度而不是 transform：图和标注都是 % 定位，会跟着一起缩放，
   文字不会被 transform 糊掉，而且 .compare 的滚动区真实变大 —— 滚轮和拖拽都是原生行为。 */
(function(){
  const compare=document.getElementById('compare');
  const NAT=${cssW}||1920;
  const pct=document.getElementById('zpct');
  let scale=1,fit=true;
  const fitScale=()=>Math.max(0.02,compare.clientWidth/NAT);
  function paint(){
    stage.style.width=(NAT*scale)+'px';
    pct.textContent=Math.round(scale*100)+'%';
    compare.classList.toggle('pannable',
      stage.offsetWidth>compare.clientWidth+1||stage.offsetHeight>compare.clientHeight+1);
  }
  function zoomTo(s,ax,ay){                 // ax/ay：以可视框内这个点为锚，缩放前后它不动
    const px=ax==null?compare.clientWidth/2:ax, py=ay==null?compare.clientHeight/2:ay;
    const u=(compare.scrollLeft+px)/scale, v=(compare.scrollTop+py)/scale;
    scale=Math.min(8,Math.max(0.05,s));fit=false;paint();
    compare.scrollLeft=u*scale-px;compare.scrollTop=v*scale-py;
  }
  function toFit(){fit=true;scale=fitScale();paint();compare.scrollLeft=0;compare.scrollTop=0;}
  document.getElementById('z-in').addEventListener('click',()=>zoomTo(scale*1.25));
  document.getElementById('z-out').addEventListener('click',()=>zoomTo(scale/1.25));
  document.getElementById('z-fit').addEventListener('click',toFit);
  pct.addEventListener('click',()=>zoomTo(1));
  compare.addEventListener('wheel',e=>{
    if(!(e.ctrlKey||e.metaKey))return;      // 普通滚轮留给上下看图：图通常比框高
    e.preventDefault();
    const b=compare.getBoundingClientRect();
    zoomTo(scale*Math.pow(1.0016,-e.deltaY),e.clientX-b.left,e.clientY-b.top);
  },{passive:false});
  compare.addEventListener('dblclick',e=>{
    if(e.target.closest('.num'))return;
    const b=compare.getBoundingClientRect();
    if(Math.abs(scale-1)<0.005)toFit();else zoomTo(1,e.clientX-b.left,e.clientY-b.top);
  });
  /* 放大后拖着看。不抢 .num（点角标跳卡片）和分割线的事件 */
  let pan=null;
  compare.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('.num,.divider')||!compare.classList.contains('pannable'))return;
    pan={x:e.clientX,y:e.clientY,l:compare.scrollLeft,t:compare.scrollTop};
    compare.classList.add('panning');e.preventDefault();
  });
  window.addEventListener('pointermove',e=>{
    if(!pan)return;
    compare.scrollLeft=pan.l-(e.clientX-pan.x);compare.scrollTop=pan.t-(e.clientY-pan.y);
  });
  window.addEventListener('pointerup',()=>{if(pan){pan=null;compare.classList.remove('panning');}});
  window.addEventListener('resize',()=>{if(fit)toFit();});
  // 图片是异步加载的：加载完竖向滚动条才出现，可视宽随之变窄，适应宽度得重算一次
  compare.querySelectorAll('img').forEach(im=>im.addEventListener('load',()=>{if(fit)toFit();}));
  toFit();
})();
/* ---- 聚焦：悬停任一侧，另一侧跟着高亮，其余压暗 ---- */
function focusOn(n){
  stage.classList.toggle('dim',!!n);
  document.querySelectorAll('.anno').forEach(a=>a.classList.toggle('focus',!!n&&a.dataset.n===n));
  document.querySelectorAll('.item').forEach(c=>c.classList.toggle('focus',!!n&&c.dataset.n===n));
}
function annoOf(n){ return document.querySelector('.anno[data-n="'+n+'"]'); }
function cardOf(n){ return document.querySelector('.item[data-n="'+n+'"]'); }

document.addEventListener('mouseover',e=>{
  const a=e.target.closest('.anno');
  if(a){ focusOn(a.dataset.n); tip.textContent=a.dataset.tip||''; tip.style.display='block'; return; }
  const c=e.target.closest('.item');
  if(c&&c.dataset.n)focusOn(c.dataset.n);
});
document.addEventListener('mouseout',e=>{
  const a=e.target.closest('.anno');
  if(a){ if(!e.relatedTarget||!a.contains(e.relatedTarget)){tip.style.display='none';focusOn(null);} return; }
  if(e.target.closest('.item'))focusOn(null);
});
document.addEventListener('mousemove',e=>{
  if(tip.style.display!=='block')return;
  const pad=14,w=tip.offsetWidth,h=tip.offsetHeight;
  tip.style.left=Math.min(window.innerWidth-w-8,e.clientX+pad)+'px';
  tip.style.top=Math.max(8,Math.min(window.innerHeight-h-8,e.clientY+pad))+'px';
});

/* 点角标 → 卡片滚到眼前；点卡片 → 图上滚到那个框并闪一下 */
document.addEventListener('click',e=>{
  const a=e.target.closest('.anno');
  if(a){ const c=cardOf(a.dataset.n); if(c)c.scrollIntoView({block:'center',behavior:'smooth'}); return; }
  const c=e.target.closest('.item');
  if(!c||e.target.closest('details.raw')||!c.dataset.n)return;
  const box=annoOf(c.dataset.n);
  if(!box)return;
  box.scrollIntoView({block:'center',behavior:'smooth'});
  box.classList.remove('pulse');void box.offsetWidth;box.classList.add('pulse');
});

/* ---- 按类别筛选：只隐藏，不重编号 ---- */
function applyFilter(cat){
  document.querySelectorAll('.fpill').forEach(b=>b.classList.toggle('on',b.dataset.cat===cat));
  document.querySelectorAll('.anno').forEach(a=>{
    const hit=cat==='all'||a.dataset.cats.split(' ').indexOf(cat)>=0;
    a.hidden=!hit;
    // 框色跟着筛选走：只看「颜色」时，颜色问题只是警告的元素不该因为它的几何是
    // 错误而顶着红框 —— 那是在替另一类问题背锅。
    a.dataset.sev=(cat==='all')?a.dataset.sevAll:(JSON.parse(a.dataset.catsev)[cat]||a.dataset.sevAll);
  });
  document.querySelectorAll('.flt').forEach(el=>{
    el.hidden=!(cat==='all'||el.dataset.cats.split(' ').indexOf(cat)>=0);
  });
  document.getElementById('shown').textContent=
    document.querySelectorAll('.item.flt:not([hidden])').length;
}
document.querySelectorAll('.fpill').forEach(b=>b.addEventListener('click',()=>applyFilter(b.dataset.cat)));
document.getElementById('tg-anno').addEventListener('change',e=>stage.classList.toggle('no-anno',!e.target.checked));
document.getElementById('tg-num').addEventListener('change',e=>stage.classList.toggle('no-num',!e.target.checked));

function copyFixes(btn){
  const text=btn.closest('.fixbox').querySelector('pre').textContent;
  navigator.clipboard.writeText(text).then(()=>{
    const old=btn.textContent;btn.textContent='✓ 已复制';setTimeout(()=>btn.textContent=old,1400);
  });
}

/* ---- 待裁决：点选 → 复制成 finalize_report 的 decisions ---- */
document.querySelectorAll('.qopt').forEach(b=>b.addEventListener('click',()=>{
  b.closest('.qopts').querySelectorAll('.qopt').forEach(o=>o.classList.toggle('on',o===b));
  b.closest('.qcard').removeAttribute('data-done');
}));
function copyDecisions(btn){
  const picked=[...document.querySelectorAll('.qcard')].flatMap(c=>{
    const on=c.querySelector('.qopt.on');
    return on?[{id:c.dataset.q,verdict:on.dataset.v}]:[];
  });
  const old=btn.textContent;
  const flash=t=>{btn.textContent=t;setTimeout(()=>btn.textContent=old,1600);};
  if(!picked.length){flash('先选一个选项');return;}
  navigator.clipboard.writeText(JSON.stringify(picked,null,1))
    .then(()=>flash('✓ 已复制 '+picked.length+' 条'),()=>flash('复制失败'));
}
</script>
</body>
</html>`;
}
