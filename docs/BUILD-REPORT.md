# 新版构建和归档核验

2026-10-04，当前开发源码在 Linux 主机上生成实际应用，不是空壳或配置占位符。以下构建不等于全部目标平台原生验收。

| 目标             | 生成物                                              | 大小（字节） |
| ---------------- | --------------------------------------------------- | -----------: |
| Linux x64        | `release-next/linux/AgentVac-0.1.0.AppImage`        |    125117305 |
| Linux x64        | `release-next/linux/agentvac-0.1.0.tar.gz`          |    121061399 |
| Windows x64 应用 | `release-next/windows/AgentVac 0.1.0.exe`           |     99385982 |
| macOS arm64      | `release-next/macos/AgentVac-0.1.0-macos-arm64.zip` |    130151137 |
| macOS x64        | `release-next/macos/AgentVac-0.1.0-macos-x64.zip`   |    134100846 |

精确大小与校验和应以最终产物和 `release-next/SHA256SUMS.txt` 为准；这些为内部验收产物，尚未正式发布。Windows 便携启动器本身是 NSIS 的 32 位引导器，内含的 Electron 应用明确为 x64，不支持 32 位 Windows。

## 完整性

- 四个目标的 `app.asar` SHA-256 完全一致：`ec9f7bc6c69bef717f869bd78df81629690206be02c0813f9f12e1d9048f7b29`。
- 每个目标的生产 JS、CSS、图标与被测试 `dist` / `dist-electron` 逐字节一致。SQLite supervisor/worker 被正确解包到 `app.asar.unpacked`，且内容与实际构建一致。
- 所有包保留应用、Electron、Chromium 的许可通知；检查了 ELF / PE / Mach-O 的实际 CPU 架构。
- Mac 两份 ZIP 全部 CRC 通过，每包 588 条归档项、14 条 Framework 符号链接保留。
- Windows NSIS 引导器中的嵌套 7z 完整性通过，79 个有效负载文件与 unpacked 应用逐文件一致。
- Linux tar.gz 全流读取并逐文件核对；AppImage 的 SquashFS payload 同样逐文件核对。各包含全部 79 个原始 Linux payload 文件。AppImage 尾部为构建器生成的 embedded block map，读取器的尾部警告已在证据中保留；这不是 FUSE 启动测试。

证据：`package-verification.json`、`macos-zip-verification.json`、`windows-portable-verification.json`、`linux-tar-verification.json`、`appimage-verification.json`。

## 安装和原生边界

新版 Linux tar.gz 已在真实桌面解包启动，证据位于 `native-linux-next/`。具体通过与跳过项以该目录最终报告和 [TEST-REPORT](TEST-REPORT.md) 为准。

macOS 和 Windows 目前是交叉构建与归档核验，不是已完成原生运行。没有 Apple Developer ID 签名/公证；Windows 主程序及便携启动器没有嵌入 Authenticode 证书。不能建议用户关闭系统安全保护来绕过这些限制。AppImage 的 FUSE 启动和图形回收站完整还原仍须单独验收。

## 可复现的构建环境说明

通常直接按 README 的构建命令在目标平台执行。此云环境默认家目录缓存只读，内部构建将 Electron 下载缓存和 builder 缓存显式指向工作区。builder 的临时 CommonJS 图标工具缓存必须放在本项目 `type: module` 范围之外，避免第三方工具 `.js` 被 Node 当作 ESM。这是构建环境参数，不改变应用源码或系统安全设置。
