# Provider 契约

provider 是唯一知道模型线格式的地方。它之上的所有代码只消费 `packages/core/src/provider.ts` 中的 `LlmEvent`。

## 1. 契约

```ts
interface Provider {
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
  models(): ModelInfo[];
}
```

`LlmRequest` 包含模型 id、组装好的系统提示词、规范化消息与工具声明。消息只使用 harness 形状：

- `user`：内容块；
- `assistant`：内容块，可选 `toolCalls`；
- `tool`：`toolCallId`、可选 `toolName`、内容块。

provider 实现负责在自身线格式与这些形状之间转换。运行时不会看到任何厂商字段。

| `LlmEvent`        | 含义                                                 |
| ----------------- | ---------------------------------------------------- |
| `text_delta`      | 助手可见的文本增量                                   |
| `reasoning_delta` | 私有推理增量，不渲染为助手文本                       |
| `tool_call_delta` | 带索引的工具调用 id、名称和/或参数片段               |
| `usage`           | token 用量；provider 未上报时可以省略                |
| `done`            | 终止原因：`end`、`max_tokens`、`tool_use`、`aborted` |
| `error`           | 归一化后的 provider 失败，结束流                     |

provider 必须把 `done` 或 `error` 恰好一次作为最后一个事件。其余结束方式会被运行时视为 `provider_stream_incomplete` 错误。

## 2. pi-ai 适配

`PiAiProvider` 适配 `@mariozechner/pi-ai` 的模型与流。

```ts
import { getModel } from "@mariozechner/pi-ai";
import { PiAiProvider } from "@pika-harness/adapters";

const provider = new PiAiProvider({
  model: getModel("openai", "gpt-4o-mini"),
  apiKey: process.env.OPENAI_API_KEY,
  sessionId: "session_1",
  cacheRetention: "short",
});

for await (const event of provider.stream(request, signal)) {
  // text_delta | reasoning_delta | tool_call_delta | usage | done | error
}
```

事件映射：

| pi-ai                               | harness                 |
| ----------------------------------- | ----------------------- |
| `text_delta`                        | `text_delta`            |
| `thinking_delta`                    | `reasoning_delta`       |
| `toolcall_start` / `toolcall_delta` | `tool_call_delta`       |
| `toolcall_end`                      | 最终 id/name 或完整参数 |
| `done`                              | 先 `usage`，再 `done`   |
| `error`                             | 先 `usage`，再 `error`  |

工具声明由 Zod JSON Schema 经 TypeBox 的 `Type.Unsafe` 包装；pi-ai 只需要结构化的 `TSchema`。工具结果通过 `toolCallId` 与 assistant 调用配对；harness 会在 tool 消息上提供 `toolName`，适配器也会回退到前面 assistant 消息中出现过的名称。

`toolcall_end` 只在没有任何 `toolcall_delta` 携带参数时发送完整参数，避免对已流式给出参数的 provider 重复参数。

适配器支持 `apiKey`、`sessionId`、`cacheRetention`、`headers`、`temperature`、`maxOutputTokens` 与中止信号。`models()` 返回当前 provider 实例对应的单个模型信息，包括上下文窗口与最大输出。

## 3. 测试

单元测试通过 `stream` 选项注入假传输，不访问网络：

```ts
const provider = new PiAiProvider({ model, stream: fakeStream, now: () => 0 });
```

运行时测试使用 `FauxProvider`，因为运行时不应依赖具体 provider。

真实链路冒烟测试是可选步骤：只有显式设置环境变量并提供凭据时才运行，且不进入 `pnpm check` 或 CI。它只用于在修改适配器后验证真实端点。
