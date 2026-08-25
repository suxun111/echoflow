# EchoFlow G3 v2 本地 MFA 实施启动合同（S0：安装与非私人 Probe）

确认日期：2026-08-25

状态：用户已确认“本地 MFA 3.3.9、仅 D 盘、无第三方传输/公网 callback、单并发、先做非私人 30–45 秒英语 probe”。本合同只授权 S0；不授权私人媒体、产品代码或数据库变更。

所属 Gate：G3-B Route B 的运行态前置验证，不是 G3 关闭条件；不进入 G3-C，不解冻 G4/G5。

关联：[本地对齐器决策提案](G3-V2-ALIGNER-DECISION-PROPOSAL.md)、[v2 实施合同](G3-TRANSCRIPT-V2-IMPLEMENTATION-CONTRACT.md)、[G3 任务合同](G3-TASK-CONTRACT.md)、[执行状态](EXECUTION-STATE.md)。

## 1. 要解决的问题与成功定义

本 S0 只验证：在当前设备上，独立于 MOSS 的本地 MFA 能被隔离安装，能以受控输入完成一次英语强制对齐，并能留下不含正文/音频的脱敏运行证据与清理证明。

S0 成功不等于 `HandoffEvidence` 已实现、MFA 对真实播客准确、跨分片交接已解决、B2/B3 通过或 G3 关闭。它只解除“本地 MFA 作为候选根本无法安装/运行”的不确定性。

## 2. 已验证启动前置条件

在开始本合同前的只读预检已确认：

- C 盘可用约 19 GiB（高于 5 GiB 硬门槛）；D 盘可用约 62 GiB（高于 50 GiB 硬门槛）；
- Conda `26.5.3` 位于 `D:\tmp\conda`，当前没有 `mfa` 命令；
- 到 Conda 仓库的 TLS 连接可用；
- 当前 Python 环境没有 MFA/WhisperX/Torch/TorchAudio；现有 Docker image 不含 MFA；
- Windows 提供至少一个 `en-US` 本地 SAPI voice，可生成完全非私人、原创英语 probe；
- 当前未经验证的隐私媒体、C1 输入及字幕正文一律不读取、不上传、不删除、不重跑。

任一条件在真正下载前反转时立即停止，不使用 Docker `prune`、不删除用户文件、不改 Docker 数据根绕过。

## 3. 冻结的 S0 运行基线

| 项目 | 固定值 |
|---|---|
| MFA 软件 | Conda-forge `montreal-forced-aligner=3.3.9`，强制 `kaldi=*=*cpu*`；安装后必须记录 `mfa version` 与 Conda 显式包清单。 |
| 英文模型 | 官方 `english_mfa` acoustic model 与兼容 dictionary；下载后必须运行 `mfa model inspect`，记录实际模型版本、来源、摘要/许可证信息。无法验证兼容性即失败关闭。 |
| 目录根 | `D:\tmp\echoflow-aligner\`，其下仅创建 `conda-pkgs`、`conda-envs`、`mfa-root`、`tmp`、`probe` 与 `evidence`。 |
| 缓存/临时目录 | 进程级 `CONDA_PKGS_DIRS`、`CONDA_ENVS_PATH`、`TMP`、`TEMP`、`MFA_ROOT_DIR` 全部指向上述 D 盘根；不得写入用户 Conda env、C 盘 Temp、Documents/MFA 或 Docker volume。 |
| 网络/回调 | 只允许 Conda-forge 与 MFA 官方模型下载所需的出站下载；不开放端口、不创建公开 callback、不传第三方音频/文本。 |
| 资源 | 单进程、单作业；CPU-first，不与 MOSS GPU 转写并发。 |
| Probe | 原创、非私人、SAPI 生成的英语 WAV 与其已知 `.lab` 文本；目标时长 30–45 秒；只存 D 盘临时目录。 |
| 原始结果 | Probe 的输入、TextGrid/JSON 与 MFA 临时目录在验收后清理；安装软件/模型保留在 D 盘。Git、Obsidian、普通日志只记录版本、计数、时长、退出码、文件哈希和清理结果。 |

## 4. 顺序化执行步骤

### 4.1 D 盘隔离与安装

1. 再次检查 C ≥5 GiB、D ≥50 GiB，并确认目标根尚不存在或为空；
2. 仅创建 `D:\tmp\echoflow-aligner\` 下的冻结目录；
3. 仅在当前 PowerShell 子进程设置第 3 节环境变量，不修改用户级/系统级环境变量或 `.condarc`；
4. 使用显式 prefix 创建环境：

```powershell
conda create --prefix D:\tmp\echoflow-aligner\conda-envs\mfa-3.3.9 --override-channels -c conda-forge montreal-forced-aligner=3.3.9 "kaldi=*=*cpu*" -y
```

5. 使用该 prefix 中的 `mfa` 执行 `version`、`--help` 和模型子命令帮助；若实际 CLI 与本合同预期命令不同，只可调整调用语法，不可改变模型、数据、目录、网络或并发边界；
6. 下载/检查官方 `english_mfa` acoustic model 与 dictionary，冻结 inspect 输出的非内容 metadata；任何模型版本、来源、许可证或 compatibility 不明确时停止。

### 4.2 非私人 Probe

1. 在 `probe` 目录由 Windows 本地 `en-US` SAPI voice 生成原创英语语音；用本机 FFmpeg 转为 16 kHz 单声道 WAV；
2. 以该原创 `.lab` 作为唯一文本，验证音频时长处于 30–45 秒；不向控制台、Git、Obsidian 或 API 输出完整文本；
3. 使用 MFA 单文件或单 corpus 对齐命令，显式指定 `-j 1` 与 D 盘 `--temporary_directory`。官方 legacy 语义为 `mfa align CORPUS DICTIONARY ACOUSTIC_MODEL OUTPUT`，单文件语义为 `mfa align_one SOUND TEXT DICTIONARY ACOUSTIC_MODEL OUTPUT`；仅按已安装 3.3.9 的 `--help` 确认最终 flags；
4. 解析对齐输出，只检查输出存在、退出码、word/phone interval 数、时间单调、非负、落在 WAV 时长内和是否存在空/无效区间；不保存或输出正文；
5. 记录脱敏 evidence 后删除 probe 输入、`.lab`、对齐输出与 MFA 临时目录；重新枚举目录和 C 盘写入情况，证明清理完成。

## 5. 验收断言

S0 只有同时满足以下条件才为通过：

- MFA 精确版本可运行，模型/词典实际身份和许可证可核验；
- Conda 显式包清单中 `kaldi` 为 `cpu_` build，且不包含 CUDA Kaldi/MAGMA 依赖；
- Probe 为 30–45 秒、原创、非私人、全程本机处理；
- 对齐 exit code 为 0，输出结构可解析，所有被检查 interval 单调且在音频范围内；
- 作业并发始终为 1，无公网 callback、无 Docker 新容器、无第三方媒体发送；
- Conda env/cache、MFA root、temp、probe 输入/输出均位于 D 盘或已被清理；未在 C 盘新增 MFA/模型/Probe 目录；
- 最终证据仅含版本、模型 identity、许可、时长、计数、退出码、校验摘要、资源 delta 与清理断言；没有文本、音频、私人对象键、Token、Cookie、URL、job ID 或用户标识。

若 MFA 返回成功但 output 无法满足结构/时间断言，则 S0 失败关闭；不得以“命令返回 0”冒充对齐有效。

## 6. 停止条件

立即停止并交还用户：

- C 或 D 空间跌破门槛，或任何 cache/temp 写入 C；
- Conda 不能解出 3.3.9、模型不可下载、许可证/来源/兼容性无法冻结；
- MFA 要求公网 callback、第三方媒体传输、未声明的账号凭据或改变数据保留边界；
- Probe 不能生成/不能满足 30–45 秒、对齐结构失败、清理失败或资源超出本机安全边界；
- 需要查看或使用 C1/任何私人媒体、启动 MOSS、创建 migration、改 Worker/API/数据库或运行 B2/B3。

## 7. S0 后精确恢复点

S0 通过后，下一项是新的**确定性代码实施合同**：先定义 v2 的领域模型、迁移、`LocalAlignmentAdapter` Fake、Handoff validator、对象生命周期和数据库测试；不得因 S0 通过直接处理私人媒体。S0 失败则记录失败分类、清理状态和恢复命令，等待新的用户选择。
