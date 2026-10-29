# Mức hỗ trợ RAW đã kiểm thử

Bảng dưới chỉ ghi những mẫu **đã chạy thật**. Một đuôi file không có nghĩa mọi máy/chế độ nén
của đuôi đó đều đọc được. Preview là ảnh JPEG camera nhúng sẵn trong RAW, không phải ảnh giải
mã từ dữ liệu cảm biến.

Nguồn chứng cứ: `tests/integration/raw-preview.test.ts` ghi báo cáo JSON vào
`work/reports/raw-support-<os>-<arch>.json`. Fixture và SHA-256 trong `tests/fixtures/manifest.json`.

## Windows 11 x64 — chế độ phát triển (Node 24.21, ExifTool 13.59, sharp 0.35.5 / libvips 8.18.7) — 28/10/2026

| Định dạng | Máy | Nén | Preview dùng | Kích thước preview | Đủ để soi nét? | Hướng | Giờ chụp | Nguồn không đổi |
|---|---|---|---|---|---|---|---|---|
| CR2 | Canon EOS 5D Mark III | lossless (Compression 6) | PreviewImage | 2560×1707 | Có | 1 | không múi giờ | ✔ |
| CR3 | Canon EOS R6 | C-RAW | JpgFromRaw | 2560×1707 | Có | 1 | có múi giờ (+02:00) | ✔ |
| NEF | Nikon D750 | lossy 12-bit | OtherImage (JpgFromRaw 24,2 MP vượt giới hạn 24 MP nên bị bỏ qua) | 1620×1080 | **Không** | 1 | không múi giờ | ✔ |
| ARW | Sony ILCE-7C | compressed (SonyRawFileType 2) | PreviewImage | 1616×1080 | **Không** | 1 và 8 (dọc) | có múi giờ (+08:00) | ✔ |
| RAF | Fujifilm X-T3 | không nén | PreviewImage | 2560×1707 | Có | 1 | không múi giờ | ✔ |
| DNG | Canon EOS 5D Mark III qua Adobe DNG Converter | lossless | JpgFromRaw | 2560×1707 | Có | 1 | không múi giờ | ✔ |
| JPEG | Sony ILCE-7C | — | chính file JPEG | 2560×1707 | Có | 1 và 8 | có múi giờ | ✔ |

Trường hợp lỗi đã thử:

- ARW bị cắt còn 4 KiB: báo `NO_PREVIEW`, file vẫn nguyên.
- JPEG không có EXIF: giờ chụp báo `missing`, không tự đoán.
- ARW cắt còn 64 KiB vẫn có thumbnail nhúng 160×120 nên **không** bị coi là mất preview (ảnh rất nhỏ, gắn nhãn không đủ soi nét).
- Ảnh dọc (Orientation 8): preview RAW xoay giống JPEG cùng khung (so sánh pixel), và ánh xạ orientation 1–8 khớp auto-rotate của Sharp.

Với ARW/NEF có preview nhỏ, nếu người dùng xác nhận cặp RAW+JPEG thì app dùng JPEG đồng hành làm preview (Task 5).

## Windows 11 x64 — bản đã đóng gói (`win-unpacked` và bản ZIP giải nén)

- ExifTool 13.59 chạy từ `resources/app.asar.unpacked/node_modules/exiftool-vendored.exe/bin/exiftool.exe` (không dùng ExifTool trong PATH).
- `test:installed --workflow` trên 13 fixture: quét, trích preview bằng Sharp trong bản đóng gói, ghép cặp,
  duyệt, xuất có SHA-256 (verified), mở lại giữ quyết định, không request mạng, không còn tiến trình ExifTool,
  SHA-256 toàn bộ fixture không đổi.
- Cùng workflow trên 542 tệp thật (ILCE-7C): xong, xuất verified (không băm thư mục nguồn vì có tệp zip 9,8 GB).
- Bộ cài NSIS đã build nhưng **chưa cài thử** trên máy sạch.

## v0.2 — ảnh phân tích khuôn mặt và LibRaw 0.22.3 (Windows 11 x64, 28–29/10/2026)

Thứ tự nguồn cho ảnh gửi phân tích (`src/worker/ai.ts`): (1) JPEG đi kèm của cặp đã xác nhận / JPEG gốc,
(2) JPEG nhúng lớn nhất nếu cạnh dài ≥ 2.000 px và ≤ 60 MP, (3) giải mã RAW bằng helper LibRaw, (4) nếu LibRaw lỗi:
JPEG nhúng nhỏ (đánh dấu `embedded-small`). Ảnh gửi: cạnh dài ≤ 3.840 px, không phóng to, bỏ EXIF/GPS, ≤ 2,5 MiB.
Ảnh LibRaw đồng thời thay preview hiển thị khi preview nhúng nhỏ (ARW/NEF ở trên trở thành "đủ soi nét" sau khi phân tích).

Giải mã LibRaw đã chạy thật (`tests/integration/libraw.test.ts`, helper `/MT`, camera WB, không auto-bright, sRGB 8-bit):

| Định dạng | Máy | Kết quả LibRaw | Nguồn phân tích được chọn |
|---|---|---|---|
| ARW (compressed) | Sony ILCE-7C | giải mã đủ cảm biến 3968×2648; khung dọc ra dọc (xoay đúng một lần) | LibRaw (preview nhúng chỉ 1616 px) → gửi 3840 px |
| CR2 | Canon 5D Mark III | 5796×3870 | JPEG nhúng (≥ 2000 px) |
| CR3 C-RAW | Canon R6 | giải mã được | JPEG nhúng |
| NEF lossy 12-bit | Nikon D750 | giải mã được | JpgFromRaw toàn khổ (trước đây bị giới hạn 24 MP của preview bỏ qua) → gửi 3840 px |
| RAF | Fujifilm X-T3 | giải mã được | JPEG nhúng |
| DNG (Adobe converter) | Canon 5D Mark III | giải mã được | JPEG nhúng |
| ARW bị cắt | — | `RAW_UNSUPPORTED`/`RAW_*`, không có kết quả giả | báo lỗi cụ thể → Cần xem lại |

Hủy/timeout: helper bị kết thúc và slot xử lý chỉ được trả sau khi tiến trình đã thoát. Đường dẫn tiếng Việt: đọc được.
Scan và phân tích dùng chung một cổng tuần tự cho LibRaw: không chạy hai helper đồng thời dù máy có nhiều slot ảnh.
JPEG gốc/đồng hành 61 MP được thu nhỏ khi đọc (giới hạn JPEG 100 MP); giới hạn 60 MP vẫn áp cho giải mã RAW.
Không có demosaic pack, RawSpeed, DNG SDK, zlib, libjpeg: DNG nén lossy-JPEG và một số định dạng hiếm không giải mã được bằng LibRaw
(vẫn dùng JPEG nhúng nếu có).

Bản đóng gói 0.2.0 (bộ cài NSIS cài im lặng vào `C:\SICPR\work\install-0.2` và bản ZIP giải nén):
`resources/bin/eventstory-raw.exe` báo `0.22.3-Release` và giải mã ARW mẫu 3968×2648; mã nguồn LibRaw
(`LibRaw-0.22.3.tar.gz`, SHA-256 `789f3c33…27e4`), COPYRIGHT, LICENSE.CDDL, BUILD.md nằm trong `resources/licenses/LibRaw/`.
Workflow 0.2 (quét → AutoCull → xuất ảnh đã chọn → mở lại) chạy trên 13 fixture và trên album thật 542 tệp ARW+JPG (ILCE-7C):
xuất verified, nguồn không đổi SHA-256. Máy cài là máy phát triển, chưa phải máy sạch.

## macOS 14+ arm64 / x64

**Chưa kiểm thử.** Cấu hình build đã có, nhưng chưa build/chạy trên máy Mac nào. Không coi là hỗ trợ.
