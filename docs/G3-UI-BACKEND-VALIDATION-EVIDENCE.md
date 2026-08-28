# G3 UI 后端核验界面：实施与验证证据

日期：2026-08-29
状态：本批 Web 实施完成；不构成 G3 关闭，也不开放 G4 学习功能。

## 目的与范围

本批为既有 G2 私人媒体 API 增加一个开发态、只读的可视化核验面，同时修正 Web 端将“处理结束”误写成“完整字幕已经可用”的表述。

- 仅修改 `apps/web`；未修改 API、Worker、数据库、迁移或 contracts。
- 保留既有 PlatformShell、上传页和“我的视频”主框架。
- 不调用 v2 enrollment/cancel、MOSS、对象存储直连、callback 或任何后台任务启动接口。
- 不加入 G4 的跳转、循环、倍速、录音、进度、学习单元、词典或双语功能。

## 真值规则

1. 媒体处理状态不是字幕发布事实。只有 owner-scoped `GET /media-assets/:id/transcript` 返回符合 `ActiveTranscriptViewSchema` 的数据，且返回的 `mediaAssetId` 与请求资产一致时，页面才显示“已确认完整英文字幕”。
2. `409 transcript_not_ready` 只显示“完整英文字幕尚未准备好；不会显示部分字幕”；其他 409 或异常均失败关闭为通用错误。
3. 上传页的 `succeeded / transcript_ready` 仅显示“等待字幕确认”，并引导用户到“我的视频”确认，绝不承诺“逐词”或 ACTIVE 成功。
4. 核验页的播放地址和字幕响应均绑定发起时的媒体 ID 与请求序号；选择另一媒体或刷新列表后，旧响应不能写入当前界面。

## 交付内容

- `MyVideosPage`：真实原片播放、完整英文字幕的主动检查、`409` 失败关闭、脱敏错误状态与键盘关闭/焦点恢复。
- `UploadsPage`：处理结束的中性状态、无内部错误码/“逐词”成功承诺、可访问的真实上传进度。
- `IntegrationPreviewPage`：仅开发态入口的只读媒体核验台。它只读取列表、按用户点击签发播放地址、按用户点击读取 ACTIVE 字幕；成功时仅显示前 12 条 Cue 样本和总数，避免变成学习播放器。
- 共享 `mediaStatus` 文案映射、移动端开发态入口、可见焦点与减少动画偏好支持。

## 已执行验证

以下命令在本工作树中实际执行并通过：

```powershell
$env:COREPACK_HOME = 'C:\Users\33442\AppData\Local\node\corepack'
node 'E:\33442\node_modules\corepack\dist\pnpm.js' run build:workspace-packages
node 'E:\33442\node_modules\corepack\dist\pnpm.js' --filter @online-learning/web lint
node 'E:\33442\node_modules\corepack\dist\pnpm.js' --filter @online-learning/web test
node 'E:\33442\node_modules\corepack\dist\pnpm.js' --filter @online-learning/web build
git diff --check
```

结果：

- 共享包构建通过；这一步同时修复了新工作树中开发服务器读取旧 contracts 构建产物的问题。
- Web TypeScript lint 通过。
- Web 全量测试通过：14 个测试文件、52 项测试；包含 ACTIVE 200、精确 `409 transcript_not_ready`、错误脱敏、按点击签发、有限 Cue 抽样、A→B 异步乱序丢弃和上传页中性文案回归。
- Web 生产构建通过。
- `git diff --check` 通过；仅有 Git 的 LF→CRLF 提示，无空白错误。
- 本机开发服务器在应用内浏览器中完成未登录页面渲染复核；共享包重建后的新页面无浏览器控制台错误。
- 两位独立只读 Reviewer 的二轮复核均为 P0=0、P1=0。

## 未验证边界

- 没有使用真实用户登录会话，因此未在浏览器中对经过认证的媒体列表、播放或字幕接口做真人数据验收；该部分由确定性 Web 测试覆盖，仍需用户登录后的手工验收。
- 本批不证明真实 MOSS 处理、长视频字幕成功、真实字幕准确率、G3 关闭或 G4 学习闭环。
- 生产构建没有开发态导航或 hash 路由入口；开发核验入口仍需以实际生产运行态复核，而不以源码存在与否代替部署验证。

## 建议的手工验收恢复点

在本地 API/Worker 已启动且用户完成登录后：打开开发态 `#/integration-preview`，选择一段自己的 `PLAYABLE` 媒体，依次点击“验证原片播放”和“检查完整英文字幕”。预期为：原片地址仅在点击后签发；字幕仅在 ACTIVE 200 时展示 12 条以内只读样本；未就绪时展示不显示部分字幕的提示。
