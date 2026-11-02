# 框架与依赖选型

本文记录 Pika Harness 的技术选型：参考了哪些 harness、为什么选这些库、哪些能力坚持自建、以及每个选择的可替换点。版本号以仓库 `package.json` 为准；标注“规划”的依赖尚未安装。

## 1. 选型原则

1. **学习目标决定自建边界**：运行时、上下文、提示词、工具循环、沙箱策略、会话记录是学习对象，自己实现。
2. **复用库而非框架**：优先选择不接管控制流的库。库提供能力，框架会替我们决定架构，反而遮蔽学习目标。
3. **契约先于实现**：`schema` 定义事件、会话、审批、沙箱契约；provider、executor、store 都是可替换端口。
4. **默认安全**：审批不是安全边界；默认禁网、显式环境白名单、路径约束、进程组清理都是基线。
5. **可替换**：每个关键依赖都要有明确的替换点，避免单点锁定。

## 2. 参考实现对比

| 项目             | 语言/定位                | 值得借鉴                                                                                                                             | 为什么不直接 fork                                                                   |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| OpenCode         | 产品优先的编码 agent     | `Schema -> Core/Protocol -> Server` 的分层；客户端只依赖 Schema 与 Protocol                                                          | 价值在产品表面，fork 学到的是它的产品结构，不是 harness 基础                        |
| Codex            | Rust，OpenAI 生态        | `core / app-server-protocol / app-server / transport` 拆分；上下文历史管理；压缩策略；工具调用状态与截断；rollout 记录、resume、fork | Rust 且强绑定 OpenAI；直接使用会把学习重点变成读大型产品代码                        |
| Kimi Code        | 产品优先的编码 agent     | `pi-tui` 衍生的终端体验；可观测的 context projector；`wire.jsonl` + `state.json` + 回放 UI                                           | 产品耦合度高；回放与投影思路值得借鉴，代码不作为起点                                |
| DeepSeek Harness | 产品优先的 agent harness | 端到端产品化经验                                                                                                                     | 与自建学习目标不一致                                                                |
| Pi               | 组件库                   | `pi-ai`、`pi-tui`；`transformContext()` 到 `convertToLlm()` 的投影分层；session 格式与 SessionManager                                | 它是最接近的组件库，但没有内置权限/沙箱边界；它的 agent core 正是我们要自己写的部分 |

结论：把 Codex、OpenCode、Kimi、DeepSeek Harness 作为架构参考，把 Pi 作为可复用组件库；不 fork 任何产品。

## 3. 语言与工程基线

| 项目        | 选择                                                                                     | 说明                                                                         |
| ----------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 语言        | TypeScript 5.9.3                                                                         | 与 `pi-ai`、`pi-tui`、MCP SDK 生态一致；类型契约可同时服务运行时、协议和测试 |
| 运行时      | Node.js >= 24                                                                            | 原生 ESM、现代 `fs`/`crypto`、`AbortSignal`、进程组能力；与 `.nvmrc` 一致    |
| 包管理      | pnpm 10.34.9                                                                             | workspace 依赖清晰，安装快，适合多包仓库                                     |
| 模块系统    | ESM + `NodeNext`                                                                         | 相对导入带 `.js` 后缀；包边界可静态检查                                      |
| 类型严格度  | `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`erasableSyntaxOnly` | 禁止 `enum`、`namespace`、参数属性等不可擦除语法，保证类型可被安全剥离       |
| 构建        | `tsc --noEmit`                                                                           | 当前只做类型检查，各包直接导出 `src`；发布构建后续再加                       |
| 格式化/检查 | Biome 2.6.4                                                                              | 一个工具完成 format 与 lint，配置简单                                        |
| 测试        | Vitest 3.2.7                                                                             | 与 TS/ESM 集成好，适合 fixture 与异步流测试                                  |
| 边界检查    | 自研 `scripts/check-boundaries.mjs`                                                      | 检查工作区依赖方向、`child_process` 唯一入口、禁止动态导入                   |

替代语言的取舍：

- Rust：性能与内存安全更好，适合长期产品化；但会显著抬高实现与迭代成本，且 `pi-ai`/`pi-tui`/MCP 生态需要重写。
- Go：并发与部署简单；但类型表达力、TUI 与模型 SDK 生态不如 TypeScript。
- Python：原型快；但类型契约、CLI 分发与前端生态不适合当前目标。

当前选择 TypeScript 是为了让学习重点落在 harness 结构，而不是语言基础设施。

## 4. 依赖选型总表

| 能力           | 选择                                 | 版本/状态              | 备选                                       | 结论                     |
| -------------- | ------------------------------------ | ---------------------- | ------------------------------------------ | ------------------------ |
| 模型接入       | `@mariozechner/pi-ai`                | 0.73.1，已接入         | Vercel AI SDK、`pi-agent-core`、手写适配器 | 选 `pi-ai`               |
| 终端 UI        | `@mariozechner/pi-tui`               | 规划                   | Ink、手写 ANSI                             | 选 `pi-tui`              |
| MCP            | `@modelcontextprotocol/sdk`          | 规划                   | 自研传输                                   | 选官方 SDK               |
| Schema/校验    | `zod`                                | 4.6.7，已使用          | TypeBox、Valibot、手写校验                 | 选 Zod                   |
| 会话日志       | JSONL + `meta.json`                  | 已实现                 | SQLite 作为事实来源                        | JSONL 为事实来源         |
| 索引           | SQLite（`better-sqlite3` 或 libsql） | 规划                   | 纯内存索引、全文索引文件                   | 可重建的派生索引         |
| 沙箱（当前）   | `NodeProcessExecutor`                | 已实现，backend `none` | `NoopExecutor`（拒绝执行）                 | 先建立执行器边界         |
| 沙箱（macOS）  | Seatbelt                             | 规划                   | Apple Containerization、Docker             | v1 默认                  |
| 沙箱（Linux）  | bubblewrap                           | 规划                   | Landlock + seccomp、Docker                 | Linux 默认               |
| 沙箱（不可信） | Docker / Podman                      | 规划                   | gVisor、Firecracker、云沙箱                | CI 与远程                |
| 协议           | JSON-RPC 2.0 风格                    | 规划                   | REST/HTTP、ACP                             | 主协议选 JSON-RPC        |
| 命令分类       | `tree-sitter-bash`                   | 规划                   | 正则、shell 自身解析                       | 用于执行前分类           |
| 测试 provider  | `FauxProvider`                       | 已实现                 | mock SDK、录制回放                         | 运行时测试默认           |
| 时钟/ID        | 可注入 `Clock` / `IdGenerator`       | 已实现                 | 直接 `Date.now()` / `randomUUID()`         | 默认实现加可注入测试实现 |

## 5. 模型接入：为什么是 pi-ai

候选对比：

| 方案            | 优点                                                                                     | 问题                                                 | 结论                                     |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `pi-ai`         | provider 覆盖广；OAuth 与 API key；usage/cost；缓存保留字段；自定义 provider；有缓存测试 | 仍是外部依赖，需要适配层                             | 采用，放在 `Provider` 接口后             |
| Vercel AI SDK   | 生态大、文档多                                                                           | provider 差异与缓存控制不如 `pi-ai` 显式；抽象层较厚 | 备选                                     |
| `pi-agent-core` | 与 `pi-ai` 配套，功能完整                                                                | agent loop 正是学习目标，直接使用会跳过核心实现      | 只作参考                                 |
| 手写适配器      | 完全可控                                                                                 | 厂商差异、流式工具调用、缓存、OAuth 成本高           | 仅在 provider 抽象本身成为学习目标时考虑 |

`PiAiProvider` 是唯一知道模型线格式的地方。它把 pi-ai 的 `text_delta`、`thinking_delta`、`toolcall_*`、`done`、`error` 映射为 harness 的 `LlmEvent`，并支持注入 `stream` 与 `now`，因此测试不需要网络且时间戳确定。

工具声明使用 Zod 生成 JSON Schema，再经 TypeBox 的 `Type.Unsafe` 桥接。这里依赖的是结构化兼容，而不是运行时耦合：如果更换 provider 库，只需替换这个桥接层。

## 6. 终端 UI：为什么是 pi-tui

`pi-tui` 提供差分渲染、同步输出、主/备用屏幕、组件、图片与自动补全。Kimi Code 的 TUI 由 `pi-tui` 派生，说明它足以支撑真实编码 agent 的终端体验。

替代方案：

- Ink：React 模型上手快，但长列表、差分渲染与终端细节控制不如专用 TUI 库。
- 手写 ANSI：学习价值高，但会把大量时间花在终端兼容性上，偏离 harness 核心。

CLI 只依赖 `schema` 与 `client`，不导入 `core`。即使当前传输是进程内的，也通过协议客户端访问运行时，避免 CLI 变成第二套运行时。

## 7. MCP：为什么用官方 SDK

选择 `@modelcontextprotocol/sdk`：

- 支持 stdio 与 streamable HTTP；
- 覆盖 OAuth、工具列表变化、重连与超时；
- 与社区服务器兼容；
- 避免自研协议带来的兼容性风险。

自研 transport 只会在需要特殊嵌入式传输时考虑；当前没有这个需求。MCP 工具统一加 `mcp__server__tool` 命名空间，并通过暴露过滤与项目信任控制可见性。

## 8. Schema 与校验：为什么是 Zod

- `schema` 包用 Zod 定义事件、会话、审批、沙箱策略与内容块，运行时和测试共享同一套校验。
- Zod 4 的 `z.toJSONSchema()` 直接把工具参数转成 provider 需要的 JSON Schema。
- 类型与校验同源，避免“类型正确但运行时数据不合法”。
- 备选 TypeBox 更贴近 JSON Schema，但类型推导与生态不如 Zod；Valibot 更轻，但当前没有包体积压力。

约束：消费者必须用 `AgentEventSchema` 校验事件，生产者不得发明字段。

## 9. 存储：JSONL 为事实来源，SQLite 为索引

选择 JSONL：

- 追加式写入，天然适合事件日志；
- 可直接查看、diff、恢复；
- 回放需要有序事件，JSONL 顺序即事实；
- 崩溃后最多丢失最后一行，不需要事务恢复。

布局：

```text
<sessions-root>/<sessionId>/meta.json
<sessions-root>/<sessionId>/log.jsonl
```

SQLite 只做派生索引：会话列表、token/成本统计、全文搜索。删掉索引后可以从 JSONL 重建，因此索引格式不是契约。候选绑定：

- `better-sqlite3`：同步 API、成熟、性能好；
- libsql：更现代，但生态与部署细节需评估。

不选“SQLite 作为事实来源”的原因：会话历史需要可读、可 diff、可按事件回放；把事实塞进关系表会让回放和迁移复杂化。

## 10. 沙箱后端矩阵

| 后端                            | 平台        | 隔离                      | 依赖                | 角色                      | 状态   |
| ------------------------------- | ----------- | ------------------------- | ------------------- | ------------------------- | ------ |
| `none`（`NodeProcessExecutor`） | 跨平台      | 无 OS 隔离                | Node 内置           | 当前默认，验证执行器边界  | 已实现 |
| `NoopExecutor`                  | 跨平台      | 拒绝执行                  | 无                  | 无后端时的安全默认        | 已实现 |
| Seatbelt                        | macOS 15+   | 进程级，中高              | 系统 `sandbox-exec` | macOS v1 默认             | 规划   |
| bubblewrap                      | Linux       | 命名空间，高              | 需安装              | Linux 默认与 CI           | 规划   |
| Landlock + seccomp              | Linux 5.13+ | 进程级，中高              | 小型启动器          | bubblewrap 不可用时的选项 | 规划   |
| Docker / Podman                 | 跨平台      | 容器，高                  | 容器运行时          | 不可信负载、CI、远程      | 规划   |
| gVisor / Firecracker            | Linux       | 微虚拟机/用户态内核，很高 | 基础设施            | 多租户                    | 后续   |
| Apple Containerization          | macOS 26+   | 每容器一个 Linux VM       | 系统框架            | 本地强隔离                | 后续   |
| 云沙箱                          | 托管        | 很高                      | 外部服务            | 产品化                    | 后续   |
| Node `--permission`             | 跨平台      | 仅 harness 进程           | Node 24             | 插件隔离                  | 后续   |

选择顺序：先在 macOS 用 Seatbelt 跑通一致性套件，再补 bubblewrap 与 Docker。`sandbox-exec` 虽被 Apple 标记废弃，但仍可用；放在 `Executor` 接口后，未来可替换。Docker 不作为 macOS 日常默认，因为大仓库的文件系统开销明显。

所有后端必须通过同一套一致性测试，覆盖工作区写入、越界写入、敏感目录读取、网络、子进程继承、符号链接、`..` 穿越、环境清洗、超时清理、输出截断与 MCP 子进程。

## 11. 协议：为什么是 JSON-RPC

候选：

- **JSON-RPC 2.0 风格**：双向请求/响应与通知，适合服务端主动推送事件和审批请求；stdio JSONL、WebSocket、进程内传输都能承载。
- **REST/HTTP**：请求/响应清晰，但服务端主动事件与审批需要额外推送机制，v0 复杂度更高。
- **ACP**：面向编辑器集成，不是会话存储与多客户端回放的主协议；后续作为适配器加入。

协议方法规划覆盖 `initialize`、会话 start/resume/fork/list、轮次 start/steer/interrupt、审批响应、订阅与沙箱模式。schema 版本化，首个外部客户端发布前只做增量变更。

## 12. 测试与工程工具链

- **Vitest**：单元、集成、fixture 回放。
- **FauxProvider**：脚本化 `LlmEvent`，让运行时测试完全确定。
- **注入式 provider transport**：适配器测试不访问网络。
- **固定时钟与 ID**：事件 fixture 做深比较。
- **契约测试**：内存存储与 JSONL 存储共享同一套 `SessionStore` 测试。
- **一致性套件**：每个沙箱后端跑同一组安全测试。
- **边界检查**：`pnpm boundary` 阻止错误依赖与直接 `child_process`。
- **`pnpm check`**：typecheck、lint、boundary、test 一条命令。

不选 Jest 的原因：Vitest 与 ESM/TypeScript 的集成更直接，配置更少。不引入 ESLint + Prettier 的原因：Biome 一个工具覆盖 format 与 lint，减少配置面和版本冲突。

## 13. 选型结论汇总

| 领域         | 最终选择                        | 状态   | 替换点              |
| ------------ | ------------------------------- | ------ | ------------------- |
| 语言/运行时  | TypeScript + Node 24            | 已落地 | 无（核心决策）      |
| 包管理       | pnpm workspace                  | 已落地 | 无                  |
| 模型接入     | `pi-ai`                         | 已接入 | `Provider` 接口     |
| 终端 UI      | `pi-tui`                        | 规划   | 协议客户端          |
| MCP          | 官方 SDK                        | 规划   | MCP 适配器          |
| 校验         | Zod                             | 已落地 | `schema` 包内部     |
| 会话事实来源 | JSONL                           | 已落地 | `SessionStore` 端口 |
| 索引         | SQLite                          | 规划   | 可重建索引          |
| 当前执行器   | `NodeProcessExecutor`（`none`） | 已落地 | `Executor` 接口     |
| 强隔离       | Seatbelt / bubblewrap / Docker  | 规划   | 平台执行器          |
| 协议         | JSON-RPC 2.0 风格               | 规划   | transport 层        |
| 测试         | Vitest + FauxProvider           | 已落地 | 测试内部            |

## 14. 未决问题

- 第一条端到端链路使用哪个 provider 与模型？当前假设一个 OpenAI 兼容端点。
- macOS 26 是否可用于 Apple Containerization 实验，还是第一年 Seatbelt + Docker 足够？
- SQLite 绑定选 `better-sqlite3` 还是 libsql？
- 首个 SDK 从 schema 生成还是手写薄客户端？
- 命令执行前的分类是否引入 `tree-sitter-bash`，还是先用路径规则加 shell 解析？
- 插件 API 何时暴露？在协议与沙箱边界稳定之前不暴露。
