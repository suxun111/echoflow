# EchoFlow 协作指南（CONTRIBUTING）

本仓库是一个 **monorepo**，由**两位开发者的 AI Agent（Codex）共同维护**。本文件是给人看的协作约定；Codex 行为约定见根目录 `AGENTS.md`。**两边的规则必须一致，否则两台 Codex 会互相踩踏。**

---

## 1. 仓库结构速览

```
apps/web      学习端（React 19 + Vite）
apps/admin    内部任务支持台（V1 不做公共内容审核）
apps/api      NestJS API，按业务模块组织
apps/worker   异步处理流水线
packages/contracts   跨应用共享类型与契约
packages/ui          共享 UI 与设计令牌
packages/database    Prisma schema、迁移与种子数据
packages/storage、packages/config  存储与配置适配层
```

---

## 2. 地盘划分（避免两台 Codex 冲突的关键）

**推荐按包划分职责，两方尽量不碰同一文件。**

| 负责方 | 负责范围 |
|--------|----------|
| **你**（owner） | `apps/web` 学习端、`packages/ui` |
| **朋友**（collaborator） | `apps/api`、`apps/worker` |

### 共享层规则（最容易冲突，必须遵守）

`packages/contracts`、`packages/database`、`packages/storage`、`packages/config` 是**全局共享**，任何一方改动前**必须先在群里/当面说明**，确认没有另一方正在动，再动手。

> ⚠️ **`packages/database`（Prisma schema + migration）冲突最难解**：改动前必须通知对方；两个人不要同时跑 `db:migrate`。

---

## 3. 分支规范

当前仓库历史遗留了大量 `codex/*`、`recovery-*` 短命分支，协作期请用以下规范，**用完即删**：

- 主分支：`master`（**永远保持可构建、可运行**）
- 功能分支：`feature/功能名`
- 修复分支：`fix/问题名`
- ⛔ **禁止直接往 `master` push**，一律走 Pull Request

### 每台 Codex 的分支隔离

- 每台 Codex 只在**自己名下的 `feature/...` 分支**上开发，**绝不共用同一个功能分支**。
- 命名示例：`feature/web-上传优化`、`feature/api-字幕接口`。
- 合入 `master` 必须经过 Pull Request + 对方（或独立 review）审核。

---

## 4. 日常协作流程

### 动手前（每次必做）

```bash
git checkout master
git pull origin master        # 拉取对方合入的最新代码
git checkout -b feature/你的任务名
```

### 改完提交

```bash
git add .
git commit -m "完成XX功能：一句能看懂的话"
git push origin feature/你的任务名
```

### 合入 master（走 Pull Request）

1. 在 GitHub 上对 `feature/你的任务名` 发起 Pull Request 到 `master`
2. 对方或另一台 Codex review 代码
3. 通过后 merge，**然后立刻删掉该功能分支**

---

## 5. 跑项目 / 验证（和 AGENTS.md 一致）

依赖安装使用 **pnpm 11.9**，优先 `pnpm install --frozen-lockfile`。

```powershell
# fresh clone 或清理过 dist 后，先构建共享包
pnpm run build:workspace-packages

# 单独跑某个应用
pnpm --filter @online-learning/web dev
pnpm --filter @online-learning/web lint
pnpm --filter @online-learning/web test
pnpm --filter @online-learning/web build

# 全仓验证（合入 master 前必跑）
pnpm lint
pnpm test
pnpm build

# 数据库相关（改动 packages/database 时才需要）
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

---

## 6. 合入 master 的硬性要求

**谁合入，谁负责保证 `master` 可用。** 合入前必须满足：

- [ ] `pnpm build` 通过
- [ ] `pnpm lint` 通过
- [ ] `pnpm test` 通过（涉及 DB 时需 `db:test:prepare`）
- [ ] 已通知对方「我要合入了」，确认对方没有正在改同一文件
- [ ] 未改动 `packages/database` schema（若改了，已提前说明并一起 review migration）

---

## 7. 冲突处理

- **同一文件两边都改了**：以对方先合入的版本为准，自己 `git pull` 后手动解决，不要硬覆盖。
- **Prisma migration 冲突**：停止一方，由后动的那方在 `git pull` 后重新 `db:generate`。
- **Codex 生成的临时分支/提交**：功能合并后立即清理，保持分支列表干净。

---

## 8. 敏感信息

- **绝不提交** `.env`、`.env.local`、密钥、API token、数据库密码 到仓库。
- 提交前检查 `git status`，确认没有意外带进敏感文件。
- 若仓库要设为 public，必须先把密钥清干净再公开。

---

## 9. 给两台 Codex 的共同约定（同步到 AGENTS.md）

请把你这份 `CONTRIBUTING.md` 的核心约定，也合并进根目录 `AGENTS.md`（对方 clone 时读到的就是同一套规则）。关键点：

1. 同一时间**只允许一个 Codex 改 `apps/web` 或共享 `packages/*`**。
2. 每台 Codex 在**自己名下的 `feature/...` 分支**开发，不共用分支、不直接 push `master`。
3. 改动 `packages/database` 前**必须通知对方**。
4. 合入 `master` 前必须通过 `pnpm build` / `lint` / `test`。

---

有任何疑问，先读这份文件 + `AGENTS.md`，仍不清楚就在群里同步沟通，**不要直接改共享代码。**