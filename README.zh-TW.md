# AgentVac

[简体中文](README.md) · [English](README.en.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

以保守方式整理 Codex 本機資料的桌面應用程式。先了解檔案分布，再預覽、隔離舊檔案，必要時還原至原位置。

- **空間分析**：區分日誌、工作階段與受保護檔案，逐項查看處理原因。
- **唯讀診斷**：分別統計 SQLite、附屬檔案與一般日誌。
- **隔離與還原**：先預覽再操作，保留批次紀錄，還原時不覆寫既有檔案。
- **淺色 / 深色佈景主題**：手動切換或跟隨系統。

本文件提供四種語言；**應用程式介面目前僅支援簡體中文**。AgentVac 並非 OpenAI 官方產品。

## 下載與安裝

目前版本：[v0.1.0](https://github.com/21888/AgentVac/releases/tag/v0.1.0)。使用預先建置的應用程式不需要另外安裝 Node.js。

| 平台                  | 下載                                                                                                                                          | 需求                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| macOS · Apple Silicon | [AgentVac-0.1.0-macos-arm64.dmg](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-macos-arm64.dmg)                   | macOS 13+，M 系列晶片        |
| macOS · Intel         | [AgentVac-0.1.0-macos-x64.dmg](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-macos-x64.dmg)                       | macOS 13+，Intel 處理器      |
| Windows               | [AgentVac-0.1.0-windows-x64-portable.exe](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-windows-x64-portable.exe) | Windows 10+，x64；可攜式版本 |
| Linux                 | [AgentVac-0.1.0-linux-x64.tar.gz](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-linux-x64.tar.gz)                 | 受支援的 Linux x64 桌面      |

下載後可對照 [SHA256SUMS.txt](https://github.com/21888/AgentVac/releases/download/v0.1.0/SHA256SUMS.txt) 驗證檔案。儲存庫若仍為私有，存取原始碼與下載需要具備權限的 GitHub 帳號。請使用仍有安全性更新的作業系統。

- **macOS**：選擇符合處理器架構的 DMG，開啟後將 AgentVac 拖入「應用程式」資料夾，再從該處啟動。
- **Windows**：儲存可攜式 EXE 後執行。本次提供的是可攜式啟動程式，不是安裝精靈。
- **Linux**：完整解壓縮 tar.gz，在正常桌面工作階段中執行內含的應用程式。相依套件請透過發行版的正式套件管理器安裝；系統垃圾桶需要可用的桌面 Trash 後端，缺少時操作會失敗並保留檔案。本版不提供 AppImage。

**目前 macOS 尚未完成 Developer ID 簽章與 Apple 公證，Windows 尚未完成 Authenticode 簽章。** Gatekeeper 或 SmartScreen 可能顯示警告或阻止啟動。請勿停用系統防護、Chromium sandbox 或 AppArmor 來略過警告。建置成功或壓縮檔完整，不代表一般首次啟動的系統信任驗證已完成；建議先使用示範資料。

## 介面預覽

以下為實際應用程式介面的測試截圖，使用**合成資料**。圖中容量是檔案邏輯大小，並非使用者實際用量、實際磁碟占用或可釋放空間。截圖用於展示介面，不能取代目前發行檔案的安裝、簽章與系統信任驗證。

### 空間分析 · 淺色

檔案分布、分類清單與逐項檢視器。

![AgentVac 淺色空間分析：檔案分布環形圖、分類清單與受保護檔案檢視器](docs/images/overview-light.png)

### 空間分析 · 深色

分別標示舊日誌候選項目與預設受保護的工作階段。

![AgentVac 深色空間分析：合成資料掃描結果、舊日誌候選項目與檔案清單](docs/images/overview-dark.png)

### 空間診斷

選擇檢查範圍，以唯讀方式查看 SQLite 相關檔案與一般日誌的大小。

![AgentVac 空間診斷：已選範圍、唯讀統計與分類大小](docs/images/space-diagnostics.png)

### 隔離紀錄與還原

依批次檢查已隔離檔案，再選擇還原或移至系統垃圾桶。

![AgentVac 隔離紀錄：三個示範日誌檔案及還原、移至系統垃圾桶操作](docs/images/quarantine-recovery.png)

## 第一次使用

以下保留目前介面的簡體中文按鈕名稱，並附上繁體中文說明。

1. **先試用示範。** 點選「体验演示扫描」（體驗示範掃描），練習預覽、隔離與還原。示範工作區會保留上次的操作狀態。
2. **選擇資料目錄。** 使用原生資料夾對話框選擇 Codex 資料根目錄，通常是使用者家目錄下的 `.codex`，也可能由 `CODEX_HOME` 自訂。請勿選擇專案目錄或磁碟根目錄；建議位置僅供參考，不會自動掃描。
3. **備份檔案與還原金鑰。** 先備份資料，再到「目录与恢复」（目錄與還原）選擇「导出恢复备份」（匯出還原備份）。備份含有敏感金鑰資料，應離線妥善保管，請勿上傳或分享；金鑰不能取代檔案備份。
4. **掃描並檢查預覽。** 預設保護最近 **30 天**的檔案。先選少量夠舊的輪替日誌，查看保護原因、掃描完整性與操作預覽。隔離真實資料前，請結束所有 Codex CLI / 桌面處理程序，並在應用程式中明確確認。
5. **嘗試還原。** 在「隔离记录」（隔離紀錄）還原剛才的批次。既有目標檔案不會被覆寫；若有衝突、檔案變更或上層目錄遺失，失敗項目會保留，處理後可重試。
6. **最後才考慮垃圾桶。** 確認批次不再需要後，才移至系統垃圾桶（Windows 為資源回收筒）。系統 API 失敗時會保留檔案，不改用永久刪除。

若 SQLite 或日誌位於其他目錄，可在「空间诊断」（空間診斷）主動新增位置、勾選範圍，再執行「只读统计」（唯讀統計）。設定中的路徑提示只有在主動啟用設定讀取後才會解析，也不會自動存取。

## 安全與保護範圍

**隔離不等於釋放磁碟空間。** 檔案會先移入所選目錄內的 `.agentvac-quarantine`；移至系統垃圾桶後通常仍占用磁碟。只有使用者在作業系統中清空垃圾桶後，才可能釋放空間，清空後無法還原。AgentVac 不提供永久刪除功能。

- **可複核的候選項目**：夠舊、只有單一硬連結的一般 `log/codex-tui.log` 輪替檔案（數字或日期後綴，可帶 `.gz`）。
- **工作階段預設受保護**：`sessions/**/*.jsonl` 與 `archived_sessions/**/*.jsonl` 需主動啟用複核後，才能選取符合條件的項目。舊工作階段仍可能使用中，移走檔案可能影響歷史紀錄與 resume。
- **一律保護**：目前日誌、憑證、設定、history、索引、state、SQLite 及其 WAL / SHM / Journal、快取、Skills、MCP、專案與未知檔案。不會展開受保護或未知目錄。
- **不跟隨連結**：符號連結、多重硬連結、特殊檔案與保護天數內的檔案皆不可隔離。
- **資料庫唯讀**：不壓縮、刪除或清理 SQLite，不執行 VACUUM、checkpoint 或模式轉換。深入檢查僅適用於符合嚴格前置條件的日誌資料庫，不符合時會拒絕檢查。

掃描預設最多存取 **50,000 個項目**，可改為 100,000；項目數包含目錄，另有深度 12 與結果預算 24 MiB 的限制。不完整掃描會明確標示並停用批次選取。每批最多 5,000 項。圖表與小計僅表示已找到的一般檔案之邏輯大小，不能視為整個目錄占用或可釋放量。

還原時也會核對檔案快照。清單通過金鑰驗證，不代表已逐位元組比較或以雜湊驗證檔案內容。跨磁碟區複製、更換電腦或從系統垃圾桶還原，可能改變檔案識別資訊，導致自動還原被拒絕；請保留完整批次與原始金鑰備份，不要手動修改清單來略過檢查。要從系統垃圾桶還原，請先透過作業系統將整個批次資料夾放回原 `.agentvac-quarantine/<批次ID>`，再由 AgentVac 驗證並還原至原位置。

## 隱私與執行限制

一般掃描只讀取檔案中繼資料，不讀取日誌或工作階段內容，也不上傳使用者檔案。主動啟用的設定路徑解析、唯讀資料庫結構與頁面狀態檢查，以及應用程式本身的還原金鑰與清單讀取，皆為獨立且受限的流程。AgentVac 不啟動或升級 Codex。

Renderer 沒有 Node 權限，並啟用 sandbox、context isolation 與 CSP。預覽僅在短時間內有效、只能使用一次，執行前會重新驗證；隔離使用同磁碟區移動，還原不覆寫既有檔案。

請勿以提升權限的方式執行、在不可信任使用者可寫入的目錄使用，或在 Codex 執行時整理資料。重複路徑檢查無法排除所有惡意競態，也無法保證突然斷電或磁碟故障時的資料一致性。重要資料仍需獨立備份。

## 從原始碼執行與建置

使用 Electron、Vue 3 與 TypeScript。需要 Node.js `^22.17.0` 或 `>=24.0.0` 及正常桌面工作階段；目前 `package-lock.json` 鎖定 Electron `44.5.1`，請使用 `npm ci` 安裝鎖定版本的相依套件。

```sh
npm ci
npm run dev

# 正式環境建置後啟動
npm run build
npm start
```

檢查命令：

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

桌面檢查需要目標作業系統的 GUI 與原生服務。測試使用產生的測試資料，不掃描真實 Codex 資料；瀏覽器或輔助處理程序測試不能取代最終發行檔案的原生驗證。

```sh
npm run dist:mac    # macOS arm64 / x64：DMG、ZIP 建置目標
npm run dist:win    # Windows x64：NSIS、portable EXE 建置目標
npm run dist:linux  # Linux x64：僅 tar.gz
npm run pack       # 目前平台尚未封裝成壓縮檔的應用程式目錄
```

以上為建置目標，實際發行檔案請以下載區為準。GitHub Actions 工作流程僅能手動觸發，不會隨原始碼或文件更新自動執行，也不會自動發布 Release。

`SOURCE-SHA256.json` 只涵蓋原始碼、測試、建置指令碼、設定與圖示，不涵蓋文件、截圖或發行檔案。發行檔案請使用下載區的 `SHA256SUMS.txt` 驗證。

## 授權條款

[MIT License](LICENSE)。第三方授權條款請見 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)；封裝保留 Electron / Chromium 等授權聲明。
