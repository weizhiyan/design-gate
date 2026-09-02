// 测试用的 Figma 节点构造器 + 树查询工具。
import type { StyleNode } from "../src/types.js";

let seq = 0;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

export const solid = (hex: string) => [{ type: "SOLID", color: rgb(hex) }];
export const imageFill = () => [{ type: "IMAGE", imageRef: "abc", scaleMode: "FILL" }];

/* eslint-disable @typescript-eslint/no-explicit-any */
export function fig(type: string, name: string, b: Box, children: any[] = [], extra: any = {}): any {
  return { id: `1:${++seq}`, name, type, absoluteBoundingBox: b, children, ...extra };
}

export function figText(name: string, b: Box, characters: string, style: any = {}, extra: any = {}): any {
  return fig("TEXT", name, b, [], { characters, style: { fontSize: 16, ...style }, fills: solid("#000000"), ...extra });
}

export function flat(n: StyleNode, out: StyleNode[] = []): StyleNode[] {
  out.push(n);
  n.children.forEach((c) => flat(c, out));
  return out;
}

export function byName(root: StyleNode, name: string): StyleNode | undefined {
  return flat(root).find((n) => n.name === name);
}

/** 构造一个比对用的 StyleNode（匹配算法测试用） */
export function sn(
  id: string,
  rect: { x: number; y: number; w: number; h: number },
  extra: Partial<StyleNode> = {}
): StyleNode {
  return { id, name: id, type: "div", rect, style: {}, children: [], ...extra };
}
