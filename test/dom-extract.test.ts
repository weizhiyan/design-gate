// 实现侧采集：验证「可见但不是文本节点」的文本与 svg/img 原子化。
// 需要真实浏览器（采集脚本依赖 getComputedStyle 的伪元素读取），无 Chrome 时自动跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBrowser } from "../src/capture/browser.js";
import { domExtractSource, type DomExtractNode } from "../src/capture/dom-extract.js";
import type { Browser } from "playwright-core";

let browser: Browser | null = null;
try {
  browser = await launchBrowser();
} catch {
  /* 环境无 Chrome/Chromium：整组用例跳过 */
}

const HTML = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font-family:sans-serif}
  #wrap{position:relative;width:400px}
  #lbl::before{content:"*";color:#ff4d4f}
  #glyph{display:inline-block;width:16px;height:16px}
  #glyph::before{content:"\\e600"}
</style>
<div id="wrap">
  <label id="lbl">用户名</label>
  <input id="inp" placeholder="请输入用户名">
  <input id="filled" placeholder="请输入密码" value="abc">
  <svg id="sv" width="16" height="16" viewBox="0 0 16 16"><path id="p" d="M0 0L16 16" stroke="#000"/></svg>
  <svg id="big" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80"/></svg>
  <img id="im" width="40" height="30" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
  <i id="glyph"></i>
</div>`;

const flatten = (n: DomExtractNode, out: DomExtractNode[] = []): DomExtractNode[] => {
  out.push(n);
  n.children.forEach((c) => flatten(c, out));
  return out;
};

let nodes: DomExtractNode[] = [];
if (browser) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(HTML, { waitUntil: "load" });
  const root = (await page.evaluate(domExtractSource("#wrap"))) as DomExtractNode;
  nodes = flatten(root);
  await browser.close();
}

const byId = (sel: string): DomExtractNode | undefined => nodes.find((n) => n.id === sel);
const opts = { skip: browser ? false : "未找到可用的 Chrome/Chromium" };

test("input 的 placeholder 采集为文本（value 为空时）", opts, () => {
  assert.equal(byId("#inp")?.text, "请输入用户名");
  assert.equal(byId("#inp")?.kind, "text");
});

test("已有 value 的 input 不采集 placeholder", opts, () => {
  assert.equal(byId("#filled")?.text, undefined);
});

test("::before 的必填星号进 auxText，不覆盖节点自身文本", opts, () => {
  const lbl = byId("#lbl");
  assert.equal(lbl?.text, "用户名");
  assert.equal(lbl?.auxText, "*");
});

test("图标字体的私用区码位不算文本", opts, () => {
  const g = byId("#glyph");
  assert.ok(g, "节点应存在");
  assert.equal(g.auxText, undefined, "U+E600 是图标字形，不是可读文本");
  assert.equal(g.kind, "box");
});

test("svg 折叠为一个 icon 原子，不下钻 path", opts, () => {
  const sv = byId("#sv");
  assert.equal(sv?.kind, "icon");
  assert.deepEqual(sv?.children, []);
  assert.equal(byId("#p"), undefined, "svg 内部图形不应出现在树里");
});

test("超尺寸 svg 视为 image（与设计侧 ICON_MAX 一致）", opts, () => {
  assert.equal(byId("#big")?.kind, "image");
});

test("img 视为 image 原子", opts, () => {
  assert.equal(byId("#im")?.kind, "image");
  assert.deepEqual(byId("#im")?.children, []);
});
