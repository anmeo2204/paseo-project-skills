# M2 — Final Sign-off

Ngày xác minh: **2026-11-27**. **PASS trong phạm vi nghiệm thu M2 đã được user phê duyệt; sẵn sàng lập kế hoạch M3.** Lượt sign-off chỉ bổ sung báo cáo này, không triển khai M3.

## 1. Completed milestones M2.1–M2.5

- **M2.1:** Catalog Loader qua Git/SSH, pin commit, validate metadata, snapshot/cache và `catalog.load`.
- **M2.2:** Project Scanner chỉ đọc, nhận diện technology/workspace boundaries, evidence và existing skill/rule inventory qua `target.scan`.
- **M2.3:** Agent capability registry, structured executor, preflight và cleanup; production execution vẫn đóng khi chưa có verified profile.
- **M2.4:** Applicability Contract v1, 19 catalog sidecars, deterministic engine và `recommendation.evaluate`; tích hợp remote đã nghiệm thu ở M2.4D.
- **M2.5:** Desktop Scan & Recommend, evidence/inventory details, manual/bulk selection và memory-only selection intent.

## 2. Architecture decisions

Catalog, filesystem scan và recommendation chạy trên daemon của host được chọn. Catalog dùng tag namespace hoặc full SHA, không fallback branch; snapshot giữ metadata/bytes từ cùng commit. Scanner độc lập provider/catalog, có allowlist và resource budgets. Engine đọc declarative sidecars như dữ liệu, đánh giá cùng boundary và giữ provenance tới catalog blob/project evidence.

Verdict hiện hành là Recommended, Optional hoặc Unknown; inventory độc lập applicability, task applicability luôn `not_assessed`. UI pin catalog qua một preflight rồi mở một recommendation subscription; request/host/target/settings identity ngăn stale events. Target Providers thể hiện installation intent, không quyết định quyền chạy AI. Selection bắt đầu rỗng và không cấp quyền ghi.

## 3. Automated và runtime verification

**Chạy lại trong lượt sign-off:** Node **22.23.4**, `npm run typecheck` **PASS**, `npm test` **77/77 PASS**, 0 fail/cancel/skip; `git diff --check` và diff toàn dải M2 đều **PASS**. React test renderer còn cảnh báo deprecation đã biết.

**Đối chiếu bằng chứng runtime đã nghiệm thu, không chạy lại Desktop trong lượt này:** M2.1–M2.4D xác minh production RPC/subscription trên Paseo 0.17.4. M2.4D ghi nhận **12/12 fixtures, 228/228 verdict**, đủ 19 skills, legacy compatibility, evidence integrity, lifecycle và target hashes không đổi. M2.5 nghiệm thu Desktop/daemon thật 0.17.5 với hai host, selection, cancel, offline/reconnect, reload, catalog errors và read-only hashes; metrics ghi 0 agents.

Đã đọc các completion/integration reports, kiểm tra relative references và mở đủ [sáu screenshots M2.5](M2.5-completion-report.md#4-screenshots-thực-tế): project picker, partial recommendations, inventory, evidence, selected skills và catalog error đều khớp nội dung báo cáo.

**Git và hygiene:** Repository `paseo-project-skills`, branch `main`, upstream `origin/main`, remote `git@github.com:anmeo2204/paseo-project-skills.git`. Working tree/index ban đầu sạch; toàn bộ implementation M2 đã committed. Review dải sau Foundation `b4b08fc` đến `a5ff65fdca739a59df9be25939502b6b852be8fb` gồm 10 commits, 64 changed files; không có uncommitted implementation để stage lại. Remote `refs/heads/main` khớp HEAD này trước sign-off.

Kiểm tra thay đổi M2 không phát hiện credential patterns hoặc tracked credential/temp artifacts. `node_modules/` là dependency directory được ignore. Path tuyệt đối trong test projection là synthetic fixture; screenshots giữ temp fixture paths và nhãn host của lượt smoke, không phải cấu hình runtime hardcode. Không phát hiện đường dẫn máy cá nhân trong implementation.

**Project-Skills migration:** Checkout riêng sạch, HEAD và remote `refs/heads/main` cùng là **`4044fbf0545f4be1da51dbc10f1327f0a3da0017`**. Đã kiểm tra commit migration và báo cáo M2.4B; M2.4D xác minh production fetch cùng SHA, 19 entrypoints, 40 supporting files, 19/19 valid sidecars. Không sửa hoặc commit repository catalog. Commit sign-off chỉ stage báo cáo này; full SHA, kết quả push và final working tree được xác nhận sau commit trong thông báo bàn giao.

## 4. SDK/Desktop compatibility

Dependencies `@getpaseo/client`, `plugin`, `protocol` tiếp tục pin **0.17.4**. Runtime RPC/subscription đã qua nghiệm thu daemon 0.17.4 và Desktop/daemon **0.17.5**. M2.5 xác minh `aria-checked`/`aria-expanded` trên Desktop accessibility. Kết quả này chỉ xác nhận luồng deterministic hiện có, không xác nhận live AI executor trên 0.17.5; profile guard hiện yêu cầu 0.17.4.

## 5. Known limitations

Scanner phù hợp local-first, không phải adversarial filesystem sandbox. Metadata/depth/byte/time budgets có thể tạo Partial; deadline hợp tác không ngắt syscall đang chạy. Không thực thi project config; runtime DB/queue và provider activation không được suy ra từ markers. Target có thể đổi sau scan. Kill cứng có thể để lại catalog staging hoặc ngắt agent cleanup reconciliation.

Windows/Linux, Desktop compact/dark và keyboard-only walkthrough chưa nghiệm thu runtime. Reload/host-switch đúng lúc recommendation subscription đang chạy có automated coverage nhưng chưa có controlled Desktop race. Chi tiết NOT TESTED được giữ trong từng report.

## 6. Deferred AI execution capability

Chưa ship approved execution profiles hoặc nối executor vào recommendation/UI. Provider availability không đồng nghĩa production eligibility. Live model turns, native structured output và provider cancellation/isolation chưa được xác minh; giữ fail-closed. Việc bật AI cần một phạm vi review/runtime verification riêng, không thuộc sign-off này.

## 7. Current implementation boundaries

M2 dừng ở đọc catalog/project, deterministic recommendations, existing inventory và lựa chọn trong bộ nhớ. Chưa có Preview, Provider Adapters, Safe Apply, ghi/overwrite target, persistent selection hoặc AI-assisted recommendations. SLP/Kanbanly và Paseo Core độc lập, không bị thay đổi bởi M2.

## 8. Readiness for M3

**GO cho planning M3** dựa trên phạm vi M2 đã PASS. Pinned catalog, evidence contracts và `SelectionIntentV1` là đầu vào cho Preview/Provider Adapters. M3 cần xác định proposed changes, provider mapping và review semantics riêng; quyền ghi Safe Apply thuộc milestone sau. Không có công việc M3 được triển khai trong lượt này.

## 9. Completion report references

- [M2.1 — Catalog Loader](M2.1-completion-report.md)
- [M2.2 — Project Scanner](M2.2-completion-report.md)
- [M2.3 — Agent Capability](M2.3-completion-report.md)
- [M2.4 — Applicability Contract v1](M2.4-applicability-contract.md)
- [M2.4B — Catalog metadata migration, pinned commit](https://github.com/anmeo2204/project-skills/blob/4044fbf0545f4be1da51dbc10f1327f0a3da0017/M2.4B-catalog-metadata-report.md)
- [M2.4C — Recommendation Engine](M2.4C-completion-report.md)
- [M2.4D — Remote integration verification](M2.4D-integration-report.md)
- [M2.5 — Scan UI và Desktop screenshots](M2.5-completion-report.md)
