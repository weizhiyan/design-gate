#!/usr/bin/env node
// design-gate MCP server —— 供 Trae / Codex / Claude Code 等载体接入。
//
// 工具:
//   get_acceptance_checklist()            → 验收引导清单（对话协议）
//   figma_frame_info(figmaUrl, figmaSnapshot?) → 读取链接或宿主快照，返回画布尺寸并推荐视口
//   inspect_selectors(webUrl)             → 列出页面候选根节点，辅助选择 selector
//   verify_page(...)                      → 执行验收，产出草稿结论（含待裁决项）
//   finalize_report(jsonPath, decisions)  → 应用人工裁决，落正式报告 + 沉淀经验
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { formatSummary, runVerify } from "./engine.js";
import { recalcSummary, writeReport } from "./report/html.js";
import type { DecisionRecord, VerifyResult } from "./types.js";

const GUIDE = `design-gate 验收对话协议 —— 与用户交互时严格遵循：

【交互方式 · 贯穿全程】凡是要用户做决定的地方（选参数、逐条裁决、要不要改规范），
优先用载体自带的交互式弹窗/选项面板发问 —— 用户点选比在长文本里数条目省事，也不容易漏。
载体没有这类能力就退回纯文本逐条问，不强求；纯文本时一次只问一件事，别把多个决定挤在一段里。

【阶段一 · 收集参数】逐项向用户询问（一次只问一项），能用工具验证的先验证再问：
1. Figma 链接或宿主传入的 Figma 快照 → 立即调 figma_frame_info 验证；失败则提示检查输入。
   工具返回 suggestedViewport —— verify_page 不传 viewport 时就按它跑（宽=设计稿宽，
   高>1200 的长画板退回 1080）。这个**口头告知一句就行，不要当成一个问题去问用户**：
   验收本来就该在设计稿的尺寸下量，改断点才是例外。
   如果载体已经通过 Figma 连接器拿到原始节点 JSON，应把它作为 figmaSnapshot 传入；
   这样不需要 FIGMA_TOKEN。只有 design-gate 自己根据链接调用 REST API 时才需要 token。
2. 页面地址 webUrl → http(s) 或 file://。
3. 组件范围 selector → 用户不确定时调 inspect_selectors 展示候选列表让其选择。
4. 规范文件 specPath → 问项目里是否有 design-spec.yaml。
5. 项目名 projectName → 报告目录与 HTML 都按它命名（reports/<项目名>/<项目名>验收.html），
   可用中文。已知项目名就直接确认一下，不知道就问；用户说随意则留空，那时取设计稿 frame 名。
   同一项目复验会覆盖同一目录，不会攒出一堆历史目录 —— 需要留档就让用户改个项目名。

【阶段二 · 执行验收】调 verify_page。结果分两条路走：
- 必须修复(error/数值类)：数值精确，AI 直接进修复循环（改代码→重跑 verify_page→收敛），
  不要拿这些去问用户 —— 几何差 3px、色值没走 token，问了也只能答「改」。
- 待裁决：verify_page 会把成百条同因结论**按根因聚成不超过 8 个问题**（Q1、Q2…），
  每个问题自带 detail（证据 + 为什么机器判不了）和三个选项。
  **就按它给的这几个问题问用户，不要自己去念 issue 清单** —— 605 条逐条念等于没问。
  按【交互方式】优先弹窗：一个 Q 一个弹窗，选项照抄工具给的 label，备注可留空。
  没有 questions 时说明没有需要人判的事，直接进修复循环。

【阶段三 · 落正式报告】收集完裁决后调 finalize_report。
decisions 里填**问题的 id**（如 {id:"Q1",verdict:"accept",note:"设计稿只画了示意行"}），
finalize_report 会自动展开到 Q1 覆盖的全部结论上 —— 不需要你逐条列 ISS-xxx。
accept/reject 决策自动沉淀到 LEARNINGS.md（存在时）。
LEARNINGS.md 只是记录，下次重跑不会自动生效 —— 所以裁决里出现 accept 时，
再弹一次窗问用户要不要把它写进 design-spec.yaml（豁免进 exemptions / 容差进 tolerances），
用户同意再改文件。不写就等于下次同一处还会重新报出来，这一点要说清。

禁止行为：
- 未经用户确认不得自行修改 spec 容差/白名单来让验收通过
- 不得跳过 error 宣称完成；同一问题盲改不超过 3 轮应停下报告卡点
- 不得向用户索要 FIGMA_TOKEN 的**内容**。token 只从环境变量读，用户在对话里贴一串
  token 本工具也读不到 —— 问了等于让用户白泄露一次凭据。缺 token 时正确的说法是：
   「请让宿主传入 figmaSnapshot，或给我一份离线节点 JSON 走 figmaJson」。
- 不得把成百条结论逐条念给用户。要问就问 verify_page 给出的那几个 Q`;

const server = new McpServer(
  { name: "design-gate", version: "0.2.0" },
  { instructions: GUIDE }
);

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `design-gate 错误: ${message}` }],
    isError: true,
  };
}

server.registerTool(
  "get_acceptance_checklist",
  {
    title: "验收引导清单",
    description: "获取完整的验收对话流程清单（开始前必读）。",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text" as const, text: GUIDE }] })
);

server.registerTool(
  "figma_frame_info",
  {
    title: "校验Figma链接",
    description:
      "读取 Figma 链接或宿主传入的节点快照，返回 frame 名称、画布尺寸、推荐视口。收集参数阶段先调用它。",
    inputSchema: {
      figmaUrl: z.string().optional().describe("Figma frame/component 链接"),
      figmaSnapshot: z.unknown().optional().describe("宿主 Agent/连接器已获取的原始 Figma 节点 JSON"),
    },
  },
  async ({ figmaUrl, figmaSnapshot }) => {
    try {
      const { loadFigmaNode } = await import("./figma/client.js");
      const { figmaToStyleTree } = await import("./figma/adapter.js");
      const { viewportForDesign } = await import("./capture/browser.js");
      const doc = (await loadFigmaNode(figmaUrl, undefined, figmaSnapshot)).document;
      const bb = doc.absoluteBoundingBox ?? {};
      const w = Math.round(bb.width ?? 0);
      const h = Math.round(bb.height ?? 0);
      // 推荐值直接用 verify_page 内部那套函数算，避免文案与实际行为漂移
      const vp = viewportForDesign(figmaToStyleTree(doc));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                name: doc.name,
                type: doc.type,
                canvasSize: `${w}x${h}`,
                suggestedViewport: `${vp.width}x${vp.height}`,
                note:
                  "verify_page 不传 viewport 时就按这个尺寸跑（宽度取设计稿宽；" +
                  "高度超过 1200 的长页面画板退回 1080，否则 100vh 会被撑坏）。" +
                  "口头告知用户即可，不必追问；用户要换断点时再显式传 viewport。",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "inspect_selectors",
  {
    title: "探测页面结构",
    description:
      "打开页面并列出顶层候选容器（tag.class、子元素数、文本预览），帮助用户确定 selector。",
    inputSchema: {
      webUrl: z.string().describe("页面地址"),
    },
  },
  async ({ webUrl }) => {
    let browser;
    try {
      const { launchBrowser, DEFAULT_VIEWPORT } = await import("./capture/browser.js");
      browser = await launchBrowser();
      const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT, screen: DEFAULT_VIEWPORT });
      await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const list = await page.evaluate(() => {
        function describe(el: any, level: number): any {
          const r = el.getBoundingClientRect();
          let text = "";
          for (const n of el.querySelectorAll("*")) {
            if (n.children.length === 0 && n.textContent && String(n.textContent).trim()) {
              text = String(n.textContent).trim().slice(0, 20);
              break;
            }
          }
          const sel =
            el.tagName.toLowerCase() +
            (el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "");
          return {
            selector: sel,
            size: Math.round(r.width) + "x" + Math.round(r.height),
            childElements: el.children.length,
            firstText: text || undefined,
            children:
              level > 1
                ? Array.from(el.children).slice(0, 8).map((c) => describe(c, level - 1))
                : undefined,
          };
        }
        return Array.from(document.body.children).map((el) => describe(el, 2));
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `页面顶层结构:\n${JSON.stringify(list, null, 1)}\n\n请让用户从中选择要验收的组件根 selector（或直接用 body 全页）。`,
          },
        ],
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
);

// ---- verify_page 与 finalize_report 定义于下方 ----

server.registerTool(
  "verify_page",
  {
    title: "设计验收（草稿）",
    description:
      "将前端实现页面与其 Figma 设计稿进行自动化验收比对（几何/颜色/字体/圆角/栅格/Token 合规）。" +
      "返回草稿结论：必须修复项可直接修代码复验；待裁决项需念给用户逐条决策，最后调 finalize_report 出正式报告。",
    inputSchema: {
      webUrl: z.string().describe("实现页面地址，http(s):// 或 file://"),
      figmaUrl: z.string().optional().describe("Figma frame/component 链接；没有 figmaSnapshot 时才需要 FIGMA_TOKEN"),
      figmaJson: z.string().optional().describe("离线缓存节点 JSON 路径（与 figmaUrl 二选一）"),
      figmaSnapshot: z.unknown().optional().describe("宿主 Agent/连接器已获取的原始 Figma 节点 JSON，不需要 FIGMA_TOKEN"),
      selector: z.string().optional().describe("组件根选择器，默认 body"),
      viewport: z
        .string()
        .optional()
        .describe(
          '视口尺寸 "WxH"。留空即按设计稿尺寸跑（宽=frame 宽，高>1200 的长画板退回 1080），' +
            "一般不用传；只有要验另一个断点时才显式指定。"
        ),
      specPath: z.string().optional().describe("design-spec.yaml 项目规范文件路径"),
      projectName: z
        .string()
        .optional()
        .describe(
          "项目名，可用中文。报告落到 reports/<项目名>/，HTML 命名为 <项目名>验收.html。" +
            "留空则取设计稿 frame 名。同一项目复验会覆盖同一目录。"
        ),
      outDir: z.string().optional().describe("报告输出目录，默认 reports/<项目名>（无项目名时用时间戳）"),
    },
  },
  async (args) => {
    try {
      let viewport: { width: number; height: number } | undefined;
      if (args.viewport) {
        const m = args.viewport.match(/^(\d+)x(\d+)$/);
        if (!m) return err(`viewport 格式应为 WxH，收到: ${args.viewport}`);
        viewport = { width: +m[1], height: +m[2] };
      }
      const result = await runVerify({
        figmaUrl: args.figmaUrl,
        figmaJson: args.figmaJson,
        figmaSnapshot: args.figmaSnapshot,
        webUrl: args.webUrl,
        selector: args.selector,
        viewport,
        specPath: args.specPath,
        outDir: args.outDir,
        projectName: args.projectName,
      });
      // 待裁决项以「按根因聚类的问题」呈现，不是 issue 清单 ——
      // 605 条 warning 逐条念给用户，人念到第 20 条就开始乱点。
      const qs = result.questions ?? [];
      const covered = qs.reduce((n, q) => n + q.issueIds.length, 0);
      const pendingText = qs.length
        ? `\n\n【需用户裁决 ${qs.length} 个问题】共覆盖 ${covered} 条结论。\n` +
          "请逐个弹窗问用户（一个问题一个弹窗，选项照抄下面的 label），收齐后调 finalize_report，" +
          "decisions 里填 Q 的 id 即可（会自动展开到它覆盖的全部结论）：\n\n" +
          qs
            .map(
              (q) =>
                `${q.id}. ${q.title}\n` +
                `   ${q.detail.split("\n").join("\n   ")}\n` +
                q.options
                  .map((o, n) => `   ${String.fromCharCode(65 + n)}(${o.verdict}) ${o.label}`)
                  .join("\n") +
                `\n   （这一答覆盖 ${q.issueIds.length} 条结论）`
            )
            .join("\n\n")
        : "\n\n无需用户裁决。error 清单可直接修代码后复验；确认收敛后无需 finalize。";
      // 同一批问题再给一份结构化的：载体要弹窗，就得按字段填标题/正文/选项。
      // 只有散文的话，agent 得从缩进文本里把 label 抄出来 —— 抄错一个字，
      // finalize_report 的 verdict 就对不上。这份 JSON 是弹窗的唯一可靠输入。
      const questionsJson = qs.length
        ? [
            {
              type: "text" as const,
              text:
                "供弹窗渲染的结构化问题（options.verdict 原样回传给 finalize_report）：\n" +
                JSON.stringify(
                  qs.map((q) => ({
                    id: q.id,
                    title: q.title,
                    detail: q.detail,
                    covers: q.issueIds.length,
                    options: q.options,
                  })),
                  null,
                  1
                ),
            },
          ]
        : [];
      return {
        content: [
          { type: "text" as const, text: formatSummary(result) + pendingText },
          ...questionsJson,
          { type: "text" as const, text: `草稿JSON(供finalize_report): ${result.jsonPath}` },
        ],
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "finalize_report",
  {
    title: "落正式验收报告",
    description:
      "应用用户裁决（confirmed=确认真问题 / accept=可接受豁免 / reject=误报），重新计分并生成最终报告。" +
      "decisions 的 id 填 verify_page 给出的问题号（Q1/Q2…），会自动展开到该问题覆盖的全部结论；" +
      "也接受单条结论 id（ISS-xxx）。accept/reject 决策自动沉淀到 LEARNINGS.md（若当前目录存在）。",
    inputSchema: {
      jsonPath: z.string().describe("verify_page 返回的 result.json 路径"),
      decisions: z
        .array(
          z.object({
            id: z
              .string()
              .describe("问题号 Q1/Q2…（推荐，会展开到它覆盖的全部结论），或单条结论 id 如 ISS-003"),
            verdict: z.enum(["confirmed", "accept", "reject"]),
            note: z.string().optional().describe("裁决备注/理由"),
          })
        )
        .describe("用户对每个待裁决问题的决定"),
    },
  },
  async ({ jsonPath, decisions }) => {
    try {
      const result = JSON.parse(await readFile(jsonPath, "utf8")) as VerifyResult;
      const outDir = path.dirname(jsonPath);
      const now = new Date().toISOString();
      const records: DecisionRecord[] = [];
      // 用户答的是「问题」（一个 Q 覆盖 N 条同因结论），落到报告上要展开成逐条裁决。
      // 审计轨迹 records 里保留 Q 级原始决定 —— 那才是用户真正回答过的东西。
      const byQuestion = new Map((result.questions ?? []).map((q) => [q.id, q.issueIds]));
      const byId = new Map(result.issues.map((i) => [i.id, i]));
      let applied = 0;

      for (const d of decisions) {
        records.push({ ...d, at: now });
        const fromQuestion = byQuestion.has(d.id);
        const prefix = fromQuestion ? `[${d.id}] ` : "";
        for (const issueId of byQuestion.get(d.id) ?? [d.id]) {
          const issue = byId.get(issueId);
          if (!issue) continue;
          applied++;
          if (d.verdict === "confirmed") {
            issue.verified = true;
            // 之前因「配对还没确认」被压低的严重度，确认后还原并重新计分。
            // 必须同时清掉 suspectPair，否则报告里那句「请先确认这是同一个元素」会一直挂着。
            if (issue.downgradedFrom) {
              issue.severity = issue.downgradedFrom;
              issue.downgradedFrom = undefined;
              issue.suspectPair = undefined;
            }
            issue.adjudication = prefix + (d.note ? `已确认: ${d.note}` : "已确认");
          } else if (d.verdict === "accept") {
            issue.severity = "info";
            issue.adjudication = `${prefix}[豁免] ${d.note || "用户判定可接受"}`;
          } else {
            issue.severity = "info";
            issue.adjudication = `${prefix}[误报] ${d.note || "用户判定不成立"}`;
          }
        }
      }

      result.decisions = [...(result.decisions ?? []), ...records];
      recalcSummary(result);
      const written = await writeReport(result, outDir);

      // 经验沉淀：仅当 cwd 存在 LEARNINGS.md 时追加（避免污染无关目录）
      let learnMsg = "";
      const learnPath = path.resolve("LEARNINGS.md");
      if (existsSync(learnPath)) {
        // 记问题标题而不是 Q 号：Q1 只在那一次运行里有意义，下次翻 LEARNINGS 的人看不懂
        const titleOf = new Map((result.questions ?? []).map((q) => [q.id, q.title]));
        const lines = records
          .filter((r) => r.verdict !== "confirmed")
          .map(
            (r) =>
              `- ${now.slice(0, 10)} | ${r.verdict === "accept" ? "豁免" : "误报"} | ` +
              `${titleOf.get(r.id) ?? r.id} | ${r.note || ""}`
          );
        if (lines.length) {
          appendFileSync(learnPath, `\n## 裁决记录 ${now.slice(0, 10)}\n${lines.join("\n")}\n`);
          learnMsg = `\n已沉淀 ${lines.length} 条裁决到 LEARNINGS.md`;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `正式报告已生成: ${result.status} 得分 ${result.score}/100\n` +
              `已应用 ${decisions.length} 个裁决 → ${applied} 条结论\n` +
              `报告: ${written.reportPath}\nJSON: ${written.jsonPath}${learnMsg}`,
          },
        ],
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

await server.connect(new StdioServerTransport());
