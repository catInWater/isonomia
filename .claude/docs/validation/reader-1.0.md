# Reader 1.0.0 体验改版验证报告

- **规格 / 票据 / ADR：** [S02 阅读](../specs/02-reading.md)、[S03 锚点与批注](../specs/03-anchors-annotations.md)、[S04 并排笔记](../specs/04-notes.md)、[ADR-0003](../adr/0003-source-anchors.md)、[ADR-0004](../adr/0004-notes-editor.md)
- **被测版本 / 日期：** 基线 `229a66dce095b0ec589d341457b5db448b347825` + 本地未提交工作树；版本 1.0.0；2026-11-21。
- **环境 / 数据：** Linux x86_64、Node 24.20.0、Electron 34.5.8、Nx 管理的 production build、既有 headless GNOME Wayland compositor；主视口 1236×640，窄窗 606×680 CSS px。GUI 测试只导入自动生成的 synthetic EPUB/TXT 并使用独立临时 profile；未读取真实书籍或用户 profile。Electron sandbox 保持启用。

## 验收记录

| 验收项                | 复现 / 操作                                                          | 预期                                                                                          | 实际与状态                                                                                                                 | 证据                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 版本 1.0.0            | 检查根、renderer、Electron 项目 manifest 及 production 输出 manifest | 所有应用包和生成的应用 manifest 均为 1.0.0                                                    | **通过**；构建后 `dist/apps/reader/package.json` 为 1.0.0                                                                  | Nx production build；manifest 检查                                                                                                      |
| S02 引用预览          | 点击合成 EPUB 的脚注引用                                             | 在原文附近显示自适应文本气泡；不跳章节、不改变正文滚动位置                                    | **通过**；GUI 断言正文 `scrollTop` 不变，显示引用目标文本                                                                  | [引用气泡](assets/reader-1.0/02-reference-preview.png)                                                                                  |
| S02 控制台与版面      | 移入顶部边缘、移出；检查控制台布局、正文水平溢出与字体控件           | 控制台单行并自动隐藏；正文尽量占高、无白色侧边/水平页面滚动条；固定中英衬线字体且无字体选择器 | **通过**；GUI 断言控制台高度小于 40px、移出后控制台离开可视顶部、页面无水平溢出，字体堆栈含 Times New Roman 且无字体选择器 | [阅读布局与目录](assets/reader-1.0/01-reader-layout.png)                                                                                |
| S02 目录              | 鼠标移入左缘并离开                                                   | 目录按边缘显隐，正文/笔记原比例分配剩余宽度，目录标题可读                                     | **通过**；比例变化小于 GUI 阈值 0.06，离开边缘后目录收起；目录标题及章节完整可见                                           | [阅读布局与目录](assets/reader-1.0/01-reader-layout.png)                                                                                |
| S03-A7 划线与批注     | 选择正文、操作四色符号色点；点击现存划线                             | 选区附近显示四色划线及笔记操作；已有划线原位显示批注，不依赖独立划线侧栏/控制台划线按钮       | **通过**；实测颜色、批注入口和已有划线交互                                                                                 | [选区操作浮栏](assets/reader-1.0/03-selection-palette.png)                                                                              |
| S04-A7 默认分栏与拖放 | 打开两栏、调整分隔条；收起笔记后将当前正文选区拖至右侧目标           | 默认等宽，调整/目录弹出保持比例；拖放打开笔记并插入一个可撤销来源                             | **通过**；GUI 验证调整后比例持久化、目录开合比例稳定、真实窗口内拖动和插入及撤销/重做；伪造外部 token 被拒绝               | [分栏与格式](assets/reader-1.0/05-formatting-and-resize.png)、[收起笔记的拖放目标](assets/reader-1.0/04-collapsed-note-drop-target.png) |
| S04-A7 格式           | 分别应用/取消段落、标题、项目/编号列表、引用、加粗，清除格式         | 符号按钮应用与取消格式，清除格式有效，并保留可访问名称                                        | **通过**；GUI 验证格式状态、切换和清除                                                                                     | [分栏与格式](assets/reader-1.0/05-formatting-and-resize.png)                                                                            |
| S04-A1/A4 保留笔记    | 调整分栏并重启；恢复保留的笔记与来源                                 | 编辑内容、来源引用及布局可恢复                                                                | **通过**；生产应用 GUI 重启阶段恢复笔记和引用；第二本书独立保存；移除书文件后可访问保留笔记                                | [重启后保留笔记](assets/reader-1.0/07-retained-notes-after-restart.png)                                                                 |
| 窄窗笔记              | 将窗口调整到 650×760 并打开笔记                                      | 低于 700 CSS px 使用可操作的笔记抽屉，不压缩成不可编辑双栏                                    | **通过**；窗口实际内容区 606×680，GUI 验证打开/关闭及输入                                                                  | [窄窗笔记抽屉](assets/reader-1.0/06-narrow-notes-drawer.png)                                                                            |
| 保存与恢复回归        | 编辑、自动保存、重启；测试关闭窗口前刷新及导出恢复副本               | 最新确认输入可恢复，普通关闭不丢编辑；失败时保留导出路径                                      | **通过**；GUI initial/restart/native-close 阶段均通过，测试集包含真实磁盘恢复与强制终止覆盖                                | Nx `reader:test`；GUI restart/native-close 阶段                                                                                         |

## 自动检查

- `npm exec -- nx run-many -t lint typecheck -p reader reader-ui`：通过，0 错误；保留 10 项已有非空断言警告。
- `npm exec -- nx run reader:test`：通过，110/110 测试；11 个 fixture 校验通过。
- `npm exec -- nx run reader:spec-check`：通过，检查 21 份文档及 52 个验收 ID。
- `npm exec -- nx run reader:build`：production build 成功；构建产物版本为 1.0.0。
- `npm exec -- nx run reader:notes-gui-smoke`：最终回归通过，真实 sandbox Electron 合成数据操作；覆盖初次启动、窗口重启及原生窗口关闭阶段，截图尺寸含 1236×640 与 606×680。回归补充验证专注模式插入后退出并显示笔记、跨章导航关闭旧批注气泡、外点关闭不抢注释编辑器焦点、目录边缘点击保持展开，以及窗口缩放后引用气泡仍在可视范围。
- 对本任务修改文件执行 Nx `format:check --files=...`：通过；`git diff --check`：通过。
- `npm exec -- nx format:check --base=origin/main`：通过。任务修改文件格式检查和 `git diff --check` 也通过。
- 首次 GUI 启动在新 worktree 中因 Electron 依赖目录未链接而被阻断；复用工作区已有依赖目录后，GUI smoke 三阶段全部通过。期间另修正了窗口变窄后测试断言早于响应式渲染完成的等待竞态；最终通过的 GUI 运行包含该等待条件。

## GUI 截图

所有图片来自最终通过的 Electron GUI smoke，在纳入仓库前已逐张打开核对；仅含 synthetic EPUB/TXT，不含私人书籍或 profile。

- [目录展开、等宽双栏、无裁切](assets/reader-1.0/01-reader-layout.png)
- [原文引用气泡](assets/reader-1.0/02-reference-preview.png)
- [选区颜色及符号操作浮栏](assets/reader-1.0/03-selection-palette.png)
- [笔记收起时的右侧拖放目标](assets/reader-1.0/04-collapsed-note-drop-target.png)
- [格式和拖动后的双栏](assets/reader-1.0/05-formatting-and-resize.png)
- [606 CSS px 窄窗抽屉](assets/reader-1.0/06-narrow-notes-drawer.png)
- [重启后仍可访问的保留笔记](assets/reader-1.0/07-retained-notes-after-restart.png)

## Review 修订记录

| 讨论链接 / 意见      | 处理决定与范围                                                                                             | 修改、测试与新证据                      | 新 head CI / 待用户决定                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| 本地代码审查（5 项） | 修复专注模式插入后笔记仍隐藏、跨章旧批注气泡残留、外点关闭抢编辑焦点、目录边缘按钮误收起、缩放关闭引用气泡 | 新增并通过 GUI 回归断言；最终截图已更新 | 尚无 PR 或远端 CI；未提交/推送/开 PR，等待用户决定 |

## 已知限制与人工复核

- 本次完成 Linux headless compositor 上的真实 Electron GUI 操作；未执行 Windows 实机/安装包手工验收，也未覆盖物理触屏/拖放设备、各中文 IME、不同 DPI 与完整辅助技术矩阵。报告不能替代这些人工验收。
- 当前隔离 worktree 分支为 `feature/reader-1.0.0-experience`，变更尚未提交。PR/远端 CI 尚不存在；最终审查与合并由用户执行。
