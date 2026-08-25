# EchoFlow G3-BE1 跨分片交接证据增强任务合同

确认日期：2026-08-24
状态：独立文档/架构复核及后续 [g3-transcript-v2 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)复核均已通过；未启动新模型、未选择新样本、未开始实现。BE1 复核结论见 [G3-BE1 独立合同与代码边界复核](G3-BE1-INDEPENDENT-REVIEW.md)，v2 合同结论见 [G3 v2 实施合同独立复核](G3-TRANSCRIPT-V2-IMPLEMENTATION-REVIEW.md)。
所属 Gate：G3-B 的补充证据任务，不是新 Gate；不关闭 G3，不进入 G3-C，不解冻 G4/G5。
关联：[G3-B 分片交接能力基准合同](G3-B-SEGMENT-HANDOFF-BENCHMARK-CONTRACT.md)、[G3 任务合同](G3-TASK-CONTRACT.md)、[执行状态](EXECUTION-STATE.md)、[V1 PRD](EchoFlow-V1-PRD.md)。

## 1. 唯一决策问题

在不放宽“完整字幕原子发布、最多一次 revision 1、无证据即失败关闭”规则的前提下，是否能建立一种**音频锚定、可复现、可审计**的跨分片交接证据，使每个相邻 Chunk 被唯一判定为：

```text
accepted（唯一可接受）
或
insufficient / ambiguous（拒绝发布）
```

本任务不问“怎样让文本尽量拼起来”，而是问“怎样证明被拼接的文本确实归属于同一段语音，且不会造成重复、遗漏或错序”。

## 2. 已冻结事实

### 2.1 C1 的真实结论

- 新授权的私有长媒体 C1 已完成受控终态；8 个有效 Chunk 的 MOSS 任务均成功，且只执行了一次 revision 1；
- 最终严格合并以 `transcript_incomplete` 失败关闭，白名单 failure class 为 `no_textual_suffix_prefix`；
- 没有 `TranscriptVersion`、ACTIVE 或 Cue；owner 字幕接口为 `409 transcript_not_ready`，播放仍可用；
- 该结果证明当前 segment-first 文本交接规则不足，**不**证明模型、音频、网络、硬件或任何私人字幕正文的具体错误；
- C1 保留为失败关闭证据，不得自动重跑、不得创建 revision 2、不得读取或写入其私人正文。

### 2.2 当前 MOSS Provider 的能力边界

- 固定 Provider 的 ready 协议为 `resultGranularity: segment`；真实 Provider/Gateway 成功结果只含语言与带时间的 segments；
- Gateway 明确不伪造 `words[]`；固定真实模型的既有真实验证也只证明 segment 时间存在、单调且在边界内；
- 模型内部时间 marker、hidden state、attention 或可能的 acoustic-event 文本都没有被当前 Gateway 暴露、校准或验证为“词 → 音频时间”对齐，不得当作发布证据；
- 匿名 speaker 标签不能证明跨 Chunk 的恒定说话人身份；音频重叠或声纹相似只能证明音频相关，不能证明某个文本 token 的删除、保留或所有权。

### 2.3 EchoFlow 的现有切面

- `MossResult.words[]`、Adapter 校验、Cue `words[]` 和 owner 字幕 API 已能承载**Provider 原生**整数毫秒词级时间；
- 但现有 `mergeChunkResults()` 在字级路径上会按时间丢弃重叠词，并不要求每个 handoff 有唯一证明；它不能直接作为本合同的发布验证器；
- 现有 segment 路径才会在无唯一文本/时间/speaker 交接时失败关闭，并驱动 revision 1；
- 当前只在失败时持久化 `g3MergeFailureDiagnostic`，成功发布时没有持久化 `H_total / H_unique / H_r1 / H_unresolved` 或每个成功 handoff 的 proof；
- `ProcessingChunk` 已绑定单一 ASR 输入、外部任务、结果、lease、幂等键和不可变 trigger。不得复用它承载第二类对齐任务。

## 3. 非目标与禁止项

- 不修改当前 C1、其私有媒体、对象、数据库记录或终态；
- 不扩大到 60 分钟或更长媒体的真实运行、采购 GPU、重新设计播放器或用户端 UI；
- 不以增大 overlap、随机静音重切、LCS 放宽、按左/右保留、平均分配时间、人工改写字幕或 revision 2 伪装解决；
- 不把一个未校准的 embedding、attention、声纹分数或“模型看起来一致”当作交接 proof；
- 不把新算法伪装成 `g3-transcript-v1` 的普通 retry；
- 不向 Git、普通日志、Obsidian、公开 API 或错误详情写入音频、字幕正文、token、URL、object key、数据库 ID、Cookie 或密钥。

## 4. 证据领域合同：`HandoffEvidence v1`

每个相邻有效 Chunk 都必须有一个不可变的 handoff evidence record。该 record 的摘要可持久化；原始对齐/ASR 结果只能以私有对象保存并按生命周期清理。

```text
schemaVersion
processingRun / pipelineVersion
planRevision
previousChunk identity + nextChunk identity
normalized-audio object version/checksum identity
previous/next ASR result checksum identity
evidenceType
provider-or-aligner name, version, model revision, decoder/alignment configuration digest
absolute evidence window [startMs, endMs)
raw-evidence object checksum identity (private object only)
candidateCount / strongCandidateCount / coverage metrics (no text)
decision = accepted | insufficient | ambiguous
decisionCode (white-listed)
proofDigest
createdAt / verifiedAt
```

`proofDigest` 只能是规范化、**不含文本/token、音频字节、候选文本或其 hash** 的结构化 proof 信封摘要；它绑定版本、范围、checksum 身份、方法、决定和白名单代码，不能作为短语或字幕的可猜测摘要。原始证据对象继承 G3 的私有对象生命周期，并受 run / revision / object version fencing 保护。

`HandoffEvidence v1` 的数据不变量：

1. 只绑定当前 ProcessingRun、当前有效 plan revision 和相邻 `(previousChunkIndex, nextChunkIndex)`；
2. 输入音频、两侧 ASR 原始结果、证据模型/对齐器和配置都必须精确匹配其 checksum/version；任一不匹配立即拒绝；
3. 证据窗口必须落在规范化音频范围内，并覆盖实际分片重叠窗口或预先登记的边界窗口；
4. `accepted` 必须证明候选唯一、时间单调、音频归属一致、没有弱单 token 或多解；
5. `insufficient` 与 `ambiguous` 不允许降级为猜测性合并，必须保留 `transcript_incomplete`；
6. proof 摘要、聚合计数和方法版本必须可审计；字幕正文与原始对齐内容不进入摘要。

## 5. 允许评估的路线

### 路线 A：Provider 原生真实词级时间

只有能力探针证明 Provider 真实返回 `words[]`，且每个词均有来自推理输出的、单调、在输入范围内的整数毫秒时间，才可评估该路线。

额外要求：

- 新增严格 word-handoff validator，而不是复用“按时间丢弃”旧逻辑；
- 交接至少需要两个来自 Provider 原生输出、彼此一致且其实际音频范围交叠的词级锚点；单词、仅文本耗尽或仅时间启发式均不是例外；
- 无文本交接、时间冲突、speaker 冲突、多重候选、单词弱候选、混合 words/segments 均失败关闭；
- 每个成功 handoff 必须持久化无正文 proof 摘要与 `H_*` 聚合；
- 新行为使用新的 `pipelineVersion`，例如 `g3-transcript-v2`，不得改变 v1 既有 run 的解释。

当前结论：本路线**尚未可用**，因为固定 Gateway 当前只输出 segment。能力探针可以否定它，但一次探针成功不能直接放行 G3-B。

### 路线 B：边界强制对齐或等价声学交接层

当 Provider 没有可消费的原生词级时间时，只能评估一个独立的、窄边界音频对齐/声学证据层。它不是“把两个字幕文本相似度算得更高”，而是要对同一段有限音频建立可复核的文本—时间关联。

最小边界：

- 只处理相邻 Chunk 的受控边界窗口；
- 对齐层必须独立持久化状态、attempt、lease、幂等键、外部任务、取消、错误与生命周期；
- 不能复用 `ProcessingChunk`，建议新增 `ProcessingHandoffEvidence` / `AlignmentJob` 领域实体；
- 原始对齐结果和必要边界音频为私有对象；摘要仅保存版本、checksum、范围、候选计数、决定和 proof digest；
- 若对齐器生成完整真实词级时间，最终仍须通过路线 A 的严格 word-handoff validator；若只生成交接 proof，segment 合并器必须显式消费 proof，不能以文本猜测补齐；
- 通用 acoustic similarity、speaker similarity 或一个单点 confidence 不是充分 proof。

当前结论：这是推荐的主候选，但仍只是待验证设计，不得写成已具备能力。

## 6. 实施切面（在能力选择后才开始）

| 切面 | 路线 A | 路线 B |
|---|---|---|
| Pipeline | 新 `pipelineVersion` + 严格 word-handoff validator | 同左，并增加 evidence/align stage |
| 数据库 | 不可变 proof manifest 或 evidence 表 | 独立 `ProcessingHandoffEvidence` / `AlignmentJob` 表，不能覆盖 ProcessingChunk |
| 对象存储 | 私有 raw Provider result / proof checksum | 另有私有 raw alignment result；若截取边界音频，增加受控临时对象种类 |
| Worker | 纯验证可在 transcript 流水线前完成 | 新 processor 管理对齐任务、lease、轮询、取消和清理 |
| 发布事务 | 重新检查所有有效 chunk + proof 已验证后才创建 ACTIVE | 同左 |
| API/Web | ACTIVE 字幕接口可保持；状态增加 handoff 计数 | 同左；不得暴露 proof 正文或对象信息 |
| Callback | 无异步新 Provider 可不改 | 新建安全 evidence callback/receipt，或审慎泛化现有 callback 关联 |

成功发布前的逻辑必须等价于：

```text
effective plan chunks 全部 SUCCEEDED
+ 每个 required handoff 恰有一个 VERIFIED/accepted proof
+ proof 与输入、ASR 结果、revision、模型、配置精确一致
+ H_unique + H_r1 + H_unresolved = H_total
+ H_segment + H_providerWord + H_alignment = H_unique + H_r1
+ H_unresolved = 0
→ 同一事务发布唯一 ACTIVE TranscriptVersion 与 Cue
```

其中 `H_unique` 是 revision 0 即被最终接受的 handoff 数，`H_r1` 是只在唯一允许的 revision 1 后被最终接受的 handoff 数，`H_unresolved` 是 revision 1 后仍未被接受的 handoff 数；三者覆盖每一个相邻有效 Chunk。每个 accepted record 必须恰属于一种白名单 `evidenceType`：`strict_segment`、`provider_native_word_timing` 或 `boundary_forced_alignment`，并分别汇总到 `H_segment`、`H_providerWord`、`H_alignment`。若未来新增类型，必须先升级本合同的 schema、白名单与等式；不得以未分类证据发布。

任一失败时：无旧 ACTIVE 则零 Version/零 Cue；已有旧 ACTIVE 则旧版继续可读。迟到回调、旧 lease、重复消息或取消后的结果都不得发布。

## 7. 确定性验证矩阵

在接触任何新真实样本前，先用 Fake MOSS/合成边界完成：

1. 唯一强 word/proof 成功；
2. 无文本交接、时间冲突、speaker 冲突、多候选、弱单 token、范围越界、输入/ASR/evidence checksum 不匹配；
3. `accepted` proof 绑定错误 run、revision、chunk pair、模型版本、对象版本时全部拒绝；
4. 混合 words/segments 或声学证据缺字段时失败关闭；
5. revision `0 → 1 → FAILED` 仍无 revision 2，旧 Chunk、输入、ASR 原始结果不可变；
6. proof 成功但发布事务失败时，不产生半套 Version/Cue，旧 ACTIVE/lesson 不被破坏；
7. 对齐任务的提交响应丢失、重启、重复回调、取消、旧 lease、临时对象清理与权限隔离；
8. API 只暴露脱敏 processing stage/计数，owner 不能读取 BUILDING、REJECTED 或他人证据；
9. 错误详情、日志和诊断不泄露正文、token、URL、object key 或 ID。

验收要求：定向单元、数据库集成、Fake MOSS、lint、test、build 和独立 Reviewer 均通过。Mock/测试通过只证明实现合同，不证明真实 MOSS 或 G3-B 通过。

## 8. 真实能力探针与后续样本规则

能力探针须另行登记并在执行前再次获得用户对模型/样本资源使用的确认：

1. 优先使用独立、许可明确、非私人、约 30–45 秒的英语实验 WAV；两个输入 Chunk 仅有预登记的小重叠，重叠中含唯一短语；
2. 固定当前模型、Provider、GPU 与解码配置；只记录字段集合、`hasWords`、词数、时间范围/单调性、granularity 和 `H_*` 结构计数；不保存音频、词或字幕正文；
3. 若没有真实可消费 `words[]`，确认当前 Provider 路线不能补充交接证据，转向路线 B 设计；
4. 若有 `words[]`，先验证来源、范围、单调性、跨两个 Chunk 的绝对时间一致性和唯一性，仍不得直接发布长媒体；
5. 只有 BE1 代码/确定性验证通过后，才可由用户选择新的、重新授权的 B2/B3 约 30 分钟样本；不得自动重跑 C1；
6. 两份独立样本的 `H_unresolved=0`、唯一 ACTIVE、Cue 时间有效及私有人工交接审计 `duplicate=0`、`omission=0`、`reorder=0`，才允许进入 G3-C。它仍不关闭 G3。

## 9. 本合同的完成与停止条件

本合同本身完成的定义是：

- 已把 C1 的真实失败结论、Provider segment-only 事实、字级路径非严格事实和不可放宽的不变量写成可审查任务边界；
- 已明确能力探针、路线选择、实施切面、确定性测试和真实验证的先后关系；
- 已通过独立文档/架构审查；
- 尚未把任何设计、能力探针或 Fake 测试说成真实交接已经解决。

停止并交还用户的情况：需要下载/采购新模型、移动 Docker 数据根、运行真实样本、选择强制对齐器或改变数据保留策略时；这些均会带来成本、隐私或架构选择，必须另行确认。

## 10. 精确恢复点

`g3-transcript-v2` 实施合同及独立复核已完成。下一项只能在用户确认具体 Route B 对齐器、数据处理边界、资源成本和保留策略后，新建“v2 实施启动合同”；不启动 Docker/模型、不上传/删除媒体、不创建数据库迁移。

实现前的恢复顺序：

```text
独立审查本合同（已完成）
→ 新建并独立复核 g3-transcript-v2 实施合同（已完成，Route B）
→ 用户确认具体对齐器、数据/网络/保留与资源边界
→ 新建 v2 实施启动合同
→ 确定性/Fake 验证
→ 独立审查实现
→ 用户确认能力探针资源与样本
→ 真实 B2/B3
```
