# design-gate

**把 Figma 设计稿和真实网页放在一起，帮助团队判断“做出来的页面是否符合设计”的验收工具。**

## 先看懂它

设计稿表达的是“应该长什么样”，网页表达的是“实际做成了什么样”。两者经常会出现
间距不一致、元素位置偏移、颜色或字体不对、漏做元素等问题。design-gate 会把这两份
结果放在同一份报告里，指出具体是哪一个元素、哪一项属性存在差异，并给出是否通过的结论。

它不是只让 AI “看截图猜问题”。工具会读取 Figma 和网页中的结构化数据，再用固定规则和
确定性代码计算差异，最后生成一份可以打开、查看、筛选和定位问题的 HTML 验收报告。
<img width="3002" height="1728" alt="image" src="https://github.com/user-attachments/assets/3e8b241c-ac01-4ec7-a5f9-314beeea70df" />


## 验收流程

```text
提供 Figma 设计稿 + 网页地址
          ↓
读取设计稿结构，以及网页真实渲染后的元素数据
          ↓
匹配两边对应的元素
          ↓
用固定规则计算位置、尺寸、颜色、字体、圆角等差异
          ↓
生成 HTML 验收报告 + JSON 结果
          ↓
人工确认有歧义的问题，形成最终结论
```

报告中通常会看到：

- **对比画布**：设计稿与网页实现叠加显示，可拖动分界线、缩放和定位标注。
- **问题列表**：红色表示需要修复的错误，黄色表示警告或需要进一步确认的差异。
- **精确定位**：每条问题会关联到页面中的元素，并显示设计值、实现值和差异原因。
- **修复参考**：对常见的样式问题给出简短的修改方向或代码片段。
- **待裁决项**：例如设计稿只画了几行示例数据，但网页展示了真实数据；这类情况不能
  仅凭像素判断对错，会交给人确认。

## 它能判断什么

程序可以稳定判断这些内容：

- 元素的位置和尺寸是否偏移
- 背景色、文字颜色是否接近
- 字号、字重、字体族和行高是否一致
- 圆角、间距、内边距和栅格是否符合规范
- 实现中的颜色是否使用了规定的设计 Token
- 设计中有但网页没有，或网页有但设计中没有的元素

这些内容不能完全交给程序决定：

- hover、focus、disabled 等交互状态是否符合预期
- 动画过程、复杂手势和动态数据的业务逻辑
- 设计稿中的示例内容与真实业务数据之间是否允许不同
- 某个差异是否是产品有意为之，而不是实现错误

因此，验收结果分为“自动计算的问题”和“等待人工裁决的问题”。AI 可以帮助把你的
描述整理成清晰的问题和验收结论，但不会替你把有业务含义的差异擅自判定为通过。

## Figma Token 要不要

**不一定需要。** 如果当前使用的 Agent 已经通过 Figma 连接器拿到了设计稿的原始节点快照，
直接把快照作为 `figmaSnapshot` 传给工具即可，不需要在 design-gate 中重复配置
`FIGMA_TOKEN`。

只有在 design-gate 自己根据 Figma URL 独立调用 Figma REST API、没有可复用的快照时，
才需要配置 Figma Personal Access Token。也可以使用上一次验收生成的
`design-node.json` 离线复验。Token 只应放在本地环境变量或 MCP 配置中，不要写入报告、
代码库或对话。

## 它适合谁

- 产品、设计和开发一起做页面验收
- 用 Trae、Codex、Claude Code 等 AI 编码代理做修复闭环
- 在 CI 中把视觉规范变成可重复执行的门禁
- 需要把验收结果交给非技术人员查看和确认

下面是完整的命令行和 MCP 接入说明。

它既可以独立通过 Figma REST API 读取设计稿，也可以接收宿主 Agent 已经通过 Figma
连接器取得的原始节点快照。后者通过 `figmaSnapshot` 传入，不需要在每个 Agent 环境里
重复配置 `FIGMA_TOKEN`。

```
Figma 连接器/REST API ──▶ 设计真值(结构化样式树)  ┐
                                              ├─▶ 元素匹配 ─▶ 确定性 diff ─▶ 验收报告
Playwright     ──▶ 实现真值(bbox+computedStyle) ┘   (多信号)    (零AI测量)     (HTML+JSON)
```

## 快速开始

```bash
npm install
npm run build
export FIGMA_TOKEN=你的figma_personal_access_token   # file read 权限即可

# 线上模式
node dist/cli.js \
  --figma "https://www.figma.com/design/KEY/File#node-id=12-34" \
  --web http://localhost:3000/pricing \
  --selector ".pricing-card" \
  --name "定价卡片" \
  --spec ./design-spec.yaml

# 离线冒烟（无需 Figma 账号，验证安装完整性）
npm run smoke
```

退出码即门禁：`PASS=0` / `FAIL=1` / `异常=2`，可直接接入 CI。

报告输出在 `reports/<项目名>/`，里面是 `<项目名>验收.html`（人看）+ `result.json`（AI/程序看）。
项目名来自 `--name`（可用中文），省略时取设计稿 frame 名；两个都没有才退回 `reports/<时间戳>/report.html`。
同一项目复验**覆盖同一目录** —— 要留档就换个项目名，或用 `--out` 指定目录。

## 接入 AI 载体（MCP）

构建后以 stdio 方式启动 `dist/mcp.js`，提供 5 个工具。它们按三阶段协议依次调用
（完整协议见 `get_acceptance_checklist` 的返回内容）：

| 阶段 | 工具 | 说明 |
|---|---|---|
| 0 · 开始前必读 | `get_acceptance_checklist()` | 取验收对话流程清单：先问什么、结果怎么分类、什么行为被禁止 |
| 1 · 收集参数 | `figma_frame_info(figmaUrl, figmaSnapshot?)` | 读取 Figma 链接或宿主已取得的快照，返回 frame 名/画布尺寸，以及默认会用的 viewport |
| 1 · 收集参数 | `inspect_selectors(webUrl)` | 列出页面顶层候选容器，帮用户定 `selector` |
| 2 · 执行验收 | `verify_page(webUrl, figmaUrl?, figmaSnapshot?, figmaJson?, selector?, viewport?, specPath?, projectName?, outDir?)` | 执行比对，返回**草稿**结论 + 问题清单 + 报告路径 |
| 3 · 落正式报告 | `finalize_report(jsonPath, decisions)` | 应用人工裁决（`confirmed`/`accept`/`reject`）、重算分数、生成正式报告，并把 accept/reject 沉淀进 `LEARNINGS.md` |

`verify_page` 出的是**草稿**：数值类问题（几何/颜色/字体）可以直接进修复循环，
但存在性差异这类需要人判断的会挂在「待裁决」里 —— 正式结论必须过 `finalize_report`，
否则被裁决为「可接受」的差异不会从分数里扣除，也不会沉淀成下次的规则。

**Trae** — 设置 → MCP → 添加服务器：

```json
{
  "mcpServers": {
    "design-gate": {
      "command": "node",
      "args": ["/绝对路径/design-gate/dist/mcp.js"],
      "env": { "FIGMA_TOKEN": "你的token" }
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`：

```toml
[mcp_servers.design-gate]
command = "node"
args = ["/绝对路径/design-gate/dist/mcp.js"]
env = { "FIGMA_TOKEN" = "你的token" }
```

**关于 FIGMA_TOKEN**：宿主 Agent 如果已经通过 Figma 连接器拿到了原始节点 JSON，
直接把它作为 `figmaSnapshot` 传给 `figma_frame_info` / `verify_page`，不需要 Token。
只有 `design-gate` 独立根据 Figma URL 调 REST API 时，才需要把 `FIGMA_TOKEN` 写进 MCP
服务配置的 `env` 块。也可以使用上次生成的 `reports/<项目名>/design-node.json`
作为 `figmaJson` 离线复验。不要在对话里粘贴 Token 内容。

**典型提示词**（修复循环）：

> 用 design-gate 验收 Figma <链接> 与 http://localhost:3000/xxx。
> 先看 get_acceptance_checklist，按它的流程走：用 figma_frame_info 验链接，
> 用 verify_page 出草稿结论，按必须修复项逐条改代码后重跑，直到只剩待裁决项；
> 把待裁决项念给我逐条决策，最后用 finalize_report 出正式报告。

## 项目规范（验收的"法律"）

复制 `templates/design-spec.yaml` 到项目根目录并按需修改：

- `grid: [4, 8]` —— 间距必须是 4/8 的倍数
- `tolerances` —— 几何/颜色ΔE/圆角容差分级（warn / error）
- `requireTokens: true` + `tokens` 表 —— 禁止硬编码色值
- `exemptions` —— 白名单豁免（第三方组件、装饰元素），命中降级为 info 并注明理由。
  百度地图（`BMap_`）、Element Plus 浮层（`el-popper`/`el-input__suffix`）这类
  「设计稿里不可能画」的 DOM 已内置默认豁免；不需要就写 `defaultExemptions: false` 关掉

经验沉淀方式：人工裁决"可接受"的差异 → 写入 `exemptions` 或调整容差 → 规则固化、结果可复现。

## 检查项

| 类别 | 内容 | 默认判定 |
|---|---|---|
| geometry | x/y/w/h vs getBoundingClientRect | ≥2px 警告 / ≥8px 错误 |
| color | 背景/文字色 CIEDE2000 色差 | ΔE≥2.3 警告 / ≥5 错误 |
| typography | 字号/字重/字体族/行高 | 不匹配按幅度分级 |
| radius | 圆角（含全圆角等价 clamp） | ≥1px 警告 / ≥3px 错误 |
| grid | gap/padding 是否在栅格倍数上 | 违规警告 |
| token | 实现色值是否命中 tokens 表 | 硬编码错误 |
| existence | 设计有码无 / 码有设计无 | error / warning |
| existence(列表) | 重复列表行数差（设计画 5 行 / 页面 14 行） | 收成一条待裁决 |

## 架构

```
src/
├── figma/       parse-url(链接解析) client(REST+缓存) adapter(节点树→样式树/容器吸收文本/坐标归一)
├── capture/     browser(无头Chromium/视口+screen钉死/CDP借登录态) dom-extract(注入脚本:遍历DOM/折叠包装层)
├── diff/        match(根锚定→df-id→重复列表下标→文本锚点→几何贪心) compare(逐属性diff)
│                geometry(相对父级/前序兄弟的局部关系) color(CIEDE2000) describe(结论转人话)
├── rules/       spec(规范加载+默认容差+第三方默认豁免) score(评分与门禁) questions(按根因聚成几问)
├── report/      html(自包含报告) markers(图钉折叠) fixes(纯净修复代码块) naming(目录/文件命名)
├── engine.ts    编排器 + formatSummary
├── cli.ts       命令行入口（CI 门禁）
└── mcp.ts       MCP server 入口
```

### 关键设计决策

- **结构化对比优先于截图对比**：截图只作为报告证据；测量全部由固定代码完成，数字精确到属性。
- **纯文本节点跳过宽高比对**：Figma 文本框紧贴内容 vs DOM 块级撑满，宽高天然不可比。
- **容器吸收唯一文本子节点**：对齐两侧结构模型（DOM 文本挂在带样式元素上）。
- **坐标归一化**：双侧均平移到根原点，消除页面内绝对偏移影响。
- **位置用局部关系而非绝对坐标**：相对父级的内偏移 / 与前序兄弟的间隔。否则父级一处偏移
  会在每个后代身上重复上报一遍，一个根因变成十几条结论。
- **匹配信号由强到弱**：根节点强制配对 > `data-df-id` 显式标注 > 重复列表按下标对齐 >
  文本锚点 > 几何贪心。占了半张画布的大块另有闸门：边长比与几何分都不够就宁可不配 ——
  这种配对错一次，整棵子树的偏差全是假的。
- **配对置信度分两档**：低置信度（<0.55）的 error 降为 warning；配对本身还没确认的
  （<0.4）不计分，只作为「请先确认这是同一个元素」的待确认项 —— 这一档的差异读不出
  「实现对不对」，按 warning 报出来全是噪声。
- **视口跟着设计稿走，且 `window.screen` 一起仿真**：`viewport` 留空时宽度取 frame 宽
  （高 >1200 的长画板退回 1080）。宽度不等于设计稿宽，页面的 rem 换算和媒体查询就整体换档，
  报告里每个几何数字都带一个跟实现无关的缩放系数。`screen` 也必须仿真 —— 大屏适配常写成
  `html{font-size:screen.width/19.2}`，读的是屏幕宽而不是视口宽。
- **一律无头、一律自己起浏览器**：headful 窗口的宽度与 DPR 是物理事实，视口仿真在那种
  上下文里不生效（Mac 上 2133px@1.8x 的窗口会把整页放大 11.1%）。需要登录态时走 CDP
  只借凭据，用户那个浏览器不参与测量。
- **重复列表按模板对齐**：设计稿画 5 行示意、页面渲染 14 行真实数据是常态。同构兄弟
  ≥3 行即识别为列表，逐行按下标配对，行数差收成**一条**待裁决结论而不是 N+M 条存在性问题。

## 已知边界（Roadmap）

- [ ] 复杂嵌套布局的多层 padding 累积（计划引入盒间边界距离）
- [ ] 渐变/图片填充回退到局部截图视觉比对
- [ ] hover/focus/disabled 状态覆盖检查
- [ ] 多断点（移动端 375 等）批量验收
- [ ] token 漂移聚类（N 个元素同向偏差 → 一个 token 修复建议）

## 环境要求

Node ≥ 20；一个 Chromium 内核浏览器，按下列优先级自动挑一个：
`DESIGN_GATE_BROWSER=<可执行文件路径>`（载体自带浏览器填这里）→ Playwright 托管的 Chromium
（`npx playwright install chromium`，版本固定、不随日常浏览器升级漂移）→ 系统 Chrome → 常见安装路径。
Figma PAT 仅在线上模式需要，且设计稿必须是 Design file（Draft 不受 API 支持）。

要验的页面需要登录时，配 `DESIGN_GATE_CDP=http://127.0.0.1:9222` 指向一个带
`--remote-debugging-port` 启动的 Chrome：只从中借 Cookie/localStorage/UA 并立刻断开，
渲染仍在我们自己起的无头上下文里 —— 详见 `使用说明.md` 第三节。
