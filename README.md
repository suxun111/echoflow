# EchoFlow

EchoFlow 是一个英语视频影子学习平台 monorepo，包含学习端、运营后台、API、异步媒体处理 Worker 与共享基础包。

## 工作区

- `apps/web`：React + Vite 学习端，覆盖课程库、逐句练习、录音与个人上传入口。
- `apps/admin`：React + Vite 运营后台骨架，覆盖内容候选、授权审核、媒资字幕与处理任务视图。
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
pnpm lint
pnpm test
pnpm build
pnpm infra:up
pnpm --filter @online-learning/web dev
pnpm --filter @online-learning/admin dev
pnpm --filter @online-learning/api dev
pnpm --filter @online-learning/worker dev
```

## 本地环境

复制 `.env.example` 为 `.env` 后按需调整。`pnpm infra:up` 会启动 Postgres、Redis 和 MinIO，配置与 `.env.example` 保持一致。

更多说明见：

- [架构说明](docs/ARCHITECTURE.md)
- [API 契约](docs/API.md)
- [工作区边界](docs/WORKSPACES.md)
- [拆分进度](docs/PROGRESS.md)
