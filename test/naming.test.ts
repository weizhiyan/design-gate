// 产物命名：目录名与 HTML 文件名都跟项目名走，中文必须活着到落盘那一步。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reportDirName, reportFileName, sanitizeName } from "../src/report/naming.js";
import { writeReport } from "../src/report/html.js";
import type { VerifyResult } from "../src/types.js";

test("中文项目名原样保留 —— 这是这套命名存在的理由", () => {
  assert.equal(sanitizeName("登录页"), "登录页");
  assert.equal(reportFileName("登录页"), "登录页验收.html");
  assert.equal(reportDirName("灵枢 · 画布", "2026-01-01T00-00-00"), "灵枢 · 画布");
});

test("路径分隔符与 file:// 会截断的字符被换掉，连字号和下划线留着", () => {
  // a/b 会被当成两级目录，# 之后的部分在 file:// 链接里会被当锚点丢掉
  assert.equal(sanitizeName("a/b#c"), "a b c");
  assert.equal(sanitizeName("Login:Page*v2"), "Login Page v2");
  assert.equal(sanitizeName("login-test_v5"), "login-test_v5", "常规命名不该被打碎");
});

test("给不出名字的来源退回时间戳与 report.html，而不是生成「验收.html」", () => {
  for (const bad of [undefined, "", "   ", "...", "//", "\n\t"]) {
    assert.equal(sanitizeName(bad), "", `${JSON.stringify(bad)} 应判定为无名`);
    assert.equal(reportFileName(bad), "report.html");
    assert.equal(reportDirName(bad, "2026-01-01T00-00-00"), "2026-01-01T00-00-00");
  }
});

test("超长名字截断后不留尾部空格或点（Windows 会吞掉结尾的点）", () => {
  const n = sanitizeName("项目".repeat(40));
  assert.equal(n.length, 60);
  assert.equal(/[.\s]$/.test(n), false);
  assert.equal(sanitizeName("x".repeat(59) + " 尾巴"), "x".repeat(59), "第 60 位是空格时要刮掉");
});

const result = (projectName?: string): VerifyResult => ({
  status: "FAIL",
  score: 60,
  summary: {
    total: 0,
    errors: 0,
    warnings: 0,
    info: 0,
    matched: 1,
    unmatchedDesign: 0,
    unmatchedCode: 0,
    needsReview: false,
  },
  issues: [],
  meta: {
    webUrl: "http://localhost",
    projectName,
    viewport: "1440x900",
    timestamp: "2026-01-01",
    durationMs: 1,
  },
});

async function written(projectName?: string): Promise<{ files: string[]; reportPath: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dg-name-"));
  const { reportPath } = await writeReport(result(projectName), dir);
  return { files: (await readdir(dir)).sort(), reportPath, dir };
}

test("落盘的 HTML 就叫 <项目名>验收.html，result.json 名字不动", async () => {
  const { files, reportPath, dir } = await written("定价卡片");
  try {
    assert.deepEqual(files, ["result.json", "定价卡片验收.html"]);
    assert.equal(path.basename(reportPath), "定价卡片验收.html");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("同一目录重出报告是覆盖，不是并排多留一份", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dg-name-"));
  try {
    // 草稿 → finalize 走的是同一条路：finalize 只拿到 jsonPath，靠 meta.projectName 拼回同名文件
    await writeReport(result("定价卡片"), dir);
    await writeReport(result("定价卡片"), dir);
    assert.deepEqual((await readdir(dir)).sort(), ["result.json", "定价卡片验收.html"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("项目名进报告标题，无项目名时退回 design-gate 字样", async () => {
  const { dir, reportPath } = await written("定价卡片");
  try {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(reportPath, "utf8");
    assert.match(html, /<title>定价卡片验收报告 —/);
    assert.match(html, /<h1><span class="htitle">定价卡片 设计验收报告<\/span>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const plain = await written(undefined);
  try {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(plain.reportPath, "utf8");
    assert.match(html, /<title>design-gate 验收报告 —/);
    assert.equal(path.basename(plain.reportPath), "report.html");
  } finally {
    await rm(plain.dir, { recursive: true, force: true });
  }
});
