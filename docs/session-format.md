# 会话存储格式

会话是唯一事实来源。内存、JSONL 与 SQLite 索引共享同一套语义：**日志追加、分支由 `parentId` 决定、投影与重放不写入日志**。

## 1. 目录布局

`JsonlSessionStore` 为每个会话创建一个目录：

```text
<root>/
  session_<id>/
    meta.json              SessionMeta：cwd、model、createdAt、title、fork 信息
    log.jsonl              仅追加的 SessionEntry 行
  index.db                 SqliteSessionIndex，可随时删除重建
  raw/
    session_<id>/
      <timestamp>-step-0001-request.json
      <timestamp>-step-0001-response.jsonl
```

`raw/` 是 `RawCaptureProvider` 写出的原始 provider 载荷，仅用于调试。重放只读 `log.jsonl`，删除 `raw/` 与 `index.db` 不影响重放。

## 2. 日志条目

每行是一个 `SessionEntry`：

```ts
{
  id: "entry_...",          // 稳定且唯一
  parentId: "entry_..." | null,
  event: AgentEvent         // 与运行时、事件订阅完全相同的对象
}
```

- 追加时默认把当前叶子作为父节点，因此普通追加形成单链。
- 显式传入 `parentId` 可把条目挂到更早的节点，形成分支。
- `fork(sessionId, entryId)` 复制该条目的祖先链到新会话，原会话不变。
- `entries()` 返回物理追加顺序；投影会从最后一个条目沿 `parentId` 回溯，只使用活动分支。

事件负载见 `docs/events.md`。与会话重建相关的事件：

| 事件                                              | 重放用途                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `turn_start` / `turn_end`                         | 折叠轮次边界                                                                |
| `user_message`                                    | 重建用户消息（`delivery` 保留 prompt/steer/follow_up）                      |
| `message_start` / `message_delta` / `message_end` | 重建 assistant 文本与工具调用；`error`/`aborted` 消息被丢弃                 |
| `tool_call_start` / `tool_execution_end`          | 重建工具调用与结果，并按 `toolCallId` 配对                                  |
| `context_projected`                               | 记录该次请求的 `promptHash`、system、sections、工具声明、消息数与估算 token |
| `compaction_end`                                  | 用 `replacedEntryIds` 删除被摘要替代的条目，并插入摘要                      |
| `sandbox_decision` / `approval_*`                 | 审计与重放时展示相同的决策                                                  |

## 3. 确定性与重放

`replaySession()` 对每个 `context_projected` 条目执行：

1. 取该条目之前的活动分支前缀；
2. 用事件中记录的 `system` 与 `tools` 重新投影；
3. 计算 `hashPrompt({ system, messages, tools })`；
4. 与记录的 `promptHash` 比较。

投影是纯函数：不修改 `entries`，也不读取 `raw/`。因此同一日志在进程重启、索引删除后仍得到相同消息与哈希。

运行时的历史与该投影一致：

- provider 失败或中止的 assistant 消息不进入下一次请求，投影会丢弃 `stopReason` 为 `error`/`aborted` 的消息；
- 没有结果的工具调用会插入合成的错误结果（孤儿修复），日志本身不变；
- 压缩后的摘要以 `[compacted context]` 用户消息参与投影。

## 4. 恢复与分叉

- `loadResumeState(store, sessionId)` 要求日志最后一个事件是 `settled`，然后用最后一条 `context_projected` 重建历史。
- 恢复的运行时通过 `initialHistory` 继续；新的请求追加到同一日志。
- `fork` 从选定条目复制祖先链。新会话的 `parentSessionId` 与 `forkEntryId` 记录来源。

## 5. 可重建索引

`SqliteSessionIndex` 从存储重建：

```text
sessions(id, title, cwd, model, status, created_at, updated_at, last_entry_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, has_usage,
         search_text)
```

- `list()` 按 `created_at`、`id` 排序，结果与 `SessionStore.list()` 一致。
- `usage()` 汇总 `message_end.usage`；`turn_end` 是轮次聚合，不重复累计。
- `search(q)` 对 id、标题、cwd 与记录文本做小写子串匹配。
- 删除 `index.db` 后重新 `rebuild(store)` 得到完全相同的列表、token 与搜索结果。

## 6. 样例日志

`docs/samples/session-log.jsonl` 是一次固定时钟、固定 ID 的完整轮次。它包含：

```text
agent_start
turn_start -> user_message -> context_projected -> message_start -> message_delta -> message_end
turn_end -> agent_end -> settled
```

`packages/core/test/session/sample-log.test.ts` 读取该文件并验证每个 `context_projected.promptHash` 都能从日志重放得到。
