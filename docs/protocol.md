# 协议与 SDK

本文描述 `pika-harness` 的 JSON-RPC 风格协议、三种传输、类型化 SDK 和 `pi-tui` 客户端。协议契约在 `packages/schema/src/protocol.ts`，文档中的示例由 `packages/schema/test/protocol.test.ts` 验证；跨包行为由 `test/protocol-transport.test.ts`、`test/websocket.test.ts`、`test/sdk.test.ts` 和 `packages/server/test/session-server.test.ts` 覆盖。

## 1. 设计约束

- 所有客户端（CLI、SDK、后续 Web UI）只消费协议，不导入 `core` 运行时。
- 服务端持有唯一运行时；事件先写入会话日志，再广播给订阅者。客户端断开不会改变会话状态。
- 同一会话可以挂多个订阅者；`unsubscribe` 只影响该订阅。
- 沙箱策略由服务端解析和执行，客户端只能请求模式，不能绕过 executor。

## 2. 传输

| 传输        | 用途             | 帧格式                              |
| ----------- | ---------------- | ----------------------------------- |
| stdio JSONL | 子进程/管道集成  | 每行一个 JSON 消息，UTF-8           |
| WebSocket   | CLI 与远程客户端 | 每个 WebSocket 文本帧一个 JSON      |
| in-process  | 测试、嵌入式宿主 | 直接传递对象，`queueMicrotask` 保序 |

三种传输承载相同的消息语义与顺序。服务端对无法解析的帧返回：

```json
{ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }
```

## 3. 消息模型

请求：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "<method>", "params": {} }
```

成功响应：

```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

错误响应：

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "invalid params" } }
```

服务端推送的事件通知：

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "subscriptionId": "subscription_2",
    "event": {
      "sessionId": "session_1",
      "timestamp": "2026-01-01T00:00:02.000Z",
      "type": "settled"
    }
  }
}
```

### 错误码

| 码     | 含义               |
| ------ | ------------------ |
| -32700 | 帧解析失败         |
| -32600 | 请求结构非法       |
| -32601 | 方法不存在         |
| -32602 | 参数校验失败       |
| -32603 | 服务端内部错误     |
| 1001   | 会话不存在或未加载 |
| 1002   | 会话未处于 settled |
| 1003   | 审批 id 不存在     |
| 1004   | 服务端未配置沙箱   |

## 4. 方法

| 方法               | 参数                                  | 结果                 |
| ------------------ | ------------------------------------- | -------------------- |
| `initialize`       | `{ clientName?, protocolVersion? }`   | 协议版本与服务端能力 |
| `session.start`    | `{ cwd, model?, sandbox? }`           | 会话摘要与生效沙箱   |
| `session.resume`   | `{ sessionId }`                       | 会话摘要与生效沙箱   |
| `session.fork`     | `{ sessionId, entryId }`              | 新会话元数据         |
| `session.list`     | `{}`                                  | 会话摘要数组         |
| `turn.start`       | `{ sessionId, text }`                 | `{ accepted: true }` |
| `turn.steer`       | `{ sessionId, text }`                 | `{ accepted: true }` |
| `turn.follow_up`   | `{ sessionId, text }`                 | `{ accepted: true }` |
| `turn.interrupt`   | `{ sessionId, reason? }`              | `{ accepted: true }` |
| `approval.respond` | `{ sessionId, approvalId, decision }` | `{ accepted: true }` |
| `subscribe`        | `{ sessionId }`                       | `{ subscriptionId }` |
| `unsubscribe`      | `{ subscriptionId }`                  | `{ removed }`        |
| `sandbox.mode`     | `{ sessionId, mode, network? }`       | 生效沙箱             |

`turn.*` 的响应只表示命令进入串行队列；真正的完成信号是订阅流中的 `settled` 事件。

### initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "clientName": "docs-client", "protocolVersion": 1 }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "serverName": "pika-harness",
    "capabilities": { "transports": ["stdio", "websocket", "in-process"] }
  }
}
```

### session.start

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.start",
  "params": {
    "cwd": "/workspace",
    "model": "faux-model",
    "sandbox": { "mode": "workspace-write", "network": "none" }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "session": {
      "id": "session_1",
      "cwd": "/workspace",
      "model": "faux-model",
      "status": "settled",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:01.000Z",
      "lastEntryId": "entry_9",
      "title": "New session"
    },
    "sandbox": { "backend": "none", "mode": "workspace-write", "network": "none" }
  }
}
```

### subscribe

```json
{ "jsonrpc": "2.0", "id": 3, "method": "subscribe", "params": { "sessionId": "session_1" } }
```

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "subscriptionId": "subscription_2" } }
```

### approval.respond

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "approval.respond",
  "params": {
    "sessionId": "session_1",
    "approvalId": "approval_17",
    "decision": "approve_for_session"
  }
}
```

```json
{ "jsonrpc": "2.0", "id": 4, "result": { "accepted": true } }
```

`decision` 只能是 `approve`、`approve_for_session` 或 `deny`。服务端允许客户端在 `approval_requested` 事件到达后立即响应：审批 id 在事件广播前就已登记，早到的决定会被缓存，等运行时开始等待时立即生效。

### 错误示例

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": { "code": 1001, "message": "session not found: session_9" }
}
```

## 5. 沙箱模式与审批

1. `session.start` 的 `sandbox` 只表达请求。服务端用 `maxMode`/`maxNetwork` 上限夹取，并在响应的 `sandbox` 字段返回实际生效值。
2. 每次策略变化（启动、恢复、fork、`sandbox.mode`）都会写入一条会话级 `sandbox_policy` 事件。
3. 工具调用先经过 `sandbox_decision` 预检；被拒绝时运行时发出 `approval_requested`，客户端可批准一次或整个会话。
4. 批准只会把策略沿单轴放宽一档。真正的执行仍由 sandbox executor 强制；客户端无法发送绕过 executor 的命令。
5. 未配置审批处理器或审批超时，一律按 `deny` 处理。

## 6. 类型化 SDK

```ts
import { PikaClient, createWebSocketClientTransport } from "@pika-harness/client";

const client = new PikaClient({
  transport: createWebSocketClientTransport("ws://127.0.0.1:7331"),
  clientName: "my-agent",
});

await client.initialize();
const { session, sandbox } = await client.startSession({ cwd: process.cwd() });
const subscription = await client.subscribe(session.id);

subscription.onEvent((event) => {
  if (event.type === "message_delta" && event.delta.kind === "text") {
    process.stdout.write(event.delta.text);
  }
  if (event.type === "approval_requested") {
    void client.respondToApproval(session.id, event.approval.id, "approve_for_session");
  }
  if (event.type === "settled") {
    console.log(`\nsettled at ${sandbox.mode}`);
  }
});

await client.prompt(session.id, "summarize the repository");
```

SDK 还提供 `resumeSession`、`forkSession`、`listSessions`、`steer`、`followUp`、`interrupt`、`setSandboxMode` 和 `unsubscribe`。订阅对象同时是 `AsyncIterable<AgentEvent>`，可以 `for await` 消费。

## 7. CLI

CLI 只依赖 `schema` 和 `client`，通过 WebSocket 连接服务端。

```bash
# 终端一：启动演示服务端（确定性 echo provider）
pnpm server

# 终端二：一次性提问
pnpm cli -- --prompt "hello harness"

# 续接已有会话
pnpm cli -- --session session_1 --prompt "continue"

# 交互模式（pi-tui）：输入消息，/approve 或 /deny 处理升级，/quit 退出
pnpm cli
```

指定服务端地址、工作目录和初始沙箱：

```bash
PIKA_SERVER_URL=ws://127.0.0.1:7331 \
  pnpm cli -- --cwd /path/to/workspace --sandbox-mode read-only --network none
```

一次性模式遇到审批请求时默认拒绝，避免非交互场景静默放宽权限；需要升级时使用交互模式。

## 8. 验证

- 协议 schema 与错误形状：`pnpm vitest run packages/schema/test/protocol.test.ts`
- stdio 与 in-process 事件序列一致：`pnpm vitest run test/protocol-transport.test.ts`
- WebSocket 多订阅与退订：`pnpm vitest run test/websocket.test.ts`
- 审批路由与客户端不可绕过沙箱：`pnpm vitest run packages/server/test/session-server.test.ts`
- SDK 端到端（工具、审批、steer、interrupt）：`pnpm vitest run test/sdk.test.ts`
- CLI 边界：`pnpm boundary`
