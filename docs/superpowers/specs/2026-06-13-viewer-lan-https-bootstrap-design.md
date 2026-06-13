# Viewer 區域網 HTTPS 一鍵部署設計

## 目標

為 Windows 工作站上的 UE-Mat Viewer Team 模式提供新手友善的 HTTPS 部署與後續維護流程。管理員使用一個繁體中文 PowerShell 腳本完成 Caddy 安裝、憑證建立、開機自啟、防火牆、Viewer 設定及成員安裝器發佈；團隊成員從既有 HTTP 頁面下載並執行一個檔案即可完成信任設定。

成功標準：

- 管理員不需要手動編輯 Caddyfile、防火牆、排程工作或 Viewer JSON。
- 成員端只有「HTTP 頁面下載一個檔案、雙擊、同意 UAC」三個可見步驟。
- HTTPS 完成後，Chrome 將頁面視為安全上下文，`navigator.clipboard.writeText()` 可正常用於匯出 UE。
- Caddy 更新不得更換既有根 CA，避免要求所有成員重新安裝憑證。
- 所有操作、錯誤和修復建議使用繁體中文。

## 使用者流程

### 管理員首次安裝

管理員執行：

```powershell
.\tools\Manage-ViewerHttps.ps1
```

互動選單選擇「首次安裝」。腳本要求系統管理員權限，確認 Viewer 正在 `127.0.0.1:5790` 提供服務，然後讓使用者二選一：

1. 輸入 WLAN IPv4 位址。
2. 輸入自訂區域網主機名，並選擇或輸入對應 WLAN IPv4 位址。

腳本顯示最終 HTTPS 網址及將要執行的變更，取得一次確認後完成部署。只有在 HTTPS 實際驗證成功後，才將 `tools/node-t3d-metadata/local.config.json` 的 `Team.secureCookies` 設為 `true`。

### 成員首次進入

成員先開啟管理員分享的 HTTP 位址，例如：

```text
http://192.168.71.92:5790/
```

當頁面偵測到 Team HTTPS 已設定但目前連線不是安全上下文時，不進入一般 Viewer，而顯示繁體中文引導頁：

- 說明目前連線無法使用「匯出到 UE」。
- 顯示最終 HTTPS 網址。
- 主要按鈕：「下載並安裝 HTTPS」。
- 次要按鈕：「我已安裝，重新檢查」。
- 提醒安裝器來自區域網管理員，執行時會要求 Windows 系統管理員權限。

主要按鈕下載單一檔案：

```text
安裝UE-Mat-HTTPS.cmd
```

成員雙擊後接受 UAC。安裝器自動安裝根憑證；主機名模式下同步維護標記化的 `hosts` 記錄；驗證 HTTPS 後打開安全網址。成員不需要另外下載 `.crt`、ZIP 或 PowerShell 檔。

瀏覽器不能靜默修改 Windows 根信任庫，因此「下載、雙擊、接受 UAC」是網頁分發可安全達成的最少操作。

## 架構

### 管理腳本

新增 `tools/Manage-ViewerHttps.ps1`，同時支援互動選單與命令模式：

```powershell
.\tools\Manage-ViewerHttps.ps1 install
.\tools\Manage-ViewerHttps.ps1 status
.\tools\Manage-ViewerHttps.ps1 restart
.\tools\Manage-ViewerHttps.ps1 update
.\tools\Manage-ViewerHttps.ps1 change-address
.\tools\Manage-ViewerHttps.ps1 export-cert
.\tools\Manage-ViewerHttps.ps1 uninstall
```

腳本在需要變更系統狀態時自動以系統管理員權限重新啟動；`status` 保持唯讀且不強制提升權限。

### Caddy 執行方式

Caddy 由 Windows 排程工作以 `SYSTEM` 身分在開機時啟動，不加入 NSSM 或 WinSW 等額外依賴。排程工作執行 `caddy run`，使用固定設定與資料目錄：

```text
%ProgramData%\UE-Mat-Caddy\
├─ Caddyfile
├─ config.json
├─ data\
├─ logs\
└─ client\
```

腳本透過 `XDG_DATA_HOME` 與 `XDG_CONFIG_HOME` 將 Caddy CA 和自動儲存設定固定於上述目錄。排程工作、維護命令與匯出命令必須使用相同環境，避免因執行帳戶不同而產生第二套 CA。

Caddyfile 使用內部 CA，將 443 反向代理到 `127.0.0.1:5790`。Caddy 自動處理 WebSocket；Viewer 的 SSE 也經由同一代理傳輸。

### 安裝 Caddy

`install` 先尋找可用的 Caddy。若未安裝，使用非互動式 `winget` 安裝，固定來源為 `winget` 並接受必要協議。若 `winget` 不存在或安裝失敗，腳本停止並顯示可操作的繁體中文原因，不從未驗證網址下載執行檔。

`update` 使用相同套件來源更新 Caddy，保留 `%ProgramData%\UE-Mat-Caddy\data`。更新後先驗證設定，再重新啟動排程工作並測試 HTTPS。

### 單檔成員安裝器

管理腳本產生 `安裝UE-Mat-HTTPS.cmd`。檔案內嵌：

- Caddy 根憑證的 Base64 內容。
- 目標 HTTPS 網址。
- 部署模式、WLAN IP 及可選主機名。
- 憑證指紋和安裝器版本。
- 一段 Base64 編碼的繁體中文 PowerShell 安裝邏輯。

`.cmd` 先要求 UAC，再將內嵌資料交給 Windows PowerShell 5.1 執行。腳本使用暫存目錄解出根憑證，確認指紋後匯入 `LocalMachine\Root`，最後刪除暫存檔。

主機名模式只維護下列標記區塊，不修改其他 `hosts` 內容：

```text
# BEGIN UE-MAT HTTPS
192.168.71.92 ue-mat.local
# END UE-MAT HTTPS
```

重新執行安裝器是冪等的：更新同一標記區塊、跳過已存在且指紋相同的憑證，再次驗證並打開 HTTPS。

### Web 分發

Viewer Server 新增唯讀的公開 HTTPS bootstrap 狀態與下載端點。端點只暴露：

- HTTPS 是否已設定。
- 目標 HTTPS 網址。
- 安裝器版本和下載可用狀態。
- 產生完成的單檔安裝器。

端點不得暴露 Caddy 私鑰、根 CA 私鑰、Viewer 本機路徑、LLM 金鑰或其他設定。安裝器下載只在 Team 模式且 bootstrap 已完整產生時開放；回應使用附件下載、禁止快取及內容類型保護標頭。

Web App 啟動時讀取 bootstrap 狀態。如果 `window.isSecureContext` 為 `false` 且 HTTPS 已設定，則顯示安裝引導；如果 HTTPS 尚未設定，則保留目前 HTTP Team 登入流程，但明確提示管理員尚未部署 HTTPS。HTTPS 存取不顯示引導。

## 維護命令

### `status`

顯示：

- Caddy 是否安裝及版本。
- 排程工作狀態和最近結果。
- 80、443、5790 監聽狀態。
- 目前模式、WLAN IP、主機名和分享網址。
- 根憑證路徑、指紋和成員安裝器版本。
- Viewer HTTP、HTTPS 和 bootstrap 下載端點檢查結果。
- `Team.secureCookies` 是否與 HTTPS 狀態一致。

### `restart`

驗證 Caddyfile 後重新啟動排程工作，等待 443 監聽並執行 HTTPS 健康檢查。失敗時保留日誌路徑，並明確說明 Viewer 本身是否仍正常。

### `change-address`

重新進行 IP／主機名選擇，產生新 Caddyfile、網站憑證及成員安裝器。根 CA 保持不變。主機名或 IP 變更後，成員需要重新下載並執行新版安裝器；網頁依據安裝器版本提示更新。

### `export-cert`

重新產生單檔成員安裝器，並將一份副本輸出到使用者選擇的目錄。此命令不輸出根私鑰。

### `uninstall`

預設移除排程工作、防火牆規則、Caddy 設定和 Web bootstrap 狀態，並將 `Team.secureCookies` 還原為 `false`。預設保留 CA 資料，避免誤操作導致成員全部失效。只有再次明確確認後才刪除 CA 資料及伺服器本機信任；解除安裝 Caddy 程式本身也需要獨立確認，因為它可能被其他本機服務使用。

## 狀態與設定

`%ProgramData%\UE-Mat-Caddy\config.json` 儲存非機密部署狀態：模式、IP、主機名、HTTPS URL、Caddy 路徑、安裝器版本、根憑證指紋及 repo 路徑。私鑰僅由 Caddy 儲存在受限 data 目錄，絕不複製到 repo 或 Web 下載目錄。

repo 內只保留腳本、Web／Server 實作及測試。產生檔案放入 `tools/viewer-https/` 時必須加入 `.gitignore`；實際常駐資料以 `%ProgramData%` 為準。

## 安全策略

- 根 CA 私鑰絕不透過 HTTP、HTTPS 或成員安裝器分發。
- 安裝器只包含公開根憑證，並在匯入前校驗 SHA-256 指紋。
- HTTP 引導頁明確告知成員只應從受信任的內部 Viewer 位址下載安裝器。
- bootstrap 下載端點提供固定檔名、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。
- PowerShell 參數、主機名和 IP 在寫入命令或 Caddyfile 前進行嚴格驗證，不進行字串拼接執行。
- 防火牆規則僅開放 TCP 443 的 Private 設定檔；5790 的現有 Team 暴露不由本功能自動擴大。
- 只有 HTTPS 健康檢查成功後才啟用 Secure Cookie；解除安裝或部署失敗時保持或恢復 HTTP 可登入狀態。

## 錯誤處理與復原

每個寫入操作分為「準備、驗證、切換」三階段。新 Caddyfile 必須先通過 `caddy validate`；新安裝器必須能解析並匹配根憑證指紋；只有這些檢查通過才更新排程工作或 Viewer 設定。

安裝失敗時：

- 不啟用 `Secure cookie`。
- 不刪除現有可運作的 Caddy 設定。
- 顯示失敗階段、具體命令結果、日誌路徑及下一步建議。
- `status` 可在任何階段用於診斷。

成員安裝器失敗時保留 HTTP 頁面可存取，並給出憑證匯入、hosts 權限、HTTPS 連通性三類明確錯誤；不要求成員閱讀原始 PowerShell 堆疊。

## 測試與驗證

自動化測試涵蓋：

- 位址輸入驗證和 IP／主機名兩種 Caddyfile 產生流程。
- config.json 讀寫及升級相容性。
- 單檔 `.cmd` 產生、Base64 解碼、憑證指紋及 hosts 標記區塊冪等更新。
- bootstrap API 的公開欄位、下載標頭和私密資料防洩漏。
- HTTP／HTTPS 引導條件和下載按鈕行為。
- Secure Cookie 只在 HTTPS 驗證成功後啟用。
- `status`、`uninstall` 和失敗回復邏輯可透過相依性注入或 dry-run 測試，不實際改動測試機系統狀態。

Windows 實機驗證使用 Windows PowerShell 5.1：

1. 從未安裝狀態執行 `install`。
2. 驗證排程工作、443、防火牆、HTTPS 頁面、WebSocket 和剪貼簿。
3. 從 HTTP 頁面下載單檔安裝器，在第二個 Windows 使用者或測試機執行。
4. 驗證憑證、hosts、自動開啟 HTTPS 和重複執行冪等性。
5. 執行 `update`、`restart`、`change-address`、`export-cert`。
6. 分別驗證保留 CA 和刪除 CA 的解除安裝路徑。

PowerShell 腳本保持 Windows PowerShell 5.1 相容，並避免會在舊版編碼環境中造成解析問題的非 ASCII 語法字元；使用者可見文字仍為繁體中文，檔案以含 BOM 的 UTF-8 儲存以確保正確顯示。
