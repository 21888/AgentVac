# AgentVac next：Linux 原生验收

验证时间：2026-10-04 21:31–21:59 UTC。测试对象是 `AgentVac-next` 冻结版本，不能与旧 `AgentVac` 基线证据混用。

## 结论

源码启动与 **从新版 tar.gz 实际解包的打包应用** 均在 dot 的 Linux/XFCE 云桌面正常终端中运行成功。真实窗口、preload/IPC、隔离恢复、持久演示目录、偏好重启保留、单实例及实际系统 Trash 已验证。另完成六项真实 GTK 目录/备份对话框操作，以及系统 Trash 完整批次还原后由应用恢复文件的往返验证。

这是 **有明确限制的通过**，不是所有平台、所有原生项目全部通过。当前桌面有真实 Codex 进程，应用正确拒绝 SQLite 深查；诊断 parser、取消以及诊断期间关窗后的子进程退出，仍需要没有 Codex 进程的正常独立环境补验。AppImage 因本环境缺少 `libfuse.so.2` 未能启动；本次打包运行证据来自 tar.gz。

## 版本与环境

- Linux x64，Electron 44.5.1，正常 XFCE 桌面；沿用已有图形会话。
- 所有 Playwright Electron 启动显式指定 `chromiumSandbox: true`；实际 `argv` 和 `app.commandLine` 均验证没有 `--no-sandbox`。窗口启用 sandbox、context isolation，renderer 无 Node integration。
- 源码使用独立 `AGENTVAC_TEST_USER_DATA`。打包版使用标准 `--user-data-dir`，实际 `app.getPath('userData')` 断言等于新建的受控 profile，`app.isPackaged` 断言为 true。
- 只选择新生成的目录、SQLite、日志和恢复备份。打包应用启动仅列出未读取的建议路径，不选择或扫描真实 Codex 数据。
- 临时目录与 fixture 放在项目普通持久卷 `.qa`。未修改 HOME、XDG_DATA_HOME、系统 Trash、权限、沙箱或系统服务。
- 新版 tar.gz SHA-256：`a494100f1f9bcea6954e638a6dd2d1cffc5900f374bba6f63ae60a033d612121`。
- 新版 ASAR SHA-256：`ec9f7bc6c69bef717f869bd78df81629690206be02c0813f9f12e1d9048f7b29`。
- 解包后 main、preload、diagnostic-supervisor、diagnostic-worker 的 ASAR 内容逐字节等于冻结 dist；两个实际外置 helper 也逐字节一致。见 [tar-payload-verification.json](tar-payload-verification.json)。
- 测试结束后再次校验生产输入，全部保持一致。完整哈希见 [final-production-sha256.txt](final-production-sha256.txt)。

## 已通过的真实原生操作

| 项目 | 实际验证 | 主要证据 |
| --- | --- | --- |
| 冷启动与 IPC | 可见真实窗口、签名 ready、并发启动 IPC、真实 preload、无 renderer require | [source-results.json](source-results.json)、[package-results.json](package-results.json) |
| 隔离与恢复 | UI 选择安全 demo 文件、预览确认、隔离三文件、历史恢复 | 同上、`package-demo-restored.png`（本地截图，未入库） |
| 重启持久性 | 实际关闭/重启进程；dark 偏好、固定 demo 路径、唯一 demo 记录、签名历史保持 | source/package results |
| 单实例 | 真正启动第二个 Electron 进程；退出码 0，主窗口仍只有一个 | source/package results |
| 目录 native dialog | GTK Cancel 保留无目录状态；GTK Open 选择精确生成目录，真实 IPC root 匹配 | [manual-results.json](manual-results.json)、`02-folder-select.png`（本地截图，未入库） |
| 恢复备份 native dialog | 取消导出、实际保存、取消导入、导入同一 profile 自有备份；每次风险勾选重置 | manual results、`04-export-save.png`（本地截图，未入库）、`06-import-own-backup.png`（本地截图，未入库） |
| 重复密钥导入 | UI 报告 0 新增、1 已存在，trusted key ID 集不变，旧扫描选择清空 | manual results |
| 真实系统 Trash | 实际 Electron `shell.trashItem`，源批次目录消失，签名历史显示 trashed | source/package results |
| Trash 完整往返 | 整批系统还原后，应用恢复三文件；每个 SHA-256 与隔离数据一致 | [trash-roundtrip-results.json](trash-roundtrip-results.json)、`09-native-trash-roundtrip-restored.png`（本地截图，未入库） |
| 真实运行进程防护 | 检测到 Codex，返回 CODEX_RUNNING，未启动诊断 helper；源 SQLite 内容及元数据不变 | source/package results |

六项 native 对话框由 CUA 在真实 GTK 窗口中操作。`*.observed.json` 记录实际窗口、动作和可见结果，再由测试程序断言应用 IPC 状态、文件存在性和 key ID 集。`nativeReturnObjectCaptured: false` 明确表示没有截取 Electron 对话框返回对象；`result` 字段是观察到的选择结果摘要，不能当成捕获的原始返回值。未把 native 对话框 mock 成成功。

保存的 PNG 展示应用内实际结果，原生 GTK 窗口另由 CUA 当场截图检查；不要把这些应用 PNG 标成 GTK 对话框截图。恢复备份内容未打印、未上传，文件只保留在受控 fixture 内。

## 系统 Trash 的真实实现与范围

测试进程 PATH 沿用旧基线已验证的官方 Debian `libglib2.0-bin` 用户态解包目录，因此 Electron XFCE 路径实际调用 `gio trash`。没有替换 `shell.trashItem` 的实现，也没有永久删除回退。

完成往返的批次为 `d41f35c6-88d6-4c1c-aa74-c191da082be6`。测试在 `/home/agent/.local/share/Trash` 找到该精确批次及 `.trashinfo`，核对其中原路径后，只通过官方 Debian `trash-restore` 还原这一批次。之后由应用自己的恢复流程还原 3 个文件，合计 23,200,000 字节，逐个哈希一致。

- [standard-trash-restore.log](standard-trash-restore.log) 保留完整精确路径、真实 Trash 元数据和工具成功输出。
- [trash-roundtrip-run.log](trash-roundtrip-run.log) 保留正常打包启动参数与退出码 0。
- [gio-provenance.log](gio-provenance.log) 与 [trash-cli-provenance.log](trash-cli-provenance.log) 记录官方包来源、SHA-256、版本与依赖。
- 包来源：[Debian libglib2.0-bin](https://packages.debian.org/trixie/amd64/libglib2.0-bin/download)、[Debian trash-cli](https://packages.debian.org/trixie/all/trash-cli/download)。

本环境没有可用 GVfs Trash 后端；旧基线已观察到 Thunar `trash:///` 和 `gio trash --list` 不支持。此次还原使用标准 XDG Trash CLI，**没有验证 Thunar 图形界面还原**，也没有安装服务或更改系统配置。

## 保留的失败与测试程序修正

1. `source-attempt1-*`：原测试重启后仍等待首次欢迎界面的“体验演示扫描”，而持久 workspace 已恢复，导致超时。只修测试就绪条件，随后源码和打包版均 exit 0。生产源码未因此修改。
2. `manual-attempt1-*`：对 native dialog 返回的测试观察器未收集到结果，在空闲状态停止，exit 130。该尝试不计为产品通过或产品故障。后续使用 CUA 实际动作及应用状态验证。
3. `manual-results.json` / `manual-run.log`：六项对话框与重复导入断言均完成；随后脚本点击“体验演示”就立即调用 context，撞到应用正确的并发操作拒绝“请等待当前操作完成”。这使组合 runner 记录 failed。独立续跑等待 demo 操作结束，完成全部 Trash 往返，结果为 passed/exit 0。保留原失败，没有把整份旧 runner 输出改成通过。
4. GTK 的部分合成快捷键未按期完成动作；最终通过可见 Cancel/Open/Save 按钮完成并验证。不能据此宣称所有 native 键盘快捷键已通过。

## 仍未通过或未运行的项目

- 深查 parser 的完整原生 preload/IPC、实际诊断中取消与关窗后无孤儿：被真实 CODEX_RUNNING 门禁阻止，未改检测器，未停止其他进程，未伪造 clear。
- 对非 demo 文件的重复隔离/恢复原生测试：同样因为真实进程门禁而 SKIP。demo 隔离恢复已通过。
- AppImage 正常启动：实际错误为 `dlopen(): error loading libfuse.so.2`，exit 1。见 [appimage-run.log](appimage-run.log)。没有安装 FUSE 或使用不安全开关。
- Thunar 图形 Trash 还原、缺依赖时新版错误处理的独立复验、OS 权限拒绝矩阵、动态系统主题切换、写入期间关闭窗口及系统剪贴板完整矩阵，未据此验收。
- macOS、Windows 的实际原生执行不属于本报告覆盖范围；交叉构建和 Linux 运行不能代替它们。

## 后续复用

`source.sh` 运行项目的稳定 `scripts/desktop-e2e.mjs`；当前脚本 SHA-256 为 `2fe155580f84fb588db50d353357bda942c3e6f3e0d65927e7f5c12e5abe032f`。`package-suite.mjs` 是仅供本次 tar 包验证的派生套件，显式校验 packaged profile 与 ASAR 路径。

脚本应在已有正常图形终端中运行。不要在之前被限制的无图形 shell 中重复提权启动，也不要关闭 Chromium sandbox。复跑应使用新的证据目录和新 fixture；`manual-suite.mjs` 的 CUA 观察文件在各次新建 ownedRoot 内，不能沿用旧观察文件跳过实际操作。`restore-standard.py` 只处理结果文件标识的精确待恢复批次，不可盲目用于其他目录。

`.qa` 内包括生成的备份密钥、profile 与解包运行文件，应排除在源代码上传和交付包之外。项目 `.gitignore` 已忽略 `.qa/`。本目录中的日志被全局 `*.log` 忽略规则隐藏，但在工作区实际存在；审计归档应显式保留本报告链接的日志。本次未清空系统 Trash、未发布和未交付产品。
