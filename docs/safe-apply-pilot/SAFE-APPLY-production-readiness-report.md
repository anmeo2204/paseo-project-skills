# Báo cáo Đánh giá Production Readiness — Safe Apply trên Main Plugin (`paseo-project-skills`)

**Ngày:** 2026-11-27  
**Baseline:** Safe Apply Single-Project Pilot trên `giz` (**PASS 10/10**, [SAFE-APPLY-giz-final-acceptance-report.md](SAFE-APPLY-giz-final-acceptance-report.md)) · Full test suite **164/164 PASS**, `tsc --noEmit` **0 lỗi**.  
**Mục tiêu đánh giá:** Cho phép người dùng thực hiện **Scan → Recommend → Select → Preview → Approve → Apply** trực tiếp trên plugin chính `paseo-project-skills` (daemon `~/.paseo`) mà không phải tạo profile/daemon riêng cho từng lần cài Skill, với thay đổi tối thiểu, tái sử dụng tối đa kiến trúc đã kiểm chứng và **không nới lỏng bất kỳ safety guard nào**.  
**Trạng thái hiện tại:** **CHỈ PHÂN TÍCH & ĐỀ XUẤT.** Chưa triển khai Production Apply trên main plugin, chưa thay đổi daemon chính `~/.paseo`, chưa nới lỏng safety guard.

---

## 1. Phân tích chuyên sâu 9 trụ cột Production Readiness

### 1.1 Trust Boundary của Daemon chính (`~/.paseo`)
- **Khác biệt cốt lõi so với Pilot:** Ở Pilot, daemon chạy cô lập (`PASEO_HOME=$tmp/daemon`, `127.0.0.1:<ephemeral>`, `relay.enabled: false`), chỉ bật trong vài phút rồi tắt opt-in và dừng hẳn. Trên daemon chính `~/.paseo` (`127.0.0.1:6767`), daemon chạy **thường trực**, phục vụ Paseo Desktop chính, CLI `paseo`, các plugin/agent khác, và có thể bật **Paseo Relay** (truy cập từ xa).
- **Bề mặt rủi ro mới:**
  1. Bất kỳ client nào kết nối được tới daemon chính (local CLI, cửa sổ Desktop khác, hoặc thiết bị qua Relay nếu bật) đều nằm trong cùng trust boundary của `paseo-project-skills`.
  2. Plugin directory install chạy không sandbox với quyền OS user hiện tại.
  3. Daemon chính không nhất thiết đặt biến môi trường `PASEO_HOME` tường minh (mặc định `~/.paseo`), trong khi `server/single-project-pilot.ts` hiện kiểm `process.env.PASEO_HOME === home`.
- **Nguyên tắc giữ nguyên:** Mặc định vẫn phải **Preview-only** cho mọi project chưa enroll; không bao giờ tự động cấp quyền ghi cho toàn bộ danh sách workspace/project của Paseo.

### 1.2 Giới hạn Caller Principal trong Paseo SDK `0.17.4`
- **Thực tế kỹ thuật:** `@getpaseo/plugin` `0.17.4` **không cung cấp caller principal / session identity / user approval attestation** cho plugin RPC handler (`PluginHandlerContext` chỉ có `paseo`, `signal`, v.v.).
- **Hệ quả trên daemon chính:**
  - Server không thể phân biệt RPC `apply.create.v1` đến từ nút **Confirm create-only** trên Desktop hay từ một script/client khác có quyền gọi RPC trên cùng daemon và biết bộ receipt binding (`previewId`, `planDigest`, `viewNonce`).
  - Không thể ghi audit log xác thực "ai đã bấm duyệt" ở mức mật mã/SDK.
- **Hướng xử lý thực tế:**
  - Nếu sản phẩm yêu cầu **multi-user / remote untrusted client / verified human approver**, đây là **hard blocker** cho đến khi Paseo SDK cung cấp caller principal.
  - Nếu Release Owner chấp nhận phạm vi **single-user local host** (chặn hoặc cảnh báo/disable Apply khi Relay bật, chỉ phục vụ loopback local trust boundary đồng nhất), có thể phát hành có điều kiện với tài liệu hóa rõ ràng và cơ chế per-project enrollment + opt-in.

### 1.3 Cơ chế Enrollment phù hợp với trải nghiệm thực tế
- **Giới hạn hiện tại (`server/single-project-policy.ts`):** `enrollment.json` chỉ lưu **đúng 1 `canonicalRoot`**. Muốn cài skill cho project thứ hai phải ghi đè enrollment của project thứ nhất — không phù hợp khi dùng trực tiếp trên daemon chính.
- **Đề xuất Minimal Change (giữ nguyên safety model):**
  - Mở rộng schema daemon-private (`$PASEO_HOME/runtime/project-skills/enrollments.json`, mode `0600`, dir `0700`) thành **explicit multi-root allowlist** (map `canonicalRoot → { enabled, policyRevision, volume, ancestors }`, có giới hạn số lượng root ví dụ tối đa 64).
  - Mỗi root vẫn được enroll độc lập qua native `--enroll-root` (mở từng thành phần bằng `O_NOFOLLOW`, ghi nhận `volume.fsid`, `caseMode`, chuỗi `ancestors` từ `/` đến root, cấp `policyRevision` riêng).
  - **Không** cho phép wildcard, parent-dir grant, symlink/alias hay auto-enroll từ `paseo.projects.list()`. Thư mục thay thế tại cùng pathname vẫn bị từ chối vì lệch `dev`/`ino`/ancestor chain.
  - **UX vận hành:** Giai đoạn đầu dùng CLI `enroll` / `enable` / `disable` / `revoke` (tái sử dụng `scripts/enroll-single-project-pilot.mjs` mở rộng cho multi-root). Việc đưa nút "Enroll this project" lên UI cần đánh giá riêng vì thiếu caller principal (nếu RPC cho phép tự enroll thì rào cản daemon-private bị vô hiệu hóa bởi chính client gọi RPC). **Do đó, enrollment phải tiếp tục là thao tác out-of-band phía host/CLI (hoặc Paseo native host settings ngoài plugin RPC)** trong khi SDK chưa có caller principal.

### 1.4 Approval Receipt & Binding giữa Preview và Apply
- **Đã có và rất vững (`server/preview-receipts.ts`, `shared/preview-receipt.ts`, `server/fixture-apply.ts`):**
  - Receipt sống tối đa 10 phút theo monotonic clock, tối đa 8 receipts / 32 MiB source bytes trên daemon (FIFO eviction), tối đa 8 MiB/receipt.
  - `planDigest` băm toàn bộ `PreviewManifest` (bao gồm `intent`, `entries`, `derivedEntries`, `directoryEffects`, `readSet`, `gitProof`, `policy.enrollment`, `viewNonce`, `epoch`, `installationInstanceId`).
  - `ApplyJournal.checkAdmission()` đảm bảo **single-use receipt** (`receipt_consumed`) dưới `flock` lock; revalidation chạy lại `handleProvidersV2` và so `manifestDigest` trước khi cấp admission ACK.
- **Điểm cần bổ sung cho main daemon:**
  - `PreviewReceiptStore` cần tra `enrollment` theo `target` (`singleProject(target)` thay vì `singleProject()` toàn cục) để bind đúng `policyRevision` của từng root được enroll.
  - Khi người dùng mở nhiều tab hoặc Preview liên tiếp nhiều project, FIFO eviction (8 receipts) có thể đẩy receipt cũ ra → UI cần thông báo rõ "Preview receipt expired or evicted, run Preview again" (hiện trả chung `receipt_invalid`).
  - Thêm `writeCapability: "production_v1"` (hoặc giữ tách biệt rõ với `"fixture_m4_5"` / `"single_project_v1"`) để không trộn lẫn policy giữa local RC, pilot và main plugin.

### 1.5 Multi-Skill Apply
- **Đã có sẵn trong code:**
  - `server/canonical-preview.ts` và `server/native-writer-contract.ts` (`buildFilePayloads`) đã hỗ trợ nhiều skill trong một `SelectionIntentV1`, sắp xếp deterministic: supporting files trước `SKILL.md`, `.agents/` trước `.kiro/`, giới hạn 2,048 files / 1,024 dirs / 8 MiB source / 30s deadline.
- **Khoảng trống cần giải quyết / kiểm chứng:**
  1. **Chưa nghiệm thu live:** Pilot `giz` chỉ chạy đúng 1 skill (`debug-regression`).
  2. **Whole-plan reject UX:** Nếu người dùng chọn 5 skill và 1 skill đã cài bị `conflict` (hoặc `blocked`), toàn bộ plan bị chặn (`plan_conflict`). Hành vi này an toàn (không âm thầm bỏ qua), nhưng trên thực tế người dùng cần thấy rõ skill nào gây conflict để bỏ chọn và Preview lại.
  3. **Partial failure across skills:** Vì không có rollback tự động, nếu lỗi I/O xảy ra ở skill thứ 3/5, skill 1–2 đã nằm trên disk (`created_verified`), skill 3 có thể dở (`created_incomplete`), skill 4–5 `not_attempted`. Cần kiểm thử thực tế quy trình đối soát ledger và chạy lại Preview cho các skill còn lại.

### 1.6 Multi-Provider Apply (đặc biệt Canonical + Kiro Derived)
- **Đã có sẵn trong code:**
  - `Codex`, `Cursor ACP`, `Antigravity` là `canonical_only` (0 derived files).
  - `Kiro` tạo bản sao derived tại `.kiro/skills/<id>/*` khi `verifyPreviewGitRoot` xác nhận target là Git work-tree root (hỗ trợ cả linked worktree), và defer Kiro package nếu canonical có `conflict`/`blocked`.
  - `native/anchored-writer.m` và `native-writer-contract.ts` đã cho phép cả `.agents/skills/<slug>/...` và `.kiro/skills/<slug>/...`, ghi canonical trước rồi mới ghi `.kiro/`.
- **Khoảng trống bắt buộc kiểm chứng trước Production:**
  1. **Chưa nghiệm thu live Kiro derived:** Pilot `giz` chỉ dùng `Codex` (`derivedEntries: []`). Chưa kiểm chứng end-to-end ghi đồng thời `.agents/skills/<id>/` + `.kiro/skills/<id>/` và Kiro CLI (`kiro-cli`) native discovery sau Apply trên Git repo thật.
  2. **Kịch bản partial failure giữa canonical và derived:** Nếu `.agents/skills/<id>/` ghi thành công nhưng `.kiro/skills/<id>/` lỗi giữa chừng (ví dụ crash/ENOSPC/late collision):
     - Lần Preview kế tiếp sẽ thấy `.agents/skills/<id>/*` là `unchanged` và `.kiro/skills/<id>/*` là `create` (hoặc `conflict` nếu file dở).
     - Cần verify bằng test tự động + live copy rằng Preview & Apply tiếp theo xử lý đúng case "canonical `unchanged` + Kiro `create`" (đảm bảo `requireCreateEntries` vẫn cho phép vì có entry `create` ở `derivedEntries`, và không đụng vào canonical `unchanged`).
  3. **Git root proof drift:** Nếu `.git` bị thay đổi giữa Preview và Apply, revalidation `manifestDigest` phải từ chối trước khi ghi (đã có trong unit/integration, cần xác nhận trong acceptance).

### 1.7 Concurrent Operations, Partial Write & Recovery
- **Cơ chế hiện có:**
  - Serialization 2 lớp: in-memory `active` Map (`fixture-apply.ts`) + native `flock` coordinator lock trên daemon home → tối đa 1 lượt Apply chạy tại một thời điểm trên mỗi daemon; request đồng thời trả `busy` (idempotent retry cùng `operationId` + `requestHash` trả lại kết quả/promise của lượt đang chạy).
  - `ApplyJournal` lưu 64 records, tự dọn terminal records (`completed`, `failed_before_write`, `partial_failure`) sau 24 giờ, **không bao giờ tự xóa** records `writing` / `recovery_required`.
  - Native helper phát `mutation_intent` → `file_verified` / `directory_verified` → `ready_to_finalize` kèm `fsync` file + parent directory.
- **Vấn đề trên daemon chính:**
  1. **Cạnh tranh đa cửa sổ / đa tab:** Hai tab Desktop cùng host có thể gọi Apply đồng thời; tab thứ hai nhận `busy` và phải Preview lại hoặc chờ. Cần đảm bảo UI hiển thị thông điệp rõ ràng, không làm mất state của operation đang chạy ở tab kia.
  2. **Giới hạn 64 records / 24h (`journal_full`):** Nếu người dùng cài lẻ nhiều lần trong 24h hoặc có nhiều record `recovery_required` chưa xử lý, `journal_full` sẽ chặn Apply mới. Cần quyết định chính sách retention/cleanup an toàn (hoặc tăng cap hợp lý / cung cấp CLI archive cho record `recovery_required` đã đối soát thủ công).
  3. **Cửa sổ kernel race khi move thư mục:** Giữa lần kiểm `linkage()` cuối và `openat`/`mkdirat`, nếu user/tiến trình khác rename thư mục gốc, 1 entry có thể được tạo trong thư mục cũ trước khi helper dừng với `linkage_changed` (thư mục thay thế không bị ghi). Đây là giới hạn POSIX/APFS đã biết và cần ghi rõ trong release notes.

### 1.8 Installation State & Bảo vệ Skill hiện có
- **Đã được bảo vệ chặt:**
  - Create-only / no-clobber (`O_CREAT | O_EXCL` trên fd neo vào parent handle, không overwrite, không delete, không chmod file có sẵn).
  - Pilot `giz` chứng minh 10/10 mục hiện có (`.gitignore`, `geeks-portal-frontend/*`, `slp-manager/*`) giữ nguyên 100% `dev`, `ino`, `mode`, `size`, `sha256`.
  - Duplicate diagnostics (`duplicate_skill_id`) cảnh báo nếu cùng ID xuất hiện ở nhiều layout (`.agents/skills`, `.cursor/skills`, `.kiro/skills`).
- **Giới hạn hiện tại (ngoài phạm vi create-only v1):**
  - Chưa có cơ chế **Update / Upgrade / Uninstall** skill đã cài. Nếu catalog phát hành phiên bản mới của một skill đã cài, Preview sẽ báo `conflict` và chặn Apply (an toàn, không ghi đè chỉnh sửa cục bộ của người dùng).
  - Chưa có manifest/lockfile quản lý phiên bản skill trong target repo (trạng thái cài đặt được suy ra trực tiếp từ filesystem comparison khi Preview). Điều này giữ target repo sạch (không thêm file metadata lạ) nhưng cần ghi rõ trong tài liệu người dùng.

### 1.9 Support Matrix & Environment Gates (Phát hiện quan trọng từ code)
- Trong `server/single-project-pilot.ts:61-75` và `server/native-writer-contract.ts:95-96`, hiện đang **khóa cứng exact version**:
  - `sw_vers -productVersion === "27.2.1"` (cả Node lẫn Zod schema `macOS: z.literal("27.2.1")`)
  - `paseo --version === "0.17.5"`
  - `process.env.PASEO_HOME === home`
- **Tác động Production:** Ngay khi macOS cập nhật bản vá bảo mật (ví dụ `27.2.2`) hoặc Paseo nâng cấp (`0.17.6`), Safe Apply trên daemon chính sẽ âm thầm rơi về Preview-only (`supported() === false`) dù APFS và kernel contract không đổi.
- **Giải pháp minimal:** Chuyển check OS sang kiểm chứng năng lực thực tế (Darwin `arm64`, local APFS read-write, `fpathconf(_PC_CASE_SENSITIVE) == 0`, native helper `codesign` + SHA-256) kèm minimum supported version thay vì literal exact patch version; giải quyết `PASEO_HOME` mặc định (`~/.paseo`) có kiểm tra `realpath` + `uid` + `0700`.

---

## 2. Phân loại trạng thái Production Readiness

### A. Đã được kiểm chứng (Verified)
- Luồng end-to-end **Scan → Recommend → Select → Preview v2 → Approve → Apply (create-only) → Status → Preview `no_changes`** trên project thật `giz` (`debug-regression` + `Codex`, **PASS 10/10**).
- Bảo toàn 100% các skill/file hiện có (10/10 mục baseline trên `giz` giữ nguyên `dev`/`ino`/`mode`/`size`/`sha256`).
- Native discovery của `codex-cli 0.167.0` đọc đúng `.agents/skills/debug-regression/SKILL.md` sau Apply.
- Opt-in mặc định OFF, tắt opt-in chặn Apply mới (`receipt_invalid`) nhưng `apply.status.v1` vẫn đọc được `operationId` cũ.
- 6/6 kịch bản an toàn trên bản sao độc lập (out-of-scope sibling/nested/alias, root replacement trước/sau Preview và `before_openat`, late collision, 2 writer tranh cùng leaf, `SIGKILL` crash recovery + restart + rotate `policyRevision`).
- Full regression suite **164/164 PASS** (Scan, Catalog Loader, Recommendation, Canonical Preview, Provider Adapters, Preview UI, Apply Journal, Native Writer, Pilot CLI/UI) và `tsc --noEmit` **0 lỗi**.

### B. Có thể tái sử dụng nguyên bản / gần nguyên bản (Reusable)
- `native/anchored-writer.m` và `server/native-writer.ts` (`--enroll-root`, `--single-project-probe`, `--single-project-worker`, `O_NOFOLLOW` ancestor walk, `O_CREAT|O_EXCL`, `fsync` file+dir, `flock` coordinator) — chỉ cần bỏ literal exact `macOS: "27.2.1"` và đặt tên/version artifact phù hợp.
- `server/fixture-apply.ts` (`createApplyEngine`), `server/apply-journal.ts` (`ApplyJournal` durable admission, receipt claim, 24h retention, crash recovery).
- `server/canonical-preview.ts`, `server/provider-adapters.ts`, `server/preview-git-root.ts`, `server/receipt-observations.ts`, `server/receipt-git-proof.ts`.
- `client/fixture-approval.tsx` (`FixtureApprovalScope`, `FixtureApprovalPreview`, `FixtureOperations`) và `client/apply-tracker.ts` — đã tích hợp sạch vào `client/foundation-screen.tsx` qua context `useFixtureApproval()`.
- `shared/apply.ts`, `shared/preview-receipt.ts`, `shared/selection-intent.ts`.

### C. Cần triển khai thêm (To Implement)
1. **Multi-root enrollment policy store** (`$PASEO_HOME/runtime/project-skills/enrollments.json`, `0600`) + CLI quản lý `list` / `enroll` / `enable` / `disable` / `revoke` cho nhiều project độc lập.
2. **Per-target receipt policy binding** trong `PreviewReceiptStore` (`policyFor(target)` tra đúng root trong allowlist) + `apply.local-capability.v1` phản ánh trạng thái capability tổng thể và/hoặc trạng thái enrolled của target đang chọn.
3. **Tích hợp vào entrypoint chính** (`index.server.ts` + `index.client.tsx`) với mặc định Preview-only khi chưa có root nào được enroll, tái sử dụng `FixtureApprovalScope` và banner trạng thái rõ ràng khi target chưa enroll.
4. **Chuẩn hóa Daemon Home & Version Gate:** Hỗ trợ default `~/.paseo` khi `PASEO_HOME` không set (vẫn kiểm `realpath` + `uid` + quyền thư mục), thay exact literal `27.2.1` / `0.17.5` bằng version floor / capability check an toàn.
5. **Bổ sung bộ Acceptance Tests mới** (xem Mục 3).

### D. Mandatory Blockers (Bắt buộc giải quyết trước khi mở Production trên Main Plugin)
1. **Quyết định chính thức về Trust Boundary & Relay trên Daemon chính:** Do Paseo SDK `0.17.4` thiếu caller principal, bắt buộc phải có quyết định Release Owner (chấp nhận single-user local host boundary hay chờ SDK) **và** cơ chế chặn Safe Apply (hoặc fail-closed về Preview-only) nếu daemon bật Relay / remote exposure vượt quá local trust boundary.
2. **Nghiệm thu live Kiro Derived (`.kiro/skills/`) + Multi-Skill Apply:** Chưa có bằng chứng thực tế trên Git repo thật cho (a) ghi đồng thời nhiều skill, (b) ghi đồng thời `.agents/skills/` + `.kiro/skills/` và Kiro CLI discovery, và (c) recovery khi canonical xong nhưng Kiro lỗi giữa chừng.
3. **Chuyển từ Single-Root sang Multi-Root Enrollment Store (out-of-band):** Không thể đưa single-root `enrollment.json` lên main daemon vì người dùng sẽ không thể cài skill cho dự án thứ 2 mà không xóa dự án thứ 1; đồng thời không được mở RPC tự enroll khi chưa có caller principal.
4. **Gỡ bỏ hardcode exact patch version (`macOS 27.2.1`, `Paseo 0.17.5`) và `PASEO_HOME` env bắt buộc:** Nếu không sửa, main plugin trên `~/.paseo` sẽ tự tắt Apply sau bản vá OS/Paseo kế tiếp hoặc khi Desktop chạy không truyền `PASEO_HOME`.

### E. Residual Risks cần Release Owner quyết định
1. **SDK `0.17.4` thiếu caller principal:** Mọi client/tiến trình cùng user local có quyền gọi plugin RPC trên `~/.paseo` đều có thể gọi `apply.create.v1` nếu nắm được receipt binding hợp lệ; không có bằng chứng mật mã về danh tính người bấm Confirm trên UI.
2. **Kernel race window khi rename/move thư mục gốc trong lúc Apply:** Nếu thư mục đã pin bị move giữa lần kiểm `linkage()` cuối và syscall `openat`/`mkdirat`, tối đa 1 entry có thể được tạo trong thư mục cũ trước khi helper dừng với `linkage_changed` (thư mục thay thế không bị ghi).
3. **Create-only không rollback tự động:** Crash/ENOSPC giữa chừng (đặc biệt khi cài nhiều skill hoặc canonical + Kiro) để lại file `0600` dở hoặc bộ skill cài dở; người dùng phải dựa vào `apply.status.v1` + ledger để dọn thủ công ngoài Safe Apply trước khi Preview lại.
4. **Không hỗ trợ Update / Overwrite / Uninstall ở v1:** Skill đã cài khi có phiên bản mới trên catalog sẽ báo `conflict` và chặn plan; người dùng phải tự cập nhật/xóa thủ công nếu muốn nâng cấp.
5. **Phạm vi nền tảng giới hạn:** Chỉ hỗ trợ **macOS arm64 + local APFS case-insensitive**; Linux, Windows, macOS Intel (x64), APFS case-sensitive và network filesystem giữ **Preview-only**.

---

## 3. Điều kiện Release & Acceptance Tests cần bổ sung

Trước khi bật Safe Apply trên plugin chính `paseo-project-skills`, cần vượt qua toàn bộ các gate sau:

| # | Acceptance Test / Gate cần bổ sung | Mục tiêu kiểm chứng |
| --- | --- | --- |
| **AT-1** | **Multi-root enrollment & cross-root isolation** | Enroll 2 project `A` và `B`, tắt `B`, giữ `A` bật: Preview/Apply trên `A` PASS; trên `B` (disabled) và `C` (unenrolled) bị chặn (`write_capability_unavailable` / `receipt_invalid`); receipt của `A` không dùng được cho `B`. |
| **AT-2** | **Multi-skill live Apply (3+ skills, có supporting files & executable `0755`)** | Toàn bộ files & modes khớp SHA-256/inode; Preview lần 2 trả `no_changes`; 1 skill conflict chặn toàn bộ plan mà không chạm các skill khác. |
| **AT-3** | **Multi-provider Canonical + Kiro Derived live acceptance** | Trên Git repo thật (và linked worktree): Apply tạo đủ `.agents/skills/<id>/*` + `.kiro/skills/<id>/*`; `codex-cli` và `kiro-cli` đều discover đúng skill; kiểm thử lỗi giữa chừng ở `.kiro/` → Preview lại thấy canonical `unchanged`, Kiro `create`/`conflict`. |
| **AT-4** | **Main daemon `~/.paseo` trust-boundary & Relay check** | Xác minh hành vi khi chạy trên daemon home mặc định (không set `PASEO_HOME` env); xác minh fail-closed khi daemon config có remote/relay exposure nếu áp dụng chính sách local-only. |
| **AT-5** | **Concurrent multi-client & journal retention test** | 2 client gọi Apply đồng thời → 1 hoàn tất, 1 nhận `busy` trước admission; kiểm tra thông báo rõ khi receipt bị evict (vượt 8 receipts) và khi journal gần đầy (64 records). |
| **AT-6** | **Full regression & existing-skill preservation** | `npm run typecheck`, `npm test`, `node scripts/smoke-local-rc.mjs`, và đối chiếu baseline skill có sẵn không thay đổi 100%. |

---

## 4. Đề xuất Milestone tiếp theo (Minimal, theo giai đoạn)

- **Milestone `M4.P1` — Multi-Root Policy, Version Gate & Multi-Skill/Kiro Acceptance (vẫn cách ly trên profile thử nghiệm):**
  1. Nâng cấp `single-project-policy.ts` thành multi-root allowlist (`enrollments.json`) + cập nhật CLI quản lý (`list`/`enroll`/`enable`/`disable`/`revoke`).
  2. Cập nhật `PreviewReceiptStore` bind enrollment theo từng `target`.
  3. Gỡ hardcode exact `macOS 27.2.1` / `Paseo 0.17.5` (chuyển sang capability/floor check) và hỗ trợ default `~/.paseo` an toàn.
  4. Chạy bổ sung **AT-1, AT-2, AT-3, AT-5** trên bản sao độc lập + live Kiro/Codex discovery.

- **Milestone `M4.P2` — Main Plugin Integration & Production Release Gate (sau khi Release Owner duyệt Residual Risks):**
  1. Tích hợp Safe Apply (mặc định Preview-only cho mọi project chưa enroll) vào `index.server.ts` và `index.client.tsx`, tái sử dụng `FixtureApprovalScope` + banner trạng thái enrollment theo target.
  2. Thêm guard kiểm tra trust boundary / relay của daemon chính (**AT-4**).
  3. Chạy full acceptance gate **AT-1 → AT-6** và chốt Production Release cho `paseo-project-skills` (create-only v1 trên macOS arm64 APFS).

- **Ngoài phạm vi M4.P (giữ tách biệt cho giai đoạn sau):**
  - Skill Update / Overwrite / Uninstall (M4.U).
  - Rule Deployment (`.cursor/rules/`, `AGENTS.md`, `.kiro/steering/`).
  - Scanner Optimization / Catalog Selector UI redesign.
  - M5 — SLP Integration Pilot.
