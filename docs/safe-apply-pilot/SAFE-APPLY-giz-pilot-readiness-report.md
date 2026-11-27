# Báo cáo đánh giá & phương án nghiệm thu Safe Apply (Pilot giới hạn)

**Ngày:** 2026-11-27  
**Baseline:** Candidate `2791c85` ([SAFE-APPLY-single-project-pilot-acceptance-report.md](SAFE-APPLY-single-project-pilot-acceptance-report.md)) · Target dự kiến: `<PROJECTS_ROOT>/giz`  
**Trạng thái thực hiện:** Chỉ điều tra, đối chiếu và lập phương án. Chưa sửa code, chưa stage/cài daemon mới, chưa ghi vào `<PROJECTS_ROOT>/giz`, chưa Apply, chưa commit/push.

---

## 1. Xác minh build thực tế đang chạy & nguyên nhân Apply chưa xuất hiện

| Hạng mục | Trạng thái thực tế trên host cục bộ |
| --- | --- |
| **Daemon & Profile** | Daemon chính `~/.paseo` (`127.0.0.1:6767`), `Paseo Daemon` **0.17.5**. |
| **Plugin đang chạy** | `paseo-project-skills` (`directory` → `<PROJECTS_ROOT>/paseo-project-skills`, `status: "running"`). |
| **Lần load gần nhất** | `2026-11-27 19:44:00 +0700` (`2026-11-27T12:44:00.024Z` trong `~/.paseo/daemon.log`). |
| **RPC đã đăng ký** | `catalog.load`, `foundation.status`, `preview.canonical`, `preview.providers`, `preview.providers.v2`, `settings.catalog.{read,write,reset}`, `target.validate-directory`. |
| **RPC vắng mặt** | `apply.local-capability.v1`, `apply.create.v1`, `apply.status.v1`. |

**Nguyên nhân Apply chưa xuất hiện (hoạt động đúng theo thiết kế an toàn):**
1. Plugin đang cài trên daemon chính là entrypoint sản phẩm [index.server.ts](../../index.server.ts) + [index.client.tsx](../../index.client.tsx), **cố ý là Preview-only** (không đăng ký `apply.*`, không bọc `FixtureApprovalScope`).
2. Candidate Safe Apply của commit `2791c85` nằm tách biệt ở [release/single-project-pilot/paseo-plugin.json](../../release/single-project-pilot/paseo-plugin.json) (`id: "paseo-project-skills-single-project-pilot"`), dùng [server/single-project-pilot.ts](../../server/single-project-pilot.ts) + [client/single-project-pilot.tsx](../../client/single-project-pilot.tsx), và **chưa được stage/cài vào profile + daemon riêng**.
3. `~/.paseo/runtime/` không có `project-skills-pilot/enrollment.json` (opt-in mặc định tắt).

---

## 2. Đối chiếu Safety Gate, Enrollment & Target `<PROJECTS_ROOT>/giz`

Kiểm tra chỉ đọc trên `<PROJECTS_ROOT>/giz` và đối chiếu với [native/anchored-writer.m](../../native/anchored-writer.m), [server/single-project-policy.ts](../../server/single-project-policy.ts) và [SAFE-APPLY-single-project-pilot-acceptance-report.md](SAFE-APPLY-single-project-pilot-acceptance-report.md):

| Điều kiện gate | Thực tế của `giz` / Host | Đạt? |
| --- | --- | --- |
| **OS / Arch / Paseo / SDK** | macOS `27.2.1`, `arm64`, Paseo `0.17.5`, SDK `0.17.4` | Đạt |
| **Volume filesystem** | `<apfs-volume>` mounted tại `<WORK_VOLUME>`: **APFS**, local, read-write, case-insensitive | Đạt |
| **Root & `.agents` metadata** | `giz` (`dev=16777234`, `ino=10167768`, `mode=0755`, `uid=501`, `flags=0`, không extended ACL); `.agents` & `.agents/skills` cùng `0755`, `uid=501`, không ACL | Đạt |
| **Cross-volume coordinator** | `giz` trên `<WORK_VOLUME>` (`dev=16777234`), `$TMPDIR` trên root volume (`dev=16777230`); `--single-project-worker` kiểm coordinator độc lập trên local APFS của `PASEO_HOME` | Đạt |
| **Create-only cho `debug-regression`** | `<PROJECTS_ROOT>/giz/.agents/skills/debug-regression` **chưa tồn tại** (`ENOENT`) | Đạt |
| **Partial scan (`directory limit`, `public/storage`)** | Chỉ ảnh hưởng scanner evidence; không chặn Preview hay Apply vì writer chỉ thao tác trong `.agents/skills/<slug>/` | Không phải blocker |

---

## 3. Các điều kiện còn thiếu (Blockers) trước khi Safe Apply trên project thật

1. **Chưa có profile Desktop riêng + daemon home riêng:** Candidate `2791c85` bắt buộc chạy ở profile/daemon riêng ngoài `~/.paseo`, không cài vào daemon chính.
2. **Chưa có công cụ CLI nhỏ để operator enroll / bật / tắt opt-in cho profile riêng:** Hiện [server/single-project-policy.ts](../../server/single-project-policy.ts) đã có hàm `enrollSingleProjectRoot` và `setSingleProjectOptIn`, còn [scripts/stage-single-project-pilot.mjs](../../scripts/stage-single-project-pilot.mjs) mới chỉ stage profile ở trạng thái opt-in OFF.
3. **UX khi opt-in OFF / chưa enroll (tùy chọn):** [client/single-project-pilot.tsx](../../client/single-project-pilot.tsx) hiện âm thầm fallback sang `ReadOnlyPreview` khi `apply.local-capability.v1` trả `{ enabled: false }` mà chưa hiện lý do.
4. **Phê duyệt bắt buộc của Release Owner (theo `7db3404` & báo cáo `2791c85`):**
   - Chấp nhận **SDK 0.17.4 thiếu caller principal** (daemon riêng chỉ phục vụ client/tiến trình tin cậy ngang nhau; không xác minh danh tính người duyệt).
   - Chấp nhận **giới hạn kernel race khi move thư mục** giữa `linkage()` cuối và `openat`/`mkdirat` (entry có thể tạo trong directory cũ trước khi helper dừng với `linkage_changed`; directory thay thế không bị ghi).
   - Xác nhận quyết định cho phép enroll và ghi thật vào `<PROJECTS_ROOT>/giz` (sau khi chọn scope 1 skill + 1 provider).

---

## 4. Phương án nghiệm thu giới hạn (1 project · 1 skill · 1 provider)

- **Phạm vi cố định:**
  - **Project:** `<PROJECTS_ROOT>/giz` (chỉ enroll 1 canonical root này trong daemon riêng; daemon chính `~/.paseo` giữ nguyên Preview-only).
  - **Catalog revision:** `4044fbf0545f4be1da51dbc10f1327f0a3da0017` (pin SHA cố định).
  - **Skill:** duy nhất `debug-regression`.
  - **Provider:** duy nhất `Codex` (`canonical_only` → **chỉ tạo file trong `.agents/skills/debug-regression/`**, 0 file tại `.kiro/`).
- **Quy trình đề xuất sau khi được phê duyệt:**
  1. **Stage profile & daemon riêng:** Chạy `node scripts/stage-single-project-pilot.mjs` tạo `$base/daemon`, `$base/desktop`, `$base/candidate` (`paseo-project-skills-single-project-pilot`), opt-in mặc định **OFF**.
  2. **Khởi động daemon riêng & directory install thật:** Cài `$base/candidate` vào daemon riêng, xác nhận `apply.local-capability.v1` trả `{ enabled: false }` khi chưa enroll.
  3. **Enroll đúng 1 canonical root:** Chạy enrollment bằng native `--enroll-root` cho `<PROJECTS_ROOT>/giz` → ghi `$PASEO_HOME/runtime/project-skills-pilot/enrollment.json` (`0600`, `enabled: true`) kèm `policyRevision`, `volume.fsid`, `ancestors`.
  4. **Mở Desktop với profile riêng** (`PASEO_HOME=$base/daemon`, `PASEO_ELECTRON_USER_DATA_DIR=$base/desktop`):
     - Chọn `<PROJECTS_ROOT>/giz`, chọn duy nhất provider `Codex`, lưu catalog SHA `4044fbf0545f4be1da51dbc10f1327f0a3da0017`.
     - Scan & Recommend → chỉ chọn duy nhất `debug-regression` → bấm **Preview Changes**.
     - Kiểm tra plan: `Eligible for create-only approval.`, chỉ có file `Create` dưới `.agents/skills/debug-regression/`, `Conflict: 0`, `Blocked: 0`, `Kiro: 0`.
     - Duyệt **Review create-only approval** → **Confirm create-only** → xác nhận `Completed` (`durability: "fsync_completed"`).
  5. **Đối soát hậu kiểm:**
     - Gọi `apply.status.v1` theo `operationId`, đối chiếu từng file tạo mới (`sha256`, `mode`, `ino`) khớp ledger.
     - Bấm **Preview Changes** lại cùng selection → xác nhận báo `No changes to approve.` (`no_changes`).
     - Chạy `git -C <PROJECTS_ROOT>/giz status --short` xác nhận **chỉ** xuất hiện `.agents/skills/debug-regression/` (không chạm file cũ hay `.kiro/`).
  6. **Tắt opt-in & dừng daemon riêng:** Đặt `enabled: false`, xác nhận `apply.status.v1` vẫn đọc được `operationId` cũ, sau đó dừng Desktop và daemon riêng.

---

## 5. Xác minh trạng thái Rule Deployment (không triển khai thêm)

| Lớp | Trạng thái hiện tại trong source code & roadmap |
| --- | --- |
| **Roadmap** | [README.md](../../README.md) & [M1.1-foundation-planning.md](../../M1.1-foundation-planning.md) nhắc tới khả năng sinh provider-specific rules ở M3 *nếu cần*. |
| **Scanner (Read-only)** | Chỉ đọc để thu thập inventory/evidence: [server/project-reader.ts](../../server/project-reader.ts) cho phép đọc metadata `rules`, `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`; [server/project-detectors/inventory.ts](../../server/project-detectors/inventory.ts) nhận diện `.cursor/rules/**/*.mdc`. |
| **Preview & Provider Adapters** | **Chưa có Rule Deployment.** [server/canonical-preview.ts](../../server/canonical-preview.ts) chỉ plan `.agents/skills/<id>/*`. [server/provider-adapters.ts](../../server/provider-adapters.ts) chỉ sinh derived skill cho Kiro (`.kiro/skills/<id>/*`); Codex, Cursor ACP, Antigravity đều `canonical_only`. |
| **Native Writer Gate** | [native/anchored-writer.m](../../native/anchored-writer.m) và [server/native-writer-contract.ts](../../server/native-writer-contract.ts) khóa cứng đường dẫn ghi trong `^\.(?:agents|kiro)/skills/<slug>/...` — chặn mọi path rule (`.cursor/rules/*`, `AGENTS.md`, `CLAUDE.md`, `.kiro/steering/*`). |

→ **Kết luận:** Rule Deployment **chưa tồn tại** trong Preview hay Apply và nằm ngoài phạm vi Pilot hiện tại.

---

## 6. File dự kiến thay đổi & Đề xuất bước tiếp theo

- **Dự kiến thay đổi tối thiểu (chưa thực hiện, chờ phê duyệt):**
  - Thêm 1 script vận hành nhỏ: `scripts/enroll-single-project-pilot.mjs` (gọi `enrollSingleProjectRoot` / `setSingleProjectOptIn` cho profile riêng đã stage bởi `stage-single-project-pilot.mjs`).
  - (Tùy chọn UX) Chỉnh nhỏ [client/single-project-pilot.tsx](../../client/single-project-pilot.tsx) để hiển thị 1 dòng trạng thái chỉ đọc khi Safe Apply đang tắt / chưa enroll.
  - **Không sửa** `native/anchored-writer.m`, `server/fixture-apply.ts`, `index.server.ts`, `index.client.tsx`, hay bất kỳ safety guard nào.

- **Điểm cần User review & phê duyệt:**
  1. Xác nhận chấp nhận **trust boundary SDK 0.17.4** (thiếu caller principal) và **cửa sổ kernel race khi move thư mục** cho lượt Pilot giới hạn.
  2. Chọn phương án thực thi tiếp theo:
     - **(A)** Thêm `scripts/enroll-single-project-pilot.mjs` (+ tùy chọn dòng trạng thái UX) rồi chạy nghiệm thu giới hạn (`giz` · `debug-regression` · `Codex`) trên profile/daemon riêng.
     - **(B)** Chạy trước trên một **bản sao tạm của `giz`** rồi mới xin xác nhận lần cuối trước khi enroll `giz` thật.
