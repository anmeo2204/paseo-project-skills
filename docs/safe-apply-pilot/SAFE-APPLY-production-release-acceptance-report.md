# Production Release Acceptance Report — Safe Apply Create-only v1 (Paseo 0.18.0)

**Ngày:** 2026-11-28  
**Release Candidate:** `6ecc5a9c682f170345182d9e7414b4a5ec0f830b` (`main` === `origin/main`, không tạo commit trùng)  
**Trạng thái:** **PASS — PRODUCTION DEPLOYED (PREVIEW-ONLY FAIL-CLOSED DO RELAY ON). DỪNG CHỜ USER REVIEW.**  
**Cam kết phạm vi:** Chỉ reload riêng `paseo-project-skills` trên daemon chính `~/.paseo`. Không restart daemon, không sửa `~/.paseo/config.json`, giữ nguyên Relay ON, không reload SLP/Kanbanly/plugin khác, không enroll project thật, không Production Apply, chưa commit/push/tag tài liệu cập nhật.

---

## 1. Release Finalization & Integrity Verification

| Kiểm tra | Kết quả | Chi tiết |
| --- | --- | --- |
| **Git State (`HEAD` vs `origin/main`)** | **PASS** | `6ecc5a9c682f170345182d9e7414b4a5ec0f830b` khớp 100% `origin/main` trước khi cập nhật `README.md` |
| **Build-time SDK Manifest (`verify:sdk-manifest`)** | **PASS** | `manifestSha256: 58ae4e1ca46283720ef9f5cd7e8c9f357252ea97fd31a8f2fda503bcca047974`, `sdkVersion: 0.17.4` |
| **Native Helper Integrity** | **PASS** | `native/anchored-writer.m` SHA-256 `1e0351cc3ba9c806b75ca87c6db0cf7ec9524ebc17b282665b1119fccb7d92bd` khớp `server/native/writer-payload.ts` (`standard: 6324edff...`, `testing: 7c6668cf...`) |
| **Typecheck (`npm run typecheck`)** | **PASS** | `tsc --noEmit` — **0 lỗi** |
| **Full Test Suite (`npm test`)** | **PASS** | **172/172 PASS** (0 fail, 0 skipped) |
| **Real Directory-Install Smoke Gate** | **PASS** | [scripts/smoke-main-plugin-install.mjs](../../scripts/smoke-main-plugin-install.mjs) PASS trên Paseo `0.18.0` cách ly (`reasons: ["remote_exposure_enabled"]`) |

### Phạm vi Integrity thực tế của Build-time SDK Manifest
- **Build-time (`scripts/build-sdk-manifest.mjs`):** Xác minh exact semver pin trong `package.json`, khớp `version` và chuỗi SRI `integrity` (`sha512-...`) trong `package-lock.json`, đọc an toàn (`O_NOFOLLOW`, `nlink === 1`, đúng `uid`) `node_modules/@getpaseo/{client,plugin,protocol}/package.json` để xác minh `name`/`version` và tính `packageJsonSha256`, rồi ràng buộc với SHA-256 của `package.json`, `package-lock.json`, `paseo-plugin.json`, `native/anchored-writer.m`, và `writerArtifacts.{standard,testing}.sha256` qua `manifestSha256`.
- **Runtime (`verifyEmbeddedSdkManifest()`):** Xác minh schema, đủ 3 gói bắt buộc, định dạng SRI, chính sách semver (`0.17.4 <= v < 0.18.0`), toàn vẹn `manifestSha256`, và khớp `writerArtifacts.{standard,testing}.sha256` — hoạt động độc lập với `import.meta.url` / `__dirname` dưới bundler của Paseo `0.18.0`.
- **Giới hạn đã xác định rõ:** Không re-hash toàn bộ cây JS trong `node_modules` tại runtime (vì Paseo bundle plugin code vào bundle độc lập khi nạp).

---

## 2. README Consistency Updates

Đã cập nhật [README.md](../../README.md) ngắn gọn và nhất quán với implementation hiện tại (chưa commit, chờ duyệt):
- **Catalog and scope:** Tách rõ validation/catalog load là read-only; native folder picking ngoài phạm vi; create-only installation do Safe Apply opt-in đảm nhiệm.
- **Scan & Recommend in Desktop:** Nêu rõ scan/recommend/preview không ghi file; ghi chỉ xảy ra sau phê duyệt create-only trên target đã enroll.
- **Preview Changes in Desktop & M4.2 historical note:** Cập nhật Desktop sử dụng `preview.providers.v2`; làm rõ M4.2 trước đây là Preview-only, còn từ M4.P2/M4.P3 plugin chính trả `eligible`/`no_changes` khi đủ điều kiện và fail-closed ngược lại.
- **Compatibility Matrix:** Bảng phân biệt rõ **Policy-Supported** (`0.17.5 <= v < 0.18.0` & `0.18.0`; SDK `0.17.4 <= v < 0.18.0`; macOS `>= 14.0.0`) và **Runtime-Verified** (Paseo `0.17.5` M4.P2 & `0.18.0` M4.P3; SDK `0.17.4`; macOS `27.2.1` arm64 APFS), kèm phạm vi build-time SDK manifest.

---

## 3. Production Deployment & Post-deployment Acceptance (`~/.paseo`)

Đã chạy **duy nhất** `"/Applications/Paseo.app/Contents/Resources/bin/paseo" plugin reload paseo-project-skills` lúc `2026-11-28T02:39:45Z`.

| Hạng mục Acceptance | Kết quả | Evidence thực tế trên `~/.paseo` (`127.0.0.1:6767`) |
| --- | --- | --- |
| **Plugin `running` & runtime khớp M4.P3** | **PASS** | `paseo-project-skills` `status: "running"`, nạp tại `/Volumes/Work/alvenix/projects/paseo-project-skills` |
| **Không có load-time regression** | **PASS** | `02:39:45.059Z [paseo] Loading plugin` → `02:39:46.623Z [paseo] Plugin ready` (0 lỗi) |
| **Daemon không restart, Relay vẫn ON** | **PASS** | PID `6027` (`startedAt: 2026-11-27T15:59:44.800Z`), `daemonVersion: "0.18.0"`, `relay.enabled: true` |
| **Scan, Recommendation, Selection & Preview** | **PASS** | `foundation.status: ready`, `catalog.load: ready` (19 skills), `target.scan: ready`, `recommendation.evaluate: ready` (19 items), `preview.providers.v2: ready` (4 providers: Codex/Cursor/Antigravity `canonical_only`, Kiro `ready`) |
| **SDK Manifest được runtime chấp nhận** | **PASS** | Không còn `unsupported_sdk_version` trong `apply.target-status.v1` |
| **Paseo `0.18.0` được runtime chấp nhận** | **PASS** | Không còn `unsupported_paseo_version` trong `apply.target-status.v1` |
| **Apply chỉ còn bị chặn bởi Relay ở cấp host** | **PASS** | `apply.target-status.v1` trả `hostCompatible: false`, `trustBoundaryOk: false`, **`reasons: ["remote_exposure_enabled"]`**, `targetState: "host_unavailable"`; `apply.create.v1` bị chặn (`applyBlocked: true`) |
| **Enrollment state không đổi** | **PASS** | `enroll-project-skills.mjs list` → `count: 0`, `roots: []`, `enrolledCount: 0` |
| **SLP, Kanbanly & sessions không bị gián đoạn** | **PASS** | `kanbanly`, `paseo-slp-orchestrator`, `paseo-kiro-usage` đều `running`, không bị reload |

---

## 4. Quy trình Production Apply Acceptance trên 1 Project Thật (CHƯA THỰC HIỆN — Chờ phê duyệt riêng)

> **Lưu ý:** Toàn bộ bước dưới đây **chưa được chạy**. Chỉ thực hiện khi User chọn rõ 1 project thật, chấp nhận tắt Relay trong thời gian Apply, và phê duyệt chạy.

### Pha 0 — Chuẩn bị & Bảo vệ trước khi chạm Project
1. Chọn 1 project Git thật có working tree sạch (`git status` clean) và ghi nhận `git rev-parse HEAD` + snapshot `.agents/skills/` (nếu có).
2. Xác nhận không có agent/session nào đang chỉnh sửa thư mục `.agents/skills/` hoặc `.kiro/skills/` của project đó.

### Pha 1 — Bật Local-Only Trust Boundary & Enroll Out-of-Band
1. Tắt Relay tạm thời trong `~/.paseo/config.json` (`daemon.relay.enabled: false`), kiểm tra `daemon.listen` là loopback (`127.0.0.1:6767`), rồi reload riêng `paseo-project-skills`:
   ```sh
   PASEO="/Applications/Paseo.app/Contents/Resources/bin/paseo"
   "$PASEO" plugin reload paseo-project-skills
   ```
2. Enroll chính xác canonical root của project thật (không wildcard, không symlink):
   ```sh
   node --import ./tests/register.mjs scripts/enroll-project-skills.mjs enroll --root /abs/path/to/real-project
   node --import ./tests/register.mjs scripts/enroll-project-skills.mjs list
   ```
3. Xác nhận trên Paseo Desktop → **Project Skills**: banner cảnh báo Relay biến mất, target hiển thị `enrolled_enabled`.

### Pha 2 — Preview → Approve → Apply → Verify trên Paseo Desktop
1. Chọn project đã enroll, pin catalog tag/SHA mong muốn, chọn Target Providers, chạy **Scan & Recommend**.
2. Chọn bộ skills cần cài, bấm **Preview Changes**, kiểm tra kỹ toàn bộ file `Create` (`.agents/skills/<id>/*` và `.kiro/skills/<id>/*` nếu chọn Kiro), xác nhận 0 `Conflict` / `Blocked` và không chạm file có sẵn.
3. Bấm **Review create-only approval → Confirm create-only**, chờ `Completed` (`fsync_completed`) và lưu `operationId`.
4. Kiểm tra `git status` trên project thật (chỉ xuất hiện các file mới theo đúng plan, không sửa/xóa file cũ) và bấm **Preview Changes** lần hai xác nhận trả `No changes to approve.` (`no_changes`).

### Pha 3 — Khôi phục An toàn (Default Fail-Closed)
1. Nếu muốn quay về chế độ chỉ đọc/an toàn sau khi cài xong:
   - Tắt hoặc thu hồi enrollment: `node --import ./tests/register.mjs scripts/enroll-project-skills.mjs disable --root /abs/path/to/real-project` (hoặc `revoke`).
   - Bật lại `daemon.relay.enabled: true` trong `~/.paseo/config.json` (Safe Apply tự động fail-closed về Preview-only tức thì, trong khi `apply.status.v1` vẫn đọc được `operationId` cũ).

---

## 5. Stop Gate — Chờ User Review

- **Thay đổi chưa commit trên working tree:**
  - `M` [README.md](../../README.md)
  - `??` [docs/safe-apply-pilot/SAFE-APPLY-production-release-acceptance-report.md](SAFE-APPLY-production-release-acceptance-report.md)
- **Chờ phê duyệt của User:**
  1. Phê duyệt commit cập nhật `README.md` + báo cáo Production Release Acceptance này lên `main` (và gắn tag release nếu muốn).
  2. Quyết định thời điểm và project cụ thể nếu muốn triển khai **Production Apply Acceptance** theo quy trình ở Mục 4.
