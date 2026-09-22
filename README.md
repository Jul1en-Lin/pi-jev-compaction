# pi-jev-compaction

一个用于 [Pi](https://github.com/badlogic/pi-mono) 的扩展。在 Pi 执行原生上下文压缩前，调用
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)，筛选不再需要的工具调用和工具结果。

本项目是 **Pi 适配层**，不是对 Pi 原生压缩系统的替换。Jev 只负责判断哪些工具调用应保留、删除或截短；最终摘要、压缩节点、文件操作信息和近期上下文仍由 Pi 原生 `compact()` 生成和管理。

## 工作方式

手动执行 `/compact` 或 Pi 自动触发压缩时，流程如下：

```text
Pi 准备压缩
    ↓
session_before_compact
    ↓
Jev 检查符合条件的工具调用/结果对
    ├─ 成功：只替换 Pi 原生的待摘要消息数组
    │          ↓
    │       Pi 原生 compact()
    └─ 超时、报错或响应无效：保持原始数组不变
               ↓
            Pi 原生 compact()
```

适配层不会把 Jev 的简化 transcript 重新拼回 Pi，而是将 Jev 的决策映射回原始 Pi 消息。因此，Pi 的 thinking、图片、工具调用元数据和其他原生消息数据不会因为适配而被转换成普通文字。

适配层只会修改：

- `messagesToSummarize`
- `turnPrefixMessages`

以下字段仍完全由 Pi 管理，不会被本扩展修改：

- `firstKeptEntryId`
- `tokensBefore`
- `previousSummary`
- `fileOps`
- `settings`
- `isSplitTurn`

### 哪些内容可以被筛选

只有位于同一个原生压缩输入中的、成对且纯文本的工具调用和工具结果才会参与筛选。以下内容会保持不变：

- 用户消息和助手正文；
- thinking 块和图片内容；
- 包含图片的工具结果；
- 缺少对应调用或结果的消息；
- 重复 ID 的调用/结果；
- 跨越两个原生输入边界的调用/结果对；
- Pi 单独保留的近期消息区域；
- 没有有效调用对应的工具结果。

如果 Jev 返回 `drop_call`，扩展会删除调用及其对应结果。如果返回 `drop_result`，则保留调用，并将结果截短为前 300 个字符加上一条说明。处理完成后，Pi 仍会照常生成原生摘要。

## 兼容性

- Pi `0.85.1`
- Node.js `>=24`
- `fast-jev-compaction` `0.4.0`

扩展对 Pi 版本进行严格检查，因为当前适配依赖 Pi `0.85.1` 的 `session_before_compact` preparation 对象可变行为；这不是 Pi 正式承诺的“替换原生压缩输入”扩展接口。使用其他 Pi 版本时，扩展不会修改压缩输入，Pi 会安全地回退到原生压缩。

本项目不修改 Pi 源码，也不会自行调用 Pi 导出的 `compact()` 函数。

## 安装

从 GitHub 安装：

```sh
pi install git:github.com/Jul1en-Lin/pi-jev-compaction@main
```

也可以安装本地 checkout：

```sh
pi install /Users/lien/prj/pi-fast-jev-compaction
```

安装后重启 Pi。查看已安装包：

```sh
pi list
```

卸载 GitHub 版本：

```sh
pi remove git:github.com/Jul1en-Lin/pi-jev-compaction
```

## 配置

扩展通过上游包访问官方 TypeSafe Jev 服务。请在启动 Pi 的终端中配置 API Key：

```sh
export TYPESAFE_API_KEY='your-typesafe-key'
```

API Key 只在运行时读取，并只用于认证 Jev 请求；不会写入本项目、Pi settings、会话文件或扩展日志。请不要提交 API Key，也不要把它放进共享的 shell 历史记录。

发送给 Jev 的决策状态可能包含会话文本和工具输入，其中可能有源代码、文件路径、命令或其他敏感信息。只有在你接受这些信息发送到 TypeSafe 的情况下，才应使用本扩展。

### 超时配置

`PI_FAST_JEV_TIMEOUT_MS` 控制一次 Jev 尝试的总时限，默认值为 15 秒：

```sh
export PI_FAST_JEV_TIMEOUT_MS=15000
```

如果 API Key 缺失、Pi 版本不支持、Jev 超时、请求失败或响应无效，扩展会显示简短提示并保持原始压缩输入不变，然后由 Pi 执行普通原生压缩。扩展不会递归调用 `/compact`。

用户主动取消压缩时，取消信号会传递给 Jev，扩展不会替换或修改原生压缩输入。

## 开发

安装依赖：

```sh
npm install --ignore-scripts --no-audit --no-fund
```

执行检查：

```sh
npm run typecheck
npm test
```

测试使用注入的 Jev asker 和计时器，不会访问 TypeSafe，也不会调用主模型。测试覆盖消息映射、工具调用/结果配对、图片和 thinking 保留、两组压缩输入、超时、取消、原生回退和 Pi hook 行为。

构建：

```sh
npm run build
```

创建本地 npm 压缩包（不会发布）：

```sh
npm pack --ignore-scripts
```

## 致谢与署名

本适配层基于 [Tamara Tran](https://github.com/tamaratran) 的
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) 项目，感谢原作者提供 Jev 决策逻辑。

如果你认为本仓库包含侵犯你权利的内容，或署名信息需要修正，请在
[GitHub Issues](https://github.com/Jul1en-Lin/pi-jev-compaction/issues) 联系维护者。我们会审核请求，并在适当情况下删除或修订相关内容。

## 许可证

本适配层使用 MIT License。使用时也请查看上游
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) 项目的许可证和署名要求。

---

## English

# pi-jev-compaction

A [Pi](https://github.com/badlogic/pi-mono) extension that uses
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) to
prune stale tool calls immediately before Pi creates its native compaction
summary.

This package is a Pi adapter, not a replacement for Pi's compaction system.
Jev makes the keep/drop/truncate decisions; Pi still creates the summary,
compaction entry, file-operation details, and retained recent context.

## How it works

For both manual `/compact` and automatic compaction:

```text
Pi prepares a compaction
        |
        v
session_before_compact
        |
        v
Jev reviews eligible tool call/result pairs
        |
        +-- success --> replace only the two native message arrays
        |                 |
        |                 v
        |            Pi's native compact()
        |
        +-- timeout/error/invalid response --> leave preparation unchanged
                                              |
                                              v
                                         Pi's native compact()
```

The adapter preserves Pi's native messages instead of serializing Jev's
simplified transcript back into Pi. It only changes:

- `messagesToSummarize`
- `turnPrefixMessages`

All other compaction metadata remains owned by Pi, including
`firstKeptEntryId`, `tokensBefore`, `previousSummary`, `fileOps`, `settings`,
and `isSplitTurn`.

### What Jev can change

Only a paired, text-only tool call and tool result within the same native
compaction input are eligible. The adapter leaves these untouched:

- user and assistant prose;
- thinking blocks and image content;
- image-bearing tool results;
- incomplete or duplicate call/result pairs;
- pairs crossing the two native input boundaries;
- Pi's separately retained recent region;
- tool results without a valid matching call.

A `drop_call` decision removes the call and its paired result. A
`drop_result` decision keeps the call and truncates the result using the
upstream default of 300 head characters plus a note. Pi then summarizes the
filtered native messages normally.

## Compatibility

- Pi `0.85.1`
- Node.js `>=24`
- `fast-jev-compaction` `0.4.0`

The extension intentionally has a strict Pi `0.85.1` guard. The adapter relies
on the mutable `session_before_compact` preparation object used by that Pi
release; this is not currently a formal extension API for replacing the
native preparation arrays. On another Pi version, the extension does not
modify the preparation and Pi falls back to ordinary native compaction.

This package does not modify Pi's source code or call Pi's exported
`compact()` function itself.

## Installation

Install from the GitHub repository:

```sh
pi install git:github.com/Jul1en-Lin/pi-jev-compaction@main
```

Or install the current checkout for local development:

```sh
pi install /Users/lien/prj/pi-fast-jev-compaction
```

Restart Pi after installation. Check the installed packages with:

```sh
pi list
```

To remove the GitHub installation:

```sh
pi remove git:github.com/Jul1en-Lin/pi-jev-compaction
```

## Configuration

The extension uses the official TypeSafe Jev endpoint through the upstream
package. Configure the key in the environment of the terminal that starts
Pi:

```sh
export TYPESAFE_API_KEY='your-typesafe-key'
```

The key is read at runtime, sent only in the authenticated Jev request, and
never written to the package, Pi settings, session files, or extension logs.
Do not commit it or paste it into a shared shell history.

The complete Jev decision state can contain conversation text and tool input,
which may include source code, file paths, commands, or other sensitive data.
Use this extension only when sending that information to TypeSafe is
acceptable.

### Timeout

`PI_FAST_JEV_TIMEOUT_MS` controls the whole Jev attempt and defaults to
15,000 milliseconds:

```sh
export PI_FAST_JEV_TIMEOUT_MS=15000
```

If the key is missing, Pi is an unsupported version, Jev times out, the
request fails, or the response is invalid, the adapter prints a short warning
and leaves the original preparation untouched. Pi then performs its ordinary
native compaction. It does not invoke `/compact` recursively.

A user cancellation is passed through to the Jev request and does not replace
or modify the native preparation.

## Notices in Pi

Normal path:

```text
[jev] 21 call(s) reviewed: dropped 18, shortened 0 · 955ms; Pi will create the native summary.
```

No useful changes:

```text
[jev] 12 call(s) reviewed: nothing dropped · 301ms; Pi will create the native summary.
```

Fallback examples:

```text
[jev] skipped: TYPESAFE_API_KEY is not set; using Pi's native compaction.
[jev] timed out after 15000ms · 15.0s; using Pi's native compaction.
[jev] failed · 802ms; using Pi's native compaction.
```

These notices are transient TUI notifications. The extension does not write
request content or API errors to disk.

## Development

Install dependencies without running lifecycle scripts:

```sh
npm install --ignore-scripts --no-audit --no-fund
```

Run the checks:

```sh
npm run typecheck
npm test
```

The tests use injected Jev askers and timers. They do not call TypeSafe or a
main model. The test suite covers message mapping, tool-call/result pairing,
image and thinking preservation, split preparation inputs, timeout and
cancellation, native fallback, and Pi hook behavior.

Build the package:

```sh
npm run build
```

Create a local npm tarball without publishing it:

```sh
npm pack --ignore-scripts
```

## Project layout

```text
extensions/fast-jev-compaction.ts  Pi lifecycle hook
src/adapter.ts                     Jev transport and native-message adapter
test/                              Offline tests
package.json                       Pi package manifest and pinned dependency
```

## Acknowledgements and attribution

This adapter is built on and gratefully acknowledges
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) by
[Tamara Tran](https://github.com/tamaratran). The upstream project provides
the Jev decision logic that this Pi adapter integrates with native Pi
compaction.

If you believe this repository contains material that infringes your rights,
or if attribution needs to be corrected, please contact the maintainer by
opening an issue at
[github.com/Jul1en-Lin/pi-jev-compaction/issues](https://github.com/Jul1en-Lin/pi-jev-compaction/issues).
We will review the request and remove or revise the affected material where
appropriate.

## License

This adapter is licensed under the MIT License. Please also review the
upstream project's license and attribution:
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
