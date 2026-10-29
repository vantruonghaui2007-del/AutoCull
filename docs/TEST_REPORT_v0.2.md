# Báo cáo kiểm thử — EventStory Cull 0.2.0

Máy: Windows 11 x64, Node 24.21, Electron 45, ExifTool 13.59, Sharp 0.35.5, LibRaw 0.22.3 (MSVC 14.51, `/MT`).
Nhánh `feat/v0.2`. Báo cáo máy đọc được nằm trong `C:\SICPR\work\reports\` (không đưa vào repository vì chứa đường dẫn ảnh riêng).

## 1. Tóm tắt nghiệm thu

| Hạng mục | Trạng thái | Bằng chứng |
|---|---|---|
| Kiểm thử tự động (typecheck, unit, integration, electron, backend) | **Đạt** | mục 2 |
| Luồng RAW → AutoCull → sửa lựa chọn → xuất nguyên bản trên **bản cài đóng gói** Windows | **Đạt** (không AI) | mục 3 |
| Backend trên **AWS thật** (deploy, live test, opt-out, quota thật) | **Chưa nghiệm thu** — chưa có thông tin đăng nhập AWS trên máy | mục 5 |
| Phân tích khuôn mặt bằng Rekognition thật trên ảnh MinhNguyen | **Chưa nghiệm thu** (cùng lý do) | mục 5 |
| Chất lượng AI (≥1.000 ảnh có nhãn: winner ≥85%, nhắm mắt P/R ≥90%…) | **Chưa nghiệm thu** — chưa có bộ ảnh gán nhãn; ranking ở trạng thái **experimental** | mục 6 |
| macOS (arm64/x64) | **Chưa kiểm thử** — không có máy Mac | mục 7 |
| Bộ cài trên máy sạch | **Chưa** — đã cài im lặng và chạy smoke trên máy phát triển | mục 3 |

Mock/giả lập chỉ dùng để kiểm logic. Không có kết luận nào về AWS, chất lượng AI hay bộ cài trên máy sạch được rút ra từ mock.

## 2. Kiểm thử tự động

| Bộ | Kết quả 0.2 | Baseline 0.1 | Ghi chú |
|---|---|---|---|
| `npm run typecheck` | sạch | sạch | |
| `npm run test:unit` | 113/113 | 70 | ranking 20, selection 8, faces 4, groups 11, queue 3, serial gate, reasons, icons, … |
| `npm run test:integration` | 118/118 (+1 phép đo album thật opt-in bỏ qua) | 67 | Gồm revision sống, race xóa asset, hủy HTTP, portable v1, cache prep-v2 cũ và ảnh nguồn bị mất/stale. |
| `npm run test:electron` | 26/26 | 17 | ai 3, autocull 5, groups-large (nhóm 450 ảnh) 1, review 7, workflow 1, shell 9 |
| `backend: npx vitest run` | 18/18 | — | auth, quota, idempotency/409, takeover có owner, transaction token, POST/GET TTL 24 h, ánh xạ không tuổi/giới tính |
| `sam validate --lint`, `sam build` | đạt | — | |

Phần AI trong integration/electron chạy **handler backend thật** trên 127.0.0.1 với store trong bộ nhớ và provider giả
(quyết định "nhắm mắt" theo màu ảnh để biết trước kết quả). Đây là kiểm logic, không phải AWS.

Các tình huống bắt buộc đã có test logic: hai request đồng thời cùng key chỉ một lượt provider; token sai/ảnh quá lớn/hết
quota không gọi provider; mất response được đọc lại không tính phí lần hai; response muộn cho nội dung đã đổi bị bỏ;
tệp thay cùng tên không dùng lại phân tích cũ; hủy/tiếp tục AutoCull không gửi lại; mất mạng → tạm dừng có thông báo,
album vẫn dùng được; quyết định thủ công thắng, đặt lại "chưa duyệt" khôi phục tự động; chạy lại không ghi đè quyết định;
dự án v1 nâng cấp có sao lưu, lỗi thì rollback; undo, ghép cặp, tệp phiên cũ vẫn dùng được; nhóm 450 ảnh hiển thị đủ và
nhãn cập nhật; xuất từ lựa chọn hiệu lực, từ chối khi lựa chọn/metadata/kết quả AutoCull đổi sau xem trước; nguồn giữ nguyên SHA-256.

## 3. Bản đóng gói Windows 0.2.0

Sản phẩm: `release/0.2.0/EventStory-Cull-0.2.0-win-x64-setup.exe` (NSIS, chưa ký số) và `EventStory-Cull-0.2.0-win-x64.zip`.

Đã dựng lại từ mã `f417475`, kiểm cả ASAR có sửa lỗi cuối (không tự chọn lại ảnh missing/stale), helper và hướng dẫn
đi kèm. Bảng dưới là lần kiểm **sau review**, ngày 29/10/2026. Bản cài/ZIP vẫn chưa ký số và chỉ dành thử nghiệm nội bộ.

| Lần chạy | Kết quả |
|---|---|
| Bộ cài NSIS cài im lặng vào thư mục mới `C:\SICPR\work\install-v02-reviewed-20261029-012255`, workflow 13 fixture | passed: quét 5,35 s, AutoCull tạm dừng vì chưa cấu hình AI (đúng thiết kế), xuất ảnh đã chọn verified, mở lại giữ quyết định, không request mạng từ renderer, không còn tiến trình ExifTool, fixture không đổi SHA-256; RAM Electron đỉnh ~647 MB |
| Cùng bộ cài, album thật MinhNguyen 542 tệp (271 ARW + 271 JPG, Sony ILCE-7C) | passed: quét 92,99 s, AutoCull thêm 3,00 s, xuất 2 ảnh logic (2 ARW + 2 JPG + 2 XMP, manifest) verified; nguồn không đổi SHA-256, mở lại giữ lựa chọn, không còn helper; RAM Electron đỉnh ~702 MB |
| Bản ZIP giải nén vào thư mục mới, workflow 13 fixture | passed: quét 3,98 s, xuất verified, mở lại giữ lựa chọn; RAM Electron đỉnh ~629 MB |
| Helper LibRaw đóng gói | `0.22.3-Release`; giải mã ARW mẫu 3968×2648; tarball nguồn đúng SHA-256; COPYRIGHT/LICENSE.CDDL/BUILD.md có mặt |
| Icon | `build/icon.ico` (16–256 px) cho exe/bộ cài/shortcut, `resources/icon.png` cho cửa sổ |

Báo cáo JSON gốc: `C:\SICPR\work\reports\v0.2\review-final\` gồm `installer/`, `zip/`, `real-album/`.
Số đo RAM là tổng working set các tiến trình Electron qua `app.getAppMetrics()`, không gồm ExifTool/perl; một lần chạy,
không phải benchmark có lặp hay phép nghiệm thu 1.000 RAW trên máy 8 GB. Không có lượt Rekognition thật trong các lần trên.

## 4. Album thật, không AI (phép đo worker trước review, `tests/integration/real-album.test.ts`)

271 ảnh logic sau ghép cặp; 202 nhóm (44 nhóm nhiều ảnh, lớn nhất 5); AutoCull 0,13 s (không có phân tích → tất cả
"Cần xem lại", đúng thiết kế); truy vấn trang 200 ảnh theo danh sách 7–94 ms; RSS đỉnh của worker test 306 MiB; nguồn không đổi.

## 5. AWS thật — chưa nghiệm thu

Đã chuẩn bị và được phép (deploy stack `eventstory-cull-pilot` ở ap-southeast-1, bật AI opt-out qua CLI, ~60 lượt thử),
nhưng máy chưa có profile `eventstory` (`~/.aws/config` không tồn tại). Khi có đăng nhập, chạy theo `backend/README.md`:
opt-out → `sam deploy` → `scripts/token.mjs create` → `scripts/live-test.mjs` → AutoCull 10–50 ảnh MinhNguyen trong app.
Đơn giá DetectFaces ap-southeast-1 đã xác minh từ Price List công khai: 0,0013 USD/ảnh (`docs/COST_ESTIMATE.md`).

## 6. Chất lượng AI — chưa nghiệm thu

Không có bộ ≥1.000 ảnh gán nhãn trước (3 sự kiện, 150 burst, 100 mặt nhắm rõ). Ngưỡng mắt, trọng số 5 tiêu chí và quy tắc
nhóm là mặc định thử nghiệm (`quality-v2`: thêm sàn nét tuyệt đối và chất lượng nét mặt provider), được kiểm bằng test đơn vị theo từng quy tắc, **không** phải bằng
số liệu chính xác. Gộp nhầm/nhắm mắt P/R/winner được chấp nhận: chưa đo. Cần gán nhãn bộ ảnh trước khi tuyên bố chất lượng.

## 7. macOS — chưa kiểm thử

`native/build-raw-helper.sh` và cấu hình electron-builder cho mac đã viết nhưng chưa chạy trên Mac. Không phát hành bản Mac.

## 8. Rà soát độc lập

Xem `docs/REVIEW_v0.2.md` và mục cuối `.superpowers/sdd/v0.2/progress.md` (kết quả review và các sửa đổi).
