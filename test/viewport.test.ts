// 视口策略的行为锁。
//
// 真实页面上踩过的坑：接 CDP 就等于在一个**真实窗口**里渲染，Playwright 的视口仿真
// 在那种上下文里不生效。Mac 上一个 2133px@1.8x 的窗口，会让页面的
// `html{font-size:screen.width/19.2}` 把整页放大 11.1% —— 此后报告里每个几何数字，
// 都是在一个从未处于 1920 的页面上量出来的，而那不是实现的偏差。
//
// 两组用例分别锁住对策的两半：默认视口跟着设计稿走；渲染时 screen 与视口一起钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_VIEWPORT,
  capturePage,
  launchBrowser,
  viewportForDesign,
} from "../src/capture/browser.js";
import type { StyleNode } from "../src/types.js";
import { flat, sn } from "./helpers.js";

// ---------- 1. 默认视口来自设计稿（纯函数，不需要浏览器） ----------

const design = (w: number, h: number): StyleNode => sn("frame", { x: 0, y: 0, w, h });

test("默认视口取设计稿尺寸", () => {
  assert.deepEqual(viewportForDesign(design(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(viewportForDesign(design(1440, 900)), { width: 1440, height: 900 });
  assert.deepEqual(viewportForDesign(design(375, 812)), { width: 375, height: 812 });
});

test("长页面画板只退回默认屏高，宽度仍按设计稿", () => {
  // 1920x3200 的长图拿去当视口高，100vh 会被撑成 3200px，凭空造出一批假偏差
  assert.deepEqual(viewportForDesign(design(1920, 3200)), {
    width: 1920,
    height: DEFAULT_VIEWPORT.height,
  });
});

test("量不出尺寸时退回 1920x1080", () => {
  assert.deepEqual(viewportForDesign(design(0, 0)), DEFAULT_VIEWPORT);
  assert.deepEqual(viewportForDesign(design(100, 80)), DEFAULT_VIEWPORT, "比 320 还小多半是空 frame");
});

test("小数尺寸四舍五入到整 px", () => {
  assert.deepEqual(viewportForDesign(design(1919.6, 1079.5)), { width: 1920, height: 1080 });
});

// ---------- 2. window.screen 必须跟视口一起仿真 ----------

let hasBrowser = false;
try {
  const probe = await launchBrowser();
  await probe.close();
  hasBrowser = true;
} catch {
  /* 环境无 Chrome/Chromium：跳过需要渲染的用例 */
}

const needBrowser = { skip: hasBrowser ? false : "未找到可用的 Chrome/Chromium" };
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/rem-adapt.html");

test("大屏 rem 适配：1920 视口下根字号正好 100px", needBrowser, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "dg-vp-"));
  try {
    const { tree } = await capturePage({
      webUrl: pathToFileURL(FIXTURE).href,
      viewport: DEFAULT_VIEWPORT,
      outDir,
    });
    const nodes = flat(tree);
    const probe = nodes.find((n) => n.id === "#probe");
    const box = nodes.find((n) => n.id === "#box");

    assert.equal(probe?.text, "1920x1080", "页面读到的 screen 必须是仿真值，不是物理屏幕");
    assert.equal(probe?.style.fontSize, 100, "根字号 = screen.width / 19.2 = 100px");
    // 真实屏幕漏进来时这里是 1110.9（2133/19.2×10）—— 报告里每个几何数字跟着偏 11.1%
    assert.equal(box?.rect.w, 1000, "10rem 必须量成 1000px");
    assert.equal(box?.rect.h, 200);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
