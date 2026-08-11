# EchoFlow Execution State

更新时间：2026-08-11

此文件记录动态执行状态，不重复存放完整 PRD。长期产品决定见 [EchoFlow V1 PRD](EchoFlow-V1-PRD.md)，整体终点见 [v0.5.0-alpha.1 Goal](GOAL-v0.5.0-alpha.1.md)。

## 当前状态

| 字段 | 当前值 |
|---|---|
| Goal | `v0.5.0-alpha.1` |
| Gate | `G0 成果保护与唯一主线` |
| 唯一 trunk | `master` |
| V1 产品代码审计源点 | `42968ad` |
| G0 文档基线 | `d01c67e`，已 fast-forward 至 master |
| 当前修复来源分支 | `codex/g0-fresh-clone-topology-20260811`，目标为审核后 fast-forward 至 master |
| WIP | fresh-clone 构建拓扑修复与最终恢复验证 |
| 产品功能开发 | 冻结 |
| Remote | 未配置 |
| 下一人工边界 | 选择远程仓库及可见性 |

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

## 当前进行中

- 审核并提交 fresh-clone 构建拓扑修复；
- 为修复后的 master 创建最终本地 Git bundle，并从空目录重新执行 install/lint/test/build；
- 等待用户选择外部 remote 和可见性。

## G0 剩余退出条件

- [x] 分支和 worktree 资产完成领域级分类；
- [x] 每项候选成果有“迁移、参考、暂停、归档”结论；
- [x] 确认版 PRD 已进入当前基线分支；
- [x] README/AGENTS/Progress 不再把过期状态交给 Agent；
- [x] G0 文档变更通过独立审核并提交为 `d01c67e`；
- [x] 将审核通过的 G0 基线 fast-forward 至 `master`，唯一 trunk 自身已包含 PRD/Goal/State/资产台账；
- [ ] 配置外部 remote；
- [ ] 推送 master、recovery、archive、hardening、daily-goal 和旧 tags；
- [ ] 从空目录 clone 外部 remote，并验证 refs 和 `git fsck --full`；
- [ ] 在 fresh clone 执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test` 和 `pnpm build`；

以下是 G0 关闭后的可选治理动作，不是退出条件：用户可选择继续保留，或另行确认清理旧 worktree、冗余 alias/ref 和本地恢复目录。

## 恢复本任务时的读取顺序

1. `AGENTS.md`；
2. `docs/EXECUTION-STATE.md`；
3. `docs/GOAL-v0.5.0-alpha.1.md`；
4. `docs/EchoFlow-V1-PRD.md`；
5. 当前任务直接涉及的应用和测试；
6. 仅在需要迁移历史成果时读取 [G0 分支资产台账](G0-BRANCH-ASSET-INVENTORY.md)。

不要默认展开整个 Monorepo，也不要因为发现历史实现就直接合并旧分支。
