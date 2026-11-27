# Báo cáo Gate 2 (Sau Enrollment & Preview — Trước Apply) — Safe Apply Pilot giới hạn cho `giz`

**Ngày:** 2026-11-27  
**Trạng thái:** **DỪNG TẠI GATE 2** — Đã hoàn tất kiểm tra trước Enrollment, thực hiện Enrollment cho `<PROJECTS_ROOT>/giz` trên daemon tạm riêng, mở Paseo Desktop profile riêng và chạy Preview đúng 1 skill `debug-regression` + `Codex`. **Chưa bấm Apply, chưa ghi file vào `<PROJECTS_ROOT>/giz`, chưa chạm daemon chính `~/.paseo`, chưa commit hoặc push.**

**Evidence JSON đầy đủ:** [docs/evidence/single-project-pilot/giz-gate2-evidence.json](../evidence/single-project-pilot/giz-gate2-evidence.json)

---

## 1. Xác minh trước Enrollment

### 1.1 Baseline đệ quy của `<PROJECTS_ROOT>/giz/.agents/skills/` (10 mục)
Toàn bộ thư mục và file hiện có (bao gồm nội dung trong `geeks-portal-frontend` và `slp-manager`) đã được ghi nhận `dev`, `ino`, `mode`, `size`, `sha256`:

| Đường dẫn dưới `.agents/skills/` | Loại | Inode | Mode | Size (B) | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `.gitignore` | file | `10531044` | `0644` | `11` | `e1f6cb56844dfb267d9d6a774197cb946ab1f3f30a05c9d2c930f6eb4f3f50de` |
| `geeks-portal-frontend` | dir | `11495999` | `0755` | `96` | — |
| `geeks-portal-frontend/SKILL.md` | file | `11496000` | `0644` | `6077` | `dedc92c3c53154a40674a55ea93f2bd1c73cd2bd2a0f95aac9fd0fa90c50f3c1` |
| `slp-manager` | dir | `11496001` | `0755` | `128` | — |
| `slp-manager/SKILL.md` | file | `11496002` | `0644` | `54588` | `c6a48a00f87843a10f425a2bc3f7e256d9922360c4fc93bd5bd1793e454f883c` |
| `slp-manager/references` | dir | `11496003` | `0755` | `192` | — |
| `slp-manager/references/PEER_TEMPLATES.md` | file | `11496004` | `0644` | `6904` | `09d9c6bc4e04aff0ebed837933264983bb827138e3823f19cbe24a0ee36e00d4` |
| `slp-manager/references/PROJECT_INVESTIGATION.md` | file | `11496005` | `0644` | `11917` | `8cefb8cc0a1af7ebf5a457b6db053b43e2dcfdb26eebefd94b5f82cff1a5aecb` |
| `slp-manager/references/STACK_PLAYBOOKS.md` | file | `11496006` | `0644` | `6296` | `2b20e3106bc8c45394dbb51ff0821b7fb52458a92ee2e12d846669871ad9ebe9` |
| `slp-manager/references/TEST_POLICY_TEMPLATE.md` | file | `11496007` | `0644` | `5865` | `b3d6620ba5aa3d957cabd91c290cc6f6d4ffa1e6279be7ee77acccfa1ed56d66` |

### 1.2 Kiểm tra `.gitignore`, `git check-ignore` & tiến trình đang chạy
- **`.agents/skills/.gitignore`:** nội dung `!.gitignore` (11 bytes).
- **`git -C <PROJECTS_ROOT>/giz check-ignore -v .agents/skills/debug-regression/SKILL.md .agents/skills/debug-regression/applicability.json`:** exit code `1` (**không bị ignore**).
- **`git status --short`:** sạch (0 dòng).
- **Tiến trình / Agent / SLP trên `giz`:** `ps aux` và `lsof +D <PROJECTS_ROOT>/giz/.agents` đều trống (**không có** tiến trình nào đang đọc/ghi target).

---

## 2. Kết quả Enrollment & Xác minh Safety Gates

- **Daemon tạm:** `<PILOT_TEMP_BASE>/daemon` (`127.0.0.1:61057`)
- **Policy file:** `$base/daemon/runtime/project-skills-pilot/enrollment.json` (`0600`, `enabled: true`)
- **Canonical root:** `<PROJECTS_ROOT>/giz`
- **`policyRevision`:** `aaae261c87ef37526b4bce2fb096f92639301b533821cd14405512955c4b1d99`
- **Volume identity:** `apfs`, local, case-insensitive, `mountPoint: "<WORK_VOLUME>"`, `fsid: ["16777234", "26"]`
- **Ancestor chain:** `6` thành phần từ `/` → `<PROJECTS_ROOT>/giz` (`ancestorsDigest: 80b4f1734a82c0d6eed14d165206b8858022cd1866e06b4622b948cef99be6ae`)
- **Root identity:** `dev=16777234`, `ino=10167768`, `mode=16877 (0755)`, `uid=501`, `gid=80` (khớp 100% baseline Gate 1)
- **Daemon chính `~/.paseo`:** `mainDaemonHasPilotPlugin: false` (vẫn Preview-only, không bị tác động)

---

## 3. Kết quả Preview trên Desktop Profile riêng (Gate 2)

### 3.1 Trạng thái UI thực tế (Paseo Desktop 0.17.5 profile riêng)
- `apply.local-capability.v1` trả `{ enabled: true }`.
- Banner Preview-only (`Safe Apply is inactive...`): **ẩn** (`previewOnlyNoticeVisible: false`).
- Target đã chọn: `<PROJECTS_ROOT>/giz`.
- Provider đã chọn: duy nhất **`Codex, ready`**.
- Catalog SHA đã pin: `4044fbf0545f4be1da51dbc10f1327f0a3da0017`.
- Skill đã chọn: duy nhất **`debug-regression`**.
- Sau khi bấm **Preview Changes**:
  - UI hiển thị **`Eligible for create-only approval.`** (`eligibleTextShown: true`).
  - Nút **`Review create-only approval`** ở trạng thái **`enabled`**.
  - **Không bấm Apply/Confirm** (`applyTriggered: false`).

### 3.2 Plan & Receipt binding (`preview.providers.v2`)
- **`applyEligibility`:** `{ status: "eligible" }`
- **`plannedEffect`:** `"create_only"`
- **`writeCapability`:** `"single_project_v1"`
- **`enrollment` binding:** khớp `policyRevision` (`aaae261c...`), `rootIdentity` (`16777234:10167768`), `ancestorsDigest` (`80b4f173...`)
- **Danh sách file dự kiến tạo (khớp 100% Gate 1):**

| Destination | Status | Mode | Size (B) | SHA-256 |
| --- | --- | --- | --- | --- |
| `.agents/skills/debug-regression/SKILL.md` | `create` | `0644` | `3639` | `a09e1842c31849c449d678cb87d9c83bb10559f70ad1df7ba943868d8c98fc30` |
| `.agents/skills/debug-regression/applicability.json` | `create` | `0644` | `67` | `a0cc6e49e3f53754580914558afd68220af1e4883c8d27d9e6245b3475490b29` |

- **Conflict:** `0` · **Blocked:** `0` · **Derived entries (Kiro / khác):** `0` (`derivedEntries: []`).

### 3.3 Xác nhận chưa ghi file nào (`zeroWriteCheck`)
- `<PROJECTS_ROOT>/giz/.agents/skills/debug-regression`: vẫn `ENOENT` (`debugRegressionAbsent: true`).
- `git -C <PROJECTS_ROOT>/giz status --short`: trống (`gitStatusClean: true`).
- Desktop tạm & daemon tạm đã dừng sạch (`localDaemon: "stopped"`), giữ nguyên profile và `enrollment.json` để thực thi ngay khi Gate 2 được duyệt.

---

## 4. Gate 2 — Chờ User phê duyệt Apply

Vui lòng xác nhận **phê duyệt Apply** cho đúng plan 2 file ở Mục 3.2 (`debug-regression` + `Codex` tại SHA `4044fbf0545f4be1da51dbc10f1327f0a3da0017` vào `<PROJECTS_ROOT>/giz`).

Sau khi bạn phê duyệt Gate 2, tôi sẽ:
1. Khởi động lại Desktop + daemon tạm đã enroll, chạy Preview mới (khớp chính xác 2 file & SHA-256 trên) và thực hiện **Apply create-only** qua UI.
2. Đối soát `apply.status.v1`, `sha256`/`mode`/`ino` của 2 file mới, và toàn bộ 10 mục baseline đệ quy hiện có trong `.agents/skills/` phải giữ nguyên 100%.
3. Chạy Preview lần hai xác nhận `no_changes`.
4. Kiểm tra một **session Codex mới** tại `<PROJECTS_ROOT>/giz` phát hiện và đọc được `debug-regression/SKILL.md` qua native discovery.
5. **Tắt opt-in** (`enabled: false`), xác nhận `apply.status.v1` vẫn truy vấn được `operationId` cũ, rồi **dừng Desktop và daemon tạm**.
6. Xuất báo cáo nghiệm thu cuối cùng dưới dạng `.md`.
