# M4 Closure Summary — Safe Apply Create-only v1 (`v0.2.0` Release Candidate)

**Ngày:** 2026-11-28  
**Baseline:** `f4bef639f8035bd0674cd5ceaa1432816d9bb2f9` (`main` === `origin/main`, không tạo commit trùng)  
**Trạng thái M4:** **CLOSED / COMPLETED — PRODUCTION DESKTOP & MOBILE/RELAY ACCEPTANCE: PASS.**  
**Đề xuất Release Tag:** `v0.2.0` *(chưa commit, chưa push, chưa gắn tag — dừng chờ User phê duyệt).*

---

## 1. Đối soát Journal Operation `1daaa5fe505a75c96ce77fd3e90a10a7` trên `giz`

Nguồn đối soát: `~/.paseo/runtime/project-skills/coordinator/1daaa5fe505a75c96ce77fd3e90a10a7.json` so với filesystem thực tế trên `/Volumes/Work/alvenix/projects/giz`:

- **Trạng thái terminal:** `phase: "completed"`, `code: "none"`, `durability: "fsync_completed"`, `targetMutated: true`.
- **Giải thích chính xác `62` ledger entries (`60 created_verified` + `2 unchanged_verified`):**
  - **16 directories (`created_verified`):**
    - `1` thư mục gốc Kiro: `.kiro/skills`
    - `7` thư mục canonical mới dưới `.agents/skills/*` (`implement-change`, `laravel-background-job`, `laravel-data-change`, `laravel-feature-change`, `react-ui-change`, `review-change`, `verify-change`; thư mục `.agents/skills/debug-regression` đã tồn tại từ trước)
    - `8` thư mục derived Kiro dưới `.kiro/skills/*` (đủ cả 8 skill đã chọn)
  - **46 files (`23` canonical + `23` Kiro derived — khớp 100% với 46 files của Preview lần hai `no_changes`):**
    - `44` file **`created_verified`** (`21` canonical mới + `23` Kiro derived mới)
    - `2` file **`unchanged_verified`**: `.agents/skills/debug-regression/SKILL.md` và `.agents/skills/debug-regression/applicability.json` (đã tồn tại sẵn với nội dung & mode trùng khớp)
  - **Tổng hợp:** `16 directories created + 44 files created = 60 created_verified`; cộng `2 unchanged_verified` = **`62` ledger entries**.
- **Đối soát thực tế trên đĩa (`giz`):** `62/62` entry tồn tại đúng loại (`directory`/`file`) và khớp chính xác `dev` + `ino` (`allExistAndMatchInode: true`, `mismatchCount: 0`). Toàn bộ 9 file baseline cũ giữ nguyên 100% inode & SHA-256.

---

## 2. Review Mobile Storage Recovery & Backlog

- **Giới hạn đã xác định rõ:** Trên Paseo Mobile (React Native), `globalThis.localStorage` không tồn tại nên [index.client.tsx](../../index.client.tsx) dùng `createMemoryStorage()` theo phiên chạy của app. Nếu app Mobile bị force-kill hoặc reload giữa chừng, danh sách `operationId` trong bộ nhớ client sẽ bị mất (không lưu bền vững trên thiết bị di động).
- **Quy trình khôi phục đáng tin cậy trên daemon host (ĐÃ XÁC MINH — KHÔNG PHẢI BLOCKER ĐÓNG M4):**
  1. Journal bền vững ở phía daemon (`ApplyJournal`, ghi atomic + `fsync`, mode `0600`) luôn tồn tại tại `~/.paseo/runtime/project-skills/coordinator/<operationId>.json`.
  2. Khi mất client tracking trên Mobile, kiểm tra trực tiếp trên host:
     ```sh
     ls -lt ~/.paseo/runtime/project-skills/coordinator/*.json
     ```
     để lấy chính xác `<operationId>`, đọc `phase`, `durability`, `targetMutated` và toàn bộ `ledger`, đồng thời có thể truy vấn chỉ đọc qua `apply.status.v1({ operationId })` **ngay cả khi `allowRelay: false`, Relay ON, hoặc enrollment đã bị disable** (đã xác minh thực tế với `1daaa5fe505a75c96ce77fd3e90a10a7` → `completed` / `fsync_completed`).
- **Đưa vào Post-M4 Backlog:** **Persistent Mobile Operation Tracking** (lưu bền vững `operationId` phía React Native khi Paseo SDK cung cấp storage API chuẩn hoặc đồng bộ danh sách operation chỉ đọc từ daemon).

---

## 3. Xác minh Git State & Trạng thái Production Cuối Cùng (`~/.paseo`)

| Hạng mục | Kết quả | Evidence |
| --- | --- | --- |
| `HEAD` / `origin/main` | **PASS** | `f4bef639f8035bd0674cd5ceaa1432816d9bb2f9` === `origin/main` (không tạo commit trùng) |
| `paseo-project-skills` status | **PASS** | `running` (Paseo `0.18.0`, PID `8357`) |
| Relay trên `~/.paseo` | **PASS** | `relay.enabled: true` |
| `allowRelay` policy | **PASS** | `allowRelay: false` (`trustBoundary: { ok: false, reason: "remote_exposure_enabled" }`) |
| `giz` enrollment | **PASS** | `enabled: false` (`enrolledCount: 0` active) |
| Apply fail-closed | **PASS** | `apply.target-status.v1` trả `hostCompatible: false`, `trustBoundaryOk: false`, `reasons: ["remote_exposure_enabled"]`; `apply.create.v1` bị chặn (`true`) |
| SLP & Kanbanly | **PASS** | `paseo-slp-orchestrator`, `kanbanly`, `paseo-kiro-usage` đều `running` bình thường |

---

## 4. Đề xuất Release Tag `v0.2.0` (Chưa thực thi — Chờ phê duyệt)

Thay đổi tài liệu chưa commit trên working tree:
- `M` [README.md](../../README.md)
- `??` [docs/safe-apply-pilot/M4-closure-summary.md](M4-closure-summary.md)

Sau khi User phê duyệt, quy trình phát hành `v0.2.0` đề xuất:
```sh
git add README.md docs/safe-apply-pilot/M4-closure-summary.md
git commit -m "Finalize and close M4 Safe Apply Create-only v1"
git tag -a v0.2.0 -m "Safe Apply Create-only v1 (Paseo 0.18.0, build-time SDK manifest, optional host Relay opt-in)"
git push origin main --follow-tags
```
