/**
 * design-gate 端到端冒烟测试（跑构建产物 dist/cli.js，零网络依赖）
 *
 * 场景：fixtures/figma-cache.json（设计真值）vs fixtures/sample.html（含 8 类故意偏差的实现）
 * 断言：CLI 能完整走通 链路 → 捕获各偏差类别 → FAIL 门禁退出码=1 → 报告产物齐全
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");

function fail(msg) {
  console.error(`❌ 冒烟失败: ${msg}`);
  process.exit(1);
}

if (!existsSync(cli)) fail("dist/cli.js 不存在，请先 npm run build");

console.log("== design-gate 端到端冒烟测试 ==\n");
const res = spawnSync(
  process.execPath,
  [
    cli,
    "--figma-json",
    path.join(root, "fixtures/figma-cache.json"),
    "--web",
    "file://" + path.join(root, "fixtures/sample.html"),
    "--selector",
    ".pricing-card",
    "--viewport",
    "800x600",
    "--spec",
    path.join(root, "templates/design-spec.yaml"),
    "--out",
    path.join(root, "reports/smoke"),
  ],
  { encoding: "utf8" }
);

console.log("---- CLI 输出 ----");
console.log(res.stdout || res.stderr);
console.log("------------------\n");

// 门禁语义: FAIL → exit 1（CI 用）。异常崩溃是 exit 2。
if (res.status === 2) fail(`CLI 崩溃:\n${res.stderr}`);
if (res.status !== 1) fail(`预期退出码 1(FAIL 门禁)，实际 ${res.status}`);

const resultPath = path.join(root, "reports", "smoke", "result.json");
// 报告文件名跟项目名走：fixture 的 frame 叫 PricingCard，所以是 PricingCard验收.html。
// 这里写死期望名字，命名规则被改坏时冒烟会红。
const reportPath = path.join(root, "reports", "smoke", "PricingCard验收.html");
if (!existsSync(resultPath)) fail("result.json 未生成");
if (!existsSync(reportPath)) fail(`PricingCard验收.html 未生成（目录内实际有: ${readdirSync(path.join(root, "reports", "smoke")).join(", ")}）`);

const result = JSON.parse(readFileSync(resultPath, "utf8"));
const cats = new Set(result.issues.map((i) => i.category));
console.log("捕获的问题类别:", [...cats].join(", "));
for (const i of result.issues) {
  console.log(
    `  [${i.severity.toUpperCase()}] ${i.category}/${i.property}: ${i.designValue} → ${i.actualValue} ${i.delta ?? ""} @ ${i.selector ?? "-"}`
  );
}

const required = ["geometry", "typography", "grid", "existence", "token"];
const missing = required.filter((c) => !cats.has(c));

const failures = [];
if (result.status !== "FAIL") failures.push(`预期 FAIL，实际 ${result.status}`);
if (missing.length) failures.push(`缺失偏差类别: ${missing.join(", ")}`);
if (!result.summary.unmatchedDesign) failures.push("未检测到'设计有代码无'元素（应缺一个功能项）");
if (!result.summary.unmatchedCode) failures.push("未检测到'实现多出'元素（应多一个 badge）");

if (cats.has("color")) console.log("\n✓ 颜色偏差已捕获");
else console.log("\n(i) 按钮色差未过 ΔE 警告阈值，属正常容差行为");

if (failures.length) fail("\n  " + failures.join("\n  "));

console.log(
  `\n✅ 冒烟通过: score=${result.score}, issues=${result.summary.total}, ` +
    `匹配对=${result.summary.matched}, 报告=${path.relative(root, reportPath)}`
);
