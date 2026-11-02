# 事件契约

运行时的每一次可观察变化都是一个规范化 `AgentEvent`。同一批对象不加转换地流向三个消费者：

```text
runtime --emit--> session log（追加式 JSONL）
              \--> event sink（进程内客户端、测试）
              \--> server transport（规划：协议帧）
```

schema 定义在 `packages/schema/src/events.ts`。消费者必须用 `AgentEventSchema` 校验，生产者不得发明字段。

## 1. 事件信封

```text
EventBase      = { sessionId, timestamp }
TurnEventBase  = EventBase + { turnId }
```

- `timestamp` 是带时区偏移的 ISO-8601 字符串。
- `agent_start`、`agent_end`、`settled` 使用 `EventBase`。
- 其余事件使用 `TurnEventBase`。

事件通过单写者发射链输出。运行时先等待会话追加完成，再调用事件消费者。因此“已写入日志的事件”与“客户端观察到的事件”是同一个对象、同一顺序。

## 2. 生命周期

```text
agent_start
  turn_start              turnNumber + 用户输入
    user_message          delivery = prompt | steer | follow_up
    compaction_start      超出阈值或上下文溢出时
    compaction_end        摘要、替换的 entry、压缩前后 token
    context_projected     本次 provider 请求的哈希、system、工具表
    message_start         assistant 消息
      message_delta       text | reasoning | tool_call 增量
    message_end           stopReason + 可选 usage
    tool_call_start       每个最终确定的调用一次，位于 message_end 之后
      tool_execution_start
      tool_execution_update   零到多个输出块
      tool_execution_end      归一化后的 ToolResult
    ...                   存在工具调用或 steer 时再次调用模型
  turn_end                stopReason + 本轮汇总 usage
agent_end
settled
```

`context_projected` 在每次模型调用前发出，因此一轮内可能出现多次。

`agent_start` 与 `agent_end` 包住一串排队的轮次。`settled` 在 prompt、steer、follow-up 三个队列全部排空后发出一次。

provider 出错时，如果消息已开始，先发 `message_end`（`stopReason: "error"`），再发 `error`；随后 `turn_end` 以 `stopReason: "error"` 结束。工具失败本身不会结束本轮：它变成 `tool_execution_end` 中 `isError: true` 的结果，模型在下一次调用中收到错误内容。

## 3. 投递语义

| delivery    | 入队点           | 效果                                                                    |
| ----------- | ---------------- | ----------------------------------------------------------------------- |
| `prompt`    | `prompt(text)`   | 空闲时启动新轮；有活动轮时转为 follow-up                                |
| `steer`     | `steer(text)`    | 当前模型步骤结束后注入，触发同一轮内再次调用模型；空闲运行时当作 prompt |
| `follow_up` | `followUp(text)` | 当前轮结束后作为新轮执行                                                |

`interrupt(reason)` 中止活动的 provider 流或工具批。已在执行的工具调用得到 `aborted` 错误结果，本轮以 `stopReason: "aborted"` 结束，运行时回到 `idle`，后续 prompt 仍可成功。

## 4. 事件类型

| 类型                    | 负载                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `agent_start`           | 无                                                                                                           |
| `agent_end`             | 无                                                                                                           |
| `turn_start`            | `turnNumber`、`input`                                                                                        |
| `turn_end`              | `stopReason`、可选 `usage`                                                                                   |
| `user_message`          | `messageId`、`delivery`、`message`                                                                           |
| `message_start`         | `messageId`、`role: "assistant"`                                                                             |
| `message_delta`         | `messageId`、`delta`                                                                                         |
| `message_end`           | `messageId`、`stopReason`、可选 `usage`                                                                      |
| `tool_call_start`       | `messageId`、`call`                                                                                          |
| `tool_execution_start`  | `toolCallId`、`name`                                                                                         |
| `tool_execution_update` | `toolCallId`、`chunk`                                                                                        |
| `tool_execution_end`    | `toolCallId`、`result`                                                                                       |
| `context_projected`     | `promptHash`、`system`、`sections`、`toolsAdded`、`toolsRemoved`、`tools`、`messageCount`、`estimatedTokens` |
| `approval_requested`    | `approval`                                                                                                   |
| `approval_resolved`     | `approvalId`、`resolution`                                                                                   |
| `sandbox_decision`      | `decision`                                                                                                   |
| `compaction_start`      | `reason`（`threshold`、`overflow`、`manual`）                                                                |
| `compaction_end`        | `summary`、`replacedEntryIds`、`tokensBefore`、`tokensAfter`、`model`                                        |
| `error`                 | `error`                                                                                                      |
| `settled`               | 无                                                                                                           |

`message_delta` 有三种：

```ts
{ kind: "text"; text: string }
{ kind: "reasoning"; text: string }
{ kind: "tool_call"; index: number; id?: string; name?: string; argumentsDelta?: string }
```

`usage` 统计输入、输出，以及可选的缓存读/写 token。一轮的用量是各模型步骤之和；失败或中止的步骤只贡献 provider 已上报的用量。

### 当前发射状态

- 已由运行时发出：`agent_start`、`agent_end`、`turn_start`、`turn_end`、`user_message`、`message_start`、`message_delta`、`message_end`、`tool_call_start`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`context_projected`、`compaction_start`、`compaction_end`、`error`、`settled`。
- 仅在运行时配置了 sandbox 时发出：`sandbox_decision`。它先于对应的 `tool_execution_start`；一次升级会先记录 `deny`，审批通过后再记录 `allow`。
- 仅在配置了 sandbox 且提供了审批处理器时发出：`approval_requested`、`approval_resolved`。没有处理器或审批模式为 `never` 时，升级直接按 `deny` 处理且不产生审批事件。

## 5. 错误归一化

`NormalizedError` 的结构：

```ts
{ code: string; message: string; retryable: boolean; details?: Record<string, unknown> }
```

| 来源                         | code                                            |
| ---------------------------- | ----------------------------------------------- |
| provider 的 `error` 事件     | 保留 provider 提供的 code                       |
| provider 流结束但没有 `done` | `provider_stream_incomplete`                    |
| provider transport 抛错      | `provider_error`（经 `providerFailure` 归一化） |
| 工具参数不是合法 JSON        | `invalid_arguments`                             |
| 工具参数未通过 Zod 校验      | `validation_error`                              |
| 未知工具名                   | `unknown_tool`                                  |
| 工具执行抛错                 | `execution_error`                               |
| 工具调用被中止               | `aborted`                                       |
| 没有配置工具执行器           | `no_executor`                                   |
| 执行器没有返回对应结果       | `missing_result`                                |
| 单轮模型调用超限             | `max_model_calls`                               |

`pi-ai` 适配器把中止映射为 `aborted`，其他失败映射为 `provider_error`。

provider 与工具失败都是数据，不是抛出的控制流：运行时把它们变成 `error` 事件或错误 `ToolResult`，让会话回到 `idle`，并接受后续 prompt。

## 6. Fixture

固定时钟与固定 ID 的事件序列位于：

- `packages/core/test/fixtures/events/tool-turn.json`：工具调用、执行、第二次模型步骤与轮次结束。
- `packages/core/test/fixtures/events/provider-error.json`：provider 失败、错误轮次结束与恢复能力。

`packages/core/test/runtime/events-fixture.test.ts` 用脚本化 provider 重放每个轮次，并与 fixture 做深比较。任何意外的事件顺序或负载变化都会让测试失败。
