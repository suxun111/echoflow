# EchoFlow G3-B 分片交接能力基准合同

确认日期：2026-08-23；状态更新：2026-08-24
状态：C1 已在新授权私人长媒体上完成并正确失败关闭；B2/B3 暂停，先执行 [G3-BE1 跨分片交接证据增强任务合同](G3-BE1-HANDOFF-EVIDENCE-TASK-CONTRACT.md)的设计与确定性验证准备
所属 Gate：G3 内部证据阶段，不是新的 Gate，不关闭 G3，也不解冻 G4/G5
关联：[G3 任务合同](G3-TASK-CONTRACT.md)、[G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)、[执行状态](EXECUTION-STATE.md)

## 1. 要回答的唯一决策问题

在固定 MOSS 模型、硬件和分片计划下，`segment-first + 严格合并 + 至多一次 revision 1 repair` 是否能为约 30 分钟英语媒体的**每一个跨分片交接**提供唯一、可验证的合并证据，从而安全产出完整、可审计的 ACTIVE 英文字幕？

这里的“可验证”不是“所有外部任务都成功”，而是每个被接受的交接都同时满足既有严格合并的文本、时间和 speaker 兼容条件，且不存在多个同样有效或仅单 token 的弱候选。

### 已知事实与本合同边界

- 已有真实 30 秒模型/Provider 冒烟，以及一次真实约 5 分钟 EchoFlow → MOSS → ACTIVE 字幕发布；
- 一次真实约 31 分钟运行中，revision 0 的 6 个分片和 revision 1 的 2 个替换分片均成功，但 revision 1 后仍无唯一交接证据，正确以 `transcript_incomplete` 失败关闭；没有 ACTIVE `TranscriptVersion` 或 Cue；
- 该历史运行早于结构化 `g3MergeFailureDiagnostic`，不得倒推填入新的 failure class；
- 本合同的 C1 已在新授权私人长媒体上执行：8 个有效 Chunk 在一次 revision 1 后仍以 `transcript_incomplete` / `no_textual_suffix_prefix` 失败关闭；没有 `TranscriptVersion`、ACTIVE 或 Cue，owner 字幕读取为 `409 transcript_not_ready`，播放仍可用。该事实不记录或推断私人媒体身份、正文或运行标识；
- C1 仅证明在 C1 的输入、配置和当前 `segment-first` 语义下，现有路线缺少可接受的唯一交接证据；它不能单独判定 C2/C3 的参数候选无效。为避免无界调参，决策上先暂停 C2/C3，等待 [G3-BE1 合同](G3-BE1-HANDOFF-EVIDENCE-TASK-CONTRACT.md)冻结并验证补充证据路线；
- 本合同不评估学习体验、字幕整体 WER/CER、逐词时间准确率、60 分钟容量、回调/重启/取消恢复或生产 SLO。

G3-B 的结论只能是“当前交接路线可进入 G3-C”“当前路线不可行/需要补充证据”或“证据不足”；它不能关闭 G3。

## 2. 不可放宽的发布与隐私边界

- 逐词时间戳仍不是 V1 的必选展示产物；但切片输入必须有可验证的跨分片唯一交接证据。段级结果只有在严格合并实际得到该证据时才足够；否则必须失败关闭，或由 Provider/经过验证的对齐层提供真实补充证据；
- 不得自动重跑既有私人样本，不得创建 revision 2，不得以随机静音重切、文本猜测、LCS 降级、人工改写字幕或页面状态冒充成功；
- 失败 run 必须保持 `TranscriptVersion=0`、ACTIVE=0、Cue=0，owner 读取字幕为 `409 transcript_not_ready`，同时原视频保持 `PLAYABLE`；
- 成功 run 必须只存在一个 ACTIVE 版本，所有 Cue 非空、时间单调、无越界；
- 样本必须是新选定、授权明确、可重复使用的英语基准媒体。证据和 Git 不得写入媒体路径、原始音视频、字幕正文、参考文本、Token、URL、object key 或数据库 ID；
- 如存在合法参考转写或音频回听，它只用于私有人工交接审计，不成为手动字幕产物，也不进入 Git。

## 3. 冻结输入与运行配置

每次运行前创建一份不含私人内容的 run manifest，至少记录：

```text
EchoFlow Commit / MOSS Commit / Provider 版本 / 模型 ID 与 revision
GPU、驱动、CUDA、CPU、RAM、系统盘与工作盘可用空间
Docker 容器名、端口、隔离数据库/Redis DB/bucket 标识
16 kHz 单声道 WAV、分片算法、实际边界、重叠、解码参数
样本授权类型、时长区间、匿名样本代号与 SHA-256（仅在私有运行记录）
```

run manifest 必须存放在受访问控制、被 Git 忽略的本地私有位置；不得写入 Git、公开数据库字段、普通日志或 Obsidian 同步。任务完成后只保留不含样本身份、正文和路径的脱敏汇总；原始私有 manifest 按既有失败检查点生命周期删除。

本机已经证明整段约 31 分钟会 OOM、约 10 分钟片在当时预算内未完成，因此“约 10 分钟分片”不是本机默认事实。初始基线配置固定为：

```text
C1 = 300 秒目标分片 / 2 秒重叠 / silence-aware 边界
```

若 C1 不能发布，只能在启动前登记独立配置后继续，例如 `C2 = 300 秒 / 5 秒`、`C3 = 240 秒 / 5 秒`。配置变化是新的初始计划，不是假装成同一输入的 retry；每个计划仍只允许既有的一次 revision 1 repair。

## 4. 分阶段执行

### B0：不启动模型的预检（已完成）

确认实际写入根为 `C:\Users\33442\Documents\影子学习videcoding（online learning）`，记录分支与 Commit；检查 Docker/端口、模型 revision、GPU、系统盘与临时工作盘可用空间。B0 唯一允许的写入是上述私有 run manifest；若任一项不满足其预先声明，停止，不启动 Worker、模型或真实媒体任务。

### B1：当前基线 C1（已完成，失败关闭）

以 C1 在一份新的、受权的、约 30 分钟样本上执行真实 EchoFlow → MOSS → 严格合并。每个阶段可恢复；不得因 Agent/终端会话中断而重置已持久化的阶段事实。

### B2：预登记的有限候选（暂停）

只有 B1 的结构化结果和私有交接审计完成，且 G3-BE1 已提供经确定性验证的严格 handoff evidence 方案后，才可运行预登记的 C2/C3。不得对某个失败边界临场随机调参。

### B3：独立确认（暂停）

选定配置必须在第二份彼此独立、重新授权的约 30 分钟样本上复现，并使用相同的 EchoFlow/MOSS Commit、Provider/模型 revision、GPU 级别、分片参数和重叠；任何变化均另记为新的 Cx。B1/B2/B3 任一成功都不自动变成 60 分钟发布或 G3 关闭证据。

## 5. 必须记录的脱敏指标

每个完整 run 记录下列聚合指标，而不记录字幕正文：

```text
H_total        = 所有相邻 chunk 的交接数
H_unique       = 初次严格合并有唯一强证据的交接数
H_r1           = 经一次允许 revision 1 repair 后获得唯一强证据的交接数
H_unresolved   = revision 1 后仍不能合并的交接数
H_failureClass = 白名单 failure class 的分布（仅新运行）
release        = 是否产生唯一 ACTIVE
```

同时记录：音频时长、分片数、每个 Chunk 终态的聚合、端到端耗时、RTF、峰值 VRAM/RAM、系统盘/工作盘最低余量、对象大小聚合与 Provider 错误类别。

每个 run 必须满足 `H_unique + H_r1 + H_unresolved = H_total`。对每一个导致 ACTIVE 的 handoff 做私有人工审计，确认自动去重对应同一语音内容，且 `duplicate=0`、`omission=0`、`reorder=0`。审计记录只保留 pass/fail 与聚合计数，不保存字幕片段、截图、参考转写或音频内容。这不是让用户手工制作字幕，而是验证模型与合并规则的安全性。

## 6. 判定规则

### 可以进入 G3-C

仅在以下条件同时满足时，当前配置才可进入 G3-C 的 60 分钟、恢复与容量矩阵：

1. 两份彼此独立、重新授权的约 30 分钟样本均产生唯一 ACTIVE；
2. 两次 run 都满足 `H_unresolved=0` 且 `H_unique + H_r1 = H_total`；
3. 所有导致 ACTIVE 的 handoff 已完成私有人工审计，重复、遗漏、错序均为 0；
4. 失败/取消路径仍符合失败关闭与原子发布不变量；
5. 不发生 OOM，并已如实记录实际资源与耗时。

这只证明该配置值得扩大验证，不证明生产可靠性、60 分钟能力或 G3 已关闭。

### 停止扩大并转向补充证据

- 任一已发布字幕经交接审计发现重复、遗漏或错序：立即停止该合并策略，不以“多跑几次”掩盖；
- 一个样本在 revision 1 后仍有 `H_unresolved>0`：当前配置不可行，可转入预登记的下一个配置；
- 两份独立样本均无法发布：停止扩大到 60 分钟，优先评估真实逐词时间戳 Provider、强制对齐层或等价的声学交接证据；
- OOM、超时或空间不足：记录为“该硬件 + 配置”的容量失败，不得据此断言合并算法已失败或仅靠更大 GPU 必然能解决交接问题；
- 仅获得结构诊断而未运行新的真实样本：只能得出“可诊断”，不得写为“交接已解决”。

## 7. 与 G3 总门禁的关系

G3-B 仅组织当前最不确定的技术决策。G3 的最终退出条件仍以 [G3 任务合同第 7 节](G3-TASK-CONTRACT.md#7-gate-退出条件) 为准：包括 5/30/60 分钟真实矩阵、失败/恢复、安全、Reviewer、fresh clone 与证据进入唯一 trunk。

实施切片 `G3.1–G3.6` 与证据阶段 `G3-A/B/C` 正交；不得因为完成文档、B0 预检或单次 B1 成功就进入 G4。

## 8. 精确恢复点

下一次行动是审阅并执行 [G3-BE1 跨分片交接证据增强任务合同](G3-BE1-HANDOFF-EVIDENCE-TASK-CONTRACT.md)的设计与确定性验证准备；本合同本身不启动 Docker、模型、真实媒体任务或 C2/C3。任何新的能力探针、对齐器实现或受控样本运行都必须在 BE1 准入条件满足后由用户重新明确授权。
