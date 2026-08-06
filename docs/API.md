# EchoFlow API 契约

更新时间：2026-07-18

API 默认前缀为 `/api`，开发端口为 `3001`。请求与响应的核心结构由 `packages/contracts` 中的 Zod schema 维护。

## 健康检查

`GET /api/health`

返回服务状态、服务名和时间戳。

## 认证

`POST /api/auth/request-code`

请求体：

```json
{ "phone": "13800000000" }
```

测试环境返回固定验证码 `246810`；开发环境生成一次性验证码并仅在开发响应中返回。`NODE_ENV=production` 时必须接入正式短信服务，目前未配置会拒绝请求。

`POST /api/auth/verify-code`

请求体：

```json
{ "phone": "13800000000", "code": "246810" }
```

返回 JWT 访问令牌、刷新令牌和用户信息。访问令牌通过 `Authorization: Bearer <accessToken>` 使用。

`POST /api/auth/refresh`

请求体：

```json
{ "refreshToken": "dev-refresh..." }
```

## 视频与课程

`GET /api/videos`

查询参数：

- `search`：按标题、副标题、创作者搜索。
- `level`：`A1`、`A2`、`B1`、`B2`、`C1`。
- `category`：课程分类。
- `accent`：口音。
- `page`：正整数，默认 `1`。
- `pageSize`：`1` 到 `50`，默认 `20`。

`GET /api/videos/:id`

返回单个视频摘要，未找到时当前返回 `null`。

`GET /api/lessons/:id`

返回课程详情和字幕 cue 列表。

## 字幕与进度

`GET /api/subtitles/:lessonId`

返回课程字幕版本和 cue 列表。

`PUT /api/subtitles/:lessonId/:cueId`

请求体遵循 `SubtitleCueSchema`，路径中的 `cueId` 会覆盖请求体里的 `id`。

`GET /api/progress/:lessonId`

需要登录；进度按用户和课程保存到 PostgreSQL。

返回课程学习进度，未找到时返回空进度。

`PUT /api/progress/:lessonId`

需要登录。

请求体：

```json
{
  "completedCueIds": ["cue-1"],
  "positionMs": 5000,
  "currentCueId": "cue-2"
}
```

## 上传与任务

`POST /api/uploads/presign`

请求体：

```json
{
  "fileName": "lesson.mp4",
  "contentType": "video/mp4",
  "sizeBytes": 1048576,
  "rightsConfirmed": true
}
```

需要登录。返回 MinIO/S3 私有上传目标和首个处理任务；文件名、MIME、大小和权限确认会在服务端校验。

客户端完成对象上传后调用 `POST /api/uploads/:uploadId/complete`。API 会确认私有对象存在、记录完成时间，再将首个 BullMQ 任务投递到队列。

`GET /api/jobs`

需要登录，返回 PostgreSQL 中最近任务列表。

`GET /api/jobs/:id`

需要登录，返回单个持久化任务；不存在时返回 404。

## 健康检查

- `GET /api/health/live`：进程存活检查，不访问外部依赖。
- `GET /api/health/ready`：PostgreSQL 和 Redis readiness 检查；依赖不可用时返回 503。

除测试环境外，API 不使用内存 Map 保存业务状态。

## 管理端

`GET /api/admin/candidates`

返回候选内容列表。

`POST /api/admin/assets/:id/review`

请求体：

```json
{ "status": "approved", "note": "授权确认" }
```

`POST /api/admin/lessons/:id/publish`

返回发布结果。
