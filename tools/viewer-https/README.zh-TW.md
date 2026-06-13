# UE-Mat Viewer HTTPS 管理工具

此工具供 Windows 管理員為 Team 模式部署 Caddy HTTPS。第一次使用不需要開 PowerShell：

1. 開啟 `tools\viewer-https`。
2. 雙擊 `Manage-ViewerHttps.bat`。
3. 同意 Windows 系統管理員權限。
4. 選擇 `1`，再輸入 WLAN IP 或自訂主機名。

BAT 會保持結果視窗開啟；完成或失敗後，確認畫面訊息再按任意鍵關閉。

需要自動化或進階維護時，也可以直接執行：

```powershell
.\tools\viewer-https\Manage-ViewerHttps.ps1
```

腳本會顯示繁體中文選單，並在需要時要求 Windows 系統管理員權限。

安裝過程會顯示 `[1/8]` 到 `[8/8]`。首次下載 Caddy 可能需要數分鐘，畫面會明確顯示目前階段，不需要重複點擊或關閉視窗。

如果舊版首次安裝曾停在輸入 IP 之後，直接重新雙擊 BAT 並再次選擇 `1`。新版會辨識並覆寫未完成的 Caddy runner；也可先選擇 `2` 查看狀態，`partialInstall: True` 代表需要重新執行選項 `1`。

## 常用命令

```powershell
.\tools\viewer-https\Manage-ViewerHttps.ps1 install
.\tools\viewer-https\Manage-ViewerHttps.ps1 status
.\tools\viewer-https\Manage-ViewerHttps.ps1 restart
.\tools\viewer-https\Manage-ViewerHttps.ps1 update
.\tools\viewer-https\Manage-ViewerHttps.ps1 change-address
.\tools\viewer-https\Manage-ViewerHttps.ps1 export-cert
.\tools\viewer-https\Manage-ViewerHttps.ps1 uninstall
```

安裝時可選擇 WLAN IP 或自訂主機名。使用主機名時，成員安裝器會自動維護 Windows `hosts` 記錄。

所有機器專屬資料保存在 `%ProgramData%\UE-Mat-Caddy`，包括 Caddy 設定、CA、日誌及網頁提供下載的成員安裝器。根 CA 私鑰不會放入 repo 或成員安裝器。

## 成員端

成員先開啟原本的 HTTP Team 網址。頁面會提示下載 `Install-UE-Mat-HTTPS.cmd`。成員只需：

1. 下載安裝器。
2. 雙擊執行。
3. 同意 Windows 系統管理員權限。

安裝器會安裝公開根憑證、設定主機名解析（若需要），並自動開啟 HTTPS 網址。

## 安全解除安裝

一般 `uninstall` 預設保留 CA 與 Caddy 程式，以免其他服務或現有成員突然失效。只有明確加入 `-RemoveCa` 或 `-UninstallCaddy` 才會移除它們。

## DryRun

要先預覽操作而不修改防火牆、排程工作或軟體，可執行：

```powershell
.\tools\viewer-https\Manage-ViewerHttps.ps1 install -DryRun -AddressMode ip -Address 192.168.71.92
```
