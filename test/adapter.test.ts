// 设计侧适配器：验证「两侧粒度对齐」的折叠规则。
// 这些规则的目的不是少报问题，而是不产出结构上不可能满足的假问题。
import { test } from "node:test";
import assert from "node:assert/strict";
import { figmaToStyleTree } from "../src/figma/adapter.js";
import { box, byName, fig, figText, flat, imageFill, solid } from "./helpers.js";

test("图标尺寸内的矢量子树折叠为一个 icon 叶子", () => {
  const icon = fig("FRAME", "mail-01", box(10, 10, 24, 24), [
    fig("VECTOR", "Vector 7163", box(10, 12, 24, 20), [], { fills: solid("#333333") }),
    fig("VECTOR", "Subtract", box(12, 14, 20, 16)),
    fig("VECTOR", "Union", box(14, 16, 16, 12)),
  ]);
  const root = figmaToStyleTree(fig("FRAME", "Root", box(0, 0, 400, 300), [icon]));

  const found = byName(root, "mail-01");
  assert.ok(found, "图标节点应保留");
  assert.equal(found.kind, "icon");
  assert.deepEqual(found.children, [], "内部 VECTOR 不应出现在树里");
  assert.equal(flat(root).length, 2, "Root + 一个图标 = 2 个节点");
});

test("超尺寸的矢量容器不整体折叠，避免把并列图标合成一个", () => {
  const a = fig("FRAME", "mail-01", box(0, 0, 24, 24), [fig("VECTOR", "v1", box(0, 0, 24, 24))]);
  const b = fig("FRAME", "lock-01", box(200, 0, 24, 24), [fig("VECTOR", "v2", box(200, 0, 24, 24))]);
  const group = fig("GROUP", "elements", box(0, 0, 224, 24), [a, b]);
  const root = figmaToStyleTree(fig("FRAME", "Root", box(0, 0, 400, 300), [group]));

  assert.equal(byName(root, "elements")?.children.length, 2, "两个图标必须各自独立");
  assert.equal(byName(root, "mail-01")?.kind, "icon");
  assert.equal(byName(root, "lock-01")?.kind, "icon");
});

test("超尺寸裸矢量视为 image 原子", () => {
  const root = figmaToStyleTree(
    fig("FRAME", "Root", box(0, 0, 400, 300), [fig("VECTOR", "blob", box(0, 0, 300, 200))])
  );
  const n = byName(root, "blob");
  assert.equal(n?.kind, "image");
  assert.deepEqual(n?.children, []);
});

test("满铺纯填充矩形被吸收为父节点背景", () => {
  const card = fig("FRAME", "Card", box(0, 0, 200, 100), [
    fig("RECTANGLE", "bg", box(0, 0, 200, 100), [], { fills: solid("#ff0000") }),
    figText("t1", box(10, 10, 80, 20), "标题"),
    figText("t2", box(10, 40, 80, 20), "副标题"),
  ]);
  const root = figmaToStyleTree(fig("FRAME", "Root", box(0, 0, 400, 300), [card]));

  assert.equal(byName(root, "bg"), undefined, "背景层不应作为独立节点");
  assert.equal(byName(root, "Card")?.style.backgroundColor, "#ff0000", "背景色应上浮到父节点");
});

test("满铺位图层同样被吸收（对应 DOM 的 background-image）", () => {
  const card = fig("FRAME", "Hero", box(0, 0, 400, 300), [
    fig("RECTANGLE", "bg_upscayl_2x", box(0, 0, 400, 300), [], { fills: imageFill() }),
    figText("t1", box(10, 10, 80, 20), "标题"),
    figText("t2", box(10, 40, 80, 20), "副标题"),
  ]);
  const root = figmaToStyleTree(card);
  assert.equal(byName(root, "bg_upscayl_2x"), undefined);
});

test("带描边的满铺矩形不吸收（可能是输入框等真实控件）", () => {
  const inner = fig("RECTANGLE", "input-bg", box(0, 0, 200, 40), [], {
    fills: solid("#ffffff"),
    strokes: solid("#cccccc"),
    strokeWeight: 1,
  });
  const wrap = fig("FRAME", "Wrap", box(0, 0, 200, 40), [inner, figText("ph", box(8, 10, 50, 20), "请输入")]);
  const root = figmaToStyleTree(fig("FRAME", "Root", box(0, 0, 400, 300), [wrap]));

  assert.ok(byName(root, "input-bg"), "带描边的满铺矩形应保留为独立节点");
});

test("AUTO 行高(INTRINSIC_%)不产出 lineHeight，显式 PIXELS 才产出", () => {
  const mk = (unit?: string) =>
    figmaToStyleTree(
      fig("FRAME", "Root", box(0, 0, 400, 300), [
        figText("T", box(0, 0, 200, 140), "欢迎使用", {
          fontSize: 94,
          lineHeightPx: 131.6,
          ...(unit ? { lineHeightUnit: unit } : {}),
        }),
      ])
    );

  assert.equal(mk("INTRINSIC_%").style.lineHeight, undefined, "AUTO 行高不是设计决定，不应参与比对");
  assert.equal(mk("PIXELS").style.lineHeight, 131.6);
  assert.equal(mk("FONT_SIZE_%").style.lineHeight, 131.6);
});

test("kind 标注：文本为 text，纯容器为 box", () => {
  const root = figmaToStyleTree(
    fig("FRAME", "Root", box(0, 0, 400, 300), [
      figText("t1", box(0, 0, 100, 20), "甲"),
      figText("t2", box(0, 40, 100, 20), "乙"),
    ])
  );
  assert.equal(root.kind, "box");
  assert.equal(byName(root, "t1")?.kind, "text");
});
