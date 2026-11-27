# Báo cáo Production Release Preflight — Safe Apply Create-Only v1

**Ngày:** 2026-11-27  
**Release Candidate:** `1009781faa2cd32743229f1aa392d649b2c624ba` (`main` = `origin/main`, working tree sạch trước khi xuất báo cáo)  
**Trạng thái thực hiện:** **CHỈ ĐỌC (Preflight).** Chưa reload daemon chính `~/.paseo`, chưa thay đổi Relay hay cấu hình daemon, chưa enroll project thật, chưa Apply, chưa commit/push/tag.

---

## Quyết định tổng thể: **GO CÓ ĐIỀU KIỆN (CONDITIONAL GO)**

- **GO cho triển khai / reload plugin `paseo-project-skills` (`1009781`) lên daemon chính `~/.paseo`:**
  - Mọi kiểm tra mã nguồn, native helper integrity, compatibility policy, full regression suite (**171/171 PASS**) và Local RC smoke đều **PASS**.
  - Do `~/.paseo` hiện đang bật **Relay (`relay.enabled: true`)**, sau khi reload, plugin sẽ chạy an toàn ở chế độ **Preview-only fail-closed** (`apply.create.v1` không được đăng ký; UI hiển thị rõ lý do Relay đang bật) — không có rủi ro tự mở quyền ghi.
- **Điều kiện bắt buộc để thực hiện Apply trên daemon chính (khi người dùng có nhu cầu cài Skill):**
  - Phải **tắt Relay** trong cấu hình Paseo (chuyển về Single-user Local Host loopback) **và** reload plugin, sau đó **enroll tường minh** đúng project root bằng CLI out-of-band.
  - Nếu muốn **giữ Relay luôn bật** trên daemon chính `~/.paseo`, Safe Apply sẽ giữ nguyên trạng thái **Preview-only** trên `~/.paseo` (đúng thiết kế fail-closed); khi đó có thể cài Skill bằng cửa sổ tắt Relay tạm thời hoặc dùng profile/daemon cách ly như Pilot.

---

## 1. Xác minh Git, Release Artifact & Full Regression Suite

| Hạng mục | Kết quả | Chi tiết |
| --- | --- | --- |
| **Git HEAD & Remote** | **PASS** | `HEAD` = `origin/main` = `1009781faa2cd32743229f1aa392d649b2c624ba` (*"Add create-only Safe Apply to main plugin"*). Không cần tạo commit trùng cho M4.P2. |
| **Native Helper Integrity** | **PASS** | SHA-256 [native/anchored-writer.m](../../native/anchored-writer.m) (`185af5020e5b0baae0e8120c152348409c01123f5f144ef038fa4c4efc590dc4`) khớp 100% header [server/native/writer-payload.ts](../../server/native/writer-payload.ts). `verifyEmbeddedHelperIntegrity(false)` PASS (`138501ce...`), `testing` PASS (`0d27351d...`). |
| **Typecheck** | **PASS** | `npm run typecheck` (`tsc --noEmit`) — **0 lỗi**. |
| **Full Test Suite** | **PASS** | `npm test` — **171/171 PASS** (0 fail, 0 skipped), gồm Scan, Recommendation, Canonical Preview, Provider Adapters, Single-Project Pilot, M4.P1 (AT-1/2/3/5) và M4.P2 (AT-4/UI/Main Entrypoint). |
| **Local RC Smoke** | **PASS** | `node scripts/smoke-local-rc.mjs` — **PASS**. |

---

## 2. Kiểm tra chỉ đọc Daemon chính (`~/.paseo`)

| Thông số | Giá trị thực tế trên `~/.paseo` | Đánh giá Compatibility Policy (`m4.p2-v1`) |
| --- | --- | --- |
| **Paseo CLI & Daemon** | `0.17.5` (`localDaemon: "running"`, `desktopManaged: true`, `connectedDaemon: "reachable"`) | **ĐẠT** (`0.17.5 <= v < 0.18.0`) |
| **Paseo SDK** | `@getpaseo/{client,plugin,protocol}` = `0.17.4` | **ĐẠT** (`0.17.4 <= v < 0.18.0`) |
| **OS / Arch / Helper** | macOS arm64, local APFS case-insensitive, native helper integrity `ok: true` | **ĐẠT** |
| **Plugin Installation Source** | `paseo-project-skills`: **directory install** trỏ trực tiếp tới checkout hiện tại (`enabled: true`, `status: "running"`) | **ĐẠT** (reload trực tiếp đúng commit `1009781`) |
| **Co-resident Plugins** | `paseo-slp-orchestrator` (`running`), `kanbanly` (`running`), `paseo-kiro-usage` (`running`) | **Độc lập** — `plugin reload paseo-project-skills` chỉ reload đúng 1 plugin, không restart daemon, không ảnh hưởng SLP, Kanbanly hay agent đang hoạt động |
| **Effective Runtime Config** | `listen: "127.0.0.1:6767"` (loopback), `extraListeners: []`, `tailscale.state: "off"` | Loopback **ĐẠT** |
| **Relay / Remote Exposure** | **`relay.enabled: true`** (`relay.paseo.sh:443`, TLS) | **FAIL-CLOSED (`remote_exposure_enabled`)** — giữ nguyên theo yêu cầu; Safe Apply tự khóa về **Preview-only** |
| **Enrollment State** | `enrollments.json` chưa tồn tại (`count: 0`, `roots: []`), `legacyPilotPolicyPresent: false`, `autoMigrated: false` | **Preview-only mặc định** |

Kết quả thực tế từ `evaluateHostCompatibility()` trên `~/.paseo`:

```json
{
  "compatible": false,
  "policyVersion": "m4.p2-v1",
  "reasons": ["remote_exposure_enabled"]
}
```

---

## 3. Residual Risks & Giới hạn Single-user Local Host

1. **Thiếu Caller Principal trong Paseo SDK `0.17.4`:**
   - Approval receipt chỉ bind `planDigest`, target root identity và `policyRevision` — **không** phải bằng chứng mật mã xác thực danh tính người bấm Confirm trên UI.
   - Mọi tiến trình local cùng user có quyền gọi RPC trên daemon được xem là cùng trust boundary; do đó Relay/remote exposure **bắt buộc** fail-closed và enrollment **chỉ** thực hiện out-of-band qua host CLI.
2. **Thay đổi Relay hoặc Enrollment Policy sau Admission ACK:**
   - **Trước Admission ACK:** mọi thay đổi Relay hoặc disable/revoke/rotate policy chặn Apply ngay lập tức (`receipt_invalid` / `unsupported_environment`), `targetMutated: false`.
   - **Sau Admission ACK (native writer đang ghi):** lượt ghi single-use đã được cấp phép sẽ chạy nốt hoặc dừng theo guard filesystem (`O_CREAT|O_EXCL`, `linkage()`); mọi request Preview/Apply **mới** bị chặn ngay lập tức; `apply.status.v1` **vẫn đọc được chỉ đọc** để đối soát/recovery ngay cả sau khi bật lại Relay hoặc tắt enrollment.
3. **Cửa sổ kernel race khi move thư mục gốc:** nếu thư mục gốc bị rename giữa lần kiểm `linkage()` cuối và `openat`/`mkdirat`, tối đa 1 entry có thể được tạo trong thư mục cũ trước khi helper dừng với `linkage_changed` (thư mục thay thế không bị ghi).
4. **Create-only không auto-rollback & chưa có Skill Update:** crash/ENOSPC để lại file `0600` dở cần dọn thủ công theo ledger; file đã tồn tại khác nội dung sẽ báo `conflict` và chặn toàn bộ plan.
5. **Giới hạn phạm vi nền tảng:** chỉ hỗ trợ macOS arm64 + local APFS case-insensitive + Paseo `0.17.5..0.17.x` + SDK `0.17.4..0.17.x`.

---

## 4. Phương án Nâng cấp Plugin chính & Rollback Plan

### A. Phương án nâng cấp (chỉ thực hiện sau khi User phê duyệt)

1. Xác nhận `HEAD` là `1009781` và reload riêng `paseo-project-skills`:
   ```sh
   PASEO="/Applications/Paseo.app/Contents/Resources/bin/paseo"
   "$PASEO" plugin reload paseo-project-skills
   "$PASEO" plugin ls --json
   "$PASEO" plugin logs paseo-project-skills
   ```
2. Xác minh hậu kiểm trên daemon chính:
   - `paseo-project-skills`, `paseo-slp-orchestrator`, `kanbanly` đều ở trạng thái `running`.
   - Mở **Project Skills** trên Desktop → xác nhận banner **Preview-only (Relay / remote exposure enabled)** hiển thị rõ ràng, Scan & Preview hoạt động bình thường, không có nút Apply.

### B. Rollback Plan về Preview-only trước đó

- **Tắt nhanh quyền ghi tức thì (không cần đổi code hay reload):**
  - Bật lại Relay (mặc định hiện đã bật), hoặc chạy `disable` / `revoke` cho từng root qua [scripts/enroll-project-skills.mjs](../../scripts/enroll-project-skills.mjs).
- **Rollback code hoàn toàn về bản M4.P1 (entrypoint chính thuần Preview-only):**
  ```sh
  git checkout af40e3074529a53be37380e24d946676c3022d52
  "/Applications/Paseo.app/Contents/Resources/bin/paseo" plugin reload paseo-project-skills
  ```
  (Hoặc `git revert 1009781faa2cd32743229f1aa392d649b2c624ba` trên `main` rồi chạy `plugin reload paseo-project-skills`.)

---

## 5. Quy trình vận hành ngắn gọn khi người dùng cần cài Skill

1. **Khi chỉ cần xem / đánh giá:** giữ nguyên cấu hình hiện tại (Relay ON) → dùng **Select Project → Scan → Recommend → Preview** bình thường ở chế độ Preview-only.
2. **Khi cần cài Skill (create-only):**
   - Tạm tắt Relay trong Paseo (local loopback only) và chạy `paseo plugin reload paseo-project-skills` (nếu daemon vừa khởi động với Relay ON).
   - Enroll đúng project cần cài qua host CLI:
     ```sh
     node --import ./tests/register.mjs scripts/enroll-project-skills.mjs enroll --root /abs/path/to/project
     ```
   - Trên Desktop: **Select Project → Scan → Recommend → Select Skills & Providers → Preview → Review create-only approval → Confirm create-only → Verify** (`Completed`, `fsync_completed`, Preview lần 2 báo `no_changes`).
   - Sau khi cài xong: chạy `disable` (hoặc `revoke`) cho project đó và bật lại Relay nếu cần. Nếu có `partial_failure` / `recovery_required`, giữ `operationId` để kiểm tra qua `apply.status.v1`, dọn file dở thủ công rồi mới Preview lại.

---

## 6. Chờ phê duyệt Deployment

- Phê duyệt thực hiện **Bước 4A** (`paseo plugin reload paseo-project-skills` trên `~/.paseo`, giữ nguyên Relay → Preview-only fail-closed).
- (Tùy chọn) Phê duyệt commit báo cáo preflight này và/hoặc tạo Git tag release (ví dụ `v0.2.0-safe-apply-v1`).
