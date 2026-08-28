# EchoFlow G3 v2 F3-A 受控对齐工件基础层实施启动合同（草案）

创建日期：2026-08-28
状态：**草案，独立只读复核已通过（P0=0、P1=0），但尚未获得实施确认。** 本文件只冻结下一批确定性基础设施的拟议边界；不授权真实 MFA 执行、对象存储 I/O、私人媒体、MOSS、生产 proof key、公开 callback 或推送。

上游依据：[v2 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)、[F1 确定性基础层合同](G3-V2-DETERMINISTIC-FOUNDATION-START-CONTRACT.md)、[F2 运行态合同](G3-V2-RUNTIME-IMPLEMENTATION-START-CONTRACT.md)、[F2 运行态验证证据](G3-V2-F2-RUNTIME-VERIFICATION-EVIDENCE.md)、[MFA S0 运行证据](G3-V2-MFA-S0-VERIFICATION-EVIDENCE.md)、[执行状态](EXECUTION-STATE.md)。

所属 Gate：G3-B Route B。代码基线：`codex/g3-v2-runtime-20260826@1726ad7`。

## 1. 要解决的问题与拆分原则

F2 已验证受限 metadata/Fake 运行态：strict evidence 可进入 `MERGING`，而没有真实 `ALIGNMENT_RAW` 身份的 accepted Fake alignment 必须失败关闭。它刻意不读取对象、启动 MFA 或物化 alignment final evidence。

要把未来的 boundary alignment 做成可审计能力，必须先解决两个尚未落地的基础问题：

1. `HANDOFF_AUDIO` / `ALIGNMENT_RAW` 目前只有对象 kind 和字符串身份字段，缺少同 `run + revision + handoff + 精确 MediaObject version` 的强关系；不能靠对象 key、metadata 或“最新版本”推断身份。
2. `HandoffEvidence` 的不可变/删除 trigger 与用户删除语义尚未有受控 purge 路径。直接接入真实对象会在删除、取消、孤儿和迟到写入时留下不可控关系。

因此本合同把下一步收敛为 **F3-A：工件身份、受控 purge 与本地对齐器 Port 的确定性基础层**。真实本地 MFA 和非私人对象 I/O 另列为 F3-B；私人媒体、生产 key、正式 `boundary_forced_alignment` 发布和 G3-C 更晚单独确认。

## 2. 当前动作与用户确认后的 F3-A 范围

### 2.1 当前动作（已授权）

- 起草、只读盘点、独立复核、提交本合同和状态记录；
- 不创建 migration、不修改源代码、不启动服务、不运行模型或媒体任务。

### 2.2 用户确认后才可实施的 F3-A

- 一次前向 schema/migration：为 v2 对齐工件建立受数据库约束的绑定关系，例如 `HandoffArtifact`（命名可在实现时保持等义）。它必须以 `mediaObjectId` 外键绑定精确 `MediaObject`，并冻结 artifact role、`ProcessingRun`、effective revision、`ProcessingHandoff`、对象 version/checksum、创建/绑定/清理状态与 fencing；绑定时 `versionId` 与 `checksumSha256` 必须非空且不可变；
- 数据库级约束和受限 transition：同一 handoff/role 只能有一个工件；F3-A 进一步收紧为一个精确 `MediaObject` 版本只能有一个 live v2 工件，不做跨 handoff/revision 复用或引用计数优化。跨 asset/run/revision、kind、version 或 checksum 不一致一律拒绝；不得用对象 key、metadata 或 `latest` 代替关系约束；
- 工件有限状态机：`RESERVED → BOUND → PURGE_ELIGIBLE → PURGED`，取消可从前两态进入 `PURGE_ELIGIBLE`。一旦 `BOUND`，对象外键、role、version 与 checksum 永不可更新或重绑；上传成功但未绑定的对象只能作为 orphan 清理，迟到绑定或把新对象伪装成同一次 retry 必须失败；
- 受控 v2 purge 设计与实现：F3-A 仅在可弃测试库实现一个 `SECURITY DEFINER`（或等强受限）内部 purge 函数。必须撤销 `PUBLIC` execute，只允许服务端内部数据库角色调用；不增加 owner/admin/public API endpoint。函数只接受精确 run/revision/artifact/fence 身份，先验证 `DELETING` 或 `CANCELLED` 与当前 fencing，才可清除合成测试关系并留下不可反查 tombstone。直接 `DELETE`、级联删除、错误 fence 和普通应用查询仍必须被拒绝；它必须兼容不可变 evidence trigger，绝不使用 prefix、`latest` 或模糊对象名批量删除；
- 独立 `LocalAlignmentAdapter` Port、工作目录和错误语义的类型/纯函数/Fake；F3-A 只允许 metadata 和测试双关（test double），不调用 `mfa.exe`、FFmpeg、对象存储或网络；
- PostgreSQL、Worker/API/脱敏的确定性测试，使用全新可弃测试库和 synthetic metadata。测试不读取、生成或保留音频、字幕正文、raw JSON、真实对象 key、版本或内容 checksum。

### 2.3 F3-A 明确不包含

- 不执行本地 MFA、FFmpeg 或任何真实音频处理；不新建 `HANDOFF_AUDIO` 或 `ALIGNMENT_RAW` 对象；
- 不读取、上传、下载、删除或重跑私人视频、C1、B2/B3、现有 run、字幕正文或真实对象；
- 不接真实 MOSS、GPU、第三方传输、Docker 业务容器或 public callback；
- 不让 alignment 路径写 accepted final evidence、进入发布、生成 `TranscriptVersion` / Cue / Lesson，或创建 revision 1 repair；
- 不新增生产 `HANDOFF_PROOF_HMAC_KEY` 的来源、环境变量、版本、轮换或部署 wiring；
- 不改变 v1 processor、C1、v1 cleanup scanner、自动 PLAYABLE 扫描、owner enrollment 的隐私告知或 G3-C。

## 3. 冻结架构规则

### 3.1 工件身份

- 每项 v2 工件必须精确绑定 `mediaAsset + processingRun + effective planRevision + logicalHandoff + role + mediaObjectId + MediaObject version + checksum`；`mediaObjectId` 为外键，绑定时的 version/checksum 均不得为空，读取前重新验证全部绑定。
- F3-A 不允许一个精确对象版本被多个 live 工件共享，也不允许 BOUND 后重绑。若未来需要 revision re-attestation 或共享，必须先由新合同定义加锁引用计数、最后引用释放条件与物理删除顺序；不能在 F3-A 中静默放宽。
- `HANDOFF_AUDIO` 和 `ALIGNMENT_RAW` 仅能由未来 F3-B 的专用 v2 processor 访问；F2 runtime 继续只处理 metadata，不能把真实对象 key/version/checksum 偷塞进现有 `v2JobHandle`、Adapter 输入、日志、API、callback receipt 或 Outbox 失败诊断。
- reservation、上传成功但未绑定、孤儿、取消、删除和迟到写入必须有可测试的终态；任何不完整或身份不匹配状态不得进入 `MERGING`。

### 3.2 删除与生命周期

- F3-A 只实现生命周期状态机、受限测试库 purge 函数与 purge 资格判断，不执行对象 I/O；现有 `transcriptObjectRetentionMs()` 只能作为旧纯策略参考，绝不得成为 v2 的生产 purge 决策。将来 F3-B 的实际删除必须先删除精确对象版本、再以同一 fence 清除可关联私有关系，或在失败时保持可重试的受控状态。
- 用户删除/取消的顺序必须是：撤销访问 → 持久化删除或取消 fence → 阻止迟到写入 → 受控 purge 工件/证据关系 → 仅保留不可反查、无内容的最小 tombstone。
- 现有 v1 cleanup scanner 维持 v1-only；不得扩展它扫描 v2 metadata 或复用其依赖 metadata 的删除方式。

### 3.3 对齐器边界

- F3-A 只定义本地 adapter 的 server-side Port：输入将来由服务端解析为精确工件和最小窗口，子进程绝不拥有数据库、队列或永久对象存储凭据。
- future input 最多为受控边界音频、最小候选文本、冻结的模型/方法/config digest 和随机 opaque correlation handle；不得传入完整视频、完整音频、完整 ASR raw、owner、asset、run 或对象 key。
- MFA 是“给定音频和文本”的强制对齐器，不是 ASR，也不能以退出码 0 证明候选文本唯一或 handoff 已解决。未知词、字典/模型不匹配、多候选、越界、低质量或结果结构异常必须失败关闭。

### 3.4 proof 和成功边界

- F3-A 仅允许进程内注入的测试 proof service 验证 canonical envelope；它不是生产密钥，也不得经环境变量、数据库、日志或 Git 持久化。
- 在生产 key、真实对象 I/O 和 F3-B 合同全部确认前，F3-A 不物化可发布的 `boundary_forced_alignment` evidence。F2 的“无 raw identity 则失败关闭”规则保持不变。

## 4. 待用户确认的高风险选择

| 选择 | F3-A 推荐默认 | 未确认时的处理 |
|---|---|---|
| F3-A 实施范围 | 仅 schema/受控 purge/LocalAdapter Port/Fake/测试 | 不建 migration、不改代码 |
| 原始工件留存 | F3-A 只测试状态机；F3-B 非私人样本的实际工件验证后立即清理，硬上限 24h | 不写入真实对象 |
| 生产留存政策 | `HANDOFF_AUDIO` 约24h；`ALIGNMENT_RAW` 的产品留存仍待裁决（现有建议有24h与≤7天冲突） | 不把任一建议编码为生产承诺 |
| 对齐器 | 本地 MFA 3.3.9 + 已冻结的 `english_mfa` 模型/词典；CPU、单并发、D盘隔离 | F3-A 不调用 MFA |
| 数据传输/回调 | 纯本机、纯轮询、无 public callback、无第三方传输 | 不开放 endpoint 或网络访问 |
| proof key | 仅测试注入；生产 key 单独确认 | 不接生产 secret wiring |
| 用户媒体/enrollment | 不处理用户媒体；F3-B 前必须将隐私告知版本与 owner enrollment 绑定 | 不自动升级现有 v2 owner enrollment |

## 5. F3-A 确定性验收矩阵

1. 前向 migration 只在新建、可弃 PostgreSQL 测试库中应用；不 backfill 或要求历史 F1/F2 evidence 已有 artifact FK，v1/C1 行、对象、ACTIVE 字幕与历史 migration 不被回填、重解释或阻断。
2. 数据库拒绝跨 asset/run/revision/handoff、错误 kind、null version/checksum、错误对象版本、错误 checksum、重复 handoff/role、同一对象版本的第二个 live artifact、旧 lease、取消后绑定、迟到绑定与任何 BOUND 后重绑；不得信任 metadata、key 前缀或最新版本。
3. 直接 `DELETE`、级联删除、普通应用查询和错误 fence 都不能绕过不可变 trigger；只有受限测试库 purge 函数可在 `DELETING`/`CANCELLED` 与精确 fence 下清除合成测试关系并留下不可反查 tombstone。v1/C1/非 v2 行不可被该函数删除。
4. 新 LocalAdapter Port 与 Fake 覆盖 submit response loss、查询/重试、重启、取消、迟到结果、输入不匹配和结果结构错误；任一无登记 raw identity 的路径维持 F2 失败关闭。
5. F1/F2 兼容回归：既有 strict `strict_segment → MERGING` 继续成功；accepted Fake alignment 无 raw identity 继续是零 evidence、零 `MERGING`、零发布的失败关闭；已有 F2 失败/取消 run 仍可读且不被 F3-A purge 改写。
6. API、普通日志、Outbox、queue、callback receipt、proof、错误与测试快照的 synthetic sentinel 回归均不含正文、音频、raw JSON、对象 key/version、内容 checksum、外部 job ID 或 proof digest。synthetic marker 仅在可弃测试库和无 I/O 测试中出现，绝不扩大为 F2/F3 runtime 的真实身份例外。
7. F3-A 不新增任何 public、owner 或 admin API endpoint；v2 pipeline fence 仍在 legacy storage/FFmpeg/MOSS 之前生效；v1 自动路径、MOSS callback 与 v1 cleanup scanner 回归保持独立。
8. 定向 TypeScript、数据库/Worker/API 测试、根级 lint/test/build、`git diff --check` 均通过；审核后由独立 Reviewer 判断 P0/P1=0。

## 6. F3-B 的明确前置条件（本合同不实施）

F3-A 完成、提交并复核后，仍必须由用户重新确认 F3-B，才可使用一个新建的非私人、许可明确的 30–45 秒英语样本执行：

```text
受控短样本 → 精确 HANDOFF_AUDIO 对象 → 本地 MFA 子进程
→ 精确 ALIGNMENT_RAW 对象 → 结构/身份校验 → 版本 fenced 清理
```

F3-B 必须另行冻结样本来源、对象 bucket/地点/权限、D盘临时目录、模型 identity、窗口与候选文本生成规则、超时/磁盘预算、清理证据、测试 proof key 的使用边界，以及是否允许仅在非私人测试 run 进入 `MERGING`。它不自动授权任何私人媒体、生产 key、正式发布、B2/B3 或 G3-C。

## 7. 停止线与精确恢复点

立即停止并交还用户：

- 任何真实音频、MFA、FFmpeg、对象存储、MOSS、网络或 callback 的执行请求；
- 任何私人媒体、C1、真实用户 enrollment、生产 key、生产 bucket、用户删除实际数据或跨境/地域决定；
- 任何需要扩大为正式发布、revision 1、B2/B3 或 G3-C 的请求。

若你确认第 4 节中 **F3-A 实施范围、受控 purge 的设计方向、暂不处理用户媒体和暂不启用生产 key**，下一步才是创建独立实施分支，完成 F3-A 的 schema/Port/Fake/测试。F3-A 完成后，再由新合同逐项确认 F3-B 的真实非私人技术链。

## 8. 草案独立复核记录

- 复核范围：F1/F2 合同、PRD、当前 schema/Worker/API 边界、工件身份、purge、生命周期和 F2 失败关闭回归；未编辑代码、未启动服务、未处理媒体或网络。
- 初次复核发现的三个 P1（purge 的权限/调用机制、工件不可重绑、F1/F2 兼容回归）均已写入第 2、3、5 节；隐私复核提出的 `mediaObjectId` 外键、非空不可变 version/checksum、单 live artifact、测试库专用 purge 与旧 retention 函数禁用也已明确。
- 最终两份独立只读复核均为 P0=0、P1=0。该结论只证明合同边界完整，不证明 F3-A 实现、真实对象/MFA 链路、私人媒体、G3-BE1/B2/B3/G3-C 或 G3 Gate 已通过。
