# EchoFlow G3 v2 运行态实施启动合同（草案）

创建日期：2026-08-26
状态：**待用户确认；本文件只冻结拟议的下一批实现边界，不授权创建 migration、修改代码、启动服务或处理任何媒体。**

在用户确认本合同的 F2 范围前，**不得开始 v2 运行态实现**，也不得把本草案当作 Route B 已落地、真实对齐已接入或 G3 通过证据。

上游依据：[确定性基础层启动合同](G3-V2-DETERMINISTIC-FOUNDATION-START-CONTRACT.md)（F1 已确认并实施）、[G3 `g3-transcript-v2` 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)、[MFA S0 运行证据](G3-V2-MFA-S0-VERIFICATION-EVIDENCE.md)、[执行状态](EXECUTION-STATE.md)。

所属 Gate：G3-B Route B。F1 只交付了确定性基础层（schema/纯领域/Fake/测试）；本草案冻结的是把该基础层接入运行态的下一批工作。它仍不授权真实对齐器接入、私人媒体处理或 G3-C。

## 1. 要解决的问题与交付物

F1 建立了可持久化、可审计、可失败关闭的 handoff/evidence 领域模型与确定性测试，但尚未存在：

1. `TranscriptRunArbiter`——v1/v2 互斥 enrollment 的串行化仲裁与稳定冲突语义；
2. v2 显式 enrollment——owner 显式请求、服务端 allowlist、Idempotency-Key、状态前置校验；
3. v2 Worker/Outbox/API 路由——`HANDOFF_EVIDENCING` 阶段、`AlignmentJob` 生命周期（submit/query/read/cancel/重试/恢复/取消/清理）、独立 job 判别与恢复扫描；
4. 受控对象生命周期——`HANDOFF_AUDIO`（约 24 小时）与 `ALIGNMENT_RAW`（最长 7 天）的版本化、fenced 清理。

本草案交付物仅是合同，不交付任何代码/迁移/媒体处理。

## 2. 本草案的授权边界

### 2.1 当前这一步允许做什么

- 只读盘点、本启动合同的起草、独立审查、提交与状态记录；
- 冻结拟议的下一批代码范围、验收矩阵、停止条件和待确认决策；
- 不产生媒体、对象、真实对齐作业、数据库变更或外部请求。

### 2.2 用户确认后建议授权的下一批实现（暂记 F2，待确认）

- `TranscriptRunArbiter`：按 `mediaAssetId` 串行化（advisory lock + 事务内重读 + 冲突判定 + 唯一 run/Outbox 创建），覆盖 v1 自动建 run、v2 enrollment/retry 与各自 Outbox；cancel 仅在锁内按明确 pipeline/run 建立栅栏；
- v2 显式 enrollment：默认关闭、owner 显式请求、服务端 allowlist、`Idempotency-Key`、事务内校验 `PLAYABLE`/未删除/时长 `≤60 分钟`/当前字幕状态；仅允许无 ACTIVE 的新资产或 v1 已终态失败/取消且无 ACTIVE 的资产；同一媒体不得并行两个可发布 pipeline；
- v2 Worker：`HANDOFF_EVIDENCING` 阶段实现（重读当前有效 plan → strict assessment → `AlignmentJob` 受控提交/轮询/恢复/取消 → 纯校验器物化 final evidence → `MERGING`）；revision `0 → 1` 白名单 overlay；发布事务内重算 `H_*` 与全部 identity 校验；
- Outbox/API：v2 独立事件名/job ID/恢复扫描/取消扫描；`GET transcript` 继续只读 ACTIVE；owner 状态接口仅脱敏 `H_*` 计数与稳定错误码；
- 受控对象生命周期：`HANDOFF_AUDIO`/`ALIGNMENT_RAW` 的精确版本上传、校验与 fenced 清理；孤儿对象立即进入同版本清理队列。

### 2.3 下一批明确不包含

- 不接入真实对齐器/模型；不下载或调用 MFA/第三方；不新增 public callback（建议纯轮询）；
- 不新增生产 proof key 来源、环境变量、版本、轮换或 secret wiring（仍需独立确认）；
- 不处理私人媒体、不上传/下载/读取用户视频、音频或字幕正文；不重跑 C1、B2/B3 或 G3-C；
- 不改写历史 migration、`.workbuddy/`、`showcase/`；不 backfill 或重解释既有 v1/C1 数据。

## 3. 待确认的高风险选择（未确认前不得实施 F2）

| 选择 | 建议默认 | 仍需确认 |
|---|---|---|
| 对齐器 | 本地 MFA `3.3.9` + `english_mfa` 3.1.0（S0 已探针，仅 D 盘、CPU、单并发、进程轮询） | 真实 boundary audio、词典覆盖、模型许可、submit/query/read/cancel 生命周期仍未冻结 |
| 网络/回调 | 纯轮询、无新增 public callback | S0 无 callback 边界不自动等于产品运行态选择 |
| 私有数据生命周期 | `HANDOFF_AUDIO` 终态约 24 小时内清理；`ALIGNMENT_RAW` 最长 7 天 | 对象地点、地域、可读主体、用户删除顺序、隐私告知版本 |
| 资源与并发 | 本地对齐默认 CPU、单并发、受控临时盘 | 真实 5/30/60 分钟前需确认 RAM/磁盘/超时/预算与 MOSS 资源隔离 |
| proof key | 下一批仍仅注入式 Fake；生产 key 来源/版本/轮换另立合同 | key 来源、删除后可验证性、生产 secret wiring |
| enrollment 隐私告知 | v2 enrollment 前须绑定对齐器/地点/最小字段/留存/删除语义的隐私告知版本 | 这是用户数据处理与隐私告知的真实触发点 |

本节除“下一批范围”外的建议都只是待决记录；确认 F2 **不等于**确认真实 MFA、对象/媒体留存、地域、回调、并发、预算、密钥或 enrollment 方案。

## 4. 下一批确定性验收矩阵（拟议）

1. v1/v2 并存隔离：v1 自动建 run 与 v2 enrollment 经同一 arbiter；冲突返回稳定错误码而非排队竞争；C1 永不因 v2 部署/扫描自动重处理；
2. v2 enrollment：owner 显式请求 + allowlist + Idempotency-Key；状态前置校验（PLAYABLE/未删除/≤60 分钟/无 ACTIVE 或 v1 已终态）；幂等返回既有 run；
3. `HANDOFF_EVIDENCING`：strict assessment → `AlignmentJob`（Fake）→ final evidence → 仅全 accepted 才进入 `MERGING`；单 Chunk `H_total=0` 直接通过非 handoff 完整性校验；
4. revision `0 → 1`：仅“其他 handoff accepted + 恰一个 strict `ambiguous_segment_handoff` + 既有 repair 白名单”才 overlay；revision 1 后仍 unresolved 立即 `transcript_incomplete`，绝不创建 revision 2；
5. 发布事务：重算 `H_*`、校验全部 identity/checksum/窗口、`H_unresolved=0`，失败回滚零半套 Version/Cue/lesson；
6. `AlignmentJob` 生命周期：submit 响应丢失先按幂等键查询、最大 attempt=3、可重试码白名单、迟到/重复/旧 lease/取消均不复活不发布；对象清理与用户删除后 receipt 不可映射；
7. 脱敏：API/日志/Outbox/receipt/proof 不含正文、token、音频、raw result、对象键/URL、外部 job ID、proofDigest；合成 sentinel 测试覆盖；
8. 定向 TS、数据库集成、Fake、API/Worker 测试、全仓 lint/test/build 通过；独立 Reviewer P0/P1=0。

这些证据只证明下一批合同实现正确，不证明 MFA 对真实播客准确、真实 handoff 已解决、B2/B3/G3-C 通过或 G3 关闭。

## 5. 停止线与精确后续

立即停止并交还用户：

- 需要下载/调用真实对齐器/模型、生成或处理 boundary audio、写入真实对象存储、决定真实 raw evidence 保留或清理；
- 需要启动实际 MOSS、Docker 业务服务、公开 callback、外部网络传输或访问任何私人媒体；
- 需要新增生产 proof key 来源/环境变量/版本/轮换/secret wiring，或让 Adapter/Fake/fixture/snapshot 承载 raw 音频、文本、raw result、对象键/URL 或 digest；
- 需要改变用户删除、隐私告知、地域、预算、并发、密钥来源或公开接口。

若你确认本合同的 **下一批范围及仅限 Fake/测试的运行态基础设施边界**，我会先将本文件状态改为“已确认”，再创建独立实施分支/工作树逐项完成；第 3 节除“下一批范围”外的建议仍仅是待决记录。审核后绑定 Commit。下一份合同才讨论真实对齐器接入、真实 B2/B3 与 G3-C。
