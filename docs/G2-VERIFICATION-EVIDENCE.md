# EchoFlow G2 验证证据：长视频上传与可播放资产

验证日期：2026-08-12  
最终代码锚点：`d08f6c6`  
实施分支：`codex/g2-long-video-upload-playback-20260812`  
结论：退出条件 1–7 已满足，无已知 P0/P1；条件 8“证据进入唯一 trunk”待本文件提交

## 1. 本 Gate 交付结果

G2 已把“私人 MP4 → 浏览器 Multipart 直传 → PostgreSQL 状态与 Outbox → Redis/Worker → ffprobe/fast-start → owner-scoped 签名 Range 播放”接成真实纵向闭环：

- 浏览器默认使用 32 MiB 分片、并发 3；分片签名按批获取，字节直接进入私有 MinIO，不经过 API；
- IndexedDB 只保存文件指纹、会话和分片清单，支持暂停、断网恢复、刷新后重选同一文件续传与 7 天恢复窗口；
- API 以对象存储的真实 Part Manifest、HEAD、ETag、Version 和大小作为完成事实；
- complete、cancel、过期清理共享 PostgreSQL advisory lock，终态重读后再行动，避免迟到请求复活资源；
- 上传完成、`MediaAsset`、`MediaObject`、`ProcessingRun` 与 Outbox 在同一数据库事务提交；
- Worker 可从 PostgreSQL 重建 Redis 丢失的任务，使用数据库 lease/heartbeat 和最终 fencing 阻止旧 Worker 发布结果；
- H.264/AAC/MP4 且不超过 3 小时的原片直接播放；slow-start 文件只做无损 fast-start remux；
- slow-start 派生对象按 asset/run/worker 唯一命名，失去 lease 的旧 Worker 只能删除自己创建的对象，不能删除新 Worker 已发布的版本；
- 播放地址只向 owner 短期签发，支持 HTTP Range；管理员默认也不能读取私人媒体；
- Web 已提供 OTP 登录、我的视频、上传任务、状态反馈和真实 `<video>` 原片播放；字幕与影子练习明确留在 G3/G4。

## 2. 代码与审核链

| Commit | 作用 |
|---|---|
| `0a53751` | 冻结 G2 任务合同 |
| `63e3053` | 第一版真实 Multipart、私有媒体、Worker 与 Web 纵向实现 |
| `68a1703` | 收紧 complete/cancel/cleanup 并发锁、Worker lease fencing 和 slow-start 派生对象竞争 |
| `65df12c` | 补齐 Web/API/Worker 故障、权限与真实进程重启验收矩阵 |
| `8d9ac84` | 修复 complete 已提交但响应丢失后，浏览器误入分片流程的问题 |
| `d08f6c6` | 补齐错误 Part 大小必须返回 `upload_part_invalid` 的真实 MinIO/API 断言 |

独立 Reviewer 在第一轮指出一个明确 P1：旧 Worker 在 slow-start 场景失去 lease 后，可能删除新 Worker 已复用并发布的播放对象。`68a1703` 改为每次处理创建唯一派生对象，并增加双 Worker 真实竞争测试；同时统一完成、取消和过期清理的锁语义。

证据初稿复核又拦住了提前关闭 Gate：当时 Web 的 IndexedDB、断网恢复、取消、签名续位，API 的对象异常和跨 owner 分片操作，以及真实 Worker 进程重启还缺可复现测试。`65df12c` 补齐矩阵。最终全仓复跑继续发现 complete 响应丢失后页面错误重入上传流程，`8d9ac84` 让客户端直接接受 GET 返回的 `completed + mediaAssetId` 服务端事实。文档终审再发现错误 Part 大小缺直接断言，`d08f6c6` 补齐真实 MinIO/API E2E。Reviewer 对最终代码锚点的结论为：`无 P0/P1，批准`。

## 3. 自动化与真实基础设施证据

最终代码锚点 `d08f6c6` 上执行：

```powershell
pnpm lint
pnpm test
pnpm build
pnpm exec prisma validate --schema packages/database/prisma/schema.prisma
docker compose config --quiet
$env:RUN_G2_LONG_MEDIA='true'
pnpm --filter @online-learning/worker test -- src/g2-media-matrix.test.ts
```

结果：

| 验证项 | 结果 |
|---|---|
| 全仓 lint | 通过 |
| 默认测试 | 87/87 通过：Contracts 5、Config 10、Database 7、Web 38、API 16、Worker 11 |
| 四应用生产 build | Web、Admin、API、Worker 全部通过 |
| Prisma schema validate | 通过 |
| Compose 配置解析 | 通过 |
| 长媒体矩阵 | 4/4 通过：5、30、60、120 分钟真实 H.264/AAC MP4 |

默认 Worker 集成测试每轮实际生成并处理 30 秒 H.264/AAC/MP4 黄金样本。长媒体矩阵实际执行 Multipart PUT、provider manifest、complete、HEAD、Version、签名 Range 与 ffprobe；120 分钟样本被强制覆盖多个 Part。8 GiB 和 3 小时只做边界计算、整数与 Part 上限验证，未在开发机制造 8 GiB 流量。

测试使用独立的 `echoflow_g2_*_test` PostgreSQL 数据库和独立 MinIO bucket，并连接真实 PostgreSQL、Redis、MinIO、ffmpeg 与 ffprobe。覆盖范围包括：

- 浏览器文件扩展名、MIME、空文件、8 GiB、3 小时边界，以及成功/失败时 Object URL 释放；
- IndexedDB 清单保存/恢复/删除、只补缺片、离线自动暂停/联网继续、刷新后重选同一文件、取消与本地清理；
- 分片缺失、错误 Part、对象缺失/大小不匹配、abort、过期、重复/并发 complete、完成响应丢失和 complete 与 cancel/cleanup 竞争；
- 第二名普通用户对 owner 上传的查询、分片签名、分片登记、complete、取消和播放均返回 not-found；管理员对私人媒体播放同样返回 not-found；
- Outbox 重投、Redis 丢失、独立 BullMQ Worker 子进程被强制终止后由替代进程接管、lease 丢失与双 Worker slow-start 竞争；
- 播放签名失败后只刷新一次 URL，并恢复此前的 `currentTime`。

## 4. Fresh clone 证据

从 `d08f6c6` 克隆至全新目录：

`E:\33442\ai\backups\EchoFlow\g2-d08f6c6-fresh`

当前桌面环境继承了 `NODE_ENV=production`，第一次普通安装因此没有建立开发依赖；明确把该进程的 `NODE_ENV` 设为 `development` 后重新执行 `pnpm install --frozen-lockfile`，冻结安装 372 个包成功。随后全仓 lint、87 个默认测试和四应用 build 全部通过，工作树保持 clean。

首次 Prisma generate 受到电脑上失效的本地代理 `127.0.0.1:58309` 阻塞。复验仅把 `PRISMA_QUERY_ENGINE_LIBRARY` 指向该 fresh clone 自身冻结安装的 `@prisma/engines@6.10.1` 二进制后通过；没有借用主工作树产物，也没有修改源码或 lockfile。这个边界属于本机网络环境，不冒充完全无环境变量的联网构建。

## 5. 真实浏览器纵向验证

真实浏览器验证分为两段，证据边界不混用：

在 `68a1703` 启动独立 G2 测试数据库、Redis、MinIO、API、Worker 与 Web，使用真实浏览器完成：

1. OTP 登录；
2. 选择本地 MP4 并确认处理权；
3. 浏览器通过签名 PUT 直传 MinIO；
4. API complete 后进入媒体检查；
5. Worker 发布 `PLAYABLE`；
6. 获取 owner-scoped 播放 URL 并打开真实 `<video>`。

首次完整链路的 API 日志显示真实 parts/sign、part record、complete 和 playback-url 请求，Worker 日志显示真实 `media_job_completed`。

最终生产逻辑锚点 `8d9ac84` 又重新启动 API、Worker 与 Web，复验登录态恢复、私人资产读取和签名播放；这次没有重复上传。最终浏览器读数：`readyState = 4`、`duration = 6`、`videoWidth = 640`、`videoHeight = 360`、无媒体错误，日志显示 refresh、media-assets 和 playback-url 成功。最终代码锚点 `d08f6c6` 只增加 API 测试，未改运行时代码；它与 `8d9ac84` 的上传故障恢复变化均由 Web/API 自动化绑定，而不是用播放复验冒充完整重传。

## 6. 仍然不属于 G2 的能力

- 尚未接入 MOSS、完整英文字幕、原子字幕发布与人工重开流；
- 尚未生成 5–10 分钟学习单元、逐句循环、录音回听和学习进度；
- 尚未做生产 TLS、备份恢复、监控告警、容量压测与香港邀请制 Alpha；
- 长媒体矩阵使用低码率合成样本，证明的是时长、分片和处理链正确，不等于真实 8 GiB 容量压测；
- 本地 Compose 与浏览器证据不等于公网生产部署证据。

在本证据提交并 fast-forward 至唯一 trunk 前，G2 不提前宣告关闭。完成该 Git 收口后，下一步也只能在用户确认后冻结并开始 G3“MOSS 与完整字幕原子发布”，不能把本证据解释成 V1 已整体完成。
