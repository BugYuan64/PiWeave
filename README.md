# PiWeave

使用 TypeScript 编写的本地 CLI 编排实验：Orchestrator 依次调用独立的 Pi SDK Writer 与 Reviewer 会话，传递草稿和审查意见，并控制最多一次返修。

## 当前状态

源码已包含执行器类型契约、Pi SDK 会话适配器、审查 JSON 校验、顺序编排与 CLI。2026-10-20 本地验证：类型检查通过、48 项离线测试通过、构建通过；`npm run verify:sdk` 与 `npm start` 均通过本地 HTTP 端点完成真实 Writer/Reviewer 调用（`completed`，退出码 0）。模型访问不经过 Pi 的 OAuth 登录。

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

PiWeave 只通过一个 OpenAI 兼容的 HTTP 端点访问模型，不使用 Pi 的 OAuth 登录、订阅凭据或用户级 `models.json`。

端点、API Key 和模型 ID **都不写在源码里**，全部来自运行时环境。仓库只提交不含真实值的 [`.env.example`](.env.example)：

```powershell
Copy-Item .env.example .env    # 再填入你的端点、Key 和模型
```

`.env` 已由 `.gitignore` 排除，不会进入版本库。启动时 `main()` 读取工作目录下的 `.env`（[`env.ts`](src/orchestration/env.ts)）；真实环境变量优先级更高，会覆盖同名的 `.env` 值。缺少任何一项时程序直接报出缺的变量名，不会静默使用默认值：

| 变量 | 含义 |
|---|---|
| `PIWEAVE_BASE_URL` | OpenAI 兼容端点，必须以 `http://` 或 `https://` 开头 |
| `PIWEAVE_API_KEY` | 该端点的 API Key |
| `PIWEAVE_MODEL` | 模型 ID |

也可以在启动前用环境变量临时指定，同样不需要改代码：

```powershell
$env:PIWEAVE_BASE_URL = "https://your-endpoint.example/v1"
$env:PIWEAVE_API_KEY  = "your-api-key"
$env:PIWEAVE_MODEL    = "your-model-id"
npm run dev -- run "解释 Orchestrator 与执行器的区别，并举例"
```

启动时该端点以 `piweave-local` 这个 Provider 注册到 SDK 的模型运行时，API Key 随 Provider 配置直接传入，认证来源只有这份配置。Provider 名固定，避免与 `openai` 等内置 Provider 重名而让已保存的 OAuth 凭据优先生效；模型运行时也不加载用户级 `models.json`，因此不存在其他可选模型。端点不提供价格信息时 `usage.cost` 恒为 `0`，只有 token 数可用。

构建后的正式入口：

```powershell
npm start -- run "解释 Orchestrator 与执行器的区别，并举例"
```

进度写入 stderr，最终结果以单个 JSON 写入 stdout。直接通过调用两个角色；一次返修最多调用四次。默认单次调用 60 秒、总时间 240 秒。退出码依次为：完成 `0`、审查失败 `1`、执行失败 `2`、超时 `124`、取消 `130`，参数错误为 `64`。

`npm run verify:sdk` 用一次真实 Writer 调用验证端点、模型与认证：成功时打印 endpoint、model、status、usage 与回复并退出 `0`，失败时退出 `1`。

## 目录

```text
.env.example           端点 / API Key / 模型的环境变量模板（不含真实值）
scripts/verify-sdk.ts  真实端点连通性验证
src/orchestration/
  model.ts       请求、执行器接口、审查与运行结果
  env.ts         读取 .env，真实环境变量优先
  provider.ts    端点校验与模型注册
  executor.ts    Pi SDK 受控会话、输出检查、超时与清理
  prompts.ts     角色提示、请求拼装、审查 JSON 校验
  service.ts     顺序调用、一次返修与停止条件
  cli.ts         命令行输入、进度、结果与退出码
tests/           编排、执行器、端点与 CLI 的离线测试及替身
项目最终架构.md    目标架构与原设计依据
阶段步骤实现.md    原实施顺序与验收条件
```

`node_modules/`、`dist/`、环境凭据文件及本地过程记录均排除在版本控制外；构建产物可用上述命令重建。Web、HTTP API、数据库、并行编排与恢复均属于后续规划。
