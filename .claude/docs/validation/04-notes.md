# 阶段 4 笔记验证报告

- **规格 / 票据 / ADR：** [S04](../specs/04-notes.md)、[S00](../specs/00-engineering.md)、T-018/T-019；D-03/D-06/D-07 已于 2026-11-20 确认。
- **被测版本 / 日期：** `feature/phase-4-notes` 工作树，2026-11-20；未提交。
- **环境 / 数据：** Linux；Node/npm 与仓库锁定依赖；合成 fixture 检查。未使用真实用户 profile 或私人书籍。

## 验收记录

| 验收项               | 复现 / 操作                                                            | 预期                               | 实际与状态                                                                                  | 证据                                                                        |
| -------------------- | ---------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| T-018 基础笔记持久化 | 打开书籍，编辑右侧笔记，等待 2 秒或点击立即保存，重启后加载同一 bookId | 一书一份，修订号递增，保存状态可见 | **部分通过**：NotesManager、IPC、右侧编辑器和 2 秒 debounce 已实现；未完成真实 GUI 重启验收 | `apps/reader/src/app/library/notes.cjs`、`apps/reader-ui/src/app/notes.tsx` |
| S04-A2 五类格式      | 在编辑器使用加粗、标题、列表、引用和段落，再保存/重载                  | 格式往返且无脚本                   | **部分通过**：编辑器按钮与受限 HTML 序列化已实现；未补持久化集成测试                        | `apps/reader-ui/src/app/note-document.ts`                                   |
| S04-A3 异常保存      | 注入乱序、满盘、终止和迁移失败                                         | 已确认修订不丢，失败不显示已保存   | **未验证**：尚未补 NotesManager 的真实磁盘/进程注入测试                                     | —                                                                           |
| T-019 分栏与引用     | 左读右写、拖放选区、锚点回跳、撤销/重做、缺书编辑                      | 引用保存 anchorId/快照并可回跳     | **未完成**：当前仅加入右侧编辑器；尚未实现引用数据模型、拖放、回跳及撤销/重做               | —                                                                           |

## 自动检查

- `npm exec -- nx run-many -t typecheck -p reader reader-ui`：通过。
- `npm exec -- nx run-many -t lint typecheck -p reader reader-ui`：通过。
- `npm exec -- nx run reader:test`：通过，74 tests、11 fixtures。
- `npm exec -- nx run reader:spec-check`：通过，17 documents、49 acceptance IDs。
- `npm exec -- nx build reader`：通过，生产构建成功。
- `npm exec -- nx format:check --base=origin/main`：未运行；当前环境无法 fetch 远端，且本地未确认目标基线格式命令输出。

## GUI 截图

**未验证。** 本分支没有 `reader:gui-smoke` target；Linux Electron 实际交互、截图和临时 profile 重启验证尚未完成。因此没有提交截图，也不将构建结果冒充 GUI 证据。

## 已知限制与人工复核

- 当前实现是 T-018 的第一段可运行闭环，不应标记阶段 4 完成。
- T-019 仍需实现稳定 note 文档中的引用节点、单次插入与等价拖放、来源快照/anchorId、失效位置显示、单步撤销/重做及布局持久化。
- 需要补真实磁盘错误、乱序保存和终止恢复测试；需要 Windows 实机验收。
