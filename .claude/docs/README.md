# Reader 文档入口

- [产品需求](PRD.md)：产品目标、范围和需求编号。
- [实施规格](specs/README.md)：阶段 0–7 的行为契约和验收标准。
- [开发票据](tickets/README.md)：依赖、优先级、实施范围与需求覆盖表。
- [ADR-0001](adr/0001-phase-zero-foundation.md)：阶段 0 进程边界、存储恢复、测试与安全审计记录。
- [ADR-0002](adr/0002-reading-adapter.md)：阶段 2 文本适配器、内容位置、进度持久化与双模式阅读。
- [阶段 3 GUI 检查截图](validation/03-anchors-annotations.md)：9 张 Linux Electron 原始截图、验收关联与证据边界。
- [阶段 4 笔记验证](validation/04-notes.md)：保存/迁移/终止回归、引用/分栏/批注汇入、重启/正常关闭及 5 张真实 GUI 截图；[笔记 ADR](adr/0004-notes-editor.md)。
- [Reader 项目交付技能](../skills/reader-delivery/SKILL.md)：feature / fix 的分支、验证、PR 截图、CI 与 review 讨论循环；从 `/reader-delivery` 启动。
- [Reader delivery 技能验证报告](validation/reader-delivery-skill.md)：skill 结构、文档检查、格式检查与 dry-run 限制。

推进顺序：确认相关未决项 → 规格 ready → 必要 ADR → 票据实现 → 自动测试与 Windows 验收 → 附证据关闭票据。

规格和票据均为草案，不表示功能已实现。v1 目标为 Windows；同步和手动完整备份留至 v1.5，P2 为候选范围。技术取舍实施时记录到 docs/adr。
