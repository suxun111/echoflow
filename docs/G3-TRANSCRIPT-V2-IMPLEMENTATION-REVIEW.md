# EchoFlow G3 `g3-transcript-v2` 实施合同独立复核

复核日期：2026-08-25

复核范围：仅文档合同及其与当前 G3/BE1 代码边界的对应关系；不含实现、迁移、模型、Docker、媒体、能力探针或真实运行。

代码锚点：`codex/g3-moss-transcript-20260813@2142180`。
被复核合同：[G3 `g3-transcript-v2` 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)。

## 结论

终态为 **P0=0、P1=0**。合同可以作为“等待用户选择后的实施启动合同”的上游边界，但不代表 Route B 已被实现、对齐器可用、真实交接问题已经解决，亦不允许推进 G3-C 或关闭 G3。

## 方法与覆盖面

三条相互独立的只读复核线分别核对：

1. 架构与状态机：现有 G3/BE1 失败关闭、revision 上限、原子发布、v1/v2 并存、run ownership 与恢复语义；
2. 代码边界：`G3_PIPELINE_VERSION` 的 v1 自动入口、`ProcessingRun`/`ProcessingChunk`/callback/outbox 的实际职责，以及 v2 不能直接替换 v1 的原因；
3. 隐私与生命周期：最小化数据、proof key 隔离、对象版本/TTL、删除、callback、日志与脱敏边界。

复核过程中发现的合同缺口均已在最终版本收敛：strict segment assessment 与 final proof 不再混用；`TranscriptRunArbiter` 覆盖 v1 retry/re-queue、v2 enrollment/retry 和 Outbox 创建；revision 1 仅允许来自 strict assessment 的既有白名单歧义；`H_*` 定义、current-revision 范围、对齐 retry、proof key、callback 路由和删除链路均固定为可验证要求。

## 仍未验证的事项

- 未选择具体强制对齐器、模型、许可证、供应商或 callback/轮询方式；
- 未验证任何 migration、数据库约束、Fake、单元/集成测试、构建或生产运行；
- 未下载模型、启动 Docker、上传/读取/删除媒体，也未运行能力探针、B2/B3 或 G3-C；
- C1 的严格失败关闭保持不变，不能因本文档被重跑、补写或升级为 revision 2。

## 精确恢复点

用户先确认合同第 12 节的具体对齐器、数据/网络/保留边界、资源上限及非私人能力探针方案；随后才可新建 v2 实施启动合同。该确认前不得实现、迁移、安装依赖、启动运行态服务或处理任何媒体。
