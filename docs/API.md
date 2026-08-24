# EchoFlow API 契约

更新时间：2026-08-13

本文记录 G1/G2 已关闭能力和 G3 当前实施入口。统一前缀为 `/api/v1`，默认端口为 `3001`，共享结构以 `packages/contracts` 的 Zod schema 为准。G3 的本地 Fake MOSS/真实基础设施路径已接通，但真实 MOSS 长媒体矩阵尚未通过，因此不能把本页端点存在理解为 G3 已关闭。

除健康检查和认证入口外，路由默认需要 `Authorization: Bearer <access-token>`。Refresh Token 不进入 JSON 或浏览器存储，只通过名为 `echoflow_refresh` 的 HttpOnly Cookie 传递。

## 通用行为

- 响应回传或生成 `x-request-id`；
- 错误结构固定为 `{ "code": "...", "message": "...", "details": {}, "requestId": "..." }`；
- CORS 只允许 `CORS_ALLOWED_ORIGINS` 中的来源；
- 私人资源 owner 只来自认证上下文，客户端提供同名字段不会改变查询范围；
- 开发示例库为 `echoflow`，历史 `online_learning` 受迁移脚本保护。

## 健康检查

- `GET /api/v1/health`：进程存活；
- `GET /api/v1/health/ready`：PostgreSQL 可连接。

## 身份

### `POST /api/v1/auth/otp/request`

```json
{ "phone": "+8613800000000" }
```

随机生成六位 OTP，数据库只保存 HMAC。仅在非生产环境且 `AUTH_EXPOSE_TEST_OTP=true` 时，响应包含 `developmentCode`；未配置正式 OTP Delivery 时生产请求返回 503。

### `POST /api/v1/auth/otp/verify`

```json
{ "phone": "+8613800000000", "code": "123456" }
```

成功响应包含短期 Access Token 和用户，不包含 Refresh Token；响应同时设置 rotating HttpOnly Cookie。

### `POST /api/v1/auth/refresh`

从 Cookie 读取 opaque Refresh Token，成功后轮换 Cookie。旧 Token 的顺序或并发重放会撤销整个 session family。

### `POST /api/v1/auth/logout`

撤销 session family、清除 Cookie，成功返回 204。

## 当前用户与私人 Lesson

- `GET /api/v1/users/me`：返回当前用户；
- `GET /api/v1/lessons/:lessonId`：仅按认证 owner 查询；他人同 ID 返回 404，畸形 UUID 返回 400。

## 私人长视频上传

- `POST /api/v1/uploads`：创建 owner-scoped Multipart 上传；
- `GET /api/v1/uploads`、`GET /api/v1/uploads/:uploadId`：读取真实上传与 Part 状态；
- `POST /api/v1/uploads/:uploadId/parts/sign`：只为缺失 Part 签发短期 PUT URL；
- `POST /api/v1/uploads/:uploadId/parts/:partNumber`：核对对象存储已接收的 Part；
- `POST /api/v1/uploads/:uploadId/complete`：以 provider manifest 和对象 HEAD 幂等完成；
- `POST /api/v1/uploads/:uploadId/cancel`：取消仍活动的 Multipart。

视频字节不经过 API；上传对象为私有对象，默认 32 MiB 分片、文件上限 8 GiB、续传窗口 7 天。V1 仅接受 `0 < durationMs ≤ 3_600_000` 的媒体：浏览器可预检，Worker 的 ffprobe/媒体探测最终裁决；超限或无法确认时长的媒体失败且不会成为 `PLAYABLE`，字幕重试也会被拒绝。完整请求体和错误码见 `packages/contracts` 与 [G2 任务合同](G2-TASK-CONTRACT.md)。

## 媒体、播放与字幕

- `GET /api/v1/media-assets`、`GET /api/v1/media-assets/:mediaAssetId`：返回 owner 的媒体状态和真实字幕阶段/分片计数；
- `POST /api/v1/media-assets/:mediaAssetId/playback-url`：为 PLAYABLE 原片/播放对象签发短期 Range GET URL；
- `GET /api/v1/media-assets/:mediaAssetId/transcript`：只返回当前 ACTIVE 的完整英文 Cue 字幕；`words` 在 Provider 只有分段时间时为空数组，有真实逐词证据时返回逐词时间；BUILDING、失败或缺片统一不可见；
- `POST /api/v1/media-assets/:mediaAssetId/transcript/retry`：以 `Idempotency-Key` 重试持久化的可重试失败；临时音频过期、确定性坏结果或活动任务会被拒绝；
- `POST /api/v1/media-assets/:mediaAssetId/transcript/cancel`：以 `Idempotency-Key` 建立数据库取消 fencing，并通过 Outbox 让 Worker 持久重试外部 MOSS cancel。

播放成功与字幕成功彼此解耦；字幕失败不撤销原片播放。

## MOSS Callback

`POST /api/v1/integrations/moss/callback` 不使用用户 Access Token，而验证精确原始请求体上的 HMAC：

```text
X-EchoFlow-Event-Id
X-EchoFlow-Timestamp
X-EchoFlow-Nonce
X-EchoFlow-Signature: v1=<hex hmac-sha256>
```

签名覆盖 `timestamp + "." + nonce + "." + rawBody`。时间窗默认 5 分钟；Event ID、Nonce 和 payload hash 持久化防重放。重复事件幂等返回，乱序旧事件只留审计回执、不倒退 Chunk 状态。Callback 只写状态与 Outbox，不在请求线程拉取大结果或发布字幕。

## 管理端

- `GET /api/v1/admin/audit-events`：仅 `ADMIN`；只返回最小审计字段，不授予私人媒体读取能力。

## 尚未挂载或尚未验收

旧 `/api`、固定验证码、公共视频、字幕编辑、内存进度、公共发布和工作流导入均不属于 V1 当前入口。逐句学习、录音回听和进度恢复留到 G4；真实 MOSS 的 30 秒及 5/30/60 分钟矩阵通过前，G3 仍是实施中。
