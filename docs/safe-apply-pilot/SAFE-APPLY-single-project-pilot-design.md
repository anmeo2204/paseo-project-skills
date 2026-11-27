# Safe Apply — Thiết kế pilot cho một project thật

**Baseline:** RC `687542a440b8bc5bac15e1fa0b24e9dca8c4900d` và [báo cáo standalone pilot](/private/var/folders/tv/40j0n6b921xgcz_wgw7h0mn00000gn/T/pps-m43-local-rc-AjnBz0/SAFE-APPLY-standalone-pilot-report.md).

**Quyết định hiện tại: NO-GO cho ghi trực tiếp với RC `687542a`.** Standalone pilot đã pass trên bản sao độc lập. Candidate tiếp theo cần khóa quyền ghi vào đúng một canonical project root, rồi qua nghiệm thu trên bản sao trước khi xét dùng trên project thật. Đây là proposal. Fixture gate của RC hiện tại giữ nguyên.

[Báo cáo local RC trong repo](../../SAFE-APPLY-local-RC-report.md)

## 1. Opt-in phía daemon và khóa scope

Một profile Desktop, một daemon home riêng, một installation slot và một root. Mặc định Preview-only. Người vận hành bật opt-in bằng cấu hình private phía daemon. Cấu hình chỉ nhận một canonical absolute path chính xác, policy revision và identity đã ghi nhận lúc enrollment. Từ chối nhiều root, wildcard, symlink, alias và mọi target con. Đổi root hoặc bật lại sau khi root bị thay cần enrollment và Preview mới.

Khi enrollment, native code mở từng thành phần của đường dẫn bằng directory handle và `O_NOFOLLOW`. Policy lưu identity của root và chuỗi ancestor đã xác minh, gồm volume identity, `dev`/`ino` và metadata an toàn cần thiết. Khi daemon restart, nếu identity đã lưu không còn xác minh được, giữ Preview-only cho đến khi enrollment lại. Một directory mới tại cùng pathname không kế thừa quyền ghi.

| Điểm kiểm tra | Hành vi đề xuất |
| --- | --- |
| Preview v2 | Chỉ trả eligible khi canonical path khớp chính xác, native probe xác minh được root đã enrollment, môi trường hợp lệ, có ít nhất một file cần tạo và mọi entry thuộc loại create hoặc unchanged. Conflict/blocked chặn cả lượt. Plan toàn unchanged trả no-op. Receipt bind policy revision và identity của root ngoài các binding hiện có. |
| Apply admission | RPC chỉ nhận receipt binding, operation ID và approval literal. Dưới coordinator lock, daemon kiểm lại policy, host/installation, receipt lifetime, pinned catalog, read-set và root identity trước durable admission ACK. Target ngoài scope hoặc root bị thay sẽ bị từ chối trước target mutation. |
| Native write boundary | Helper nhận policy enrollment từ daemon qua kênh private và đối chiếu độc lập với root/ancestor handles. Kiểm linkage trước và sau mutation, kể cả sau khi chờ ACK. Chỉ dùng `mkdirat` và exclusive create qua parent handle đã pin. Foreign leaf xuất hiện muộn làm lượt ghi dừng. |

Nếu pinned directory bị move sau lần kiểm tra cuối và trước syscall, syscall có thể tạo entry trong directory cũ. Helper phải dừng khi phát hiện và báo `partial_failure` hoặc `recovery_required` theo evidence. Directory thay thế không được cấp quyền ghi. Nếu pilot yêu cầu tuyệt đối không có mutation trong directory đã bị move, thiết kế này là **NO-GO** cho đến khi có cơ chế OS-enforced phù hợp.

## 2. Đối soát sau crash hoặc mất reply

1. Giữ operation ID và gọi `apply.status.v1` trên đúng host/slot. Reply mất hoặc Status chưa xác định không đủ để kết luận chưa có ghi.
2. So ledger với filesystem. Đối chiếu path, inode, mode và hash khi có evidence. Phân biệt file hoàn tất, file còn dở, file chưa thử và entry có ownership chưa xác minh. Nội dung khớp hash tự nó không chứng minh ownership sau crash.
3. Giữ nguyên final paths để review. Không tự retry Apply, resume, xóa file hoặc rollback. Chạy Preview mới sau khi đối soát. File dở hoặc conflict tiếp tục chặn cả plan cho đến khi được xử lý ngoài Safe Apply.

Việc tắt quyền ghi hoặc mất enrollment vẫn phải cho phép Status chỉ đọc đối với operation cũ trong host/slot gốc.

## 3. Trust boundary

SDK **0.17.4 thiếu caller principal**. Client có quyền gọi plugin RPC trên daemon host và truy cập installation slot có thể gọi Apply nếu giữ receipt binding hợp lệ, hoặc tra Status nếu có operation ID phù hợp. Daemon không thể xác minh ai đã bấm xác nhận trên UI.

Daemon riêng chỉ phục vụ các client và tiến trình mà người vận hành chấp nhận tin cậy ngang nhau. Receipt binding và operation ID phải được giữ trong boundary đó. Nếu cần phân quyền từng người, truy vết danh tính người duyệt hoặc chia sẻ daemon với caller không tin cậy, pilot là **NO-GO** với SDK hiện tại.

## 4. Tiêu chí GO/NO-GO trên bản sao

Nghiệm thu đúng candidate định cài qua directory install thật trên **macOS arm64, local APFS case-insensitive, Paseo 0.17.5 và SDK 0.17.4**. Dùng bản sao độc lập, cùng cấu hình một root và entrypoints dự kiến ship.

| Ca bắt buộc | Điều kiện pass |
| --- | --- |
| Opt-in và ngoài scope | Khi tắt opt-in, environment lệch, hoặc target là sibling, nested path hay alias, Preview vẫn đọc được khi phù hợp và không eligible. Gọi Apply trực tiếp không tạo target mutation. |
| Root replacement | Thay root tại cùng pathname trước Preview, sau Preview và ở native barrier. Root thay thế giữ nguyên bytes, mode và inode. Ca move sau last check trả partial/recovery nếu đã mutation qua handle cũ. |
| No-clobber | Chèn foreign leaf ngay trước create và cho hai writer tranh cùng leaf. Foreign entry giữ nguyên hash, mode và inode. Cùng leaf chỉ có một exclusive create thành công. |
| Crash recovery | Kill sau exclusive create, trước khi ghi nhận completion. Sau restart, Status theo operation ID trả recovery và ledger khớp evidence filesystem. Không phát sinh Apply lại, resume hoặc cleanup. |
| Luồng bình thường | Desktop xác nhận đúng receipt, Status khớp file đã tạo, existing entries giữ nguyên và Preview lại cùng selection báo no-op. |

**GO có điều kiện** cho đúng một project khi toàn bộ ca pass, người vận hành chấp nhận trust boundary và đã diễn tập đối soát crash trên bản sao. **NO-GO** nếu còn ca chưa xác minh, root thay thế có thể tự nhận quyền ghi, foreign entry bị chạm, hoặc yêu cầu caller identity hay containment vượt quá thiết kế.

Lượt này chỉ xuất proposal. Không sửa RC, project gốc, daemon chính hoặc SLP. Không commit hoặc push.
