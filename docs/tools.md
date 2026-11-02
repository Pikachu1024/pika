# 工具契约

工具是声明式对象加执行函数。运行时从不直接调用工具；`ToolBatchExecutor` 负责预检整批调用、执行并归一化每个结果。

## 1. 契约

```ts
interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  concurrencyKey?(args: unknown): string | null;
  execute(context: ToolContext, args: unknown): Promise<ToolOutput>;
}

interface ToolContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  signal: AbortSignal;
  onUpdate(chunk: string): void;
}
```

`ToolOutput` 是 `{ content, isError, details?, fullOutputRef? }`，不包含 `toolCallId`；执行器会补上。

## 2. 执行流程

```text
tool_call_start
  tool_execution_start
  tool_execution_update*   由 ToolContext.onUpdate 触发
  tool_execution_end       归一化后的 ToolResult
```

每个调用依次处理：

1. 解析 JSON 参数并用 `tool.schema` 校验。JSON 非法、工具未知或校验失败时直接返回错误结果，不执行任何副作用。
2. 读取 `concurrencyKey(args)`。相同非空 key 的调用串行；`null` 的调用并行。结果始终按模型调用顺序返回。
3. 传入的 `ToolContext.signal` 是本轮的终止信号。工具抛错变成 `execution_error`；信号已中止时变成 `aborted`。
4. 合并文本内容；超过 `maxOutputBytes`（默认 1 MiB）时保留头尾片段。配置了 `ToolOutputStore` 时，完整文本会持久化，结果中带有标记与 `fullOutputRef`。

```ts
const executor = new ToolBatchExecutor(registry, {
  maxOutputBytes: 64 * 1024,
  outputStore: new FileToolOutputStore("/session/outputs"),
});
```

截断按 UTF-8 字节进行：头部约占 60%，尾部约占 40%，切割点不会落在多字节字符中间。

## 3. v0 工具集

| 工具 | 参数 | 强制执行点 |
| --- | --- | --- |
| `read_file` | `path`、`offset?`、`limit?`（行号从 1 开始） | `PathPolicy` 读取 |
| `write_file` | `path`、`content` | `PathPolicy` 写入 |
| `edit_file` | `path`、`oldText`、`newText`、`replaceAll?` | `PathPolicy` 写入 |
| `bash` | `command`、`timeoutMs?`（会被策略收紧） | sandbox `Executor` |
| `grep` | `pattern`、`path?`、`glob?`、`ignoreCase?` | 先过路径检查，再由 `Executor` 执行 |
| `glob` | `pattern`、`path?` | 先过路径检查，再由 `Executor` 执行 |

文件工具在授权前解析符号链接，因此指向工作区外的链接返回 `symlink-escape`，不会触碰目标文件。shell 与搜索工具不自行 spawn 进程，而是构造 `ExecRequest` 交给执行器；执行器构造白名单环境，并且不加载登录 shell 启动文件。

会修改文件的工具共享 `write:<绝对路径>` 并发 key。对同一目标的两个写入即使读取可以并行，也会串行执行。`edit_file` 在 `oldText` 匹配多次且未设置 `replaceAll` 时返回 `ambiguous_match`。

## 4. 示例

以下行为由 `packages/core/test/tool/file-tools.test.ts`、`packages/core/test/tool/shell-tools.test.ts` 与 `packages/adapters/test/tool/shell-tools.test.ts` 覆盖。

读取一段行范围：

```json
{ "path": "src/index.ts", "offset": 10, "limit": 20 }
```

写入并自动创建父目录：

```json
{ "path": "notes/summary.md", "content": "# Summary\n" }
```

替换唯一匹配；匹配不唯一时返回 `ambiguous_match`，除非 `replaceAll` 为 true：

```json
{ "path": "src/config.ts", "oldText": "port: 3000", "newText": "port: 4000" }
```

执行命令且不加载 rc 文件：

```json
{ "command": "echo first; sleep 0.05; echo second" }
```

只搜索 TypeScript 文件：

```json
{ "pattern": "needle", "glob": "*.ts" }
```

模式中包含 `/` 时，`glob` 从 `-name` 切换为 `-path` 片段匹配：

```json
{ "pattern": "src/**/*.ts" }
```

## 5. 终端结果

`bash`、`grep`、`glob` 在 `details` 中报告 `exitCode`、`signal`、`timedOut` 与 `truncated`。非零退出码通常是错误，但 `grep` 的退出码 1 表示“没有匹配”，不算失败。超时会终止整个进程组，后台子进程不会在调用结束后残留。

超大输出遵循执行器契约：模型收到头尾片段与持久化引用，`tool_execution_end` 携带同一个截断后的 `ToolResult`。
