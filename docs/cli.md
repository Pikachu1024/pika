# CLI 交互客户端

`pika` 是唯一入口。默认情况下它先启动一个随自身生命周期存在的本地服务，再启动协议客户端；agent 循环、工具执行、沙箱和审批都在服务端完成，客户端只负责 slash 命令、模型目录、状态展示和事件渲染。

```bash
pika [--url <ws://host:port>] [--session <id>] [--cwd <path>]
pika --prompt <text> [options]
pika serve [--port <n>] [--host <addr>] [--dir <path>]
           [--sandbox-backend <backend>]
```

不带 `--prompt` 时进入 pi-tui 交互界面。`/` 开头触发命令补全，普通文本作为用户消息发送。

## 1. 启动与本地服务

默认模式下 `pika` 会重新执行自身进入服务端模式：

1. 生成一个 32 字节的随机 token，只通过 `PIKA_SERVER_TOKEN` 传给它启动的子进程；
2. 在 `127.0.0.1` 上以 `--port 0` 启动服务，端口由系统分配；
3. 读取服务端打印的 `pika-server listening on ws://...` 行，解析出实际地址；
4. 把带 token 的地址作为 `--url` 传给客户端逻辑并进入 TUI 或单次提示模式。

子进程只继承显式的环境变量白名单（`PATH`、`HOME`、`TMPDIR`、locale、代理设置、`NODE_EXTRA_CA_CERTS` 以及 `PIKA_*`），工作目录与父进程一致。token 不会出现在日志或帮助文本中。

退出时父进程终止子进程：先发 `SIGTERM`，宽限期后仍未退出则发 `SIGKILL`；子进程也会在父进程关闭 stdin 时自行退出，因此不会留下监听端口。启动失败（子进程提前退出、输出无法解析、10 秒内未就绪）会以非零码退出，不进入 UI。

`--url` 或非空的 `PIKA_SERVER_URL` 表示远程模式：直接连接已有服务，不启动也不回收任何子进程。此时 token 需要由该服务的运维方自行提供。

`pika serve` 只运行服务端：

| 参数                           | 说明                                                    |
| ------------------------------ | ------------------------------------------------------- |
| `--port <n>`                   | 监听端口，`0` 表示系统分配；默认 `PIKA_PORT` 或 `7331`  |
| `--host <addr>`                | 监听地址，默认 `PIKA_HOST` 或 `127.0.0.1`               |
| `--dir <path>`                 | 会话目录，默认 `PIKA_SESSION_DIR` 或 `./.pika/sessions` |
| `--sandbox-backend <backend>`  | 工具执行后端，默认 `PIKA_SANDBOX_BACKEND` 或 `auto`     |
| `--exit-on-parent-stdin-close` | stdin 关闭时退出，供 launcher 使用                      |
| `-h`, `--help`                 | 打印用法                                                |

启动成功后打印实际监听地址。设置 `PIKA_SERVER_TOKEN` 时，所有 WebSocket 升级都必须携带匹配的 `?token=`，否则在读取任何 JSON-RPC 帧之前返回 401。

### 工具执行与沙箱后端

本地服务为每个会话注册六个内置工具：`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`bash`。文件路径统一经过 `PathPolicy`（以会话工作目录为根），子进程统一经过服务启动时选定的 sandbox executor；超过 `maxOutputBytes` 的工具结果写入 `<会话目录>/<sessionId>/outputs`。需要升级 sandbox 的调用会以审批请求的形式出现，可用 `/approve` 或 `/deny` 处理。

sandbox 后端在服务启动时选定一次，所有会话共用同一个 executor：

| 取值       | 行为                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| `auto`     | 默认值。macOS 使用 `seatbelt`，Linux 使用 `bwrap`；其他平台或都不可用时启动失败    |
| `seatbelt` | macOS 的 `sandbox-exec`，必须已安装                                                |
| `bwrap`    | Linux 的 bubblewrap，必须已安装                                                    |
| `docker`   | Docker CLI 与守护进程 socket，必须可用                                             |
| `none`     | 不做 OS 隔离，只保留进程内的 `PathPolicy` 与环境白名单；会削弱边界，仅用于本机调试 |

显式指定的后端不可用、或 `auto` 找不到任何隔离后端时，服务在开始监听前失败，而不是静默降级。

本地 TUI 模式（不带 `--url`）下服务由 launcher 拉起，launcher 不转发客户端参数，因此后端只能通过 `PIKA_SANDBOX_BACKEND` 选择；所有 `PIKA_*` 变量都会转给本地服务。远程模式（`--url` 或 `PIKA_SERVER_URL`）的后端由服务端运维方决定。

## 2. 模型目录

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

## 3. 命令

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

## 4. 界面状态

状态行始终显示：

```text
<running|settled> | <model> (<alias>) | <sandbox mode>/<network> | <session id> | <cwd>
```

transcript 中会标记 `[tool]`、`[turn <stopReason>]`、`[compact]`、`[approval ...]` 和 `[btw]`。切换会话时 transcript 清空并显示新会话行。

## 5. 范围

本版不提供 TUI 内的目录编辑、`/btw` 流式输出、会话中途热切换模型（切换总是 fork）、外部 handoff/导出、新的密钥存储，以及用户自定义命令。
