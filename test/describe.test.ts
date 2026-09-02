// 显示层数值收敛。真实页面 X501 的报告里出现过
// `4.8000006675720215/4.8000006675720215/4.8000006675720215/4.8000006675720215`
// 这种值：Figma 自带的浮点尾巴，读它没有意义，还会把右栏撑破。
// 这里锁的是「给人看的字符串怎么写」，不是比对阈值 —— 阈值走原始数值，不经过 trimNums。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeIssuePlain, trimNums } from "../src/diff/describe.js";
import type { Issue } from "../src/types.js";

const issue = (over: Partial<Issue>): Issue => ({
  id: "ISS-001",
  severity: "warning",
  category: "radius",
  property: "border-radius",
  designValue: "8/8/8/8",
  actualValue: "6/6/6/6",
  message: "圆角偏差",
  selector: "div.card",
  ...over,
});

test("浮点尾巴收到 2 位小数", () => {
  assert.equal(trimNums("9.140000343322754", "border-radius"), "9.14");
  assert.equal(trimNums("4.8000006675720215", "border-radius"), "4.8");
  // 本来就短的数值原样保留，不要补零也不要动
  assert.equal(trimNums("1.5", "line-height"), "1.5");
  assert.equal(trimNums("0.5px", "border-width"), "0.5px");
  assert.equal(trimNums("16px", "font-size"), "16px");
});

test("四角写法各值相同就缩成一个值", () => {
  assert.equal(trimNums("8/8/8/8", "border-radius"), "8");
  assert.equal(trimNums("9.140000343322754/9.140000343322754/9.140000343322754/9.140000343322754", "border-radius"), "9.14");
  // 各角不同必须原样保留，缩写会丢信息
  assert.equal(trimNums("8/8/0/0", "border-radius"), "8/8/0/0");
});

test("图层名里的斜杠不会被并掉", () => {
  assert.equal(trimNums('RECTANGLE "a/a"', "element"), 'RECTANGLE "a/a"');
});

test("圆角的 16777200 哨兵值译成全圆角，别的属性上的大数照原样", () => {
  assert.equal(trimNums("16777200/16777200/16777200/16777200", "border-radius"), "全圆角");
  assert.equal(trimNums("16777200/16777200/8/8", "border-radius"), "全圆角/全圆角/8/8");
  // 宽度真有一万多就是一万多，不能替换成文案
  assert.equal(trimNums("16777200", "w"), "16777200");
});

test("空值不炸", () => {
  assert.equal(trimNums(undefined), "");
  assert.equal(trimNums(""), "");
});

test("人话描述里也不出现浮点尾巴", () => {
  const line = describeIssuePlain(
    issue({ designValue: "4.8000006675720215/4.8000006675720215/4.8000006675720215/4.8000006675720215" })
  );
  assert.ok(!/\d\.\d{3,}/.test(line), `描述里仍有浮点尾巴: ${line}`);
  assert.ok(line.includes("4.8"), `描述里应保留 4.8: ${line}`);
});
