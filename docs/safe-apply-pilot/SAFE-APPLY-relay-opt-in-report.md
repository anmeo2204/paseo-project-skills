# Báo cáo triển khai Phương án A — Out-of-Band Host Opt-in cho Paired Relay (`relay-policy`)

**Ngày:** 2026-11-28  
**Baseline:** `00101fc` (Production Release Acceptance)  
**Trạng thái:** **IMPLEMENTED & VERIFIED — CHỜ USER PHÊ DUYỆT BẬT TRÊN `~/.paseo` & COMMIT.**

---

## 1. Tóm tắt thiết kế (Giữ nguyên Default Fail-Closed)

- **Mặc định vẫn 100% fail-closed (`allowRelay: false`):** Nếu chủ máy không chủ động bật qua host CLI, Safe Apply tiếp tục chặn khi Relay ON (`remote_exposure_enabled`) y hệt M4.P3.
- **Lưu trữ an toàn out-of-band (không có RPC):** Trường tùy chọn `allowRelay?: boolean` lưu trong `~/.paseo/runtime/project-skills/enrollments.json` (tái sử dụng toàn bộ cơ chế khóa `O_NOFOLLOW`, `0o600`, `nlink === 1`, kiểm `uid`, private dir `0o700`, atomic write + `fsync` của [server/multi-root-policy.ts](../../server/multi-root-policy.ts)).
- **Các chốt an toàn KHÔNG thay đổi kể cả khi `allowRelay: true`:**
  - `daemon.listen` vẫn bắt buộc **loopback** (`127.0.0.1` / `localhost` / `::1`) — cấu hình `0.0.0.0` hoặc `remote.enabled: true` vẫn bị chặn (`remote_exposure_enabled`).
  - `config.json` hỏng / không xác minh được vẫn bị chặn (`trust_boundary_unverified`).
  - Mỗi project đích vẫn bắt buộc **enroll đích danh** qua host CLI.
  - Native writer vẫn chỉ **create-only** (`O_CREAT | O_EXCL`), không bao giờ ghi đè hay xóa file có sẵn.
  - Revoke tức thì: chạy `relay-policy --deny` khóa Apply ngay lập tức mà không cần reload plugin.

---

## 2. Danh sách thay đổi

| File | Nội dung |
| --- | --- |
| [server/multi-root-policy.ts](../../server/multi-root-policy.ts) | Thêm `allowRelay?: boolean` vào `multiRootPolicyFileSchema` (bảo toàn qua `enroll`/`enable`/`disable`/`revoke`); thêm `readHostRelayOptIn(daemonHome)` (fail-closed) và `setHostRelayOptIn(daemonHome, allowRelay)`. |
| [server/compatibility-policy.ts](../../server/compatibility-policy.ts) | Cập nhật `checkDaemonTrustBoundary` và `evaluateHostCompatibility` nhận `allowRelay?: boolean` (mặc định `false`); chỉ cho phép `relay.enabled: true` khi `allowRelay === true` trong khi vẫn chặn non-loopback `listen`, `remote.enabled: true`, và malformed config. |
| [index.server.ts](../../index.server.ts) | Đọc live `readHostRelayOptIn(daemonHome)` khi khởi tạo `compat`, `verifyTrust()`, và `createMultiRootApply({ checkTrustBoundary })`. |
| [scripts/enroll-project-skills.mjs](../../scripts/enroll-project-skills.mjs) | Thêm subcommand `relay-policy --allow \| --deny [--home <daemonHome>]`; hiển thị `allowRelay` trong lệnh `list`. |
| [tests/m4p2-main-plugin-release-gate.test.mjs](../../tests/m4p2-main-plugin-release-gate.test.mjs) | Bổ sung test end-to-end cho Phương án A: mặc định fail-closed, `relay-policy --allow` mở Apply trên Paseo `0.18.0` khi Relay ON cho root đã enroll, chặn unenrolled root, vẫn chặn `0.0.0.0` và `remote.enabled: true`, và `relay-policy --deny` khóa tức thì. |
| [README.md](../../README.md) | Cập nhật hướng dẫn `relay-policy --allow \| --deny` và trust boundary. |

---

## 3. Residual Risk (Minh bạch)

- Do Paseo `0.18.0` / SDK `0.17.4` chưa có `caller principal` trong `PluginHandlerContext`, khi bạn bật `relay-policy --allow`, **mọi thiết bị đã pair với daemon Paseo của bạn qua Relay** (ví dụ điện thoại 5G của bạn) đều có thể duyệt `apply.create.v1` lên các project đã enroll — cùng mức trust boundary với việc điện thoại của bạn hiện có thể chạy agent/terminal qua Relay.

---

## 4. Kết quả Kiểm chứng

- `npm run verify:sdk-manifest`: **PASS** (`manifestSha256: 58ae4e1ca46283720ef9f5cd7e8c9f357252ea97fd31a8f2fda503bcca047974`)
- `npm run typecheck`: **PASS** (0 lỗi)
- `npm test`: **PASS** (**173/173**, gồm test mới cho Phương án A)
- `node scripts/smoke-main-plugin-install.mjs`: **PASS** (xác nhận mặc định `allowRelay: false` vẫn fail-closed khi Relay ON trên Paseo `0.18.0` cách ly)

---

## 5. Bước tiếp theo (Chờ User phê duyệt)

Để dùng nút **Review create-only approval → Confirm create-only** ngay trên điện thoại 5G và Desktop khi Relay đang ON:
1. Bật opt-in trên `~/.paseo`:
   ```sh
   node --import ./tests/register.mjs scripts/enroll-project-skills.mjs relay-policy --allow
   ```
2. Reload riêng plugin chính:
   ```sh
   "/Applications/Paseo.app/Contents/Resources/bin/paseo" plugin reload paseo-project-skills
   ```
3. (Tùy chọn) Commit thay đổi Phương án A lên `main`.
4. Sau khi nghiệm thu xong trên `giz`, tắt nhanh bằng `relay-policy --deny` và/hoặc `disable --root /Volumes/Work/alvenix/projects/giz`.
