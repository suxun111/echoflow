# EchoFlow G3 v2 MFA S0 第一次运行证据

执行日期：2026-08-25
状态：**失败关闭（外部模型索引限额）；安装前置通过，S0 未通过。**

关联：[MFA S0 实施启动合同](G3-V2-MFA-IMPLEMENTATION-START-CONTRACT.md)、[执行状态](EXECUTION-STATE.md)。

## 结论

本次只完成了 D 盘隔离的 MFA 软件安装和 CLI 验证。官方 `english_mfa` 声学模型在读取官方模型索引时被匿名 API 的小时限额拒绝，因而模型、字典、模型许可证/兼容性、30–45 秒非私人 probe 和对齐输出均**没有**完成。根据启动合同的“模型不可下载即停止”规则，S0 以失败关闭，而非把安装成功误写成 MFA 能完成对齐。

这不是对 MFA 模型质量、网络长期可用性、用户设备或任何私人媒体的结论。现有证据只能证明：在当时匿名索引限额下，模型下载不可执行。

## 已验证事实

| 检查项 | 结果 |
|---|---|
| 安装目录 | `D:\tmp\echoflow-aligner\conda-envs\mfa-3.3.9` 存在；缓存、MFA root、临时目录和证据目录均在同一 D 盘根下。 |
| MFA CLI | 在添加该 Conda prefix 的 `Library\\bin`、`Scripts` 和根目录到**当前进程** `PATH` 后，`mfa.exe version` 返回 `3.3.9`。未改变用户或系统环境变量。 |
| CPU 约束 | `conda list --explicit` 共 200 行，脱敏 SHA-256 为 `6f1e32bff80dbdf417efd146ce4e5ddc22efd7f61ff734125ce570d6c0c8f616`；Kaldi 条目为 `kaldi-5.5.1172-cpu_hf03c2bf_5.conda`。 |
| GPU 依赖检查 | 安装后按包名检查未发现匹配 `cuda` 或 `magm` 的包。该断言针对本次 MFA Conda 环境，不泛化到整台机器。 |
| 模型状态 | `mfa model list acoustic` 与 `mfa model list dictionary` 均返回没有本地模型。 |
| Probe 与临时数据 | `probe` 目录条目数为 0；`tmp` 目录条目数为 0。未生成、读取、上传或保留任何音频、文本或对齐产物。 |
| 已检查的 C 盘默认位置 | `C:\Users\33442\Documents\MFA` 与 `C:\Users\33442\.conda\envs\mfa-3.3.9` 均不存在。该结果不等于对全盘的无写入断言。 |
| 空间 | 收尾检查时 C 盘约 19.9 GiB、D 盘约 72.1 GiB 可用，均高于 S0 的 5 GiB / 50 GiB 门槛。 |

## 命令与结果摘要

1. 使用冻结的 Conda-forge、显式 D 盘 prefix 和 `kaldi=*=*cpu*` 安装 `montreal-forced-aligner=3.3.9`；第一次下载遇到临时连接失败，第二次复用 D 盘缓存后安装成功。
2. 运行 `mfa.exe version`、`mfa model --help`、`mfa align_one --help`。CLI 明确支持 JSON 输出、`--num_jobs/-j` 和 D 盘临时目录参数；未启动实际对齐。
3. 按官方模型命令尝试下载 `english_mfa` acoustic model。远端索引返回匿名 API 小时限额错误，命令以非零退出码结束；未提供 Token、未切换镜像、未使用第三方传输。
4. 重新枚举本地模型、临时目录、受限的 C 盘默认目录和磁盘空间，结果如上。

## 边界与未验证项

- 未使用、读取或上传用户私人媒体、C1 输入或字幕正文；未启动 MOSS、Docker、新容器、数据库迁移、Worker/API 或产品代码。
- 未开放端口或创建公网 callback；本次没有任何模型或媒体对齐作业，因此不存在并发作业。
- 未验证模型版本、来源、许可证、字典兼容性、probe 时长、对齐结构、时间戳单调性、清理流程或真实播客质量。
- 未改变 S0 合同、G3 Gate 状态、上传时长上限或严格 handoff 失败关闭语义。

## 失败根因与恢复点

已验证根因是官方模型索引的匿名 API 小时限额，而非 Conda 解算、CPU Kaldi 选择、磁盘门槛或私人媒体。无法从现有数据判断是谁消耗了该共享匿名限额，也不应据此推断网络或设备存在长期故障。

若用户重新授权下一次 S0，精确恢复点是：保持当前 D 盘 MFA 3.3.9 环境与缓存不动；待官方限额重置后，在相同进程级 D 盘环境变量、CPU、单并发、无 Token、无镜像、无私人媒体边界下，先重试官方 `english_mfa` acoustic model 下载，再下载兼容 dictionary，随后运行 `mfa model inspect`。只有两者的实际身份、许可证和兼容性可冻结，才生成原创的非私人 30–45 秒 probe。
