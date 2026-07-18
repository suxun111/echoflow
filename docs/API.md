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

开发环境返回固定验证码 `246810`。`NODE_ENV=production` 时开发短信服务会拒绝请求。

`POST /api/auth/verify-code`

请求体：

```json
{ "phone": "13800000000", "code": "246810" }
```

返回开发访问令牌、刷新令牌和用户信息。

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

返回课程学习进度，未找到时返回空进度。

`PUT /api/progress/:lessonId`

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

返回私有上传目标和首个处理任务。

`GET /api/jobs`

返回当前内存任务列表。

`GET /api/jobs/:id`

返回单个任务；不存在时返回 404。

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
