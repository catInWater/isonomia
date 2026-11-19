# ADR-0001 阶段 0 工程基础

- 状态：已实施基础验证；产品范围与 Windows 验收仍待确认
- 阶段 1 补充：D-05 已按导入时复制书文件至应用私有 `userData/data/books` 决定（2026-11-19）
- 日期：2026-11-18
- 关联：S00、S00-A4/A5/A6/A7、T-000～T-005

## 背景

Reader 是本地优先 Electron 应用。书籍输入不可信，用户内容需独立于书籍文件保存；阶段 0 必须在导入和编辑功能前明确进程、IPC、数据恢复与测试边界。

## 决策

1. **主进程持有权限。** Electron 主进程持有用户数据目录与 `DurableStore`；渲染器仅通过冻结的 preload 方法访问版本、状态、记录读写、恢复候选列表和显式恢复。IPC 方法名固定、参数按白名单和 JSON/ID/恢复选择校验；来源必须是顶层主文档。
2. **书和用户数据分区。** 书籍文件导入时复制到应用用户目录下的私有 `data/books`；原路径只读且永不由应用删除。书目目录和笔记等用户内容分开，保留笔记删除只移除应用副本并将书籍标为不可用；删除书籍及用户内容会移除书目项和副本。渲染器不接收原始路径，仅主进程原生文件对话框可选择导入源。
3. **不可变修订保存。** `apps/reader/src/app/storage/index.cjs` 使用单条记录的单调修订号、SHA-256 信封校验、临时文件写入/文件同步/硬链接发布/目录同步。并发按记录串行，写入使用期望修订号拒绝旧写入；确认成功才可显示已保存。
4. **迁移与恢复保守处理。** 迁移先产生带校验的快照并逐步校验；失败保留旧数据。损坏最新记录不自动猜测或覆盖，UI 仅列出经过校验的候选并要求明确恢复，恢复写入新修订号，所有原始文件保留。
5. **默认离线。** 生产环境只允许渲染器自身打包 `file:` 路径；开发时只允许本地配置端口。权限、下载、弹窗、导航和 webview 均拒绝；自动更新不启用。此边界不代替 EPUB/TXT 解析器沙箱验收。
6. **固定测试入口。** 使用 Node 内置测试运行真实临时磁盘和子进程强制终止测试；固定 EPUB/TXT 是原创合成内容，CC0 清单含字节数、SHA-256 与用途。Nx `reader:test` 同时运行 shell/storage/fixture 测试和 fixture 校验。

## 取舍与限制

- 当前使用 Node 内置 fs/crypto，避免引入数据库或二进制运行时；代价是后续需维护 schema、迁移和数据目录治理。
- `fsync`/硬链接/目录行为在 Windows 尚未实机验证；必须通过 Windows CI/手动安装运行退出卸载测试后才可声称 S00-A3。
- 阶段 0 初始路由库 React Router 6.29.0 经 `npm audit` 报告 open-redirect XSS advisory，已升级为同一主版本 6.30.6，`package.json` 使用 exact 版本并更新 lockfile。其余报告在阶段 0 记录：升级前本机 audit 汇总 89 high、2 critical、20 moderate；路由修复后复核 86 high、2 critical、22 moderate，范围横跨 Electron/Nx 构建链及开发工具依赖。Critical advisories 包括测试工具 vitest/tinypool，并非当前产品入口；high 同样含生产/打包链。禁止仅按数量视为可接受或隐藏结果。Electron 34.5.8 所属旧主线需升级到受支持版本，并验证 `nx-electron` 及 Nx/plugin 同版本兼容；按此锁文件不能分发。逐条审计记录、升级后清理传递依赖、Windows 重建及 re-audit 均为移除发布阻塞的先决条件，不能用强制 npm audit fix 绕过兼容性。

- `fsync`/硬链接/目录行为在 Windows 尚未实机验证；必须通过 Windows CI/手动安装运行退出卸载测试后才可声称 S00-A3。
- 记录恢复是应用内部恢复，不是 v1.5 手动完整备份功能。
- 当前用户范围 D-02～D-08 是工程基线提案，未视为关闭决定；对应规格不能标记 ready。

## 验证证据

本地已通过：

- `npm ci`（现有锁文件环境）
- `NX_DAEMON=false npm exec -- nx run-many -t lint typecheck -p reader reader-ui`
- `NX_DAEMON=false npm exec -- nx run reader:test`（shell、存储崩溃/磁盘/迁移、固定样例）
- `NX_DAEMON=false npm exec -- nx run reader:build --configuration=production`
- `NX_DAEMON=false npm exec -- nx sync:check`
- `NX_DAEMON=false npm exec -- nx run reader:spec-check`
- `git diff --check`

未完成：Windows 安装器 CI 已构建，但实际安装启动退出卸载、分支保护生效、生产性能基线、产品导入/阅读验收、完整依赖升级仍待验证。曾发布的 `reader-windows-x64-unsigned` artifact 使用递归 `**/*.exe`，包含 `win-unpacked/Reader.exe`；该 exe 不可从其运行目录拆出单独执行，Electron 需要相邻 `icudtl.dat` 与 `resources`。CI 现仅发布根级 NSIS 安装器并验证恰好一个匹配项，以防重复交付裸 exe。Windows 安装器启动日志尚未由 CI 自动冒烟覆盖。2026-11-18 本地 `npm audit` 曾报告 89 high、2 critical、20 moderate；升级与发布前复审为阻塞项。
