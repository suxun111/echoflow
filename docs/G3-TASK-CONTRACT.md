# EchoFlow G3 任务合同：MOSS 与完整字幕原子发布

冻结日期：2026-08-13；segment-first 修订确认：2026-08-15；G3 证据阶段补充确认：2026-08-23
基线：`master@0c3e2ee`  
实施分支：`codex/g3-moss-transcript-20260813`  
状态：用户已确认开始；实施中，退出条件尚未通过

## 1. 本 Gate 要解决的唯一问题

对 G2 已验证、可播放的私人长视频，系统从原始媒体中提取规范化英文语音，按可恢复的持久任务切片提交给 MOSS，并在所有必需分片均成功、英文分段及时间边界通过完整性校验后，一次性发布唯一 ACTIVE 的英文字幕版本。逐词时间戳是可选增强，不是 V1 发布前提；但对于切片输入，必须存在可验证的跨分片唯一交接证据。段级结果只有在严格合并实际得到该证据时才足够；否则必须失败关闭，或由 Provider/经过验证的对齐层提供真实补充证据。

本 Gate 不实现逐句播放器、录音回听、学习进度或工作流导入。Fake MOSS、页面状态和局部成功都不能代替真实 MOSS 长视频验收。

## 2. 第一性原理与事实源

- 视频、音频和 MOSS 原始结果属于对象存储；PostgreSQL 只保存身份、状态、时间边界、对象事实和最终结构化字幕，不把大文件塞进数据库；
- PostgreSQL 的 `ProcessingRun`、`ProcessingChunk`、`TranscriptVersion` 和 Outbox 是恢复事实源；Redis/BullMQ 只负责投递，不是任务事实源；
- MOSS 是可失败、可超时、会重复回调的外部计算服务，不是 EchoFlow 的最终事实源；
- 单个分片成功不等于字幕成功；只有完整、单调、无越界且含真实分段时间边界的全部英文结果才允许发布；若 Provider 返回逐词时间戳，还必须一并校验；
- 先完成并校验新的 BUILDING 版本，再在同一事务中将旧 ACTIVE 置为 SUPERSEDED、新版本置为 ACTIVE，不能原地覆盖线上字幕；
- MOSS 不获得对象存储永久凭据，只能读取短期签名的规范化音频分片；
- API/Worker/MOSS 任一重启后都必须从数据库与对象事实恢复，不能依赖进程内 Map、定时器或内存进度。

## 3. 冻结范围

### 3.1 媒体预处理

- 只处理 owner 的 `PLAYABLE` 媒体资产；G2 的播放对象与字幕处理失败彼此解耦；
- 使用 FFmpeg 从原片提取从视频 `0ms` 开始的 16 kHz、单声道 PCM/WAV，禁止为了“对齐”裁掉开头静音；
- 规范化音频保存为 `NORMALIZED_AUDIO`，分片保存为 `AUDIO_CHUNK`，均记录 bucket、objectKey、versionId、大小、校验和与生命周期元数据；
- 分片目标时长、静音边界与重叠均为候选参数，必须由模型、硬件和跨分片交接基准确认后持久化在计划中；每片保存绝对 `startMs/endMs`，合并时基于绝对时间去重；
- 预处理命令必须有超时、stderr 上限、临时目录隔离和 finally 清理；失败不能删除 G2 原片或播放资产。

### 3.2 MOSS Adapter

- EchoFlow 内部冻结为 `submit/query/result/cancel` 四个逻辑操作，具体 MOSS HTTP 路由与字段只存在于 Adapter；业务层不得散落供应方协议；
- 当前自建 Provider Gateway 使用带版本的 `/api/provider/v1` 路由；MOSS 原有 GUI `/api/jobs` 不是 EchoFlow 供应方合同；
- submit 使用稳定幂等键：`sourceObjectVersion + pipelineVersion + planRevision + chunkIndex + startMs + endMs + inputObjectKey + inputVersionId + inputChecksum + modelVersion`；同一输入身份重试复用同一键，不同边界或输入版本绝不复用旧 MOSS Job；
- 每个外部任务的 `externalJobId` 必须在提交被接受后立即持久化；响应丢失时先按幂等键查询，不能盲目重复计费；
- 对已经进入失败/取消终态、但允许用户重试的分片，Adapter 必须把同一幂等身份映射为供应方的“重开/重试”操作；不得把旧终态 Job 直接当成本轮新提交，也不得改变 EchoFlow 的稳定幂等键；
- 优先由 MOSS 通过短期签名 URL 拉取音频分片；若实际 MOSS 只能 multipart 接收，Adapter 每次重试必须重新打开流，且仍不得泄露永久对象存储凭据；
- 回调为主、延迟轮询为兜底；429、408、5xx、网络中断与超时属于可重试，认证、契约错误和确定性坏结果属于终止失败；
- `partial`、无时间边界的整篇文本或需要人工确认的未完成结果均不等于成功；成功结果必须含完整英文分段及每段真实起止时间；
- MOSS 未冻结或暂未实现的供应方字段通过 Adapter 映射解决，不反向污染 EchoFlow 的领域模型。

### 3.3 回调安全与幂等

- 公开入口固定为 `POST /api/v1/integrations/moss/callback`，不使用用户 Access Token，但必须验证原始请求体签名；
- 请求携带事件 ID、Unix 时间戳、随机 Nonce 与 HMAC-SHA256 签名；默认只接受前后 5 分钟窗口；
- 签名覆盖 `timestamp + nonce + rawBody`，使用常量时间比较；生产 Secret 不得使用示例值；
- 事件 ID 与 Nonce 均进入持久化唯一约束；重复、乱序和迟到回调幂等处理，不能倒退已完成/已取消状态；
- 回调只记录状态与结果定位信息，不在普通日志中记录字幕正文、音频 URL、签名或私人 object key；
- callback 只写数据库状态和 Outbox；大结果读取、校验与发布仍由 Worker 完成。

### 3.4 状态、租约与恢复

- G2 播放准备与 G3 字幕处理使用不同 `ProcessingRun`；同一媒体、pipelineVersion 只能有一个 G3 run；
- G3 状态依次为 `PLAYBACK_READY → AUDIO_EXTRACTING → CHUNKING → TRANSCRIBING → MERGING → CUE_SEGMENTING → VALIDATING → TRANSCRIPT_READY`；
- 每个阶段和分片通过数据库 CAS/lease 认领，最终提交再次验证 leaseOwner、状态与取消栅栏；旧 Worker 不得覆盖或删除新 Worker 已采用的对象；
- Redis 消息丢失、Outbox 重投、Worker 崩溃、MOSS 回调丢失和外部任务已接受但响应丢失后均可恢复；
- 只重试失败阶段或失败分片；已持久化且校验通过的音频对象、外部 Job ID 和原始结果不得重复生成；
- 对 `ambiguous_segment_handoff`，V1 最多允许一次自动、有界的相邻 pair 重切：原计划保持 revision 0，新 pair 作为 revision 1 overlay 持久化；旧 `ProcessingChunk`、输入对象、ASR 原始结果和外部 Job 永不覆盖或删除。候选 revision 只在完整严格合并成功时原子切换为 active；重切后仍歧义则 `transcript_incomplete`，不再猜测或继续重切；
- 取消先持久化终态并建立 fencing，再尽力取消 MOSS 和清理临时对象；迟到回调不能复活任务；
- 可重试失败采用有上限的指数退避与抖动；超过上限进入明确失败态并保留稳定错误码。

### 3.5 合并、校验与原子发布

- MOSS 原始结果先作为不可变 `ASR_RAW` 对象保存，并记录 checksum、模型版本和来源分片；
- 必选分段结构至少包含 `text/startMs/endMs`，可选逐词结构同样包含 `text/startMs/endMs`；所有数值使用毫秒整数，不使用浮点秒作为数据库事实；
- 分片偏移恢复后，依据重叠区文本序列与时间做确定性去重；不能只把数组首尾拼接；
- 当相邻分段在重叠区没有唯一文本与时间交接证据时，必须失败关闭。仅该结构化诊断可触发上述一次静音重切；静音位置本身不是字幕发布证据，任何 repair 候选仍必须走完整的严格合并和原子发布；
- 校验覆盖：每个必需分片成功、索引连续、分段文本非空、`0 ≤ startMs < endMs ≤ durationMs`、全局时间单调、Cue 不倒序、没有明显大段未覆盖；存在逐词数据时还要校验词序和词时间；
- Provider 只有分段时间时，一个已校验的真实分段直接映射为一个 Cue，`words=[]`；只有存在真实逐词/强制对齐证据时才允许进一步切分，禁止按字符数或平均时长伪造单词边界；
- 不生成中文翻译、说话人审核或人工字幕；
- `TranscriptVersion` 从 BUILDING 创建，所有 Cue、版本状态、`PrivateLesson` 绑定和 run 终态在同一数据库事务发布；
- 任一分片缺失、结果损坏、时间戳越界或发布事务失败时，学习端仍只能看到旧 ACTIVE；没有旧版本时看不到任何半成品字幕；
- 数据库必须保证同一媒体最多一个 ACTIVE `TranscriptVersion`。

### 3.6 API 与 Web 状态

- owner 可在媒体资产详情中看到真实字幕阶段、当前有效计划的已完成分片数/总分片数、最近更新时间与稳定错误码；历史 revision 不得被重复计入或暴露；
- 只展示由数据库事实推导的阶段和计数，不伪造模型百分比或完成时间；
- 提供 owner-scoped 的字幕版本与 Cue 只读接口，为 G4 真实播放器准备数据；BUILDING/REJECTED 版本不可见；
- 失败页区分“播放仍可用”和“字幕生成失败”，支持对允许重试的任务发起显式重试；
- Web 本 Gate 只做处理状态与完整字幕数据可达性，不提前实现逐句循环或录音。

### 3.7 G3 证据阶段（不替代 Gate 退出条件）

G3 内部按证据组织为 G3-A、G3-B、G3-C；它们不是新的 Gate，不授权进入 G4，也不放宽第 7 节退出条件。

- **G3-A：基础真实链路。** 已有真实 30 秒模型/Provider 冒烟与一次真实约 5 分钟 EchoFlow → MOSS → ACTIVE 发布证据。它不证明长媒体交接可靠；
- **G3-B：跨分片交接可行性。** 以新的、受权且可重复的英语基准样本，验证当前 `segment-first + 严格合并 + 至多一次 revision 1 repair` 是否能为每个交接提供唯一、可审计的证据。详细输入边界、指标、失败转向与恢复点见 [G3-B 分片交接能力基准合同](G3-B-SEGMENT-HANDOFF-BENCHMARK-CONTRACT.md)；
- **G3-C：长媒体可靠性与容量。** 仅在 G3-B 明确安全交接路线后，完成 30 秒与 5/30/60 分钟真实发布、失败恢复、重启/回调丢失、安全和 Reviewer 矩阵。

## 4. 冻结契约

### 4.1 Owner API

```text
GET  /api/v1/media-assets/:mediaAssetId
POST /api/v1/media-assets/:mediaAssetId/transcript/retry
POST /api/v1/media-assets/:mediaAssetId/transcript/cancel
GET  /api/v1/media-assets/:mediaAssetId/transcript
```

`GET transcript` 只返回当前 ACTIVE 版本；未完成统一返回 `transcript_not_ready`。重试使用 `Idempotency-Key`，且不能并发创建第二条活动 run。

### 4.2 MOSS Callback

```text
POST /api/v1/integrations/moss/callback

X-EchoFlow-Event-Id: <stable event id>
X-EchoFlow-Timestamp: <unix seconds>
X-EchoFlow-Nonce: <random nonce>
X-EchoFlow-Signature: v1=<hex hmac-sha256>
```

Callback body 至少携带 `externalJobId`、EchoFlow 幂等键、外部状态、结果定位信息或稳定错误；实际供应方字段由 Adapter 转成内部事件。

### 4.3 稳定错误码

- `transcript_not_ready`
- `transcript_active_conflict`
- `audio_extract_failed`
- `audio_chunk_failed`
- `moss_unavailable`
- `moss_timeout`
- `moss_rate_limited`
- `moss_rejected`
- `moss_invalid_response`
- `moss_callback_invalid`
- `transcript_incomplete`
- `transcript_timing_invalid`
- `transcript_publish_failed`
- `processing_cancelled`

错误继续使用 `{code,message,details,requestId}`；不得在 `details` 中返回字幕正文、签名 URL、MOSS Token 或 object key。

## 5. 历史资产迁移边界

### 5.1 只参考设计与测试场景

- `codex/moss-production-hardening@0baedef`：参考 MOSS 错误分类、每次重试重开 Stream、外部任务 ID、恢复扫描和指数退避；
- `codex/recovery-f24e-20260811@299e6e1`：参考请求 timeout、429/503 重试、分片偏移和刷新后状态恢复；
- `codex/recovery-0b51-20260811@2c76de7`：参考“任一分片失败不发布”和 Cue/run 同事务发布语义。

### 5.2 明确拒绝

- 不整体 merge/cherry-pick 上述分支或 migration；
- 不上传整段原视频给 MOSS；
- 不以文件名扫描 MOSS 全部任务模拟真正幂等；
- 不把 `waiting_review` 当完成；
- 不接受只有整篇文本而没有 segment 级时间边界的结果，也不接受伪造的逐词时间戳；
- 不包含翻译、词汇、公共发布、人工审核或固定 2 GiB/15 分钟限制；
- 不让数据库完成与 Queue 投递之间出现无 Outbox 的崩溃间隙。

## 6. 验收矩阵

### 6.1 确定性 Fake MOSS

- submit/query/result/cancel 正常路径；
- 429、503、连接中断、单请求超时和指数退避；
- POST 已接受但响应丢失后复用同一外部任务；
- callback 签名正确/错误、过期 timestamp、重复 nonce、重复事件、乱序与迟到；
- 单片失败后仅重试该片；某必需片永久失败时不能出现 ACTIVE 字幕；
- 相邻交接歧义时只生成一个 revision 1 的替换 pair；旧 pair 和未受影响 chunk 的身份、对象、结果、MOSS Job 均不变；repair 后仍歧义时不生成 revision 2，且没有 ACTIVE 字幕；
- Redis 消息丢失、Outbox 重投、Worker 在抽音频/提交/合并/发布前后崩溃；
- 多 Worker 竞争、lease 过期接管、取消与完成竞态、旧 Worker 最终 fencing；
- 结果为空、缺分段时间、时间倒退、越界、重复重叠、缺片与损坏 checksum；存在逐词结果时还覆盖缺词时间戳；
- 发布事务失败时旧 ACTIVE 不变；重复发布仍只有一个 ACTIVE 版本。

### 6.2 真实媒体与真实 MOSS

- G3-A/B/C 仅组织本节证据；G3-B 的约 30 分钟可行性基准不能单独替代下列发布、恢复或容量验收；
- 30 秒英文黄金样本用于日常真实集成，核对分段时间与可读文本；Provider 返回逐词结果时再核对逐词时间；
- 5、30、60 分钟英文样本各至少一次完整链路，核对分片、重叠去重、单调时间、最终 Cue 数与播放总时长；
- 至少注入一个真实失败分片并恢复，证明只重试失败片且没有部分发布；
- MOSS 服务重启、Worker 重启、回调丢失后由轮询恢复；
- 记录吞吐、端到端耗时、峰值内存、音频与结果对象大小和错误分类，供 MOSS 采购/容量决定；
- 真实 MOSS endpoint、凭据和供应方协议未就绪时，可完成代码与 Fake MOSS 证据，但 G3 不得关闭。

### 6.3 安全、权限与清理

- 双用户与管理员均不能读取另一 owner 的字幕、状态、临时音频或原始结果；
- MOSS 无永久存储凭据；临时 URL 过期后不可读取；
- 普通日志中没有字幕正文、音频 URL、object key、Token 或 HMAC Secret；
- 成功临时音频/分片约 24 小时清理；失败排查对象最长 7 天；MOSS 输入终态后约 24 小时清理，临时结果拉取后最长 7 天；
- 清理操作必须受当前 run/version/object identity fencing 保护，不能删除新运行仍在使用的对象。

## 7. Gate 退出条件

G3-A/B/C 仅组织证据，不替代以下任一退出条件。G3 仍只有在所有条件同时有绑定证据时关闭。

G3 只有以下条件同时满足时关闭：

1. 任务合同、contracts、迁移、API、Worker、Web 与运行行为一致；
2. Fake MOSS 故障、幂等、回调安全、恢复、竞争和原子发布矩阵通过；
3. 真实 PostgreSQL、Redis、MinIO、FFmpeg/FFprobe 集成证据绑定最终 Commit；
4. 30 秒及 5/30/60 分钟真实 MOSS 样本矩阵通过；
5. 60 分钟结果具备完整英文分段和真实起止时间，全局单调且不越界；逐词时间戳若存在也必须通过相同校验；
6. 任一必需分片失败、取消或结果损坏时均无部分 ACTIVE 字幕；
7. 双用户、管理员、回调伪造/重放和临时对象访问负向矩阵通过；
8. 定向和全仓 lint/test/build、Prisma validate 与 fresh clone 通过；
9. 独立 Reviewer 对最终代码锚点确认无 P0/P1；
10. 验证证据已提交并进入唯一 trunk。

Fake MOSS 全绿、手工看到一段字幕、某个 MOSS Job 显示 done、数据库存在 Cue 或页面显示 100%，均不能单独关闭 G3。

## 8. 实施切片

```text
G3.1 合同、增量迁移、Adapter 与 Fake MOSS
→ G3.2 音频规范化、分片对象、Run/Chunk 恢复
→ G3.3 submit + callback/poll + 结果留存
→ G3.4 合并校验、Cue 分段、唯一 ACTIVE 原子发布
→ G3.5 Owner API + Web 真实状态/完整字幕可达
→ G3.6 真实长媒体/MOSS、安全/恢复矩阵 + Reviewer + Gate 证据
```

实施切片与 G3-A/B/C 证据阶段正交；G3.6 的真实验证覆盖这些阶段，但任一阶段局部完成均不单独关闭 G3。
