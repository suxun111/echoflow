# EchoFlow 工作区边界

更新时间：2026-07-18

## 默认协作边界

默认优先处理 `apps/web` 学习端。只有任务明确涉及后台、API、Worker、数据库、存储或共享契约时，才进入对应工作区。

## 应用

`apps/web`

学习端用户体验。负责课程发现、收藏、继续学习、练习页、录音、字幕解析、个人上传入口和前端性能体验。不直接修改后端 schema。

`apps/admin`

运营后台。负责内容工作台、候选内容、授权审核、媒资字幕、处理任务和课程发布视图。不承载学习端交互。

`apps/api`

NestJS API。负责 HTTP 模块、请求校验、业务编排、开发认证、上传预签名和任务查询。跨端数据结构优先从 `packages/contracts` 引入。

`apps/worker`

异步媒体处理。负责 BullMQ 队列消费、处理阶段编排和幂等执行。不要在 Worker 内定义 HTTP 契约。

## 共享包

`packages/contracts`

跨应用契约。只放稳定的 Zod schema 和共享 TypeScript 类型。修改这里通常需要同步验证 API、Web、Admin、Worker。

`packages/config`

环境变量解析。只负责配置 shape、默认值和类型，不读取业务数据。

`packages/ui`

共享视觉 token 和通用组件。避免放入具体业务页面逻辑。

`packages/storage`

对象存储适配。通过 `StorageProvider` 暴露上传、读取和删除能力。具体业务权限由 API 层决定。

`packages/database`

Prisma schema、迁移和种子数据。修改 schema 后需要重新生成 Prisma Client 并运行数据库相关测试。

## 验证建议

- Web 改动：`pnpm --filter @online-learning/web lint`、`test`、`build`。
- API 改动：先构建相关共享包，再跑 `pnpm --filter @online-learning/api lint`、`test`、`build`。
- 契约改动：运行全仓 `pnpm lint`、`pnpm test`、`pnpm build`。
