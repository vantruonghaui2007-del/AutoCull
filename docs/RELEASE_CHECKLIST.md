# Release checklist

Đánh dấu bằng kết quả thật trên từng hệ điều hành/kiến trúc. Ô không có bằng chứng giữ nguyên "chưa kiểm thử".

## v0.2 — trạng thái nghiệm thu (29/10/2026)

- Windows 0.2.0: bộ cài NSIS đã cài im lặng trên **máy phát triển**, bản ZIP đã giải nén; cả hai chạy được workflow
  quét → AutoCull không AI → sửa thủ công → xuất nguyên bản có SHA-256 → mở lại. Album MinhNguyen 542 tệp cũng đạt.
  Không coi đây là kiểm thử trên máy sạch hay chứng minh AI hoạt động.
- Bản dựng sau sửa review (`f417475`) đã chạy lại toàn bộ test và smoke của NSIS/ZIP/album thật; bằng chứng mới nhất
  nằm trong `docs/TEST_REPORT_v0.2.md` (118 integration, 26 Electron, RAW→export verified).
- **Chưa nghiệm thu:** AWS thật và AI opt-out (chưa có profile đăng nhập), chất lượng trên bộ ≥1.000 ảnh gán nhãn,
  máy 8 GB với 1.000 RAW 24 MP, Lightroom Classic, Mac và Windows máy sạch.
- **Chưa phát hành công khai:** chưa ký số; giấy phép runtime GCC/Strawberry Perl kèm ExifTool còn cần xác minh
  (`docs/LICENSES.md`). Các tệp cài đặt hiện chỉ là ứng viên thử nghiệm nội bộ, không phải bản đã nghiệm thu.

## Bằng chứng v0.1 (lịch sử, không thay cho nghiệm thu v0.2)

## Ma trận

| Mục | Windows 11 x64 | macOS 14+ arm64 | macOS 14+ x64 |
|---|---|---|---|
| `npm run typecheck`, unit, integration, Electron | ✔ 28/10/2026 | chưa kiểm thử | chưa kiểm thử |
| `package:dir` + `test:installed --workflow` (fixtures) | ✔ (exportStatus verified, không còn tiến trình ExifTool, nguồn giữ nguyên SHA-256) | chưa kiểm thử | chưa kiểm thử |
| Bản ZIP giải nén + `test:installed --workflow` | ✔ | — | chưa kiểm thử |
| Bộ cài NSIS được build | ✔ (`EventStory-Cull-0.1.0-win-x64-setup.exe`, chưa ký) | — | — |
| Cài bằng NSIS rồi chạy smoke | **chưa chạy** (cài đặt ghi registry/Start menu của người dùng — cần chạy trên máy thử riêng) | — | — |
| DMG build | — | chưa kiểm thử | chưa kiểm thử |
| Ký mã / notarize | chưa ký | chưa ký, cần máy Mac + tài khoản Apple Developer | như trên |
| Offline (không mạng) | renderer không có request mạng (kiểm trong smoke) | chưa kiểm thử | chưa kiểm thử |
| 1.000 ảnh trên máy 8 GB | chưa kiểm thử | chưa kiểm thử | chưa kiểm thử |
| 1.000 ảnh trên máy 16 GB | một phần: 542 tệp thật (271 ARW + 271 JPG) | chưa kiểm thử | chưa kiểm thử |
| Ổ đầy / ổ chỉ đọc / rút thẻ khi xuất | mô phỏng trong test (mất tệp nguồn, nguồn đổi khi copy); chưa thử ổ đầy thật | chưa kiểm thử | chưa kiểm thử |
| Lightroom Classic import | chưa nghiệm thu (xem LIGHTROOM_ACCEPTANCE.md) | chưa kiểm thử | chưa kiểm thử |

## Số đo đã có (Windows 11, 16 GB, 4 metadata + 2 image jobs, bản ZIP đóng gói)

| Bộ ảnh | Preview đầu tiên | Quét + preview xong | Đỉnh bộ nhớ (tổng tiến trình Electron) |
|---|---|---|---|
| 13 fixture (6 định dạng RAW + JPEG) | 2,3 s | 4,0 s | ~620 MB |
| 542 tệp thật Sony ILCE-7C (ARW nén + JPG) | 2,9 s | 85,7 s | ~734 MB |

Một lần chạy mỗi bộ; không phải benchmark có lặp. Đỉnh bộ nhớ không gồm tiến trình ExifTool/perl.
Bộ 1.000 JPEG tổng hợp 64×48 (test hàng đợi, không phải RAW): 13,8 s — `tests/integration/scan-1000.test.ts`.

## Trước khi phát hành

1. `npm ci` trên máy build sạch của từng hệ điều hành/kiến trúc (Sharp cài gói `@img/sharp-<os>-<arch>` đúng máy).
2. `npm run fixtures` (cần ảnh mẫu của người dùng cho ARW/JPG, hoặc thay bằng mẫu khác và cập nhật manifest).
3. Chạy toàn bộ test + `npm run dist` + `npm run test:installed -- --app <bản cài> --fixtures tests/fixtures/files --workflow`.
4. Cài bộ cài thật trên máy thử (không phải máy dev), chạy lại smoke, gỡ cài đặt.
5. macOS: ký bằng Developer ID và notarize — chỉ trên Mac, bí mật lấy từ biến môi trường
   (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), không lưu vào repo.
6. Windows: ký bằng chứng thư code signing nếu có (`CSC_LINK`/`CSC_KEY_PASSWORD` hoặc dịch vụ ký).
7. Cập nhật RAW_SUPPORT.md, LIGHTROOM_ACCEPTANCE.md và bảng trên bằng kết quả thật.
