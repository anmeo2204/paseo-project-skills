# Final M4 Acceptance Report — Production Relay Apply Acceptance (Paseo 0.18.0)

**Ngày:** 2026-11-28  
**Baseline:** `2b8ddb03a7b2c1384e12f33bd87322d4edfce9eb` (Out-of-Band Host Relay Opt-in)  
**Target thực tế:** `/Volumes/Work/alvenix/projects/giz` (branch `giz`, `HEAD 89c89de6c7656bf79a832d35330d1f14456ff3f2`)  
**Kết luận tổng thể:** **PASS — FINAL M4 GATE HOÀN TẤT 100% (BAO GỒM LIVE APPLY TỪ ĐIỆN THOẠI QUA RELAY/5G, 4/4 PROVIDERS DISCOVERY/READ TRACES, VÀ KHÓA LẠI FAIL-CLOSED MẶC ĐỊNH).**

---

## 1. Tóm tắt Nghiệm thu thực tế qua Relay/5G trên Project `giz`

1. **Pre-flight & Isolated Policy Verification:**
   - Xác minh `HEAD === origin/main` (`2b8ddb0`), `verify:sdk-manifest` PASS (`58ae4e1c...`), native writer SHA-256 `1e0351cc...`.
   - Kiểm thử đầy đủ 5 kịch bản trên daemon Paseo `0.18.0` cách ly: Relay ON + `allowRelay: false` (blocked), Relay ON + `allowRelay: true` + unenrolled (ineligible), Relay ON + `allowRelay: true` + enrolled (eligible), `relay-policy --deny` (thu hồi tức thì pre-admission receipt `receipt_invalid`), policy malformed & mode `0644` (`unsafe_policy_file` fail-closed).
2. **Phát hiện & khắc phục bug thực tế trên Paseo Mobile (React Native):**
   - Lần bấm Apply đầu tiên từ điện thoại gặp `tracking_unavailable` (*"Could not save the operation for recovery. No request was sent."*) do `globalThis.localStorage` không tồn tại trên React Native — cơ chế fail-closed đã không gửi request và giữ nguyên `giz` sạch 100%.
   - Bổ sung `resolveClientProfileStorage()` tại [index.client.tsx](../../index.client.tsx) dùng session memory storage khi `globalThis.localStorage` không tồn tại (Desktop/Web vẫn giữ `localStorage` nghiêm ngặt như cũ), thêm regression test tại [tests/m4p2-main-plugin-release-gate.test.mjs](../../tests/m4p2-main-plugin-release-gate.test.mjs) (**173/173 PASS**, `tsc --noEmit` 0 lỗi), và reload riêng `paseo-project-skills`.
3. **Live Apply thực tế từ điện thoại qua Relay/5G (giữ nguyên Relay ON):**
   - User mở **Project Skills** trên điện thoại (5G), chọn `giz`, chọn 4 providers (`codex`, `cursor`, `antigravity`, `kiro`), chọn bộ 8 recommended skills (`debug-regression`, `implement-change`, `laravel-background-job`, `laravel-data-change`, `laravel-feature-change`, `react-ui-change`, `review-change`, `verify-change`), bấm **Preview → Review create-only approval → Confirm create-only**.
   - **Operation ID:** `1daaa5fe505a75c96ce77fd3e90a10a7`
   - **Kết quả journal:** `phase: "completed"`, `code: "none"`, `durability: "fsync_completed"`, `targetMutated: true`, `ledgerCount: 62` (**60 `created_verified` + 2 `unchanged_verified`** cho `.agents/skills/debug-regression/*`).

---

## 2. Bảng Kết quả Acceptance Criteria (PASS / FAIL)

| Acceptance Criterion | Kết quả | Evidence thực tế |
| --- | --- | --- |
| **Isolated Paseo `0.18.0` `allowRelay` policy matrix (5/5 cases)** | **PASS** | Default deny, unenrolled blocked, enrolled eligible, `--deny` revokes pre-admission receipt, malformed/0644 fail-closed |
| **Live Apply từ điện thoại qua Relay/5G (giữ Relay ON)** | **PASS** | `operationId: 1daaa5fe505a75c96ce77fd3e90a10a7`, `phase: "completed"`, `durability: "fsync_completed"`, 60 created + 2 unchanged |
| **Existing files preservation (9/9 baseline files trên `giz`)** | **PASS** | Toàn bộ 9 file cũ (`.gitignore`, `debug-regression/*`, `geeks-portal-frontend/SKILL.md`, `slp-manager/**`) giữ nguyên **100% inode & SHA-256**; 0 file tracked bị sửa/xóa |
| **Preview lần hai trả `no_changes`** | **PASS** | `preview.providers.v2` trả `applyEligibility: { status: "no_changes" }`, 23 canonical + 23 Kiro derived đều `unchanged` |
| **Native Discovery & Read Verification (4/4 Providers trên `giz`)** | **PASS** | • **Codex** (`0.167.0`): `discovered: true`, `readToolMatched: true`<br>• **Kiro ACP** (`2.34.2`, `kiro_default`): `Reading SKILL.md:1` (`completed`), trả `"Verify Change"`<br>• **Cursor ACP** (`2026.10.22-27dcf5f`, `ask`): `Read .agents/skills/verify-change/SKILL.md`, trả `"Verify Change"`<br>• **Antigravity ACP** (`1.5.18`, `plan`): `File .agents/skills/verify-change/SKILL.md` (`completed`), trả `"Verify Change"` |
| **Post-acceptance Lockdown (`relay-policy --deny` + `disable`)** | **PASS** | `allowRelay: false`, `giz` `enabled: false`, reload riêng `paseo-project-skills` |
| **Apply bị khóa fail-closed & `apply.status.v1` vẫn đọc được** | **PASS** | `apply.target-status.v1` trả `hostCompatible: false`, `trustBoundaryOk: false`, `reasons: ["remote_exposure_enabled"]`, `enrolledCount: 0`; `apply.create.v1` bị chặn (`applyBlocked: true`); `apply.status.v1` vẫn đọc được `1daaa5fe505a75c96ce77fd3e90a10a7` (`completed` / `fsync_completed`) |
| **Relay vẫn ON & SLP/Kanbanly không bị gián đoạn** | **PASS** | Daemon PID `8357` không restart, `relay.enabled: true`, `kanbanly` / `paseo-slp-orchestrator` / `paseo-kiro-usage` / `paseo-project-skills` đều `running` |

---

## 3. Thay đổi chưa commit (Chờ phê duyệt)

- `M` [index.client.tsx](../../index.client.tsx) — React Native mobile `localStorage` fallback (`resolveClientProfileStorage`) để Apply hoạt động sạch trên Paseo Mobile.
- `M` [tests/m4p2-main-plugin-release-gate.test.mjs](../../tests/m4p2-main-plugin-release-gate.test.mjs) — Regression test cho React Native mobile storage fallback (**173/173 PASS**).
- `??` [docs/safe-apply-pilot/FINAL-M4-production-relay-apply-acceptance-report.md](FINAL-M4-production-relay-apply-acceptance-report.md) — Báo cáo này.

**Stop Gate:** Chưa commit/push/tag. Mời User review để phê duyệt commit bản fix mobile + Final M4 Acceptance Report và đóng Milestone **M4 (Safe Apply Create-only v1)**.
