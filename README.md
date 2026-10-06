# AgentVac

[简体中文](README.md) · [English](README.en.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

面向 Codex、Claude Code、Cline 和 Cursor 的开源桌面工具：本地查看和搜索受支持的会话，分析磁盘用量，并预览符合条件的日志、缓存或完整 Claude Code 会话组。

**版本状态：** 此源码用于准备**尚未发布的 v0.2.0 有限范围候选版本**。部分会话不可归档，部分平台读取、隔离与恢复受限；不提供四种工具的完整会话管理或删除。最终源码检查、原生平台及安装包验收仍待完成。**当前 v0.1.0 下载版仅支持 Codex**，尚无已验证并发布的 v0.2.0 安装包。见[候选发布说明](docs/RELEASE-NOTES-0.2.0.md)和[发布范围矩阵](docs/RELEASE-SUPPORT-MATRIX.md)（英文）。

- **先看清数据**：查看文件逻辑大小、分类、整理候选与保护原因。
- **操作前先预览**：选择工具和数据目录，核对具体文件或完整整理单元。
- **保留恢复路径**：本地隔离、按批次记录，恢复时不覆盖已有数据。
- **舒适使用**：浅色、深色与跟随系统主题；提供 Codex SQLite 与日志的只读诊断。

本文档提供四种语言；**应用界面目前仅支持简体中文**。AgentVac 是独立项目，不是所支持工具厂商的官方产品。

## v0.2.0 候选范围

下表是源码允许进入复核的范围，不代表每个平台都已通过发行验收；还需满足下方的平台限制。

| 工具            | 可复核并隔离的范围                                                                                               | 保护范围与主要限制                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Codex**       | 旧轮转日志；通过旧版身份与恢复校验的已有签名会话隔离记录可恢复                                                   | 新的会话 JSONL 隔离保持停用；当前日志、凭据、配置、索引、数据库、未知缓存与未知数据受保护 |
| **Claude Code** | 标准旧调试日志；可选的本地会话归档，包含主记录及全部已识别关联文件                                               | 最新及活动会话、全局提示历史、记忆、凭据与未知布局；不清理 Desktop、Cowork 或云端历史     |
| **Cline**       | 可重建的全文搜索缓存、检查点临时缓存（checkpoint scratch）完整单元；已识别的旧版模型目录缓存与过期会话 hook 遥测 | 主会话数据库、任务历史、真实 Git 检查点、凭据与配置；暂不提供完整任务归档                 |
| **Cursor**      | 已识别的旧诊断日志；符合已验证布局的完整 `Cache`、`Code Cache`、`GPUCache` 和 `CachedData` 目录                  | 聊天与状态数据库、配置档、扩展、工作区、索引、账号及网络状态与未知缓存布局                |

只有明确支持的路径和完整已识别布局才可能成为候选，仍需通过时间、活动状态、文件系统与进程检查。发现目录不等于可以清理其中所有数据。Claude Code 会话归档后需恢复才能继续，全局提示历史保持不变。Cline 重建缓存时，搜索或离线模型列表可能暂不可用。Cursor 下次启动可能重新下载资源或编译缓存；恢复不会覆盖已重新生成的数据。

详细范围见 [Claude Code](docs/CLAUDE-CODE-SCOPE.md)、[Cline](docs/CLINE-SCOPE.md)、[Cursor](docs/CURSOR-SCOPE.md)、[完整整理单元与恢复](docs/SAFE-CLEANUP-UNITS.md)及[验收矩阵](docs/MULTI-AGENT-ACCEPTANCE.md)。合成数据测试不代表兼容每个已安装的工具版本，也不代表最终跨平台发行验收完成。

## 本地会话查看与搜索

单独授权后，可本地读取 Codex 的受支持 JSONL、Claude Code 主会话及有界子代理内容、Cline 当前 SDK 与受支持旧版历史，以及 Cursor 受支持的数据库记录（Windows 上停用）或明确选定的 agent-transcripts。可按标题、项目、正文关键词及原始会话时间筛选，并分页查看长消息。缺失时间保持未知，不以文件修改时间代替；未知格式、继承或压缩历史及安全上限可能使结果不完整，界面会提示范围限制。

内容授权限定于当前工具、目录和本次应用会话；撤回授权会停止读取并清空显示。正文以纯文本显示，不执行命令或自动加载外部媒体。Cline SDK 目录和 Cursor agent-transcripts 可单独选择为只读来源，不因此获得清理权限。只有符合条件且识别完整的 Claude Code 本地会话组可请求隔离预览；Codex、Cline、Cursor 的正式会话删除或归档保持停用。

在 macOS 和 Linux 上，Cursor 数据库读取需要建立私有本地临时副本，可能包含未查询的设置或认证页；每次请求默认累计上限为 512 MiB。无法验证位置或权限时不会读取数据库，也不会静默改用其他复制位置；这些平台的最终支持路径仍待原生验收。Windows 在 v0.2.0 中明确停用 Cursor IDE 数据库读取。[完整范围、隐私与限制](docs/CONVERSATION-MANAGEMENT.md)。

### 平台限制与待验收项

- **所有平台：** 相关工具及全部 CLI、桌面、IDE、SDK 和后台进程必须退出；进程仍在运行、观察不完整或状态不明时，隔离、恢复及移入系统回收站会被阻止。受保护或被阻止不等于清理成功。
- **Windows x64：** v0.2.0 明确停用 Cursor IDE 数据库读取，不会因辅助检查成功而启用。支持的替代入口是单独选择 agent-transcripts 进行只读查看；最终安装包中的原生正向验收仍待完成。
- **Linux x64：** 无法归属的外部运行时可能保持“状态不明”，阻止 Claude Code、Cline 或 Cursor 的隔离与恢复；不能宣称这些操作在普通 Linux 安装中均可用。
- **macOS Intel / Apple Silicon：** 常规隔离与恢复失败仍在专项诊断中，两种架构的最终原生与安装包验收尚未完成。此处不承诺这些操作已获 macOS 发行验收。

**v0.1.0 安全提示：** 建议仅整理旧日志，不启用会话文件隔离。当前 Codex 分页历史可能引用其他记录；新版源码已停止新的会话文件隔离。已有签名记录也只有通过旧版身份与恢复校验才能恢复。

## 下载与安装

当前下载版，**仅支持 Codex**：[v0.1.0](https://github.com/21888/AgentVac/releases/tag/v0.1.0)。以下均为既有 v0.1.0 文件，不包含本文所述 v0.2.0 候选功能；候选源码或本地构建不等于已发布安装包。预构建应用不需要另装 Node.js。

| 平台                  | 下载                                                                                                                                          | 要求                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| macOS · Apple Silicon | [AgentVac-0.1.0-macos-arm64.dmg](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-macos-arm64.dmg)                   | macOS 13+，M 系列芯片    |
| macOS · Intel         | [AgentVac-0.1.0-macos-x64.dmg](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-macos-x64.dmg)                       | macOS 13+，Intel 处理器  |
| Windows               | [AgentVac-0.1.0-windows-x64-portable.exe](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-windows-x64-portable.exe) | Windows 10+，x64；便携版 |
| Linux                 | [AgentVac-0.1.0-linux-x64.tar.gz](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-linux-x64.tar.gz)                 | 受支持的 Linux x64 桌面  |

下载后可对照 [SHA256SUMS.txt](https://github.com/21888/AgentVac/releases/download/v0.1.0/SHA256SUMS.txt) 核验文件。仓库若仍为私有，访问源码和下载需要有权限的 GitHub 账号。请使用仍有安全更新的操作系统。

- **macOS**：选择匹配芯片的 DMG，打开后将 AgentVac 拖入「应用程序」文件夹，再从那里启动。
- **Windows**：保存便携 EXE 后运行。本次提供的是便携启动器，不是安装向导。
- **Linux**：完整解压 tar.gz，在正常桌面会话中运行其中的应用。依赖通过发行版正规包管理器安装；系统回收站需要可用的桌面 Trash 后端，缺失时操作失败并保留文件。本版不提供 AppImage。

**当前 macOS 未完成 Developer ID 签名与 Apple 公证，Windows 未完成 Authenticode 签名。** Gatekeeper 或 SmartScreen 可能提示或阻止启动。不要关闭系统防护、Chromium sandbox 或 AppArmor 来绕过警告。构建成功或归档完整不代表普通首次启动的系统信任验收已完成；建议先使用演示数据。

## 界面预览

以下截图展示**尚未发布的 v0.2.0 开发界面与合成测试数据**，预览中的进程检查为模拟状态。图表显示已发现文件的逻辑大小，不代表用户实际用量或可释放空间。截图用于展示界面，不代表已安装工具的兼容性、原生平台、签名或首次启动系统信任验收完成。

### 空间分析 · 浅色

选择工具，查看文件分布、分类列表与保护原因。

![AgentVac 浅色 Codex 空间分析：工具选择器、文件分布环形图与分类文件列表](docs/images/overview-light.png)

### 空间分析 · 深色

旧日志候选与默认受保护的会话分别标识。

![AgentVac 深色 Codex 空间分析：合成扫描结果、旧日志候选与受保护会话](docs/images/overview-dark.png)

### 空间诊断

选择 Codex 检查范围，只读查看 SQLite 相关文件与普通日志。

![AgentVac Codex 空间诊断：范围选择、只读汇总与逐文件大小信息](docs/images/space-diagnostics.png)

### 隔离记录与恢复

Claude Code 批次记录展示已隔离的调试日志与已完整恢复的本地会话归档。

![AgentVac Claude Code 隔离记录：一个待恢复调试日志与一个已恢复的完整会话组](docs/images/quarantine-recovery.png)

<details>
<summary>更多预览：Claude Code、Cline 与 Cursor</summary>

### Claude Code · 完整会话归档

一起复核主记录与已识别的子代理文件，再隔离完整单元。

![AgentVac Claude Code 预览：完整主记录与子代理文件组、文件数量和会话风险确认](docs/images/claude-session-preview-light.png)

### Cline · 可重建搜索缓存

派生搜索缓存数据库与已有 WAL / SHM 旁路文件组成一个完整单元，主会话数据库保持保护。

![AgentVac Cline 预览：派生搜索缓存数据库与 WAL / SHM 完整文件组及重建提醒](docs/images/cline-cache-preview-light.png)

### Cursor · 完整缓存目录

将已识别的 GPUCache 目录作为一个完整单元复核，并提示后续可能需要重建缓存。

![AgentVac 深色 Cursor 预览：完整 GPUCache 目录、准确文件数量与重建提醒](docs/images/cursor-cache-preview-dark.png)

</details>

## 第一次使用

1. **先试演示。** 点击「体验演示扫描」，在独立 Codex 演示工作区练习预览、隔离和恢复。演示工作区会保留上次的操作状态。
2. **选择工具和数据目录。** 开发版先在顶部选择 Codex、Claude Code、Cline 或 Cursor，再使用原生文件夹对话框连接目录。v0.1.0 仅支持 Codex，通常为 `~/.codex` 或 `CODEX_HOME` 指定位置。请选择对应工具的数据根目录，不要选择项目目录或磁盘根目录；Cursor IDE 的数据目录与 `.cursor` 不同。建议位置只是提示，不会自动扫描。
3. **备份文件与恢复钥匙。** 先备份数据，再到「目录与恢复」选择「导出恢复备份」。备份包含敏感钥匙材料，应离线妥善保管，不要上传或分享；钥匙不能替代文件备份。
4. **扫描并检查预览。** 默认保护最近 **30 天**的文件。先选少量符合条件的旧日志，查看保护原因、扫描完整性，以及所选会话或缓存单元的全部成员。真实操作前退出对应工具及全部相关 CLI、桌面、IDE、SDK 和后台进程，并在应用中确认；进程仍在运行或状态不明时会阻止操作。
5. **试着恢复。** 在「隔离记录」恢复刚才的批次。已有文件和目录不会被覆盖或合并；发生冲突、数据变化或父目录缺失时保留相关项，处理后可在对应工具仍关闭的情况下重试。
6. **最后才考虑回收站。** 只有确认不再需要的批次才移入系统回收站。系统 API 失败时保留文件，不改用永久删除。

若 Codex SQLite 或日志位于其他目录，可在「空间诊断」主动添加位置、勾选范围后执行「只读统计」。配置中的路径提示只有主动开启配置读取才会解析，也不会自动访问。其他工具按上述各自范围进行元数据扫描。

## 安全与保护范围

**隔离不等于释放磁盘空间。** 文件先进入所选目录内的 `.agentvac-quarantine`；移入系统回收站后通常仍占用磁盘。只有用户在操作系统中清空回收站后才可能释放空间，清空后不可恢复。AgentVac 不提供永久删除功能。

- **明确候选范围**：Codex 既有的旧日志策略保持不变。Codex 不再允许新的会话文件隔离，已有签名记录通过身份与恢复校验后才可恢复。已支持的 Claude Code 完整会话组需主动复核；移走后需恢复才能继续。
- **关键数据保持保护**：凭据、设置、主数据库及旁路文件、项目数据与未知布局。唯一明确的数据库缓存例外是 Cline 已识别的派生搜索缓存及其关联文件，作为不解析内容的完整单元移动，不执行 SQL。
- **完整单元不可拆分**：已支持的会话组与缓存目录不能逐个选择内部文件。成员未知、扫描不完整或布局变化时整组保护；每个单元最多 5,000 个节点、12 层子目录。
- **不跟随链接**：符号链接、多重硬链接、特殊文件、跨卷单元成员与保护天数内的文件不可隔离。
- **保守执行**：预览短时有效、仅可使用一次，执行前重新校验；相关进程必须始终关闭，检查失败或状态不明会阻止操作。不执行 SQL 清理、VACUUM、checkpoint 或数据库模式转换；Codex 日志数据库的深入只读检查另有严格前置条件。

扫描默认最多访问 **50,000 项**，可改为 100,000 项；条目数包含目录，另有深度 12 和结果预算 24 MiB 限制。不完整扫描会明确标记并停用批量选择。每批最多 5,000 项。图表和小计仅表示已发现普通文件的逻辑大小，不能作为整个目录占用或可释放量。

恢复还会核对文件快照。清单通过钥匙认证不代表文件正文已逐字或哈希核验。跨卷复制、换机或系统回收站还原可能改变文件身份，导致自动恢复被拒绝；请保留完整批次和原钥匙备份，不要手改清单。要从系统回收站恢复，先通过操作系统将整个批次文件夹放回原 `.agentvac-quarantine/<批次ID>`，再由 AgentVac 校验并恢复原位置。

完整目录恢复不保证保留所有平台特有 ACL、扩展属性或创建时间。新建的多成员文件组使用 v4 签名恢复记录，不等于一次原子文件系统重命名；Windows 不提供目录 fsync 保证。旧清单中的不安全舍入标识不能通过重新导入钥匙修复，应保留整批数据而不是强制恢复。最终候选包经操作系统回收站还原的路径仍未完成原生验收。

## 隐私与运行限制

普通扫描只读取文件元数据，不读取日志或会话正文，也不上传用户文件。另行授权的会话查看与正文搜索会读取本地内容。主动开启的配置路径解析、只读数据库结构与页状态检查，以及应用自身的恢复钥匙和清单读取是独立、受限的流程。AgentVac 不启动或升级这些工具。

Renderer 无 Node 权限，启用 sandbox、context isolation 与 CSP。预览短时有效、仅可使用一次，执行前重新校验；隔离使用同卷移动，恢复不覆盖已有文件。

请勿提权运行、在不可信用户可写的目录使用，或在对应工具或其后台服务运行时整理。重复路径检查不能消除全部恶意竞态，也无法保证突然断电或坏盘时的数据一致性。重要数据仍需独立备份。

## 从源码运行与构建

技术栈：Electron、Vue 3、TypeScript。需要 Node.js `^22.17.0` 或 `>=24.0.0` 及正常桌面会话；`package-lock.json` 当前锁定 Electron `44.5.1`，使用 `npm ci` 安装锁定依赖。

```sh
npm ci
npm run dev

# 生产构建后启动
npm run build
npm start
```

检查命令：

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run test:app-data
npm run test:ux
npm run test:bulk
npm run test:scan
npm run test:accessibility
npm run test:desktop
npm run test:providers
```

桌面检查需要目标操作系统的 GUI 和原生服务。测试使用生成夹具，不扫描用户真实数据；浏览器或辅助进程测试不能替代最终发行文件的原生验收。

```sh
npm run dist:mac    # macOS arm64 / x64：DMG、ZIP 构建目标
npm run dist:win    # Windows x64：NSIS、portable EXE 构建目标
npm run dist:linux  # Linux x64：仅 tar.gz
npm run pack       # 当前平台的未归档应用目录
```

以上为构建目标，实际发布文件以下载区为准。GitHub Actions 原生验证通常按需手动执行；特定源码验收可能使用临时触发条件，请以当前工作流文件为准。验证不会自动发布 Release。

`SOURCE-SHA256.json` 记录特定源码快照的哈希，包含代码、测试、文档与截图；它不证明当前候选版本已通过验收，也不用于校验发行安装包。下载应用请使用对应发行版的 `SHA256SUMS.txt`。

## 许可

[MIT License](LICENSE)。第三方许可见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)；打包保留 Electron / Chromium 等许可通知。
