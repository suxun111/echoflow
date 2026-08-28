# EchoFlow G3 v2 F2 运行态验证证据

验证日期：2026-08-28
实施分支：`codex/g3-v2-runtime-20260826`
上游合同：[G3 v2 运行态实施启动合同](G3-V2-RUNTIME-IMPLEMENTATION-START-CONTRACT.md)

状态：**方向一验收通过。受限 F2 实现的本地代码锚点为 `6ba3c41`；全仓验证及两份独立只读复核均已完成（P0=0、P1=0）。本证据只覆盖 Fake 运行态，未证明真实对齐、对象生命周期 I/O、私人媒体或 G3 Gate 关闭；代码尚未推送。**

## 1. 范围与停止线

F2 只实现 `g3-transcript-v2` 的测试态 Fake 运行基础设施：`TranscriptRunArbiter`、owner 显式 enrollment、隔离的 API/Outbox/Worker 路由、恢复/取消围栏、内存 Fake 对齐器和确定性测试。

F2 的 v2 路由没有启动或调用真实 MFA/MOSS、没有读取/上传任何私人媒体、没有对象存储实际读写、没有新增生产 proof key、没有公网 callback，也没有把 v2 接入 G3-C 或完整字幕发布。现有 v1 MOSS/对象存储路径保持独立。

为验证既有全仓回归，本机临时启动了 PostgreSQL、Redis 和 MinIO；它们只服务于隔离测试库、测试桶和由测试生成的合成媒体。没有启动 MOSS、API 或 Worker 进程，也没有把用户媒体放入任何测试服务。

## 2. 已实现的可验证边界

- `TranscriptRunArbiter` 在同一媒体 advisory lock 内重读状态，限制 v1/v2 并行所有权；v2 必须具备 owner、显式 enrollment、60 分钟上限、`HANDOFF_EVIDENCING`、canonical v2 事件和合法的 opaque queue handle。
- v2 API 仅在 `NODE_ENV=test` 与显式 Fake 开关同时成立时可达，且要求服务端 allowlist 与有效 `Idempotency-Key`。API 返回、idempotency response 和 v2 queue payload 均不暴露 `ProcessingRun` 或媒体数据库 ID。
- Outbox 只在 Fake gate 开启时发布 v2 独立事件；队列只携带合同允许的内部 `v2JobHandle`。Worker 先把该 handle 解析为数据库内私有身份，再用 pipeline fence 分流到注入式 Fake 状态机。
- Fake Worker 使用独立 `echoflow-v2-fake-runtime` 队列、单并发和 `storage=null`；它不构造 Playback、MOSS 或 transcript processor，且在任何 legacy resolver/processor 前拒绝非 v2 事件。
- v2 对齐状态机只使用 PostgreSQL 元数据和内存 Fake，覆盖 submit 响应丢失、lookup/submit/query 的白名单重试、受控 `nextAttemptAt`/`nextPollAt`、最多三次、恢复、取消和迟到结果失败关闭。strict evidence 可以进入 `MERGING`，但没有独立 `ALIGNMENT_RAW` 身份时，accepted Fake alignment 必须以 `alignment_raw_unavailable` / `transcript_incomplete` 失败关闭，不写 `HandoffEvidence`、不进入 `MERGING`、不发布字幕。
- MOSS callback 若意外指向 v2 run，会在写入 receipt、chunk 或 Outbox 前稳定忽略；HTTP request log 会脱敏路径中的 UUID。v2 生命周期日志不记录 BullMQ job ID/handle，v2 Outbox 队列失败只保存稳定错误码。
- F2 的对象生命周期仅保留策略/测试；现有真实 cleanup scanner 限制为 v1，不能因异常 v2 行触发真实对象删除。

## 3. 自动化验证

| 命令 | 实际结果 | 覆盖边界 |
|---|---|---|
| `node E:/33442/node_modules/corepack/dist/pnpm.js lint` | 通过 | 共享包、Web/Admin/API/Worker TypeScript 静态检查 |
| `node E:/33442/node_modules/corepack/dist/pnpm.js test` | 313 通过，3 跳过 | Config 14、Contracts 6、Database 43、Web 47、API 32、Worker 171；跳过项为既有 `RUN_G2_LONG_MEDIA` 门控的长媒体测试 |
| `node E:/33442/node_modules/corepack/dist/pnpm.js build` | 通过 | 共享包与 Web/Admin/API/Worker 生产构建 |
| `git diff --check` 与 `git diff --cached --check` | 通过 | 提交前无补丁空白错误 |
| Worker F2 测试集合（包含在根级 test） | 86 通过 | Fake runtime 7、v2 Outbox/recovery 4、queue handler 6、runtime log 1、handoff 47、evidencing 9、alignment 12 |
| API F2 测试集合（包含在根级 test） | 3 通过 | enrollment/cancel、owner/allowlist/idempotency、v2 callback 零副作用 |

全仓第一次运行中，API 的新数据库 e2e 文件与既有 API e2e 文件并行清理同一可弃数据库，造成两个测试出现 401；这是测试隔离竞态，不是产品认证缺陷。将 API 测试改为文件串行后，单包 API 全量（32）和本次根级全量（313）均通过。

## 4. 方向一决策与复核闭环

此前独立 Reviewer 的共同 P1 是：F1 schema 规定 `accepted + boundary_forced_alignment` 的 `HandoffEvidence` 必须带有 non-null `rawObjectKey`、`rawVersionId`、`rawChecksum`，而 F2 停止线禁止 Fake/runtime fixture 承载对象身份。代码已经安全地选择 `alignment_raw_unavailable` / `transcript_incomplete` 失败关闭，但旧验收矩阵仍错误地要求 Fake alignment 成功 evidence。

用户已选择方向一：只将 strict evidence → `MERGING` 作为 F2 成功路径；Fake alignment 只验证 submit/query/retry/recover/cancel/late-result 围栏，并在 accepted 且无 raw identity 时失败关闭。`boundary_forced_alignment` final evidence、真实 raw 对象身份、对象生命周期 I/O 与发布移至下一份合同。

为避免将纯领域测试误读为运行态授权，F1 合同、领域类型说明和测试已明确：F1 schema/identity 纯函数测试可用固定、不可解析的 marker 字段值测试 validation/canonicalization；它们不调用 API/Worker/queue/storage/adapter/log/network，也绝不流入 F2 runtime。该澄清不是对 Fake alignment raw identity 的例外。

在最后一次实现收窄后，两位独立 Reviewer 分别复核了运行态边界与隐私/合同边界，结论均为 P0=0、P1=0。复核确认旧 processor 已不接受公开 v2 handoff 注入，v2 会在任何存储、FFmpeg 或 MOSS 调用前被拒绝；`raw-sentinel` 已删除；对象身份、raw result、正文、音频和内容 digest 未进入 API 响应、普通日志、callback receipt 或 Outbox 失败诊断。唯一残留是恒为 `undefined` 的 retired helper，属于后续 P2 清理，不构成可达运行路径。

## 5. 尚未证明的事项

- 不证明真实 MFA 对齐、真实 MOSS、真实媒体、跨分片交接准确性、30/60 分钟矩阵、真实对象生命周期或 G3 Gate 关闭；
- 不决定真实对齐器、数据地点与保留期、资源/并发、生产 proof key、用户隐私告知或公网 callback；
- 不证明 accepted Fake alignment 能物化 final evidence；方向一明确规定它不能。该成功路径等待未来对象生命周期合同。

## 6. 精确恢复点

F2 代码已作为本地提交 `6ba3c41` 固定，尚未推送。精确恢复点是：在用户明确授权前不 push/merge；下一份任务合同才可讨论真实 `ALIGNMENT_RAW` 对象身份、真实对齐器/媒体、保留/删除语义与 G3-C。不得把本证据当作这些事项已完成，也不得以 Fake raw identity 将 alignment 路径改写为成功。
