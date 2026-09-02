#!/usr/bin/env node
import { runVerify, formatSummary } from "./engine.js";

interface Args {
  figma?: string;
  figmaJson?: string;
  web: string;
  selector?: string;
  viewport?: string;
  spec?: string;
  out?: string;
  name?: string;
}

function parseArgs(argv: string[]): Args {
  const args: any = { web: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--figma") args.figma = argv[++i];
    else if (a === "--figma-json") args.figmaJson = argv[++i];
    else if (a === "--web") args.web = argv[++i];
    else if (a === "--selector") args.selector = argv[++i];
    else if (a === "--viewport") args.viewport = argv[++i];
    else if (a === "--spec") args.spec = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.web) {
    console.error("缺少 --web 参数");
    printHelp();
    process.exit(1);
  }
  return args;
}

function printHelp(): void {
  console.log(`design-gate — Figma 设计稿 vs 前端实现 自动化验收

用法:
  design-gate --web <页面URL> [--figma <Figma链接>] [选项]

参数:
  --figma <url>       Figma frame/component 链接（独立调用 REST API 时需 FIGMA_TOKEN）
  --figma-json <path> 离线缓存的节点 JSON（开发/测试用，与 --figma 二选一）
  --web <url>         实现页面地址，http(s):// 或 file://
  --selector <css>    组件根选择器，默认 body
  --viewport <WxH>    视口尺寸，默认 1440x900
  --spec <path>       design-spec.yaml 项目规范文件路径
  --name <项目名>      项目名，可用中文。决定报告目录 reports/<项目名>/ 与
                      HTML 文件名 <项目名>验收.html；留空则取设计稿 frame 名
  --out <dir>         报告输出目录，默认 reports/<项目名>（无项目名时用时间戳）

示例:
  design-gate --figma "https://www.figma.com/design/KEY/File#node-id=12-34" \\
              --web http://localhost:3000/card --selector ".pricing-card" \\
              --name "定价卡片" --spec ./design-spec.yaml`);
}

async function main() {
  const a = parseArgs(process.argv);
  let viewport: { width: number; height: number } | undefined;
  if (a.viewport) {
    const m = a.viewport.match(/^(\d+)x(\d+)$/);
    if (!m) throw new Error(`--viewport 格式应为 WxH，收到: ${a.viewport}`);
    viewport = { width: +m[1], height: +m[2] };
  }

  const result = await runVerify({
    figmaUrl: a.figma,
    figmaJson: a.figmaJson,
    webUrl: a.web,
    selector: a.selector,
    viewport,
    specPath: a.spec,
    outDir: a.out,
    projectName: a.name,
  });
  console.log(formatSummary(result));
  // 验收门禁退出码：PASS=0，其余=1（可直接接 CI）
  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error("验收失败:", err instanceof Error ? err.message : err);
  process.exit(2);
});
