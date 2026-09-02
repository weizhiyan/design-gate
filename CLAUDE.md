# design-gate 项目约定

Figma 设计稿 vs 前端实现的自动化验收门禁。MCP server + CLI，测量全在确定性代码里，
AI 只负责问用户和改代码，不负责量尺寸。

## 硬规则

**FIGMA_TOKEN 只从环境变量读，绝不落到任何文件里。**
不写进本文件、不写进 design-spec.yaml、不写进报告、不写进 scripts。
用户在对话里贴的 token 本工具也读不到 —— 所以也不要向用户索要 token 内容。
宿主 Agent 已通过 Figma 连接器拿到原始节点时，优先通过 `figmaSnapshot` 传入，
不需要 Token。只有 design-gate 独立根据 URL 调 Figma REST API 时才需要把 Token
写进 MCP 服务配置的 `env`；也可以给一份离线节点 JSON 走 `figmaJson`。

**这个目录不在 git 里，没有还原点。**
所以任何文件都必须一次写完整，禁止「先写一半再补」——
`src/diff/match.ts` 曾被一次部分 Write 毁掉，只能从 `dist/` 反编译捞回来。
改大文件用 Edit 逐段改，不要用 Write 覆盖。

**未经用户确认不得放宽 spec。**
改容差 / 加豁免来让验收通过属于篡改结论，必须先问用户。

## 报告 HTML 的刻意选择

`src/report/html.ts` 产出的是**单文件内联** HTML（离线可看、可直接发人）：

- 字面量色值是刻意的。这里没有 token 层、没有深色模式，别去套别的项目的
  「只能用 var(--x)」规则。
- 只做浅色模式。
- 产物落 `reports/<项目名>/<项目名>验收.html`，同一项目复验覆盖同一目录；
  要留档就让用户换个项目名。

## 改动比对逻辑前先看这两处

- `test/noise.test.ts` 是降噪行为锁。X501 那轮真实页面出过 605 条 warning、494 个图钉，
  每条用例锁的都是当时的一个对策；回归了噪声就整批回来。改 `diff/match.ts`、
  `diff/compare.ts`、`report/markers.ts` 之前先读它。
- `src/rules/score.ts` 是门禁分数的唯一实现，`engine.ts` 与 `report/html.ts`
  的 `recalcSummary()` 都走它。不要在别处再抄一份公式。

测试里不要 import `playwright-core`（`foldPins` 因此从 report/html.ts 搬到
`src/report/markers.ts`）。

## 常用命令

`npm run typecheck` / `npm test` / `npm run smoke` / `npm run smoke:mcp`。
`smoke` 会先 `tsc` 重建 dist，所以 dist 不会落后于 src。

## 验收流程是两段式

`verify_page` 出的是**草稿**：error 类 AI 直接进修复循环，待裁决项聚成不超过 8 个问题
交给用户点选，再由 `finalize_report` 应用裁决、重算分数、落正式报告。
不要拿几百条结论逐条念给用户。
