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

| 参数                           | 说明                                                       |
| ------------------------------ | ---------------------------------------------------------- |
| `--port <n>`                   | 监听端口，`0` 表示系统分配；默认 `PIKA_PORT` 或 `7331`     |
| `--host <addr>`                | 监听地址，默认 `PIKA_HOST` 或 `127.0.0.1`                  |
| `--dir <path>`                 | 会话目录，默认 `PIKA_SESSION_DIR` 或 `$PIKA_HOME/sessions` |
| `--sandbox-backend <backend>`  | 工具执行后端，默认 `PIKA_SANDBOX_BACKEND` 或 `auto`        |
| `--exit-on-parent-stdin-close` | stdin 关闭时退出，供 launcher 使用                         |
| `-h`, `--help`                 | 打印用法                                                   |

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

## 2. Pika home 与模型目录

所有用户级状态默认位于 Pika home：`$PIKA_HOME`，未设置时为 `~/.pika`。

| 内容           | 默认位置                      | 覆盖方式                                 |
| -------------- | ----------------------------- | ---------------------------------------- |
| 会话           | `$PIKA_HOME/sessions`         | `PIKA_SESSION_DIR` 或 `pika serve --dir` |
| 用户级模型目录 | `$PIKA_HOME/models.json`      | `PIKA_CONFIG_DIR`                        |
| 凭据           | `$PIKA_HOME/credentials.json` | `PIKA_CONFIG_DIR`                        |

`PIKA_HOME` 会传入 launcher 启动的本地服务，因此客户端和服务端使用同一个 home。旧版本的用户配置位于 `$XDG_CONFIG_HOME/pika`（默认 `~/.config/pika`）；启动时如果新的目标文件不存在，客户端会把 `models.json` 和 `credentials.json` 复制到 home 目录一次。已存在的目标文件不会被覆盖，旧文件保留，复制失败只打印 `[config]` 警告，不阻止启动。设置 `PIKA_CONFIG_DIR` 时不执行迁移。

客户端同时读取用户级目录和项目级目录：

| 来源   | 路径                                                                        |
| ------ | --------------------------------------------------------------------------- |
| 用户级 | `${PIKA_CONFIG_DIR:-$PIKA_HOME}/models.json`（`PIKA_HOME` 默认 `~/.pika`）  |
| 项目级 | `PIKA_MODELS_FILE`（相对路径按 `cwd` 解析），否则 `<cwd>/.pika/models.json` |

用户级目录适合放个人常用端点，不应提交到仓库；项目级目录用于随项目共享的端点。两者都不存在时不会报错，此时只保留 `PIKA_LLM_*` 或 `--llm-*` 提供的隐式 `env` 预设。

合并规则：先加载用户级预设，再按别名用项目级预设覆盖同名项，其余项目级预设追加在后面。项目级目录的 `default` 优先于用户级目录的 `default`。任一文件无法读取、JSON 非法或不符合 schema 时，客户端只报告该文件的路径和原因，另一个目录仍然生效。

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
      "maxTokens": 4096,
      "tools": false
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
- `tools`：可选布尔值，默认 `true`。设为 `false` 时不向该端点声明任何内置工具，适用于不接受 `tools` 字段的服务端。
- `default`：可选，必须指向已定义的别名。

### 密钥与凭据

`/connect` 保存的密钥单独存放在同一配置目录的 `credentials.json`（目录 `0700`、文件 `0600`，原子替换），不写入 `models.json`。密钥解析优先级：

1. 预设 `apiKeyEnv` 命名的环境变量；
2. 否则 `credentials.json` 中该别名的值；
3. 都没有时，若预设声明了 `apiKeyEnv` 则命令失败并只报告变量名；未声明则不带密钥连接。

`/config` 对每个预设只显示环境变量是 `set` 还是 `missing`、凭据是 `set` 还是 `missing`，不会打印密钥。目录和凭据错误也不会回显文件内容。

启动时的模型优先级：

1. 存在 `PIKA_LLM_*` 或 `--llm-*` 时，使用隐式 `env` 预设；
2. 否则使用合并后的 `default`；
3. 否则使用第一个预设；
4. 都没有时使用服务端默认模型，并在启动时提示运行 `/connect`。

`PIKA_MODELS_FILE` 指定的目录与隐式 `env` 预设可以同时存在，`/models` 会把 `env` 排在列表首位。

## 3. 命令

| 命令                                                                      | 说明                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `/help`                                                                   | 列出命令和参数提示                                         |
| `/models`                                                                 | 列出预设，`*` 标记当前模型，显示来源、密钥变量名和工具开关 |
| `/model [alias]`                                                          | 在会话头部 fork 到新会话并切换预设；无参数时弹出选择列表   |
| `/connect`                                                                | 交互式添加或更新用户级 LLM 端点，并新建会话试用            |
| `/config`                                                                 | 显示两个目录路径、当前默认预设、来源和密钥是否存在         |
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

### 在 TUI 内配置端点

`/connect` 依次询问：

1. 服务端类型（当前只有 OpenAI 兼容端点）；
2. Base URL（必填，必须是 `http://` 或 `https://`）；
3. 模型 id（必填）；
4. 别名（默认等于模型 id，`env` 为保留名）；
5. API key（屏蔽输入，回显为 `*`；可直接回车跳过）；
6. 可选的 context window 和 max output tokens（正整数，回车跳过）；
7. 是否启用工具调用（默认启用）。

保存时把端点写入用户级 `models.json` 并设为 `default`，密钥写入同目录的 `credentials.json`；同名别名会被覆盖。随后重新加载两个目录，用新端点**新建**一个会话（不会热切换当前会话），并提示是否立即用 `/btw ping` 做一次不带工具的连通性检查。检查失败不影响已保存的预设。

`/connect` 要求在会话 settled 时运行；运行中的回合会被拒绝。工具调用关闭时，新会话的请求不会声明任何内置工具，`/status` 仍显示会话与沙箱信息。

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

本版不提供任意目录的往返编辑界面、`/btw` 流式输出、会话中途热切换模型（切换总是 fork）、外部 handoff/导出，以及用户自定义命令。`/connect` 只管理用户级目录，项目级目录仍通过文件维护。
