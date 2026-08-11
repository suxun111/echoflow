# EchoFlow G0 分支资产台账

更新时间：2026-08-11

本台账回答三个问题：当前从哪里继续开发、历史成果保留什么、哪些实现不能进入已确认的 V1。

产品与架构判断以 [EchoFlow V1 PRD](EchoFlow-V1-PRD.md) 为准，当前执行状态以 [Execution State](EXECUTION-STATE.md) 为准。本文记录的是历史资产取舍，不代表对应功能已经在主线实现。

## 最终决策

1. `master` 是唯一移动 trunk；`42968ad` 是 V1 产品代码审计源点，`d01c67e` 是已经进入 master 的 G0 文档基线。
2. 不整体 merge 任何 recovery、hardening、daily-goal 或 archive 分支。
3. 不整笔 cherry-pick `43f40ec`、`0baedef`、`2c76de7`、`299e6e1` 等快照提交。
4. 历史实现只允许按领域、按文件或按测试场景选择性提取，并在新提交中记录来源 Ref 和与 V1 的差异。
5. 认证、Prisma Schema、Multipart 上传、Outbox、MOSS 流水线和生产部署按已确认 V1 重建，不能把原型“修补成生产版”。
6. 旧标签保持不动并标记为分叉历史；统一版本线从 `v0.5.0-alpha.1` 继续。

## 决策词典

| 状态 | 含义 |
|---|---|
| 保留 | 当前主线已有且继续使用 |
| 迁移 | 可提取小型实现或测试，但必须重新验证 |
| 参考重写 | 只复用设计思想、交互意图或测试场景 |
| 暂停 | 有价值，但不属于 V1 P0 |
| 归档 | 只保留历史或恢复证据，不再继续开发 |
| 淘汰 | 与已确认 V1 冲突，不得进入新实现 |

## Git 历史事实

```text
v0.1.0 / 1b8bdc1
├─ 学习端主线
│  └─ 42968ad = v0.2.0 = v0.4.1（G0 审计时的 master 产品代码源点）
└─ 后端硬化支线
   ├─ 43f40ec = v0.3.0
   └─ 0baedef = v0.4.0
```

因此，`v0.4.1` 不是 `v0.4.0` 的线性补丁版；它与 `v0.2.0` 指向同一个提交。`v0.3.0/v0.4.0` 是从 `v0.1.0` 分出的实验快照，没有进入 master。禁止移动或重打旧标签来掩盖这段历史。

## 分支级处置

| Ref | Tip | 独特资产 | 处置 |
|---|---:|---|---|
| `master` | 移动 trunk；G0 文档基线为 `d01c67e` | 最新学习端视觉、Practice UI、测试与 UI 问题证据；也含待移出 V1 的词典/生词交互 | 唯一 trunk；保留视觉骨架，按 PRD 收窄功能 |
| `codex/g0-baseline-20260811` | `d01c67e` | 确认版 PRD、Goal、State、资产台账 | 已审核并 fast-forward 至 master；保留来源分支 |
| `codex/g0-fresh-clone-topology-20260811` | 由 `d01c67e` 分出 | fresh-clone 共享包构建顺序修复与证据更新 | 当前 G0 修复来源分支；审核后 fast-forward 至 master |
| `codex/daily-goal-integration` | `5acf375` | 今日目标、有效学习计时、设置、庆祝弹窗和测试 | 暂停；P2 时只迁移计时策略和测试 |
| `codex/daily-goal-prototype` | `40f4ff0` | 早期双语 Practice/视觉分叉 | 归档；master 已取代，不合并 |
| `codex/merge-learning-ui-fixes` | `42968ad` | 与产品代码审计源点 `42968ad` 指向同一提交 | 冗余别名；不再开发、不需合并 |
| `codex/moss-production-hardening` | `0baedef` | 数据库模块、错误/请求 ID、认证边界、Worker 恢复和部署实验 | 参考重写；禁止整分支或整提交迁移 |
| `codex/recovery-0b51-20260811` | `2c76de7` | 私有 MP4、严格完整字幕发布、学习页视频控制和 Cue 交互 | 选择性参考；学习交互与原子发布语义优先 |
| `codex/recovery-f24e-20260811` | `299e6e1` | 更完整的 MOSS 错误/恢复、最近任务、Web 轮询恢复、词汇翻译实验 | 选择性参考；容错资产优先，词汇翻译暂停 |
| `codex/recovery-5025-20260811` | `6c5d68c` | 今日目标、连续学习、日期边界测试、需求文档和截图 | 不可变恢复证据；V1 暂停 |
| `codex/recovery-b8b9-20260811` | `f2c6e0b` | 两份旧 PRD、fresh-clone 构建顺序问题、并发重复任务测试意图 | 归档/需求考古；无独特真实后端可迁移 |
| `codex/archive-detached-2eeb078-20260811` | `2eeb078` | 登录注册 UI、倒计时/错误态和认证测试意图 | Auth UI 参考；后端和 Session 实现淘汰 |
| `codex/archive-detached-9942c38-20260811` | `9942c38` | 文件树与产品代码审计源点 `42968ad` 完全相同 | 冗余归档；无代码可迁移 |

## Worktree 处置台账

以下是 2026-08-11 本轮提交前的复核快照。Worktree 本身只是检出位置；是否有独特资产由对应 Commit、recovery ref 和文件级备份共同判断。

| Worktree | HEAD / 分支 | 状态与处置 |
|---|---|---|
| 主工作区 | 先完成 `g0-baseline@d01c67e`，随后检出 `codex/g0-fresh-clone-topology-20260811` | 当前承载 fresh-clone 修复；审核后 fast-forward 至 master |
| `0b51` | `codex/recovery-0b51-20260811@2c76de7` | tracked 成果已进入 recovery Commit；只剩 Playwright 生成目录，已在 E 盘备份，不作为源码迁移 |
| `4efc` | detached `1b8bdc1` | clean；由 `v0.1.0` 和所有后续历史可达，只作旧基线检出位置 |
| `5025` | `codex/recovery-5025-20260811@6c5d68c` | clean；不可变恢复证据，P2 暂停 |
| `538e` | detached `2eeb078` | clean；已有 `archive-detached-2eeb078` ref，仅作 Auth UI 历史检出位置 |
| `692b` | detached `d656491` | clean；提交已被 `daily-goal-prototype`、相关 recovery 和 `archive-9942` 包含，无独特未提交资产 |
| `795f` | detached `d656491` | clean；与 `692b` 重复，无独特未提交资产 |
| `8750` | `codex/moss-production-hardening@0baedef` | clean；只读参考，不整体迁移 |
| `b8b9` | `codex/recovery-b8b9-20260811@f2c6e0b` | clean；旧 PRD/测试意图恢复证据 |
| `b91f` | detached `9942c38` | clean；已有 archive ref，文件树等同产品代码审计源点 `42968ad` |
| `daily-goal-integration` | `codex/daily-goal-integration@5acf375` | clean；Dormant P2 分支 |
| `f24e` | `codex/recovery-f24e-20260811@299e6e1` | tracked 成果已进入 recovery Commit；只剩 Playwright 生成目录，已在 E 盘备份，不作为源码迁移 |

所有 detached Commit 都已被标签、分支或 archive ref 覆盖；当前没有只存在于 detached HEAD 且尚未保护的 tracked 成果。本轮仍不删除任何 worktree。

## 领域级资产选择

### 1. 学习端视觉与页面骨架

首选产品代码来源：`42968ad`（G0 文档进入前的 master 产品代码审计源点）。

保留：

- 当前 EchoFlow 视觉语言和响应式布局；
- Practice 页面外形、字幕区和播放控制区；
- 与词典/生词无关的现有测试 Fixture；
- `docs/ui-issues` 中的视觉问题证据。

必须替换：

- App 内部状态导航；
- 静态课程和全局固定 Cue；
- `SpeechSynthesis` 假播放；
- localStorage/临时状态充当服务端事实；
- 没有行为的按钮和模拟任务状态。

当前 `ContextMenu`、`DictionaryPopover`、本地词典和生词本只服务于 V1 明确不做的词典/生词能力，应标为 P2 历史资产，并从 V1 可达主路径和验收中移除；不能因为它们已在 master 就视为“继续使用”。

路由、深链接、Route Error Boundary 和页面级 Lazy Loading 在现有历史分支中都没有合格实现，G1/G4 从 master 新建。

### 2. 认证、权限和 Auth UI

可参考来源：

- `2eeb078`：手机号/验证码表单、倒计时、loading/error、`role="alert"` 和页面测试意图；
- `43f40ec`：OTP 过期、消费、失败次数，`AuthGuard`、`CurrentUser` 和 owner filter 骨架。

必须重写：

- 使用成熟库签发短期 Access Token；
- opaque、rotating、HttpOnly Refresh Session；
- 服务端撤销、重放检测、限流与审计；
- learner/admin 最小角色和 deny-by-default owner scope；
- 双用户越权负向测试。

明确淘汰：固定验证码、Map 用户、Base64 token、自制 HS256、JSON 返回 refresh JWT、localStorage refresh token、`editor` 角色和未鉴权字幕更新。

### 3. 数据库、契约与迁移

可迁移：

- `DatabaseService` / `DatabaseModule` 的接入方式；
- `@prisma/client` 作为运行时依赖；
- `migrate:deploy` 脚本思想；
- 任务错误码、阶段、失败时间、查询索引和 CAS 认领思路。

必须从空 V1 Schema 重建：

- `User`、`RefreshSession`；
- `UploadSession`、Multipart Part、`MediaAsset` / `MediaObject`；
- `ProcessingRun`、`ProcessingChunk`、`OutboxEvent`；
- `TranscriptVersion`、`SubtitleCue`、`LearningProgress`、`AuditEvent`。

旧 migration 只作字段/索引参考，不直接执行。其 `sizeBytes` 为 32 位 `Int`、上限 2 GiB，且混入公共发布、收藏、翻译、人工审核和云端录音，均与 V1 冲突。

### 4. API、错误和可观测性

可迁移的骨架：

- `{code,message,details,requestId}` 统一错误外形；
- Request ID 生成、响应回传和耗时日志；
- owner 过滤和“无权资源表现为不存在”的模式；
- `f24e` 的稳定 `errorCode`、最近任务查询和前端错误展示思路。

重写要求：

- 全部 V1 API 使用 `/api/v1`；
- 领域错误码覆盖 Prisma 冲突、对象状态和幂等冲突；
- 日志移除 query/敏感字段；
- Request/Correlation/Processing Run ID 传播至 Queue、Worker 和 MOSS；
- Bootstrap 集成测试必须真正加载 Filter、Middleware、Validation 和 CORS。

### 5. 私有长视频上传

可提取的共同资产：

- owner 隔离查询；
- 文件名清洗和 MP4 初步检查；
- 上传完成后的对象 `stat`；
- 私有签名播放 URL；
- `f24e` 的 AbortController、退避、刷新后恢复最近任务；
- 现有 `local-mp4.spec.ts` 作为测试起点。

必须重新实现：

- 8 GiB 架构上限、120 分钟产品保证；
- Multipart Upload Session、Part 校验、7 天续传；
- 一个用户同一时间一个活跃上传；
- 幂等 complete、对象完整性验证、额度与生命周期；
- 数据库状态变更和 Outbox 原子写入。

明确淘汰两条 recovery 的 2 GiB、15 分钟预签名、单 PUT 协议，以及重复 complete 会新建任务的行为。

### 6. Worker 与 MOSS

从 `hardening@0baedef` 参考：

- PostgreSQL CAS 任务认领；
- 稳定 BullMQ `jobId`；
- 持久化外部 MOSS Job ID；
- retryable/terminal 错误分类；
- 每次重试重新打开 Stream；
- 恢复扫描、指数退避、优雅关闭和相关测试场景。

从 `f24e@299e6e1` 参考：

- 单请求 timeout、错误分类和退避；
- 外部 Job ID 复用、幂等键、attempt 信息；
- waiting-dependency、最近任务和前端刷新恢复。

从 `0b51@2c76de7` 参考：

- 任一分片失败就不发布 READY；
- 所有 Cue 与任务终态在同一发布事务完成；
- 严格“完整字幕才对学习端可见”的语义。

必须重新实现：

```text
Outbox
→ ProcessingRun/Chunk
→ 抽取并规范化 16kHz 单声道音频
→ 长音频分片
→ MOSS callback + poll
→ 分片重试和外部 ID 持久化
→ 时间戳合并、顺序/覆盖/完整性校验
→ 完整英文字幕原子发布
```

明确淘汰：整段原视频直接传 MOSS、把 `waiting_review` 当成功、缺片仍发布 READY、模拟 stage output、将数据库完成与 Queue enqueue 分成有崩溃间隙的两步。

### 7. 播放、字幕与影子练习

保留 master 的视觉骨架；从 `0b51` 参考真实 `<video>` 控制、Cue 定位、单句循环、上一句/下一句和相关测试。

G4 必须补齐：

- 真实私有媒体 URL 与字幕绑定；
- 5–10 分钟学习单元；
- 连续播放和单句模式；
- MediaRecorder 录音与回听；
- 最新录音只存本机 IndexedDB；
- 第二次打开的服务端进度恢复；
- 媒体流、计时器和 Object URL 释放。

本地字典、生词本、中文自测和 CourseVocabulary 不得进入 V1 主路径，也不计入 V1 验收；只作为 P2 历史资产保留。

### 8. 暂停的 P2 资产

| 资产 | 来源 | 当前处置 |
|---|---|---|
| 今日目标与庆祝 | `5acf375`、`6c5d68c` | 暂停；以后基于真实 Media/Recording 状态重建 |
| 连续学习 | `6c5d68c` | 只保留日期边界和同步测试思想 |
| 中文翻译/双语字幕 | `40f4ff0`、`2c76de7`、`299e6e1` | V1 淘汰，未来单独立项 |
| CourseVocabulary | `299e6e1` | P2 归档，不迁移 migration |
| 本地词典、生词本、中文自测 | master、`2c76de7` | 从 V1 可达路径移除；P2 历史资产 |
| 收藏、公共课程、推荐 | 多条旧线 | 与私人 V1 冲突，淘汰 |
| AI 发音评分 | 仅需求想法 | V1 不做 |

### 9. 部署与运维

可以迁移 `.dockerignore`、固定依赖版本、liveness/readiness 分离、环境变量拒绝默认值和独立 migration job 的思想。

旧 Dockerfile 和 production Compose 只能作本地集成参考，不能作为生产部署。它们仍使用单机本地卷、root 容器、完整源码/devDependencies、无 TLS/Web/CDN/备份/监控，并把 MOSS 故障升级为 API readiness 失败。

G5 重新建立：静态 Web/CDN、应用运行环境、托管 PostgreSQL、私有对象存储、Redis、独立 MOSS、非 root 瘦镜像、TLS、备份、监控和恢复演练。

## 历史测试的证据边界

硬化支线当前 `lint`、API 3/3、Worker 13/13、Config 4/4、Schema 5/5 和 `prisma validate` 可以通过，但只能证明部分编译和纯函数行为。

这些测试绕开了真实 PostgreSQL、Redis、MinIO 和 MOSS；API 测试没有加载完整 bootstrap；Schema 测试只检查字符串；没有覆盖双用户越权、refresh replay、迁移、Outbox 崩溃点、长视频、7 天续传、录音、删除和恢复。因此“测试绿色”不能提升为生产闭环证据。

`b8b9@f2c6e0b` 还留下两个可迁移的测试/工程意图：

- 20 个并发重复任务最终只执行一次；新实现应改测多 Worker、Outbox 重投、MOSS 响应丢失和数据库唯一事实，不能继续使用进程内 `Set/WeakMap`；
- fresh clone 中共享包必须按依赖图先构建；应通过 workspace/Turbo 拓扑和 CI `build → test` 解决，不用“每次 lint/test 都全仓 build”掩盖顺序问题。

G0 已采用低风险过渡方案：根 `dev/lint/test` 只预构建 `packages/*` 的 5 个共享包，而不是全仓 build。在 `d01c67e` 的隔离 clone 中，手工执行同等顺序已通过 lint/test/build；包含本修复 Commit 的最终 fresh clone 仍待提交后验证。是否启用现有 `turbo.json` 和缓存图留到 G1/CI 治理单独评估。

`b8b9` 的两份旧 PRD 只作需求考古；其中私人素材、Cue 循环、IndexedDB 录音、错误态和分阶段验收原则已被确认版 PRD 吸收。旧 2 GiB/MOV、无复杂续传、翻译发布链、固定验证码和旧 `/api` 接口均已失效。

## 按 Gate 的提取顺序

| Gate | 主来源 | 允许提取 | 必须新建 |
|---|---|---|---|
| G1 | master + hardening 概念 + `2eeb078` UI | DatabaseModule、错误/Request ID 骨架、Auth UI 测试 | Contracts、V1 Schema、正式 Auth/RBAC、真实集成门禁 |
| G2 | master + `f24e/0b51` 上传片段 | owner、文件验证、对象 stat、私有 URL、轮询恢复 | Multipart、7 天续传、幂等 complete、Outbox、播放资产 |
| G3 | hardening + `f24e` 容错 + `0b51` 原子语义 | CAS、错误分类、externalJobId、恢复测试 | Run/Chunk、抽音频、分片、回调轮询、合并校验、原子发布 |
| G4 | master 视觉 + `0b51` 交互 | 播放控制、Cue 导航和测试场景 | 路由、真实媒体/字幕、录音回听、IndexedDB、进度恢复 |
| G5 | hardening 运维思想 | `.dockerignore`、健康检查和配置校验 | 生产镜像、迁移任务、TLS、监控、备份、恢复演练 |

## 选择性迁移协议

每项历史资产迁移都必须：

1. 在任务合同中写明来源 Ref、目标文件、保留思想和拒绝部分；
2. 从 `master` 最新状态创建新 `codex/*` 分支；
3. 优先手工重建或逐文件提取，不覆盖 master 的整套 App/Schema；
4. 先写契约和验收测试，再接实现；
5. 为安全、权限、幂等、恢复和清理增加负向测试；
6. 在 Commit/PR 说明中保留 provenance；
7. 经独立 Reviewer 对照 PRD 判断后才能并入 trunk。

## 暂不执行的清理

在外部 remote 推送并完成全新 clone 验证前：

- 不删除 recovery/archive/hardening/daily-goal 分支；
- 不删除旧 worktree；
- 不 prune reflog；
- 不修改旧标签；
- 不删除 E 盘备份和恢复验证目录。

外部恢复闭环完成后，再由用户明确确认是否归档或清理冗余 worktree/ref。
