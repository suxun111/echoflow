# EchoFlow G3 本地实现验证证据

验证日期：2026-08-16

实施分支：`codex/g3-moss-transcript-20260813`

基线提交：`0c3e2ee`（分支创建时的 `master`）

合同锚点：`b191499`

EchoFlow 代码验收锚点：`ca3e3ad00cdb54a5e32d1ce614db433b3c9d50e9`

MOSS Provider Gateway 锚点：`cdf6eb32f12f593121b669cddf609db7f4215131`

状态：本地实现候选通过；G3 Gate 保持打开

## 1. 结论

`8139081` 已形成可恢复的本地 G3 候选链路；`805b93f` 与 `1e5ff7b` 分离了 G2 媒体事实和 G3 字幕进度。2026-08-15 用户确认 segment-first：真实分段时间为 V1 必选，逐词时间为可选增强。`ca3e3ad` 完成共享契约、HTTP Adapter 和跨分片合并修订：没有逐词证据时直接保留真实 segment；文本、时间、重复序列或 speaker 不能唯一消歧时失败关闭，不猜测性发布。MOSS 仓库的 `cdf6eb3` 提供独立 `/api/provider/v1` 机器网关，以稳定身份连接 EchoFlow 和原生 MOSS 任务。

本地自动化、真实 PostgreSQL/Redis/MinIO/FFmpeg 集成、生产构建和独立代码审查均通过，当前没有已知 P0/P1。

这不是 G3 关闭证据。机器接口、认证和 segment-first 响应合同已经本地实现，但真实模型尚未下载、加载或推理，30 秒及 5/30/60/120 分钟真实 MOSS 样本矩阵没有执行；因此不能声称真实长视频已经由 MOSS 生成合格字幕，也不能进入 G4。

## 2. 已实现并验证的边界

- PostgreSQL 增量迁移建立 G3 ProcessingRun/Chunk、回调防重放、对象事实和字幕发布所需约束；
- API 提供 owner-scoped 字幕状态、ACTIVE 字幕读取、幂等重试/取消，以及独立 HMAC MOSS Callback 信任边界；
- Worker 使用 PostgreSQL 作为事实源，Redis/BullMQ 只负责唤醒；空队列可由持久状态重建；
- 每次处理调用使用独立 lease generation；Run 与 Chunk 的认领、续租、状态写入和最终发布都受同一代际 fencing；
- 外部 Job 使用稳定幂等身份；提交响应丢失、回调丢失、乱序/重复回调、超时取消失败和 Worker 接管均可恢复；
- G3 临时对象在网络写入前建立数据库身份，并写入不可变物理 attempt key；每个存活对象 Version 都有可追踪事实；
- 清理先在短事务中提交 tombstone，再在事务外按非空 exact Version 删除，最后以短事务 CAS 标记 purged；迟到上传、缺失 PENDING 和重试采用均有收口路径；
- 所有分片成功且分段/可选逐词时间戳、单调性、边界和来源完整性通过后，才会发布唯一 ACTIVE 字幕；任一失败不会暴露半套字幕；
- API 把 `g2-playback-v1` ProcessingRun 序列化为顶层媒体阶段/错误，只把 `g3-transcript-v1` ProcessingRun 序列化为字幕进度；Web 只在持久阶段确为 `transcript_ready` 时显示“字幕已完成”，并保留媒体格式失败的专用重传指引。
- MOSS Provider Gateway 使用 Bearer Token 和精确 `host:port` 白名单，逐跳验证重定向；provider-only listener 不暴露原 GUI `/api/jobs`；稳定 Job/Attempt 身份、不可变结果、取消 fencing、重启协调和 24 小时原生任务/首次读取后 7 天结果 TTL 均持久化。

## 3. 代码锚点 `ca3e3ad` / `cdf6eb3` 的确定性验证

运行环境：Windows；Node `v24.18.0`；pnpm `11.9.0`；Docker `29.6.2`；FFmpeg/ffprobe `8.1.2`。

| 命令/检查 | 结果 | 证据边界 |
|---|---|---|
| `docker compose -f infrastructure/docker-compose.yml ps` | PostgreSQL、Redis、MinIO 均 healthy | 本机开发基础设施，不代表生产环境 |
| `pnpm lint` | 通过 | 5 个共享包和 4 个应用的 TypeScript 静态检查 |
| `pnpm test` | 160 passed，4 skipped | 包含真实 PostgreSQL/MinIO/Redis/FFmpeg 和确定性 Fake MOSS；跳过项是需设置 `RUN_G2_LONG_MEDIA=true` 才执行的自生成 G2 长媒体矩阵 |
| `pnpm build` | 通过 | config/contracts/database/storage/ui 与 Web/Admin/API/Worker 生产构建 |
| MOSS `compileall` + `unittest discover` | 52 passed | 在隔离 Docker 运行依赖中复制只读源码后执行；其中 Provider API 13 项 |
| 8002 隔离 Provider 运行态 | healthy；ready 200；旧 `/api/jobs` 404；未认证 401 | EchoFlow Adapter 可访问；失败 Job 在容器重启前后保持同一 `externalJobId`；未加载模型，不证明推理 |
| 设置 `.env.example` 的本地 `DATABASE_URL` 后执行 `pnpm --filter @online-learning/database exec prisma validate` | 通过 | G3 schema 可由 Prisma 解析；未设置该必需变量时命令会按设计拒绝运行 |
| `docker compose -f infrastructure/docker-compose.yml config --quiet` | 通过 | Compose 结构有效，不代表生产部署验收 |
| `git diff --check` | 通过 | 无补丁空白错误 |

测试分布：

| 范围 | 通过 | 跳过 |
|---|---:|---:|
| Config | 13 | 0 |
| Contracts | 6 | 0 |
| Database | 8 | 0 |
| Web | 43 | 0 |
| API | 25 | 0 |
| Worker | 65 | 4 |
| 合计 | 160 | 4 |

Worker 的 65 个通过测试中，G3 主流水线为 28 个，另含 MOSS Adapter 8 个、分片 4 个、合并校验 14 个和 G2 播放回归 11 个。G3 测试覆盖成功发布、单片失败、取消、24 小时/7 天保留、Run/Chunk 代际接管、真实子进程 kill/restart、提交和上传响应丢失、迟到上传、对象 checksum 损坏、发布事务回滚、Redis 空队列重建、exact Version 清理，以及分片边界丢词/重复/多解/speaker 冲突的失败关闭。

## 4. 独立审查

独立 Reviewer 在多轮只读审查中曾阻断以下问题，修复后重新审查：

- 旧 Worker 丢租约后仍可能完成 Chunk 或发布；
- 对象上传与数据库事实之间的崩溃窗口可能产生不可枚举版本；
- 取消扫描可能把暂时查不到的外部 Job 错判为已取消；
- 同进程并发任务复用 workerId，不能区分 lease generation；
- cleanup 在长数据库事务内执行对象删除，数据库连接丢失时存在复用/删除竞态；
- Chunk 业务写只校验 Chunk token，未同时原子校验当前 Run generation。

Reviewer 对 `ca3e3ad` / `cdf6eb3` 的最终结论为：无 P0/P1，批准作为本地验收锚点并进入证据提交；G3 Gate 仍须等待真实模型与长视频矩阵。审查过程中额外拦截并修复了 segment 文本去重导致的丢词/重复、重复 token 多解、时间不相交同文误合并、speaker 冲突，以及 Provider 的 pre-native crash、下载中取消后立即重试、迟到 attempt 覆盖、无人查询时 TTL 不启动等窗口。

剩余 P2 包括：Provider 某些非预期内部异常仍可能映射为 400；成功结果超过 7 天清理后的稳定身份尚无明确重开语义；下载默认可能继承环境代理；实际加载模型尚未与请求 `modelVersion` 强绑定；未来若启用逐词 Provider，旧 words 合并启发式需要单独加固。它们不阻断当前本地候选，但应在生产加固或对应能力启用前关闭。

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

1. 在明确的 CPU/GPU 环境下载并校验真实 MOSS 模型，冻结模型版本与请求 `modelVersion` 的绑定；
2. 使用真实 MOSS 完成 30 秒黄金样本；
3. 使用真实 MOSS 完成 5/30/60/120 分钟私人 MP4 矩阵；
4. 核对完整英文、单调且无越界的真实分段时间、分片边界、模型版本和唯一 ACTIVE 发布；若 Provider 返回逐词时间，再额外核对逐词时间；
5. 在真实推理中演练 MOSS/Worker 重启、轮询丢失、429/503、超时、取消和恢复；
6. 记录端到端耗时、吞吐、峰值内存、对象大小、供应方错误分类和成本依据；
7. 对 EchoFlow 与 MOSS 最终 Commit 执行 fresh clone 的冻结安装、迁移、lint、test 和 build/启动验证；
8. 在真实 MOSS 相关代码确定后重新执行 Reviewer 与最终 Gate 判断；
9. 将最终验证证据提交并进入唯一 trunk。

在这些证据完成前，G3 状态必须保持“实施中/等待外部验收”，不得标记为关闭，也不得以此开始 G4 集成。
