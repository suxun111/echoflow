# EchoFlow G3 本地实现验证证据

验证日期：2026-08-16；真实 30 秒补充验证：2026-08-21；真实 31 分钟分片验证、不可变 replan/revision 确定性验证与真实 5 分钟完整发布：2026-08-22；真实约 31 分钟完整链路受控失败关闭：2026-08-23

实施分支：`codex/g3-moss-transcript-20260813`

基线提交：`0c3e2ee`（分支创建时的 `master`）

合同锚点：`b191499`

EchoFlow 代码验收锚点：`ca3e3ad00cdb54a5e32d1ce614db433b3c9d50e9`；本轮音频边界修复：`8873c35`

MOSS Provider Gateway 锚点：`cdf6eb32f12f593121b669cddf609db7f4215131`；输入范围校验锚点：`2f1c2ad`

状态：本地实现候选、真实 30 秒 MOSS 冒烟、不可变 replan/revision 确定性验证与一次真实 5 分钟 EchoFlow → MOSS → ACTIVE 字幕发布均通过。2026-08-23 的真实约 31 分钟完整链路在唯一 revision 1 repair 后正确失败关闭、没有 ACTIVE 字幕；成功的 30/60 分钟及故障恢复矩阵仍未完成，G3 Gate 保持打开

范围更新：2026-08-24 起，V1 的当前时长上限为 ≤60 分钟。本文件保留已发生运行的原始事实；未验证边界和后续矩阵按新的 30/60 分钟范围表述。

## 1. 结论

`8139081` 已形成可恢复的本地 G3 候选链路；`805b93f` 与 `1e5ff7b` 分离了 G2 媒体事实和 G3 字幕进度。2026-08-15 用户确认 segment-first：真实分段时间为 V1 必选，逐词时间为可选增强。`ca3e3ad` 完成共享契约、HTTP Adapter 和跨分片合并修订：没有逐词证据时直接保留真实 segment；文本、时间、重复序列或 speaker 不能唯一消歧时失败关闭，不猜测性发布。MOSS 仓库的 `cdf6eb3` 提供独立 `/api/provider/v1` 机器网关，以稳定身份连接 EchoFlow 和原生 MOSS 任务。`8873c35` 进一步把 MOSS 分片计划上限钳制到经 Worker 生成并实测的规范化 WAV 时长，避免以略长的视频容器时长向 Provider 声明不存在的尾部音频。

本地自动化、真实 PostgreSQL/Redis/MinIO/FFmpeg 集成、生产构建和独立代码审查均通过，当前没有已知 P0/P1。2026-08-22 的有界不可变 replan/revision 确定性证据见第 8 节，真实 5 分钟端到端发布证据见第 9 节；具体提交锚点以 Git 历史为准。

这不是 G3 关闭证据。机器接口、认证和 segment-first 响应合同已经本地实现；2026-08-21 以固定真实模型完成了 30 秒音频的 CLI 与隔离 Provider 冒烟，2026-08-22 又完成一次真实 5 分钟 EchoFlow G3 API/Worker/对象存储/Provider/严格合并/原子 ACTIVE 发布。它仍未完成 30/60 分钟真实 MOSS 矩阵、真实故障恢复或人工准确率基准；因此不能关闭 G3，也不能进入 G4。

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

## 3. 代码锚点与确定性验证

运行环境：Windows；Node `v24.18.0`；pnpm `11.9.0`；Docker `29.6.2`；FFmpeg/ffprobe `8.1.2`。

| 命令/检查 | 结果 | 证据边界 |
|---|---|---|
| `docker compose -f infrastructure/docker-compose.yml ps` | PostgreSQL、Redis、MinIO 均 healthy | 本机开发基础设施，不代表生产环境 |
| `pnpm lint` | 通过 | 5 个共享包和 4 个应用的 TypeScript 静态检查 |
| `pnpm test` | 168 passed，4 skipped | 包含真实 PostgreSQL/MinIO/Redis/FFmpeg 和确定性 Fake MOSS；跳过项是需设置 `RUN_G2_LONG_MEDIA=true` 才执行的自生成 G2 长媒体矩阵 |
| `pnpm build` | 通过 | config/contracts/database/storage/ui 与 Web/Admin/API/Worker 生产构建 |
| MOSS `compileall` + `unittest discover` | 52 passed | 在隔离 Docker 运行依赖中复制只读源码后执行；其中 Provider API 13 项 |
| 8002 隔离 Provider 运行态 | healthy；ready 200；旧 `/api/jobs` 404；未认证 401 | EchoFlow Adapter 可访问；失败 Job 在容器重启前后保持同一 `externalJobId`；未加载模型，不证明推理 |
| 设置 `.env.example` 的本地 `DATABASE_URL` 后执行 `pnpm --filter @online-learning/database exec prisma validate` | 通过 | G3 schema 可由 Prisma 解析；未设置该必需变量时命令会按设计拒绝运行 |
| `docker compose -f infrastructure/docker-compose.yml config --quiet` | 通过 | Compose 结构有效，不代表生产部署验收 |
| `git diff --check` | 通过 | 无补丁空白错误 |
| 固定真实 MOSS 模型级 CLI（RTX 4060 Laptop GPU、CUDA 12.8、BF16） | 30 秒英语 WAV 成功；11 个真实分段、286 token、约 13.84 秒推理、时间 0.11–29.62 秒 | 模型 revision `e8681d68e7042738ffca8ac8212bc8fcb1131ab8` 已核验；只证明模型级转写，不证明 EchoFlow 发布链 |
| 隔离真实 Provider（`127.0.0.1:8002`） | `ready=true`；重复同一 POST 保持同一 `externalJobId`；`processing → succeeded`；结果为 11 个英文 segment、110–29620ms、单调且无越界 | 临时 Bearer 与回环 `8099` 音频服务只用于本机验证，结束后均已关闭；`words` 缺失符合 segment-first，不伪造词级时间 |

测试分布：

| 范围 | 通过 | 跳过 |
|---|---:|---:|
| Config | 13 | 0 |
| Contracts | 6 | 0 |
| Database | 9 | 0 |
| Web | 43 | 0 |
| API | 25 | 0 |
| Worker | 72 | 4 |
| 合计 | 168 | 4 |

Worker 的 72 个通过测试中，G3 主流水线为 32 个，另含 MOSS Adapter 8 个、分片 6 个、合并校验 15 个和 G2 播放回归 11 个。G3 测试覆盖成功发布、单片失败、取消、24 小时/7 天保留、Run/Chunk 代际接管、真实子进程 kill/restart、提交和上传响应丢失、迟到上传、对象 checksum 损坏、发布事务回滚、Redis 空队列重建、exact Version 清理，以及分片边界丢词/重复/多解/speaker 冲突的失败关闭；其中新增回归验证容器媒体时长略长于规范化 WAV 时，最后一个 MOSS 分片仍不越界。

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

## 6. 真实 30 秒 MOSS 补充验证

MOSS 代码锚点仍为 `cdf6eb32f12f593121b669cddf609db7f4215131`，本轮没有修改该仓库的已跟踪源码。模型 ID 为 `OpenMOSS-Team/MOSS-Transcribe-Diarize`，固定 revision 为 `e8681d68e7042738ffca8ac8212bc8fcb1131ab8`；20 个模型文件的大小均与官方元数据一致，权重 SHA-256 与官方元数据一致。输入为本地 16 kHz / mono / 30.000 秒英语 WAV；音频和转写正文不进入 EchoFlow 仓库。

模型级 CLI 使用本地模型目录、`cuda:0`、BF16、贪心解码和 `8192` token 上限。它返回 11 个非空、时间单调且均在 `[0, 30s]` 内的真实分段，生成 286 token，未触发截断。Provider 级验证以本地临时 token 和精确 `127.0.0.1:8099` allowlist 启动独立 `8002` listener；两次相同 payload 返回同一稳定外部身份，终态为 `succeeded`，固化结果为 `language=en`、11 个整数毫秒分段、无 `words`。原生 GUI Job 的 `waiting_review` 被 Gateway 正确映射为 Provider 的 `succeeded`。

独立 Reviewer 对输入/结果一致性、时间不变量、监听清场和源代码锚点复核后结论为 P0=0、P1=0。验证结束时 `8002` 和 `8099` 无监听；旧 CPU GUI `8001` 容器保持 healthy 且未重启。唯一 P2 证据缺口是没有人工参考转写，因此没有 WER/CER 等量化准确率结论。

## 7. 真实 31 分钟 MOSS 分片验证（未通过，受控失败）

本轮输入是用户本机的一段私人英语长视频，经本地归一化为 16 kHz / mono PCM WAV 后用于验证。原视频、音频、转写正文、可访问 URL、临时 Bearer 和原始 Provider 结果均没有进入仓库、证据文件或控制台输出；本节只保留可复现的结构性指标。

### 已验证事实

- 固定 revision `e8681d68e7042738ffca8ac8212bc8fcb1131ab8` 在 RTX 4060 Laptop GPU / BF16 下，整段约 31 分钟单块推理发生真实 CUDA OOM；约 10 分钟单块在 60 分钟内未完成。因此此设备上的候选计划是约 5 分钟的 silence-aware 分片，片间保留 2 秒上下文，而不是把整段或 10 分钟块当作可用路径。
- 该计划产生 6 块真实音频。所有实际 Provider 终态均为 `succeeded`，并逐块通过 `language=en`、非空 segment、整数毫秒、范围、单调性和无伪造 `words` 的检查；Provider 监听和本地静态音频监听均在每轮后确认关闭。
- 初次完整六块调用 EchoFlow 的真实 `buildTranscript` 时，在第 2→3 个交接处失败，内部分类为 `ambiguous_segment_handoff`。这不是 Provider 崩溃、时间越界或媒体格式错误，而是两侧 segment-only 转写没有满足唯一 suffix→prefix 文本和时间重叠证据。按 G3 合同，系统正确地拒绝生成 ACTIVE，而没有猜测性拼接。
- 为验证“重切到静音边界”是否有效，实验把第 2→3 核心边界从 `886744ms` 移至已检测到的 `882003ms`（1,254ms 静音中心），只重跑相邻两块，并使用包含实际范围的独立实验幂等身份。两块分别得到 80 个合格 segment；再做六块真实合并时，首次失败前移到第 3→4 个交接，证明这一处 repair 的确消除了第 2→3 歧义。
- 第二次实验保留上述成功边界，并把第 3→4 边界从 `1190118ms` 移至 `1198254ms`（763ms 静音中心），仅重跑第 3、4 块。两块均通过 Provider 不变量，但完整合并仍在第 3→4 处以同一受控歧义失败。因而不能把“随机换一个静音点”写成可发布的自动修复算法。
- MOSS Provider 的本地工作树额外修复了真实结果中观测到的末段 40ms 量化越界：只允许原始结果的最后一段在不超过 50ms 时被裁至已验证的 WAV 上界；非末段、较大越界、空区间、旧任务缺少时长、以及下载 WAV 与声明范围不匹配时均失败关闭。该工作树的 `unittest discover -s tests -v` 为 58 passed，`compileall` 通过；EchoFlow 的 `merge.test.ts` 为 15 passed，Worker lint 与 build 通过。本轮没有提交或推送这些仍在验证中的工作树改动。

### 结论与不可省略的下一步

真实模型、Provider、5 分钟分片和 Provider 边界校验已被证明可运行；“完整长视频字幕可原子发布”尚未通过。MOSS 当前只提供 segment 时间，缺少可验证的逐词时间；因此内部 LCS、时间所有权或保留两侧的降级拼接都可能静默丢字、重复或改变语序，不能替代严格合并。

若要继续自动 repair，必须先实现有界的不可变 replan：每次 repair 增加 `planRevision`，保留旧 `ProcessingChunk`，只重跑相邻 pair，并让 Provider 身份绑定 `planRevision + startMs + endMs + 实际输入 checksum/version`。当前 Worker 的身份只含 source/pipeline/stage/chunkIndex/model，移动边界会与旧 Job 冲突；数据库也只允许同一 Run 下一个 `chunkIndex`，因此不能安全地在原记录上覆盖。repair 上限应为一次；仍无唯一 suffix→prefix 证据时终态为 `transcript_incomplete`，不得发布 ACTIVE。

本节是一次失败关闭的真实长媒体证据，而不是 G3 关闭或端到端发布证据。

## 8. 有界不可变 replan/revision（确定性验证通过）

### 已验证事实

- 新增增量迁移 `20260822000100_g3_plan_revision_repair`：`ProcessingRun` 保存 active/pending plan revision 和安全的 repair 元数据；`ProcessingChunk` 的唯一身份扩展为 `run + planRevision + chunkIndex`；`TranscriptVersion` 记录发布计划 revision。数据库约束把自动修复限制为 `0 → 1`，并通过 trigger 拒绝修改已有分片的范围、输入身份、模型、幂等键或已写入的 ASR 结果身份；历史 revision 0 行允许保持旧的空 `inputChecksum`。
- 仅当严格合并返回结构化 `ambiguous_segment_handoff` 时，Worker 才可扫描规范化音频中的静音窗口，创建 revision 1 的相邻 pair overlay。旧分片、输入对象、原始 ASR 结果、外部任务和既有结果对象均不覆盖、不删除；若修复后的严格合并仍歧义，任务以 `transcript_incomplete` 失败关闭，不会创建 revision 2 或发布 ACTIVE。
- 重规划分片的对象键和 MOSS 幂等身份包含 plan revision、实际范围、输入对象/version/checksum 和原有效计划的 modelVersion。部署间模型配置变动不会把两个模型的结果混入同一计划。
- API 状态计数、显式重试、取消扫描和 Worker 的外部 MOSS 取消均先计算“有效 overlay”；它们不会把旧 pair 重新计数、重试或取消。取消态仍会处理当前有效计划中已经标记为 `CANCELLED` 的外部任务。

### 本机命令与结果

| 命令/检查 | 结果 | 证据边界 |
|---|---|---|
| `pnpm --filter @online-learning/database test:prepare echoflow_g3_replan_migration_test` | 通过；从空库依次应用 4 条迁移 | 验证新迁移可在隔离 PostgreSQL 部署；不是含既有 revision 0 生产数据的升级演练 |
| `pnpm --filter @online-learning/worker test` | 71 passed，4 skipped | 使用真实 PostgreSQL/Redis/MinIO/FFmpeg、确定性 Fake MOSS 和约 140 秒合成媒体；覆盖相邻 pair 重规划、旧输入/结果不可变、模型继承、二次歧义失败关闭、有效 overlay 取消 |
| `pnpm --filter @online-learning/database test` | 9 passed | 包含 schema/迁移合同断言 |
| `pnpm --filter @online-learning/api test` | 25 passed | 覆盖 effective overlay 的状态计数、重试和取消边界 |
| `pnpm lint` | 通过 | 工作区 TypeScript 静态检查 |
| `pnpm build` | 通过 | 所有共享包与 Web/Admin/API/Worker 生产构建 |
| `pnpm --workspace-concurrency=1 test` | 167 passed，4 skipped | 完整工作区回归；应用会为 API、Worker 使用各自的隔离数据库 |
| 独立只读审查 | P0=0、P1=0 | 仍有 P2：既有 revision 0 数据升级演练、pending revision 恢复入队、以及静音检测基础设施错误的更精细分类 |

### 未验证边界与结论

本节不读取或记录用户私人视频、音频、字幕正文、对象键、临时 URL 或凭据。它验证的是可恢复的数据模型与确定性行为；真实 MOSS 的 5 分钟端到端发布已在第 9 节完成，但仍需继续 30/60 分钟矩阵。

## 9. 真实 5 分钟 EchoFlow → MOSS → ACTIVE 字幕发布（通过）

本节使用一段经用户授权的私人英语视频。原文件路径、音视频内容、字幕正文、对象键、签名 URL、Bearer、数据库主键和原始 Provider 响应均未写入仓库、证据文件或控制台输出；只保留可复核的时长、计数、状态和提交锚点。

### 9.1 受控失败与根因

第一次独立 5 分钟尝试完成 G2 上传与媒体探测，但 G3 的最后一个请求被 Provider 以 `audio_duration_mismatch` 拒绝。已验证事实是：视频容器时长为 `300123ms`，由 Worker 用 FFmpeg 生成的 16 kHz/单声道/PCM WAV 实测为 `300002ms`；旧计划把最后一段声明到视频上界，多出 `121ms`，超过 Provider 的 `50ms` 容差。该失败没有发布任何 ACTIVE 字幕，且第一次运行的独立数据库、桶和日志被保留，未重试或覆盖。

`8873c35` 的修复从规范化 WAV 的 RIFF/PCM 数据计算实际时长，以 `min(媒体时长, 规范化音频时长)` 规划初始分片；有界 repair 在重新下载并校验同一 WAV 后使用相同上界。字幕版本仍保留视频容器时长，允许视频存在短暂静音尾部，避免把播放器时间轴错误裁短。

### 9.2 第二次独立运行的已验证事实

- 在全新的 PostgreSQL 数据库、启用 versioning 的 MinIO 桶和空 Redis 逻辑库中部署 4 条迁移；未复用第一次失败的任务、队列或对象版本。
- 隔离 Provider、API 与 Worker 均启动且健康；主 Docker PostgreSQL、Redis、MinIO 和既有 `8001` GUI 容器均未重启或修改。
- 真实 OTP、5 Part Multipart 直传完成 `25,311,688` bytes；G2 将资产变为 `PLAYABLE`，并以 ffprobe 记录 `300123ms` 视频时长。
- G3 将同一原片规范化为 `300002ms` WAV，创建 3 个分片，范围总体为 `[0, 300002]`；3/3 外部 MOSS 分片均成功。
- G3 `ProcessingRun` 的最终事实为 `SUCCEEDED / TRANSCRIPT_READY`；发布 1 个 ACTIVE `TranscriptVersion`，版本时长为 `300123ms`、Cue 数为 71；Cue 起止时间单调、非空、在 `[0, 300123]` 内，最末 Cue 结束于 `299980ms`。
- 隔离运行结束后只终止其 Provider/API/Worker 进程树以释放 GPU 与端口；没有删除第一次或第二次的验证数据库、桶、输入副本或排障证据。

### 9.3 本轮代码与审查验证

| 命令/检查 | 结果 | 证据边界 |
|---|---|---|
| `pnpm --filter @online-learning/worker test -- src/processors/transcript.test.ts` | 32 passed | 包含真实 FFmpeg/MinIO/PostgreSQL 的新增尾部时长回归 |
| `pnpm lint` | 通过 | 当前 `8873c35` 的全仓 TypeScript 静态检查 |
| `pnpm test` | 168 passed，4 skipped | 当前 `8873c35` 的全仓回归；跳过项未作为通过依据 |
| `pnpm build` | 通过 | 当前 `8873c35` 的全仓生产构建 |
| 本轮代码/文档独立只读审查 | P0=0，P1=0 | 已确认初始计划与一次有界 repair 均以实测 WAV 上界为准；P2 是更贴近真实短音轨 repair 夹具和畸形 WAV 解析硬化，不覆盖尚未完成的 30/60 分钟运行矩阵 |

### 9.4 未验证边界

本次证明一次真实 5 分钟闭环，不证明 30/60 分钟可稳定发布，不证明跨片歧义一定可由一次 repair 消除，也不证明 MOSS/Worker 重启、轮询丢失、429/503、超时、取消或人工准确率基准已通过。

## 10. 真实约 31 分钟 EchoFlow → MOSS → 受控失败关闭（2026-08-23）

本节使用经用户授权的私人英语长视频，按本机约 30 分钟验证任务执行。原文件路径/名称、音视频内容、字幕正文、对象键、数据库主键、可访问 URL、Bearer 和 Provider 原始结果均未写入仓库、验证脚本输出或本节；仅保留结构性状态、计数、范围和资源指标。

### 10.1 隔离环境与真实调用边界

- 在全新的 PostgreSQL 数据库、启用 versioning 的 MinIO 桶和空 Redis 逻辑库中应用 4 条迁移；不复用此前 5 分钟运行的 DB、桶、队列、对象或任务事实。
- EchoFlow 工作树锚点为 `f2363a9`；其产品代码与 `8873c35` 相同，二者差异仅为此前的证据/状态文档。MOSS 工作树锚点为 `2f1c2ad`，本轮未修改两边的已跟踪源码。
- 隔离 API、Worker 和 Provider 均通过启动健康检查。Provider 使用固定模型 revision `e8681d68e7042738ffca8ac8212bc8fcb1131ab8`、RTX 4060 Laptop GPU、`cuda:0`、BF16 和 `8192` token 上限；Worker 使用 300 秒目标分片、2 秒重叠，且 Worker/Provider 临时目录均显式位于 D 盘。
- 资源采样覆盖约 67 分 56 秒：GPU 峰值 `7876 / 8188 MiB`；C 盘最低剩余 `3.4 GiB`、D 盘最低剩余 `63.09 GiB`。`ProcessingRun.createdAt → failedAt` 为 `4000` 秒。采样只记录显存和磁盘，不含媒体或转写内容。

### 10.2 已验证的真实运行事实

1. 真实 Multipart 上传完成后，G2 将媒体置为 `PLAYABLE`，视频时长为 `1,865,653ms`；G3 开始时读取字幕 API 返回 `409 / transcript_not_ready`，没有在处理中泄露部分字幕。
2. revision 0 的 6 个真实 Provider 分片均达到 `SUCCEEDED`。随后严格合并没有猜测性拼接，而是创建合同允许的唯一一次 revision `0 → 1` repair，只重跑相邻 pair；旧 6 块保持不变。
3. revision 1 的 2 个替换分片也均达到 `SUCCEEDED`。所有持久分片的最大 revision 为 1；按每个 chunk index 的最高**候选** revision 聚合后，候选 6 块均成功、范围有效、起点为 `0ms`、终点为 `1,865,653ms`、无覆盖缺口。它们没有成为已发布版本。
4. repair 后严格合并仍不能得到可安全发布的完整版本，因此 Run 正确终态为 `FAILED / MERGING / transcript_incomplete`。失败态保留 `activePlanRevision=0` 与 `pendingPlanRevision=1`，这是现有确定性回归的合同化失败表示；没有创建 revision 2。
5. 终态数据库聚合为：媒体仍 `PLAYABLE`，按最高候选 revision 计算的失败/取消 Chunk 数 `0`，`TranscriptVersion=0`、`ACTIVE=0`、Cue=`0`。owner 再次读取字幕 API 得到 `409 / transcript_not_ready`。因此既无半成品字幕，也没有错误激活或可访问 Cue。
6. 终态后才关闭本轮 Provider/API/Worker 进程树并确认隔离端口不再监听；Docker PostgreSQL、Redis、MinIO 和既有 MOSS GUI 容器均未停止、重配或删除。

### 10.3 验证命令与独立审查

| 命令/检查 | 结果 | 证据边界 |
|---|---|---|
| `pnpm --filter @online-learning/database migrate:deploy`（新库） | 通过，4 条迁移全部应用 | 验证本轮空库迁移，不代表含历史业务数据的升级演练 |
| 隔离启动器的 API / Provider 健康检查 | API 数据库 ready；Provider ready；Worker 存活 | 使用本机真实 Docker 基础设施和 GPU，不代表生产部署 |
| 真实上传与观察驱动 | G2 `PLAYABLE`；6 块 revision 0、2 块 revision 1 均真实完成；最终 `transcript_incomplete` | 不输出私人媒体或转写正文；不把分片成功误当成字幕发布 |
| owner `GET /media-assets/:id/transcript` 终态负向检查 | `409 / transcript_not_ready` | 证明失败关闭后无 ACTIVE 可读字幕 |
| PostgreSQL 终态聚合 | 按最高候选 revision 聚合的 6 块均成功且时间范围有效；`TranscriptVersion=0`、`ACTIVE=0`、Cue=0 | 事实源检查，不读取 `errorDetail`、对象键或字幕正文 |
| `pnpm --filter @online-learning/worker test -- src/processors/transcript.test.ts` | 32 passed | 覆盖一次 repair 后仍歧义必须 `transcript_incomplete` 且不发布 ACTIVE 的确定性闭环；不替代真实 MOSS |
| `pnpm lint`、`pnpm build` | 均通过 | 当前产品代码的全仓静态检查与生产构建；本轮仅新增证据文档 |
| `git diff --check` | 通过 | 证据和状态文档无补丁空白错误 |
| 独立只读终态审查 | P0=0、P1=0 | 审查范围仅限 revision 上限、有效覆盖和原子不发布；不覆盖准确率、60 分钟、故障恢复或安全矩阵 |

### 10.4 观察器事件与结论边界

- 初始观察器因短期测试 Access Token 过期收到 `401`；用同一隔离任务的新 OTP 会话恢复观察，没有重传、重跑、取消或修改任务。后续观察器对该类凭证失效自动重新认证。
- 观察期间出现过一次 `500 / internal_error`；该次事件后下一次 owner-scoped 读取成功，且**当时**数据库 Run 尚未进入失败态。终态仍为 `FAILED / MERGING / transcript_incomplete`。为避免读取私人转写/对象日志，本轮没有对该单次 API 事件作根因归因；它不是“API 通过”的证据，应作为后续可复现诊断项。
- 本节证明真实约 31 分钟链路的 **正确失败关闭**、真实 revision 1 触发和原子不发布；它不证明 30 分钟成功发布、字幕准确率、逐词时间、60 分钟、真实故障恢复、权限/回调攻击矩阵或 G3 关闭。

## 11. revision 1 严格合并失败的隐私安全诊断合同（2026-08-23）

### 11.1 目标与范围

第 10 节的真实约 31 分钟任务证明了正确失败关闭，但当时持久化的失败信息只包含通用消息，不能在不读取私人字幕正文的前提下判断 revision 1 失败的具体证据类型。本节只为**后续**严格 segment handoff 失败建立内部诊断和回归合同：不重跑既有私人样本、不读取其对象或日志、不放宽合并规则、不创建 revision 2，也不向公开 API 增加诊断字段。

### 11.2 持久化合同

仅当严格 segment handoff 失败且本次未成功创建新的 repair 时，`ProcessingRun.errorDetail.g3MergeFailureDiagnostic` 写入 `schemaVersion: 1` 的白名单对象。字段只包括：

- `failureClass`：`no_textual_suffix_prefix`、`text_match_without_time_overlap`、`text_time_match_with_speaker_conflict`、`multiple_valid_alignments` 或 `weak_single_token_alignment`；
- 候选计数、最大候选 token 数、边界 segment/token 计数、重叠窗口毫秒数和相邻 chunk index；
- 被评估的 plan revision，以及 repair 的 active/pending revision 和决策枚举。

该对象不包含字幕正文、token、speaker 标签、对象键、版本 ID、UUID、URL 或原始错误消息。`ProcessingRun.repairPlan` 仍只记录第一次 repair 的结构事实；两者可联合判断“首次 repair 的 pair”与“最终失败的 pair”是否一致。公开媒体列表、详情、字幕和重试 API 保持既有响应契约，不暴露 `errorDetail` 或 `repairPlan`。

### 11.3 确定性验证

| 命令/检查 | 结果 | 证明的边界 |
|---|---|---|
| `pnpm --filter @online-learning/worker exec vitest run src/transcript/merge.test.ts src/processors/transcript.test.ts` | 49 passed | 五类 handoff 失败均产生仅含结构字段的分类；合成 140 秒媒体 + Fake MOSS 仍严格执行 revision `0 → 1 → FAILED`，无 revision 2、无任何 TranscriptVersion/Cue/Lesson 发布 |
| `pnpm --filter @online-learning/worker lint` | 通过 | Worker 类型检查通过 |
| `pnpm --filter @online-learning/api test -- app.e2e.test.ts` | 19 passed | 有效 overlay 仍以 `6/6` 投影；播放可用、字幕 owner `409`/他人 `404`、retry `422` 且 Run/Chunk/Outbox 不变；内部 sentinel 和对象键不出现在状态/错误 API 响应中 |
| `pnpm --filter @online-learning/api lint` | 通过 | API 类型检查通过 |
| `pnpm lint` | 通过 | 当前全仓 TypeScript 静态检查；包含 API/Worker 新增测试源码 |
| `pnpm test` | 171 passed，4 skipped | 当前全仓回归；4 个既有长媒体矩阵用例仍由显式开关跳过，未作为通过依据 |
| `pnpm build` | 通过 | 当前全仓生产构建 |

这是合成/种子测试的代码证据，不是新的真实 MOSS 长媒体成功证据。此前真实任务发生在该诊断合同之前，不能仅靠新的枚举对其做追溯性分类。

### 11.4 下一恢复点

下一次必须由用户选择新的受权真实样本或批准经审查的 repair 设计；新失败才可读取该白名单诊断，再决定下一步。不得自动重跑既有私人输入，不得把所有 chunk `SUCCEEDED` 误写为字幕已发布，也不得通过自动 revision 2 或文本猜测绕过严格合并。

## 12. 仍然阻塞 G3 的外部证据

以下任一项不能由 Fake MOSS 或测试数量替代：

1. 使用真实 MOSS 完成成功发布的 30/60 分钟私人 MP4 矩阵；本节的约 31 分钟样本正确失败关闭，不可替代成功矩阵；30 秒 WAV 冒烟也不能替代真实长视频和分片边界；
2. 核对完整英文、单调且无越界的真实分段时间、分片边界、模型版本和唯一 ACTIVE 发布；若 Provider 返回逐词时间，再额外核对逐词时间；
3. 在真实推理中演练 MOSS/Worker 重启、轮询丢失、429/503、超时、取消和恢复；
4. 记录端到端耗时、吞吐、峰值内存、对象大小、供应方错误分类和成本依据；
5. 对 EchoFlow 与 MOSS 最终 Commit 执行 fresh clone 的冻结安装、迁移、lint、test 和 build/启动验证；
6. 在真实 MOSS 相关代码确定后重新执行 Reviewer 与最终 Gate 判断；
7. 将最终验证证据提交并进入唯一 trunk。

在这些证据完成前，G3 状态必须保持“实施中/等待外部验收”，不得标记为关闭，也不得以此开始 G4 集成。
