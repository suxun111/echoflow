# EchoFlow 项目进度

更新时间：2026-08-13

动态任务状态以 [Execution State](EXECUTION-STATE.md) 为准，产品目标以 [V1 PRD](EchoFlow-V1-PRD.md) 为准。

## 当前判断

EchoFlow 已具备：

- React/Vite 学习端与管理端原型；
- NestJS API、BullMQ Worker、Prisma、Storage、Config 和 Contracts 骨架；
- 较完整的视觉语言和部分本地录音、词汇交互原型；其中词典/生词功能不属于 V1；
- 多条历史实验分支中的认证、私有上传、MOSS、迁移和 E2E 候选资产。

EchoFlow 尚不具备：

- MOSS 完整字幕与字幕原子发布；
- 可恢复的 Outbox/Worker/MOSS 完整转写流水线；
- 真实媒体、完整字幕、逐句练习和进度恢复纵向链路；
- CI、生产发布和真实基础设施恢复闭环。

G1 已建立真实 PostgreSQL/Auth/owner 基线，G2 已建立私人 MP4 上传与原片播放闭环；但 MOSS、字幕、影子练习和生产运维尚未闭环，因此仍不能作为完整 V1 或公开生产服务交付。

## 当前 Git 基线

```text
master                          唯一移动 trunk；G0 GitHub 外部恢复历史锚点 3c07e4e
V1 产品代码审计源点            42968ad
G0 文档基线                    d01c67e
fresh-clone 修复来源分支        codex/g0-fresh-clone-topology-20260811@0e3c912
codex/daily-goal-integration    5acf375
codex/daily-goal-prototype      40f4ff0
codex/moss-production-hardening 0baedef
```

历史标签存在分叉语义，暂不重写；新版本线计划从 `v0.5.0-alpha.1` 开始。

## G0 已完成

- 四个 dirty worktree 已做 E 盘文件级备份和 SHA-256 校验；
- 创建四条 recovery 分支；
- 创建两条 detached archive 分支；
- 创建包含全部 refs 的 Git bundle；
- 从 bundle 在空目录恢复并通过 `git fsck --full`；
- 确认版 V1 PRD 已复制进当前 G0 baseline 分支。

## G0 本地收敛

- 已完成 [历史分支资产台账](G0-BRANCH-ASSET-INVENTORY.md)；
- 已区分保留、迁移、参考重写、暂停、归档和淘汰资产；
- 已确认所有旧实现都不能整体合并，master 是唯一 trunk；
- 已更新仓库中的确认版 PRD、Goal、State 和入口文档；
- G0 基线文档已独立审核、提交为 `d01c67e` 并 fast-forward 至 master；
- fresh clone 暴露的共享包 `dist` 构建顺序问题已用根命令的共享包预构建修复；
- 修复已独立审核、提交为 `0e3c912` 并 fast-forward 至 master；
- 已创建修复后的全引用 bundle，SHA-256 为 `7D3C07B40DF2CAFC33CC5EF8C0F40186E12BF22D286DA89686EEE53F2FDA3BE6`；
- 已从 bundle 恢复到空目录，18 个 heads/tags refs 零差异且 `git fsck --full` 通过；
- 已在该 fresh clone 不做手工预构建，直接完成冻结安装、lint、31 个测试和 Web/Admin/API/Worker 生产构建。

## G0 外部恢复完成

- 已配置 Private GitHub remote：`https://github.com/suxun111/echoflow.git`；
- 已推送全部 13 条本地分支和 5 个历史标签；
- 已从 GitHub 在全新目录 clone，18 个 heads/tags refs 零差异，HEAD 精确匹配且 `git fsck --full` 通过；
- 已在 GitHub fresh clone 完成冻结安装、lint、31 个测试和 Web/Admin/API/Worker 生产构建；
- G0 已关闭；用户可继续保留旧 worktree，也可在未来单独确认归档或清理。

## G0 之后

```text
G1 契约、数据库、身份和安全
→ G2 长视频上传与可播放资产
→ G3 MOSS 与完整字幕原子发布
→ G4 真实播放器与影子练习
→ G5 生产加固与邀请制 Alpha
```

上一 Gate 没有证据通过时，不开始下一 Gate。

## G1 已完成

- `/api/v1` contracts、统一错误、requestId、CORS allowlist 和安全环境校验已建立；
- V1 baseline migration 已在空 PostgreSQL 应用并验证幂等；
- OTP、短期 Access JWT、opaque rotating HttpOnly Refresh Session 已进入真实数据库；
- 并发 Refresh 重放会撤销整个 family；
- owner/RBAC 默认拒绝，数据库复合外键阻止跨 owner/跨聚合关系；
- PRD、contracts、Prisma 和 migration 的状态机已经统一；
- 最终代码锚点 `4bfaaba` 通过独立 Reviewer，无 P0/P1；
- fresh clone 冻结安装、lint、58 个测试、Web/Admin/API/Worker build 全部通过；
- 完整证据见 [G1 验证证据](G1-VERIFICATION-EVIDENCE.md)。

## G2 已完成

- 浏览器真实 Multipart 私人直传、32 MiB 默认分片、并发 3 与 7 天续传已接通；
- API 以 provider manifest、HEAD、ETag/Version 和大小完成校验，重复/并发 complete 只产生一份资产；
- PostgreSQL Outbox、Redis 与 Worker 支持重投、恢复、lease heartbeat 和最终 fencing；
- 真实 ffprobe 验证 MP4/H.264/AAC，slow-start 只做无损 fast-start remux；
- owner-scoped 短期签名播放支持 HTTP Range，双用户和管理员负向权限通过；
- Web 已提供 OTP、我的视频、上传/恢复任务与真实原片播放；
- 最终代码锚点 `d08f6c6` 通过独立 Reviewer，无 P0/P1；
- 全仓 lint、87 个默认测试、四应用 build、30 秒黄金样本及 5/30/60/120 分钟真实长媒体矩阵通过；
- fresh clone 通过；`68a1703` 浏览器完整上传链和最终运行时代码 `8d9ac84` 的签名播放复验通过，`d08f6c6` 只增加错误 Part 测试，边界见 [G2 验证证据](G2-VERIFICATION-EVIDENCE.md)。

验证证据已提交为 `3514a4e` 并进入唯一 trunk，G2 的 8 项退出条件全部完成。下一步是先冻结 G3“MOSS 与完整字幕原子发布”的任务合同；G2 的绿色不代表字幕或学习闭环已完成。
