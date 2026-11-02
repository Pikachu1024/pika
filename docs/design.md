# 总体设计

本文描述 Pika Harness 的目标设计与当前实现的对应关系。实现进度以 `openspec/changes/agent-harness-foundation/tasks.md` 为准；文中标注“规划”的部分表示接口或方向已确定，但尚未落地。

## 1. 目标与非目标

### 目标

- 用一套事件契约同时驱动运行时、会话日志和协议。
- 保持单向依赖，避免 CLI、server、SDK 各自演化成不同实现。
- 把沙箱做成一等子系统：显式策略、平台执行器、可审计决策。
- 支持确定性回放：同一份日志得到相同的时间线、投影和提示词哈希。
- 用 v0/v1 的纵向切片跑通每一层，而不是先铺开产品功能。
- provider、工具、沙箱后端和 UI 都可替换。

### 非目标

- 插件市场、子代理、浏览器/computer-use 工具、Web/桌面客户端、远程沙箱、RAG、自研 MCP 实现。
- Windows 沙箱。
- 多租户或不可信公网负载。
- v0 就做到完美隔离。v0 先建立策略与执行器接缝，真正的 OS 隔离开在后续里程碑。
- 为大量模型厂商手写适配器。

## 2. 运行时

### 2.1 单写者状态机

运行时是单写者的异步循环。外部命令进入串行队列，状态变化只通过事件离开。这样可以避免 TUI、SDK、审批处理器并发修改状态导致的竞态。

状态定义在 `packages/core/src/agent.ts`：

```ts
type AgentState = "idle" | "streaming" | "tool-calling" | "compacting" | "aborted";
```

当前实现会进入 `idle`、`streaming`、`tool-calling` 和短暂的 `aborted`；`compacting` 为压缩预留，尚未使用。

命令队列：

```text
promptQueue    -> 空闲时立即开新轮；有活动轮时转为 follow-up
steerQueue     -> 当前模型步骤结束后注入，同一轮内再次调用模型
followUpQueue  -> 当前轮结束后作为新轮执行
interrupt      -> 通过 AbortController 中止当前 provider 流或工具批
```

### 2.2 轮次语义

- 一轮（turn）从一次用户输入开始，到运行时静默结束，期间可以包含多次模型调用和多个工具批。
- `prompt` 在空闲时启动新轮；有活动轮时按 follow-up 处理。
- `steer` 在当前模型步骤结束后注入，并触发同一轮内的下一次模型调用；空闲运行时把它当作 prompt。
- `follow_up` 在当前轮结束后作为新轮执行。
- `interrupt` 中止当前 provider 流或工具批；已开始的工具调用会收到 `aborted` 结果，本轮以 `stopReason: "aborted"` 结束，运行时回到 `idle`，后续 prompt 仍可成功。
- `settled()` 在命令队列为空、没有活动流、没有运行中的工具时完成。客户端用它判断会话何时可以安全复用。

单轮模型调用默认上限为 16 次。超限时运行时发出 `max_model_calls` 错误并以 `stopReason: "error"` 结束本轮，避免模型在工具循环中无限打转。

### 2.3 模型步骤与工具循环

一次模型步骤的流程：

```text
组装 LlmRequest（model / system / messages / tools）
  -> provider.stream()
  -> 归一化 LlmEvent
  -> 累积文本、推理、工具调用
  -> message_end
  -> 若有工具调用：执行工具批，把结果追加到历史
  -> 若有 steer 或工具结果：再次调用模型
  -> 否则结束本轮
```

实现细节：

- `tool_call_delta` 按 index 累积，`tool_call_start` 最终携带完整调用。
- provider 未给出 `done` 就结束流时，运行时发出 `provider_stream_incomplete` 错误。
- `stopReason` 为 `tool_use` 但没有任何工具调用时，视为不一致响应，按 `end` 结束，避免死循环。
- 工具失败不会直接结束本轮：它变成 `isError: true` 的 `ToolResult`，模型在下一次调用中看到错误内容。
- 未配置工具执行器时，每个工具调用都会得到 `no_executor` 错误结果。

### 2.4 工具批处理

工具批由 `ToolBatchExecutor` 执行：

1. 预检整批调用：解析 JSON、查找工具、用 Zod 校验参数。失败项直接生成错误结果，不产生副作用。
2. 读取每个工具的 `concurrencyKey(args)`。相同非空 key 的调用串行，`null` 的调用并行。
3. 通过 `ToolContext` 传入本轮的 `AbortSignal`；工具抛错变成 `execution_error`，中断时变成 `aborted`。
4. 结果始终按模型调用顺序返回，与完成顺序无关。
5. 文本输出超过 `maxOutputBytes`（默认 1 MiB）时保留头尾片段；配置了 `ToolOutputStore` 时写入完整输出并返回引用。

### 2.5 事件发射

运行时通过一条串行发射链写事件：

```ts
async #emit(event: AgentEvent): Promise<void> {
  const run = this.#emissionChain.then(async () => {
    await this.#sessionStore?.append(this.#sessionId, event, undefined);
    await this.#eventSink.emit(event);
  });
  this.#emissionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
```

会话存储先追加，事件消费者后收到。因此“已经写入日志的事件”与“客户端观察到的事件”是同一个对象，顺序也一致。单个消费者失败不会让后续事件失去稳定顺序。

## 3. Provider 抽象

### 3.1 契约

```ts
interface Provider {
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
  models(): ModelInfo[];
}

type LlmEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason }
  | { type: "error"; error: NormalizedError };
```

运行时只消费 `LlmEvent`，不接触任何厂商线格式。`LlmMessage` 只有三种角色：`user`、`assistant`（可带 `toolCalls`）、`tool`（带 `toolCallId` 与可选 `toolName`）。

### 3.2 pi-ai 适配

`PiAiProvider` 把 `@mariozechner/pi-ai` 的模型与流映射到上述契约：

| pi-ai                               | harness                 |
| ----------------------------------- | ----------------------- |
| `text_delta`                        | `text_delta`            |
| `thinking_delta`                    | `reasoning_delta`       |
| `toolcall_start` / `toolcall_delta` | `tool_call_delta`       |
| `toolcall_end`                      | 最终 id/name 或完整参数 |
| `done`                              | 先 `usage`，再 `done`   |
| `error`                             | 先 `usage`，再 `error`  |

工具声明由 Zod JSON Schema 经 TypeBox 的 `Type.Unsafe` 桥接给 pi-ai。适配器从 assistant 历史或工具消息中恢复 `toolName`；当 provider 已经流式给出参数时，`toolcall_end` 不重复发送完整参数。

适配器支持注入 `stream` 与 `now`，因此单元测试不访问网络，时间戳也可确定。真实链路冒烟测试是可选步骤，不进入 `bun run check` 或 CI。

### 3.3 测试

- 运行时测试使用 `FauxProvider`，返回脚本化的 `LlmEvent` 序列。
- provider 适配器测试注入假的 `stream`，验证事件映射、工具参数累积和错误归一化。
- 事件顺序用固定时钟与固定 ID 的 fixture 做深比较，任何意外顺序或字段变化都会让测试失败。

## 4. 上下文投影

### 4.1 输入与输出

```ts
interface ProjectionInput {
  entries: SessionEntry[];
  system: string;
  tools: ProviderTool[];
}

interface ProjectionResult {
  messages: LlmMessage[];
  promptHash: string;
}
```

投影是纯函数：读取会话条目，产出 provider 消息，不修改存储历史。

### 4.2 投影管线

```text
SessionEntry[]
  -> 从最后一个条目沿 parentId 回溯，选出活动分支
  -> 应用 compaction_end：移除被替换条目，在最早被替换位置插入摘要
  -> 逐条转换：
       user_message        -> user 文本消息
       message_start/end   -> 建立 assistant 草稿
       message_delta       -> 只累加文本，丢弃 reasoning 与 tool_call 增量
       tool_call_start     -> 追加完整工具调用
       tool_execution_end  -> tool 结果消息
  -> 修复工具配对：为缺失结果的调用补一条错误结果
  -> 规范化 JSON 后计算 SHA-256 promptHash
```

工具调用的权威来源是 `tool_call_start`，不是流式增量；推理增量不进入 provider 消息。缺失工具结果会被补成 `Missing tool result ...` 错误消息，保证每次工具调用都有对应结果。

### 4.3 确定性

提示词哈希对 `{ system, messages, tools }` 做递归键排序后序列化，再计算 SHA-256。相同日志、相同策略、相同工具集必须得到相同哈希。回放时用记录下来的哈希做逐字节比较。

### 4.4 当前边界

- 运行时当前直接维护内存中的 `LlmMessage[]` 历史；投影函数已独立实现，但尚未接入运行时的每次模型调用。接入后，历史将完全由会话日志推导。
- 提醒注入、图片/附件能力降级、token 预算目前不在投影函数内；token 估算与压缩规划是独立模块。
- 投影不改变存储历史，所有“注入”都只能是派生视图。

## 5. 系统提示词

系统提示词是结构化文档，不是拼接字符串。`createPromptBuilder()` 支持以下命名段：

| 段                    | 内容                                                      |
| --------------------- | --------------------------------------------------------- |
| `identity`            | 身份与行为约束                                            |
| `environment`         | 工作目录、OS、shell、日期、git 分支、模型等，按键排序渲染 |
| `projectInstructions` | 从仓库根到工作目录的 `AGENTS.md` 内容                     |
| `skillIndex`          | 技能名称与描述，不加载正文                                |
| `toolGuidance`        | 工具使用指导，不包含工具 schema                           |
| `mode`                | `plan` / `execute` / `review`                             |

渲染格式固定为 `## <name>\n<content>`，段之间空一行，末尾带换行。`toolsAdded` 与 `toolsRemoved` 记录在文档对象中，用于重建某轮的工具集；当前渲染器不把它们写进提示词正文。

`AGENTS.md` 发现逻辑从仓库根逐级走到 `cwd`，根目录在前，子目录在后；缺失文件跳过。`cwd` 必须位于 `repoRoot` 内。

### 5.1 缓存构建

缓存不是独立子系统，而是提示词顺序与 provider 适配细节：

| 手段     | 做法                                                       |
| -------- | ---------------------------------------------------------- |
| 稳定前缀 | 静态段落在前，动态内容在后，缓存边界之上不放时间戳         |
| 显式标记 | Anthropic 的 `cache_control`；OpenAI 的 `prompt_cache_key` |
| 会话亲和 | provider 支持时让同一会话落在同一后端                      |
| 可观测性 | 记录每次请求的 `cache_read` / `cache_write` 用量           |

`pi-ai` 已提供缓存保留、用量字段与缓存测试。harness 自己负责的唯一策略是：一次性摘要请求不写缓存，避免压缩把有用的前缀挤出缓存。

## 6. 工具系统

工具是声明式对象加执行函数：

```ts
interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  concurrencyKey?(args: unknown): string | null;
  execute(context: ToolContext, args: unknown): Promise<ToolOutput>;
}
```

`ToolBatchExecutor` 负责难处理的部分：整批预检、独立调用并行、冲突写入串行、结果顺序、错误归一化、输出截断与持久化引用。

v0 工具集刻意保持很小：`read_file`、`write_file`、`edit_file`、`bash`、`grep`、`glob`。它们覆盖参数校验、路径策略、进程执行、输出截断、并发与中断。浏览器、computer-use、worktree、子代理属于产品能力，不是 harness 基础。

审批策略尚未接入工具执行器；`Tool` 上预留的审批字段属于后续设计。

## 7. 沙箱

### 7.1 审批与沙箱是两个轴

```text
approval: untrusted | on-failure | on-request | never
sandbox:  read-only | workspace-write | danger-full-access
```

审批决定“是否允许执行”，沙箱决定“执行时能触碰什么”。两者组合成权限配置。客户端展示和选择配置，服务端负责强制执行。

审批提示是社工攻击目标：仓库 README 可以诱导模型执行“标准构建步骤”并外传数据。真正的防线是默认拒绝网络的沙箱，审批弹窗只是 UX 检查点。

### 7.2 策略模型

```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface SandboxPolicy {
  mode: SandboxMode;
  writableRoots: string[];
  deniedReads: string[];
  network: "none" | "proxy" | "full";
  envAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}
```

默认值：网络 `none`，环境白名单 `PATH`、`HOME`、`LANG`、`TERM`，超时 120 秒，输出上限 1 MiB。生效策略由会话模式、工具声明、用户规则和项目信任共同解析；记录和执行的必须是解析后的策略，而不是请求方声称的策略。

### 7.3 解析与单调收敛

`resolveSandboxPolicy()` 负责归一化：

- `read-only` 不允许声明可写根；
- `workspace-write` 的可写根必须位于工作区内；
- `danger-full-access` 使用文件系统根（POSIX）；
- 去重并解析为绝对路径。

`clampSandboxPolicy(parent, requested)` 负责单调收敛，保证子任务不能比父任务更宽：

- 模式与网络按等级取更严格者；
- 可写根必须是父策略的子集；
- 拒绝读取的路径只增不减；
- 环境白名单取交集；
- 超时和输出上限取更小值。

每一条被收敛的放宽都会记入 `violations`，便于审计。

### 7.4 路径策略

OS 沙箱只覆盖子进程。harness 自己的文件工具运行在 Node 进程内，必须经过同一套 `PathPolicy`：

- 先解析 `realpath`，再授权；符号链接指向工作区外时返回 `symlink-escape`；
- 写操作在 `read-only` 下直接拒绝；
- `deniedReads` 优先于普通读取；
- `danger-full-access` 跳过工作区限制；
- 返回规范化后的路径，调用方必须使用它，避免“检查后使用”竞态；
- 空路径、空字节、无法解析的路径返回 `invalid-path`；
- 对尚不存在的写入目标，先解析最近的已存在祖先，再拼回缺失段。

### 7.5 执行器

```ts
interface Executor {
  readonly backend: "none" | "seatbelt" | "bwrap" | "docker";
  exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult>;
  probe(): Promise<SandboxCapabilities>;
}
```

当前实现：

- `NoopExecutor`：拒绝执行，用于没有沙箱后端的场景。
- `NodeProcessExecutor`：backend 为 `none`，只提供进程构造、环境隔离、超时、输出上限和进程组清理，不提供 OS 级文件系统或网络隔离。
- `NodeProcessExecutor` 使用 `spawn(..., { detached: true, shell: false })`；环境按白名单构造，并额外丢弃名称形似凭据的变量；超时先 SIGTERM，宽限期后 SIGKILL；进程退出后清理整个进程组，避免后台子进程残留；stdout/stderr 共用输出预算，截断时保证 UTF-8 边界完整。

### 7.6 环境与密钥隔离

- provider 凭据只留在 harness 进程，不传给工具子进程。
- 只转发白名单变量，绝不继承 `process.env`。
- 不加载登录 shell 启动文件：`bash --noprofile --norc -c` 或 `zsh -f -c`。
- 密钥应存放在 OS keychain，而不是工具可读的明文配置文件。

### 7.7 后端路线

| 后端                          | 平台        | 隔离级别                  | 依赖                   | 角色                      |
| ----------------------------- | ----------- | ------------------------- | ---------------------- | ------------------------- |
| `none`                        | 跨平台      | 无                        | 内置                   | 当前默认，仅进程构造      |
| Seatbelt（`sandbox-exec`）    | macOS       | 进程级，中高              | 系统自带，已废弃但可用 | macOS v1 默认             |
| bubblewrap                    | Linux       | 命名空间，高              | 需要安装               | Linux 默认与 CI           |
| Landlock + seccomp            | Linux 5.13+ | 进程级，中高              | 小型启动器             | bubblewrap 不可用时的选项 |
| Docker / Podman               | 跨平台      | 容器，高                  | 容器运行时             | CI、远程、不可信负载      |
| gVisor / Firecracker          | Linux       | 微虚拟机/用户态内核，很高 | 基础设施               | 后续多租户                |
| Apple Containerization        | macOS 26+   | 每容器一个 Linux VM       | 系统框架               | 未来本地强隔离            |
| 云沙箱（E2B、Modal、Daytona） | 托管        | 很高                      | 外部服务               | 产品化                    |
| Node `--permission`           | 跨平台      | 仅 harness 进程           | Node 24                | 插件隔离                  |

macOS 15 先用 Seatbelt。它被 Apple 标记为废弃，但仍可用且被 Codex 使用；放在 `Executor` 接口后面，未来可替换为 Apple Containerization 或容器后端。Linux 先用 bubblewrap；Docker 是可移植与不可信负载路径，不作为 macOS 日常默认，因为文件系统开销较大。

### 7.8 威胁模型

| 威胁                          | 主要防线                         |
| ----------------------------- | -------------------------------- |
| 模型删除或改写文件            | 路径约束加审批                   |
| 提示注入外传数据              | 默认禁网加密钥清洗               |
| 依赖 postinstall 执行任意代码 | 网络白名单或容器                 |
| 恶意 MCP server               | 同策略下的独立进程加工具暴露过滤 |
| 恶意插件/扩展                 | 进程外执行加 Node 权限模型       |
| 供应链或零日                  | 容器、微虚拟机或远程沙箱         |

设计遵循“致命三要素”规则：私有数据、不可信内容、外连通道不能同时可用。沙箱默认切断外连。

### 7.9 一致性测试

每个沙箱后端都要通过同一套测试：

- 工作区内写入成功；
- 工作区外写入失败；
- 读取 `~/.ssh`、`~/.aws` 失败；
- 网络访问失败；
- 子进程重复上述操作仍然失败；
- 指向工作区外的符号链接失败；
- `..` 穿越失败；
- 工具环境不含凭据；
- 超时后没有遗留进程；
- 超大输出被截断并持久化；
- MCP server 子进程遵守同一策略。

这套测试是平台适配器不“假装安全”的保证。

### 7.10 升级流程（规划）

1. 命令被沙箱拒绝。
2. 执行器识别为沙箱拒绝并发出 `sandbox_decision`。
3. 运行时向用户展示包含被拒操作和原因的升级审批。
4. `accept_for_session` 放宽本会话的生效策略并记录升级。
5. 会话结束后恢复默认策略。

命令尽量在执行前分类（路径规则与 shell 解析），事后 `EPERM` 检测只作为兜底。

## 8. 会话存储与回放

### 8.1 JSONL 布局

每个会话一个目录：

```text
<sessions-root>/<sessionId>/
  meta.json
  log.jsonl
```

`meta.json` 保存 `SessionMeta`：id、title、cwd、model、createdAt、parentSessionId、forkEntryId。`log.jsonl` 每行一个 `SessionEntry`：

```json
{ "id": "entry_...", "parentId": "entry_...", "event": { "type": "turn_start", "...": "..." } }
```

追加时默认把 `parentId` 指向当前最后一条条目，因此普通会话是线性链；显式传入 `parentId` 可以构造分支。每个会话的读写通过进程内 Promise 锁串行化，避免半行读取或并发追加。

### 8.2 树、fork 与列表

- `fork(sessionId, entryId)` 复制从根到指定条目的祖先链，创建新会话，并在 meta 中记录 `parentSessionId` 与 `forkEntryId`；原会话不变。
- `list()` 汇总每个会话的状态、最后条目、创建/更新时间与 token 用量。
- 状态由最后一条事件推导：`settled` 为已结算，`error` 为错误，其余为活动。
- 用量只累加 `message_end`，避免与 `turn_end` 的聚合用量重复计算。
- 内存存储与 JSONL 存储共享同一套契约测试。

### 8.3 回放

回放把日志折叠成时间线，选取活动分支，执行与在线相同的投影，再重建提示词。原始轮次记录的 `promptHash` 必须与回放结果一致。回放只依赖日志与策略，不重新调用模型。

### 8.4 索引（规划）

SQLite 只作为派生索引，用于会话列表、token/成本统计与全文搜索；删除后可以从 JSONL 重建。候选绑定为 `better-sqlite3` 或 libsql，具体在实现时决定。

### 8.5 原始载荷（规划）

provider 请求/响应原文存放在旁路目录，便于调试；回放不依赖这些载荷，因此可以单独清理。

## 9. 压缩

压缩是策略对象，包含触发条件、摘要器与保留策略。当前实现：

- `createCompactionPolicy()`：`tokens > contextWindow - reserveTokens` 时触发。
- `planCompaction()`：按 token 估算判断是否需要压缩，并保留最近若干轮用户消息不压缩。
- 投影器会应用已记录的 `compaction_end`：移除被替换条目，并在最早被替换位置插入 `[compacted context]` 摘要。

规划中的部分：

- 运行时自动触发压缩、调用摘要器并写入 `compaction_start` / `compaction_end`。
- 按分支独立压缩；fork 后的分支各自计算。
- provider 上下文溢出时压缩并重试一次。
- 一次性摘要请求禁用 prompt-cache 写入，避免污染缓存。

压缩是日志中的事件，不是就地改写历史。

## 10. 协议、SDK 与 CLI（规划）

- **协议**：JSON-RPC 2.0 风格，支持 stdio JSONL、WebSocket 与进程内传输。方法覆盖 `initialize`、会话 start/resume/fork/list、轮次 start/steer/interrupt、审批响应、subscribe/unsubscribe、沙箱模式选择。
- **SDK**：基于 `schema` 的类型化客户端，暴露会话创建、prompt、steer、interrupt、事件订阅与审批响应。
- **CLI**：使用 `pi-tui`，从第一天起只作为协议客户端，即使传输是进程内的，也不直接导入 `core`。
- **ACP**：后续作为编辑器集成适配器加入，不作为主协议。
- **Web/桌面**：等协议与回放稳定后再做。

## 11. Skills 与 MCP（规划）

Skills 遵循 Agent Skills 规范：`SKILL.md` 加 YAML frontmatter，按需加载正文，四个作用域（builtin、user、project、plugin）。提示词中只放名称与描述，选中后才读正文，避免提前占满上下文。

MCP 使用官方 `@modelcontextprotocol/sdk`，支持 stdio 与 streamable HTTP、OAuth、工具命名空间（`mcp__server__tool`）、暴露过滤与项目信任。生命周期覆盖崩溃、重连、超时与工具列表变化。

## 12. 里程碑

| 里程碑 | 交付物                                     | 覆盖维度                     |
| ------ | ------------------------------------------ | ---------------------------- |
| M0     | 单个 provider、流式 CLI 对话、事件日志骨架 | 运行时、轮次、provider、记录 |
| M1     | 六个工具、审批门、上下文投影               | 工具、上下文、审批           |
| M2     | 分段提示词、AGENTS.md、技能索引、压缩      | 提示词、缓存、压缩、扩展     |
| M3     | JSONL 树、resume/fork、确定性回放测试      | 记录、回放、存储             |
| M4     | 协议、server、类型化 SDK、CLI 协议客户端   | 协议、SDK、CLI               |
| M5     | macOS 沙箱执行器、一致性套件、MCP          | 沙箱、扩展                   |
| M6     | 网络代理、容器后端、ACP                    | 沙箱、协议                   |

沙箱策略与执行器接口在 M0/M1 就引入，即使第一个真实后端在 M5 才落地，这样工具从一开始就写在执行器边界上。

## 13. 风险与取舍

- **Seatbelt 已废弃**：放在 `Executor` 接口后，保留 Docker 兜底，后续采用 Apple Containerization 或 Linux bubblewrap。
- **macOS 上的 Docker 较慢**：用于不可信负载与 CI，不作为日常默认；可评估 OrbStack。
- **进程内文件工具绕过 OS 沙箱**：强制 `PathPolicy`、符号链接解析，必要时把文件操作路由到沙箱辅助进程；一致性测试覆盖两条路径。
- **提示词缓存脆弱**：稳定前缀、提示词哈希、缓存用量指标，以及一次性摘要不写缓存。
- **JSONL 增长**：压缩、SQLite 索引、后续保留策略；原始载荷旁路存放，可单独清理。
- **依赖 `pi-ai`**：provider 接口隔离；可以用 Vercel AI SDK 或直接适配器替换。
- **范围蔓延**：明确的非目标与里程碑门禁；产品功能必须单独开变更。
- **虚假安全感**：文档明确审批是 UX、v0 没有 OS 沙箱；一致性套件通过前不宣称沙箱完成。
- **树日志复杂**：先做追加加 `parentId`；fork 与分支压缩在 M3 落地。
- **协议频繁变动**：协议版本化，schema 生成客户端；首个外部客户端发布前只做增量变更。

## 14. 开放问题

- 第一条端到端链路使用哪个 provider 与模型？设计假设一个 OpenAI 兼容端点，`pi-ai` 后续可提供其他厂商。
- SQLite 绑定选 `better-sqlite3` 还是 libsql？索引可丢弃，可在实现时决定。
- 开发机是否有 macOS 26 可用于 Apple Containerization 实验，还是第一年 Seatbelt 加 Docker 足够？
- 首个 SDK 从 schema 生成还是手写薄客户端？schema 工具稳定时优先生成。
- 插件 API 何时暴露？在协议与沙箱边界稳定之前不暴露。
