# Báo cáo nghiệm thu — Safe Apply Single-Project Pilot Candidate

**Ngày:** 2026-11-27  
**Baseline:** Proposal `7db3404` ([SAFE-APPLY-single-project-pilot-design.md](SAFE-APPLY-single-project-pilot-design.md)) · Giữ nguyên fixture gate của RC `687542a` ([SAFE-APPLY-local-RC-report.md](../../SAFE-APPLY-local-RC-report.md))  
**Phạm vi nghiệm thu:** Chỉ ghi vào bản sao độc lập trong profile/daemon tạm. Không sửa project gốc, daemon chính, SLP; không stage, commit hoặc push.

---

## 1. Tóm tắt triển khai

- **Native enrollment & write boundary** ([anchored-writer.m](../../native/anchored-writer.m), [native-writer-contract.ts](../../server/native-writer-contract.ts), [native-writer.ts](../../server/native-writer.ts), [writer-payload.ts](../../server/native/writer-payload.ts)):
  - Giữ nguyên mode `--worker` / `--primitive-fixture-worker` và fixture gate `pps-m43-*` của RC `687542a`.
  - Bổ sung `--enroll-root` mở từng thành phần từ `/` đến `canonicalRoot` bằng `open`/`openat(..., O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`, kiểm `fstat`/`fstatat(..., AT_SYMLINK_NOFOLLOW)`, `fstatfs` (APFS local read-write, `fsid`, `mountPoint`), `fpathconf(_PC_CASE_SENSITIVE) == 0` và `safeDirectory`, trả về identity đầy đủ của root và chuỗi ancestor.
  - Bổ sung `--single-project-probe` và `--single-project-worker` nhận policy enrollment từ daemon qua kênh private và tự đối chiếu độc lập toàn bộ ancestor/root handles + volume `fsid` + `linkage()` trước/sau admission ACK và trước/sau mutation.
- **Daemon-private opt-in & policy store** ([single-project-policy.ts](../../server/single-project-policy.ts)):
  - Mặc định tắt (`Preview-only`). Policy lưu tại `$PASEO_HOME/runtime/project-skills-pilot/enrollment.json` (`0600` trong thư mục `0700` thuộc `uid`), chỉ nhận đúng 1 `canonicalRoot` tuyệt đối, fail-closed khi thiếu/hỏng/sai quyền.
- **Receipt binding, Apply admission & tái sử dụng UI/Journal** ([preview-receipt.ts](../../shared/preview-receipt.ts), [preview-receipts.ts](../../server/preview-receipts.ts), [canonical-preview.ts](../../server/canonical-preview.ts), [fixture-apply.ts](../../server/fixture-apply.ts), [fixture-approval.tsx](../../client/fixture-approval.tsx)):
  - `PreviewManifest.policy.enrollment` bind `policyRevision`, `canonicalRoot`, `volume`, `rootIdentity` và `ancestorsDigest` vào `planDigest`.
  - `createSingleProjectApply` tái sử dụng `ApplyJournal`, admission dưới `flock`, revalidation, create-only/no-clobber và whole-plan reject khi có `conflict`/`blocked`.
  - Tắt opt-in, xoay `policyRevision` hoặc xóa `enrollment.json` chặn ngay receipt cũ (`receipt_invalid`), trong khi `apply.status.v1` vẫn truy vấn được chỉ đọc trên đúng `hostId`/slot gốc. Không tự retry, resume, cleanup hoặc rollback.
- **Candidate entrypoints & staging** ([single-project-pilot.ts](../../server/single-project-pilot.ts), [single-project-pilot.tsx](../../client/single-project-pilot.tsx), [release/single-project-pilot/paseo-plugin.json](../../release/single-project-pilot/paseo-plugin.json), [stage-single-project-pilot.mjs](../../scripts/stage-single-project-pilot.mjs)).

---

## 2. Support Matrix & Kết quả kiểm thử

| Hạng mục | Cấu hình / Phạm vi | Kết quả |
| --- | --- | --- |
| **OS / Arch / FS** | macOS **27.2.1**, **arm64**, **local APFS case-insensitive** | **PASS** (được hỗ trợ) |
| **Paseo / SDK** | Paseo Desktop & daemon **0.17.5**, `@getpaseo/{client,plugin,protocol}` **0.17.4** | **PASS** (được hỗ trợ) |
| **Ngoài matrix** | x64, Linux, Windows, APFS case-sensitive, network/read-only FS, version lệch | **Unsupported** (bị chặn bởi environment/native gate) |
| **Typecheck** | `npm run typecheck` (`tsc --noEmit`) | **PASS** (0 lỗi) |
| **Full test suite** | `npm test` (gồm [single-project-pilot.test.mjs](../../tests/single-project-pilot.test.mjs)) | **PASS — 162/162** (158 cũ + 4 mới) |
| **RC `687542a` fixture gate** | `node scripts/smoke-local-rc.mjs` | **PASS** (fixture gate giữ nguyên) |
| **Live directory install & Desktop** | `node --import ./tests/register.mjs scripts/accept-single-project-pilot.mjs` | **PASS — 6/6 ca**, daemon tạm đã dừng (`localDaemon: "stopped"`) |

---

## 3. Evidence nghiệm thu trên bản sao độc lập

Toàn bộ evidence JSON được lưu tại [docs/evidence/single-project-pilot/acceptance.json](../evidence/single-project-pilot/acceptance.json) (install thực qua `paseo --home "$home" plugin install "$plugin" --json`, plugin ID `paseo-project-skills-single-project-pilot`, status `running`).

| Ca kiểm tra | Kết quả & Evidence chính |
| --- | --- |
| **1. Opt-in OFF mặc định** | `apply.local-capability.v1` trả `{ enabled: false }`. Preview v2 trả `ineligible` (`write_capability_unavailable`). Gọi trực tiếp `apply.create.v1` trả `receipt_invalid`. Không tạo `.agents/`. |
| **2. Sibling / Nested / Symlink alias** | Enroll `project-copy-1` (`policyRevision: cd2ebeb5164c5676a1a781fb3210a26ef7903b9ec3296a4dfe784ba6ce7f0b5c`). Enroll symlink alias bị native helper từ chối (`invalid_target`). Preview trên sibling & nested trả `ineligible` (`write_capability_unavailable`), Apply trực tiếp trả `receipt_invalid`, snapshot trước/sau khớp 100%. Preview trên alias trả `target_changed`. |
| **3. Root replacement (trước/sau Preview & move sau linkage check)** | • **Trước Preview:** `ineligible` (`write_capability_unavailable`), directory thay thế nguyên vẹn.<br>• **Sau Preview, trước Apply:** `apply.create.v1` trả `unsupported_environment`, directory thay thế nguyên vẹn.<br>• **Move sau linkage check (`before_openat` trên `file-01.txt`, op `f9477b5d8800475b30899b673ee94905`):** trả `phase: "partial_failure"`, `code: "linkage_changed"`, `targetMutated: true`, `requiresPreview: true`.<br>&nbsp;&nbsp;- **Đối chiếu riêng directory cũ (`moved-old-root-3c`):** `file-00.txt` (`ino 122833026`, mode `0644`, 14 bytes, `created_verified`), `file-01.txt` (`ino 122833033`, mode `0600`, **0 bytes**, `created_incomplete`), `run.sh` và `SKILL.md` vắng mặt (`not_attempted`).<br>&nbsp;&nbsp;- **Đối chiếu riêng directory thay thế (`project-copy-1`):** snapshot trước/sau khớp 100% (không có `.agents/`), Preview lại trả `ineligible` (`write_capability_unavailable`). |
| **4. Late collision & hai writer tranh cùng leaf** | • **Late collision (op `af16417cbfd43f7eec21c748765fa46d`):** chèn foreign `file-00.txt` tại `after_create_check` → trả `failed_before_write`, `code: "destination_exists"`, `targetMutated: false`. Foreign file giữ nguyên `ino 122833056`, mode `0640`, `sha256: b707f2416e5d0d99f8ba2e7581007da84beef61c119cf83fb948038a10407b5d`.<br>• **Hai writer tranh cùng leaf (`before_openat`):** kết quả `["completed", "failed_before_write"]`; bên thua trả `destination_exists`, `targetMutated: false`; file thắng `ino 122833068`, mode `0644`, `sha256: 6dd760ef03973aa8bcf4e7641e7193af4ecd90b4da7cc2ce0b12dd4f7f33adb4`. |
| **5. Crash recovery, restart, tắt opt-in & đổi policy** | Kill native helper bằng `SIGKILL` tại `after_create` trên `file-01.txt` (op `67f26258cdcb37ae27d50c4cf713db62`). Dừng & khởi động lại daemon tạm, **tắt opt-in** (`enabled: false`): `apply.local-capability.v1` trả `false`, nhưng `apply.status.v1` trên host/slot gốc vẫn trả `phase: "recovery_required"`, `code: "terminal_record_missing"`, `requiresPreview: true`. Ledger khớp disk: `file-00.txt` (`ino 122833094`, 14 bytes, `created_verified`), `file-01.txt` (`ino 122833097`, mode `0600`, 0 bytes, `ownership_unknown`), `SKILL.md` vắng (`not_attempted`). Bật lại với `policyRevision` mới: Preview báo `ineligible` (`plan_conflict`) do file dở; receipt phát trước khi xoay revision bị chặn với `receipt_invalid`. |
| **6. Desktop Apply → Status → Preview no-op** | Paseo Desktop 0.17.5 mở màn hình `Project Skills Single-Project Pilot` trên `project-copy-desktop`: Scan → Preview (`Eligible for create-only approval.`) → Review → Confirm → `Completed` (op `801993ac2c06a34039014d45661474b8`, `durability: "fsync_completed"`). 4 file tạo mới (`file-00.txt`, `file-01.txt`, `run.sh` mode `0755`, `SKILL.md`) khớp `sha256`/mode/`ino` với ledger; `sentinel.txt` giữ nguyên. Bấm Preview lại hiện `No changes to approve.` và RPC trả `applyEligibility: { status: "no_changes" }`. |

---

## 4. Cách đối soát file dở sau crash hoặc mất reply

1. **Truy vấn Status chỉ đọc:** Giữ `operationId` và gọi `apply.status.v1` trên đúng `hostId` và slot `paseo-project-skills-single-project-pilot` (vẫn hoạt động ngay cả khi đã tắt opt-in hoặc mất enrollment).
2. **Đối chiếu từng dòng ledger với filesystem:**
   - `created_verified`: đối chiếu `dev`/`ino`, `mode` và `sha256` trên disk với `row.identity` và `row.expected`.
   - `created_incomplete` / `ownership_unknown`: kiểm tra sự tồn tại thực tế trên disk (thường là file 0 byte hoặc ghi dở với mode `0600`). **Lưu ý:** nội dung khớp hash sau crash tự nó không chứng minh ownership.
   - `not_attempted`: xác nhận đường dẫn chưa được tạo bởi lượt ghi.
3. **Xử lý thủ công ngoài Safe Apply:** Giữ nguyên final paths để review; không tự retry, resume, xóa hoặc rollback. Sau khi xử lý/dọn file dở ngoài Safe Apply, chạy **Preview mới** — nếu còn file dở hoặc conflict, Preview sẽ tiếp tục chặn toàn bộ plan (`plan_conflict`).

---

## 5. Giới hạn Trust Boundary & Điều kiện Release Owner cần chấp nhận

- **SDK 0.17.4 thiếu caller principal:** Handler phía daemon không nhận được danh tính người gọi (caller identity) và không thể xác minh ai đã bấm xác nhận trên UI. Bất kỳ client/tiến trình nào có quyền gọi plugin RPC trên daemon host và truy cập cùng installation slot đều có thể gọi `apply.create.v1` nếu có receipt binding hợp lệ, hoặc tra `apply.status.v1` nếu có `operationId`.
- **Điều kiện release owner phải chấp nhận trước khi xét ghi vào project thật:**
  1. **Trust boundary đồng nhất:** Daemon riêng chỉ phục vụ các client/tiến trình được tin cậy ngang nhau; receipt binding và `operationId` được giữ trong boundary đó. Nếu yêu cầu phân quyền theo người dùng hoặc audit danh tính người duyệt, giữ quyết định **NO-GO** với SDK 0.17.4.
  2. **Giới hạn kernel race khi move thư mục:** Nếu pinned directory bị move trong cửa sổ hẹp giữa lần kiểm `linkage()` cuối và syscall `openat`/`mkdirat`, syscall có thể tạo một entry trong **directory cũ** trước khi helper phát hiện `linkage_changed` và dừng (directory thay thế không bị ghi và không kế thừa quyền ghi). Nếu yêu cầu containment tuyệt đối không bao giờ ghi vào directory đã move, giữ **NO-GO**.
  3. **Quy trình vận hành & diễn tập:** Chấp nhận vận hành 1 profile Desktop + 1 daemon home riêng + 1 canonical root đã enroll, giữ mặc định tắt khi không dùng, và đã diễn tập đối soát `recovery_required` / file dở trên bản sao trước khi xét mở cho project thật.

---

## 6. Lệnh tái kiểm chứng

```sh
npm run typecheck
npm test
node scripts/smoke-local-rc.mjs
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/register.mjs scripts/accept-single-project-pilot.mjs
```
