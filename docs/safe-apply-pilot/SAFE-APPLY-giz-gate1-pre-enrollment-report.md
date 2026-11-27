# Báo cáo Gate 1 (Trước Enrollment) — Safe Apply Pilot giới hạn cho `giz`

**Ngày:** 2026-11-27  
**Trạng thái:** **DỪNG TẠI GATE 1** — Đã hoàn tất chuẩn bị môi trường cách ly, focused tests và baseline filesystem. **Chưa enroll `<PROJECTS_ROOT>/giz`, chưa Apply, chưa ghi vào target project, chưa chạm daemon chính `~/.paseo`, chưa commit hoặc push.**

---

## 1. Phạm vi Pilot giới hạn

- **Project root:** `<PROJECTS_ROOT>/giz`
- **Catalog revision (pinned SHA):** `4044fbf0545f4be1da51dbc10f1327f0a3da0017`
- **Skill:** `debug-regression` (1 skill duy nhất)
- **Provider:** `Codex` (`canonical_only`, 0 derived files)
- **Môi trường chạy:** Profile Desktop & daemon riêng biệt (opt-in mặc định **OFF**); daemon chính `~/.paseo` giữ nguyên Preview-only.

---

## 2. Thay đổi đã thực hiện & Kết quả Focused Tests

Không sửa `native/anchored-writer.m` hoặc bất kỳ safety guard nào. Không triển khai Rule Deployment, Scanner Optimization hay Catalog Selector.

| File | Mục đích |
| --- | --- |
| [scripts/enroll-single-project-pilot.mjs](../../scripts/enroll-single-project-pilot.mjs) | CLI vận hành `status` / `enroll` / `enable` / `disable` cho daemon home riêng, tái sử dụng nguyên bản [server/single-project-policy.ts](../../server/single-project-policy.ts). |
| [client/single-project-pilot.tsx](../../client/single-project-pilot.tsx) | Hiển thị dòng trạng thái chỉ đọc `pilotPreviewOnlyNotice` khi `apply.local-capability.v1` trả `{ enabled: false }` (opt-in OFF / chưa enroll / root identity không khớp), tự ẩn khi enabled. |
| [tests/single-project-pilot-cli-ui.test.mjs](../../tests/single-project-pilot-cli-ui.test.mjs) | Focused tests cho CLI enrollment (`status`, `enroll`, `disable`, `enable --rotate`, từ chối symlink alias) và banner trạng thái Preview-only trên UI. |

**Kết quả kiểm tra:**
- `npm run typecheck` (`tsc --noEmit`): **PASS** (0 lỗi).
- Focused tests (`tests/single-project-pilot-cli-ui.test.mjs` + `tests/single-project-pilot.test.mjs`): **PASS — 6/6**.

---

## 3. Xác minh môi trường cách ly & Safety Gates (trước Enrollment)

Evidence JSON đầy đủ: [docs/evidence/single-project-pilot/giz-gate1-baseline.json](../evidence/single-project-pilot/giz-gate1-baseline.json)

| Hạng mục kiểm tra | Kết quả thực tế |
| --- | --- |
| **Staged isolated base** | `<PILOT_TEMP_BASE>` (`0700`) |
| **Isolated daemon home & listen** | `$base/daemon` · `127.0.0.1:61057` (tách biệt hoàn toàn với daemon chính `~/.paseo` trên `127.0.0.1:6767`) |
| **Directory install thật** | `paseo-project-skills-single-project-pilot` (`status: "running"`) trong daemon tạm |
| **Daemon chính `~/.paseo`** | `mainDaemonHasPilotPlugin: false` — giữ nguyên Preview-only, không bị tác động |
| **Opt-in mặc định OFF** | `enroll-single-project-pilot.mjs status` → `active: false`; `apply.local-capability.v1` → `{ enabled: false }` |
| **Preview read-only khi OFF** | `preview.providers.v2` trên `giz` (`debug-regression` + `codex`) trả `status: "ready"`, `applyEligibility: { status: "ineligible", reasons: ["write_capability_unavailable"] }` |
| **Chặn Apply trực tiếp khi OFF** | `apply.create.v1` trả `{ status: "error", code: "receipt_invalid" }`, không tạo file nào trên `giz` |
| **Trạng thái daemon tạm hiện tại** | Đã dừng sạch (`localDaemon: "stopped"`), giữ nguyên thư mục stage chờ Gate 1 |

**Xem trước danh sách file dự kiến (read-only, từ SHA `4044fbf0545f4be1da51dbc10f1327f0a3da0017`):**
1. `.agents/skills/debug-regression/SKILL.md` — `create`, mode `0644`, `3639` bytes, `sha256: a09e1842c31849c449d678cb87d9c83bb10559f70ad1df7ba943868d8c98fc30`
2. `.agents/skills/debug-regression/applicability.json` — `create`, mode `0644`, `67` bytes, `sha256: a0cc6e49e3f53754580914558afd68220af1e4883c8d27d9e6245b3475490b29`
- **Derived entries (Kiro / khác):** `0` (Codex là `canonical_only`).

---

## 4. Baseline Filesystem của `<PROJECTS_ROOT>/giz` (chỉ đọc)

- **Canonical path:** `<PROJECTS_ROOT>/giz`
- **Git HEAD:** `89c89de6c7656bf79a832d35330d1f14456ff3f2` · `git status --short`: **sạch (0 dòng)**
- **Volume:** <apfs-volume> mounted tại `<WORK_VOLUME>` (APFS, local, read-write, case-insensitive)
- **Root & `.agents` identities:**
  - `giz`: `dev=16777234`, `ino=10167768`, `mode=0755`, `uid=501`, `gid=80`, không ACL
  - `giz/.agents`: `dev=16777234`, `ino=10167852`, `mode=0755`, `uid=501`, `gid=80`
  - `giz/.agents/skills`: `dev=16777234`, `ino=10531043`, `mode=0755`, `uid=501`, `gid=80`
- **Các mục hiện có trong `.agents/skills/` (phải giữ nguyên 100% sau Apply):**
  - `.gitignore` (`ino=10531044`, `mode=0644`, `11` bytes, `sha256: e1f6cb56844dfb267d9d6a774197cb946ab1f3f30a05c9d2c930f6eb4f3f50de`)
  - `geeks-portal-frontend` (`directory`, `ino=11495999`, `mode=0755`)
  - `slp-manager` (`directory`, `ino=11496001`, `mode=0755`)
- **`.agents/skills/debug-regression`:** `ENOENT` (chưa tồn tại).

---

## 5. Residual Risks & Biện pháp kiểm soát trong lượt Pilot

| Residual Risk | Mức độ / Bản chất | Biện pháp kiểm soát áp dụng trong lượt Pilot này |
| --- | --- | --- |
| **1. SDK 0.17.4 thiếu caller principal** | Daemon không xác minh được danh tính người gọi RPC hay ai đã bấm Confirm trên UI. Mọi tiến trình cùng trust boundary có thể gọi `apply.create.v1` nếu giữ receipt binding hợp lệ. | Cô lập hoàn toàn trong **1 profile Desktop + 1 daemon home tạm riêng** (`127.0.0.1:61057`, `relay.enabled: false`, `local-credential` `0600`), chỉ chạy trong thời gian nghiệm thu rồi **tắt opt-in và dừng daemon ngay**. |
| **2. Cửa sổ kernel race khi move thư mục** | Nếu thư mục đã pin bị rename giữa lần kiểm `linkage()` cuối và `openat`/`mkdirat`, syscall có thể tạo 1 entry trong thư mục cũ trước khi helper phát hiện `linkage_changed` và dừng (thư mục thay thế không bị ghi). | Người vận hành không di chuyển/đổi tên `<PROJECTS_ROOT>/giz` trong lúc Apply; native helper vẫn kiểm `linkage()` ngay trước và sau mỗi mutation và dừng lập tức nếu lệch. |
| **3. Crash / mất điện giữa chừng để lại file dở** | Create-only không rollback tự động; crash sau `openat(O_CREAT|O_EXCL)` có thể để lại file `0600` rỗng/ghi dở và báo `recovery_required`. | `giz` đang ở trạng thái `git status` sạch; baseline `dev`/`ino`/`mode`/`sha256` đã được ghi lại tại `giz-gate1-baseline.json`; `apply.status.v1` vẫn đọc được ngay cả sau khi tắt opt-in để đối soát thủ công. |
| **4. Unsandboxed local directory plugin** | Directory install chạy code plugin với quyền của user `<local-user>`. | Candidate stage trực tiếp từ checkout local đã review, dùng packaged native helper đã verify SHA-256 + `codesign --verify --strict`, không cài vào daemon chính `~/.paseo`. |

---

## 6. Gate 1 — Chờ User phê duyệt để chuyển sang Enrollment + Preview

Để tiếp tục sang bước tiếp theo (**Enroll `<PROJECTS_ROOT>/giz` trên daemon tạm `pps-pilot-hlJUW2` → chạy Preview đúng 1 skill `debug-regression` cho `Codex` → dừng lại ở Gate 2 chờ xác nhận Apply**), vui lòng xác nhận:

1. **Chấp nhận các residual risks** nêu tại Mục 5 cho lượt Pilot giới hạn này.
2. **Phê duyệt Enrollment** đúng 1 canonical root `<PROJECTS_ROOT>/giz` vào daemon tạm riêng (`$base/daemon`).
