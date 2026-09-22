# pi-jev-compaction

一个用于 [Pi](https://github.com/badlogic/pi-mono) 的扩展。在 Pi 执行原生上下文压缩前，调用
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)，筛选不再需要的工具调用和工具结果。

本项目是 **Pi 适配层**，不是对 Pi 原生压缩系统的替换。Jev 只负责判断哪些工具调用应保留、删除或截短；最终摘要、压缩节点、文件操作信息和近期上下文仍由 Pi 原生 `compact()` 生成和管理。

## 视频演示

<video controls width="640" src="./assets/tamarajtran-jev-compaction.mp4">
  Your browser does not support the video tag.
</video>

视频来源：[Tamara Tran 在 X 发布的视频](https://x.com/tamarajtran/status/2100694549362553153)。视频文件仅作为项目演示素材保留，版权归原作者所有。

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

English version: [README.en.md](README.en.md)
