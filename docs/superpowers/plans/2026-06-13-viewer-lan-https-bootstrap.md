# Viewer LAN HTTPS Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Traditional Chinese, beginner-friendly Windows HTTPS manager plus an HTTP web bootstrap that distributes one self-contained client installer.

**Architecture:** A PowerShell module owns deterministic validation, Caddyfile generation, client installer generation, and system maintenance commands under `tools/viewer-https/`. Viewer Server exposes only a sanitized bootstrap JSON document and generated `.cmd` from `%ProgramData%\UE-Mat-Caddy`; a focused React gate replaces the normal app on insecure HTTP when HTTPS is ready.

**Tech Stack:** Windows PowerShell 5.1, Caddy, Node.js HTTP server, React, TypeScript, Vitest, happy-dom.

---

### Task 1: Testable PowerShell HTTPS Core

**Files:**
- Create: `tools/viewer-https/ViewerHttps.Core.psm1`
- Create: `tools/viewer-https/tests/ViewerHttps.Core.Tests.ps1`
- Create: `tools/viewer-https/templates/Caddyfile.template`
- Create: `tools/viewer-https/templates/ClientInstaller.cmd.template`

- [ ] Write PowerShell tests for IPv4/hostname validation, IP and hostname Caddyfile rendering, marked hosts-block replacement, and self-contained installer rendering.
- [ ] Run the test file and confirm it fails because the module does not exist.
- [ ] Implement pure functions `Test-ViewerHttpsIPv4`, `Test-ViewerHttpsHostname`, `New-ViewerHttpsCaddyfile`, `Set-ViewerHttpsHostsBlock`, and `New-ViewerHttpsClientInstaller` without changing system state.
- [ ] Re-run under Windows PowerShell 5.1 and confirm all tests pass.

### Task 2: Server Bootstrap API

**Files:**
- Create: `viewer/server/https-bootstrap.ts`
- Modify: `viewer/server/http-server.ts`
- Create: `viewer/tests/https-bootstrap.test.ts`

- [ ] Write failing tests proving absent state returns `{configured:false}`, valid state exposes only public fields, traversal/invalid installer paths are rejected, and the download response uses no-store/nosniff attachment headers.
- [ ] Run `viewer/node_modules/.bin/vitest.cmd run viewer/tests/https-bootstrap.test.ts` from repo root and confirm RED.
- [ ] Implement a small loader rooted at `%ProgramData%\UE-Mat-Caddy` with optional `UE_MAT_CADDY_HOME` override for tests.
- [ ] Add `/api/https-bootstrap` and `/api/https-bootstrap/installer` before the Team authentication gate so first-time members can use them.
- [ ] Re-run the targeted test and existing HTTP/auth tests.

### Task 3: HTTP Bootstrap UI

**Files:**
- Create: `viewer/web/src/HttpsBootstrap.tsx`
- Create: `viewer/web/src/https-bootstrap.css`
- Modify: `viewer/web/src/main.tsx`
- Create: `viewer/tests/https-bootstrap-ui.test.tsx`

- [ ] Write failing component tests for configured insecure HTTP, unconfigured HTTP, download action, retry navigation, and secure-context bypass.
- [ ] Run the React Vitest target and confirm RED.
- [ ] Implement `loadHttpsBootstrap`, `shouldShowHttpsBootstrap`, and the Traditional Chinese guidance component.
- [ ] Add a startup gate in `main.tsx`; failure to fetch bootstrap must fall back to the existing app.
- [ ] Re-run targeted React tests and the complete React test suite.

### Task 4: Beginner-Friendly Windows Manager

**Files:**
- Create: `tools/viewer-https/Manage-ViewerHttps.ps1`
- Create: `tools/viewer-https/README.zh-TW.md`
- Modify: `.gitignore` only if a repo-local dry-run output path is introduced
- Extend: `tools/viewer-https/tests/ViewerHttps.Core.Tests.ps1`

- [ ] Add failing dry-run tests for command dispatch, ProgramData layout, state JSON, scheduled-task command, firewall command, winget command, secure-cookie update, and uninstall preservation defaults.
- [ ] Implement `install`, `status`, `restart`, `update`, `change-address`, `export-cert`, and `uninstall`, plus an interactive Traditional Chinese menu.
- [ ] Require elevation only for mutating commands, validate Viewer HTTP before install, use `winget --source winget`, keep Caddy data persistent, and write all machine-specific outputs to `%ProgramData%\UE-Mat-Caddy`.
- [ ] Generate bootstrap state atomically only after Caddy/config validation; enable `Team.secureCookies` only after HTTPS health succeeds.
- [ ] Run all PowerShell tests under Windows PowerShell 5.1 and exercise `status` and `install -DryRun` without modifying the host.

### Task 5: Integration, Documentation, and Verification

**Files:**
- Modify: `deploy/README.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-13-viewer-lan-https-bootstrap-design.md` only if implementation requires an explicitly documented correction

- [ ] Document the new `tools/viewer-https/Manage-ViewerHttps.ps1` entrypoint and the member HTTP bootstrap flow.
- [ ] Run focused PowerShell, server, and React tests.
- [ ] Run `viewer/node_modules/.bin/vitest.cmd run` and `viewer/node_modules/.bin/vitest.cmd run --config viewer/vitest.react.config.ts` with paths adjusted from `viewer/` as needed.
- [ ] Run the Viewer TypeScript/web build using checked-in binaries if `pnpm` is unavailable.
- [ ] Run `git diff --check`, inspect `git status`, and confirm no `%ProgramData%` artifacts, certificates, private keys, or local config are tracked.
