# EchoFlow G1 任务合同

更新时间：2026-08-12

## 目标

在唯一 trunk 的新分支上建立一个可从空 PostgreSQL 恢复、可在服务重启后恢复会话、默认拒绝越权的 `/api/v1` 身份与数据基线，为 G2 的私人长视频上传提供可信的 owner 和事务事实源。

## 实施分支与来源

- 实施分支：`codex/g1-contract-database-auth-20260812`；
- 基线：`master@9fadacc`；
- 允许参考 `codex/moss-production-hardening@0baedef` 的 DatabaseModule、错误/requestId、OTP 字段和 owner filter 思想；
- 允许参考 `codex/archive-detached-2eeb078-20260811@2eeb078` 的登录表单错误态测试意图；
- 不整体 merge 或 cherry-pick 任何历史快照；
- 拒绝历史实现中的固定验证码、进程内 Map、自制 Token、JSON refresh token、localStorage refresh token、`editor` 角色和旧 migration。

## 本任务交付

### Contracts

- `/api/v1` 的 ID、用户、角色、状态、Auth、统一错误和私人 Lesson 契约；
- Access Token 只出现在响应体；Refresh Token 只通过 HttpOnly Cookie 传递；
- 旧原型暂时需要的共享类型可保留兼容，但不得继续定义违反 V1 的 Auth 响应。

### PostgreSQL baseline

- 从空库建立 V1 baseline migration；
- 核心模型：`User`、`OtpChallenge`、`RefreshSession`、`UploadSession`、`UploadPart`、`MediaAsset`、`MediaObject`、`ProcessingRun`、`ProcessingChunk`、`OutboxEvent`、`TranscriptVersion`、`SubtitleCue`、`LearningUnit`、`PrivateLesson`、`LearningProgress`、`AuditEvent`、`IdempotencyRecord`；
- `sizeBytes` 使用 `BigInt`；私人资源都有明确 owner；状态、唯一约束、外键和必要索引进入数据库；
- 不把视频二进制、Refresh 明文、OTP 明文或字幕正文写进日志；
- 不在本任务中把 baseline 应用于现有 `online_learning` 旧原型库，只对名称以 `_test` 结尾的独立测试库执行。

冻结状态语义与 PRD 一致：

```text
UploadSession:     CREATED → UPLOADING → VERIFYING → COMPLETED
MediaAsset:        PROCESSING_PLAYBACK → PLAYABLE
ProcessingRun:     QUEUED → PROCESSING → VALIDATING → SUCCEEDED/FAILED/CANCELLED
ProcessingStage:   UPLOAD_VERIFIED → PROBING → PLAYBACK_READY → AUDIO_EXTRACTING → CHUNKING
                   → TRANSCRIBING → MERGING → CUE_SEGMENTING → VALIDATING
                   → TRANSCRIPT_READY → COURSE_READY
TranscriptVersion: BUILDING → ACTIVE → SUPERSEDED/REJECTED
```

失败、过期和删除状态只补充生命周期终态，不替换以上主路径。一个 MediaAsset 同时最多一个 `ACTIVE` TranscriptVersion。

### 身份和权限纵向闭环

- `POST /api/v1/auth/otp/request`：生成随机六位 OTP，数据库持久化 HMAC，5 分钟过期、请求节流；仅 test/development 且显式允许时返回测试码；
- `POST /api/v1/auth/otp/verify`：最多 5 次尝试，成功后消费 OTP、创建/读取用户、建立 Refresh Session；
- `POST /api/v1/auth/refresh`：读取 opaque HttpOnly Cookie，轮换 Token；旧 Token 重放时撤销整个 token family；
- `POST /api/v1/auth/logout`：服务端撤销当前会话并清除 Cookie；
- `GET /api/v1/users/me`：Bearer Access Token 鉴权；
- `GET /api/v1/lessons/:lessonId`：owner 条件进入数据库查询，其他用户得到 404；
- `GET /api/v1/admin/audit-events`：仅 `ADMIN`，普通用户得到 403；管理员默认不获得私人媒体读取能力；
- 除健康检查和 Auth 入口外，API 默认需要鉴权。

### API 和启动安全

- 全局前缀 `/api/v1`；旧 `/api/*` 不再作为 G1 可用入口；
- 统一错误结构 `{code,message,details?,requestId}`；
- 生成或校验 `x-request-id`，响应回传，并只记录方法、路径、状态、耗时和 requestId；
- CORS 使用显式 allowlist；
- Access Token 使用成熟 JWT 库、固定 issuer/audience/algorithm 和短期过期；
- Refresh/OTP 只存不可逆摘要；
- production 启动时缺少数据库、Access Secret、Refresh Pepper、OTP HMAC Secret 或 CORS allowlist 必须失败；禁止生产默认 Secret。

## 明确不做

- G2 的 Multipart 上传、对象签名和可播放 MediaAsset；
- G3 的 Worker、MOSS、字幕生成与发布；
- G4 的 Web 登录接线、播放器、录音和进度 UI；
- 短信供应商采购或真实短信发送；本 Gate 使用可替换 OTP Delivery Port 与显式测试 sink；
- 公共课程、翻译、生词、收藏、审核发布、daily goal 和云端录音；
- 迁移、删除或覆盖现有本地 `online_learning` 数据库。

## 验收矩阵

| 证据 | 必须成立 |
|---|---|
| 空库迁移 | 独立 `_test` PostgreSQL 从零执行 `prisma migrate deploy` 成功，再执行一次保持幂等 |
| 持久化 | 登录后关闭并重建 Nest App，原 Refresh Session 仍能轮换并访问 `users/me` |
| OTP | 随机码可成功一次；错误码累计；过期、已消费和超次数全部失败 |
| Refresh | 响应体无 refresh token；Cookie 为 HttpOnly/SameSite；轮换后旧 Token 重放失败并撤销新 Token |
| Access | 正常 Token 成功；篡改、错误签名、错误 issuer/audience 和过期 Token 全部 401 |
| Owner | 用户 A 可读自己的 Lesson；用户 B 请求同 ID 得到 404；客户端传 ownerId 无效 |
| RBAC | learner 访问 admin API 为 403；admin 可访问最小审计列表但不能读取私人媒体 |
| Bootstrap | 测试真实加载 prefix、CORS、requestId、Filter 和日志拦截器 |
| 错误 | 400/401/403/404/409/429/500 使用稳定 code 且携带 requestId |
| 全仓 | root lint、test、build 通过；PostgreSQL 集成证据绑定最终 Commit |

## Gate 退出条件

只有以下条件同时成立，G1 才能关闭：

1. 上述实现进入同一 G1 Commit；
2. Reviewer 在实现冻结后只读审核，无 P0/P1；
3. 从空测试库执行 migration、真实 API、重启、双用户、伪 Token 和 replay 自动化验证；
4. root lint/test/build 通过；
5. 证据绑定 Commit、测试数据库名称、命令和结果并写回 Execution State；
6. G1 分支推送 GitHub，但未通过前不 fast-forward `master`，不开始 G2。
