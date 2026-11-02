# 上下文管线

上下文管线把“会话日志 + 系统提示词 + 工具表”变成一次确定性的 provider 请求。管线只读日志，投影结果不写回；运行时在真正发起请求前记录 `context_projected`，因此同一份日志与同一份输入必须得到同一个 `promptHash`。

```text
AGENTS.md ──> PromptBuilder ──> SystemPromptDocument { sections, toolsAdded, toolsRemoved }
                                              |
Session log ──> ContextProjector ──> LlmMessage[] ──> reminders ──> convert
                                              |                        |
                                              v                        v
                                         hashPrompt(system, messages, tools)
                                              |
                                              v
                                    context_projected（事件日志）
```

实现位置：

| 步骤                 | 文件                                          |
| -------------------- | --------------------------------------------- |
| AGENTS.md 发现       | `packages/core/src/context/agents-md.ts`      |
| 分节系统提示词       | `packages/core/src/context/prompt-builder.ts` |
| 日志投影             | `packages/core/src/context/projection.ts`     |
| 提醒、转换、缓存计量 | `packages/core/src/context/pipeline.ts`       |
| 提示词哈希           | `packages/core/src/context/hash.ts`           |
| 阈值压缩策略         | `packages/core/src/context/compaction.ts`     |
| 运行时接入           | `packages/core/src/runtime/runtime.ts`        |

## 1. 系统提示词分节

提示词由具名 section 组成，顺序固定，空 section 被省略：

1. `identity`
2. `environment`（key 按字典序排序，输出 `key: value` 行）
3. `projectInstructions`（根到叶的 AGENTS.md，用空行连接）
4. `skillIndex`（保持输入顺序的 `- name: description` 列表）
5. `toolGuidance`
6. `mode`

渲染规则是每个 section 输出 `## <name>\n<content>`，section 之间空一行，整体以一个换行结尾。

```text
## identity
You are Pika.

## environment
cwd: /workspace
shell: bash

## projectInstructions
Root rule.

Leaf rule.

## skillIndex
- beta: Second
- alpha: First

## toolGuidance
Prefer tools.

## mode
execute
```

测试：`packages/core/test/context/prompt.test.ts`。空输入渲染为 `""`。

`toolsAdded` / `toolsRemoved` 不进入正文，只随文档返回并写入 `context_projected`，用于说明本次请求相对上一请求的工具表变化。

### AGENTS.md 发现

`loadAgentsInstructions({ repoRoot, cwd, readFile? })` 从 `repoRoot` 逐级走到 `cwd`，只收集存在的 `AGENTS.md`，返回根在前、叶在后的数组；缺文件直接跳过，`cwd` 在 `repoRoot` 之外则抛错。测试：`packages/core/test/context/agents-md.test.ts`。

### 恢复时的重建

`context_projected.sections` 是完整快照。恢复会话时用 `renderPromptSections(sections)` 即可逐字节重建当时的系统提示词，无需重新读盘；测试 `rebuilds the recorded system prompt from persisted sections` 验证这一点。

## 2. 日志投影

`createContextProjector().project({ entries, system, tools })` 是纯函数，按以下顺序工作：

1. 从最后一条 entry 沿 `parentId` 回溯得到活动分支，再反转成时间顺序；断链或环会被访问集合截断。
2. 预扫描 `message_end`：`stopReason` 为 `error` 或 `aborted` 的 assistant 消息整条丢弃，与运行时内存历史一致。
3. 折叠事件：`message_start` 建稿，`message_delta` 累积文本与工具调用增量，`message_end` 定稿；`tool_execution_end` 的结果按 `toolCallId` 配对。
4. 应用 `compaction_end`：`replacedEntryIds` 命中的 entry 被移除，摘要以 `[compacted context]\n<summary>` 的用户消息插在被替换区间之前。
5. 工具配对修复：没有结果的工具调用补一条 `role: "tool"` 的 `error` 内容，消息以 “Missing tool result for tool call ...” 说明原因。
6. 用 `hashPrompt({ system, messages, tools })` 计算 `promptHash`。

投影不修改传入的 `entries`；所有内容 part、工具调用都会被克隆。测试：`packages/core/test/context/projection.test.ts`。

## 3. 提醒与 provider 转换

`createProjectionPipeline({ projector? }).project(input)` 在投影之上做三件纯追加的事：

- `reminders`：每个提醒包成 `<system-reminder>\n...\n</system-reminder>`，作为额外的 text part 追加到最后一条用户消息；日志中没有用户消息时补一条。日志本身不变。
- `convert`：provider 专属的消息转换，在提醒之后、哈希之前执行。
- `usage`：把 provider 上报的 `cacheReadTokens` / `cacheWriteTokens` 原样记录为 `cache`。

只有 `messages` 实际改变时才重新哈希；未注入提醒且未转换时复用投影结果的哈希。测试：`packages/core/test/context/pipeline.test.ts`。

## 4. 缓存规则

缓存命中依赖“长且稳定的前缀”。管线保证：

- system 由固定顺序的 section 渲染，环境变量排序，同一输入逐字节相同。
- 历史只追加，旧消息不重写；活动分支由 `parentId` 决定，分叉不会改变其它分支的内容。
- 提醒是临时的，只影响最后一条用户消息，不进入日志。
- `convert` 必须是确定性的纯函数，否则同一日志会产生不同请求。

`promptHash` 对 `{ system, messages, tools }` 做键排序后的规范 JSON，再取 SHA-256，因此字段书写顺序不影响结果。缓存读写 token 只来自 provider 的 `usage`，管线不做估算：

```text
usage.cacheReadTokens  -> cache.readTokens
usage.cacheWriteTokens -> cache.writeTokens
无 usage               -> { readTokens: 0, writeTokens: 0 }
```

## 5. Token 估算

`createTokenEstimator()` 默认按 4 字符约 1 token 估算；`estimateMessages` 累加所有 text 与 error 内容，并额外计算 assistant 工具调用的 `name` 与 `arguments`。图片不计入字符启发式，由 provider adapter 按各自规则计价。

估算只用于阈值判断与事件记录，不用于账单。

## 6. 压缩

### 策略

```text
shouldCompact(tokens, contextWindow, reserveTokens)
  = tokens > contextWindow - reserveTokens
```

`planCompaction(messages, { contextWindow, reserveTokens, keepRecentTurns })` 从末尾往前数用户消息，`keepRecentTurns` 条用户消息之前的位置就是切点 `cutIndex`；只有切点大于 0 且超过阈值才 `needed`。测试：`packages/core/test/context/compaction.test.ts`。

### 运行时路径

运行时配置 `compaction: { contextWindow, reserveTokens, keepRecentTurns, summarize }` 后：

1. 每次模型调用前做阈值检查（`reason: "threshold"`）。
2. provider 返回上下文溢出错误、且本轮尚未产生 assistant 消息时，强制压缩一次并重试该次调用（`reason: "overflow"`）；只重试一次。
3. 压缩前进入 `compacting` 状态，先发 `compaction_start`，摘要成功后发 `compaction_end`。

`compaction_end` 记录：

| 字段                           | 含义                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `summary`                      | `summarize(被替换的旧消息)` 的结果；失败或为空时使用 `Earlier conversation was compacted.` |
| `replacedEntryIds`             | 被摘要替换的真实日志 entry id                                                              |
| `tokensBefore` / `tokensAfter` | 压缩前后的 `estimateMessages` 结果                                                         |
| `model`                        | 执行摘要的模型                                                                             |

压缩只改内存历史：`[compacted context] 摘要 + 最近若干轮]`。投影从日志读取 `compaction_end` 重建同样的形状，因此回放与在线请求一致；`replacedEntryIds` 让投影知道哪些 entry 已被摘要覆盖。

摘要抛错时会发 `compaction_failed` 错误事件，但仍使用兜底摘要继续，避免会话卡死。

## 7. 与事件日志的对应关系

`context_projected` 在每次 `provider.stream` 之前发出，包含：

```text
promptHash       本次请求的哈希
system           完整系统提示词
sections         渲染 system 的 section 快照
toolsAdded       相对上一请求新增的工具名
toolsRemoved     相对上一请求移除的工具名
tools            本次请求的完整工具表
messageCount     消息条数
estimatedTokens  估算 token
```

回放（`packages/core/src/session/replay.ts`）用日志重算投影并比对 `promptHash`。示例日志与断言：`docs/samples/session-log.jsonl`、`packages/core/test/session/sample-log.test.ts`。

## 8. 不变量

- 投影、提醒、转换、哈希都是纯函数；任何一步都不写日志。
- 恢复会话必须用 `context_projected.sections` 重建 system，不能用当前磁盘上的 AGENTS.md 重新生成。
- 压缩摘要进入投影后必须与运行时内存历史同形，否则 `promptHash` 会在回放时漂移。
- 缓存 token 只记录 provider 上报值，不推断、不补齐。
