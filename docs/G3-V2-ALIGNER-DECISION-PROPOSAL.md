# EchoFlow G3 v2 本地边界对齐器决策提案

日期：2026-08-25

状态：基于只读盘点与官方资料的**待确认提案**；不授权安装、下载、迁移、Docker、代码或媒体处理。
关联：[v2 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)、[执行状态](EXECUTION-STATE.md)、[G3 任务合同](G3-TASK-CONTRACT.md)。

## 1. 要解决的问题

固定 MOSS Gateway 已经验证为 `segment`-only。跨分片交接不能靠文本猜测、旧 word overlap-drop 或重新切片伪造通过；Route B 需要独立、可失败关闭的声学边界证据。

## 2. 盘点事实

以下均为 2026-08-25 的本机只读事实：

- MOSS 已验证在 RTX 4060 Laptop GPU 上进行 BF16 转写，但其真实 Provider 输出不构成 `words[]` 或声学 handoff proof；约 31 分钟单块曾 OOM，因此 v1 仍采用约 5 分钟分片；
- 本机存在 Conda `26.5.3`（`D:\tmp\conda`），但当前 Python 环境没有 `whisperx`、`torch`、`torchaudio`、`ctc_segmentation` 或 `aeneas`；现有 Docker image 也没有 MFA；
- 当日 C 盘约剩 `0.8 GiB`，D 盘约剩 `82 GiB`，E 盘约剩 `30 GiB`；因此任何下载、模型缓存、Conda 环境和临时工作区都不能默认落在 C 盘；
- Docker 可用，但现有镜像不含 MFA。当前磁盘条件下拉取新镜像会把 Docker 数据层风险带回 C 盘，故不作为首选。

## 3. 候选比较与结论

| 候选 | 结论 | 原因 |
|---|---|---|
| **MFA 3.3.9，本地 CLI** | **推荐** | 独立于 MOSS、可在本地运行、适合“给定文本 + 边界音频”的强制对齐；软件 MIT，英文 MFA acoustic/dictionary 模型标示 CC BY 4.0；现有 Conda 可在 D 盘隔离。 |
| WhisperX | 暂不选 | 对齐能力存在，但本机未安装依赖；其对齐模型、HF 下载、版本与附加依赖需另行冻结。把它与现有 MOSS 转写混合会引入更多未校准的模型/依赖变量。 |
| TorchAudio CTC 对齐 | 不选为 V1 依赖 | 官方文档说明 TorchAudio 已进入维护阶段，且其 CTC forced alignment API 已弃用/移除路径明确，不应把它作为长期 Gate 依赖。 |

官方依据：MFA 的 [安装文档](https://montreal-forced-aligner.readthedocs.io/en/installation-docs-update/installation.html)、[官方仓库与 MIT 声明](https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner)、[英文模型/词典许可证](https://mfa-models.readthedocs.io/en/latest/acoustic/English/index.html)；TorchAudio 的 [维护与弃用说明](https://docs.pytorch.org/audio/stable/)；WhisperX 的 [代码许可证](https://github.com/m-bain/whisperX/blob/main/LICENSE)。第三方软件和模型实际版本、下载摘要与许可文本必须在安装时再次核验并记录，不能仅依赖本提案。

## 4. 推荐的保守实施基线（待确认）

1. **对齐器**：本地 MFA `3.3.9`，仅接受相互兼容的英文 acoustic model 与 dictionary；初始候选为官方 `english_mfa` 配对。实际模型版本、来源、SHA-256、许可证和兼容性必须在下载后通过 `mfa model inspect` 固化进配置，版本变化不得覆盖旧 evidence。
2. **数据边界**：仅本机处理；不向第三方、公开 callback 或外网服务发送音频、候选文本、字幕或 raw result。MFA 以子进程方式受 Worker 控制，采用轮询/进程退出收集，不新增公网 endpoint。
3. **最小输入**：每个 unresolved handoff 仅构造最多 30 秒的 16 kHz 单声道边界 WAV（默认边界两侧各最多 15 秒）与该窗口必要的候选文本；不得传完整视频、整段音频或完整字幕给对齐器。
4. **资源隔离**：所有 Conda cache/env、MFA root、临时文件、模型和工作目录显式置于 `D:\tmp\echoflow-aligner\`；初始并发为 1，CPU-first，不与 MOSS GPU 转写并发争抢。不得使用 Docker 作为 MFA 首版运行方式。
5. **生命周期**：`HANDOFF_AUDIO`、MFA 临时目录和 `ALIGNMENT_RAW` 在 run 终态后目标 24 小时内清理；最终只保留脱敏 evidence 信封及独立 HMAC proof。删除/取消必须取消本地子进程、fence 迟到结果，并按对象版本清理。
6. **失败关闭**：MFA 不认识的词、字典/声学不匹配、时间/窗口越界、低置信或多候选都产生 `insufficient`/`ambiguous` evidence，不能生成 revision 2 或 ACTIVE 字幕。

## 5. 硬性前置条件

下列条件未满足前，禁止下载或安装：

- C 盘可用空间恢复到至少 `5 GiB`，避免 Windows/驱动/工具临时文件耗尽系统盘；
- D 盘可用空间保持至少 `50 GiB`；
- 安装时显式设置 `CONDA_PKGS_DIRS`、`CONDA_ENVS_PATH`、`TMP`、`TEMP`、`MFA_ROOT_DIR` 到新的 D 盘目录，并在命令结束后验证没有把模型/临时文件写到 C 盘；
- 锁定 MFA 软件、英文 acoustic model、dictionary 的版本与摘要，并完成许可/归属记录；
- 先运行新选、非私人、许可明确的 30–45 秒英语 probe；不得自动使用 C1 或任何此前私人视频。

`5 GiB`/`50 GiB` 是当前设备的保守运行门槛，不是已验证的模型最低要求。若不满足，任务应失败关闭并交还用户，不得通过 Docker 清理、`prune`、删除用户文件或改变 Docker 数据根来绕过。

## 6. 后续实施顺序（确认后）

```text
用户确认本地 MFA 基线与空间前置条件
→ 新建 v2 实施启动合同（冻结版本、接口、测试切片）
→ D 盘安装/模型 metadata 预检（不接触私人媒体）
→ 非私人 30–45 秒 probe + 清理证明
→ 第一确定性实现切片：领域模型/迁移/Adapter Fake/validator
→ 数据库与 Worker/API/隐私回归 + 独立复核
→ 逐次重新授权的真实 B2/B3
```

任何一个阶段失败都不得把 Fake、模型可启动或探针成功写成真实 G3 通过。

## 7. 仅需用户确认的最小事项

请确认或否决以下一条基线：

> 采用 **本地 MFA 3.3.9 + 英文 `english_mfa` 配对**；只在 D 盘 `D:\tmp\echoflow-aligner\` 下载和运行；无公网 callback、无第三方数据传输、单并发、终态原始对齐产物约 24 小时清理；先做非私人 30–45 秒英语 probe。C 盘恢复到至少 5 GiB 前不下载安装。

若确认，下一轮只创建并复核“v2 实施启动合同”，不直接拿私人媒体运行。
