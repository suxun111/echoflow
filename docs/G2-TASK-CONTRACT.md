# EchoFlow G2 任务合同：长视频上传与可播放资产

冻结日期：2026-08-12  
基线：`master@fb66eee`  
实施分支：`codex/g2-long-video-upload-playback-20260812`  
状态：8 项退出条件全部通过，G2 已关闭；最终代码验收锚点 `d08f6c6`，证据提交 `3514a4e`

> 历史合同提示：本文件记录 G2 在当时范围下的冻结与关闭事实。2026-08-24 起，当前 V1 的时长准入以 [V1 PRD](EchoFlow-V1-PRD.md) 的 `≤60 分钟` 修订为准；该修订不改写本文件中的旧验收条件或已发生证据。

## 1. 本 Gate 要解决的唯一问题

让一名已登录用户把一份私人 MP4 长视频从浏览器可靠直传到私有对象存储，并在上传中断后于 7 天内继续；服务端必须以对象存储和 PostgreSQL 的真实状态完成校验，最终向该 owner 提供支持 HTTP Range 的短期签名播放地址。

本 Gate 不生成字幕、不创建学习单元，也不以静态卡片、内存状态或模拟百分比冒充上传完成。

## 2. 冻结范围

### 2.1 API 与对象存储

- `/api/v1/uploads` 创建 owner-scoped `UploadSession`，只接受 MP4、最大 8 GiB、已确认内容处理权；
- 服务端生成私有 bucket/object key，启动真实 S3/MinIO Multipart；视频字节不经过 API；
- 默认分片 32 MiB、浏览器并发 3，参数通过配置约束；
- 只为当前缺失分片签发短期 PUT URL；签名限制 bucket、object key、uploadId、partNumber 和有效期；
- 服务端保存 `providerUploadId`，以对象存储的真实 Part Manifest 作为 complete 依据；
- complete 必须幂等：重复或并发调用只能产生一个 `MediaAsset`、一个原始 `MediaObject` 和一条确定性的后续事件；
- complete 后执行对象 HEAD，核对大小、ETag/Version、Content-Type，并保存对象事实；
- 取消必须 abort Multipart，并把会话置为终态；过期会话不得继续签名或完成；
- 播放接口只向 owner 返回短期 GET URL；bucket 不公开，管理员默认不能借角色读取私人媒体；
- 私有对象通过签名 URL 支持 `Range: bytes=...`，签名过期可重新获取，不改变媒体身份。

### 2.2 数据与状态

- 沿用 G1 的 `UploadSession`、`UploadPart`、`MediaAsset`、`MediaObject`、`ProcessingRun`、`OutboxEvent`；
- 只做向前兼容的 G2 增量迁移，不改写 G1 baseline；
- 每位用户同时最多一个 `CREATED | UPLOADING | VERIFYING` 上传；
- 浏览器文件指纹和上传清单可恢复，但数据库与对象存储仍是服务端事实源；
- 状态只允许：`CREATED → UPLOADING → VERIFYING → COMPLETED`，以及 `CANCELLED | EXPIRED | FAILED` 终态；
- 上传校验与播放准备分离：complete 后创建 `PROCESSING_PLAYBACK` 资产，真实媒体探测成功后才切换 `PLAYABLE`；
- 上传完成、资产/对象创建、处理运行与 Outbox 必须在同一数据库事务提交；
- API 崩溃、Outbox 重投或 Worker 重启不能造成重复资产。

### 2.3 媒体探测与播放准备

- 使用真实 `ffprobe` 读取对象，确认容器为 MP4、视频为 H.264、音频为 AAC，并获得真实时长；
- 合规且可直接播放的原片不做有损转码；
- 若样本不满足渐进播放，G2 只允许无损 fast-start remux，产生独立 `PLAYBACK` 对象；
- 探测失败时资产进入明确失败态，不能签发可播放地址；
- 字幕失败与播放状态解耦属于 G3，不在本 Gate 实现。

### 2.4 Web

- 把现有上传弹窗替换为可到达的完整上传页和任务详情；
- 文件选择后执行本地 MIME/扩展名、大小、时长及浏览器可读媒体信息检查；编码最终以服务端探测为准；
- 清楚展示文件名、大小、时长、私人说明和权利确认；
- IndexedDB 保存文件指纹、sessionId、已完成分片、ETag 和过期时间；不保存整份视频；
- 支持真实上传进度、暂停、继续、取消、断网自动暂停、恢复网络继续；刷新后重新选择同一文件只补传缺失分片；
- 签名过期只刷新未完成分片；
- 无可信总量时不展示虚假 ETA 或处理百分比；
- 上传/任务页包含空态、准备态、上传态、暂停态、校验态、可播放态、失败态、过期态；
- 可播放后使用真实 `<video>` 验证原片，播放 URL 过期时可刷新并恢复当前位置；完整学习播放器留到 G4。

## 3. 冻结契约

### 3.1 创建与恢复

```text
POST   /api/v1/uploads
GET    /api/v1/uploads
GET    /api/v1/uploads/:uploadId
POST   /api/v1/uploads/:uploadId/parts/sign
PUT    <private object-store signed URL>
POST   /api/v1/uploads/:uploadId/parts/:partNumber
POST   /api/v1/uploads/:uploadId/complete
POST   /api/v1/uploads/:uploadId/cancel
```

所有写请求使用 `Idempotency-Key` 或由资源身份天然幂等；所有资源从认证上下文取得 ownerId，客户端提交的 ownerId 一律忽略或拒绝。

### 3.2 媒体

```text
GET /api/v1/media-assets
GET /api/v1/media-assets/:mediaAssetId
POST /api/v1/media-assets/:mediaAssetId/playback-url
```

播放 URL 只返回短期能力，不进入持久数据库和普通日志。

### 3.3 稳定错误码

在统一 API 错误外形下增加领域错误：

- `upload_active_conflict`
- `upload_expired`
- `upload_part_invalid`
- `upload_manifest_incomplete`
- `upload_object_mismatch`
- `media_format_unsupported`
- `media_not_playable`
- `storage_unavailable`

错误必须包含 `requestId`，不得暴露 bucket 凭据、签名 URL、私人 object key 或媒体正文。

## 4. 约束与非目标

- 不接 MOSS、不生成字幕、不显示假 AI 处理百分比；
- 不做 MOV、多文件批量、HLS、多码率、有损转码、云端录音；
- 不做工作流导入或数据库直写；未来 G6 必须复用本 Gate 的资产入口；
- 不把 MinIO、PostgreSQL、Redis 或 Worker 暴露公网；
- 不使用 MemoryStorageProvider、进程内 Map 或静态任务作为生产路径；
- 不删除或迁移历史 `online_learning` 数据库；G2 使用独立 `echoflow_*_test` 数据库与独立测试 bucket/prefix。

## 5. 验收矩阵

### 5.1 确定性自动化

- contracts：边界、状态和 BigInt JSON 序列化；
- PostgreSQL：每 owner 单活动上传、owner 复合关系、并发 complete、唯一资产/Outbox；
- MinIO：真实 Multipart、只补缺片、abort、HEAD、私有性、签名 PUT/GET、Range；
- Worker：重复事件、API/Worker 重启、失败探测、成功探测、状态 CAS；
- Web：文件校验、IndexedDB manifest、暂停/恢复/取消、断网、签名刷新、刷新恢复、URL 释放；
- 双用户：A 看不到、不能签名、不能取消、不能播放 B 的资源；管理员也不能直接播放。

### 5.2 媒体样本

- 30 秒黄金样本用于每次集成；
- 5、30、60、120 分钟 H.264/AAC MP4 各至少一轮真实 Multipart → HEAD → probe → signed Range；
- 至少以计算和签名边界验证 8 GiB、3 小时不会发生 32 位溢出或超出 Part 上限；实际 8 GiB 上传属于发布候选容量验证，不在开发机制造无意义流量；
- 非 MP4、错误 MIME、超 8 GiB、缺 Part、错误 Part 大小、对象缺失和不支持编码均必须失败且不生成可播放资产。

### 5.3 故障场景

- 断网后暂停，恢复网络只补缺片；
- 刷新/关闭后重新选择同一文件可在 7 天内继续；
- Part 签名过期后重新签发；
- complete 重复、并发、完成后响应丢失均只得到一个资产；
- 对象完成后 API 崩溃，重试可从对象事实恢复；
- Outbox 重投、Redis 丢失和 Worker 重启可恢复播放准备；
- 播放签名过期后刷新 URL 并恢复时间；
- 取消或过期后迟到请求不能复活上传。

## 6. Gate 退出条件

G2 只有在以下条件同时满足时关闭：

1. 任务合同、共享 contracts、迁移、API、Worker、Web 和运行行为一致；
2. 真实 PostgreSQL、MinIO、Redis 和 ffprobe 集成证据绑定最终 Commit；
3. 30 秒及 5/30/60/120 分钟样本矩阵通过；
4. 断网、刷新、签名过期、重复/并发 complete、API/Worker 重启与对象缺失场景通过；
5. 双用户与管理员私人媒体负向矩阵通过；
6. 定向 lint/test/build 和全仓 lint/test/build 通过；
7. Reviewer 对最终代码锚点确认无 P0/P1；
8. 证据文档已提交并进入唯一 trunk。

页面存在、单 PUT 成功、数据库写入一行、手工播放一次或测试数量增加，均不能单独关闭 G2。

## 7. 实施切片

```text
G2.1 合同与增量迁移
→ G2.2 真实 Multipart + owner API + 幂等 complete
→ G2.3 Outbox/Worker 媒体探测 + 可播放资产
→ G2.4 Web IndexedDB 续传 + 任务详情 + 真实播放
→ G2.5 长媒体/故障/权限验证 + Reviewer + Gate 证据
```
