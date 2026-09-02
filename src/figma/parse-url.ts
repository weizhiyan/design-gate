export interface ParsedFigmaUrl {
  fileKey: string;
  nodeId?: string; // 冒号格式 "123:456"
}

/**
 * 解析 Figma 链接，提取 file key 与 node id。
 * 兼容:
 *   https://www.figma.com/design/KEY/Name#node-id=123-456
 *   https://www.figma.com/file/KEY/Name?node-id=123%3A456
 */
export function parseFigmaUrl(url: string): ParsedFigmaUrl {
  const m = url.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  if (!m) {
    throw new Error(`无法识别的 Figma 链接（需包含 /design/<key>/ 或 /file/<key>/）: ${url}`);
  }
  let nodeId: string | undefined;
  const hashMatch = url.match(/[#&?]node-id=([^&#]+)/);
  if (hashMatch) {
    try {
      nodeId = decodeURIComponent(hashMatch[1]).replace("-", ":");
    } catch {
      nodeId = hashMatch[1].replace("-", ":");
    }
  }
  return { fileKey: m[1], nodeId };
}

export function figmaNodeUrl(fileKey: string, nodeId?: string): string {
  const base = `https://www.figma.com/design/${fileKey}/`;
  if (!nodeId) return base;
  return `${base}?node-id=${encodeURIComponent(nodeId)}`;
}
