# Reader delivery 技能验证报告

- **规格 / 票据 / ADR：** [Reader 项目交付技能](../../skills/reader-delivery/SKILL.md)；项目入口规则见 [CLAUDE.md](../../../CLAUDE.md) 与 [开发文档入口](../README.md)。本次没有新增产品规格或 ADR。
- **被测版本 / 日期：** `origin/main` 基线 `cff0d6adc43675e881d082c78466564488daacef` 与 `chore/reader-delivery-skill` 上的 skill、项目入口文档和本报告；2026-11-20。
- **环境 / 数据：** Linux；Node.js 24.20.0；npm 11.19.0；Nx 22.0.0；仅检查 Markdown/JSON/skill 结构和仓库文档，不读取未跟踪私人 EPUB，不启动 Reader GUI。

## 验收记录

| 验收项             | 复现 / 操作                                                                                                                                                                  | 预期                                                                                 | 实际与状态                                                                                                                                           | 证据                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 交付 skill 结构    | 运行 `python3 -I /home/alice/.claude/skills/skill-creator/scripts/quick_validate.py .claude/skills/reader-delivery`                                                          | frontmatter、目录和 skill 资源符合 skill 契约                                        | **通过**：`Skill is valid!`                                                                                                                          | `.claude/skills/reader-delivery/SKILL.md`、`assets/`、`references/`、`evals/evals.json`                                                         |
| 文档相对链接       | 对 `.claude/skills/reader-delivery` 与 `.claude/docs` 下 Markdown 链接逐一解析                                                                                               | 相对链接不指向缺失文件                                                               | **通过**：`All relative Markdown links in skill and docs resolve.`                                                                                   | 本地只读链接检查                                                                                                                                |
| Nx 文档/规格检查   | `NX_NO_CLOUD=true NX_DAEMON=false npm exec -- nx run reader:spec-check`                                                                                                      | 规格、票据、文档引用可被现有检查识别                                                 | **通过**：`Validated 18 documents and 49 acceptance IDs`                                                                                             | Nx 输出                                                                                                                                         |
| 格式检查与修复     | 首轮 PR CI 对三个提交文档报格式失败；本地用 `nx format:write --base=origin/main --head=HEAD` 修复，再对同一已提交 diff 运行 `nx format:check --base=origin/main --head=HEAD` | 本次提交文档符合仓库 Prettier 格式                                                   | **修复后通过**：Nx 检查任务 diff 中的已跟踪提交文件；本地未跟踪 eval workspace 不纳入 PR 检查                                                        | [首轮 CI 运行](https://github.com/catInWater/isonomia/actions/runs/44699649482)；Nx 本地输出                                                    |
| Git 内容边界       | 用明确文件名逐个暂存并检查 `git diff --cached --check`                                                                                                                       | 只提交 skill、模板、参考、eval 定义和入口文档；不提交私人 EPUB 或本地 eval workspace | **通过**：PR 相对基线共 11 个预期文件；每轮仅暂存本任务的明确文件；私人 EPUB 和 `.claude/skills/reader-delivery-workspace/` 保持未跟踪               | `git diff --cached --stat`、`git status`                                                                                                        |
| 交付流程覆盖       | 阅读 skill、CI 参考、讨论参考和模板                                                                                                                                          | 明确独立分支、验证报告、GUI 证据、当前 head CI、讨论循环、歧义暂停和用户合并边界     | **通过**：相关规则已写入 skill 与项目入口                                                                                                            | `SKILL.md`、`references/ci.md`、`references/discussion.md`                                                                                      |
| skill dry-run 评估 | 使用 3 个合成场景，各配置各运行 1 次；未访问真实 PR、未运行真实应用、未联网                                                                                                  | 评估 instruction coverage，并诚实标明样本限制                                        | **通过（非统计基准）**：with-skill 100%（21/21）；without-skill 79%（15/19）。这是三个不同场景的单次样本，标准差表示场景差异，不表示重复试验不确定性 | 本地未提交的 `.claude/skills/reader-delivery-workspace/iteration-1/benchmark.{json,md}`；定义见 `../../skills/reader-delivery/evals/evals.json` |

## 自动检查

- `python3 -I /home/alice/.claude/skills/skill-creator/scripts/quick_validate.py .claude/skills/reader-delivery`：通过。
- 相对 Markdown 链接检查：通过，109 个相对链接均可解析。
- GitHub CLI 讨论读取实测：`gh pr view 11 --repo catInWater/isonomia --json url,state,headRefOid,comments,reviews,latestReviews` 与 GraphQL `reviewThreads` 查询通过。当前安装的 GitHub CLI 拒绝将 `--comments` 与 `--json` 同用；已修正讨论参考中的示例，使用 JSON 字段读取评论和 reviews。此次核对评论、reviews、行内线程均为空，且 GraphQL 各集合的 `hasNextPage` 均为 `false`；最终交接前仍须重新核对新 head。
- `NX_NO_CLOUD=true NX_DAEMON=false npm exec -- nx run reader:spec-check`：通过，18 documents / 49 acceptance IDs。
- `NX_NO_CLOUD=true NX_DAEMON=false npm exec -- nx format:check --base=origin/main --head=HEAD`：修复首轮 CI 的三个 Markdown 格式错误后通过；检查覆盖本次 PR 的 11 个已跟踪文件（包括本报告），不包含本地未跟踪 eval workspace。
- `git diff --cached --check`：通过。
- 本地未运行 `reader:test`、`reader:build`、GUI smoke：本次只新增交付流程 skill、模板和文档入口，没有应用代码或可见 Reader 行为变化；这些任务不增加本次变更的证明力。

## GUI 截图

**不适用。** 本次变更只包含 skill、Markdown/JSON 模板、参考文档和项目入口规则，没有 Reader UI、Electron 主进程或用户可见交互改动；不贴旧截图充数。

## Review 修订记录

| 讨论链接 / 意见       | 处理决定与范围                                                                                                                   | 修改、测试与新证据   | 新 head CI / 待用户决定                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| 本 PR 尚无远端 review | 等待 CI 通过后按 skill 读取正文评论、reviews、行内线程和回复；清楚且范围内的意见在同一 PR 处理，歧义/冲突/超范围意见先请用户裁定 | 当前没有远端讨论修订 | 以 PR 最新 head 的 Linux checks / Windows installer 为准；最终等待用户审查并合并 |

## 已知限制与人工复核

- 本地验证证明 skill 结构、入口链接、文档规格检查和格式，但不证明未来每次交付都能成功创建 PR、运行远端 CI 或获得 GUI/Windows 实机证据。
- dry-run 评估是合成计划/模板练习，每个场景每种配置只有一个样本；不能当作生产成功率或严格 benchmark。
- 本次没有 Windows 实机验收；该限制适用于 Reader 应用，不是本 skill 文档变更的 UI 验收。
- PR 创建后需要核对最新 head SHA、Linux/Windows 必需检查、PR 讨论和用户最终审查；本 agent 不自动批准、解决线程或合并。
