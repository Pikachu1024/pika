# 架构

## 1. 定位与原则

Pika Harness 是一个学习优先的 TypeScript agent harness。目标不是尽快做出产品，而是亲手实现 harness 的核心：运行时循环、上下文投影、提示词组装、工具系统、沙箱执行边界、会话记录与回放、客户端协议。模型接入、终端 UI、MCP 协议等成熟能力直接复用库。

设计原则：

- **核心自建，外围复用**：运行时、上下文、提示词、工具、沙箱策略、会话记录自己实现；`pi-ai` 负责模型接入，`pi-tui` 负责终端 UI，MCP 使用官方 SDK。
- **契约先行**：同一套规范化事件既是运行时输出，又是会话日志，后续还作为协议帧发给客户端。
- **单向依赖**：`schema <- core <- adapters <- server`，`schema <- client <- cli`。客户端不能直接依赖运行时。
- **单写者**：外部命令串行进入运行时，状态变化只以事件形式离开。
- **沙箱即边界**：审批只是 UX，真正的强制执行点是 sandbox executor。

## 2. 包结构与依赖

```
apps/cli                 packages/server                  packages/client
(pi-tui 终端客户端)      (会话管理/传输/审批路由)          (类型化协议 SDK)
       \                        |                                /
        +----------------- packages/schema -------------------+
                    (协议、事件、会话、审批、沙箱契约)
                                |
                           packages/core
              (运行时、上下文、提示词、工具、沙箱策略、会话端口)
                                |
                          packages/adapters
              (pi-ai provider、沙箱执行器、JSONL 存储、MCP)
```

实际依赖以各 `package.json` 为准：

| 工作区                   | 依赖                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| `@pika-harness/schema`   | `zod`，不依赖任何工作区包                                                   |
| `@pika-harness/core`     | `schema`、`zod`                                                             |
| `@pika-harness/adapters` | `core`、`schema`、`@mariozechner/pi-ai`、`@modelcontextprotocol/sdk`、`zod` |
| `@pika-harness/server`   | `schema`、`core`、`adapters`                                                |
| `@pika-harness/client`   | `schema`                                                                    |
| `@pika-harness/cli`      | `schema`、`client`                                                          |

依赖方向是单向的。`core` 不导入具体存储、具体 provider 或任何客户端；`adapters` 实现 `core` 声明的端口；`server` 负责组装。

## 3. 职责划分

| 工作区              | 职责                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/schema`   | 协议消息、规范化事件、会话记录、审批、沙箱策略与决策的 Zod 契约                                            |
| `packages/core`     | 单写者运行时、provider/executor/session 端口、上下文投影、提示词、工具注册表与批量执行、沙箱策略与路径策略 |
| `packages/adapters` | `pi-ai` provider、进程执行器与 OS 沙箱后端、JSONL/SQLite 存储、Skills 发现、MCP 生命周期                   |
| `packages/server`   | 会话管理、订阅、审批路由、stdio/WebSocket/进程内传输                                                       |
| `packages/client`   | 基于 `schema` 的类型化协议客户端                                                                           |
| `apps/cli`          | 基于 `pi-tui` 的终端客户端，只消费协议                                                                     |

## 4. 数据流

在线写入路径：

```
用户 / 客户端
     |
     v
prompt | steer | followUp | interrupt        (串行命令)
     |
     v
AgentRuntime（单写者）
     |-- Provider.stream --------> LlmEvent
     |-- ToolExecutor.execute ---> ToolResult
     v
AgentEvent --+--> EventSink（进程内消费者、测试）
             +--> SessionStore.append（JSONL）
             +--> Server transport -> 协议帧
```

读取与回放路径：

```
SessionEntry[]
     |
     v
按 parentId 选择活动分支
     |
     v
ContextProjector.project()
     |
     v
LlmMessage[] + promptHash
     |
     v
Provider adapter -> 模型线格式
```

运行时只把规范化对象向上传递。provider wire format、终端渲染格式、存储格式都不进入 `core`。

## 5. 关键边界

### 5.1 协议边界

运行时和会话存储不被客户端直接导入。CLI、SDK、未来的 Web 客户端都通过 `schema` 中的消息契约和协议实现通信。CLI 从第一天起就是协议客户端，即使传输是进程内的，也不能直接调用运行时，否则会逐渐演变成第二套实现。

### 5.2 沙箱边界

所有由工具发起的子进程执行都必须经过 sandbox executor。只有 `packages/adapters/src/sandbox/` 可以导入 `node:child_process`。审批决定“是否允许执行”，executor 决定“执行时能触碰什么”。进程内的文件工具同样要经过 `PathPolicy`，否则会绕过 OS 沙箱。

### 5.3 会话边界

追加式会话日志是事实来源。上下文投影、提示词哈希、SQLite 索引、回放视图都是派生结果。回放只能读取日志，不能修改日志。压缩、审批结果、沙箱决策都作为事件记录，而不是就地改写历史。

### 5.4 进程边界

provider 凭据只保留在 harness 进程内，不传给工具子进程。子进程环境由策略显式构造，不能继承 `process.env`；不加载登录 shell 的启动文件；超时或中断时终止整个进程组。

### 5.5 本地服务生命周期

`pika` 默认自行拉起本地会话服务，用户只需要一个命令。服务只监听 `127.0.0.1` 的临时端口；launcher 每次运行生成一次性 token，通过子进程环境 `PIKA_SERVER_TOKEN` 传给服务端，并在客户端连接时作为 `?token=` 查询参数携带。服务端在 WebSocket 升级阶段用常量时间比较校验 token，缺少或错误时返回 401，连接不会进入 JSON-RPC 层。token 不写入日志、会话记录或终端输出。

服务模式与回收约定：

- `pika serve [--port <n>] [--host <addr>] [--dir <path>]` 独立运行服务，沿用 `PIKA_PORT`、`PIKA_HOST`、`PIKA_SESSION_DIR`，启动后打印 `pika-server listening on ws://...`。
- `--exit-on-parent-stdin-close` 由 launcher 使用：父进程 stdin 关闭即停止监听并退出，避免客户端异常死亡后留下孤儿进程。
- `pika --url <ws://...>` 或 `PIKA_SERVER_URL` 进入远程模式，不启动本地服务。
- launcher 只向本地服务子进程传递显式环境白名单（`PIKA_*`、`HOME`、`PATH`、`TMPDIR`、语言与代理变量），不继承完整 `process.env`。

## 6. 强制检查

`bun run boundary` 运行 `scripts/check-boundaries.mjs`，扫描 `packages/*/src` 与 `apps/*/src`，检查：

- 每个包是否导入了禁止依赖的工作区包；
- `node:child_process` 是否只出现在 `packages/adapters/src/sandbox/`；
- 源码是否使用动态 `import()` 或 `require()`。

`bun run check` 依次执行 typecheck、lint、boundary 和 test，是提交前的最低门槛。

## 7. 当前状态

| 区域             | 状态                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `schema`         | 事件、会话、轮次、审批、沙箱策略与决策、内容块、用量、ID、时间戳、协议消息契约已实现并有测试        |
| `core` 运行时    | 单写者循环、prompt/steer/follow-up/interrupt、settled、模型调用上限、事件发射已实现                 |
| `core` provider  | `Provider`/`LlmEvent` 边界与 `FauxProvider` 已实现                                                  |
| `core` 上下文    | 分段提示词、`AGENTS.md` 发现、确定性投影与提示词哈希、token 估算、压缩策略与运行时压缩已实现        |
| `core` 工具      | 注册表、批量执行器、结果截断、文件工具与 shell/搜索工具已实现                                       |
| `core` 沙箱      | 策略解析与单调收敛、`PathPolicy`、`NoopExecutor`、`Executor` 端口、审批与升级决策已实现             |
| `core` 会话      | `SessionStore` 端口、内存实现、回放、恢复与 fork 已实现                                             |
| `adapters`       | `PiAiProvider`、`NodeProcessExecutor`、Seatbelt/bwrap/Docker、JSONL/SQLite 存储、Skills、MCP 已实现 |
| `server`         | 会话管理、审批路由、stdio/WebSocket/进程内传输、沙箱模式解析已实现                                  |
| `client` / `cli` | 类型化 SDK、`pi-tui` 客户端、一次性 prompt 与交互式审批已实现                                       |

实现进度以归档任务列表 `openspec/changes/archive/2026-11-02-agent-harness-foundation/tasks.md` 为准；能力契约在 `openspec/specs/`。

## 8. 文档索引

- [总体设计](design.md)：运行时、上下文、工具、沙箱、会话、协议的详细设计。
- [框架与依赖选型](framework-selection.md)：参考实现对比、依赖选择、沙箱后端矩阵与取舍。
- [事件契约](events.md)：事件信封、生命周期、投递语义与错误归一化。
- [Provider 契约](providers.md)：`LlmEvent` 与 `pi-ai` 适配细节。
- [工具契约](tools.md)：工具接口、批量执行、内置工具与截断行为。
- [协议与 SDK](protocol.md)：JSON-RPC 方法、三种传输、SDK 与 CLI 用法。
- [Skills 与 MCP](extensions.md)：技能发现与懒加载、MCP 配置、生命周期与信任边界。
- `openspec/specs/`：当前能力契约；范围与设计的历史事实来源在 `openspec/changes/archive/2026-11-02-agent-harness-foundation/`。
