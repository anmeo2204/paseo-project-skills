# Báo cáo Nghiệm thu Production Deployment — DỪNG TẠI PRE-DEPLOYMENT (P0 Regression & Environment Drift)

**Ngày:** 2026-11-28  
**HEAD kiểm tra:** `40f5777ab469f182673931cf0a4718edd9c66d5f` (so với RC `1009781faa2cd32743229f1aa392d649b2c624ba`)  
**Kết luận tổng thể:** **NO-GO / DỪNG DEPLOYMENT** — Phát hiện **1 lỗi P0 load-time regression** trên real Paseo bundler và **1 environment drift** (`Paseo 0.17.5 → 0.18.0`) ngay tại bước Pre-deployment.  
**Cam kết trạng thái:** Đã dừng đúng quy tắc; **chưa reload `paseo-project-skills`, chưa sửa code, chưa thay đổi `~/.paseo` hay Relay, chưa enroll, chưa Apply, chưa commit/push/tag.**

---

## 1. Bảng kết quả từng tiêu chí Pre-deployment

| # | Tiêu chí | Kết quả | Evidence cụ thể |
| --- | --- | --- | --- |
| 1 | **Git HEAD & diff so với RC `1009781`** | **PASS** | `HEAD` = `origin/main` = `40f5777ab469f182673931cf0a4718edd9c66d5f`; working tree sạch. Chỉ có 1 commit sau RC (`40f5777`) bổ sung 1 file báo cáo `SAFE-APPLY-production-release-preflight-report.md`, **0 thay đổi runtime code**. |
| 2 | **Native helper integrity** | **PASS** | SHA-256 [native/anchored-writer.m](../../native/anchored-writer.m) (`185af5020e5b0baae0e8120c152348409c01123f5f144ef038fa4c4efc590dc4`) khớp 100% header [server/native/writer-payload.ts](../../server/native/writer-payload.ts). |
| 3 | **Rollback target khả dụng** | **PASS** | Commit Preview-only `af40e3074529a53be37380e24d946676c3022d52` hợp lệ trong Git history. |
| 4 | **Co-resident plugins & active agents** | **PASS** | `kanbanly`, `paseo-slp-orchestrator`, `paseo-kiro-usage` đều `status: "running"`; các agent/session hiện có không bị tác động. |
| 5 | **Relay & Enrollment baseline** | **PASS** | `relay.enabled: true` giữ nguyên; `enrollments.json` chưa tồn tại (`count: 0`, `roots: []`), `legacyPilotPolicyPresent: false`. |
| 6 | **Plugin `paseo-project-skills` load trên daemon thật** | **FAIL (P0)** | `paseo plugin ls --json` báo `status: "failed"`; `paseo plugin logs paseo-project-skills` báo lỗi load-time (xem Mục 2). |
| 7 | **Phiên bản Paseo daemon & CLI** | **DRIFT** | Paseo CLI và Daemon đã nâng cấp lên **`0.18.0`** (so với baseline `0.17.5` đã nghiệm thu tại M4.P2). |
| 8 | **Deployment (Reload) & Post-deployment UI Acceptance** | **SKIPPED (Dừng do Fail #6)** | Dừng theo quy tắc an toàn trước khi thực hiện reload. |

---

## 2. Phân tích Blocker & Environment Drift

### Blocker 1 (P0) — Load-time crash dưới CommonJS bundler của Paseo
- **Log thực tế từ `paseo plugin logs paseo-project-skills`:**
  ```text
  2026-11-27T15:59:47.137Z  stdout  [paseo] Loading plugin
  2026-11-27T15:59:51.887Z  stderr  [paseo] Plugin failed to load: The "path" argument must be of type string or an instance of URL. Received undefined
  ```
- **Nguyên nhân gốc tại [index.server.ts](../../index.server.ts#L33):**
  ```ts
  const defaultPluginRoot = dirname(fileURLToPath(import.meta.url));
  ```
  Unit tests chạy trực tiếp bằng Node ESM nên `import.meta.url` có giá trị hợp lệ, nhưng khi Paseo daemon thật bundle directory plugin sang CommonJS, `import.meta.url` trở thành `undefined` và `fileURLToPath(undefined)` throw ngay khi nạp module — làm sập toàn bộ plugin (bao gồm cả Preview-only).
- **Hướng khắc phục tối thiểu (chưa áp dụng, chờ phê duyệt):**
  - Giải quyết `defaultPluginRoot` an toàn cho cả CJS (`typeof __dirname === "string"`) lẫn ESM (`typeof import.meta?.url === "string"`), và không bao giờ throw ở module load (nếu không xác định được `pluginRoot`, `readInstalledSdkVersions` fail-closed về Preview-only).
  - Bổ sung kiểm thử directory install thật trên daemon tạm cách ly (để bắt mọi lỗi bundler CJS trước khi phát hành).

### Blocker 2 (Environment Drift) — Paseo đã nâng cấp từ `0.17.5` → `0.18.0`
- Cả Paseo CLI và Daemon trên `~/.paseo` hiện là **`0.18.0`** (`localDaemon: "running"`, `listen: "127.0.0.1:6767"`, `relay.enabled: true`).
- Theo chính sách M4.P2 (`0.17.5 <= v < 0.18.0`), ngay cả sau khi sửa lỗi load CJS, Safe Apply sẽ **fail-closed về Preview-only** với 2 lý do: `unsupported_paseo_version` và `remote_exposure_enabled`.
- Để mở **Production Apply** trên Paseo `0.18.0` trong tương lai, cần một lượt xác minh tương thích riêng cho Paseo `0.18.0` + SDK tương ứng.

---

## 3. Phương án xử lý đề xuất (Chờ User quyết định)

1. **Phương án A — Rollback ngay về Preview-only (`af40e30`):**
   - `git checkout af40e3074529a53be37380e24d946676c3022d52` và `paseo plugin reload paseo-project-skills` để khôi phục ngay plugin về `status: "running"` (Preview-only).
2. **Phương án B — Hotfix tối thiểu lỗi `import.meta.url` + kiểm thử directory install thật trên Paseo `0.18.0` cách ly:**
   - Sửa an toàn CJS/ESM tại [index.server.ts](../../index.server.ts#L33), chạy full `npm test` + kiểm thử load thật qua `paseo --home <temp> plugin install` trên `0.18.0`, sau đó mới xin phê duyệt reload lên `~/.paseo` ở chế độ **Preview-only fail-closed**.
3. **Bước tiếp theo cho Production Apply (sau khi khôi phục/deploy Preview-only ổn định):**
   - Chạy kiểm chứng tương thích chính thức cho **Paseo `0.18.0`** (cập nhật compatibility matrix & native writer gate nếu đạt) và thực hiện Production Apply Acceptance trên 1 project copy với Relay tắt trước khi xét bật cho project thật.
