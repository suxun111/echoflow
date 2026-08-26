# EchoFlow Execution State

更新时间：2026-08-26

此文件记录动态执行状态，不重复存放完整 PRD。长期产品决定见 [EchoFlow V1 PRD](EchoFlow-V1-PRD.md)，整体终点见 [v0.5.0-alpha.1 Goal](GOAL-v0.5.0-alpha.1.md)。

## 当前状态

| 字段 | 当前值 |
|---|---|
| Goal | `v0.5.0-alpha.1` |
| Gate | `G1`、`G2` 已关闭；`G3` 保持打开。G3-A 已有真实 30 秒 MOSS 冒烟和一次真实约 5 分钟 EchoFlow → MOSS → ACTIVE 字幕发布；G3-B 的 C1 已在新授权私人长媒体上完成并正确失败关闭：8 个有效 Chunk 在最多一次 revision 1 后仍无唯一 segment-first 交接证据，未发布 ACTIVE。BE1 与 `g3-transcript-v2` 实施合同的独立复核均已通过；MFA S0 已在 D 盘 CPU 环境完成模型/词典 inspect、40.459 秒非私人本机对齐、脱敏结构校验及清理后只读复核，现已关闭。尚未开始 v2 产品实现；G3-C 的 30/60 分钟完整发布、故障恢复与容量矩阵尚未开始。 |
| 唯一 trunk | `master` |
| V1 产品代码审计源点 | `42968ad` |
| G0 文档基线 | `d01c67e`，已 fast-forward 至 master |
| fresh-clone 修复 | `0e3c912`，已 fast-forward 至 master；来源分支为 `codex/g0-fresh-clone-topology-20260811` |
| G1 实施分支 | `codex/g1-contract-database-auth-20260812`；最终代码锚点 `4bfaaba` |
| G2 实施分支 | `codex/g2-long-video-upload-playback-20260812`；最终代码验收锚点 `d08f6c6` |
| G3 实施分支 | `codex/g3-moss-transcript-20260813`；基线提交 `0c3e2ee`（分支创建时的 `master`）；真实 5 分钟发布代码锚点 `8873c35` |
| MOSS Provider 分支 | `codex/echoflow-provider-gateway-20260815`；当前输入范围校验锚点 `2f1c2ad`（Gateway 基线 `cdf6eb3`） |
| WIP | G3“MOSS 与完整字幕原子发布”仍是唯一核心纵向闭环。C1 证明当前固定 MOSS Provider 的 `segment` 粒度无法在该样本的全部边界提供唯一交接证据；Provider 当前没有经验证的原生 `words[]`，而 EchoFlow 现有字级合并路径也不是严格的 handoff proof 验证器。[G3-BE1 跨分片交接证据增强任务合同](G3-BE1-HANDOFF-EVIDENCE-TASK-CONTRACT.md)及其[独立复核](G3-BE1-INDEPENDENT-REVIEW.md)，连同已复核的 [G3 v2 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)，已冻结 Route B、失败关闭规则、实施切面与确定性验证边界。[MFA S0](G3-V2-MFA-IMPLEMENTATION-START-CONTRACT.md)已关闭，完整证据见 [脱敏运行证据](G3-V2-MFA-S0-VERIFICATION-EVIDENCE.md)；下一步仅能先创建/确认新的确定性 v2 代码实施任务合同，尚未开始迁移、代码或私人媒体处理。 |
| 产品功能开发 | G2 已通过退出门；G3 实施中，G4–G5 继续冻结 |
| Remote | `origin = https://github.com/suxun111/echoflow.git`；Private；外部恢复验证通过 |
| 下一人工边界 | S0 已关闭。下一项只允许基于既有 [G3 v2 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)创建并确认一份新的确定性代码实施任务合同，明确第一批领域模型、迁移、Fake、路由与数据库测试的范围/验收；在该合同确认前，不得直接开始 v2 产品实现、重跑 C1、创建 revision 2、放宽严格合并或处理私人媒体。 |

> S0 已于 2026-08-26 完成清理与冻结条件下的只读复核：目录枚举、两次 UTF-8 `mfa model inspect`、本地 catalog/哈希、CPU 约束、侧车证据和受限 C 盘路径均与已冻结证据一致。

## 2026-08-11 决策澄清

- G5 的发布阶段统一命名为“生产加固与香港邀请制 Alpha”；原 PRD 中两处 `Beta` 是命名不一致，已按版本目标 `v0.5.0-alpha.1` 和 5–10 名邀请用户的证据门统一为 `Alpha`，不改变功能范围；
- PRD 的 G6 工作流接入是 Alpha 之后的未来阶段，不属于当前 `v0.5.0-alpha.1` Goal；
- 用户选择“保留旧 worktree”不会阻塞 G0；就 worktree 清理而言，G0 只要求所有资产已保护、已分类且可从独立位置恢复。

## 2026-08-23 G3 证据阶段决策

- 用户已确认把 G3 内部按 G3-A（基础真实链路）、G3-B（跨分片交接可行性）、G3-C（长媒体可靠性与容量）组织；这不是新的 Gate，不解冻 G4/G5，也不降低 G3 最终退出条件；
- 真实约 31 分钟运行说明 segment-only 输出在切片场景下不天然提供唯一交接证据；严格失败关闭、一次 revision 1 上限和原子不发布语义保持不变；
- 逐词时间戳仍不是 V1 的必选展示产物，但跨分片唯一交接证据成为非可选发布前提；缺少时必须由真实逐词时间、强制对齐或等价声学证据补足，而非文本猜测；
- `5/30/60` 是 G3 完整字幕发布矩阵；`10/30/60` 是当前 V1 的采购、容量与成本基准，两者不得互相替代；
- 新的 [G3-B 分片交接能力基准合同](G3-B-SEGMENT-HANDOFF-BENCHMARK-CONTRACT.md) 已冻结输入隐私、运行配置、硬断言、转向规则与精确恢复点；本次只创建合同，尚未启动新样本、模型或 Docker 任务。
- 2026-08-24 的 B0 无媒体候选验证只证明本机隔离运行态可启动和受控清理；它没有选择样本、上传或下载音频、加载模型、提交 MOSS、轮询结果或发布字幕，不能写成 C1 或 G3-B 通过。

## 2026-08-24 G3-B C1 终态与 BE1 决策

- 新授权的私人长媒体 C1 已完成受控终态：8 个有效 Chunk 的 MOSS 外部任务成功，且只使用了一次 revision 1；最终严格合并以 `transcript_incomplete` / `no_textual_suffix_prefix` 失败关闭；
- 原子发布不变量在该次失败中成立：`TranscriptVersion=0`、ACTIVE=0、Cue=0；owner 字幕读取为 `409 transcript_not_ready`，原视频仍可播放。该结论不推断模型、网络、硬件或任何私人字幕正文的错误；
- C1 是失败关闭证据，不得自动重跑、不得创建 revision 2，也不得读取、写入或向文档泄露其私人正文、媒体身份或运行标识；
- 当前固定 MOSS Provider 仅经验证提供带时间的 `segment` 结果，尚无可用于发布的原生逐词或声学交接证据；现有 EchoFlow 字级时间路径会按重叠时间丢弃词，尚未实现每个 handoff 的唯一性证明；
- 因此 B2/B3 和 G3-C 暂停在 [G3-BE1 跨分片交接证据增强任务合同](G3-BE1-HANDOFF-EVIDENCE-TASK-CONTRACT.md)之前。BE1 只冻结证据模型、失败关闭规则、实现切面与确定性验证；不启动新模型、样本、Docker 任务或数据库迁移。

## 2026-08-24 V1 时长上限修订

- 用户已将 V1 的私人视频上传与字幕处理上限从 120 分钟收敛为 `0 < durationMs ≤ 3_600_000`（≤60 分钟，含 60:00）；8 GiB 保持为独立文件大小上限；
- 该修订适用于后续产品准入、G3-C 真实矩阵、容量基准和所有新建/重试字幕处理：当前要求为 `5/30/60`，不再以 120 分钟或 3 小时作为 V1 Gate；
- 浏览器元数据预检只改善体验；Worker ffprobe/媒体探测是时长最终事实源。超限或无法确认时长的输入不得成为 `PLAYABLE` 或进入新的字幕处理；历史超限媒体不自动删除或改写，已发布内容保持只读兼容；
- 既有 G2 的 120 分钟上传/播放验证和其他历史证据仍如实保留，但从本修订起不再构成当前产品承诺或后续验收门槛。

## 2026-08-25 G3-BE1 独立复核

- [G3-BE1 独立合同与代码边界复核](G3-BE1-INDEPENDENT-REVIEW.md)在不启动 Docker、模型、媒体或迁移的前提下完成；P0=0、P1=0，且没有把路线 B、能力探针或确定性测试写成已完成；
- 复核确认当前 Gateway 仍为 segment-only，Adapter 可承载但不伪造 `words[]`，现有字级合并不是 strict handoff proof，`ProcessingChunk` 不能复用为对齐任务，且发布路径尚未验证每个 proof；
- 因此只批准进入 `g3-transcript-v2` 实施合同阶段。该合同必须固定 HandoffEvidence 唯一性/计数、独立对齐任务生命周期、v2 路由与恢复、proof 原子发布与脱敏测试；在用户确认对齐器/资源/保留策略前不实现、不运行新样本。

## 2026-08-25 G3 v2 实施合同复核

- [G3 v2 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)已选择 Route B 作为架构类别，并经独立架构、代码边界及隐私/生命周期三路只读复核；终态为 P0=0、P1=0，详见 [独立复核记录](G3-TRANSCRIPT-V2-IMPLEMENTATION-REVIEW.md)；
- 合同补齐了 strict assessment 与 final evidence 的区分、`TranscriptRunArbiter`、v1/v2 互斥 enrollment、revision 1 白名单、7 项 `H_*` 汇总、proof key 隔离、回调版本路由及删除/清理边界；这些均是实施要求，尚不是已运行的功能；
- 具体对齐器/模型与许可证、数据处理地点和 callback、保留期、对象存储/临时盘、GPU/CPU/RAM/预算/并发、以及非私人能力探针仍需用户逐项确认。确认后下一项只能是新的实施启动合同；不得直接创建 migration、安装依赖、启动 Docker 或处理媒体。

## 2026-08-25 G3 v2 本地对齐器决策提案

- 对现有环境、MOSS 边界和官方资料的只读盘点形成 [本地 MFA 对齐器决策提案](G3-V2-ALIGNER-DECISION-PROPOSAL.md)：建议本地 MFA 3.3.9、英文 `english_mfa` 配对、D 盘隔离、进程轮询、单并发、无公网 callback 和约 24 小时原始对齐产物清理；这只是待确认的推荐，不是已安装或已验证的对齐能力；
- 当日可读环境显示 C 盘约 0.8 GiB、D 盘约 82 GiB、E 盘约 30 GiB；当前 Python 无 MFA/WhisperX/TorchAudio，现有 Docker image 也无 MFA。因此明确禁止在当前条件下下载/安装或拉取新镜像；
- 后续硬门槛为 C ≥5 GiB、D ≥50 GiB、显式把 Conda/MFA/temp 全部定向 D 盘、冻结并核验软件/模型/词典版本和许可证、并先用新选非私人 30–45 秒英语 probe。未满足时不清理 Docker、不删除用户数据、不重跑 C1。

## 2026-08-25 G3 v2 MFA S0 启动

- 用户已确认本地 MFA 3.3.9、仅 D 盘、无第三方传输/公网 callback、单并发与非私人 30–45 秒英语 probe；[S0 实施启动合同](G3-V2-MFA-IMPLEMENTATION-START-CONTRACT.md)冻结了安装、模型 identity、Probe、清理和失败关闭边界；
- 启动前只读预检已重新确认 C 约 19 GiB、D 约 62 GiB 可用，Conda 与网络可用，当前没有 `mfa` 命令；该事实只授权下一步受控安装/Probe，不是 MFA 已可用或 G3 通过；
- 默认 Conda dry-run 曾解析到 GPU Kaldi/MAGMA 依赖，已拒绝该方案；CPU 约束 dry-run 已解析为 `kaldi` 的 `cpu_` build、预计下载约 390 MiB。此为求解结果，不是安装、模型下载或 Probe 通过；
- S0 禁止私人媒体、C1、MOSS、Docker 新容器、迁移、Worker/API/数据库变更；成功后只能进入新的 v2 确定性代码实施合同。

## 2026-08-25 G3 v2 MFA S0 第一次运行（失败关闭）

- D 盘隔离环境已成功安装并可运行：`mfa version` 为 `3.3.9`，Conda 显式清单中的 Kaldi 为 `kaldi-5.5.1172-cpu_hf03c2bf_5`，未发现 CUDA/MAGMA 包；Windows 下需以该 prefix 的 `Library\\bin`、`Scripts` 和根目录加入**进程级** `PATH` 后调用 `mfa.exe`，没有修改用户或系统环境变量；
- 官方 `english_mfa` acoustic model 的第一次下载在读取官方远端模型索引时，被匿名 API 小时限额拒绝。该失败没有下载模型、没有取得模型 identity/许可证/兼容性，也没有开始 dictionary 下载；因此按 S0 合同停止条件关闭，而不是把软件安装成功写成完整对齐能力通过；
- `mfa model list acoustic` 与 `dictionary` 均报告没有本地模型；`probe`、`tmp` 目录均为空。未生成、读取、上传或保留任何音频、字幕正文或私人媒体，未启动 Docker/MOSS/C1；
- 已检查的 C 盘默认 MFA 与 Conda env 目录均不存在；D 盘空间仍高于 S0 硬门槛。完整脱敏事实、命令摘要、边界和精确恢复点见 [S0 第一次运行证据](G3-V2-MFA-S0-VERIFICATION-EVIDENCE.md)。

## 2026-08-25 G3 v2 MFA S0 限额后续接（失败关闭）

- 在先前匿名 API 限额提示的重置时间之后，用户确认按相同边界续接。重新预检确认 MFA `3.3.9`、D 盘环境、CPU 基线、C/D 空间和受限 C 盘默认目录均未反转；
- 官方 `english_mfa` acoustic model 的单一下载请求运行约五分钟，没有 stdout、退出码或模型文件落盘，随后被有界等待策略中断并以非零退出码结束。该结果证明本轮没有取得模型，不证明远端永久不可用或模型损坏；
- `api.github.com:443` 与 `github.com:443` 的 TCP 连通性均通过，MFA root 只含配置和模型索引缓存，acoustic/dictionary 本地列表仍为空，`probe` 和 `tmp` 仍为空；
- 未新增 Token、镜像、第三方媒体传输、callback、Docker/MOSS/C1、迁移或产品代码操作。下一次必须由用户选择更长的同边界等待，或显式批准新的凭据/来源策略后重新评估。

## 2026-08-25 G3 v2 MFA S0 发布资产 TLS 失败（失败关闭）

- 用户随后授权在相同 D 盘、CPU、单并发、无 Token/镜像/私人媒体边界下等待官方限额重置，并只重试一次；
- 重置后请求已通过模型索引和官方发布资产跳转，但在 HTTPS/TLS 传输阶段收到意外 EOF 并以非零退出。未记录或保留临时签名下载参数；没有模型文件写入；
- 对官方发布资产主机的 TCP 443 连通性通过，但这不证明 TLS 文件流成功。收尾时 MFA 本地模型列表、`probe`、`tmp` 和受限 C 盘默认目录均保持此前的空/无模型状态；
- 没有关闭证书校验、设置代理、使用镜像、增加 Token 或第三方传输。按模型不可下载的停止条件关闭 S0，等待用户在可信网络路径确定后再决定是否启动新合同。

## 2026-08-26 G3 v2 MFA S0 本地 Probe（技术验证通过，清理待完成）

- 用户手工放入模型后，D 盘隔离的 MFA `3.3.9` 成功识别并 UTF-8 inspect `english_mfa` 声学模型 `3.1.0` 与同名词典；Kaldi 仍为 `5.5.1172` 的 `cpu_` build，未发现 CUDA/cuDNN/MAGMA 包。模型仓库公开许可元数据为 `CC-BY-4.0`，本地模型文件不内嵌 LICENSE/NOTICE；
- 一段仅由本机 SAPI 生成的原创非私人英语 Probe 已在本机 FFmpeg 规范化为 16 kHz 单声道，时长 `40.459` 秒。`mfa align_one` 以 JSON、单并发和 D 盘临时目录执行后 exit code `0`；脱敏解析得到 107 个词级与 309 个音素级区间，全部检查项为非负、单调且不超音频范围；
- 侧车证据只保留版本、哈希、时长和计数，不含文本、音频、URL、任务标识或用户标识；未使用私人媒体、C1、MOSS、Docker、数据库、Worker/API 或 v2 产品代码；
- 但 MFA 的 `--final_clean` 后仍有本次临时提取目录，且后续针对固定 D 盘临时对象的三次清理请求均在 Codex 执行器创建 PowerShell 前被安全策略拒绝。没有声称清理成功，因此 S0 不关闭；精确人工清理对象及恢复检查见 [S0 脱敏运行证据](G3-V2-MFA-S0-VERIFICATION-EVIDENCE.md)。

- 人工清理后，S0 仍不能仅凭目录为空就关闭：必须在 Console UTF-8、`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`、`TERM=dumb` 的冻结条件下重跑两次 `mfa model inspect`，并复核本地 catalog 的 tag/name/version/file-name、官方 release asset 字节数、已冻结 SHA-256 与受限 C 盘路径。catalog 的整数记录是 release id，不是文件大小。只有该只读复核与清理证据同时成立，才可标记 S0 通过；不需要重跑非私人 Probe，除非误删模型、词典或侧车证据。

## 2026-08-26 G3 v2 MFA S0 清理与复核（通过并关闭）

- 用户已清理本次 Probe 的源/规范化 WAV、`.lab`、对齐 JSON、两个临时脚本与仅本次作业的 `tmp\\mfa-s0`；只读枚举确认七个固定对象均不存在，同时 D 盘模型与脱敏侧车证据仍存在；
- 受限 C 盘默认 MFA/Conda/Temp 路径仍均不存在。MFA `3.3.9` 在 Console UTF-8、`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`、`TERM=dumb` 的冻结进程条件下，两次 `mfa model inspect` 均 exit `0`；
- 本地 `english_mfa` 声学模型 `3.1.0` 与词典的 SHA-256、MFA catalog 的 tag/name/version/file-name 映射、官方 release asset 字节数，及 CPU Kaldi `5.5.1172` 的 `cpu_` build（无 CUDA/cuDNN/MAGMA）均与既有侧车和文档证据一致；catalog 的整数记录按 release id 解释，不作为文件大小比较；侧车仍报告 40.459 秒、107 个词级/309 个音素级区间、零无效/越界/非单调检查项；
- 因此 S0 的模型 identity/来源链/许可边界、非私人 Probe、单并发本机对齐、脱敏证据、清理和复核断言同时成立，S0 通过并关闭。它不关闭 G3，也不证明真实播客、HandoffEvidence 或私人媒体能力；下一项仍须先建立新的 v2 确定性代码实施任务合同。

## 已完成证据

### G0 第一轮

- 四个 dirty worktree 已复制到 `E:\33442\ai\backups\EchoFlow\G0-20260811-145052`；
- 共保护 126 个 Git 相关改动/未跟踪文件；
- 源文件与备份逐文件 SHA-256 比对，零不匹配；
- 创建四条 recovery 分支与 Commit；
- 创建两条 detached archive 分支；
- 创建 `EchoFlow-all-refs-v2-20260811.bundle`；
- Bundle SHA-256：`8A656C08AA732280D65F44B6D47B0A1413BA9172E15860E054A788B2D0F4A8D5`；
- 从 bundle 克隆到全新目录成功；
- recovery/archive refs 6/6 精确匹配；
- `git fsck --full` 通过；
- 没有执行合并、删除、prune、reset 或标签重写。

### 受保护分支

| 分支 | Commit | 用途 |
|---|---|---|
| `codex/recovery-0b51-20260811` | `2c76de7` | 本地 MP4、私有学习、API/Worker 实验 |
| `codex/recovery-5025-20260811` | `6c5d68c` | Daily goal/streak 原型，V1 暂停 |
| `codex/recovery-b8b9-20260811` | `f2c6e0b` | 旧 PRD 与早期 Worker 实验 |
| `codex/recovery-f24e-20260811` | `299e6e1` | 更完整媒体处理、词汇/翻译实验 |
| `codex/archive-detached-2eeb078-20260811` | `2eeb078` | 早期 Auth UI/API 实验 |
| `codex/archive-detached-9942c38-20260811` | `9942c38` | 与产品代码审计源点 `42968ad` 相同 tree 的历史 Commit |

## G0 第二轮本地结论

- [G0 分支资产台账](G0-BRANCH-ASSET-INVENTORY.md) 已完成领域级分类；
- `master` 确认为唯一移动 trunk；`42968ad` 保留为 V1 产品代码审计源点，不再冒充当前 master Tip；
- recovery/hardening 分支只允许选择性提取，禁止整体 merge；
- hardening 中的认证、数据库、Worker 和部署实现均不符合完整 V1，只保留约束、错误分类、恢复与测试思想；
- `0b51` 优先参考严格字幕原子发布和学习交互；
- `f24e` 优先参考 MOSS 容错、任务恢复和 Web 轮询；
- daily goal、streak、翻译、词汇和公共内容明确暂停或淘汰；
- 仓库入口已经指向确认版 PRD、Goal、State 和资产台账。

### fresh-clone 构建拓扑发现

- 在 bundle 恢复目录对 `d01c67e` 执行 `pnpm install --frozen-lockfile` 成功；
- 随后的原根 `pnpm lint` 失败，API/Admin/Worker 无法解析共享包，因为它们的 `types/main/exports` 指向未跟踪的 `dist`，而递归 lint 的上游任务使用 `tsc --noEmit`；
- 隔离复验证明先构建 `packages/*` 后，lint、31 个测试和 Web/Admin/API/Worker build 全部通过；
- G0 采用零新增依赖的最小修复：根 `dev/lint/test` 先运行 `build:workspace-packages`；任务缓存编排器留到 G1/CI 治理时单独决定。

### 修复后本地恢复验证

- fresh-clone 修复已独立审核、提交为 `0e3c912` 并 fast-forward 至 `master`；
- 从修复后的 master 创建 `EchoFlow-g0-code-0e3c912-20260811.bundle`，SHA-256 为 `7D3C07B40DF2CAFC33CC5EF8C0F40186E12BF22D286DA89686EEE53F2FDA3BE6`；
- 从该 bundle 克隆至全新目录，18 个 heads/tags refs 零不匹配，`git fsck --full` 通过，恢复后的 HEAD 精确为 `0e3c912`；
- 在该 fresh clone 中不做手工预构建，直接执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test` 和 `pnpm build`，全部通过；
- 测试共 31 个：Web 24、API 3、Worker 2、Database 2；Web、Admin、API、Worker 生产构建全部通过；
- 以上只证明可重复安装、静态检查、现有自动化测试与构建，不证明真实 PostgreSQL、Redis、MinIO、MOSS 或生产部署闭环。

### GitHub 外部恢复验证

- GitHub 仓库 `suxun111/echoflow` 确认为 Private，默认分支为 `master`；
- 推送全部 13 条本地分支和 5 个历史标签成功；
- 从 GitHub 克隆至全新目录 `E:\33442\ai\backups\EchoFlow\G0-20260811-145052\restore-check-github-3c07e4e`；
- source / GitHub clone 的 heads + tags 均为 18，零不匹配；`git fsck --full` 通过，恢复工作树干净；
- 外部验证锚点为 `3c07e4e`，source HEAD 与 GitHub clone HEAD 精确一致；
- 在该 GitHub fresh clone 中执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test` 和 `pnpm build`，全部通过；
- 测试仍为 31 个，Web、Admin、API、Worker 生产构建全部通过；该证据边界仍不包含真实 PostgreSQL、Redis、MinIO、MOSS 和生产部署。

## 当前进行中

- G1 已按 [验证证据](G1-VERIFICATION-EVIDENCE.md) 关闭；
- G2 已按 [任务合同](G2-TASK-CONTRACT.md) 实现，并由 [验证证据](G2-VERIFICATION-EVIDENCE.md) 关闭；
- 最终代码验收锚点为 `d08f6c6`，独立 Reviewer 结论为无 P0/P1；
- 验证证据已提交为 `3514a4e` 并 fast-forward 至唯一 trunk，8 项退出条件全部成立；
- 用户已确认开始 G3；[G3 任务合同](G3-TASK-CONTRACT.md)与 [G3-B 分片交接能力基准合同](G3-B-SEGMENT-HANDOFF-BENCHMARK-CONTRACT.md)共同构成当前实施与验收边界；
- EchoFlow `ca3e3ad` 已采用 segment-first 契约并接入 `/api/provider/v1`；MOSS `cdf6eb3` 已实现独立 Bearer 网关、稳定幂等身份、代际 fencing、重启协调、不可变结果与持久 TTL。独立 Reviewer 对两个工作树均未发现 P0/P1；
- [G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)记录了 EchoFlow 168 个通过测试、MOSS 52 个通过测试、真实 PostgreSQL/Redis/MinIO/FFmpeg、生产构建和隔离网关运行态复验；另有 4 个会自生成样本的 G2 长媒体回归测试因未设置 `RUN_G2_LONG_MEDIA=true` 而跳过；
- 固定 revision 的真实 MOSS 已在 RTX 4060 Laptop GPU 上完成 30 秒英语 WAV 的 BF16 CLI 与隔离 Provider 冒烟：11 段、时间单调且无越界、同一幂等请求返回稳定外部任务身份；详细边界见 [G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)；
- 2026-08-22 的真实约 31 分钟验证：整段单块真实 OOM、10 分钟单块在本机预算内未完成；6 个约 5 分钟 Provider 分片均结构合格，但真实 `buildTranscript` 在 segment-only handoff 处失败关闭。一次强静音边界 re-cut 消除了第 2→3 歧义，下一处仍失败，证明不能以随机静音重切或文本猜测替代不可变 replan 设计；详见 [G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)；
- 2026-08-22 已实现有界不可变 replan/revision：只允许 `revision 0 → 1`、只替换歧义相邻 pair、旧分片/输入/ASR 结果/外部任务保持不可变，API/Outbox 仅按有效 overlay 计数、重试和取消。新迁移、真实 PostgreSQL 的 Fake MOSS/140 秒合成媒体回归、全仓 lint/test/build 与独立审查均通过；这只是确定性本地证据，不替代真实 MOSS 长媒体发布，详见 [G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)；
- 2026-08-22 已用当前 `8873c35` 完成一次真实 5 分钟 EchoFlow G3 API/Worker/对象存储/Provider/严格合并/ACTIVE 字幕发布：3 个分片全部成功，规范化 WAV 为 `300002ms`，视频时间轴为 `300123ms`，71 个 Cue 均单调、非空且无越界。此次运行同时修复了视频容器时长略长于规范化 WAV 时 Provider 拒绝最后分片的问题；
- 2026-08-23 的全新隔离真实约 31 分钟 EchoFlow→MOSS 运行：G2 上传后资产保持 `PLAYABLE`；revision 0 的 6 个真实 MOSS 分片均成功，严格合并触发唯一一次相邻 pair 的 revision 1 repair，revision 1 的 2 个替换分片也均成功。repair 后严格合并仍以 `FAILED / MERGING / transcript_incomplete` 终态关闭；按最高候选 revision 聚合的 6 块范围连续、无无效区间，但 `TranscriptVersion=0`、`ACTIVE=0`、Cue=0，owner 读取字幕返回 `409 transcript_not_ready`。独立审查本轮原子不发布与 revision 上限为 P0=0、P1=0；详见 [G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)；
- 2026-08-23 已把“revision 1 后仍严格合并歧义”落实为内部、版本化、白名单结构诊断：只保留 failure class、候选计数、边界计数/时间、chunk index、被评估 revision 与 repair 决策；不持久化字幕正文、token、speaker 标签、对象键、UUID、URL 或原始错误消息。合成媒体 + Fake MOSS 的 revision `0 → 1 → FAILED` 回归、API overlay/权限/重试不变性与不泄露回归均通过。该合同不追溯性解释此前真实私人运行，也不改变严格判定或允许 revision 2；详见 [G3 本地验证证据](G3-LOCAL-VERIFICATION-EVIDENCE.md)；
- 真实模型层面已证明“真实 30 秒模型 + Provider 协议 + 一次真实 5 分钟完整发布”，但未完成 30/60 分钟矩阵、真实故障恢复或人工准确率基准，因此 G3 不关闭；
- G4 播放器、录音与进度以及 G5 生产发布继续冻结。

## G2 关闭证据

> 以下为 2026-08-12 旧范围的已完成事实，其中的 120 分钟/3 小时描述不构成当前 V1 准入或后续 Gate；当前边界以本文件“2026-08-24 V1 时长上限修订”和 V1 PRD 的 ≤60 分钟为准。

- 私人 MP4 已形成浏览器 Multipart 直传、PostgreSQL/Outbox、Redis/Worker、ffprobe/fast-start 与 owner-scoped 签名 Range 播放的真实闭环；
- complete、cancel、过期清理与 Worker 发布使用数据库锁、lease 和最终 fencing，迟到请求与旧 Worker 不能复活或破坏已发布资产；
- 最终锚点全仓 lint、87 个默认测试、四应用 build、Prisma validate 和 Compose config 通过；
- 30 秒黄金样本与 5/30/60/120 分钟真实长媒体矩阵通过；
- `d08f6c6` 的 fresh clone 冻结安装、lint、test、build 通过；本机 `NODE_ENV` 与失效代理边界已在证据中记录；
- `68a1703` 浏览器完成 OTP、真实直传、Worker 检查与签名播放；最终运行时代码 `8d9ac84` 复验登录态、资产读取和签名播放，`d08f6c6` 只增加错误 Part 测试；
- G2 不包含 MOSS、字幕、学习单元、逐句练习或生产部署。

## G1 关闭证据

- 冻结合同 `cad0c0b`，第一版实现 `9106ba3` 因 Reviewer 的 5 个 P1 被否决；
- 安全与数据约束整改 `7a9048c` 通过第二轮独立审核；
- fresh clone 暴露 Prisma Client 生成缺口，修复为 `f568eea` 后通过第三轮独立审核；
- 最终又收窄测试库删除边界并补充 403/429 断言，`4bfaaba` 通过独立增量审核；
- 最终代码 `4bfaaba` 无已知 P0/P1；
- fresh clone 冻结安装、首次 lint、58 个测试和四应用 build 通过；
- 独立 `echoflow_g1_fresh_f568eea_test` 从空库迁移成功，第二次 deploy 无待迁移；
- API 真实 PostgreSQL 测试覆盖重启、并发 Refresh 重放、伪 Token、双用户 owner、RBAC 和复合数据库约束；
- 历史 `online_learning` 保持原 13 张表和 2 条旧 migration，并被配置/迁移入口显式保护。

## G0 退出条件（已全部完成）

- [x] 分支和 worktree 资产完成领域级分类；
- [x] 每项候选成果有“迁移、参考、暂停、归档”结论；
- [x] 确认版 PRD 已进入当前基线分支；
- [x] README/AGENTS/Progress 不再把过期状态交给 Agent；
- [x] G0 文档变更通过独立审核并提交为 `d01c67e`；
- [x] 将审核通过的 G0 基线 fast-forward 至 `master`，唯一 trunk 自身已包含 PRD/Goal/State/资产台账；
- [x] fresh-clone 构建拓扑修复通过独立审核、提交为 `0e3c912` 并 fast-forward 至 `master`；
- [x] 从修复后的本地全引用 bundle 恢复到空目录，完成 refs、fsck、冻结安装、lint、31 个测试与生产构建验证；
- [x] 配置 Private GitHub `origin`；
- [x] 推送全部 13 条本地分支和 5 个历史标签；
- [x] 从空目录 clone 外部 remote，并验证 18 个 heads/tags refs、HEAD 和 `git fsck --full`；
- [x] 在外部 remote 的 fresh clone 执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test` 和 `pnpm build`；

G0 于 2026-08-11 完成退出条件并关闭。G1 必须从新的任务合同、分支和验收门开始，不把 G0 的工程绿色误当成生产能力。

以下是 G0 关闭后的可选治理动作，不是退出条件：用户可选择继续保留，或另行确认清理旧 worktree、冗余 alias/ref 和本地恢复目录。

## 恢复本任务时的读取顺序

1. `AGENTS.md`；
2. `docs/EXECUTION-STATE.md`；
3. `docs/GOAL-v0.5.0-alpha.1.md`；
4. `docs/EchoFlow-V1-PRD.md`；
5. 当前任务直接涉及的应用和测试；
6. 仅在需要迁移历史成果时读取 [G0 分支资产台账](G0-BRANCH-ASSET-INVENTORY.md)。

不要默认展开整个 Monorepo，也不要因为发现历史实现就直接合并旧分支。
