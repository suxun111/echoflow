# EchoFlow API 契约

更新时间：2026-08-12

本文记录 G1 当前生产入口；G2–G5 尚未接通。统一前缀为 `/api/v1`，默认端口为 `3001`，共享结构以 `packages/contracts` 的 Zod schema 为准。

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

## 管理端

- `GET /api/v1/admin/audit-events`：仅 `ADMIN`；只返回最小审计字段，不授予私人媒体读取能力。

## 尚未挂载

旧 `/api`、固定验证码、公共视频、字幕编辑、内存进度、上传预签名、内存任务和公共发布端点均不属于 G1 当前 API。对应源码骨架将在 G2–G4 按 Gate 接线或清理，不能视为已实现能力。
