# EchoFlow Execution State

更新时间：2026-08-16

此文件记录动态执行状态，不重复存放完整 PRD。长期产品决定见 [EchoFlow V1 PRD](EchoFlow-V1-PRD.md)，整体终点见 [v0.5.0-alpha.1 Goal](GOAL-v0.5.0-alpha.1.md)。

## 当前状态

| 字段 | 当前值 |
|---|---|
| Goal | `v0.5.0-alpha.1` |
| Gate | `G1`、`G2` 已关闭；`G3` 本地实现候选已通过代码审查，但真实 MOSS 门禁未通过，Gate 保持打开 |
| 唯一 trunk | `master` |
| V1 产品代码审计源点 | `42968ad` |
| G0 文档基线 | `d01c67e`，已 fast-forward 至 master |
| fresh-clone 修复 | `0e3c912`，已 fast-forward 至 master；来源分支为 `codex/g0-fresh-clone-topology-20260811` |
| G1 实施分支 | `codex/g1-contract-database-auth-20260812`；最终代码锚点 `4bfaaba` |
| G2 实施分支 | `codex/g2-long-video-upload-playback-20260812`；最终代码验收锚点 `d08f6c6` |
| G3 实施分支 | `codex/g3-moss-transcript-20260813`；基线提交 `0c3e2ee`（分支创建时的 `master`）；EchoFlow 代码锚点 `ca3e3ad` |
| MOSS Provider 分支 | `codex/echoflow-provider-gateway-20260815`；代码锚点 `cdf6eb3` |
| WIP | G3“MOSS 与完整字幕原子发布”仍是唯一核心纵向闭环；Provider 合同已实现，当前等待真实模型与样本矩阵 |
| 产品功能开发 | G2 已通过退出门；G3 实施中，G4–G5 继续冻结 |
| Remote | `origin = https://github.com/suxun111/echoflow.git`；Private；外部恢复验证通过 |
| 下一人工边界 | 用户确认大模型下载、磁盘与算力投入后，先执行真实 30 秒黄金样本，再决定是否进入 5/30/60/120 分钟矩阵；未通过不关闭 G3 |

## 2026-08-11 决策澄清

- G5 的发布阶段统一命名为“生产加固与香港邀请制 Alpha”；原 PRD 中两处 `Beta` 是命名不一致，已按版本目标 `v0.5.0-alpha.1` 和 5–10 名邀请用户的证据门统一为 `Alpha`，不改变功能范围；
- PRD 的 G6 工作流接入是 Alpha 之后的未来阶段，不属于当前 `v0.5.0-alpha.1` Goal；
- 用户选择“保留旧 worktree”不会阻塞 G0；就 worktree 清理而言，G0 只要求所有资产已保护、已分类且可从独立位置恢复。

## 已完成证据

### G0 第一轮

- 四个 dirty worktree 已复制到 `E:\33442\ai\backups\EchoFlow\G0-20260811-145052`；
- 共保护 126 个 Git 相关改动/未跟踪文件；
- 源文件与备份逐文件 SHA-256 比对，零不匹配；
- 创建四条 recovery 分支与 Commit；
- 创建两条 detached archive 分支；
- 创建 `EchoFlow-all-refs-v2-20260811.bundle`；
- Bundle SHA-256：`8A656C08AA732280D65F44B6D47B0A1413BA9172E15860E054A788B2D0F4A8D5`；
- 从 bundle 克隆到全新目录成功；
- recovery/archive refs 6/6 精确匹配；
- `git fsck --full` 通过；
- 没有执行合并、删除、prune、reset 或标签重写。

### 受保护分支

| 分支 | Commit | 用途 |
|---|---|---|
| `codex/recovery-0b51-20260811` | `2c76de7` | 本地 MP4、私有学习、API/Worker 实验 |
| `codex/recovery-5025-20260811` | `6c5d68c` | Daily goal/streak 原型，V1 暂停 |
| `codex/recovery-b8b9-20260811` | `f2c6e0b` | 旧 PRD 与早期 Worker 实验 |
| `codex/recovery-f24e-20260811` | `299e6e1` | 更完整媒体处理、词汇/翻译实验 |
| `codex/archive-detached-2eeb078-20260811` | `2eeb078` | 早期 Auth UI/API 实验 |
| `codex/archive-detached-9942c38-20260811` | `9942c38` | 与产品代码审计源点 `42968ad` 相同 tree 的历史 Commit |

## G0 第二轮本地结论

- [G0 分支资产台账](G0-BRANCH-ASSET-INVENTORY.md) 已完成领域级分类；
- `master` 确认为唯一移动 trunk；`42968ad` 保留为 V1 产品代码审计源点，不再冒充当前 master Tip；
- recovery/hardening 分支只允许选择性提取，禁止整体 merge；
- hardening 中的认证、数据库、Worker 和部署实现均不符合完整 V1，只保留约束、错误分类、恢复与测试思想；
- `0b51` 优先参考严格字幕原子发布和学习交互；
- `f24e` 优先参考 MOSS 容错、任务恢复和 Web 轮询；
- daily goal、streak、翻译、词汇和公共内容明确暂停或淘汰；
- 仓库入口已经指向确认版 PRD、Goal、State 和资产台账。

### fresh-clone 构建拓扑发现

- 在 bundle 恢复目录对 `d01c67e` 执行 `pnpm install --frozen-lockfile` 成功；
- 随后的原根 `pnpm lint` 失败，API/Admin/Worker 无法解析共享包，因为它们的 `types/main/exports` 指向未跟踪的 `dist`，而递归 lint 的上游任务使用 `tsc --noEmit`；
- 隔离复验证明先构建 `packages/*` 后，lint、31 个测试和 Web/Admin/API/Worker build 全部通过；
- G0 采用零新增依赖的最小修复：根 `dev/lint/test` 先运行 `build:workspace-packages`；任务缓存编排器留到 G1/CI 治理时单独决定。

### 修复后本地恢复验证

- fresh-clone 修复已独立审核、提交为 `0e3c912` 并 fast-forward 至 `master`；
- 从修复后的 master 创建 `EchoFlow-g0-code-0e3c912-20260811.bundle`，SHA-256 为 `7D3C07B40DF2CAFC33CC5EF8C0F40186E12BF22D286DA89686EEE53F2FDA3BE6`；
- 从该 bundle 克隆至全新目录，18 个 heads/tags refs 零不匹配，`git fsck --full` 通过，恢复后的 HEAD 精确为 `0e3c912`；
- 在该 fresh clone 中不做手工预构建，直接执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test` 和 `pnpm build`，全部通过；
- 测试共 31 个：Web 24、API 3、Worker 2、Database 2；Web、Admin、API、Worker 生产构建全部通过；
- 以上只证明可重复安装、静态检查、现有自动化测试与构建，不证明真实 PostgreSQL、Redis、MinIO、MOSS 或生产部署闭环。

### GitHub 外部恢复验证

- GitHub 仓库 `suxun111/echoflow` 确认为 Private，默认分支为 `master`；
- 推送全部 13 条本地分支和 5 个历史标签成功；
- 从 GitHub 克隆至全新目录 `E:\33442\ai\backups\EchoFlow\G0-20260811-145052\restore-check-github-3c07e4e`；
- source / GitHub clone 的 heads + tags 均为 18，零不匹配；`git fsck --full` 通过，恢复工作树干净；
- 外部验证锚点为 `3c07e4e`，source HEAD 与 GitHub clone HEAD 精确一致；
- 在该 GitHub fresh clone 中执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test` 和 `pnpm build`，全部通过；
- 测试仍为 31 个，Web、Admin、API、Worker 生产构建全部通过；该证据边界仍不包含真实 PostgreSQL、Redis、MinIO、MOSS 和生产部署。

## 当前进行中

- G1 已按 [验证证据](G1-VERIFICATION-EVIDENCE.md) 关闭；
- G2 已按 [任务合同](G2-TASK-CONTRACT.md) 实现，并由 [验证证据](G2-VERIFICATION-EVIDENCE.md) 关闭；
- 最终代码验收锚点为 `d08f6c6`，独立 Reviewer 结论为无 P0/P1；
- 验证证据已提交为 `3514a4e` 并 fast-forward 至唯一 trunk，8 项退出条件全部成立；
- 用户已确认开始 G3；[G3 任务合同](G3-TASK-CONTRACT.md) 冻结为当前实施与验收边界；
- EchoFlow `ca3e3ad` 已采用 segment-first 契约并接入 `/api/provider/v1`；MOSS `cdf6eb3` 已实现独立 Bearer 网关、稳定幂等身份、代际 fencing、重启协调、不可变结果与持久 TTL。独立 Reviewer 对两个工作树均未发现 P0/P1；
- [G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)记录了 EchoFlow 160 个通过测试、MOSS 52 个通过测试、真实 PostgreSQL/Redis/MinIO/FFmpeg、生产构建和 8002 隔离网关运行态复验；另有 4 个会自生成样本的 G2 长媒体回归测试因未设置 `RUN_G2_LONG_MEDIA=true` 而跳过；
- 真实模型尚未下载、加载和执行；30 秒及 5/30/60/120 分钟真实样本矩阵也未验证，因此 G3 不关闭；
- G4 播放器、录音与进度以及 G5 生产发布继续冻结。

## G2 关闭证据

- 私人 MP4 已形成浏览器 Multipart 直传、PostgreSQL/Outbox、Redis/Worker、ffprobe/fast-start 与 owner-scoped 签名 Range 播放的真实闭环；
- complete、cancel、过期清理与 Worker 发布使用数据库锁、lease 和最终 fencing，迟到请求与旧 Worker 不能复活或破坏已发布资产；
- 最终锚点全仓 lint、87 个默认测试、四应用 build、Prisma validate 和 Compose config 通过；
- 30 秒黄金样本与 5/30/60/120 分钟真实长媒体矩阵通过；
- `d08f6c6` 的 fresh clone 冻结安装、lint、test、build 通过；本机 `NODE_ENV` 与失效代理边界已在证据中记录；
- `68a1703` 浏览器完成 OTP、真实直传、Worker 检查与签名播放；最终运行时代码 `8d9ac84` 复验登录态、资产读取和签名播放，`d08f6c6` 只增加错误 Part 测试；
- G2 不包含 MOSS、字幕、学习单元、逐句练习或生产部署。

## G1 关闭证据

- 冻结合同 `cad0c0b`，第一版实现 `9106ba3` 因 Reviewer 的 5 个 P1 被否决；
- 安全与数据约束整改 `7a9048c` 通过第二轮独立审核；
- fresh clone 暴露 Prisma Client 生成缺口，修复为 `f568eea` 后通过第三轮独立审核；
- 最终又收窄测试库删除边界并补充 403/429 断言，`4bfaaba` 通过独立增量审核；
- 最终代码 `4bfaaba` 无已知 P0/P1；
- fresh clone 冻结安装、首次 lint、58 个测试和四应用 build 通过；
- 独立 `echoflow_g1_fresh_f568eea_test` 从空库迁移成功，第二次 deploy 无待迁移；
- API 真实 PostgreSQL 测试覆盖重启、并发 Refresh 重放、伪 Token、双用户 owner、RBAC 和复合数据库约束；
- 历史 `online_learning` 保持原 13 张表和 2 条旧 migration，并被配置/迁移入口显式保护。

## G0 退出条件（已全部完成）

- [x] 分支和 worktree 资产完成领域级分类；
- [x] 每项候选成果有“迁移、参考、暂停、归档”结论；
- [x] 确认版 PRD 已进入当前基线分支；
- [x] README/AGENTS/Progress 不再把过期状态交给 Agent；
- [x] G0 文档变更通过独立审核并提交为 `d01c67e`；
- [x] 将审核通过的 G0 基线 fast-forward 至 `master`，唯一 trunk 自身已包含 PRD/Goal/State/资产台账；
- [x] fresh-clone 构建拓扑修复通过独立审核、提交为 `0e3c912` 并 fast-forward 至 `master`；
- [x] 从修复后的本地全引用 bundle 恢复到空目录，完成 refs、fsck、冻结安装、lint、31 个测试与生产构建验证；
- [x] 配置 Private GitHub `origin`；
- [x] 推送全部 13 条本地分支和 5 个历史标签；
- [x] 从空目录 clone 外部 remote，并验证 18 个 heads/tags refs、HEAD 和 `git fsck --full`；
- [x] 在外部 remote 的 fresh clone 执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test` 和 `pnpm build`；

G0 于 2026-08-11 完成退出条件并关闭。G1 必须从新的任务合同、分支和验收门开始，不把 G0 的工程绿色误当成生产能力。

以下是 G0 关闭后的可选治理动作，不是退出条件：用户可选择继续保留，或另行确认清理旧 worktree、冗余 alias/ref 和本地恢复目录。

## 恢复本任务时的读取顺序

1. `AGENTS.md`；
2. `docs/EXECUTION-STATE.md`；
3. `docs/GOAL-v0.5.0-alpha.1.md`；
4. `docs/EchoFlow-V1-PRD.md`；
5. 当前任务直接涉及的应用和测试；
6. 仅在需要迁移历史成果时读取 [G0 分支资产台账](G0-BRANCH-ASSET-INVENTORY.md)。

不要默认展开整个 Monorepo，也不要因为发现历史实现就直接合并旧分支。
