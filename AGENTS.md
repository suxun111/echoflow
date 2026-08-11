# EchoFlow 项目协作说明

## 项目目标

EchoFlow V1 是一个私人英语长视频影子学习工具：用户上传自己的 MP4 视频，系统生成完整英文字幕，再进行逐句循环、录音回听和进度恢复。

当前项目按 Gate 推进，不默认优先某个应用。开始任务前先读取：

1. `docs/EXECUTION-STATE.md`；
2. `docs/GOAL-v0.5.0-alpha.1.md`；
3. `docs/EchoFlow-V1-PRD.md`；
4. 涉及历史成果时读取 `docs/G0-BRANCH-ASSET-INVENTORY.md`；
5. 当前任务直接涉及的入口、依赖和测试。

当前 Gate 未通过前，不进入下一 Gate，也不使用 Mock、静态进度或局部模块完成度冒充纵向闭环。

## 架构地图

- `apps/web`：React 19 + Vite 学习端；V1 以“我的视频”、上传、学习播放器、录音和进度为中心。
- `apps/admin`：内部任务支持台；V1 不做公共内容审核发布。
- `apps/api`：NestJS API，按业务模块组织。
- `apps/worker`：异步处理流水线。
- `packages/contracts`：跨应用共享类型与契约。
- `packages/ui`：共享 UI 与设计令牌。
- `packages/database`：Prisma schema、迁移与种子数据。
- `packages/storage`、`packages/config`：存储与配置适配层。

## 上下文边界

- `docs/EchoFlow-V1-PRD.md` 是产品与架构目标；`docs/ARCHITECTURE.md` 和 `docs/API.md` 在 G1 前主要描述当前骨架，不代表目标已经实现。
- 历史 recovery/hardening/daily-goal 分支是候选资产，不是可以整体合并的发布分支；先查 `docs/G0-BRANCH-ASSET-INVENTORY.md`。
- 先读取目标应用的入口、直接依赖和相关测试，不默认展开整个 monorepo。
- 不读取或分析 `node_modules`、`dist`、`coverage`、`.turbo`、`*.tsbuildinfo`、本地数据库和存储数据。
- Web 任务从 `apps/web/src/app/App.tsx` 及对应 `features` 目录开始；只有跨包类型确有影响时再读取 `packages`。
- 保持源文件 UTF-8 和现有中文界面文案；不要因终端编码显示异常重写文本。
- 工作区可能包含用户未提交改动；只修改任务直接涉及的文件。
- 同一时间只允许一个核心纵向闭环处于集成状态；可并行只读调查和互不冲突的技术子任务。

## 常用命令

```powershell
pnpm run build:workspace-packages
pnpm --filter @online-learning/web dev
pnpm --filter @online-learning/web lint
pnpm --filter @online-learning/web test
pnpm --filter @online-learning/web build
```

fresh clone 或清理过 `dist` 后，先构建共享包再运行定向应用命令。根目录的 `pnpm dev`、`pnpm lint` 和 `pnpm test` 已自动执行这一步；需要全仓验证时运行根目录的 `pnpm lint`、`pnpm test` 和 `pnpm build`。依赖安装使用 pnpm 11.9，并优先执行 `pnpm install --frozen-lockfile`。

## 验证原则

- 任务完成必须提供绑定当前 Commit 的可复现证据；执行 Agent 的“已完成”不是验收。
- 优先使用确定性验证，再由独立 Reviewer 对照验收标准判断；审核后代码变化必须重新验证。
- 同一失败原因连续三轮仍未解决时停止自动返工并交还给人。
- 改动 Web 端时至少运行定向 TypeScript 检查、单元测试和生产构建。
- 性能改动同时检查交互响应、资源加载、定时器、媒体流与 Object URL 的释放。
- 不在未明确要求时修改公共 API、数据库 schema 或跨包契约。
