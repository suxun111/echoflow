# EchoFlow G3 v2 确定性基础层实施启动合同（草案）

创建日期：2026-08-26
状态：**待用户确认；本文件只冻结建议的首批实现边界，不授权创建 migration、修改代码、启动服务或处理任何媒体。**

在用户明确确认 F1 范围前，**不得直接开始 v2 产品实现**，也不得把本草案当作 Route B、真实对齐或 G3 通过证据。

上游依据：[G3 `g3-transcript-v2` 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)、[实施合同独立复核](G3-TRANSCRIPT-V2-IMPLEMENTATION-REVIEW.md)、[MFA S0 运行证据](G3-V2-MFA-S0-VERIFICATION-EVIDENCE.md)、[执行状态](EXECUTION-STATE.md)。

所属 Gate：G3-B Route B。S0 已关闭，只证明当前设备的本地 MFA 候选可在非私人 Probe 上受控运行；它不授权真实边界对齐、v2 产品代码、私人媒体、G3-C 或 G3 关闭。

## 1. 要解决的问题与交付物

当前 v1 严格合并在无法证明分片交接唯一性时会正确失败关闭；但尚不存在可持久化、可审计、可失败关闭的 Route B 交接证据领域模型。若直接把 MFA 或新逻辑塞进现有 v1 Worker，会破坏 C1/v1 的失败关闭、自动建 run 和原子发布语义。

本合同建议先完成一个**无真实媒体、无网络、无运行态服务**的确定性基础层。它的产物不是“可用转写”，而是为后续实现建立：

1. 数据库级的 handoff identity、唯一性、不可变性和 `H_*` 计数不变量；
2. 纯函数的 strict assessment / final evidence / 发布前校验边界；
3. 可替换的 `AlignmentAdapter` Port 与内存 Fake；
4. 可重复的 PostgreSQL、Fake 与回归测试入口。

## 2. 本草案的授权边界

### 2.1 当前这一步允许做什么

- 只读盘点与本启动合同的起草、独立审查、提交和状态记录；
- 冻结拟议的首批代码范围、验收矩阵、停止条件和待确认决策；
- 不产生任何媒体、对象、真实对齐作业、数据库变更或外部请求。

### 2.2 用户确认后建议授权的第一批 F1 实现

F1 的边界建议严格收敛为“schema + 纯领域 + Fake + 数据库/单元测试”：

- 新增**前向** Prisma/PostgreSQL migration、schema、约束和 trigger；
- 新增纯领域 handoff/evidence validator、计数重算与 proof-digest 注入接口；
- 新增 `AlignmentAdapter` interface 与确定性内存 Fake；
- 新增定向 PostgreSQL 集成测试、Worker 纯函数测试和 v1 回归测试；
- 仅为测试运行**全新、可丢弃**的本地 PostgreSQL 测试库；若测试框架使用 Docker，只能使用独立、可丢弃且专用命名的测试容器/卷，不得启动、修改或复用现有 compose、业务容器、数据库或卷；不在现有开发库、历史 run 或用户数据上试跑 migration，也不上传、下载或读取用户媒体。

### 2.3 F1 明确不包含

- 不修改 `G3_PIPELINE_VERSION`、v1 `ensureTranscriptRuns()`、v1 playback 自动建 run、v1 retry/cancel/recovery 扫描或 `mergeChunkResults()` 行为；
- 不接入真实 MFA、MOSS、GPU、Docker 业务容器、对象存储对象、公开 callback 或任何外部服务；
- 不新增 v2 owner enrollment/API/Web UI/Outbox/Worker processor；这些属于下一份合同；
- 不读取、上传、删除或重跑 C1、B2/B3、私人视频、字幕正文或音频；
- 不改写历史 migration、`.workbuddy/` 或 `showcase/`；不 backfill、重解释、迁移或修改既有 v1/C1 run、Chunk、Version、Cue 或对象。

## 3. 不可变架构与失败关闭规则

- Route B 固定为独立、音频锚定的交接证据层；初始 `H_providerWord = 0`，不得以 Provider `words[]`、静音重切或 v1 overlap-drop 合并路径放行；
- 每个 `(processingRunId, planRevision, logicalHandoffIndex)` 恰有一条 final decision。assessment 与 final evidence 分离，final evidence 不可覆盖；
- `H_total = max(effectiveChunkCount - 1, 0)`；`H_unique + H_r1 + H_unresolved = H_total`；`H_segment + H_providerWord + H_alignment = H_unique + H_r1`；发布前 `H_unresolved = 0`；
- `ProcessingHandoff` 必须冻结当前有效 plan 中同一 run/revision 的左右**相邻**有效 Chunk；不得自连、跨 run/revision、跳过 Chunk 或在 later revision 借用旧 pair。每个 logical pair 的 final evidence 必须一对一且终态不可变；`H_total` 必须从该 revision 的有效 Chunk 重算，只有当前 effective revision 的记录参与 `H_*` 与发布，旧 revision 只能作为不可变历史；
- 最终 accepted evidenceType 白名单仅为 `strict_segment` 和 `boundary_forced_alignment`；`provider_native_word_timing` 初始固定不准入。任意缺失、重复、未分类或与左右身份/窗口/checksum 不一致的证据均失败关闭；
- 只允许 revision `0 → 1`：revision 0 中必须“其他所有 handoff 已 accepted + 恰有一个 strict `ambiguous_segment_handoff`”，且其 repair code 仅可为 `no_textual_suffix_prefix`、`text_match_without_time_overlap`、`text_time_match_with_speaker_conflict`、`multiple_valid_alignments` 或 `weak_single_token_alignment`。该唯一 pair 才能 overlay；alignment 的 insufficient/ambiguous、输入错配、超时/取消、结果损坏或任一 identity/checksum 不一致均不得触发 repair。revision 1 必须重新物化全部当前 handoff，之后仍 unresolved 立即失败关闭，绝不创建 revision 2；
- v1/v2 必须并存隔离；C1、已有 v1 run、旧 ACTIVE 和历史对象不得被 v2 部署、扫描或测试触发；
- proof digest 必须使用独立的 `HANDOFF_PROOF_HMAC_KEY` 抽象，禁止复用 MOSS callback secret；F1 仅允许注入式 Fake，**不授权**新增生产 key 来源、环境变量、版本、轮换或 secret wiring。proof、raw result、对象键/URL、音频、正文、Token、外部 job ID 和 digest 均不得进入普通日志、Outbox、API 或测试快照；F1 的 Adapter Port、Fake 参数和测试 fixture/snapshot 仅可承载非内容 synthetic metadata，不能读取、产生或承载上述私有字段；
- 任何约束失败、取消、旧 lease、重复/迟到结果或发布事务失败均不得产生半套 TranscriptVersion/Cue/Lesson，旧 ACTIVE 始终保持只读可见。

## 4. F1 拟议实现切面

| 切面 | 拟议内容 | 当前锚点与保护 |
|---|---|---|
| 数据库 | 新实体：`ProcessingHandoff`、`HandoffAssessment`、`AlignmentJob`、`HandoffEvidence`；`TranscriptVersion` 的七个 `H_*` 字段；`HANDOFF_EVIDENCING` stage；`HANDOFF_AUDIO` / `ALIGNMENT_RAW` object kind；唯一/外键/check/trigger/不可变终态约束。 | [schema.prisma](../packages/database/prisma/schema.prisma)；只新增前向 migration，不改 `20260813000100_g3_moss_transcript` 或 `20260822000100_g3_plan_revision_repair`。所有新增 `H_*` 列、CHECK 与 trigger 必须只约束 v2 记录或为 v1 提供安全兼容默认；不得重解释、回填或阻断既有 v1/C1 行。 |
| 领域模块 | 新建 handoff model、白名单 failure/decision、identity/checksum/window/revision validator、`H_*` 聚合和发布前断言。 | 参考但不复用 [merge.ts](../apps/worker/src/transcript/merge.ts) 的失败分类；禁止用其 merge 结果当 proof。 |
| Adapter | 新建 `AlignmentAdapter` Port 和内存 Fake，接口仅覆盖 `submit/query/read/cancel` 的确定性测试语义。 | 与 [moss/adapter.ts](../apps/worker/src/moss/adapter.ts) 独立；不把 MFA 模拟成 MOSS `words[]`。 |
| 数据库测试 | 真实 PostgreSQL 集成测试：final evidence 唯一性、不可变性、`H_*` 等式、revision 归属、事务回滚和 v1 兼容。 | 现有 [schema.test.ts](../packages/database/src/schema.test.ts) 只做文本级 schema 断言，不能代替集成测试。 |
| 纯函数/Fake 测试 | strict accepted、strict insufficient → Fake alignment accepted、单 Chunk `H_total=0`、所有 identity mismatch 和 unresolved 失败关闭。 | 可复用 [transcript.test.ts](../apps/worker/src/processors/transcript.test.ts) 的 lease/原子发布思想，不接入其 v1 processor。 |

`HandoffEvidenceCallbackReceipt`、真实对象写入、对象清理器、`TranscriptRunArbiter`、v2 enrollment、Outbox/Worker/API 路由均明确延后；它们需要独立合同，不能在 F1 顺手加入。

F1 的 PostgreSQL 约束至少应覆盖：handoff key 唯一；左右 Chunk 同 run/revision、相邻、有效且不可自连；final evidence 与 handoff 一对一；assessment 非终态而 final evidence 终态不可覆盖；当前 effective revision 才能计入 `H_*`；`H_total` 由有效 Chunk 数重算；accepted evidenceType 只可为 `strict_segment` 或 `boundary_forced_alignment`。这些约束、H 等式和 `H_providerWord=0` 必须在 v2 范围内由数据库和纯领域校验双重证明，不能只靠 ORM 或字符串 schema 断言。

## 5. 需用户确认的高风险选择

S0 不能替代以下确认。为减少下一轮沟通成本，本合同给出推荐默认值；未确认前均不得实施超出 F1 的工作。

| 选择 | 建议默认 | 为什么仍需确认 |
|---|---|---|
| F1 范围 | 仅本合同第 2.2 节的 schema/纯领域/Fake/测试；不接真实媒体或外部服务。 | 涉及新 migration 和本地 PostgreSQL 测试基础设施。 |
| 真实对齐器 | 未来候选为本地 MFA `3.3.9` 与已验证英语模型；F1 只建 Port/Fake，不调用它。 | 真实 boundary audio、词典覆盖、模型许可、submit/query/read/cancel 生命周期尚未冻结。 |
| 网络/回调 | 未来建议纯轮询、无新增公网 callback；F1 不增 endpoint。 | S0 的无 callback 边界不自动等于产品运行态选择。 |
| 私有数据生命周期 | 未来建议 `HANDOFF_AUDIO` 终态后约 24 小时内清理、`ALIGNMENT_RAW` 最长 7 天；F1 不生成这些对象。 | 需要确认对象地点、地域、可读主体、用户删除顺序和隐私告知版本。 |
| 资源与并发 | F1 无模型任务；未来本地对齐默认 CPU、单并发、受控临时盘。 | 真实 5/30/60 分钟运行前需确认 RAM/磁盘/超时/预算及与 MOSS 的资源隔离。 |
| v2 enrollment | 未来必须 owner 显式请求、服务端 allowlist、Idempotency-Key、无 ACTIVE 或已终态失败/取消的资产；F1 不提供入口。 | 这是用户数据处理与隐私告知的真实触发点。 |
| proof key | F1 仅使用注入式 Fake 和非内容 synthetic metadata；不新增真实 key 配置或轮换。 | key 来源、版本、轮换、删除后的可验证性和生产 secret wiring 必须由后续合同单独确认。 |

本节除“F1 范围”外的所有未来建议都只是待决记录：确认 F1 **不等于**确认真实 MFA、对象/媒体留存、地域、回调、并发、预算、密钥或 enrollment 方案。

## 6. F1 确定性验收矩阵

在用户确认并实现后，且接触任何真实样本前，至少需要以下可重复证据：

1. 新 migration 只能前向应用；测试只使用全新可丢弃 PostgreSQL 库，并以 synthetic v1 兼容 fixture 验证现有 v1 migration、schema 与读写保持兼容；不得在现有开发库、历史 run 或 C1 数据上迁移、backfill 或重解释；
2. PostgreSQL 证明 handoff key 唯一、左右 Chunk 同 run/revision/相邻/不可自连、final evidence 一对一、assessment/final 边界和终态不可覆盖；并证明 current revision 归属、`H_total` 重算、`H_*` 非负和两组等式、accepted type 白名单以及 `H_providerWord=0`；
3. strict accepted、strict insufficient 后 Fake alignment accepted、direct Fake alignment accepted 和 single-chunk `H_total=0` 均有确定性测试；
4. 无交接、单 token、多候选、时间/speaker 冲突、窗口越界、混合 granularity、缺字段和任一 identity/checksum 错配均失败关闭，不能发布；
5. 只有“其他 handoff accepted + 恰一个 strict `ambiguous_segment_handoff` + 既有 repair-code 白名单”才可 `0 → 1`；两个歧义、任一 alignment insufficient/ambiguous、任一 identity/checksum 不匹配均不得创建 revision 1 或 revision 2；重复/迟到结果、旧 lease、取消和发布事务失败不复活、不覆盖、不产生半套字幕；
6. Fake adapter 不读取真实 MFA、音频、模型、对象存储或网络；其 Port、参数、fixture 与 snapshot 只含非内容 synthetic metadata，不含私人文本/媒体、raw result、对象键/URL、digest 或真实/Fake secret；
7. v1 自动 enrollment、MOSS callback、ACTIVE transcript 读取、owner 隔离和现有 Worker/API 回归保持通过；
8. 定向 TypeScript、数据库集成、F1 单元/Fake 测试、全仓 lint/test/build 都通过；审核后的最终 Commit 经独立 Reviewer P0/P1=0。

这些证据只证明 F1 合同实现正确，不证明 MFA 对真实播客准确、真实 handoff 已解决、B2/B3/G3-C 通过或 G3 关闭。

## 7. 停止线与精确后续

立即停止并交还用户，不自行扩大范围：

- 需要创建真实 MFA Adapter、下载/调用模型、生成或处理 boundary audio、写入对象存储、决定 raw evidence 保留或清理；
- 需要启动实际 MOSS、Docker 业务服务、公开 callback、外部网络传输或访问任何私人媒体；
- 需要实现 `TranscriptRunArbiter`、v2 enrollment、API/Outbox/Worker 路由或改变 v1 retry/cancel/recovery；
- 需要新增生产 proof key 的来源、环境变量、版本、轮换或 secret wiring，或让 Adapter/Fake/fixture/snapshot 承载 raw 音频、文本、raw result、对象键/URL 或 digest；
- 需要更改用户删除、隐私告知、地域、预算、并发、密钥来源或公开接口。

若你确认本合同的 **F1 范围及仅限测试的基础设施边界**，我会先将本文件状态改为“已确认”，再创建独立实施分支/工作树，逐项完成 F1 的 schema、纯领域、Fake 和测试；第 5 节除 F1 外的建议仍仅是待决记录，不构成本次确认。每次审核后绑定 Commit。F1 完成后，下一份合同才讨论 `TranscriptRunArbiter`、显式 enrollment、v2 Worker/Outbox/API 路由和受控对象生命周期。
