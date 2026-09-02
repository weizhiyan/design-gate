/**
 * MCP 握手冒烟：验证 dist/mcp.js 能被真实 MCP 客户端连上、工具都注册成功、能被调用。
 * 跑法：npm run smoke:mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/mcp.js"] });
const client = new Client({ name: "smoke-client", version: "0.0.1" });
await client.connect(transport);

const EXPECTED = [
  "get_acceptance_checklist",
  "figma_frame_info",
  "inspect_selectors",
  "verify_page",
  "finalize_report",
];
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log("注册的工具:", names.join(", "));
const missing = EXPECTED.filter((n) => !names.includes(n));
if (missing.length) {
  console.error("缺少工具:", missing.join(", "));
  process.exit(1);
}

// verify_page 的入参契约（projectName 决定报告目录与 HTML 文件名，漏了就退回时间戳目录）
const verifyProps = Object.keys(tools.find((t) => t.name === "verify_page").inputSchema.properties);
console.log("verify_page 入参:", verifyProps.join(", "));
if (!verifyProps.includes("projectName")) {
  console.error("verify_page 少了 projectName 入参");
  process.exit(1);
}

// 测试 checklist 工具
const r1 = await client.callTool({ name: "get_acceptance_checklist", arguments: {} });
console.log("checklist 返回前60字:", r1.content[0].text.slice(0, 60).replace(/\n/g, " "), "...");

// 测试 inspect_selectors（用本地 fixture）
const r2 = await client.callTool({
  name: "inspect_selectors",
  arguments: { webUrl: "file://" + process.cwd() + "/fixtures/sample.html" },
});
console.log("inspect_selectors 输出片段:", r2.content[0].text.slice(0, 150).replace(/\n/g, " "), "...");

await client.close();
console.log("MCP 握手与工具调用全部通过 ✓");
