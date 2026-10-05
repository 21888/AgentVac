# 私有源码仓库范围

本仓库保存 AgentVac 新功能验证版的源码、锁定依赖清单、测试程序、构建所需应用图标、文字验收记录，以及 README 展示用的四张真实界面截图。产品仍处于验证阶段，README 和 TEST-REPORT 所列发布闸门继续有效。

## README 界面截图

四张图片均直接复制自既有冻结版本测试截图，未修改画面。全部使用合成测试夹具，不含用户实际 Codex 数据、恢复钥匙正文或备份文件内容。图中的路径属于测试环境，容量是夹具逻辑大小，不是用户实际用量、实际磁盘占用、可释放空间或性能指标。

| 本仓库图片 | 原始测试截图 | 展示内容与证据范围 |
| --- | --- | --- |
| [overview-light.png](images/overview-light.png) | `docs/screenshots/02-overview-demo.png` | 浅色空间分析与文件检查器；浏览器 UI 测试 |
| [overview-dark.png](images/overview-dark.png) | `docs/scan-regression/01-complete-scan-dark.png` | 深色演示扫描结果；浏览器 UI 回归 |
| [space-diagnostics.png](images/space-diagnostics.png) | `docs/app-data-regression/04-diagnostics-files-light.png` | 明确选择范围后的只读统计；真实服务与生成夹具，文件对话框和 Trash 使用测试适配器 |
| [quarantine-recovery.png](images/quarantine-recovery.png) | `docs/native-linux-next/07-before-trash.png` | Linux 原生应用中待恢复的演示隔离批次 |

图片用于说明界面和工作流程，不替代完整测试记录，也不表示 macOS / Windows 原生验收、AppImage/FUSE、签名或公证已完成。详细范围见 [测试报告](TEST-REPORT.md)、[双主题状态证据](app-data-regression/states.json)和 [Linux 新版原生报告](native-linux-next/README.md)。

## CI 与费用

唯一 GitHub Actions 工作流仅支持 `workflow_dispatch`，没有 push、pull_request、schedule 等自动触发入口。此次源码上传和 README 截图更新不启动任何 CI。运行测试前必须另行确认用户授权和零费用条件；20 分钟超时本身不保证免费。工作流没有依赖缓存、附件上传、发布或部署步骤。

## 证据与排除项

- 生产源码、原有测试程序、构建配置、工作流和图标按冻结验证版原样保存。README 和本文补充界面展示与截图范围；原生报告继续保留原有范围说明。本次仅更新文档、展示图片及仓库文件校验清单，未重跑应用测试。
- `docs/` 中的 JSON、日志和原生报告是既有测试证据，不能当作本次 GitHub CI 的运行结果。
- 除 `docs/images/` 中明确列出的四张展示图外，其余测试截图仍保留在本地和完整源码验证归档中。证据 JSON、日志或历史哈希清单可能提到未纳入本仓库的文件；原生报告中的其他截图引用仍以本地证据说明标识。
- 完整验证归档：`AgentVac-0.1.0-source-verification.zip`；SHA-256：`9b303cdc0259f202d6a388427f7cb65ed19121810a74d0f69f9136acd2d7bbae`。该归档保留原有验证版本，不包含本次 README 展示编排。
- `SOURCE-SHA256.json` 校验本仓库当前纳入的文件，包括四张展示图，不包括清单自身；历史证据哈希保留原有范围，不改写为新测试结果。
- 不上传 node_modules、编译输出、安装包、解包运行目录、下载工具、缓存、生成夹具、Electron 用户配置或恢复钥匙备份。

没有公开源码、发布 Release、创建第三方登录或上传用户实际 Codex 数据。
