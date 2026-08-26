# EchoFlow G3 v2 MFA S0 运行证据

## 2026-08-26：清理与只读复核通过，S0 关闭

状态：**S0 通过并关闭。**

此前技术 Probe 已通过但清理未获执行器授权，因此 S0 保持打开。用户现已手工清理固定的 D 盘临时对象；随后完成的只读复核证明清理、模型 identity/来源链、CPU 约束、脱敏侧车证据与 C/D 隔离均未反转。

| 关闭断言 | 本次复核结果 |
|---|---|
| Probe/临时清理 | 先前列出的 7 个固定对象均不存在：源/规范化 WAV、`.lab`、对齐 JSON、两个临时脚本和仅本次作业的 `tmp\\mfa-s0`。模型、隔离环境、缓存与脱敏侧车证据保留。 |
| C/D 隔离 | 受限的 `Documents/MFA`、默认 Conda MFA env 与 Temp/MFA 路径均不存在；D 盘侧车证据仍存在。 |
| 可复现 inspect | 在 Console UTF-8、`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`、`TERM=dumb` 的冻结进程条件下，`mfa model inspect acoustic english_mfa` 与 `mfa model inspect dictionary english_mfa` 均 exit `0`。 |
| 本地身份与来源链 | 声学模型仍为 `english_mfa` `3.1.0`，本地 SHA-256 `2C08BD4F82C3943DD57AC09AEAC99DBCE17A1E1BFE9FD932C8D95CD13D971068`；词典 SHA-256 `975BF9C7791535C5AEC57995E0BD2B77EB7CA364D1D974C2134E07BB0F16B079`。本地 catalog 的 tag/name/version/file-name 映射与既有公开 release 元数据一致；其整数记录是 release id（声学 `160678230`、词典 `160678250`），已与官方 release id 匹配，不是文件字节数。官方 release asset 的字节数与本地文件一致；上游未提供远端 digest，此处不声称签名证明。 |
| 运行与结构证据 | CPU Kaldi 仍为 `5.5.1172` 的 `cpu_hf03c2bf_5`，没有 CUDA/cuDNN/MAGMA 包；脱敏侧车 SHA-256 保持 `6494B4FF5CD4F0773DCFD917D20C0C1BB2E20809A09FA30BD3F91232887FD6B5`，其中的已验证结果仍为时长 `40.459` 秒、107 个词级和 309 个音素级区间、零无效/越界/非单调。 |

这次关闭不重跑 Probe、不读取或上传私人媒体、不启动 MOSS、Docker、数据库、Worker/API 或 v2 产品代码。S0 的完成只解除“本地 MFA 候选在当前设备能否受控运行”的不确定性；它不证明真实播客准确率、HandoffEvidence、跨分片交接、G3 关闭或私人媒体可处理。

关闭记录经独立只读复核，P0=`0`、P1=`0`、P2=`0`；复核特别确认 catalog 整数与官方 release id 精确对应、官方 asset 大小与本地文件一致、远端 digest 均为 null，且本文没有把 S0 误写成 G3/v2/私人媒体成功。

下一项只能是基于既有 v2 实施合同创建并确认新的确定性代码实施任务合同；在该合同明确范围和验收前，不得直接进入迁移、产品代码或私人媒体。

---

## 2026-08-26：本地非私人 Probe 技术验证通过，清理待完成

状态：**对齐技术断言通过；S0 的清理断言未完成，因此 S0 保持打开，未进入 v2 产品实现。**

用户已在既定的 D 盘隔离目录手工放入英语声学模型和词典。MFA 3.3.9 在 CPU Kaldi 环境中识别并 inspect 这两个本地模型；随后对一段完全由本机 SAPI 生成的非私人英语 WAV 运行单并发 `align_one`。命令退出码为 0，JSON 的词级和音素级区间均通过时长、单调性、非负性与范围校验。

这只证明一次受控的本地能力探针，**不**证明真实播客准确率、HandoffEvidence 已实现、跨分片交接已解决、G3 关闭或任何私人媒体可处理。验收后的精确临时文件清理被当前 Codex 本机执行器在命令启动前以安全策略拒绝，因而无法取得“已清理”的运行证据。没有把这项技术限制写成成功清理，也没有删除、读取或上传任何用户私人媒体。

### 已验证事实

| 检查项 | 结果 |
|---|---|
| MFA 软件与 inspect 条件 | `mfa version` 为 `3.3.9`；运行时仅在当前进程把隔离 prefix 的 `Library\\bin`、`Scripts` 与根目录加入 `PATH`。`mfa model inspect acoustic english_mfa` 与 `mfa model inspect dictionary english_mfa` 在 Console UTF-8、`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`、`TERM=dumb` 的同一进程条件下均 exit `0`。这是必要条件：省略该组合时 Windows GBK/Rich 渲染 IPA 可能报 `UnicodeEncodeError`，不能把那种终端问题解释为模型不兼容。未修改用户或系统环境变量。 |
| CPU 约束 | Conda 元数据中 Kaldi 为 `5.5.1172`、build `cpu_hf03c2bf_5`；隔离环境未发现 CUDA、cuDNN 或 MAGMA 包。 |
| 声学模型 | `mfa model list acoustic` 和上述 UTF-8 `inspect` 均成功。identity 为 `english_mfa`，版本 `3.1.0`，`gmm-hmm` / triphone / MFCC；本地 ZIP SHA-256 为 `2C08BD4F82C3943DD57AC09AEAC99DBCE17A1E1BFE9FD932C8D95CD13D971068`。 |
| 词典 | `mfa model list dictionary` 和上述 UTF-8 `inspect` 均成功；identity 为 `english_mfa`，本地词典 SHA-256 为 `975BF9C7791535C5AEC57995E0BD2B77EB7CA364D1D974C2134E07BB0F16B079`。 |
| 来源链与兼容性 | 本地 MFA catalog 把两个已识别模型分别映射至 `acoustic-english_mfa-v3.1.0` / `english_mfa.zip` 和 `dictionary-english_mfa-v3.1.0` / `english_mfa.dict`；其末尾整数是 release id（声学 `160678230`、词典 `160678250`），已与官方 release id 匹配，不能作为本地文件大小比较。官方公开 release 元数据返回相同 tag、资产名和字节数（ZIP `92,170,811`，词典 `1,078,195`），与本地文件大小一致。公开资产元数据未提供远端 SHA-256（字段为 null），因此证据冻结本地 SHA-256，并明确这是一条可复现的 catalog tag/name/version/file-name + official release id/asset size + local hash 来源链，**不是**声称获得了上游签名或远端哈希证明。两个模型被 MFA 以同名版本 catalog 识别且 `align_one` 已实际配对运行。 |
| 许可证来源 | 本地模型文件不内嵌 LICENSE/NOTICE；经官方 `mfa-models` 仓库公开元数据核验，仓库许可证标识为 `CC-BY-4.0`。该事实不把本地文件缺少许可证字段误写为“文件内已携带许可证”，也不外推到未选用的模型。 |
| Probe | Windows 本地 `en-US` SAPI voice 生成原创、非私人英语语音；FFmpeg 仅在本机转为 16 kHz 单声道 WAV。时长 `40.459` 秒，处于 30–45 秒窗口。 |
| 对齐执行 | `mfa align_one` 显式使用 JSON 输出、`--num_jobs 1`、D 盘 `--temporary_directory` 与 `--final_clean`；exit code `0`，没有 Docker、MOSS、公开 callback 或第三方媒体传输。 |
| 输出结构 | MFA 3.3.9 JSON 的 `tiers` 为 `words` / `phones` 映射；脱敏解析得到 107 个 word interval（106 个非空标签）和 309 个 phone interval（308 个非空标签）。 |
| 时间轴校验 | 无无效区间、无越出 WAV 时长区间、无非单调区间；不输出或记录任何标签正文。对齐 JSON 的 SHA-256 为 `9BC97585B814678EC1343C9E776A7AD89A17EE5F7D3841C1A7663507658DC203`。 |
| 脱敏侧车证据 | `D:\tmp\echoflow-aligner\evidence\mfa-s0-alignment-summary.json` 仅含版本、哈希、时长、计数与校验结果；SHA-256 为 `6494B4FF5CD4F0773DCFD917D20C0C1BB2E20809A09FA30BD3F91232887FD6B5`，不含字幕正文、音频、URL、任务标识或用户标识。 |
| C/D 隔离 | 已检查的 `C:\Users\33442\Documents\MFA`、`C:\Users\33442\.conda\envs\mfa-3.3.9`、`C:\Users\33442\AppData\Local\Temp\MFA` 均不存在；模型、缓存、Probe 与临时目录均位于 D 盘隔离根。 |

### 独立复核

先前 Probe 阶段的独立只读复核结论为 P0=`0`、P1=`0`：复核已实际使用本文冻结的 UTF-8 进程条件，两个 `mfa model inspect` 均 exit `0`；未发现 URL、凭据、字幕正文、私人媒体或“已清理/已关闭”的误写。后续关闭复核发现 catalog 整数的语义是 release id 而非资产字节数，已据此改正本文件的来源链描述；关闭结论只依赖 catalog 的 tag/name/version/file-name、官方 release asset 字节数和本地 SHA-256，不把 release id 当作大小证据。

### 清理阻塞与精确恢复点

> **恢复条件修订：** 用户完成清理后，除了只读枚举确认对象不存在、侧车证据仍存在和受限 C 盘路径仍不存在，还必须在本文冻结的 UTF-8 条件下重新运行两次 `mfa model inspect`，并复核本地 catalog 的 tag/name/version/file-name、官方 release asset 字节数和已冻结 SHA-256。该复核无需重跑 Probe，除非清理时误删除模型、词典或侧车证据。

MFA 的 `--final_clean` 后仍留下 D 盘临时提取的词典文件；Probe 的源 WAV、规范化 WAV、`.lab` 与 JSON 也尚在。随后三次只针对固定 D 盘文件/目录的清理请求都在 PowerShell 进程创建前被 Codex 执行器安全策略拒绝；因此 **没有清理操作实际执行**。

待人工清理的精确对象均位于 `D:\tmp\echoflow-aligner`：

- `probe\mfa-s0-source.wav`
- `probe\mfa-s0-16k.wav`
- `probe\mfa-s0.lab`
- `probe\mfa-s0-alignment.json`
- `probe\generate-mfa-s0-probe.ps1`
- `probe\validate-mfa-s0-output.py`
- `tmp\mfa-s0\`（仅本次对齐生成的提取词典临时目录）

应保留 `conda-envs`、`conda-pkgs`、`mfa-root` 和 `evidence\mfa-s0-alignment-summary.json`。用户清理上述固定对象后，只需恢复一次只读枚举：确认对象不存在、侧车证据仍存在、受限 C 盘路径仍不存在。该复核无需重跑 Probe，除非清理时误删除模型或侧车证据。

为避免歧义：上文的“只读枚举”只是在清理后检查目录状态，**不构成** S0 关闭判断；完整恢复条件以本节开头的“恢复条件修订”为准，必须附加 UTF-8 inspect 与 catalog/哈希复核。

此前同一 S0 曾因匿名索引限额、有界等待无终态与官方发布资产 TLS EOF 三次失败关闭。用户此后手工放入模型文件，才使本次本地 inspect 与 Probe 成为可能。历史网络失败不被重写成“模型下载成功”，本次也没有复用任何私人媒体、MOSS、Docker、数据库、Worker/API 或 v2 产品代码。

只有清理状态得到只读复核后，才可把 S0 标记为通过；其后仍需单独确认新的**确定性 v2 代码实施合同**，才可讨论领域模型、迁移、`LocalAlignmentAdapter` Fake、Handoff validator 和数据库测试。不得因 S0 Probe 技术成功自动进入私人 C1、真实播客、G3-C 或产品上线。

---

## 2026-08-25：下载受阻的历史运行记录

执行日期：2026-08-25
状态：**失败关闭（匿名索引限额、有界等待无终态、官方发布资产 TLS EOF）；安装前置通过，S0 未通过。**

关联：[MFA S0 实施启动合同](G3-V2-MFA-IMPLEMENTATION-START-CONTRACT.md)、[执行状态](EXECUTION-STATE.md)。

## 结论

本任务只完成了 D 盘隔离的 MFA 软件安装和 CLI 验证。第一次下载官方 `english_mfa` 声学模型时，远端模型索引返回匿名 API 小时限额；限额提示时间后的续接请求在约五分钟内没有 stdout、退出码或模型文件落盘，因此按有界等待策略中断；后续在同边界下等待限额重置后，请求到达官方发布资产，但 HTTPS/TLS 传输意外 EOF。模型、字典、模型许可证/兼容性、30–45 秒非私人 probe 和对齐输出均**没有**完成。根据启动合同的“模型不可下载即停止”规则，S0 以失败关闭，而非把安装成功误写成 MFA 能完成对齐。

这不是对 MFA 模型质量、远端永久可用性、用户设备或任何私人媒体的结论。现有证据只能证明：第一次受匿名索引限额阻塞，第二次没有在选定的五分钟窗口内完成，第三次在官方发布资产 HTTPS/TLS 文件传输时中断。普通 TCP 443 可达不等价于完整 TLS 文件流可用。

## 已验证事实

| 检查项 | 结果 |
|---|---|
| 安装目录 | `D:\tmp\echoflow-aligner\conda-envs\mfa-3.3.9` 存在；缓存、MFA root、临时目录和证据目录均在同一 D 盘根下。 |
| MFA CLI | 在添加该 Conda prefix 的 `Library\\bin`、`Scripts` 和根目录到**当前进程** `PATH` 后，`mfa.exe version` 返回 `3.3.9`。未改变用户或系统环境变量。 |
| CPU 约束 | `conda list --explicit` 共 200 行，脱敏 SHA-256 为 `6f1e32bff80dbdf417efd146ce4e5ddc22efd7f61ff734125ce570d6c0c8f616`；Kaldi 条目为 `kaldi-5.5.1172-cpu_hf03c2bf_5.conda`。 |
| GPU 依赖检查 | 安装后按包名检查未发现匹配 `cuda` 或 `magm` 的包。该断言针对本次 MFA Conda 环境，不泛化到整台机器。 |
| 模型状态 | 第一次下载被匿名限额拒绝；续接下载约五分钟无终态且无模型文件后中断；限额重置后的单次重试在官方发布资产 HTTPS/TLS 阶段 EOF。收尾时 `mfa model list acoustic` 与 `mfa model list dictionary` 均返回没有本地模型。 |
| Probe 与临时数据 | `probe` 目录条目数为 0；`tmp` 目录条目数为 0。未生成、读取、上传或保留任何音频、文本或对齐产物。 |
| 已检查的 C 盘默认位置 | `C:\Users\33442\Documents\MFA` 与 `C:\Users\33442\.conda\envs\mfa-3.3.9` 均不存在。该结果不等于对全盘的无写入断言。 |
| 网络最小检查 | 模型索引和发布资产主机的 TCP 443 均可达；这不等价于模型索引、TLS 文件流或二进制下载成功。 |
| 空间 | 续接收尾检查时 C 盘约 19.9 GiB、D 盘约 72.1 GiB 可用，均高于 S0 的 5 GiB / 50 GiB 门槛。 |

## 命令与结果摘要

1. 使用冻结的 Conda-forge、显式 D 盘 prefix 和 `kaldi=*=*cpu*` 安装 `montreal-forced-aligner=3.3.9`；第一次下载遇到临时连接失败，第二次复用 D 盘缓存后安装成功。
2. 运行 `mfa.exe version`、`mfa model --help`、`mfa align_one --help`。CLI 明确支持 JSON 输出、`--num_jobs/-j` 和 D 盘临时目录参数；未启动实际对齐。
3. 按官方模型命令第一次尝试下载 `english_mfa` acoustic model。远端索引返回匿名 API 小时限额错误，命令以非零退出码结束；未提供 Token、未切换镜像、未使用第三方传输。
4. 限额提示时间后，用户确认按相同边界续接。相同下载命令以单会话运行约五分钟，没有 stdout、退出码或模型文件落盘；按有界等待策略发送中断并以非零退出码结束。
5. 用户确认在同边界下等待官方限额重置。重置后单次下载到达官方发布资产，但 HTTPS/TLS 读取出现意外 EOF；未保存下载签名参数、未关闭 TLS 校验且没有模型文件写入。
6. 重新枚举本地模型、MFA root、临时目录、受限的 C 盘默认目录和磁盘空间；TCP 端口检查通过，结果如上。

## 边界与未验证项

- 未使用、读取或上传用户私人媒体、C1 输入或字幕正文；未启动 MOSS、Docker、新容器、数据库迁移、Worker/API 或产品代码。
- 未开放端口或创建公网 callback；本次没有任何模型或媒体对齐作业，因此不存在并发作业。
- 未验证模型版本、来源、许可证、字典兼容性、probe 时长、对齐结构、时间戳单调性、清理流程或真实播客质量。
- 未改变 S0 合同、G3 Gate 状态、上传时长上限或严格 handoff 失败关闭语义。

## 失败根因与恢复点

第一次失败的已验证根因是官方模型索引的匿名 API 小时限额，而非 Conda 解算、CPU Kaldi 选择、磁盘门槛或私人媒体。无法从现有数据判断是谁消耗了该共享匿名限额，也不应据此推断网络或设备存在长期故障。第二次失败只说明在选定的五分钟窗口内没有完成。第三次的已验证症状是官方发布资产 HTTPS/TLS 读取发生意外 EOF；仅凭该症状和 TCP 可达，不能诊断为远端、网络设备或本机任一侧的永久故障。

下一次 S0 需要新的用户选择。安全默认是保持当前 D 盘 MFA 3.3.9 环境与缓存不动，先确定可信网络路径后再明确授权一次同源重试；不得关闭 TLS 校验、使用镜像或切换未经审查的下载源。若考虑凭据、代理或来源变化，必须先重新审查隐私、供应链和数据边界。无论选择哪条路径，均先下载官方 `english_mfa` acoustic model 和兼容 dictionary，再运行 `mfa model inspect`。只有两者的实际身份、许可证和兼容性可冻结，才生成原创的非私人 30–45 秒 probe。
