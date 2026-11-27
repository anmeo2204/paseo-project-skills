# Safe Apply — Local Release Candidate

**Baseline `6acc758` · 2026-11-27 · GO cho directory install local trong phạm vi fixture và support matrix dưới đây. NO-GO cho ghi vào project thật.**

Candidate có plugin ID riêng `paseo-project-skills-local-rc`. Các entrypoints dự kiến cài nằm trong [release/local](release/local) và được sao nguyên vào thư mục cài có `client/`, `server/` và `shared/` cùng gốc. CLI Paseo đã chấp nhận directory install thực và báo plugin `running`. Dependencies được lấy từ checkout đã pin. Gói này cần giữ đường dẫn checkout/dependencies trong lúc dùng. Entrypoints và manifest của bản đang dùng khớp git baseline và tiếp tục Preview-only. [Baseline M4.6](M4.6-completion-report.md) · [Dấu vân tay bản cài](docs/evidence/local-rc/source-sha256.json)

## Environment gate và đăng ký RPC

- Đã nghiệm thu macOS **27.2.1 (26B131)**, **arm64**, **local APFS case-insensitive**, Paseo Desktop/daemon **0.17.5**, SDK client/plugin/protocol **0.17.4**. Profile private dưới temp directory, daemon home đúng profile, target phải ở bên dưới `targets/`. Candidate dùng coordinator và journal ngoài target. Không có Node full-path writer.
- Profile chuẩn đăng ký `apply.create.v1` và `apply.status.v1`. Preview v2 kiểm target bằng helper chuẩn trước khi trả eligibility cho UI. Apply kiểm lại environment và filesystem ở native boundary. Helper đóng gói `m4.4-fixture.1` protocol 1, bytes nhúng base64, private extraction, SHA-256 và version handshake. Helper thực hiện write chỉ sau durable admission ACK. [Native artifact evidence](docs/evidence/local-rc/packaged-helper.json)
- Đã cài thêm variant với SDK pin không khớp trong daemon tạm. Foundation vẫn ready, capability false, Apply/Status không đăng ký. Trong profile được hỗ trợ, một target trên **APFS case-sensitive** đã kiểm bằng disk image tạm vẫn Preview được nhưng trả ineligible. Gọi Apply trực tiếp với receipt hợp lệ cho target đó trả `unsupported_environment`. Snapshot bytes/mode/inode giữ nguyên. Disk image đã detach.
- x64, Linux, Windows, network filesystem, cloud-synced targets và các version ngoài matrix không thuộc support Apply. Lượt này chỉ kiểm âm thực cho APFS case-sensitive và SDK pin mismatch. Native gate từ chối platform/volume ngoài điều kiện của helper. Chưa xác minh cơ chế nhận diện mọi cloud-sync provider trên volume APFS local.

## Nghiệm thu candidate đã cài

| Ca | Kết quả |
| --- | --- |
| Profile chuẩn, không có hook nghiệm thu | CLI cài directory từ source thật. CatalogLoader đọc catalog đã publish tại SHA `4044fbf0545f4be1da51dbc10f1327f0a3da0017`. Preview eligible, Apply completed, Status trả đúng record đã lưu. Kiểm hash/mode/inode và sentinel giữ nguyên. |
| Approval trên Desktop | Cùng entrypoints và service của candidate. Profile riêng cung cấp catalog fixture và seam lỗi/barrier. Stale confirm A → B → A bị bỏ, double-click chỉ tạo một operation, Enter/Space hoạt động. |
| Create-only no-clobber | Foreign leaf xuất hiện ở native barrier trước exclusive create. UI báo failed before writing và `destination_exists`. Toàn bộ fingerprint của foreign tree giữ nguyên. |
| Partial và recovery | `ENOSPC` sau một byte hiển thị ledger với file đã tạo, file còn dở và file chưa thử. Kill helper hoặc plugin parent sau exclusive create cho recovery required. Restart daemon giữ nguyên leaf rỗng và existing sentinel. |
| Mất reply và mở lại Desktop | Giữ reply sau durable terminal. Reload thấy outcome unknown trong lúc chờ Status, rồi khôi phục terminal kết quả. Thoát hẳn Desktop và mở lại cùng profile cũng tìm lại operation qua Status. Audit không có Apply gửi lại. |
| Kiro root, linked worktree, nested | Root và linked gitfile worktree tạo 33 canonical + 33 derived mỗi fixture. Nested tạo 33 canonical. Hash/mode/inode khớp ledger, existing entries giữ nguyên. |
| Product hiện tại | Source entrypoints nguyên bản được load riêng trong daemon nghiệm thu. Preview v2 có mặt, Apply/Status và UI ghi vắng. |

**Typecheck và 158/158 test pass.** Profile chuẩn chạy ngoài Desktop để kiểm catalog và wire path không dùng hook. Lượt Desktop dùng adapter fixture riêng để đặt race đúng thời điểm. [Standard smoke](docs/evidence/local-rc/standard-smoke.json) · [Desktop acceptance](docs/evidence/local-rc/desktop-acceptance.json) · [Cold reopen](docs/evidence/local-rc/desktop-cold-reopen.json) · [Test log](docs/evidence/local-rc/tests.log)

## Trust boundary và quyết định

Receipt bind với host và installation instance đã phát Preview. Status bind với host và installation slot bền qua restart. SDK 0.17.4 không cung cấp caller principal cho handler. Người gọi khác trong cùng trust boundary có thể dùng binding hợp lệ và operation ID phù hợp. Approval UI là xác nhận của client trong profile tin cậy. CLI cài directory tin tưởng plugin code và dependencies, chạy server code unsandboxed trong daemon host.

Crash có thể để lại file đã tạo nhưng còn rỗng hoặc ghi dở. Tình trạng chưa xác minh cần đối soát bằng ledger và Preview mới. Writer không tự resume hoặc xoá target. Advisory lock chỉ bao phủ writer cùng daemon namespace. Không cấp atomicity cho cả plan hoặc containment tuyệt đối khi pinned directory bị move sau kiểm tra cuối.

**GO** cho local source RC trong profile tạm và target fixture trên matrix đã nghiệm thu. Native helper vẫn thực thi fixture gate. **NO-GO** cho cài vào daemon chính, ghi vào project thật, distribution npm/Git/managed và tích hợp SLP trong lượt này.

## Tái kiểm chứng

```sh
npm run typecheck
npm test
node scripts/smoke-local-rc.mjs
node scripts/m45-desktop-acceptance.mjs --local-rc
node scripts/m46-desktop-reopen.mjs <base-tạm-do-driver-Desktop-in-ra>
```

Để chỉ chuẩn bị bản cài không có hook, chạy `node scripts/stage-local-rc.mjs`. Lệnh trả về `cli`, `home`, `plugin`, `targetRoot` và Desktop profile tạm. Khởi động daemon với `"$cli" --home "$home" daemon start`, rồi cài bằng `"$cli" --home "$home" plugin install "$plugin" --json`. Dùng thư mục con fixture dưới `targetRoot` làm target.

Desktop và daemon nghiệm thu đã dừng. Không cài vào daemon chính, stage, commit hoặc push. Không thay đổi SLP.
