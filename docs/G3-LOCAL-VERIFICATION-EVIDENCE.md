# EchoFlow G3 本地实现验证证据

验证日期：2026-08-13

实施分支：`codex/g3-moss-transcript-20260813`

基线：`master@0c3e2ee`

合同锚点：`b191499`

本地代码验收锚点：`8139081fad3a89332e440a66dde75e9949209f50`

状态：本地实现候选通过；G3 Gate 保持打开

## 1. 结论

`8139081` 已形成可恢复的本地 G3 候选链路：从已 PLAYABLE 的私人 MP4 提取 16 kHz 单声道音频、静音附近分片、通过统一 Adapter 执行 MOSS `submit/query/result/cancel`、接收 HMAC 回调并以轮询兜底、保存不可变 ASR 原始结果、合并和校验逐词时间戳，最后在单个数据库事务中发布唯一 ACTIVE 英文字幕。

本地自动化、真实 PostgreSQL/Redis/MinIO/FFmpeg 集成、生产构建和独立代码审查均通过，当前没有已知 P0/P1。

这不是 G3 关闭证据。真实 MOSS endpoint、认证和供应方协议尚未提供，30 秒及 5/30/60/120 分钟真实 MOSS 样本矩阵没有执行；因此不能声称真实长视频已经由 MOSS 生成合格字幕，也不能进入 G4。

## 2. 已实现并验证的边界

- PostgreSQL 增量迁移建立 G3 ProcessingRun/Chunk、回调防重放、对象事实和字幕发布所需约束；
- API 提供 owner-scoped 字幕状态、ACTIVE 字幕读取、幂等重试/取消，以及独立 HMAC MOSS Callback 信任边界；
- Worker 使用 PostgreSQL 作为事实源，Redis/BullMQ 只负责唤醒；空队列可由持久状态重建；
- 每次处理调用使用独立 lease generation；Run 与 Chunk 的认领、续租、状态写入和最终发布都受同一代际 fencing；
- 外部 Job 使用稳定幂等身份；提交响应丢失、回调丢失、乱序/重复回调、超时取消失败和 Worker 接管均可恢复；
- G3 临时对象在网络写入前建立数据库身份，并写入不可变物理 attempt key；每个存活对象 Version 都有可追踪事实；
- 清理先在短事务中提交 tombstone，再在事务外按非空 exact Version 删除，最后以短事务 CAS 标记 purged；迟到上传、缺失 PENDING 和重试采用均有收口路径；
- 所有分片成功且逐词时间戳、单调性、边界和来源完整性通过后，才会发布唯一 ACTIVE 字幕；任一失败不会暴露半套字幕；
- Web 只显示真实持久阶段、分片计数和当前 ACTIVE 字幕，不用假百分比冒充进度。

## 3. 当前 Commit 的确定性验证

运行环境：Windows；Node `v24.18.0`；pnpm `11.9.0`；Docker `29.6.2`；FFmpeg/ffprobe `8.1.2`。

| 命令/检查 | 结果 | 证据边界 |
|---|---|---|
| `docker compose -f infrastructure/docker-compose.yml ps` | PostgreSQL、Redis、MinIO 均 healthy | 本机开发基础设施，不代表生产环境 |
| `pnpm lint` | 通过 | 5 个共享包和 4 个应用的 TypeScript 静态检查 |
| `pnpm test` | 146 passed，4 skipped | 包含真实 PostgreSQL/MinIO/Redis/FFmpeg 和确定性 Fake MOSS；跳过项是需要显式真实长媒体输入的 G2 矩阵 |
| `pnpm build` | 通过 | config/contracts/database/storage/ui 与 Web/Admin/API/Worker 生产构建 |
| `pnpm --filter @online-learning/database exec prisma validate` | 通过 | G3 schema 可由 Prisma 解析 |
| `docker compose -f infrastructure/docker-compose.yml config --quiet` | 通过 | Compose 结构有效，不代表生产部署验收 |
| `git diff --check` | 通过 | 无补丁空白错误 |

测试分布：

| 范围 | 通过 | 跳过 |
|---|---:|---:|
| Config | 13 | 0 |
| Contracts | 5 | 0 |
| Database | 8 | 0 |
| Web | 41 | 0 |
| API | 23 | 0 |
| Worker | 56 | 4 |
| 合计 | 146 | 4 |

Worker 的 56 个通过测试中，G3 主流水线为 28 个，另含 MOSS Adapter 6 个、分片 4 个、合并校验 7 个和 G2 播放回归 11 个。G3 测试覆盖成功发布、单片失败、取消、24 小时/7 天保留、Run/Chunk 代际接管、真实子进程 kill/restart、提交和上传响应丢失、迟到上传、对象 checksum 损坏、发布事务回滚、Redis 空队列重建及 exact Version 清理。

## 4. 独立审查

独立 Reviewer 在多轮只读审查中曾阻断以下问题，修复后重新审查：

- 旧 Worker 丢租约后仍可能完成 Chunk 或发布；
- 对象上传与数据库事实之间的崩溃窗口可能产生不可枚举版本；
- 取消扫描可能把暂时查不到的外部 Job 错判为已取消；
- 同进程并发任务复用 workerId，不能区分 lease generation；
- cleanup 在长数据库事务内执行对象删除，数据库连接丢失时存在复用/删除竞态；
- Chunk 业务写只校验 Chunk token，未同时原子校验当前 Run generation。

最终对 `8139081` 的结论为：未发现已知 P0/P1，批准该本地代码锚点。该审查是代码与本地证据审查，不包含真实 MOSS 运行验证。

## 5. 仍然阻塞 G3 的外部证据

以下任一项不能由 Fake MOSS 或测试数量替代：

1. 冻结真实 MOSS endpoint、认证、请求/响应字段、幂等能力、回调签名与取消语义；
2. 使用真实 MOSS 完成 30 秒黄金样本；
3. 使用真实 MOSS 完成 5/30/60/120 分钟私人 MP4 矩阵；
4. 核对完整英文、单调且无越界的逐词时间戳、分片边界、模型版本和唯一 ACTIVE 发布；
5. 演练真实 MOSS/Worker 重启、回调丢失、429/503、超时、取消和恢复；
6. 记录端到端耗时、吞吐、峰值内存、对象大小、供应方错误分类和成本依据；
7. 对最终 G3 Commit 执行 fresh clone 的冻结安装、迁移、lint、test 和 build 验证；
8. 在真实 MOSS 相关代码确定后重新执行 Reviewer 与最终 Gate 判断；
9. 将最终验证证据提交并进入唯一 trunk。

在这些证据完成前，G3 状态必须保持“实施中/等待外部验收”，不得标记为关闭，也不得以此开始 G4 集成。
