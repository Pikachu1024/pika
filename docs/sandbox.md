# Sandbox

沙箱是本项目的强制执行边界。审批只是交互层，用于在策略拒绝后询问用户；真正的隔离由 `Executor` 和 `PathPolicy` 完成。任何工具都不能绕过这两条路径直接访问进程或文件。

## 1. 威胁模型

沙箱要防的是：

- 模型生成错误的命令，例如写到工作区外、读取凭据、访问网络。
- 间接提示注入诱导工具执行危险操作。
- 工具参数中的 `..`、绝对路径、符号链接逃逸。
- 子进程继承凭据或加载登录 shell 启动文件。
- 失控进程长期占用资源。

沙箱**不**承诺：

- 防御内核或 hypervisor 漏洞、Seatbelt/bubblewrap/Docker 自身的逃逸漏洞。
- 防御同一用户下、不经过 harness 的其他进程。
- 阻止用户在审批时主动放行的危险操作。
- 隐藏侧信道（CPU、时间、磁盘占用）。

因此策略默认收紧，升级必须是一次显式的、可审计的用户决策。

## 2. 策略模型

`SandboxPolicy` 定义在 `packages/schema/src/sandbox.ts`，由 `resolveSandboxPolicy` 解析和规范化：

```ts
{
  mode: "read-only" | "workspace-write" | "danger-full-access";
  workspaceRoot: string;
  writableRoots: string[];
  deniedReads: string[];
  network: "none" | "proxy" | "full";
  envAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}
```

### 2.1 文件模式

| 模式                 | 可读       | 可写               | 子进程               |
| -------------------- | ---------- | ------------------ | -------------------- |
| `read-only`          | 工作区内   | 无                 | 拒绝任意进程工具     |
| `workspace-write`    | 工作区内   | 工作区与嵌套可写根 | 允许，受 OS 沙箱约束 |
| `danger-full-access` | 全文件系统 | 全文件系统         | 允许                 |

- `read-only` 声明 `writableRoots` 会直接报错，而不是静默丢弃。
- `workspace-write` 的额外可写根必须解析到工作区内部。
- `danger-full-access` 的可写根是文件系统根。
- `deniedReads` 在所有模式下都生效；`danger-full-access` 也不能读取被显式拒绝的路径。

### 2.2 网络

| 值      | 含义                                                |
| ------- | --------------------------------------------------- |
| `none`  | 禁止网络                                            |
| `proxy` | 只允许访问本地代理；代理按目标 allowlist 转发并记录 |
| `full`  | 不限制网络                                          |

代理接口由 `startNetworkProxy` 提供：它同时处理 `CONNECT` 和绝对 URL 的 HTTP 请求，记录每个目标的 `host`、`port`、`allowed`、`reason`、`timestamp`。allowlist 支持精确主机和 `*.example.com` 通配后缀。

当前接入情况：

- Seatbelt 的 `proxy` 只放行到 `localhost`，由代理执行目标过滤。
- bubblewrap 和 Docker 尚未实现把代理路由进命名空间/容器，因此 `proxy` 与 `none` 一样**失败关闭**，不会暴露宿主网络。

### 2.3 环境与资源

- 子进程只拿到 `envAllowlist` 中的变量，默认 `PATH`、`HOME`、`LANG`、`TERM`。
- 即使某个名字被 allowlist，形如 `API_KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`AUTH` 的变量仍会被丢弃。
- 子进程从不继承 `process.env`，也不加载登录 shell 或 rc 文件。
- `timeoutMs` 到期后先向整个进程组发 `SIGTERM`，宽限期后发 `SIGKILL`。
- `maxOutputBytes` 是 stdout 与 stderr 的共享上限。

### 2.4 子任务策略单调性

`clampSandboxPolicy(parent, requested)` 保证子任务不能比父任务更宽：

- 模式、网络只能相同或更窄。
- 可写根必须落在父策略的可写根内。
- `deniedReads` 只增不减。
- `envAllowlist` 取交集。
- `timeoutMs`、`maxOutputBytes` 取较小值。

每次收紧都会返回一条 `violations` 说明，便于审计。

## 3. 路径策略

进程内文件工具（`read_file`、`write_file`、`edit_file`）不 spawn 子进程，由 `PathPolicy` 直接授权：

1. 拒绝空路径和包含 NUL 的路径。
2. 相对路径以工作区根解析。
3. 解析符号链接后再比较，返回的规范路径供后续读写使用，关闭 check/use 间隙。
4. 不存在的叶子路径会先解析最近的已存在祖先，再拼回剩余段，因此计划写入也能提前授权。
5. 拒绝路径优先于 `danger-full-access` 的放行。

错误码：

| code                | 场景                         |
| ------------------- | ---------------------------- |
| `read-only`         | 只读模式下尝试写入           |
| `outside-workspace` | 读取或写入越界               |
| `denied-read`       | 命中 `deniedReads`           |
| `symlink-escape`    | 请求路径经符号链接改写后越界 |
| `invalid-path`      | 空路径、NUL、无法解析的路径  |

## 4. 审批与升级

### 4.1 审批模式

| 模式         | 行为                                             |
| ------------ | ------------------------------------------------ |
| `untrusted`  | 写入和任意进程工具在预检阶段直接拒绝，不自动升级 |
| `on-failure` | 后端报告拒绝后请求升级                           |
| `on-request` | 默认值；策略拒绝或后端拒绝后请求升级             |
| `never`      | 永不提示，升级按拒绝处理                         |

### 4.2 预算阶段

`ToolBatchExecutor` 在执行前用 `classifyToolCall` 判定：

```text
danger-full-access ──> allow
read-only:
  write tool          ──> deny（升级轴：filesystem）
  arbitrary process   ──> deny（升级轴：process）
  其他工具            ──> allow
workspace-write:
  approvalMode=untrusted 且 write/process ──> deny（不升级）
  其他                                     ──> allow
```

工具通过 `Tool.sandbox` 声明 `{ write, arbitraryProcess }`。未声明的工具按 `false/false` 处理。

### 4.3 升级流程

```text
tool call
   |
   v
classifyToolCall
   | allow --------------------------> execute
   | deny
   v
sandbox_decision(outcome=deny)
   |
   v
approval_requested(kind=sandbox-escalation)
   |
   +-- deny / 无处理器 --> sandbox_denied 结果，策略不变
   |
   +-- approve ---------> 仅本次调用使用放宽后的策略
   |
   +-- approve_for_session --> setPolicy 持久化放宽后的策略
                                |
                                v
                         sandbox_decision(outcome=allow)
                                |
                                v
                             execute
```

放宽始终是最小的一步：

- 文件/进程：模式升一级；`read-only` 升到 `workspace-write` 时把 `workspaceRoot` 加入可写根。
- 网络：`none` → `proxy` → `full`。

后端拒绝（例如 Seatbelt 返回 `operation not permitted`）也走同一流程：工具把 `ExecResult.denied` 映射为拒绝事件，请求审批，然后用放宽后的策略重试一次。`classifyDenialReason` 根据错误文本判断升级轴，无法识别时按 `filesystem` 处理。

### 4.4 审计事件

```ts
type SandboxDecision = {
  toolCallId?: string;
  backend: "none" | "seatbelt" | "bwrap" | "docker";
  mode: "read-only" | "workspace-write" | "danger-full-access";
  outcome: "allow" | "deny";
  reason: string;
};
```

- 预检允许/拒绝都会写入 `sandbox_decision`。
- 升级会留下 `deny` 和后续的 `allow` 两条记录。
- 事件进入 JSONL 会话日志，replay 时保持相同的 `outcome` 与 `reason`。

没有配置 sandbox 时，运行时不会分类工具调用，也不会发出这些事件。

## 5. 后端矩阵

| 后端       | 平台              | 文件系统             | 网络                    | 进程                          | 说明                                               |
| ---------- | ----------------- | -------------------- | ----------------------- | ----------------------------- | -------------------------------------------------- |
| `none`     | 任意              | 无 OS 隔离           | 无隔离                  | 无隔离                        | 仅环境过滤、超时、输出上限；用于测试或明确禁用沙箱 |
| `seatbelt` | macOS             | Seatbelt profile     | `none`/`proxy`/`full`   | `process-exec`/`process-fork` | 通过 `/usr/bin/sandbox-exec` 执行                  |
| `bwrap`    | Linux             | 只读根 + 可写绑定    | `none`/`proxy` 失败关闭 | PID/UTS/IPC 命名空间          | 需要非特权用户命名空间                             |
| `docker`   | 任意（需 daemon） | 只挂载工作区与可写根 | `none`/`proxy` 失败关闭 | 容器 + `--init`               | `--cap-drop ALL`、`no-new-privileges`              |

### 5.1 Seatbelt

生成的 profile 默认拒绝，然后按策略放行：

- `(allow process-exec)`、`(allow process-fork)`。
- `(allow file-read*)`；`deniedReads` 以 `(deny file-read* (subpath ...))` 覆盖。
- 可写根、`/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`、`/dev/fd`。
- `none`：`(deny network*)`；`proxy`：只放行 `localhost`；`full`：`(allow network*)`。

根路径在生成 profile 前会 `realpath`，因为 macOS 上 `/tmp` 实际是 `/private/tmp`。由于 Seatbelt v1 的读限制会阻断 shell 启动，profile 对读取采用“全局允许 + 敏感路径拒绝”；进程内文件工具仍由 `PathPolicy` 严格限制。

### 5.2 bubblewrap

- 以只读方式绑定整个根文件系统，`/dev`、`/proc`、`/tmp` 单独挂载。
- 工作区与可写根重新绑定为可写。
- `deniedReads` 用空的 `--tmpfs`（目录）或 `/dev/null` 只读绑定（文件）遮蔽。
- `network` 不为 `full` 时 `--unshare-net`。
- `danger-full-access` 使用 `--dev-bind / /`。

### 5.3 Docker

- `--rm --init --cap-drop ALL --security-opt no-new-privileges`。
- 工作区按模式以 `ro` 或 `rw` 挂载；额外可写根以 `rw` 挂载。
- 未挂载的路径（包括 `deniedReads`）在容器内不可见，由缺失本身完成隔离。
- 仅转发 allowlist 中的环境变量名；容器内不继承宿主环境。
- `network` 不为 `full` 时 `--network none`。
- 默认镜像 `debian:bookworm-slim`，可通过 `DockerExecutorOptions.image` 覆盖。

## 6. 一致性测试

共享用例位于 `packages/adapters/test/sandbox/conformance.ts`，每个后端注册同一套断言：

| 用例           | 断言                        |
| -------------- | --------------------------- |
| 工作区内写入   | 成功且无 `denied`           |
| 工作区外写入   | 失败或文件不存在            |
| 读取拒绝路径   | 失败且不输出敏感内容        |
| `..` 穿越      | 失败且不输出敏感内容        |
| 符号链接逃逸   | 失败且不输出敏感内容        |
| 网络拒绝       | 退出码非 0 且 `denied` 有值 |
| 子进程继承限制 | 子 shell 仍被拒绝           |
| 环境清理       | 泄漏变量缺失，允许变量保留  |
| 只读模式写入   | 失败                        |
| 超时清理进程组 | `timedOut` 且后台进程已消失 |

运行：

```bash
# 本机可用的后端；不可用的后端跳过
pnpm vitest run packages/adapters/test/sandbox

# 要求所有适用后端必须存在；CI 使用
pnpm test:sandbox
```

`pnpm test:sandbox` 设置 `PIKA_REQUIRE_SANDBOX_BACKENDS=1`：在 macOS 要求 Seatbelt，在 Linux 要求 bubblewrap，并且始终要求 Docker CLI 与 daemon。CI 会安装 bubblewrap、放开 Ubuntu 24.04 的非特权用户命名空间限制，并拉取 `debian:bookworm-slim`。

Docker 后端暂不支持自动清理超时后遗留的容器，因此用例标记为跳过；Seatbelt 和 bubblewrap 覆盖该用例。

## 7. 已知限制

- bubblewrap 和 Docker 的 `proxy` 模式尚未路由到本地代理，当前按 `none` 失败关闭。
- Docker 后端不单独挂载 `deniedReads`，依赖“未挂载即不可见”。
- Seatbelt 的读取限制是全局允许加减去敏感路径，不提供逐路径白名单。
- `danger-full-access` 完全绕过 OS 隔离，仅保留环境过滤和审计。
- Docker 超时杀死的只是 CLI 客户端，容器清理尚未自动化。
