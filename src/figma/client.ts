import { readFile } from "node:fs/promises";

const API_BASE = "https://api.figma.com/v1";

/** 从不同来源解包 Figma 节点响应的常见外层结构。 */
function unwrapDocument(input: unknown): any {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  if (!data || typeof data !== "object") throw new Error("Figma 快照必须是 JSON 对象");
  const value = data as any;
  if (value.nodes && typeof value.nodes === "object") {
    const first = Object.values(value.nodes)[0] as any;
    return first?.document ?? first;
  }
  return value.document ?? value;
}

/**
 * 获取 Figma 节点子树原始 JSON。
 * - figmaSnapshot: 宿主 Agent/连接器已经取得的节点数据，优先级最高，不需要 Token
 * - jsonPath: 离线缓存文件
 * - figmaUrl: 独立 CLI/MCP 进程自行走 REST API，需要 FIGMA_TOKEN
 */
export async function loadFigmaNode(
  figmaUrl: string | undefined,
  jsonPath: string | undefined,
  figmaSnapshot?: unknown,
): Promise<{ document: any; source: string }> {
  if (figmaSnapshot !== undefined) {
    return { document: unwrapDocument(figmaSnapshot), source: "宿主传入的 Figma 快照" };
  }

  if (jsonPath) {
    const raw = await readFile(jsonPath, "utf8");
    return { document: unwrapDocument(raw), source: `缓存文件 ${jsonPath}` };
  }

  if (!figmaUrl) {
    throw new Error("必须提供 --figma 链接、figmaSnapshot 或 --figma-json 缓存文件");
  }
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    // 这句话是给 AI 看的：它以前把这条错误当成「问用户要 token」的提示，
    // 于是反复让用户在对话里粘贴凭据 —— 而我们只从环境变量读，粘贴过来的传不进来。
    throw new Error(
      "缺少 FIGMA_TOKEN。它只从环境变量读，在对话里粘贴 token 传不进来，不要向用户索要 token 内容。\n" +
        "正确做法二选一：\n" +
        "① 把 FIGMA_TOKEN 写进 design-gate 这个 MCP 服务配置的 env 块" +
        "（token 在 Figma → Settings → Security → Personal access tokens 创建，勾 file read）；\n" +
        "② 由宿主 Agent 传入 figmaSnapshot，或改用 figmaJson 传离线节点 JSON —— 同一项目跑过一次后，" +
        "reports/<项目名>/design-node.json 就是可直接复用的那份。"
    );
  }

  const { fileKey, nodeId } = await import("./parse-url.js").then((m) => m.parseFigmaUrl(figmaUrl));
  const ids = nodeId ?? "0:0";
  const res = await fetch(
    `${API_BASE}/files/${fileKey}/nodes?ids=${encodeURIComponent(ids)}`,
    { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(20_000) }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Figma API 请求失败 HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const doc = data.nodes?.[ids]?.document ?? (Object.values(data.nodes ?? {})[0] as any)?.document;
  if (!doc) {
    throw new Error(`Figma 返回中找不到节点 ${ids}，请检查链接中的 node-id`);
  }
  return { document: doc, source: `Figma API file=${fileKey} node=${ids}` };
}

/** 导出 Figma 节点为 PNG（用于报告左右对比图），返回图片字节。任何失败返回 null，不阻断验收 */
export async function exportNodePng(figmaUrl: string): Promise<Buffer | null> {
  const token = process.env.FIGMA_TOKEN;
  if (!token || !figmaUrl) return null;
  try {
    const { fileKey, nodeId } = await import("./parse-url.js").then((m) => m.parseFigmaUrl(figmaUrl));
    if (!nodeId) return null;
    const res = await fetch(
      `${API_BASE}/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`,
      { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { images?: Record<string, string> };
    const imgUrl = data.images?.[nodeId];
    if (!imgUrl) return null;
    // 图片走 Figma CDN（s3-alpha 等），部分网络环境不通，超时即放弃截图对比
    const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!imgRes.ok) return null;
    return Buffer.from(await imgRes.arrayBuffer());
  } catch {
    return null;
  }
}
