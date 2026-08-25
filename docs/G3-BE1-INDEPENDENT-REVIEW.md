# EchoFlow G3-BE1 独立合同与代码边界复核

复核日期：2026-08-25
复核范围：`G3-BE1` 的合同、PRD/G3 约束与当前 `g3-transcript-v1` 代码切面。
源代码锚点：`3378f6d`（本复核开始前的实施分支 HEAD）。
执行边界：仅只读文档/代码复核；未启动 Docker、模型或媒体任务，未读取、上传、删除或记录任何私人媒体或字幕正文。

## 复核结论

| 优先级 | 数量 | 结论 |
|---|---:|---|
| P0 | 0 | 合同没有放宽无证据即失败关闭、唯一 ACTIVE 原子发布、revision `0 → 1` 上限或私有内容边界。 |
| P1 | 0 | 没有发现阻断进入“起草 `g3-transcript-v2` 实施合同”的矛盾。 |
| P2 | 6 | 下节项目必须成为 v2 实施合同的明确验收项；尚未授权实施。 |

因此，BE1 的“独立文档/架构审查”完成；它只批准下一步创建实施合同，不批准代码、迁移、Docker、模型、能力探针、真实样本或 B2/B3。

## 已验证事实

| 主题 | 复核事实 | 代码/合同锚点 |
|---|---|---|
| Provider 能力 | 当前固定 Gateway 的 ready/result 只提供带时间的 `segments`，没有可消费的原生 `words[]`；路线 A 目前不可用。 | `G3-BE1-HANDOFF-EVIDENCE-TASK-CONTRACT.md` §2.2；EchoFlow `apps/worker/src/moss/adapter.ts` |
| 词级路径 | Adapter 可以校验并承载 Provider 原生词级时间，但不会伪造词。现有 `mergeChunkResults()` 用文本/时间重叠去重，并会按时间丢弃重叠词；它没有 run、revision、chunk pair、checksum 或 proof 验证。 | `apps/worker/src/moss/adapter.ts`；`apps/worker/src/transcript/merge.ts:59-115` |
| segment 路径 | segment-first 路径会在文本/时间/speaker 候选不唯一时抛出结构化失败并保持失败关闭；它不是音频锚定 proof。 | `apps/worker/src/transcript/merge.ts:165-368`；`merge.test.ts` |
| 持久化边界 | `ProcessingChunk` 已绑定单一 ASR 输入、外部 Job、结果、lease、幂等键与 callback，不能承担第二类对齐任务；目前不存在 evidence/alignment 实体、对象类型或处理阶段。 | `packages/database/prisma/schema.prisma:243-327` |
| 当前发布 | 当前发布会校验 effective chunks 与 ASR 结果对象并构建字幕；成功路径尚不查询每个 handoff proof 或 `H_*` 计数。 | `apps/worker/src/processors/transcript.ts:1092-1228` |
| 版本路由 | 数据库允许同一媒体按 `pipelineVersion` 并存 run，但 Worker/Outbox/恢复目前固定 `g3-transcript-v1`。v2 不能只替换 merge 函数。 | `apps/worker/src/transcript/constants.ts`；`apps/worker/src/processors/transcript.ts`；`apps/worker/src/outbox.ts` |

上述事实支持 BE1 合同的核心判断：当前 v1 必须继续严格失败关闭；推荐的路线 B 只是待选择、待验证的设计，不能被写成已经具备的能力。

## v2 实施合同必须固定的 P2 项

1. 明确本轮批准的仍只是“实施合同”，不是代码、迁移、Docker、模型、能力探针或真实 B2/B3。
2. 将强制对齐产生的证据标记为 `boundary_forced_alignment`；不得伪装成 `provider_native_word_timing`，也不得替代 Provider 原生 `words[]` 的能力探针。
3. 固化 `HandoffEvidence` 的唯一键、不可变性、checksum/对象版本规范化、proof digest 的规范化算法及其非公开可见性；proof、API 与普通日志不得含可反推正文的内容或哈希。
4. 定义 `H_total = effectiveChunkCount - 1`（单 Chunk 为 `0`），以及 revision overlay 下的计数归属；每个逻辑 handoff 必须恰有一个最终决定，且 `H_*` 等式可由持久化记录重算。
5. 对路线 B 单独定义 evidence/alignment job 的幂等键、lease、取消、迟到回调、稳定失败码、私有对象保留和清理；不得复用 `ProcessingChunk`。
6. 将确定性矩阵落实为可执行测试：所有绑定身份不匹配拒绝、发布事务回滚、权限/API 脱敏、重启/重复回调/旧 lease/清理 fencing，以及 v2 的 dispatch、恢复与 v1 并存语义。

## 未验证事项与停止线

- 未验证任何新对齐器是否可产生足够的音频锚定交接证据；路线 B 的具体技术、资源成本和保留策略仍需用户后续确认。
- 未对 Provider 执行新的能力探针，未验证 `words[]`，也没有重新运行 C1。
- 未运行 Fake/数据库/真实 MOSS 验证；它们属于未来 v2 实施合同的验收，不能被本次文档复核替代。
- G3 继续打开，G3-C 与 G4/G5 继续冻结。

## 精确恢复点

下一项仅可新建并审阅 `g3-transcript-v2` 实施合同：先选择/界定证据路线与数据生命周期，再定义确定性验证；在该合同完成、实现经独立审查且用户确认模型/样本资源之前，不启动 Docker、模型、媒体或迁移。
