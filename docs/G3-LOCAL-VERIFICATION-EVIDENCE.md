# EchoFlow G3 本地实现验证证据

验证日期：2026-08-15

实施分支：`codex/g3-moss-transcript-20260813`

基线：`master@0c3e2ee`

合同锚点：`b191499`

本地代码验收锚点：`1e5ff7b86af4636be2fab89caf2c124ce75fa8c0`

状态：本地实现候选通过；G3 Gate 保持打开

## 1. 结论

`8139081` 已形成可恢复的本地 G3 候选链路：从已 PLAYABLE 的私人 MP4 提取 16 kHz 单声道音频、静音附近分片、通过统一 Adapter 执行 MOSS `submit/query/result/cancel`、接收 HMAC 回调并以轮询兜底、保存不可变 ASR 原始结果、合并和校验逐词时间戳，最后在单个数据库事务中发布唯一 ACTIVE 英文字幕。`805b93f` 在真实浏览器上传复验中消除了播放完成冒充字幕完成的问题，`1e5ff7b` 又保留了独立的 G2 媒体阶段/错误和 G3 字幕进度。

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
- API 把 `g2-playback-v1` ProcessingRun 序列化为顶层媒体阶段/错误，只把 `g3-transcript-v1` ProcessingRun 序列化为字幕进度；Web 只在持久阶段确为 `transcript_ready` 时显示“字幕已完成”，并保留媒体格式失败的专用重传指引。

## 3. 代码锚点 `1e5ff7b` 的确定性验证

运行环境：Windows；Node `v24.18.0`；pnpm `11.9.0`；Docker `29.6.2`；FFmpeg/ffprobe `8.1.2`。

| 命令/检查 | 结果 | 证据边界 |
|---|---|---|
| `docker compose -f infrastructure/docker-compose.yml ps` | PostgreSQL、Redis、MinIO 均 healthy | 本机开发基础设施，不代表生产环境 |
| `pnpm lint` | 通过 | 5 个共享包和 4 个应用的 TypeScript 静态检查 |
| `pnpm test` | 150 passed，4 skipped | 包含真实 PostgreSQL/MinIO/Redis/FFmpeg 和确定性 Fake MOSS；跳过项是需设置 `RUN_G2_LONG_MEDIA=true` 才执行的自生成 G2 长媒体矩阵 |
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
| Web | 43 | 0 |
| API | 25 | 0 |
| Worker | 56 | 4 |
| 合计 | 150 | 4 |

Worker 的 56 个通过测试中，G3 主流水线为 28 个，另含 MOSS Adapter 6 个、分片 4 个、合并校验 7 个和 G2 播放回归 11 个。G3 测试覆盖成功发布、单片失败、取消、24 小时/7 天保留、Run/Chunk 代际接管、真实子进程 kill/restart、提交和上传响应丢失、迟到上传、对象 checksum 损坏、发布事务回滚、Redis 空队列重建及 exact Version 清理。

## 4. 独立审查

独立 Reviewer 在多轮只读审查中曾阻断以下问题，修复后重新审查：

- 旧 Worker 丢租约后仍可能完成 Chunk 或发布；
- 对象上传与数据库事实之间的崩溃窗口可能产生不可枚举版本；
- 取消扫描可能把暂时查不到的外部 Job 错判为已取消；
- 同进程并发任务复用 workerId，不能区分 lease generation；
- cleanup 在长数据库事务内执行对象删除，数据库连接丢失时存在复用/删除竞态；
- Chunk 业务写只校验 Chunk token，未同时原子校验当前 Run generation。

最终对核心流水线 `8139081` 的结论为：未发现已知 P0/P1。浏览器复验发现 G2 播放 Run 会被误显示成“字幕已完成”后，`805b93f` 分离 G2/G3 查询与展示语义；随后 `1e5ff7b` 将顶层 G2 媒体诊断和 G3 `transcriptProcessing` 明确拆分，并以 API E2E 覆盖 G2/G3 并存、分片计数和 `media_format_unsupported`，以 Web 测试覆盖专用重传指引。独立 Reviewer 对两个增量均未发现 P0/P1，批准当前本地代码锚点。仅剩非阻断维护建议：未来把跨 API/Worker 重复的 pipeline 名称提取成共享常量。审查不包含真实 MOSS 运行验证。

## 5. 浏览器与本地运行验收

在 Docker PostgreSQL、Redis、MinIO 均 healthy 的环境中，使用生产构建预览和真实浏览器完成以下链路：

1. 通过 OTP 登录本地测试用户；
2. 上传自生成的 6 秒、1280×720、H.264/AAC MP4（5,711,488 bytes）；
3. 浏览器执行签名 Multipart 上传，Worker 完成 G2 媒体探测，资产进入 `PLAYABLE`；
4. “我的视频”和“上传与处理”都如实显示“等待字幕任务”，未再把 G2 `PLAYBACK_READY` 显示为“字幕已完成”；
5. 点击“播放原片”后，浏览器 `<video>` 的 `duration = 6`、`readyState = 4`，签名 MinIO 地址可读取；
6. 桌面与 390×844 移动视口均无横向溢出，生产预览控制台没有错误。
7. 另上传自生成的 MPEG-4 Part 2 + AAC MP4；Worker 真实拒绝后，页面显示“不支持播放 / 请重新上传 MP4 / H.264 / AAC 文件”，未混入字幕失败状态，控制台没有错误。

本次运行明确设置 `MOSS_ENABLED=false`，所以“等待字幕任务”是正确状态；它证明个人上传与原片播放的本地纵向链路，不证明 MOSS 字幕链已通过。

## 6. 仍然阻塞 G3 的外部证据

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
