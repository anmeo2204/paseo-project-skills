# Báo cáo nghiệm thu cuối cùng — Safe Apply Pilot giới hạn trên `giz`

**Ngày:** 2026-11-27  
**Kết luận tổng thể:** **PASS (10/10 tiêu chí đạt)** cho lượt Safe Apply Pilot giới hạn (`giz` · `debug-regression` · `Codex` · profile & daemon tạm riêng).  
**Cam kết phạm vi:** Daemon chính `~/.paseo`, safety guard, native writer, SLP và Kanbanly **không thay đổi**. Chưa stage, commit hoặc push.

---

## 1. Phạm vi & thông số lượt nghiệm thu

- **Project root đã enroll:** `<PROJECTS_ROOT>/giz` (`dev=16777234`, `ino=10167768`, APFS local case-insensitive)
- **Catalog revision (pinned SHA):** `4044fbf0545f4be1da51dbc10f1327f0a3da0017`
- **Skill:** `debug-regression` (1 skill duy nhất)
- **Provider:** `Codex` (`canonical_only`, 0 derived files)
- **Profile & daemon riêng:** `<PILOT_TEMP_BASE>` (`127.0.0.1:61057`)
- **Policy revision đã enroll:** `aaae261c87ef37526b4bce2fb096f92639301b533821cd14405512955c4b1d99`
- **Operation ID:** `7f826c811411786157ec6fa9c52c9b41`
- **Plan digest:** `a9e805ff8633c9d8761dacf7728aa5751cb355da46e8bda7cbfacadbbf0033b4`

**Evidence JSON/JSONL:**
- Gate 1 baseline: [giz-gate1-baseline.json](../evidence/single-project-pilot/giz-gate1-baseline.json)
- Gate 2 enrollment & Preview: [giz-gate2-evidence.json](../evidence/single-project-pilot/giz-gate2-evidence.json)
- Post-Apply & Opt-in OFF: [giz-apply-evidence.json](../evidence/single-project-pilot/giz-apply-evidence.json)
- Codex native discovery trace: [giz-codex-discovery.jsonl](../evidence/single-project-pilot/giz-codex-discovery.jsonl)

---

## 2. Bảng kết quả từng tiêu chí nghiệm thu

| # | Tiêu chí nghiệm thu | Kết quả | Evidence cụ thể |
| --- | --- | --- | --- |
| 1 | **Tiền kiểm trước Apply khớp Gate 2 100%** | **PASS** | 10 mục baseline đệ quy khớp nguyên vẹn, `git status` trống, `enrollment` khớp `policyRevision` & `rootIdentity`, Preview mới trả `eligible` với đúng 2 file khớp SHA-256 & mode của Gate 2. |
| 2 | **Thực hiện Apply qua UI đúng luồng `Review create-only approval → Confirm create-only`** | **PASS** | Paseo Desktop 0.17.5 profile riêng thực thi thành công, hiển thị `Completed` và `Operation ledger` với `Created and verified`. |
| 3 | **Operation `completed` & durability `fsync_completed`** | **PASS** | `apply.status.v1({ operationId: "7f826c811411786157ec6fa9c52c9b41" })` trả `phase: "completed"`, `code: "none"`, `targetMutated: true`, `durability: "fsync_completed"`, `requiresPreview: false`. |
| 4 | **Chỉ tạo đúng 2 file trong plan đã duyệt, khớp SHA-256, size, mode & inode** | **PASS** | Xem bảng đối chiếu tại Mục 3. `git status --short --untracked-files=all` chỉ liệt kê đúng 2 file dưới `.agents/skills/debug-regression/`. Không tạo file nào tại `.kiro/`. |
| 5 | **Toàn bộ 10 mục baseline hiện có giữ nguyên 100%** | **PASS** | Đối chiếu đệ quy toàn bộ 10 mục (`.gitignore`, `geeks-portal-frontend/*`, `slp-manager/*`): `dev`, `ino`, `mode`, `size`, `sha256` khớp 100% với Gate 2. |
| 6 | **Preview lần hai trả về `no_changes`** | **PASS** | Desktop UI hiển thị `No changes to approve.`; `preview.providers.v2` trả `applyEligibility: { status: "no_changes" }`. |
| 7 | **Session Codex mới phát hiện & đọc đúng `SKILL.md` qua native discovery** | **PASS** | `codex-cli 0.167.0` (`--sandbox read-only`, `thread_id: 01a21d22-c3d3-78c0-a26e-640ebe32c4d2`, `cwd: <PROJECTS_ROOT>/giz`) phát hiện `debug-regression`, gọi tool `cat .agents/skills/debug-regression/SKILL.md` (exit 0) và trả `{"discovered":true,"skillName":"debug-regression","skillPath":"<PROJECTS_ROOT>/giz/.agents/skills/debug-regression/SKILL.md","firstHeading":"Debug Regression"}`. |
| 8 | **Tắt opt-in chặn Apply mới nhưng vẫn truy vấn được `operationId` cũ** | **PASS** | `enroll-single-project-pilot.mjs disable` → `enabled: false`; `apply.local-capability.v1` trả `{ enabled: false }`; gọi `apply.create.v1` trả `receipt_invalid`; `apply.status.v1({ operationId })` vẫn trả nguyên bản record `completed`. |
| 9 | **Dừng Desktop & daemon riêng sạch sẽ** | **PASS** | `paseo --home "$home" status --json` xác nhận `localDaemon: "stopped"`. |
| 10 | **Daemon chính `~/.paseo`, safety guard, SLP & Kanbanly giữ nguyên** | **PASS** | `mainDaemonHasPilotPlugin: false`; `native/anchored-writer.m` không đổi; không stage/commit/push. |

---

## 3. Đối chiếu chi tiết 2 file vừa tạo trên `<PROJECTS_ROOT>/giz`

| Destination | Trạng thái ledger | Dev : Ino | Mode | Size (B) | SHA-256 (Disk = Ledger = Catalog) |
| --- | --- | --- | --- | --- | --- |
| `.agents/skills/debug-regression` | `created_verified` (dir) | `16777234:12562568` | `0755` | — | — |
| `.agents/skills/debug-regression/applicability.json` | `created_verified` | `16777234:12562569` | `0644` | `67` | `a0cc6e49e3f53754580914558afd68220af1e4883c8d27d9e6245b3475490b29` |
| `.agents/skills/debug-regression/SKILL.md` | `created_verified` | `16777234:12562570` | `0644` | `3639` | `a09e1842c31849c449d678cb87d9c83bb10559f70ad1df7ba943868d8c98fc30` |

---

## 4. Đề xuất điều kiện Release cho bước tiếp theo

1. **Duy trì trạng thái hiện tại cho production chung:**
   - Daemon chính `~/.paseo` tiếp tục chạy bản **Preview-only** (`paseo-project-skills`) cho đến khi hoàn tất các điều kiện release bên dưới.
   - Với nhu cầu cài skill lẻ vào 1 project cụ thể trên macOS arm64 (APFS local case-insensitive), có thể tái sử dụng quy trình Pilot hiện tại (profile/daemon riêng + `enroll` 1 root + tắt opt-in ngay sau khi Apply).
2. **Điều kiện trước khi mở rộng sang đa skill / Kiro derived / nhiều project:**
   - Nghiệm thu riêng ca **Kiro derived** (`.kiro/skills/<id>/`) trên 1 bản sao dự án Git thật để kiểm chứng đồng bộ canonical + derived và discovery của Kiro CLI.
   - Có quyết định chính thức của release owner về **caller principal** (chờ Paseo SDK cấp caller identity cho plugin handler, hoặc chấp nhận mô hình daemon single-user tin cậy ngang nhau với tài liệu hóa rõ ràng).
   - Bổ sung kiểm thử tự động (hoặc kiểm tra lại toàn bộ `npm test` sau khi hoàn thiện commit của `scripts/enroll-single-project-pilot.mjs` và banner UX trong `client/single-project-pilot.tsx`) trước khi đóng gói/commit.
3. **Thao tác git chờ quyết định của bạn:**
   - Repo `paseo-project-skills`: hiện có các thay đổi chưa commit (`client/single-project-pilot.tsx`, `scripts/enroll-single-project-pilot.mjs`, `tests/single-project-pilot-cli-ui.test.mjs`, các báo cáo & evidence trong `docs/`).
   - Repo `<PROJECTS_ROOT>/giz`: hiện có đúng 2 file mới chưa commit (`.agents/skills/debug-regression/SKILL.md` và `.agents/skills/debug-regression/applicability.json`) để bạn review và quyết định giữ lại hoặc commit trong `giz`.
