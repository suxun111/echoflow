# EchoFlow G3 `g3-transcript-v2` 实施合同

确认日期：2026-08-25
状态：独立架构、代码边界与隐私/生命周期复核已通过（P0=0、P1=0）；未选择具体对齐器、未开始代码/迁移、未启动 Docker/模型、未处理媒体。复核结论见 [G3 v2 实施合同独立复核](G3-TRANSCRIPT-V2-IMPLEMENTATION-REVIEW.md)。
所属 Gate：G3-B 的补充实施设计，不是新 Gate；不关闭 G3，不进入 G3-C，不解冻 G4/G5。
代码基线：`codex/g3-moss-transcript-20260813@2142180`。
关联：[G3-BE1 跨分片交接证据增强任务合同](G3-BE1-HANDOFF-EVIDENCE-TASK-CONTRACT.md)、[BE1 独立复核](G3-BE1-INDEPENDENT-REVIEW.md)、[G3 任务合同](G3-TASK-CONTRACT.md)、[G3-B 分片交接能力基准合同](G3-B-SEGMENT-HANDOFF-BENCHMARK-CONTRACT.md)、[执行状态](EXECUTION-STATE.md)、[V1 PRD](EchoFlow-V1-PRD.md)。

## 1. 唯一决策与本轮边界

`g3-transcript-v2` 选择 **路线 B：独立、音频锚定的边界对齐证据层**。它要解决的不是“让两段文本更像”，而是在最终有效计划的每个相邻 Chunk 之间，建立可重放、可审计、可失败关闭的唯一交接决定。

当前固定 Gateway 经验证只输出带时间的 `segments`，没有可消费的 Provider 原生 `words[]`；因此路线 A 不是 v2 的条件分支。若未来 Provider 能力改变，必须先走新的非私人能力探针、独立合同和新 pipelineVersion，不能把 `words?.length > 0` 当作放行。

本轮交付物仅为本合同及其独立审阅。它不授权：

- 选择、下载、购买或运行任何具体强制对齐器/模型；
- 数据库迁移、代码、对象、Docker、队列、回调路由或网络配置变更；
- 上传、读取、删除、重跑 C1 或发送任何私人媒体/字幕；
- 30/45 秒能力探针、B2/B3、G3-C、60 分钟运行、播放器、工作流接入或用户可见校对功能。

## 2. 冻结事实与不可放宽规则

- C1 的 8 个有效 Chunk 在唯一一次 revision 1 后仍以 `transcript_incomplete` / `no_textual_suffix_prefix` 失败关闭；无 Version、ACTIVE 或 Cue。它不得自动重跑，也不得被 v2 自动 enrollment。
- `g3-transcript-v1` 的既有 run、Chunk、ASR 原始结果、revision、错误语义和 ACTIVE 字幕均不可回填、改写或按 v2 重新解释。
- v1 的 `mergeChunkResults()` 会按时间丢弃重叠词，不能作为 v2 的 strict proof validator；仅类型存在 `MossResult.words[]` 也不表示 Gateway 提供了真实原生词级时间。
- 任一没有唯一证据、输入身份不匹配、外部任务失败、取消、旧 lease 或发布事务失败，都必须失败关闭；无旧 ACTIVE 时零 Version/零 Cue，有旧 ACTIVE 时旧版继续可读。
- 仍只允许 `revision 0 → 1` 的一次受控 overlay repair；不得创建 revision 2、随机增大 overlap、临场静音重切、LCS 放宽、speaker/embedding/attention 相似度、人工字幕或文本猜测。
- V1 时长上限仍为 `0 < durationMs ≤ 3_600_000`（≤60 分钟）；本合同不构成任何真实时长、准确率、吞吐、成本或 G3 通过证据。

## 3. 证据路线与准入策略

### 3.1 白名单类型

每个最终被接受的 handoff 必须且只能属于下列一种 `evidenceType`：

```text
strict_segment
boundary_forced_alignment
```

`provider_native_word_timing` 在 v2 初始值中固定为不准入，故 `H_providerWord = 0`。新增类型必须先更新 BE1、v2 合同、schema 白名单、计数等式与测试，不能在实现中悄悄加入。

`strict_segment` 只能由新的、可持久化的严格 segment validator 产生；它必须复现 BE1 的唯一文本/时间/speaker 判定和失败类，不能复用现有“字级重叠后丢弃”的路径。

当 `strict_segment` 无法产生唯一强证据时，进入 `boundary_forced_alignment`。对齐层只处理受控边界窗口，并以声学对齐验证候选文本与该窗口的关联；它不是整段视频的第二次转写，也不是文本相似度服务。

严格 segment 的失败首先只形成不可变、**非终态** `HandoffAssessment`，不得抢占 final `HandoffEvidence`。只有 strict assessment 为 accepted 时才物化 final `strict_segment` evidence；assessment 为 insufficient/ambiguous 时可交给 `AlignmentJob`，后者的确定性结果才写入唯一 final `boundary_forced_alignment` evidence。这样“strict 失败 → alignment accepted”不会覆盖或伪造历史，也不会让一个预先写入的 strict `ambiguous` 阻塞对齐成功。

### 3.2 对齐适配器 Port（尚不选择实现）

未来具体实现必须满足内部逻辑操作：

```text
submitBoundaryEvidence(input) -> accepted external identity
queryBoundaryEvidence(identity) -> non-terminal or terminal status
readBoundaryEvidence(identity) -> private raw evidence result
cancelBoundaryEvidence(identity) -> best-effort cancellation
```

`input` 只能包含服务端生成、精确绑定的最小信息：

```text
pipelineVersion / schemaVersion / alignmentPolicyVersion
服务端私有的 run + effective revision 绑定（对外仅传 opaque correlation handle）
相邻左右 Chunk 的不可变身份、输入与 ASR 结果版本/checksum
规范化音频的精确版本/checksum
预登记的绝对边界窗口 [startMs, endMs)
对齐器方法、模型 revision 与配置 digest
稳定 idempotency key
```

对外的 opaque correlation handle 必须是随机、不可反查数据库的值，不得编码 owner、asset、run、revision、chunk 或对象信息。它不得包含标题、原文件名、用户资料、完整视频、完整规范化音频、永久对象存储凭据、客户端声明的 owner/run/chunk identity，或未限定版本的“最新对象”。

如果选定算法需要候选文本，具体实现必须在 EchoFlow 服务端从精确版本的左右 ASR raw 中裁剪最小边界候选，并绑定窗口与 candidate-generation policy。对齐器只能通过短期、精确版本、无日志的私有载荷或对象读取该最小文本；不得读取完整 ASR raw、完整字幕或由 Adapter 自行决定的额外字段。每一类离开 EchoFlow 的音频/文本字段、TTL、权限和处理地点都须在实施启动合同中逐项声明。

实际提供方、模型许可证、网络/地域、传输方式、资源预算和精确保留期属于第 12 节的用户确认点。

### 3.3 `accepted` 的最低条件

一个 `boundary_forced_alignment` 只有同时满足以下全部条件才可为 `accepted`：

1. 恰有一个 strong candidate，且候选不是单 token、仅文本耗尽或仅 confidence；
2. 至少有两个独立强锚点，时间单调、范围在登记窗口内，并跨越/覆盖实际交接边界；
3. 每个锚点都与左右 ASR 原始结果、规范化音频版本/checksum、当前有效 revision、方法/模型/配置 digest 精确一致；
4. 私有 raw evidence 明确给出可确定消费的边界所有权或真实对齐 cue，不允许 merge 层用猜测补齐；
5. 没有时间冲突、speaker 冲突、多解、缺字段、范围越界或混合未验证 granularity。

数值阈值、锚点定义、覆盖规则和候选上限必须收敛为一个版本化 `alignmentPolicy`。实现前须将实际值冻结进配置 digest；失败后不得以变更阈值伪装同一次 retry。

## 4. `HandoffEvidence v1`、逻辑 handoff 与计数

### 4.1 逻辑 handoff

对当前有效 plan 的有序 Chunk 列表，逻辑 handoff 为相邻位置 `(i, i + 1)`：

```text
H_total = max(effectiveChunkCount - 1, 0)
```

单 Chunk 的 `H_total=0`，不需要对齐任务，但仍必须通过所有非 handoff 的字幕完整性校验。

每个 plan revision 都物化该 revision 的所有逻辑 handoff。revision 1 中，如果某个 handoff 的左右有效 Chunk 输入/结果身份与 revision 0 完全相同，可创建新的 immutable re-attestation，引用旧 raw evidence 的版本/checksum；若任一身份变更，必须生成新的对齐证据，绝不复用旧 proof。这样每个当前有效 handoff 始终有一个绑定当前 revision 的最终记录。

唯一性范围固定为 `(processingRunId, planRevision, logicalHandoffIndex)`：每个范围恰有一条 final decision。旧 revision 的 assessment/evidence 只在资产未删除且仍处于已声明审计保留期内保持不可变历史；用户删除、对象生命周期清理和 proof key 到期优先于历史保留。只有当前 active/effective revision 的 final evidence 参与 `H_*`、MERGING 和发布。对齐服务不可用、输入错配、结果损坏或取消时，也必须写入 final `decision=insufficient` 的白名单 code（如 `alignment_unavailable`、`alignment_input_mismatch`、`alignment_result_invalid`、`alignment_cancelled`）；没有 raw result 时不得伪造 raw checksum。

### 4.2 计数不变量

发布与脱敏状态只使用从持久化 handoff 记录重算的计数：

```text
H_unique + H_r1 + H_unresolved = H_total
H_segment + H_providerWord + H_alignment = H_unique + H_r1
H_providerWord = 0  # v2 初始冻结值
H_unresolved = 0    # 发布前提
```

- `H_unique`：最终有效 handoff 首次在 revision 0 得到 accepted 的数量；
- `H_r1`：最终有效 handoff 首次在允许的 revision 1 得到 accepted 的数量；
- `H_unresolved`：最终有效 handoff 没有 accepted final evidence 的数量；
- `H_segment`、`H_alignment`：按最终 accepted evidenceType 聚合；
- 每个逻辑 handoff 恰有一条 final decision，任何缺失、重复或未分类记录均阻止发布。

七个 `H_*` 汇总必须同 TranscriptVersion 一起持久化，供审计、API 脱敏展示和发布事务重算；迁移必须用数据库 `CHECK` 或同等强度数据库约束固定非负值、两组等式与 v2 的 `H_providerWord=0`。不以进程内 Map、队列长度、UI 百分比或普通日志作为事实源。

### 4.3 私有证据信封

`HandoffEvidence v1` 的私有持久化字段至少包括：

```text
schemaVersion / processingRun / pipelineVersion / effective planRevision
logical handoff index / previousChunk / nextChunk identity
normalized audio、左右 ASR 结果、raw evidence 的对象版本/checksum identity
evidenceType / method provider、version、model revision、alignmentPolicy/config digest
absolute evidence window / non-content candidate、strong-candidate、coverage metrics
decision = accepted | insufficient | ambiguous
white-listed decisionCode / createdAt / verifiedAt
proofKeyVersion / proofDigest
```

对象 key、版本 ID、数据库 ID、原始内容 checksum、正文、token、词级时间、候选文本、音频字节与原始 provider payload 都是私有输入事实，不得进入 owner API、普通日志、Trace、Outbox payload、callback body、错误详情、Git、Obsidian 或截图。

`proofDigest` 必须使用独立的 `HANDOFF_PROOF_HMAC_KEY` 服务端 Secret、版本化的 HMAC-SHA256，对私有规范化信封计算；不得复用 MOSS callback Secret，也不得使用可由候选文本、音频字节或 raw ASR/对齐输出直接验证的普通内容 hash。启动时必须校验当前 key/version 存在；未知 key version 或缺失 key 一律拒绝验证。轮换时旧 key 只能保留到对应 evidence 保留期结束，随后连同旧 evidence 清除。其 preimage 不可对外读取；digest、本体 Secret 和 key version 均不能作为 API、普通日志或 Trace 字段，并须有脱敏/轮换回归测试。

## 5. 独立领域模型与前向迁移要求

实际实施时必须新建前向 Prisma/PostgreSQL migration；本轮不创建 migration。最小领域模型为：

| 实体 | 责任与不可变边界 |
|---|---|
| `ProcessingHandoff` | 每个 run/revision/逻辑相邻 pair 的工作单元；创建时冻结左右 Chunk、音频和 ASR 身份，独立维护状态、lease、取消栅栏与 final evidence 引用。 |
| `HandoffAssessment` | strict segment 或其他预判的不可变、非终态评估快照；记录白名单结果，不与 final evidence 混用。 |
| `AlignmentJob` | 路线 B 的持久异步提交单元；独立维护幂等键、attempt、外部 job ID、轮询、取消、错误、lease 与重启恢复；不得复用 `ProcessingChunk`。 |
| `HandoffEvidence` | 每个 `ProcessingHandoff` 唯一、终态、不可覆盖的私有证据快照；可表达 `accepted`、`insufficient` 或 `ambiguous`，并承载第 4 节字段。 |
| `HandoffEvidenceCallbackReceipt` | 仅在具体对齐器采用回调时创建；独立 eventId/nonce/payload hash 唯一性，不能复用 `MossCallbackReceipt`。 |

至少需要下列数据库不变量：

- `ProcessingHandoff` 唯一键覆盖 `processingRunId + planRevision + logicalHandoffIndex`，并强制左右 Chunk 属于同一 run、相邻、有效且不可自连；
- 每个 `ProcessingHandoff` 最多一个 final `HandoffEvidence`；已 verified/rejected 的身份、raw result、方法配置和 decision 不得覆盖；
- `AlignmentJob` 的稳定 idempotency key 覆盖 pipeline、run、revision、logical pair、左右输入/结果 identity、音频 identity、窗口、方法/模型/配置 digest；任何材料性变化必须成为新的 job identity，不能当 retry；
- `AlignmentJob` 仅对 `alignment_unavailable`、`alignment_timeout`、`alignment_rate_limited` 和受控传输中断重试；最大提交次数固定为 3，`nextAttemptAt`、指数退避和抖动必须持久化。提交响应丢失时先按同一 idempotency identity 查询，不能盲目新建外部任务；次数耗尽、非重试错误、取消或输入错配必须恰好写入一条 `decision=insufficient` 的 final evidence，不能继续排队、创建新 revision 或重置身份；
- accepted evidence 必须齐全绑定输入、ASR、方法、窗口、raw object 与 proof identity；任一 checksum/version 不匹配拒绝；
- 所有新实体都具备 status、attempt、lease/fencing、取消和迟到结果防护；外部任务成功不等于 evidence accepted；
- `ProcessingHandoff`、`HandoffAssessment`、`AlignmentJob`、`HandoffEvidence` 与 receipt 的身份和终态不可变性必须由 PostgreSQL trigger、受限 transition 函数或同等数据库级防护实现，不能只依赖应用层；
- `TranscriptVersion` 必须保存第 4.2 节的七个 `H_*` 汇总，且发布代码在事务内重算/验证等式；
- 扩展 `MediaObjectKind` 以区分私有 `HANDOFF_AUDIO` 与 `ALIGNMENT_RAW`，并由受控对象事实记录其版本、checksum 和生命周期；
- 新增 `HANDOFF_EVIDENCING` ProcessingStage，位于所有有效 ASR Chunk 成功之后、`MERGING` 之前。

## 6. v1/v2 并存、enrollment 与版本路由

不得把全局 `G3_PIPELINE_VERSION` 从 v1 直接替换为 v2。它当前驱动 G2 播放完成后的自动建 run、PLAYABLE 扫描、恢复、取消、Worker 认领与 MOSS 幂等键；直接替换会意外触发历史私人媒体。

所有 v1 自动建 run 与 v2 enrollment 必须经过同一个按 `mediaAssetId` 串行化的 `TranscriptRunArbiter`。在同一数据库事务中：取得 advisory lock（或等价持久化锁）→ 重新读取该媒体全部 G3 run 与 ACTIVE 状态 → 按下列策略判定冲突 → 创建唯一 run 与对应 Outbox。Worker 首次认领、恢复与发布前也必须重新确认该媒体的 pipeline ownership；`TranscriptVersion` 的 ACTIVE 唯一约束只能作为最后防线，不能替代该 arbiter。

v1 的显式 retry/re-queue、v2 enrollment/retry，以及各自 Outbox 创建也必须先经过该 arbiter；若另一 pipeline 已持有该媒体，API 必须在写 Outbox 前返回稳定 conflict，不能先接受请求再由 Worker 静默丢弃。cancel 仅能针对服务端已解析出的准确 pipeline/run 执行，并同样在锁内建立取消栅栏。

v2 实施必须引入服务端版本注册与显式 enrollment：

1. 默认关闭；部署、定时扫描和 PLAYABLE 自动发现不得创建 v2 run；
2. v1 run 仍可恢复、取消、读取，且 C1 永不因 v2 部署或扫描自动重新处理；
3. v2 仅可在 owner 显式请求、受服务端 allowlist 控制且带 Idempotency-Key 的情况下创建。事务内必须从认证上下文验证 owner、`PLAYABLE`、未删除、Worker 确认时长 `≤60 分钟` 与当前字幕状态；客户端不得传入任意 pipelineVersion；
4. 初始 v2 enrollment 只允许没有 ACTIVE TranscriptVersion 的新资产，或 v1 已终态失败/取消且没有 ACTIVE 的资产；已有 v1 ACTIVE 的升级/重转写另立合同，不得静默 supersede；
5. 同一媒体不得并行运行两个可发布的字幕 pipeline。v2 创建前必须检查 v1/v2 的活跃 run 与 ACTIVE 状态；冲突返回稳定错误码而非排队竞争；
6. v2 事件名、job ID、恢复扫描、取消扫描、Adapter 幂等命名空间和状态投影必须独立于 v1。

对于已有 v2 run 的 enrollment，服务端必须幂等地返回该 run。owner retry 只可恢复同一 v2 run，且所有输入、模型、alignmentPolicy/config digest 完全不变；材料性改变必须使用新的 pipelineVersion（例如 v3）并走新的确认合同，不能删除、覆盖或重解释 v2 evidence。retry/cancel 必须由服务端按明确 pipeline 选择该 run，绝不能按“最新 run”猜测。

owner 的显式 enrollment 只是运行触发条件，不等同于对新增外部处理的知情确认。对齐器、数据处理地点、最小音频/文本字段、留存和删除语义确定后，必须更新相应隐私告知并将其版本绑定到 enrollment；未确认时不得向外部服务发送内容。

`GET /api/v1/media-assets/:mediaAssetId/transcript` 继续只读当前 ACTIVE Version。v2 BUILDING/REJECTED evidence 不得遮蔽已有 ACTIVE，也不对 owner、管理员或其他用户开放原始 proof。

## 7. Worker 状态机、repair 与发布

v2 运行的高层顺序为：

```text
PLAYBACK_READY
→ AUDIO_EXTRACTING
→ CHUNKING
→ TRANSCRIBING
→ HANDOFF_EVIDENCING
→ MERGING
→ CUE_SEGMENTING
→ VALIDATING
→ TRANSCRIPT_READY
```

在 `HANDOFF_EVIDENCING`：

1. 重新读取当前有效 plan 的全部 Chunk，验证每片 `SUCCEEDED`、ASR raw 对象版本/checksum 与统一模型版本；
2. 为每个逻辑 handoff 创建/恢复独立工作单元，先生成不可变但非终态的 strict segment `HandoffAssessment`；assessment accepted 时物化 final `strict_segment` evidence，assessment insufficient/ambiguous 时才由 `AlignmentJob` 提交受控边界对齐；
3. 对齐器结果必须先保存为私有、不可变 `ALIGNMENT_RAW` 对象并校验 checksum，再由纯确定性 validator 创建 final `HandoffEvidence`；
4. 只有全部 final decision 为 accepted 才进入 `MERGING`。

若 revision 0 存在 unresolved：仅当所有其他 handoff 已 accepted，且恰有一个由 strict segment `HandoffAssessment` 产生的 `ambiguous_segment_handoff` 时，才允许创建一次 revision 1 overlay。其 repair code 必须属于既有 `TranscriptRepairDiagnostic` 白名单：`no_textual_suffix_prefix`、`text_match_without_time_overlap`、`text_time_match_with_speaker_conflict`、`multiple_valid_alignments` 或 `weak_single_token_alignment`。选择规则固定为该唯一 pair；`boundary_forced_alignment` 的 insufficient/ambiguous、输入错配、外部失败或取消均永不 repair-eligible，直接失败关闭。revision 1 必须重新物化并验证当前有效 plan 的全部 handoff，之后仍 unresolved 立即 `transcript_incomplete`，绝不创建 revision 2。

发布事务必须在同一数据库事务内重新验证：

```text
run 仍由当前 lease 持有且未取消
+ 当前有效 revision 与 Chunk 身份未变化
+ 每个 required Chunk 均 SUCCEEDED，raw ASR version/checksum 有效
+ 每个逻辑 handoff 恰有一个 current-revision accepted evidence
+ 所有 evidence 的音频、ASR、窗口、方法、模型与配置 identity 匹配
+ H_* 等式成立且 H_unresolved = 0
→ 创建 BUILDING TranscriptVersion / Cue / PrivateLesson 绑定
→ 初始 v2 enrollment 场景确认无旧 ACTIVE 后创建唯一 ACTIVE
→ run 置为 SUCCEEDED / TRANSCRIPT_READY
```

任一步失败则回滚；不允许半套 Version/Cue/lesson，不允许迟到 callback、旧 Worker、重复消息或取消后的结果发布。

## 8. API、回调、权限、日志与生命周期

### 8.1 状态与权限

- owner 状态接口至多显示脱敏 stage、`H_total/H_unique/H_r1/H_unresolved`、已完成 handoff 数、总数、更新时间和稳定错误码；没有假百分比、ETA、proof、raw object、外部 job ID、正文或词级信息；
- 所有 evidence/alignment 访问从数据库的 `ProcessingRun → MediaAsset.ownerId` 派生，不能信任客户端、callback 或 provider 提供的 owner/run/revision/pair；
- owner、管理员和其他用户均不可读取 BUILDING/REJECTED evidence，管理角色默认也没有私人媒体、音频或 raw result 的读取权；
- `GET transcript` 的 ACTIVE-only 语义不改变。

### 8.2 可选异步 callback

MOSS 的 v2 ASR callback 可以沿用既有 MOSS 安全入口，但服务端必须从已持久化的 `ProcessingChunk → ProcessingRun` 解析 pipelineVersion，并投递显式 `media.transcript_process.v1` 或 `media.transcript_process.v2`（或等价的、不可混淆的 job discriminator）。不得信任 callback 声称的版本，也不得把未知/未标记事件兜底交给 v1 processor。

具体对齐器若选择回调，必须新增独立 endpoint 和 receipt，例如：

```text
POST /api/v1/integrations/handoff-evidence/callback
```

签名规则复用现有安全模式但不复用 Chunk receipt：HMAC 覆盖 `timestamp + nonce + rawBody`、常量时间比较、短时间窗、eventId 与 nonce 持久化唯一、严格 schema、乱序/重复/迟到幂等。body 只允许 opaque external job identity、预期 idempotency identity、状态、发生时间和白名单错误码；禁止 URL、正文、token、raw result、对象 key 与原始 provider error。

若具体对齐器选择纯轮询，实施必须显式声明“不新增 public callback”；轮询结果仍走相同的 checksum、取消、lease 和发布 fencing。

### 8.3 私有对象和清理

| 数据 | 最低合同规则 |
|---|---|
| `HANDOFF_AUDIO` | 私有、精确对象版本、仅登记边界窗口；成功/失败/取消终态后目标约 24 小时内清理。 |
| `ALIGNMENT_RAW` | 私有、不可变、精确对象版本；保留时钟从对象上传成功、外部任务终态或首次本地可访问三者中最早的可确定时间起算，最长 7 天清理。 |
| Worker/aligner 临时文件 | 每任务隔离目录、finally 清理；不写共享卷、镜像层、队列或普通日志。 |
| HandoffEvidence 脱敏信封 | 仅在资产/字幕存在且审计必要时保留；用户删除后删除所有可关联信封，只留不含私人内容、不可关联资源的最小 tombstone。 |
| callback/idempotency receipt | 仅为重放保护保留预先声明的有限期限；删除后不得映射为可读资源。 |

清理必须以 run、revision、对象版本和当前 fencing 为条件；不得按 prefix、最新对象或模糊名称删除。上传后未绑定 evidence、PENDING reservation、删除/取消后迟到上传的孤儿对象必须立即进入同一版本 fenced 清理队列，并不晚于对象创建后 24 小时清理。清理必须同时删除对象版本与对应私有对象事实，不能只删 bucket 内容或只标记数据库行。

用户删除顺序为：撤销读权限与签名 URL → 持久化删除/取消栅栏 → 尽力取消外部对齐任务 → 阻止迟到回调复活 → 删除 `ProcessingHandoff`、`HandoffAssessment`、`AlignmentJob`、`HandoffEvidence` 与 receipt 中所有可关联媒体、owner、run、对象、checksum、外部 job 或 proof 的关系及对象版本 → 保留最小无内容 tombstone。若仍需 replay 防护，只可保留不可反查资源的 HMAC event/nonce tombstone，且最长 30 天；不得保留原 event、外部 job、idempotency、owner/run/object/proof identity，也不得再拉取 raw result。实际精确保留期、数据地点和外部服务策略须在实施前由用户确认。

bucket 必须私有、禁止匿名列举/读取。任何 URL/对象传输均绑定精确版本、最小范围和短期 TTL，使用 TLS 与服务间网络 allowlist；对齐器不获得 EchoFlow 的数据库、队列或永久对象存储凭据，且其 debug dump、请求体记录和二次留存默认禁用。

### 8.4 日志与错误 allowlist

普通日志、指标、Trace、API error 与 Outbox payload 只允许稳定错误码、stage、非内容聚合计数、耗时、方法/模型/配置版本和内部 correlation/request identity。禁止正文/token、音频、raw result、object key/version、签名 URL、外部 job ID、用户/媒体数据库 ID、callback body、payload hash、provider 原始错误与 proofDigest。

对齐 HTTP debug、请求/响应 dump、异常自动序列化、ORM 查询日志和 `error.message` 透传默认关闭或统一 sanitize。所有脱敏规则必须用合成 sentinel 测试验证，不能用私人内容测试。

## 9. 实施切面（实现前不执行）

| 切面 | v2 必需改动 |
|---|---|
| 数据库 | 前向 migration、新实体/枚举/约束、`H_*` TranscriptVersion 汇总、对象类型和 stage。 |
| Worker | v2 专用 processor/版本调度、handoff evidence validator、AlignmentJob、恢复、取消、清理与原子发布重验。 |
| 队列/Outbox | v2 独立 event/job 名、allowlist、job ID、扫描与 cancellation；MOSS ASR callback 必须从持久化 Chunk→run 映射 pipelineVersion，再投递显式 v1/v2 job，禁止 callback 声称版本或无条件兜底到 v1 processor。 |
| 存储 | 复用版本化基础能力；新增受控 boundary/raw evidence 上传、下载、校验与版本 fenced 清理。 |
| API/contracts | 服务端 enrollment、v1/v2 状态优先级、脱敏 handoff 计数、可选新回调签名契约；ACTIVE transcript 接口保持只读。 |
| 合并 | 新 evidence-aware merge/validator；禁止复用 v1 word overlap-drop 和将静音 re-cut 当 proof。 |
| 测试 | 本合同第 10 节矩阵、迁移、API/DB/Fake/恢复/隐私/回归。 |

## 10. 确定性验收矩阵

实现后、接触任何新真实样本前，必须通过：

1. strict segment accepted、strict assessment 失败后 boundary alignment accepted、boundary alignment accepted、单 Chunk `H_total=0`；
2. 无交接、单 token、多候选、时间/speaker 冲突、窗口越界、混合 granularity、缺字段均失败关闭；
3. run、revision、logical pair、Chunk、音频、ASR、raw evidence、模型、方法、配置任一 identity/checksum 错配均不可发布；
4. Handoff 的唯一性、不可变 final evidence、`H_*` 两组等式、revision 0/1 归属和 `H_unresolved=0` 发布前提；
5. `0 → 1 → FAILED` 不产生 revision 2；v1 原始 Chunk/对象/Job 与 v2 的对象/状态隔离；
6. 对齐 submit 响应丢失、重启、重复投递、旧 lease、重复/迟到 callback、取消、对象清理和用户删除均不复活或发布；
7. proof 成功但发布事务失败时零半套 Version/Cue/lesson，旧 ACTIVE 不变且总是最多一个 ACTIVE；
8. v1/v2 并存、显式 enrollment、禁止自动 PLAYABLE 扫描、status/retry/cancel 路由与恢复扫描；
9. 双 owner/admin 负向访问、HMAC 篡改/重放、proof key 缺失/未知版本/轮换、API/error/log/Outbox/receipt/proof 脱敏 sentinel、删除后 receipt tombstone 不可映射；
10. 定向 TypeScript、数据库集成、Fake MOSS/Alignment、API/Worker 测试、lint、全仓 test/build 和独立 Reviewer。

这些 Fake/合成/数据库证据只证明实现符合合同，不证明对齐器可用、真实 MOSS 交接已解决、B2/B3 通过或 G3 可以关闭。

## 11. 本合同的验收与停止条件

本合同完成的定义是：路线 B、v1/v2 并存、独立领域模型、数据最小化、状态/发布不变量、确定性测试和确认停止线均已明确；并经独立架构/代码边界审阅，P0/P1 为零。

必须停止并交还用户的情况：

- 选择具体对齐器、模型、许可证、供应商、网络/地域或是否新增 callback；
- 确定真实的 boundary audio/raw result 数据保留期、存储位置、临时盘、预算、GPU/CPU 或外部传输方式；
- 创建 migration、安装依赖、启动 Docker/服务、发送任何媒体、运行能力探针、B2/B3 或 C1；
- 需要改变用户删除、隐私声明、跨境处理、对象生命周期或公开接口边界。

## 12. 精确恢复点与用户确认清单

下一项不是实现，而是由用户确认以下选择后，再单独创建“v2 实施启动合同”：

1. 具体边界对齐器：本地还是第三方、模型/许可证、是否可固定 revision、是否满足 `submit/query/result/cancel`；
2. 数据处理边界：最小 boundary audio/raw result 的传输方式、网络/地域、是否新增 public callback、外部服务是否训练或二次留存；
3. 生命周期与资源：精确保留期、对象存储、临时盘、GPU/CPU/RAM、预算上限和并发上限；
4. 能力探针：新选、非私人、许可明确的 30–45 秒英语样本，探针资源上限和清理方案；
5. 后续真实 B2/B3：逐次重新授权样本、配置和资源，绝不自动使用 C1。

在这些选择获得确认前，保持现有 v1 严格失败关闭；不得因为本合同存在而声称交接证据已具备或启动任何运行态工作。
