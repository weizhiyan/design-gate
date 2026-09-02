# 验收流程规则（粘贴到 Trae 项目规则 / AGENTS.md / Codex instructions）

## design-gate 设计验收规约

1. **验收前必读**：先读 `design-spec.yaml`（判定规则）和 `LEARNINGS.md`（历史经验），再调用 verify_page。
2. **验收入口**：使用 design-gate MCP 的 `verify_page` 工具；不要用截图肉眼对比代替结构化验收。
3. **修复循环**：拿到 FAIL 结果后，按 issue 清单逐条修（每条都有设计值/实际值/差值/selector，直接替换数值），
   全部修完后重新调用 verify_page 复验，直到 PASS 或仅剩 info 级。
4. **禁止行为**：
   - 未经我确认，不得修改 design-spec.yaml 的容差或白名单来"让验收通过"
   - 不得跳过 error 级问题宣称完成
   - 不得对同一问题反复盲改超过 3 轮——应停下来报告卡点
5. **裁决沉淀**：每轮结束后，把人工裁决的新结论追加到 LEARNINGS.md 对应章节；
   确定性规则（可接受的偏差）提醒我同步进 design-spec.yaml。
6. **报告归档**：PASS 后保留 reports/ 下该次 result.json 作为验收凭证。
