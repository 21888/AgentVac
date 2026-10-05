# AgentVac 新版验证记录

更新：2026-10-04。本文区分已经运行的检查与尚未完成的发布验收。**目前不是三平台全部验收完成的交付声明。**

## 已完成的同源检查

| 层级                                            | 实际结果                                       | 证据                                                |
| ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Node 单元 / 真实临时文件 / 故障注入             | 167/167，通过，0 跳过                          | `next-unit-final.log`                               |
| Vue / Node TypeScript                           | 通过                                           | `next-typecheck-final.log`                          |
| Vite + Electron main/preload/独立 helpers       | 构建通过                                       | `next-final-build.log`                              |
| Electron 自带 Node 的诊断、进程隔离、审计测试   | 31/31，通过，0 跳过；不是原生窗口测试          | `next-electron-helper-tests.log`                    |
| 原有完整 UI 工作流                              | 29/29                                          | `e2e-results.json`、`next-e2e.log`                  |
| 键盘、焦点、重复点击、已移动后抛错              | 8 组通过                                       | `ux-focused/focused-results.json`                   |
| 300 / 5000 / 5001 项筛选、跨页批选边界          | 5 组通过                                       | `bulk-regression/results.json`                      |
| 实时进度、50k 部分 / 100k 完整重扫、取消 / 失败 | 3 组，14 个双主题状态                          | `scan-regression/results.json`、`audit-states.json` |
| 新目录、诊断、钥匙、救援、持久演示              | 6 组真实服务流程，32 个双主题状态；含 1000×700 | `app-data-regression/results.json`、`states.json`   |
| 原流程 axe 自动检查                             | 26 状态，0 违规，12 条跨状态 incomplete        | `accessibility-results.json`                        |
| 新服务页 axe 自动检查                           | 32 状态，0 违规，16 条跨状态 incomplete        | `app-data-regression/states.json`                   |

浏览器测试运行实际生产 Vue 界面、真实引擎和 AppDataServices，但文件夹选择和 Trash 使用仅限生成数据的适配器。它们不代替原生 Electron 窗口、预加载 IPC、系统对话框或实际系统回收站。axe 的 incomplete 原样保留；零自动违规不是 WCAG 认证或辅助技术用户验收。

## 本轮重点复验

- 生成 50,011 项并包含尾部 300 GiB 稀疏文件，50k 截断必须明确 `partial`，100k 重扫覆盖完整结果；24 MiB 返回体预算、遍历深度与权限受阻均可见。保护目录未展开，不冒充整盘总占用。
- UI 部分结果禁止表头和跨页批选；仍可显式逐项预览，带不完整警告。取消 / 根目录失效清除旧结果、旧选择；旧 request ID 不会取消或覆盖新请求。
- SQLite 深查只解析合成的白名单 `logs_2.sqlite`，原库内容哈希与元数据保持不变；旁路文件、未知进程或变动时放弃结果。
- SQLite 最终打开前将合成 DB 替换成 FIFO 的真实竞态，隔离进程可超时退出，主事件循环仍可响应。包括显式取消、父进程退出、异常输出、输出超限、重启以及实际 ASAR + 解包 helpers 路径检查。
- 恢复钥匙错文件、坏格式、链接、原子写失败、主钥匙缺失/替换均有测试。导入不会覆盖当前主钥匙；认证旧批次仍可恢复。只读救援区分“清单认证”与“数据正文验证”。
- 持久演示只使用自身认证的唯一目录；未知新增文件/链接会阻止重置。Trash 成功后报错必须刷新真实目录状态，不假称“未移动”。
- 已知故障前后清单、路径冲突、部分恢复、磁盘错误、假 Trash 成功、未知额外文件等回归继续通过。没有永久删除 fallback。

## 5000 项真实文件动作基准

脚本：`npm run test:performance`；结果：`performance/performance-results.json`。

本次生成 5000 个 32 MiB 稀疏文件，共 **156.25 GiB 逻辑大小**。实际分配空间单独记录，远小于逻辑大小；下列是当前文件系统的元数据操作时延，**不是 156 GiB 实体读写吞吐量或性能承诺**。

- 扫描：0.527 秒；预览：0.908 秒
- 隔离 5000 项：2.916 秒
- 重建引擎后读取全部历史：0.360 秒
- 丢失钥匙只读留存检查：0.188 秒，仍发现全部 5000 项
- 恢复 5000 项：1.989 秒
- 全部文件的 inode / device / size 与原记录一致；受保护标记内容不变。生成夹具在测试后清理。

## 原生与安装验收分界

旧基线真实 Linux x64 证据保存在 [`native-linux-baseline/README.md`](native-linux-baseline/README.md)，包括正常 sandbox 启用的桌面窗口、IPC、隔离恢复、偏好重启、原生选择器取消，以及真实 GIO Trash → 标准 XDG Trash 还原 → 应用恢复 → 三文件 SHA-256 一致。最初 Playwright 默认添加 `--no-sandbox` 的结果不计安全验收，报告保留了更正。

**旧基线结果不代替本次新增功能。** 本次新版已额外完成：

- Linux source 和真实 tar.gz 解包程序的 sandbox、隔离 preload/IPC、首屏签名状态、演示隔离恢复、偏好与唯一演示目录重启保留、单实例，以及真实 `shell.trashItem`。
- 6 个实际 GTK 对话框：目录取消/选择、恢复钥匙导出取消/保存、导入取消/导入自身备份。通过 CUA 观察及后续真实 IPC / 文件断言核实；不是捕获 native 返回对象或模拟文件夹选择。
- 新版 tar 应用的完整 3 文件标准系统 Trash 往返；官方 `trash-restore` 只还原本次精确批次，应用最终恢复后每个文件 SHA-256 一致。
- 实际检测到当前云环境正在运行的 Codex 进程，深查被正确拒绝，helper 启动数为 0，原始数据库不变。此环境没有绕过进程防护来声称原生深查成功。

证据位于 `native-linux-next/`。原生脚本的首次重启按钮等待和手工脚本末段未等待演示加载的时序错误分别保留在历史记录；修正脚本/独立续跑后通过，生产应用未为测试改动。以下仍是当前发布闸门：

1. 在没有 Codex 进程的授权测试环境复验原生 SQLite helper IPC、取消/关窗及无孤儿进程。目前组件测试通过，但本机整应用实际进程防护使这些项明确跳过。
2. macOS arm64 / x64、Windows x64 的原生执行与构建验证；Windows owned-process 清理机制需要真实 Windows CI。
3. AppImage/FUSE 启动和图形回收站还原。Linux tar.gz 解包启动、真实 GIO Trash 与标准命令行还原已通过，不能将其混称为 FUSE 或 GVfs 图形还原验收。
4. macOS Developer ID / 公证和 Windows Authenticode 当前没有完成。不得通过关闭系统安全机制绕过验证。
5. 最终源码/文档/产物版本快照和校验和封存。四目标内部验收包的运行资源、架构、归档与外置 helper 一致性已通过，见 [BUILD-REPORT](BUILD-REPORT.md)。

私有 CI 的授权不等于公开发布。测试不触碰实际 Codex 数据或用户凭据；不证明突然断电、坏盘、内核级路径事务或任意恶意并发下绝对安全。受限 Windows job 环境、父进程与 guardian 同时被外部强杀等生命周期边界见隔离模块说明。
