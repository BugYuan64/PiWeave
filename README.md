# PiWeave

使用 TypeScript 编写的本地 CLI 编排实验：Orchestrator 依次调用独立的 Pi SDK Writer 与 Reviewer 会话，传递草稿和审查意见，并控制最多一次返修。

## 当前状态

源码已包含执行器类型契约、Pi SDK 会话适配器、审查 JSON 校验、顺序编排与 CLI。2026-10-20 本地验证：类型检查通过、39 项离线测试通过、构建通过。真实 Provider 认证与模型调用尚未验收，因此不能据此认定 Pi 已接通。

当前仓库独立于历史 AgentForge Python 项目。两份设计文档保留了迁移背景；其中引用的旧 Python 文件不包含在此仓库中。

## 技术栈与环境

- 推荐 Node.js 24.x；当前 SDK 要求 Node.js >=22.19.0。
- TypeScript、ESM、NodeNext、strict。
- Pi SDK `@earendil-works/pi-coding-agent` 1.3.0。
- npm、tsx、Node 内置测试运行器。

依赖版本通过 `package-lock.json` 固定；不依赖全局安装的 Pi CLI。

## 安装与验证

```powershell
npm ci
npm run check
npm test
npm run build
```

## 配置与启动

先通过 Pi SDK 支持的认证来源配置目标 Provider 的凭据。凭据保存在本机环境或 Pi 私有配置中，不提交到 Git。选择模型时可使用 Pi 已配置的默认值，或在启动前设置以下非秘密参数：

```powershell
$env:PIWEAVE_PROVIDER = "<provider-id>"
$env:PIWEAVE_MODEL = "<model-id>"
npm run dev -- run "解释 Orchestrator 与执行器的区别，并举例"
```

构建后的正式入口：

```powershell
npm start -- run "解释 Orchestrator 与执行器的区别，并举例"
```

进度写入 stderr，最终结果以单个 JSON 写入 stdout。直接通过调用两个角色；一次返修最多调用四次。默认单次调用 60 秒、总时间 240 秒。退出码依次为：完成 `0`、审查失败 `1`、执行失败 `2`、超时 `124`、取消 `130`，参数错误为 `64`。

`verify:sdk` 当前引用的独立脚本尚未提供，不能作为可用验证入口。真实模型连通与完整角色演示仍待完成。

## 目录

```text
src/orchestration/
  model.ts       请求、执行器接口、审查与运行结果
  executor.ts    Pi SDK 受控会话、输出检查、超时与清理
  prompts.ts     角色提示、请求拼装、审查 JSON 校验
  service.ts     顺序调用、一次返修与停止条件
  cli.ts         命令行输入、进度、结果与退出码
tests/           编排、执行器和 CLI 的离线测试及替身
项目最终架构.md    目标架构与原设计依据
阶段步骤实现.md    原实施顺序与验收条件
```

`node_modules/`、`dist/`、环境凭据文件及本地过程记录均排除在版本控制外；构建产物可用上述命令重建。Web、HTTP API、数据库、并行编排与恢复均属于后续规划。
