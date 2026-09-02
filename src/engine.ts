import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureElementCrops, capturePage, cropImageFile, viewportForDesign } from "./capture/browser.js";
import { compareTrees } from "./diff/compare.js";
import { matchTrees } from "./diff/match.js";
import { figmaToStyleTree } from "./figma/adapter.js";
import { exportNodePng, loadFigmaNode } from "./figma/client.js";
import { figmaNodeUrl, parseFigmaUrl } from "./figma/parse-url.js";
import { writeReport } from "./report/html.js";
import { reportDirName, sanitizeName } from "./report/naming.js";
import { loadSpec } from "./rules/spec.js";
import { buildQuestions } from "./rules/questions.js";
import { issueElementKey, scoreAndStatus } from "./rules/score.js";
import type { Issue, Marker, StyleNode, VerifyResult } from "./types.js";
import { foldPins, type Pin } from "./report/markers.js";
import { buildFixesText } from "./report/fixes.js";

export interface VerifyOptions {
  /** Figma 链接；没有宿主快照时才需要 FIGMA_TOKEN */
  figmaUrl?: string;
  /** 离线缓存 JSON 路径（开发/冒烟），优先级低于宿主快照 */
  figmaJson?: string;
  /** 宿主 Agent/连接器已获取的原始 Figma 节点 JSON，优先级最高 */
  figmaSnapshot?: unknown;
  /** 实现页面地址，http(s) 或 file:// */
  webUrl: string;
  /** 组件根选择器（默认 body） */
  selector?: string;
  viewport?: { width: number; height: number };
  /** design-spec.yaml 路径 */
  specPath?: string;
  /** 报告输出目录（默认 reports/<项目名>，无项目名时退回 reports/<时间戳>） */
  outDir?: string;
  /** 项目名：决定报告目录名与 HTML 文件名（`<项目名>验收.html`）。留空则用设计稿 frame 名 */
  projectName?: string;
}

/**
 * 验收主流程：
 * 设计稿真值 → 实现真值 → 匹配 → 确定性 diff → 报告
 */
export async function runVerify(opts: VerifyOptions): Promise<VerifyResult & { reportPath: string; jsonPath: string }> {
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // 1. 设计稿真值
  const { document: figmaDoc, source } = await loadFigmaNode(opts.figmaUrl, opts.figmaJson, opts.figmaSnapshot);
  const designTree = figmaToStyleTree(figmaDoc);

  // 产物命名要在建目录之前定下来：显式 projectName 优先，否则用设计稿 frame 名 ——
  // 报告是给人看的，目录叫「登录页」比叫 2026-08-28T14-32-05 好找。
  // 同一项目复验直接覆盖同一目录：旧行为每跑一次留一个时间戳目录，攒出过 44MB 无人看的历史。
  const projectName = sanitizeName(opts.projectName) || sanitizeName(designTree.name);
  const outDir = opts.outDir ?? path.join("reports", reportDirName(projectName, stamp));

  // 视口跟着设计稿走：宽度不等于设计稿宽度时，页面的 rem 换算和媒体查询会整体换档，
  // 报告里每个几何数字都带着一个跟实现无关的缩放系数。调用方显式指定仍然最高优先。
  const viewport = opts.viewport ?? viewportForDesign(designTree);

  // 2. 实现真值
  const capture = await capturePage({
    webUrl: opts.webUrl,
    selector: opts.selector,
    viewport,
    outDir,
  });

  // 设计侧原始 JSON 落盘：同一项目复验、或换个环境重跑，就不必再要 token 了 ——
  // 把这份路径喂给 figmaJson 即可。离线模式本来就有一份，不重复拷。
  if (opts.figmaUrl || opts.figmaSnapshot !== undefined) {
    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, "design-node.json"), JSON.stringify(figmaDoc), "utf8");
    } catch {
      /* 缓存失败不阻断验收 */
    }
  }

  // 设计稿截图（线上模式导出 frame PNG；离线模式跳过。也接受手动放入的 design.png）
  let designShotPath: string | undefined;
  if (opts.figmaUrl) {
    try {
      const png = await exportNodePng(opts.figmaUrl);
      if (png) {
        designShotPath = path.join(outDir, "design.png");
        await writeFile(designShotPath, png);
      }
    } catch {
      /* 截图导出失败不阻断验收 */
    }
  }
  if (!designShotPath && existsSync(path.join(outDir, "design.png"))) {
    designShotPath = path.join(outDir, "design.png");
  }

  // 3. 匹配 + 4. 确定性 diff
  const match = matchTrees(designTree, capture.tree);
  const spec = await loadSpec(opts.specPath);
  const { issues, needsReview } = compareTrees(match, { spec });

  // 5. 元素级裁剪证据卡（错误优先，最多24个元素）+ 大图标记钉
  const selectorToDesignRect = new Map<string, StyleNode>();
  const codeRectBySelector = new Map<string, StyleNode>();
  for (const p of match.pairs) {
    selectorToDesignRect.set(p.code.id, p.design);
    codeRectBySelector.set(p.code.id, p.code);
  }
  // 「码有设计无」的多余元素不在 pairs 里，但它在实现页面上确实存在、rect 也是量到的 ——
  // 不喂进来，「这块多了」就永远只能是右侧的一行字，图上没有任何框指向它。
  for (const n of match.unmatchedCode) {
    if (!codeRectBySelector.has(n.id)) codeRectBySelector.set(n.id, n);
  }
  const activeIssues = issues.filter((i) => i.severity !== "info");
  const cropSelectors = [
    ...new Set(
      activeIssues
        .filter((i) => i.selector)
        .sort((a, b) => (a.severity === "error" ? -1 : 1) - (b.severity === "error" ? -1 : 1))
        .map((i) => i.selector!)
    ),
  ].slice(0, 24);

  let cropsActual: Record<string, string> = {};
  let cropsDesign: Record<string, string> = {};
  if (cropSelectors.length) {
    try {
      const cropsDir = path.join(outDir, "crops");
      await mkdir(cropsDir, { recursive: true });
      cropsActual = await captureElementCrops({
        webUrl: opts.webUrl,
        viewport,
        selectors: cropSelectors,
        outDir: cropsDir,
      });
      for (const [k, v] of Object.entries(cropsActual)) cropsActual[k] = path.relative(outDir, v);
      if (designShotPath) {
        let di = 0;
        for (const sel of cropSelectors) {
          const designNode = selectorToDesignRect.get(sel);
          if (!designNode) continue;
          const out = await cropImageFile(
            designShotPath,
            designNode.rect,
            2,
            path.join(cropsDir, `d-${di++}.png`)
          );
          if (out) cropsDesign[sel] = path.relative(outDir, out);
        }
      }
    } catch {
      /* 裁剪失败不影响验收主流程 */
    }
  }

  // 6. 大图标记钉（按元素分组，含 bbox 与素净悬停摘要）
  const groupMap = new Map<string, { sev: string; cats: Set<string>; ids: string[]; issues: Issue[] }>();
  for (const i of activeIssues) {
    const key = issueElementKey(i);
    let g = groupMap.get(key);
    if (!g) {
      g = { sev: "warning", cats: new Set(), ids: [], issues: [] };
      groupMap.set(key, g);
    }
    if (i.severity === "error") g.sev = "error";
    g.cats.add(i.category);
    g.ids.push(i.id);
    g.issues.push(i);
  }
  const markers = foldPins(
    [...groupMap].flatMap<Pin>(([key, g]) => {
      const codeNode = key.startsWith("__design_") ? undefined : codeRectBySelector.get(key);
      if (!codeNode) return []; // 无实现元素定位的组不上图钉（仍在右侧列表）
      return [
        {
          marker: {
            key,
            selector: key,
            severity: g.sev as Marker["severity"],
            cats: [...g.cats] as Marker["cats"],
            count: g.ids.length,
            x: codeNode.rect.x,
            y: codeNode.rect.y,
            w: codeNode.rect.w,
            h: codeNode.rect.h,
            tip: "", // 合并之后才知道这个钉最终覆盖哪些结论
            issueIds: g.ids,
          },
          issues: g.issues,
        },
      ];
    })
  );

  // 7. 纯净修复代码块
  const fixesText = buildFixesText(activeIssues);

  // 按根因聚类的待裁决问题：AI 据此逐条问用户，而不是念几百条 warning
  const questions = buildQuestions(issues);

  // 8. 汇总评分（公式与门禁只在 rules/score.ts 一处）
  const { score, status, errors, warnings, info } = scoreAndStatus(issues, {
    matched: match.pairs.length,
    unmatchedDesign: match.unmatchedDesign.length,
    unmatchedCode: match.unmatchedCode.length,
    needsReview,
  });

  let figmaUrlNormalized: string | undefined;
  if (opts.figmaUrl) {
    const parsed = parseFigmaUrl(opts.figmaUrl);
    figmaUrlNormalized = figmaNodeUrl(parsed.fileKey, parsed.nodeId ?? designTree.id);
  }

  const result: VerifyResult & { reportPath: string; jsonPath: string } = {
    status,
    score,
    summary: {
      total: issues.length,
      errors,
      warnings,
      info,
      matched: match.pairs.length,
      unmatchedDesign: match.unmatchedDesign.length,
      unmatchedCode: match.unmatchedCode.length,
      needsReview,
    },
    issues,
    meta: {
      figmaUrl: figmaUrlNormalized,
      webUrl: opts.webUrl,
      projectName: projectName || undefined,
      viewport: `${viewport.width}x${viewport.height}`,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      designScreenshotPath: designShotPath,
      actualScreenshotPath: capture.screenshotPath,
      cropsActual,
      cropsDesign,
      cssW: capture.cssW,
      cssH: capture.cssH,
      designW: designTree.rect.w,
      designH: designTree.rect.h,
      markers,
    },
    fixesText,
    questions,
    reportPath: "",
    jsonPath: "",
  };

  void source;
  const written = await writeReport(result, outDir);
  result.reportPath = written.reportPath;
  result.jsonPath = written.jsonPath;
  // 修复清单单独落盘（前端可直接转发给 AI）
  await writeFile(path.join(outDir, "fixes.txt"), fixesText, "utf8");
  return result;
}

/** 控制台摘要输出（CLI/MCP 共用） */
export function formatSummary(
  r: VerifyResult & { reportPath?: string; jsonPath?: string }
): string {
  const lines: string[] = [];
  lines.push(`验收结论: ${r.status}  得分: ${r.score}/100`);
  lines.push(
    `问题: ${r.summary.errors} 错误 / ${r.summary.warnings} 警告 / ${r.summary.info} 信息 | ` +
      `匹配 ${r.summary.matched} 对, 设计未实现 ${r.summary.unmatchedDesign}, 实现多出 ${r.summary.unmatchedCode}`
  );
  const show = r.issues.filter((i) => i.severity !== "info").slice(0, 20);
  for (const i of show) {
    const loc = i.selector ? ` @ ${i.selector}` : "";
    lines.push(
      `  [${i.severity.toUpperCase()}] ${i.property}: 设计=${i.designValue} 实现=${i.actualValue} ${i.delta ?? ""}${loc}`
    );
  }
  if (r.issues.length > show.length + r.summary.info) lines.push(`  ... 其余 ${r.issues.length - show.length} 条见报告`);
  lines.push(`报告: ${r.reportPath}`);
  lines.push(`JSON : ${r.jsonPath}`);
  return lines.join("\n");
}
