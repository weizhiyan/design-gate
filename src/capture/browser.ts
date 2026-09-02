import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import type { StyleNode } from "../types.js";
import { domExtractSource } from "./dom-extract.js";

/** 验收默认视口。设计稿量不出尺寸时用它 —— 1920 是当前大屏基准 */
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
/** 超过这个高度的设计稿是「长页面画板」而不是屏幕高，拿它当视口高会撑坏 100vh */
const MAX_VIEWPORT_H = 1200;
/** 视口宽高下限：比这还小多半是量错了（空 frame、被折叠的节点） */
const MIN_VIEWPORT = 320;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

/** Playwright 托管浏览器的缓存根目录 —— 载体自带的浏览器通常也装在这套目录下 */
function managedRoots(): string[] {
  const home = homedir();
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(home, "Library/Caches/ms-playwright"),
    path.join(home, ".cache/ms-playwright"),
    path.join(home, "AppData/Local/ms-playwright"),
  ].filter((p): p is string => !!p && existsSync(p));
}

/** chromium-<rev>/ 下各平台可执行文件的相对位置 */
const MANAGED_REL = [
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
  "chrome-linux/chrome",
  "chrome-win/chrome.exe",
  "chrome-mac/headless_shell",
  "chrome-linux/headless_shell",
];

/**
 * 找一个「内置」Chromium —— Playwright 托管的那种。
 * 优先它而不是用户日常在用的 Chrome：版本固定、没有扩展、没有用户配置，
 * 两次验收之间不会因为浏览器自动升级或某个扩展注入样式而量出不同的数。
 * 同一目录下多个版本取版本号最大的；完整 Chromium 优先于 headless shell。
 */
function findManagedChromium(): string | undefined {
  for (const root of managedRoots()) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const revs = entries
      .filter((e) => /^chromium(_headless_shell)?-\d+$/.test(e))
      .sort(
        (a, b) =>
          Number(a.includes("headless_shell")) - Number(b.includes("headless_shell")) ||
          Number(b.split("-").pop()) - Number(a.split("-").pop())
      );
    for (const rev of revs) {
      for (const rel of MANAGED_REL) {
        const exe = path.join(root, rev, rel);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return undefined;
}

export async function launchBrowser() {
  // 一律自己起、一律无头：视口/缩放/screen 三者的仿真只在我们创建的上下文里生效。
  // 需要登录态时走 borrowSession()：只把 Cookie/storage 抄过来，不复用用户那个窗口。
  const explicit = process.env.DESIGN_GATE_BROWSER;
  if (explicit) {
    // 显式指定就不再兜底：静默换一个浏览器等于让人拿着错的版本号找差异
    return chromium.launch({ executablePath: explicit, headless: true });
  }
  const managed = findManagedChromium();
  if (managed) {
    try {
      return await chromium.launch({ executablePath: managed, headless: true });
    } catch {
      /* 托管副本损坏，继续往下找 */
    }
  }
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    for (const p of CHROME_CANDIDATES) {
      try {
        return await chromium.launch({ executablePath: p, headless: true });
      } catch {
        /* 尝试下一个 */
      }
    }
  }
  throw new Error(
    "未找到可用的 Chrome/Chromium。三条路任选：" +
      "① 装一份内置副本（推荐，版本固定不随日常浏览器升级漂移）: npx playwright install chromium；" +
      "② 安装 Google Chrome；" +
      "③ 用 DESIGN_GATE_BROWSER=<可执行文件路径> 指向载体自带的浏览器。"
  );
}

/**
 * 设计稿尺寸 → 验收视口。
 *
 * 宽度必须跟设计稿一致：页面的 rem 换算和媒体查询都按宽度分档，宽度错了整页比例就错，
 * 报告里每个数字都跟着偏 —— 而那不是实现的偏差。
 * 高度只在设计稿明显是「长页面画板」时退回默认屏高：1920x3200 拿去当视口高，
 * 100vh 会被撑成 3200px，凭空造出一批假偏差。
 */
export function viewportForDesign(design: StyleNode): { width: number; height: number } {
  const w = Math.round(design.rect.w);
  const h = Math.round(design.rect.h);
  return {
    width: w >= MIN_VIEWPORT ? w : DEFAULT_VIEWPORT.width,
    height: h >= MIN_VIEWPORT && h <= MAX_VIEWPORT_H ? h : DEFAULT_VIEWPORT.height,
  };
}

/** 从本机 Chrome 借来的登录态。只有这几个字段过界，那个窗口本身不参与测量 */
interface BorrowedSession {
  cookies: Parameters<import("playwright-core").BrowserContext["addCookies"]>[0];
  local: Record<string, string>;
  session: Record<string, string>;
  /** 抄一份 UA：有些网关按 UA 拒绝请求，换了 UA 借来的凭据也会被判无效 */
  userAgent?: string;
}

/** 一次验收里 capturePage / captureElementCrops 都要用，按源缓存，只连一次 CDP */
const sessionCache = new Map<string, Promise<BorrowedSession | undefined>>();

/** 没配 DESIGN_GATE_CDP 就是普通模式：全新隔离上下文，不带任何登录态 */
function sessionFor(webUrl: string): Promise<BorrowedSession | undefined> {
  const endpoint = process.env.DESIGN_GATE_CDP;
  if (!endpoint) return Promise.resolve(undefined);
  const key = `${endpoint}|${safeOrigin(webUrl) ?? webUrl}`;
  let hit = sessionCache.get(key);
  if (!hit) {
    hit = borrowSession(endpoint, webUrl);
    sessionCache.set(key, hit);
  }
  return hit;
}

/**
 * 连上 DESIGN_GATE_CDP 指向的本机 Chrome，把登录态抄出来，**立刻断开**。
 * 只读，不动用户任何标签页；close() 在 CDP 连接上只断开，不会关掉那个浏览器。
 *
 * 为什么不直接在那个浏览器里渲染：headful 窗口的宽度和 DPR 是物理事实，
 * Playwright 的视口仿真在那种上下文里不生效。Mac 上一个 2133px@1.8x 的窗口，
 * 会让 `html{font-size:screen.width/19.2}` 这类大屏适配把整页放大 11%，
 * 此后报告里每个几何数字，都是在一个从未处于 1920 的页面上量出来的。
 */
async function borrowSession(
  endpoint: string,
  webUrl: string
): Promise<BorrowedSession | undefined> {
  let browser: import("playwright-core").Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  } catch (e) {
    throw new Error(
      `CDP 连接失败（${endpoint}）: ${e instanceof Error ? e.message : String(e)}。` +
        `请确认 Chrome 已以 --remote-debugging-port=9222 启动（需搭配独立 --user-data-dir）且端口正确。`
    );
  }
  try {
    const base = browser.contexts()[0];
    const cookies = base ? await base.cookies() : [];
    const origin = safeOrigin(webUrl);
    const src =
      base && origin ? base.pages().find((p) => safeOrigin(p.url()) === origin) : undefined;
    // 很多后台系统把 token 放在 localStorage 而不是 Cookie 里，而 storage 只能在
    // 该源的页面上下文里读。没有同源标签页就必须说出来 —— 否则验收会安静地
    // 跑出一份「登录已过期」的空页面报告，整轮白跑。走 stderr：stdout 是 MCP 协议通道。
    if (!src) {
      console.error(
        `[design-gate] CDP 浏览器里没有 ${origin ?? webUrl} 的标签页，只借到 Cookie。` +
          `若该系统的 token 存在 localStorage，页面会以未登录状态渲染 —— ` +
          `请先在那个 Chrome 里打开并登录目标页面，再重跑。`
      );
    }
    const extra = src
      ? await src
          .evaluate(() => ({
            local: Object.fromEntries(Object.entries(localStorage)) as Record<string, string>,
            session: Object.fromEntries(Object.entries(sessionStorage)) as Record<string, string>,
            userAgent: navigator.userAgent,
          }))
          .catch(() => undefined)
      : undefined;
    return {
      cookies,
      local: extra?.local ?? {},
      session: extra?.session ?? {},
      userAgent: extra?.userAgent,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 开一个采集页：视口、`window.screen`、DPR 三者全部钉死。
 *
 * `screen` 必须一起仿真 —— 大屏适配常写成 `html{font-size:screen.width/19.2}`，
 * 它读的是屏幕宽而不是视口宽；不仿真的话，物理屏幕多大页面就按多大排版，
 * 量出来的每个 px 都带着一个跟实现无关的缩放系数。
 */
async function openCapturePage(
  browser: import("playwright-core").Browser,
  viewport?: { width: number; height: number },
  session?: BorrowedSession
) {
  const vp = viewport ?? DEFAULT_VIEWPORT;
  const ctx = await browser.newContext({
    viewport: vp,
    screen: vp,
    deviceScaleFactor: 2,
    ...(session?.userAgent ? { userAgent: session.userAgent } : {}),
  });
  if (session?.cookies.length) await ctx.addCookies(session.cookies);
  const page = await ctx.newPage();
  const store = { local: session?.local ?? {}, session: session?.session ?? {} };
  if (Object.keys(store.local).length || Object.keys(store.session).length) {
    // 必须在页面脚本之前注入：页面的启动脚本会读 token 决定要不要跳登录页
    await page.addInitScript((s) => {
      const d = s as { local: Record<string, string>; session: Record<string, string> };
      for (const [k, v] of Object.entries(d.local)) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(d.session)) sessionStorage.setItem(k, v);
    }, store);
  }
  return page;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface CaptureResult {
  tree: StyleNode;
  screenshotPath: string;
  /** 截图对应的 CSS 尺寸（大图标记钉定位基准） */
  cssW: number;
  cssH: number;
}

/**
 * 打开页面 → 冻结动画 → 等待字体 → 注入采集脚本 → 全页截图。
 * 返回归一化(相对根元素原点)的 DOM 样式树。
 */
export async function capturePage(opts: {
  webUrl: string;
  selector?: string;
  viewport?: { width: number; height: number };
  outDir: string;
}): Promise<CaptureResult> {
  await mkdir(opts.outDir, { recursive: true });
  // 先借登录态：CDP 借不到时直接抛错，不必白起一个浏览器
  const session = await sessionFor(opts.webUrl);
  const browser = await launchBrowser();
  try {
    const page = await openCapturePage(browser, opts.viewport, session);
    await page.goto(opts.webUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // 尽力等待网络空闲（存在长连接/轮询的页面不阻塞验收）
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    // 冻结动画/过渡，保证截图与几何稳定
    await page.addStyleTag({
      content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`,
    });
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(200);

    const raw = (await page.evaluate(domExtractSource(opts.selector ?? null))) as
      | import("../types.js").StyleNode
      | null;
    if (!raw) throw new Error("DOM 采集结果为空");

    const screenshotPath = path.join(opts.outDir, "actual.png");
    const shotTarget = opts.selector ? page.locator(`${opts.selector} >> visible=true`).first() : page;
    await shotTarget.screenshot({ path: screenshotPath });

    let cssW: number;
    let cssH: number;
    if (opts.selector) {
      const box = await (shotTarget as import("playwright-core").Locator).boundingBox();
      cssW = Math.ceil(box?.width ?? 0) || 1;
      cssH = Math.ceil(box?.height ?? 0) || 1;
    } else {
      const dim = await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
      }));
      cssW = dim.w;
      cssH = dim.h;
    }

    // 归一化到根元素原点
    normalizeTree(raw);
    return { tree: raw as StyleNode, screenshotPath, cssW, cssH };
  } finally {
    await browser.close();
  }
}

function normalizeTree(root: StyleNode): void {
  const ox = root.rect.x;
  const oy = root.rect.y;
  const walk = (n: StyleNode) => {
    n.rect.x = Math.round((n.rect.x - ox) * 10) / 10;
    n.rect.y = Math.round((n.rect.y - oy) * 10) / 10;
    n.children.forEach(walk);
  };
  walk(root);
}

/**
 * 元素级裁剪：逐个 selector 截取元素真实渲染图（报告证据卡用）。
 * 单个失败静默跳过，不阻断验收。
 */
export async function captureElementCrops(opts: {
  webUrl: string;
  viewport?: { width: number; height: number };
  selectors: string[];
  outDir: string;
}): Promise<Record<string, string>> {
  await mkdir(opts.outDir, { recursive: true });
  const result: Record<string, string> = {};
  if (!opts.selectors.length) return result;
  const session = await sessionFor(opts.webUrl);
  const browser = await launchBrowser();
  try {
    const page = await openCapturePage(browser, opts.viewport, session);
    await page.goto(opts.webUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.addStyleTag({
      content: `*,*::before,*::after{animation:none!important;transition:none!important}`,
    });
    for (let i = 0; i < opts.selectors.length; i++) {
      const sel = opts.selectors[i];
      try {
        const loc = page.locator(sel).first();
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
        const file = path.join(opts.outDir, `a-${i}.png`);
        await loc.screenshot({ path: file, timeout: 6000 });
        result[sel] = file;
      } catch {
        /* 该元素裁剪失败，跳过 */
      }
    }
  } finally {
    await browser.close();
  }
  return result;
}

/**
 * 从整图（如 Figma frame 导出 PNG）中按矩形裁剪，输出小图。
 * scale: 图片像素 / 设计 px 的倍率（exportNodePng 用 scale=2）。
 */
export async function cropImageFile(
  imgPath: string,
  rect: { x: number; y: number; w: number; h: number },
  scale: number,
  outPath: string
): Promise<string | null> {
  try {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent(`<body style="margin:0"><div id="c"><img id="i" src="file://${imgPath}"></div></body>`);
      const nat = await page.evaluate(() => {
        const img = document.getElementById("i") as HTMLImageElement;
        return { w: img.naturalWidth, h: img.naturalHeight };
      });
      await page.evaluate(
        ({ scale, rect, naturalW }) => {
          const img = document.getElementById("i") as HTMLImageElement;
          const c = document.getElementById("c") as HTMLDivElement;
          c.style.position = "relative";
          c.style.width = `${rect.w}px`;
          c.style.height = `${rect.h}px`;
          c.style.overflow = "hidden";
          img.style.width = `${Math.round(naturalW / scale)}px`;
          img.style.height = "auto";
          img.style.position = "absolute";
          img.style.left = `${-rect.x * scale}px`;
          img.style.top = `${-rect.y * scale}px`;
        },
        { scale, rect, naturalW: nat.w }
      );
      await page.locator("#c").screenshot({ path: outPath, timeout: 6000 });
      return outPath;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}
