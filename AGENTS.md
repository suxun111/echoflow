# EchoFlow 项目协作说明

## 项目目标

EchoFlow 是一个英语视频影子学习平台 monorepo。默认优先处理学习端 `apps/web`，除非任务明确涉及管理端、API、Worker 或共享包。

## 架构地图

- `apps/web`：React 19 + Vite 学习端，课程库、练习、录音与上传界面。
- `apps/admin`：管理端前端。
- `apps/api`：NestJS API，按业务模块组织。
- `apps/worker`：异步处理流水线。
- `packages/contracts`：跨应用共享类型与契约。
- `packages/ui`：共享 UI 与设计令牌。
- `packages/database`：Prisma schema、迁移与种子数据。
- `packages/storage`、`packages/config`：存储与配置适配层。

## 上下文边界

- 先读取目标应用的入口、直接依赖和相关测试，不默认展开整个 monorepo。
- 不读取或分析 `node_modules`、`dist`、`coverage`、`.turbo`、`*.tsbuildinfo`、本地数据库和存储数据。
- Web 任务从 `apps/web/src/app/App.tsx` 及对应 `features` 目录开始；只有跨包类型确有影响时再读取 `packages`。
- 保持源文件 UTF-8 和现有中文界面文案；不要因终端编码显示异常重写文本。
- 工作区可能包含用户未提交改动；只修改任务直接涉及的文件。

## 常用命令

```powershell
pnpm --filter @online-learning/web dev
pnpm --filter @online-learning/web lint
pnpm --filter @online-learning/web test
pnpm --filter @online-learning/web build
```

需要全仓验证时再运行根目录的 `pnpm lint`、`pnpm test` 和 `pnpm build`。依赖安装使用 pnpm 11.9，并优先执行 `pnpm install --frozen-lockfile`。

## 验证原则

- 改动 Web 端时至少运行定向 TypeScript 检查、单元测试和生产构建。
- 性能改动同时检查交互响应、资源加载、定时器、媒体流与 Object URL 的释放。
- 不在未明确要求时修改公共 API、数据库 schema 或跨包契约。
