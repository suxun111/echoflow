# EchoFlow G1 验证证据

更新时间：2026-08-12

## Gate 结论

G1“契约、数据库、身份和安全”通过。本结论绑定最终代码 Commit：

```text
4bfaabaac4405a317f9abb6750e95f5a487f18dc
```

G2 长视频上传与可播放资产尚未开始；本文不把 PostgreSQL/Auth 基线冒充上传、MOSS、播放器或生产部署闭环。

## 审计链

| Commit | 作用 | 审核结论 |
|---|---|---|
| `cad0c0b` | 冻结 G1 任务合同 | 范围基线 |
| `9106ba3` | 第一版数据库/Auth 实现 | Reviewer 发现 5 个 P1，不批准 |
| `7a9048c` | 修复并发 Refresh、owner 复合外键、状态机、旧库保护和测试缺口 | Reviewer 无 P0/P1，批准 |
| `f568eea` | fresh clone 暴露 Prisma Client 未生成后，修复首次构建拓扑 | 第三轮 Reviewer 无 P0/P1，批准 |
| `4bfaaba` | 收窄测试库删除范围，补 403/429 稳定错误断言 | 最终小增量 Reviewer 无 P0/P1，批准 |

Reviewer 已逐项核销：并发 Refresh 重放、独立开发库与旧库保护、跨 owner/跨聚合关系、PRD 状态机、确定性空库、真实日志分支、稳定 409/500、UUID、CORS 和过期文档。

## 数据库证据

最终 fresh clone 测试数据库：

```text
echoflow_g1_fresh_f568eea_test
```

- 测试准备脚本只接受安全命名的 `_test` 数据库，先强制删除并重建，再运行 `prisma migrate deploy`；
- 首次执行实际应用 `20260812000100_v1_baseline`；
- 再执行 `pnpm run db:migrate:deploy`，结果为 `No pending migrations to apply`；
- 目标库共有 18 张 `public` 表，成功迁移只有 `20260812000100_v1_baseline`；
- 历史 `online_learning` 仍为 13 张表和原 2 条 migration：`20260801000000_local_mp4_pipeline`、`20260804120000_course_vocabulary_translation`；
- `.env.example`、API 启动配置和 migration runner 均拒绝将新 baseline 用于历史 `online_learning`；
- PostgreSQL 真实负向测试证明跨 owner Upload/Media、ProcessingRun、Lesson、Progress，以及跨 Lesson Unit、跨 Transcript Cue 都被数据库拒绝；每个 MediaAsset 只能有一个 ACTIVE TranscriptVersion。

## 身份、安全与 API 证据

API 自动化真实加载生产 `createApplication` 和 PostgreSQL repository，覆盖：

- `/api/v1`、旧前缀 404、readiness、CORS allowlist、requestId 和结构化日志字段白名单；
- 随机 OTP、HMAC 落库、请求节流、5 次尝试、过期、消费后不可复用；
- Access JWT 固定 HS256、issuer、audience、短期过期；篡改、错误签名、错误 issuer/audience 和过期 Token 均为 401；
- opaque Refresh Cookie 为 HttpOnly/SameSite/受限 Path，响应体没有 Refresh Token；
- 服务重启后 Refresh Session 仍可轮换；
- 顺序重放和同 Cookie 并发使用均撤销整个 family，并使并发胜者 Token 失效；
- logout 撤销服务端 family 并清 Cookie；
- owner 来自认证上下文，用户 B 请求用户 A 的 Lesson 得到 404；
- learner 访问 admin 为 403；admin 只获得最小审计列表，仍不能读取其他用户私人 Lesson；
- 400、409、500 使用稳定错误 code、通用消息和 requestId，不泄露底层异常。

## 最终命令与结果

主工作区的最终代码锚点为 `4bfaaba`。Fresh clone 对完整生产实现 `f568eea` 做冻结安装、首次 lint、真实数据库测试与 build；`4bfaaba` 只新增测试保护和断言，已在主工作区重跑完整 lint、58 个测试与 build，并通过独立增量审核。Fresh clone 位于：

```text
E:\33442\ai\backups\EchoFlow\G1-f568eea-fresh
```

执行结果：

| 命令 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile --offline` | 通过；372 个依赖全部来自已校验本地 store |
| `pnpm lint` | 通过；fresh clone 首次构建自动执行 `prisma generate` |
| `pnpm test` | 通过；58 个测试 |
| `pnpm build` | 通过；Web、Admin、API、Worker 全部生产构建成功 |
| `pnpm run db:migrate:deploy` | 通过；第二次执行无待迁移 |
| `docker compose -f infrastructure/docker-compose.yml config --quiet` | 通过 |

58 个测试分布：Web 24、API 13、Worker 2、Database 6、Config 9、Contracts 4。API 的 13 个测试中包含 11 个真实 PostgreSQL E2E 和 2 个统一错误过滤器测试。

## 已知非阻断项

- 测试库删除保护已限制为 `echoflow_*_test`，不接受其他 `_test` 数据库名；
- 403/429 已显式断言稳定 code 与 requestId；
- G2/G3 实现删除、字幕切换时，需要补聚合删除与 `ON DELETE RESTRICT` 场景测试；
- 复用旧 PostgreSQL volume 时，`postgres-init` 建库与立即手工 migration 之间可能有短暂竞态，部署脚本应等待 init 完成。

## 证据边界

本 Gate 证明本地可重复安装/构建、空 PostgreSQL baseline、身份会话、owner/RBAC 和安全默认值。它不证明真实短信供应商、G2 Multipart/MinIO、G3 MOSS、CI、Staging、生产密钥管理、备份恢复或公网部署；这些必须在后续 Gate 单独验证。
