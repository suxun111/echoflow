# EchoFlow G3 v2 运行态实施启动合同

创建日期：2026-08-26
确认日期：2026-08-26
状态：**已确认并进入收尾验证。用户确认 F2 范围：仅实现 TranscriptRunArbiter、显式 enrollment、v2 Worker/Outbox/API 路由、Fake 和确定性测试；不接入真实 MFA/MOSS、私人媒体、对象存储实际读写、外部网络、生产密钥或公网 callback。2026-08-28 用户进一步确认“方向一”：F2 的成功验收只覆盖 strict evidence → `MERGING`；Fake 对齐只覆盖受控生命周期和无 raw 身份时的失败关闭。F2 不伪造 raw object identity，不物化 `boundary_forced_alignment` final evidence，不发布字幕。第 3 节的高风险选择仍全部待决。**

本确认只冻结 F2 的运行态实现边界（仅 Fake/测试基础设施），不授权真实对齐器、私人媒体、对象存储实际读写、生产密钥或公网 callback。F1 纯领域测试的 marker 例外不授权 F2 runtime 读取、产生或持久化任何对象身份。

上游依据：[确定性基础层启动合同](G3-V2-DETERMINISTIC-FOUNDATION-START-CONTRACT.md)（F1 已确认并实施）、[G3 `g3-transcript-v2` 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)、[MFA S0 运行证据](G3-V2-MFA-S0-VERIFICATION-EVIDENCE.md)、[执行状态](EXECUTION-STATE.md)。

所属 Gate：G3-B Route B。F1 只交付了确定性基础层（schema/纯领域/Fake/测试）；F2 只把受限的 metadata state machine 接入隔离运行态。它仍不授权真实对齐器接入、私人媒体处理或 G3-C。

## 1. 要解决的问题与交付物

F1 建立了可持久化、可审计、可失败关闭的 handoff/evidence 领域模型与确定性测试，但尚未存在可隔离验证的：

1. `TranscriptRunArbiter`——v1/v2 互斥 enrollment 的串行化仲裁与稳定冲突语义；
2. v2 显式 enrollment——owner 显式请求、服务端 allowlist、Idempotency-Key、状态前置校验；
3. v2 Worker/Outbox/API 路由——`HANDOFF_EVIDENCING` 的元数据状态机、`AlignmentJob` 的 submit/query/read/cancel/重试/恢复/取消围栏、独立 job 判别与恢复扫描；
4. 受控对象生命周期策略——保证 F2 不创建、读取或删除 `HANDOFF_AUDIO` / `ALIGNMENT_RAW`，既有真实 v1 cleanup scanner 也不能触及 v2。

本合同的 F2 实现只交付 Fake/测试基础设施；真实对象生命周期、对齐器和发布仍需下一份合同。

## 2. 本草案的授权边界

### 2.1 已确认且已实施的 F2 范围

- `TranscriptRunArbiter`：按 `mediaAssetId` 串行化（advisory lock + 事务内重读 + 冲突判定 + 唯一 run/Outbox 创建），覆盖 v1 自动建 run、v2 enrollment/retry 与各自 Outbox；cancel 仅在锁内按明确 pipeline/run 建立栅栏；
- v2 显式 enrollment：默认关闭、owner 显式请求、服务端 allowlist、`Idempotency-Key`、事务内校验 `PLAYABLE`/未删除/时长 `≤60 分钟`/当前字幕状态；仅允许无 ACTIVE 的新资产或 v1 已终态失败/取消且无 ACTIVE 的资产；同一媒体不得并行两个可发布 pipeline；
- test-only Worker：独立 `echoflow-v2-fake-runtime` 队列、单并发和 `storage=null`。它只处理 v2 metadata state machine，且在任何 legacy resolver/processor 前拒绝非 v2 事件；
- Outbox/API：v2 独立事件名、受控恢复/取消扫描和脱敏状态接口；`GET transcript` 继续只读 ACTIVE；
- 生命周期策略和测试：F2 不上传、读取、创建或删除 `HANDOFF_AUDIO`/`ALIGNMENT_RAW`，真实 cleanup scanner 只扫描 v1。

### 2.2 方向一：F2 的两条明确运行路径

1. **strict 成功路径（F2 唯一可接受的成功路径）**：strict assessment accepted → `strict_segment` `HandoffEvidence` → 全部 handoff accepted 后才推进到 `MERGING`。它不创建 `AlignmentJob`，也不发布 `TranscriptVersion`、Cue 或 lesson；
2. **Fake 对齐路径（只验证生命周期与失败关闭）**：strict insufficient → `AlignmentJob` 的 lookup/submit/query/read/retry/recover/cancel/late-result 围栏。若 Fake provider 返回 accepted，F2 仍没有另行授权的不可变 `ALIGNMENT_RAW` 身份，必须以 `alignment_raw_unavailable` / `transcript_incomplete` 失败关闭：零 `HandoffEvidence`、零 `MERGING`、零发布；
3. 仅 v2 内部 Outbox payload 与 queue job 可使用 opaque `v2JobHandle` 作路由；它不得进入 API、普通日志、callback receipt、proof 或 Outbox 失败诊断。Adapter 输入/输出、F2 runtime fixture、所有上述对外/诊断面都不得携带 raw 音频、文本、raw result、对象键/URL、版本、内容 checksum 或 proof digest。

### 2.3 下一批明确不包含

- 不接入真实对齐器/模型；不下载或调用 MFA/第三方；不新增 public callback（建议纯轮询）；
- 不新增生产 proof key 来源、环境变量、版本、轮换或 secret wiring（仍需独立确认）；
- 不处理私人媒体、不上传/下载/读取用户视频、音频或字幕正文；不重跑 C1、B2/B3 或 G3-C；
- 不物化 `boundary_forced_alignment` final evidence、`ALIGNMENT_RAW` 原始对象身份、对象上传/清理、revision overlay 或 v2 真正发布事务；
- 不改写历史 migration、`.workbuddy/`、`showcase/`；不 backfill 或重解释既有 v1/C1 数据。

## 3. 仍待确认的高风险选择

| 选择 | 建议默认 | 仍需确认 |
|---|---|---|
| 对齐器 | 本地 MFA `3.3.9` + `english_mfa` 3.1.0（S0 已探针，仅 D 盘、CPU、单并发、进程轮询） | 真实 boundary audio、词典覆盖、模型许可、submit/query/read/cancel 生命周期仍未冻结 |
| 网络/回调 | 纯轮询、无新增 public callback | S0 无 callback 边界不自动等于产品运行态选择 |
| 私有数据生命周期 | `HANDOFF_AUDIO` 终态约 24 小时内清理；`ALIGNMENT_RAW` 最长 7 天 | 对象地点、地域、可读主体、用户删除顺序、隐私告知版本 |
| 资源与并发 | 本地对齐默认 CPU、单并发、受控临时盘 | 真实 5/30/60 分钟前需确认 RAM/磁盘/超时/预算与 MOSS 资源隔离 |
| proof key | 下一批仍仅注入式 Fake；生产 key 来源/版本/轮换另立合同 | key 来源、删除后可验证性、生产 secret wiring |
| enrollment 隐私告知 | v2 enrollment 前须绑定对齐器/地点/最小字段/留存/删除语义的隐私告知版本 | 这是用户数据处理与隐私告知的真实触发点 |

本节全部是下一份“真实对象/对齐器”合同的待决记录；方向一不等于确认真实 MFA、对象/媒体留存、地域、回调、并发、预算、密钥或 enrollment 方案。

## 4. 方向一确定性验收矩阵

1. v1/v2 并存隔离：v1 自动建 run 与 v2 enrollment 经同一 arbiter；冲突返回稳定错误码而非排队竞争；C1 永不因 v2 部署/扫描自动重处理；
2. v2 enrollment：owner 显式请求 + allowlist + Idempotency-Key；状态前置校验（PLAYABLE/未删除/≤60 分钟/无 ACTIVE 或 v1 已终态）；幂等返回既有 run；
3. strict accepted 必须物化 `strict_segment` 证据，全部 handoff accepted 时才进入 `MERGING`，且 strict 路径没有 `AlignmentJob`；单 Chunk `H_total=0` 也只能通过非 handoff 完整性校验；
4. Fake alignment 覆盖 response-loss adoption、lookup/submit/query 白名单重试（最多三次）、恢复、取消和迟到结果。accepted Fake result 无 raw identity 时必须让 run/handoff/job 终态失败，保持 `HANDOFF_EVIDENCING`，且不得写 evidence、进入 `MERGING` 或发布；
5. revision `0 → 1`、accepted alignment 的成功 evidence、真实对象生命周期和发布事务均移至后续合同，不得借 F2 测试或 Fake 路由实现；
6. 脱敏：API/普通日志/Outbox 失败诊断/receipt/proof 不含正文、token、音频、raw result、对象键/URL、外部 job ID、proofDigest 或 `v2JobHandle`；仅第 2.2 节第 3 项所述内部 Outbox payload/queue job 可携带该 opaque handle。v2 callback 在写 receipt/chunk/Outbox 前被忽略；
7. F1 纯领域 schema 测试可使用固定、不可解析的 marker 来验证字段形状，但它们不属于 F2 runtime，绝不触发 API/Worker/queue/storage/adapter/log/network I/O；
8. 定向 TS、数据库集成、Fake、API/Worker 测试、全仓 lint/test/build 通过；独立 Reviewer P0/P1=0。

这些证据只证明下一批合同实现正确，不证明 MFA 对真实播客准确、真实 handoff 已解决、B2/B3/G3-C 通过或 G3 关闭。

## 5. 停止线与精确后续

立即停止并交还用户：

- 需要下载/调用真实对齐器/模型、生成或处理 boundary audio、写入真实对象存储、决定真实 raw evidence 保留或清理；
- 需要启动实际 MOSS、Docker 业务服务、公开 callback、外部网络传输或访问任何私人媒体；
- 需要新增生产 proof key 来源/环境变量/版本/轮换/secret wiring，或让 F2 Adapter/Fake/runtime fixture/snapshot 承载 raw 音频、文本、raw result、对象键/URL、版本或内容 digest；
- 需要改变用户删除、隐私告知、地域、预算、并发、密钥来源或公开接口。

F1 纯领域单测的 marker 例外只能用于 schema/identity validator 的无 I/O 测试，绝不构成上条 F2 runtime 的例外。F2 收尾顺序固定为：更新合同与证据 → 补强受限路径测试 → 全仓验证 → 独立复核 → 仅提交本合同授权的文件并推送。下一份合同才讨论真实对象生命周期、对齐器接入、真实 B2/B3 与 G3-C。
