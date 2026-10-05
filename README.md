# AgentVac

[简体中文](README.md) · [English](README.en.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

保守整理 Codex 本地数据的桌面应用。先看清文件分布，再预览、隔离旧文件，必要时恢复原位。

- **空间分析**：区分日志、会话与受保护文件，逐项查看处理原因。
- **只读诊断**：分别统计 SQLite、旁路文件与普通日志。
- **隔离与恢复**：先预览再操作，保留批次记录，恢复时不覆盖已有文件。
- **浅色 / 深色主题**：手动切换或跟随系统。

本文档提供四种语言；**应用界面目前仅支持简体中文**。AgentVac 不是 OpenAI 官方产品。

## 下载与安装

当前版本：[v0.1.0](https://github.com/21888/AgentVac/releases/tag/v0.1.0)。预构建应用不需要另装 Node.js。

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

以下为真实应用界面的测试截图，使用**合成数据**。图中容量是文件逻辑大小，不是用户实际用量、实际磁盘占用或可释放空间。截图用于展示界面，不代替当前发行文件的安装、签名与系统信任验收。

### 空间分析 · 浅色

文件分布、分类列表与逐项检查器。

![AgentVac 浅色空间分析：文件分布环形图、分类列表和受保护文件检查器](docs/images/overview-light.png)

### 空间分析 · 深色

旧日志候选与默认受保护的会话分别标识。

![AgentVac 深色空间分析：合成数据扫描结果、旧日志候选与文件列表](docs/images/overview-dark.png)

### 空间诊断

选择检查范围，只读查看 SQLite 相关文件与普通日志的大小。

![AgentVac 空间诊断：已选范围、只读统计与分类大小](docs/images/space-diagnostics.png)

### 隔离记录与恢复

按批次检查已隔离文件，再选择恢复或移入系统回收站。

![AgentVac 隔离记录：三个演示日志文件及恢复、移入系统回收站操作](docs/images/quarantine-recovery.png)

## 第一次使用

1. **先试演示。** 点击「体验演示扫描」，练习预览、隔离和恢复。演示工作区会保留上次的操作状态。
2. **选择数据目录。** 使用原生文件夹对话框选择 Codex 数据根目录，通常为用户主目录下的 `.codex`，也可能由 `CODEX_HOME` 自定义。不要选择项目目录或磁盘根目录；建议位置只是提示，不会自动扫描。
3. **备份文件与恢复钥匙。** 先备份数据，再到「目录与恢复」选择「导出恢复备份」。备份包含敏感钥匙材料，应离线妥善保管，不要上传或分享；钥匙不能替代文件备份。
4. **扫描并检查预览。** 默认保护最近 **30 天**的文件。先选少量足够旧的轮转日志，查看保护原因、扫描完整性和操作预览。真实隔离前退出全部 Codex CLI / 桌面进程，并在应用中明确确认。
5. **试着恢复。** 在「隔离记录」恢复刚才的批次。已有目标文件不会被覆盖；发生冲突、文件变化或父目录缺失时，失败项会保留，处理后可重试。
6. **最后才考虑回收站。** 只有确认不再需要的批次才移入系统回收站。系统 API 失败时保留文件，不改用永久删除。

如果 SQLite 或日志位于其他目录，可在「空间诊断」主动添加位置、勾选范围后执行「只读统计」。配置中的路径提示只有主动开启配置读取才会解析，也不会自动访问。

## 安全与保护范围

**隔离不等于释放磁盘空间。** 文件先进入所选目录内的 `.agentvac-quarantine`；移入系统回收站后通常仍占用磁盘。只有用户在操作系统中清空回收站后才可能释放空间，清空后不可恢复。AgentVac 不提供永久删除功能。

- **可复核候选**：足够旧、单链接的普通 `log/codex-tui.log` 轮转文件（数字或日期后缀，可带 `.gz`）。
- **会话默认保护**：`sessions/**/*.jsonl` 与 `archived_sessions/**/*.jsonl` 需主动开启复核后才能选择合格项。旧会话仍可能使用中，移走会话文件可能影响历史与 resume。
- **始终保护**：当前日志、凭据、配置、history、索引、state、SQLite 及其 WAL / SHM / Journal、缓存、Skills、MCP、项目与未知文件。不会展开受保护或未知目录。
- **不跟随链接**：符号链接、多重硬链接、特殊文件与保护天数内的文件不可隔离。
- **数据库只读**：不压缩、不删除或清理 SQLite，不执行 VACUUM、checkpoint 或模式转换。深入检查仅适用于满足严格前置条件的日志数据库，无法满足时拒绝检查。

扫描默认最多访问 **50,000 项**，可改为 100,000 项；条目数包含目录，另有深度 12 和结果预算 24 MiB 限制。不完整扫描会明确标记并停用批量选择。每批最多 5,000 项。图表和小计仅表示已发现普通文件的逻辑大小，不能作为整个目录占用或可释放量。

恢复还会核对文件快照。清单通过钥匙认证不代表文件正文已逐字或哈希核验。跨卷复制、换机或系统回收站还原可能改变文件身份，导致自动恢复被拒绝；请保留完整批次和原钥匙备份，不要手改清单。要从系统回收站恢复，先通过操作系统将整个批次文件夹放回原 `.agentvac-quarantine/<批次ID>`，再由 AgentVac 校验并恢复原位置。

## 隐私与运行限制

普通扫描只读取文件元数据，不读取日志或会话正文，也不上传用户文件。主动开启的配置路径解析、只读数据库结构与页状态检查，以及应用自身的恢复钥匙和清单读取是独立、受限的流程。AgentVac 不启动或升级 Codex。

Renderer 无 Node 权限，启用 sandbox、context isolation 与 CSP。预览短时有效、仅可使用一次，执行前重新校验；隔离使用同卷移动，恢复不覆盖已有文件。

请勿提权运行、在不可信用户可写的目录使用，或边运行 Codex 边整理。重复路径检查不能消除全部恶意竞态，也无法保证突然断电或坏盘时的数据一致性。重要数据仍需独立备份。

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
```

桌面检查需要目标操作系统的 GUI 和原生服务。测试使用生成夹具，不扫描真实 Codex 数据；浏览器或辅助进程测试不能替代最终发行文件的原生验收。

```sh
npm run dist:mac    # macOS arm64 / x64：DMG、ZIP 构建目标
npm run dist:win    # Windows x64：NSIS、portable EXE 构建目标
npm run dist:linux  # Linux x64：仅 tar.gz
npm run pack       # 当前平台的未归档应用目录
```

以上为构建目标，实际发布文件以下载区为准。GitHub Actions 工作流仅手动触发，不随源码或文档更新自动运行，也不自动发布 Release。

`SOURCE-SHA256.json` 只覆盖源码、测试、构建脚本、配置与图标，不覆盖文档、截图或发行文件。发行文件请使用下载区的 `SHA256SUMS.txt` 校验。

## 许可

[MIT License](LICENSE)。第三方许可见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)；打包保留 Electron / Chromium 等许可通知。
