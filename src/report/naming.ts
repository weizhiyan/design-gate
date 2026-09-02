// 验收产物的命名规则：目录与 HTML 都跟项目名走（允许中文），而不是只有时间戳。
// 名字来源的退让顺序由 engine 决定：显式 projectName → 设计稿 frame 名 → 无名。
// 无名时退回旧行为（reports/<时间戳>/report.html），不至于生成「验收.html」这种秃头文件。

/**
 * 文件系统或 file:// 链接里会出事的字符：
 * `/` `\` 是路径分隔，`:` 在 Windows 非法，`*` `?` `"` `<` `>` `|` 是通配/保留，
 * `#` `%` 会让 file:// 链接从文件名中途截断。连字号和中文都保留。
 */
const HOSTILE = /[/\\:*?"<>|#%]/g;

/** 控制字符不该进文件名（Figma 图层名里出现过换行）；用 Unicode 类避免源码里塞裸控制字节 */
const CTRL = /\p{Cc}/gu;

/** 首尾的点与空白：`.` `..` 是目录本身，Windows 还会吞掉结尾的点和空格 */
const EDGE = /^[.\s]+|[.\s]+$/g;

/**
 * 收敛成能安全落盘、也能出现在 file:// 链接里的名字。中文原样保留 ——
 * 这是明确要的效果，且三个平台的文件名都是 UTF-8。
 * 返回空串表示「这个来源给不出可用的名字」，调用方应继续往下退。
 */
export function sanitizeName(raw: string | undefined): string {
  if (!raw) return "";
  const cleaned = raw.replace(CTRL, " ").replace(HOSTILE, " ").replace(/\s+/g, " ").replace(EDGE, "");
  // 截断后可能又在末尾留下空格或点，所以再刮一次边
  return cleaned.slice(0, 60).replace(EDGE, "");
}

/** 报告 HTML 的文件名：`<项目名>验收.html`；无项目名时退回 report.html */
export function reportFileName(projectName?: string): string {
  const n = sanitizeName(projectName);
  return n ? `${n}验收.html` : "report.html";
}

/** 报告目录名：有项目名就用项目名，否则退回时间戳 */
export function reportDirName(projectName: string | undefined, stamp: string): string {
  return sanitizeName(projectName) || stamp;
}
