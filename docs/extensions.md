# Skills 与 MCP

本文描述 `packages/adapters` 中的两项外部能力接入：Agent Skills 的发现与懒加载，以及 MCP server 的生命周期管理。配置示例由 `packages/adapters/test/skills/discovery.test.ts`、`packages/adapters/test/mcp/config.test.ts` 和 `packages/adapters/test/mcp/manager.test.ts` 验证。

两项能力都不改运行时主循环：Skills 通过系统提示中的索引加一个 `load_skill` 工具接入；MCP 通过把远端工具适配为普通 `Tool` 接入。

## 1. Agent Skills

### 1.1 目录约定

```text
<scope-root>/
  review/
    SKILL.md
  format/
    SKILL.md
```

也可以把单个技能直接放在 root 下：`<scope-root>/SKILL.md`，名称取目录名。

`SKILL.md` 使用 YAML 风格 frontmatter，只读取 `name` 和 `description`：

```markdown
---

name: review
description: Review a diff for correctness and security issues.
---

Read the diff, list blocking issues first, then optional improvements.
```

`name` 缺省时使用目录名；`description` 支持单行、引号包裹和 `|` / `>` 折叠写法。

### 1.2 Scope 与优先级

| Scope     | 用途                 |
| --------- | -------------------- |
| `builtin` | 随 harness 分发      |
| `plugin`  | 插件附带             |
| `user`    | 用户全局配置         |
| `project` | 当前项目，优先级最高 |

同名技能按 `builtin < plugin < user < project` 覆盖。同一 scope 内后配置的 root 覆盖先配置的 root。

### 1.3 提示索引与懒加载

发现阶段只读取 frontmatter，不把正文放进上下文。`catalog.index()` 返回 `{ name, description }`，传给 `createPromptBuilder()` 的 `skillIndex`，渲染为：

```text
- review: Review a diff for correctness and security issues.
```

模型需要某个技能时调用 `load_skill`，工具才读取正文并作为工具结果返回。未命中的名称返回 `isError: true`，不会静默成功。

```ts
import { createLoadSkillTool, FileSystemSkillCatalog } from "@pika-harness/adapters";

const skills = await FileSystemSkillCatalog.create({
  builtin: ["/opt/pika/skills"],
  user: [`${home}/.pika/skills`],
  project: [`${workspace}/.pika/skills`],
  plugin: pluginSkillRoots,
});

const promptSections = [
  {
    name: "skillIndex",
    content: skills
      .index()
      .map(({ name, description }) => `- ${name}: ${description}`)
      .join("\n"),
  },
];

registry.register(createLoadSkillTool(skills));
```

`SkillCatalog` 是接口；测试或远程技能源可以实现 `list()`、`index()`、`load(name)`，不要求使用文件系统。

## 2. MCP

### 2.1 配置格式

配置通过 `parseMcpConfig()` 校验。以下示例与 `packages/adapters/test/mcp/config.test.ts` 中的 `documentedConfig` 一致：

```json
{
  "servers": [
    {
      "name": "filesystem",
      "scope": "user",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "envAllowlist": ["PATH", "HOME"],
      "allow": ["read_*"],
      "deny": ["write_*"]
    },
    {
      "name": "github",
      "scope": "project",
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "oauth": true,
      "headers": { "X-Trace": "pika" }
    }
  ]
}
```

字段：

| 字段           | 适用传输 | 说明                                                     |
| -------------- | -------- | -------------------------------------------------------- |
| `name`         | 全部     | 字母、数字、`_`、`-`；用作工具命名空间                   |
| `scope`        | 全部     | `user`（默认）或 `project`                               |
| `allow`        | 全部     | glob 白名单，匹配原始工具名或命名空间名                  |
| `deny`         | 全部     | glob 黑名单，优先级高于 `allow`                          |
| `command`      | stdio    | 可执行文件                                               |
| `args`         | stdio    | 参数数组                                                 |
| `cwd`          | stdio    | 子进程工作目录                                           |
| `env`          | stdio    | 显式环境变量值                                           |
| `envAllowlist` | stdio    | 从宿主环境转发的变量名                                   |
| `url`          | http     | Streamable HTTP 端点                                     |
| `headers`      | http     | 额外请求头                                               |
| `oauth`        | http     | 为 `true` 时必须注入 `OAuthClientProvider`，否则启动失败 |

### 2.2 环境与 OAuth 边界

- stdio server 不继承 `process.env`。默认只转发 `PATH`、`HOME`、`LANG`、`TERM`；可通过 `envAllowlist` 收窄或扩展，`env` 中的显式值最后合并。
- 名字类似 API key、token、secret、password 的变量即使被 allowlist 命中也会丢弃。server 的 stderr 不会被转发，避免凭据进入日志。
- HTTP server 设置 `oauth: true` 时，通过 `createMcpManager({ oauthProvider })` 注入 SDK 的 `OAuthClientProvider`；缺失时连接直接失败，不会降级为匿名请求。

### 2.3 项目信任

`scope: "project"` 的 server 在项目被信任前不会启动，也不会暴露任何工具：

```ts
const manager = createMcpManager({
  servers: parseMcpConfig(document).servers,
  projectTrusted: await trustStore.isTrusted(workspace),
  oauthProvider,
});
```

未信任时状态为 `blocked`，`error` 为 `project is not trusted`，连接工厂不会被调用。

### 2.4 命名空间与过滤

工具注册名为 `mcp__<server>__<tool>`，例如 `mcp__filesystem__read_file`。`allow` / `deny` 同时匹配原始名和命名空间名；`deny` 优先。被过滤的工具不会出现在 `manager.tools()`、`createTools()` 或 provider 工具列表中。

MCP 原始 `inputSchema` 通过 `Tool.parameters` 原样暴露给模型，不经过 Zod 重建。`readOnlyHint: true` 的工具按只读分类；缺少该提示的工具按写操作处理，在不受信任会话中需要审批。

### 2.5 生命周期

```ts
const manager = createMcpManager({
  servers,
  projectTrusted,
  connectTimeoutMs: 10_000,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, factor: 2 },
});

await manager.start();
for (const tool of manager.createTools()) registry.register(tool);

// 退出前
await manager.close();
```

- `start()` 逐个连接并拉取 `tools/list`，支持分页；单个 server 失败只把该 server 标记为 `unavailable`，不影响会话和其他 server。
- 连接关闭或报错时，该 server 的工具立即从 `manager.tools()` 移除，已注册的适配工具返回 `isError: true` 的工具结果，而不是抛出到运行时。
- 自动重连使用指数退避；成功后重新拉取工具。也可以调用 `await manager.reconnect("filesystem")` 立即重试。
- `tools/list_changed` 通知触发重新发现，无需重启会话；`manager.refresh()` 可手动刷新。
- 状态取值：`starting`、`ready`、`unavailable`、`blocked`、`stopped`。

### 2.6 自定义连接

`createMcpManager` 接受 `connectionFactory`，实现 `(context) => Promise<McpConnection>` 即可替换传输。测试使用官方 SDK 的 `InMemoryTransport` 和低层 `Server` 覆盖崩溃、重连和工具列表变更，不启动真实子进程。

## 3. 验证

```bash
bun test packages/adapters/test/skills packages/adapters/test/mcp
bun run --filter @pika-harness/adapters typecheck
bun run boundary
```

覆盖点：

- 四个 scope 的发现与覆盖顺序、提示索引不含正文、懒加载正文、未知技能报错。
- 文档配置可解析、非法名称被拒绝、allow/deny/命名空间匹配、`deny` 优先。
- 未信任项目不启动连接；工具命名空间正确；工具调用结果映射。
- 崩溃后工具不可用、自动与手动重连、`tools/list_changed` 刷新。
