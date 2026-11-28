# Báo cáo P0 Hotfix & Paseo 0.18.0 Runtime Acceptance

**Ngày:** 2026-11-28  
**Baseline:** `192982f` (báo cáo dừng deployment trước đó) · RC gốc `1009781faa2cd32743229f1aa392d649b2c624ba`  
**Kết luận tổng thể:** **PASS** — Đã tái hiện lỗi gốc, khắc phục tối thiểu lỗi load-time CJS/ESM tại [index.server.ts](../../index.server.ts), xác minh thành công directory install + reload + Preview trên **Paseo `0.18.0` cách ly**, và giữ nguyên cơ chế fail-closed (chặn Apply trên `0.18.0` và khi Relay ON).  
**Cam kết phạm vi:** **Chưa reload hay thay đổi daemon chính `~/.paseo`**, chưa tắt Relay, chưa enroll, chưa Apply, chưa mở rộng compatibility range cho `0.18.0`, chưa commit/push/tag, không chạm SLP, Kanbanly hay project thật (`giz`).

---

## 1. Root Cause Verification

- **Tái hiện lỗi trên Paseo `0.18.0` bundler cách ly:** Cài trực tiếp checkout hiện tại qua `paseo --home <temp> plugin install` tái hiện chính xác 100% lỗi trên daemon chính:
  ```text
  DaemonRpcError: Request failed: The "path" argument must be of type string or an instance of URL. Received undefined
  ```
- **Kiểm chứng thực nghiệm hành vi bundler của Paseo `0.18.0` (probe plugin cách ly):**
  - `import.meta.url`: `undefined`
  - `__dirname`: `undefined`
  - `__filename`: `undefined`
  - `process.cwd()`: trỏ tới thư mục làm việc của daemon (không phải plugin root)
  - `PluginServerContext` keys: `["addHook", "before", "handle", "notifications", "on", "registerProvider", "registerSettings", "registerUsageSource", "registerWorktreeManager"]` (không cung cấp `pluginDir`/`rootDir`)
  - `PluginHandlerContext` keys: `["paseo"]`
  - `process.env` liên quan Paseo: `PASEO_AGENT_CWD`, `PASEO_AGENT_ID`, `PASEO_CLI`, `PASEO_HOME`, `PASEO_NODE_ENV`, `PASEO_WORKSPACE_ID`
- **Audit toàn bộ runtime modules (`index.server.ts`, `index.client.tsx`, `server/`, `client/`, `shared/`):**
  - [index.server.ts](../../index.server.ts#L33) là **vị trí duy nhất** trong toàn bộ runtime code sử dụng `import.meta.url` / `fileURLToPath` / `__dirname` / `__filename` / `process.cwd()`.

---

## 2. Minimal Hotfix

- Thay thế biểu thức top-level throw tại [index.server.ts](../../index.server.ts) bằng hàm xuất `resolveDefaultPluginRoot(metaUrl?, dirnameValue?)`:
  - Không bao giờ throw khi khởi tạo module.
  - Không fallback sang `process.cwd()`.
  - Không giả định `__dirname` là source plugin root: chỉ khi `pluginRoot` xác định được **và** `readInstalledSdkVersions(pluginRoot)` xác minh được cả 3 gói `@getpaseo/{client,plugin,protocol}/package.json` (file thật, `O_NOFOLLOW`, đúng `uid`) thì mới đạt SDK check.
  - Khi chạy trong môi trường bundle không có đường dẫn module đáng tin cậy (như Paseo `0.18.0` hiện tại), trả `undefined` → `sdkVersions = []` → **fail-closed về Preview-only (`unsupported_sdk_version`)** mà vẫn nạp sạch toàn bộ tính năng read-only.
- Giữ nguyên toàn bộ kiến trúc Safe Apply, native writer (`185af502...`) và safety guarantees.

---

## 3. Real Runtime Acceptance trên Paseo `0.18.0` cách ly

Chạy bằng script release gate mới [scripts/smoke-main-plugin-install.mjs](../../scripts/smoke-main-plugin-install.mjs) trên daemon & project copy tạm (`relay.enabled: true`). Evidence JSON sạch: [paseo-018-runtime-acceptance.json](../evidence/m4p2/paseo-018-runtime-acceptance.json).

| Tiêu chí | Kết quả | Evidence thực tế |
| --- | --- | --- |
| **Real directory install (`paseo plugin install`)** | **PASS** | `paseo-project-skills` nạp cả server + client bundle thành công, `status: "running"`. |
| **Plugin reload (`paseo plugin reload`)** | **PASS** | Reload sạch, `status: "running"`, `pluginLogsClean: true` (0 lỗi load). |
| **Read-only RPCs & Preview cho 4 providers** | **PASS** | `foundation.status` → `ready`; `target.validate-directory` → `ready`; `preview.providers.v2` với `debug-regression` cho đủ 4 provider (`codex`, `cursor`, `antigravity` `canonical_only`; `kiro` `ready` với 2 derived entries). |
| **Apply fail-closed** | **PASS** | `apply.target-status.v1` trả `hostCompatible: false`, `trustBoundaryOk: false`, `reasons: ["unsupported_paseo_version", "unsupported_sdk_version", "remote_exposure_enabled"]`; gọi `apply.create.v1` bị chặn (`applyCreateBlocked: true`); `preview.providers.v2` trả `ineligible` (`write_capability_unavailable`). |
| **Zero target mutation** | **PASS** | Snapshot trước/sau của project copy khớp 100% (`targetUntouched: true`). |

---

## 4. Regression Tests & Verification

| Kiểm tra | Kết quả | Chi tiết |
| --- | --- | --- |
| **CJS/ESM Regression Test** | **PASS** | Bổ sung vào [tests/m4p2-main-plugin-release-gate.test.mjs](../../tests/m4p2-main-plugin-release-gate.test.mjs): kiểm chứng `resolveDefaultPluginRoot(undefined, undefined) === undefined`, invalid URL không throw, bundled dir thiếu `node_modules` fail-closed về Preview-only (`unsupported_sdk_version`). |
| **Real Directory-Install Smoke Gate** | **PASS** | [scripts/smoke-main-plugin-install.mjs](../../scripts/smoke-main-plugin-install.mjs) PASS trên Paseo `0.18.0` cách ly. |
| **Typecheck (`npm run typecheck`)** | **PASS** | `tsc --noEmit` — **0 lỗi**. |
| **Full Test Suite (`npm test`)** | **PASS** | **172/172 PASS** (171 cũ + 1 CJS/ESM regression test mới; 0 fail, 0 skipped). |
| **Native Helper Integrity** | **PASS** | SHA-256 `native/anchored-writer.m` (`185af502...`) khớp 100% `server/native/writer-payload.ts`. |
| **Paseo `0.17.5` / `smoke-local-rc.mjs`** | **N/A (Host đã nâng lên `0.18.0`)** | Binary Paseo `0.17.5` không còn tồn tại trên máy do Desktop tự cập nhật lên `0.18.0` (`stage-local-rc.mjs` cố ý khóa cứng `0.17.5`). Hành vi `0.17.5` tiếp tục được bảo phủ bởi bộ unit/integration tests trong `npm test` (172/172 PASS). |

---

## 5. Phân tích tương thích Paseo `0.18.0` (Chỉ phân tích — chưa mở Apply)

1. **SDK & RPC contract (`0.17.5` vs `0.18.0`):**
   - Toàn bộ RPC hiện dùng (`foundation.status`, `target.validate-directory`, `catalog.load`, `settings.catalog.*`, `preview.providers.v2`, `apply.target-status.v1`) chạy tương thích với `@getpaseo/{client,plugin,protocol}` `0.17.4` trên daemon `0.18.0`.
   - `paseo-plugin.json` bắt buộc có `requirements.paseo` (đã có sẵn trong repo).
2. **Caller Principal:**
   - **Chưa được bổ sung trong Paseo `0.18.0`.** Probe thực tế xác nhận `PluginHandlerContext` vẫn chỉ có `["paseo"]`. Mô hình **Single-user Local Host** (Relay fail-closed + out-of-band CLI enrollment) vẫn bắt buộc giữ nguyên.
3. **Relay, Runtime Config & Plugin Lifecycle:**
   - Cấu trúc `daemon.relay.enabled` và `daemon.listen` giữ nguyên; `checkDaemonTrustBoundary` hoạt động chính xác trên `0.18.0`.
   - `PASEO_CLI` và `PASEO_HOME` được truyền qua `process.env` cho plugin runtime.
   - **Điểm nghẽn quan trọng khi mở Apply trên `0.18.0`:** Vì Paseo bundle plugin không truyền `import.meta.url`, `__dirname`, `__filename` hay `server.pluginDir`, cơ chế đọc `node_modules/@getpaseo/*/package.json` lúc runtime sẽ luôn trả `unsupported_sdk_version` dưới bundler. Cần một cơ chế chứng thực phiên bản SDK ở build-time (tương tự `writer-payload.ts`, sinh từ `node_modules`/`package-lock.json` có kiểm tra hash) thay vì dựa vào đường dẫn file runtime.
4. **Thay đổi cần thiết để hỗ trợ chính thức Paseo `0.18.0` (milestone riêng sau khi duyệt):**
   - Bổ sung manifest phiên bản SDK sinh ở build-time (không phụ thuộc `import.meta.url`/`__dirname`).
   - Mở rộng dải tương thích trong `server/compatibility-policy.ts` và `native/anchored-writer.m` (`0.18.x`) rồi rebuild & `codesign` native writer.
   - Đánh giá nâng cấp `@getpaseo/{client,plugin,protocol}` nếu bản `0.18.x` có phát hành trên npm.
5. **Acceptance Tests đề xuất để mở Apply chính thức trên Paseo `0.18.0`:**
   - Chạy lại trọn bộ AT-1 → AT-6 trên daemon `0.18.0` cách ly với Relay OFF, gồm live Desktop UI Apply + `apply.status.v1` crash recovery + 4-provider discovery/read trace.

---

## 6. Stop Gate — Chờ User review trước khi reload `~/.paseo`

- **Danh sách file thay đổi chưa commit:**
  - `M` [index.server.ts](../../index.server.ts)
  - `M` [tests/m4p2-main-plugin-release-gate.test.mjs](../../tests/m4p2-main-plugin-release-gate.test.mjs)
  - `??` [scripts/smoke-main-plugin-install.mjs](../../scripts/smoke-main-plugin-install.mjs)
  - `??` [docs/evidence/m4p2/paseo-018-runtime-acceptance.json](../evidence/m4p2/paseo-018-runtime-acceptance.json)
  - `??` [docs/safe-apply-pilot/SAFE-APPLY-p0-hotfix-and-0.18-acceptance-report.md](SAFE-APPLY-p0-hotfix-and-0.18-acceptance-report.md)
- **Bước chờ phê duyệt:**
  1. Phê duyệt reload riêng `paseo-project-skills` trên daemon chính `~/.paseo` (sẽ khôi phục từ `failed` → `running` ở chế độ **Preview-only fail-closed**, giữ nguyên Relay ON, không ảnh hưởng SLP/Kanbanly).
  2. Phê duyệt commit hotfix + smoke gate + báo cáo này lên `main`.
