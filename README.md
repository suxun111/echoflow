# EchoFlow

EchoFlow V1 是一个私人英语长视频影子学习工具。目标链路是：

```text
私人 MP4 上传
→ 对象存储与持久任务
→ MOSS 完整英文字幕
→ 5–10 分钟学习单元
→ 逐句循环、录音回听和进度恢复
```

当前仓库仍处于高保真原型和工程骨架阶段，目标架构尚未全部接通。不要根据页面、接口或 Worker 文件存在就判断功能已经完成。

## 当前执行基线

- 唯一 trunk：`master`；
- V1 产品代码审计源点：`42968ad`；G0 文档基线：`d01c67e`；
- 当前 Goal：`v0.5.0-alpha.1`；
- 当前 Gate：G0 成果保护与唯一主线；
- 产品功能开发暂时冻结，先完成历史成果收敛和远程恢复能力；
- recovery、hardening、daily-goal 分支不得整体盲合。

开始开发或审查前依次阅读：

1. [当前执行状态](docs/EXECUTION-STATE.md)
2. [v0.5.0-alpha.1 Goal](docs/GOAL-v0.5.0-alpha.1.md)
3. [EchoFlow V1 PRD](docs/EchoFlow-V1-PRD.md)
4. [G0 分支资产台账](docs/G0-BRANCH-ASSET-INVENTORY.md)

## 工作区

- `apps/web`：React + Vite 学习端；当前含课程库、练习、录音和上传原型，V1 将收敛到“我的视频”。
- `apps/admin`：React + Vite 管理端骨架；V1 只保留内部任务支持能力。
- `apps/api`：NestJS API，提供健康检查、认证、课程、字幕、进度、上传、任务与管理端接口。
- `apps/worker`：BullMQ 媒体处理 Worker 骨架，模拟转码、转写、翻译、分句、发布流程。
- `packages/contracts`：Zod 契约和跨端共享类型。
- `packages/config`：服务端环境变量解析。
- `packages/ui`：共享 UI token 与基础组件。
- `packages/storage`：内存存储与 MinIO 存储适配。
- `packages/database`：Prisma schema、测试与种子数据。

## 常用命令

```powershell
pnpm install --frozen-lockfile
pnpm run build:workspace-packages
pnpm lint
pnpm test
pnpm build
pnpm infra:up
pnpm --filter @online-learning/web dev
pnpm --filter @online-learning/admin dev
pnpm --filter @online-learning/api dev
pnpm --filter @online-learning/worker dev
```

根 `dev`、`lint` 和 `test` 会先构建 `packages/*`，因此可在 fresh clone 直接运行。若只执行某个 `apps/*` 的定向命令，先运行一次 `pnpm run build:workspace-packages`，避免共享包尚无 `dist` 导致解析失败。

## 本地环境

复制 `.env.example` 为 `.env` 后按需调整。`pnpm infra:up` 会启动 Postgres、Redis 和 MinIO，配置与 `.env.example` 保持一致。

更多说明见：

- [V1 PRD](docs/EchoFlow-V1-PRD.md)
- [Goal](docs/GOAL-v0.5.0-alpha.1.md)
- [Execution State](docs/EXECUTION-STATE.md)
- [G0 分支资产台账](docs/G0-BRANCH-ASSET-INVENTORY.md)
- [架构说明](docs/ARCHITECTURE.md)
- [API 契约](docs/API.md)
- [工作区边界](docs/WORKSPACES.md)
- [拆分进度](docs/PROGRESS.md)
