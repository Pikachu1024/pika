# CLI 交互客户端

`pika` 是协议客户端，不在本地运行 agent 循环。所有会话、工具执行、沙箱和审批都在 `pika-server` 侧完成；客户端只负责 slash 命令、模型目录、状态展示和事件渲染。

```bash
pika [--url ws://127.0.0.1:7331] [--session <id>] [--cwd <path>]
```

不带 `--prompt` 时进入 pi-tui 交互界面。`/` 开头触发命令补全，普通文本作为用户消息发送。

## 1. 模型目录

客户端按以下顺序定位目录文件：

1. `PIKA_MODELS_FILE`，相对路径按当前工作目录解析；
2. 否则读取 `<cwd>/.pika/models.json`。

默认文件不存在时不会报错，此时只保留 `PIKA_LLM_*` 或 `--llm-*` 提供的隐式 `env` 预设。显式指定的文件无法读取、JSON 非法或不符合 schema 时，客户端报告文件路径和原因，并继续使用当前会话。

```json
{
  "default": "fast",
  "models": [
    {
      "name": "fast",
      "model": "local-small",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "FAST_API_KEY",
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    {
      "name": "reasoning",
      "model": "local-large",
      "baseUrl": "http://127.0.0.1:8000/v1"
    }
  ]
}
```

- `name`：`/model`、`/handoff` 使用的别名，必须唯一。
- `model`、`baseUrl`：传给会话的模型 id 与端点。
- `apiKeyEnv`：保存密钥的环境变量名，不是密钥本身。
- `contextWindow`、`maxTokens`：可选的正整数。
- `default`：可选，必须指向已定义的别名。

密钥只在需要创建会话时从 `apiKeyEnv` 命名变量读取。变量缺失或为空时命令失败并只报告变量名；`/config` 只显示 `set` 或 `missing`，不会打印密钥，目录错误也不会回显文件内容。

启动时的模型优先级：

1. 存在 `PIKA_LLM_*` 或 `--llm-*` 时，使用隐式 `env` 预设；
2. 否则使用目录的 `default`；
3. 否则使用第一个预设；
4. 都没有时使用服务端默认模型。

`PIKA_MODELS_FILE` 指定的目录与隐式 `env` 预设可以同时存在，`/models` 会把 `env` 排在列表首位。

## 2. 命令

| 命令                                                                      | 说明                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `/help`                                                                   | 列出命令和参数提示                                         |
| `/models`                                                                 | 列出预设，`*` 标记当前模型，显示引用的密钥变量名           |
| `/model [alias]`                                                          | 在会话头部 fork 到新会话并切换预设；无参数时弹出选择列表   |
| `/config`                                                                 | 显示目录路径、当前默认预设，以及每个密钥变量是否存在       |
| `/status`                                                                 | 显示会话、模型、沙箱和目录                                 |
| `/usage`                                                                  | 显示当前会话聚合的 token 用量                              |
| `/context`                                                                | 显示最近一次上下文投影的消息数和估算 token                 |
| `/new`                                                                    | 用当前模型和目录新建会话                                   |
| `/sessions`                                                               | 列出会话                                                   |
| `/resume [sessionId]`                                                     | 恢复会话并替换当前订阅和 transcript；无参数时弹出选择列表  |
| `/fork [entryId]`                                                         | 在指定 entry 或当前头部 fork，并移动到新会话               |
| `/handoff <alias> [--cwd <path>] [--sandbox <mode>] [--network <policy>]` | 在头部 fork，换预设并可覆盖目录、沙箱模式和网络策略        |
| `/sandbox [mode] [--network <policy>]`                                    | 请求修改沙箱；省略参数时弹出模式选择                       |
| `/compact`                                                                | 在 settled 会话上强制压缩上下文，并报告压缩前后的 token 数 |
| `/btw <question>`                                                         | 用空工具列表回答旁路问题，不写入会话日志                   |
| `/approve`、`/deny`                                                       | 处理待审批的沙箱升级请求                                   |
| `/quit`                                                                   | 退出客户端（`Ctrl+C` 同样退出）                            |

参数按空白拆分，支持双引号；引号内可用 `\"` 转义。无法识别的命令在本地拒绝，不会作为提示词发送给模型。

### 模型切换与会话语义

`/model` 和 `/handoff` 都是 fork：源会话保持不变，新会话记录 parent 和 fork entry。还在运行的回合会拒绝这两条命令，需要等待 `settled`。

`/handoff` 的 `--sandbox`、`--network` 只是请求值，服务端仍会按会话上限收敛，实际生效值通过 `sandbox_policy` 事件和状态行更新。`/new` 与 `/model` 切换后，新会话沿用当前沙箱设置。

`/compact`、`/btw`、`/fork`、`/model`、`/handoff` 都要求会话已 settled。`/btw` 的答案以 `[btw]` 标记输出，不改变会话 entry 或用量；手工压缩只在成功时输出 `[compact] <before> -> <after> tokens`，阈值压缩仍由运行时自动触发。

## 3. 界面状态

状态行始终显示：

```text
<running|settled> | <model> (<alias>) | <sandbox mode>/<network> | <session id> | <cwd>
```

transcript 中会标记 `[tool]`、`[turn <stopReason>]`、`[compact]`、`[approval ...]` 和 `[btw]`。切换会话时 transcript 清空并显示新会话行。

## 4. 范围

本版不提供 TUI 内的目录编辑、`/btw` 流式输出、会话中途热切换模型（切换总是 fork）、外部 handoff/导出、新的密钥存储，以及用户自定义命令。
