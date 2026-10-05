# 源码仓库与发布文件范围

更新：2026-10-05。

本仓库保存 AgentVac 的源码、锁定依赖清单、测试程序、构建配置与图标、使用文档，以及既有的文字验收记录和四张界面截图。当前下载与使用说明见 [README](../README.md)；已发布的 [v0.1.0 Release](https://github.com/21888/AgentVac/releases/tag/v0.1.0) 提供 macOS Apple Silicon / Intel DMG、Windows x64 便携 EXE、Linux x64 tar.gz 和 `SHA256SUMS.txt`。仓库为私有时，Release 也需要相应访问权限。

v0.1.0 的构建源码提交为 `9e6322d354059650ad2429923f8375e38d3131c9`。Mac 应用未签名、未公证；Windows 应用未签名，下载后的 Gatekeeper / SmartScreen 首次启动信任体验尚未认证。当前分发不含 AppImage 或 Windows 安装向导。具体已验证项与限制以 README 和该 Release 说明为准。

## README 界面截图

四张图片均直接复制自既有冻结版本测试截图，未修改画面。全部使用合成测试夹具，不含用户实际 Codex 数据、恢复钥匙正文或备份文件内容。图中的路径属于测试环境，容量是夹具逻辑大小，不是用户实际用量、实际磁盘占用、可释放空间或性能指标。

| 本仓库图片 | 原始测试截图 | 展示内容与证据范围 |
| --- | --- | --- |
| [overview-light.png](images/overview-light.png) | `docs/screenshots/02-overview-demo.png` | 浅色空间分析与文件检查器；浏览器 UI 测试 |
| [overview-dark.png](images/overview-dark.png) | `docs/scan-regression/01-complete-scan-dark.png` | 深色演示扫描结果；浏览器 UI 回归 |
| [space-diagnostics.png](images/space-diagnostics.png) | `docs/app-data-regression/04-diagnostics-files-light.png` | 明确选择范围后的只读统计；真实服务与生成夹具，文件对话框和 Trash 使用测试适配器 |
| [quarantine-recovery.png](images/quarantine-recovery.png) | `docs/native-linux-next/07-before-trash.png` | Linux 原生应用中待恢复的演示隔离批次 |

图片用于说明界面和工作流程，保留原始测试时点与范围，不替代当前下载包的验证，也不表示已完成签名、公证或下载后首次启动认证。历史测试过程见 [测试记录](TEST-REPORT.md)、[双主题状态记录](app-data-regression/states.json)和 [Linux 原生记录](native-linux-next/README.md)；这些历史记录不能直接当作当前 Release 的验收结果。

## 主分支工作流

`master` 中的 `.github/workflows/native-desktop.yml` 仅支持 `workflow_dispatch` 手动触发，没有 push、pull_request 或 schedule 自动入口。每个矩阵任务最长 8 分钟；这是执行上限，不保证免费。该工作流没有依赖缓存、附件上传、Release 发布或部署步骤。

本文说明主分支保留的工作流；历史验证与交付分支中的一次性工作流具有各自范围。文档更新不改变工作流，也不启动新的 CI。运行测试仍需遵守相应授权与费用限制。

## 校验范围与历史记录

- `SOURCE-SHA256.json` 仅覆盖项目源代码、测试、构建脚本、配置及图标；不覆盖文档、历史记录、日志、测试输出、截图、运行环境信息或打包成品。它不是整仓库或发行文件的校验清单。
- 下载包应使用 v0.1.0 Release 中的 `SHA256SUMS.txt` 校验。GitHub 另外提供该标签对应的源码归档；源码归档与四个应用下载包是不同的文件。
- `docs/` 中原有 JSON、日志和原生报告是较早的测试记录，保留原始日期、结果和限制，不改写为新版本测试结果。历史哈希可能对应旧产物或未纳入仓库的本地文件。
- 除 `docs/images/` 中列出的四张展示图外，其余测试截图未纳入本仓库。历史记录中的其他截图引用仍按原始记录的证据范围理解。
- 仓库不包含 `node_modules`、编译输出、应用安装包、解包运行目录、下载工具、缓存、生成夹具、Electron 用户配置或恢复钥匙备份。测试代码在运行时生成合成夹具，不包含用户实际 Codex 数据。

本次仅更正文档说明，不新增详细测试报告或日志，不改写原始测试结果、Git 历史或 Release 文件，也不改变仓库可见性。
