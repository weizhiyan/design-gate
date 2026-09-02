// 大图标注钉的折叠与截断 —— 纯呈现逻辑，不改变任何结论或分数。
import { describeGroupTip } from "../diff/describe.js";
import type { Issue, Marker } from "../types.js";

/** 大图上最多插这么多钉。X501 那轮 494 个钉铺在 886×448 的图上，图本身就看不见了 */
export const MAX_MARKERS = 100;
/** 后代框与祖先框重合到这个程度，两个钉在图上就是同一个框 */
export const MERGE_IOU = 0.9;

/** 待落图的钉 + 它覆盖的结论（悬停摘要要等合并完成后才能写） */
export interface Pin {
  marker: Marker;
  issues: Issue[];
}

function boxIoU(a: Marker, b: Marker): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni <= 0 ? 0 : inter / uni;
}

/** selector 是完整路径（`html>body>div#app>…`），层数即深度 */
const selectorDepth = (key: string): number => key.split(">").length;

/**
 * 钉子折叠。
 *
 * 套壳链（`div.card > div.card-inner > div.card-body` 各带一条结论）在图上画出的是
 * 一叠几乎重合的框 —— 看起来一个框，却占了 3 个钉、3 个角标编号。这里把与祖先框
 * 基本重合的后代钉合并进祖先，**结论 id 一并带上去**，所以右侧列表和分数都不受影响。
 *
 * 先深后浅：孙子先并进儿子，儿子再带着孙子的 id 并进父亲。
 * 最后按「错误优先、结论多的在前」截断 —— 截掉的是最不值得先看的那一截，不是随机一截。
 */
export function foldPins(pins: Pin[]): Marker[] {
  const absorbed = new Set<string>();
  const deepestFirst = [...pins].sort(
    (a, b) => selectorDepth(b.marker.key) - selectorDepth(a.marker.key)
  );
  for (const p of deepestFirst) {
    let host: Pin | undefined;
    for (const cand of pins) {
      if (cand === p || absorbed.has(cand.marker.key)) continue;
      if (!p.marker.key.startsWith(cand.marker.key + ">")) continue;
      if (boxIoU(p.marker, cand.marker) < MERGE_IOU) continue;
      // 并进最近的那个祖先：中间层若随后也被并走，会连着这批 id 一起上去
      if (!host || selectorDepth(cand.marker.key) > selectorDepth(host.marker.key)) host = cand;
    }
    if (!host) continue;
    host.marker.issueIds.push(...p.marker.issueIds);
    host.marker.count += p.marker.count;
    host.marker.cats = [...new Set([...host.marker.cats, ...p.marker.cats])];
    if (p.marker.severity === "error") host.marker.severity = "error";
    host.issues.push(...p.issues);
    absorbed.add(p.marker.key);
  }
  return pins
    .filter((p) => !absorbed.has(p.marker.key))
    .sort(
      (a, b) =>
        Number(b.marker.severity === "error") - Number(a.marker.severity === "error") ||
        b.marker.count - a.marker.count
    )
    .slice(0, MAX_MARKERS)
    .map((p) => ({ ...p.marker, tip: describeGroupTip(p.issues) }));
}
