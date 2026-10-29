# Giấy phép, thành phần native và quyền dữ liệu

Kiểm kê ngày 28/10/2026 (v0.2, Task 1), cập nhật 29/10/2026 (Task 7: LibRaw, AWS SDK). Đây là ghi nhận kỹ thuật, không phải ý kiến pháp lý.
Mã nguồn ứng dụng: **UNLICENSED / private** cho tới khi chủ sở hữu quyết định.

## 1. Gói npm đi trong ứng dụng

Xem `docs/license-inventory.md` (sinh bằng `node scripts/license-inventory.mjs`): 17 gói, tất cả có giấy phép
khai báo và tệp license (MIT, ISC, Apache-2.0, CC0-1.0, và `Apache-2.0 AND LGPL-3.0-or-later` cho Sharp Windows).
Giấy phép khai trong `package.json` của gói wrapper **không** đại diện cho binary bên trong — xem mục 2.

## 2. Thành phần native/binary (audit riêng)

| Thành phần | Nằm ở | Giấy phép xác định được | Nghĩa vụ chính | Trạng thái phát hành |
|---|---|---|---|---|
| ExifTool 13.59 (Phil Harvey, script Perl) | `exiftool-vendored.exe/bin/exiftool_files/exiftool.pl` | "same terms as Perl itself" = Artistic License 1.0 **hoặc** GPL-1.0-or-later (README của gói; exiftool.org) | Giữ thông báo bản quyền; phân phối nguyên vẹn | OK (đã có trong `LICENSES/THIRD_PARTY.md`) |
| Launcher `exiftool.exe` | `exiftool-vendored.exe/bin/exiftool.exe` | CC0-1.0 (windows_exiftool.txt) | Không | OK |
| Strawberry Perl 5.32 runtime (`perl.exe`, `perl532.dll`, thư viện) | `exiftool_files/` | Perl: Artistic/GPL; các thư viện kèm theo có license riêng trong `Licenses_Strawberry_Perl.zip` (198 mục: bzip2, expat, freetype FTL/GPL-2, BerkeleyDB, …) | Giữ nguyên `Licenses_Strawberry_Perl.zip` khi phân phối | OK nếu giữ nguyên thư mục (đang giữ, asarUnpack) |
| `libgcc_s_seh-1.dll`, `libstdc++-6.dll`, `libwinpthread-1.dll` | `exiftool_files/` | Có tệp `LICENSE` = văn bản GPL-3.0 chuẩn (SHA-256 `3972dc97…`) không ghi rõ áp cho thành phần nào. Theo thông lệ GCC: GPL-3.0 + GCC Runtime Library Exception; winpthreads: MIT/ZPL | **Cần xác minh** với upstream exiftool-vendored/Strawberry Perl | **Cần xác minh trước phát hành công khai**. Dùng nội bộ/pilot: chấp nhận được nếu chủ sở hữu đồng ý |
| `liblzma-5__.dll` | `exiftool_files/` | xz/liblzma: 0BSD/public domain (theo upstream) | Không | OK (ghi nhận) |
| libvips 8.18.7 + thư viện (aom, archive, cairo, cgif, exif, expat, ffi, fontconfig, freetype, fribidi, glib, harfbuzz, heif, highway, imagequant, lcms, mozjpeg, pango, pixman, png, proxy-libintl, rsvg, tiff, uhdr, webp, xml2, zlib-ng) | `@img/sharp-win32-x64/lib/libvips-42.dll` (liên kết động) | libvips LGPL-3.0-or-later; danh sách giấy phép từng thư viện theo `THIRD-PARTY-NOTICES.md` của dự án sharp-libvips (versions.json trong gói khớp bản dựng) | LGPL: phân phối dạng thư viện động có thể thay thế, kèm thông báo và chỉ dẫn lấy mã nguồn | OK: DLL được asarUnpack, có thể thay; cần chép `THIRD-PARTY-NOTICES` của sharp-libvips vào `LICENSES/` trước phát hành |
| Electron 45 (Chromium, Node.js, ffmpeg) | thư mục cài | MIT + `LICENSES.chromium.html` (electron-builder tự kèm) | Giữ tệp | OK |
| **LibRaw 0.22.3** | `resources/bin/eventstory-raw.exe` (liên kết tĩnh, `/MT`) | **CDDL-1.0** (chọn theo kế hoạch; LibRaw cho chọn LGPL-2.1 hoặc CDDL-1.0) | Giữ COPYRIGHT/LICENSE.CDDL; cung cấp mã nguồn LibRaw tương ứng + mọi patch + hướng dẫn build; không thêm demosaic pack | OK: không sửa mã LibRaw (không có patch); tarball upstream SHA-256 `789f3c33…27e4`, COPYRIGHT, LICENSE.CDDL và `native/README.md` (hướng dẫn build) đi kèm bản cài tại `resources/licenses/LibRaw/` — kiểm trong smoke bản cài 0.2.0. Mã helper `native/raw-helper/eventstory-raw.cpp` là của EventStory |
| **AWS SDK for JavaScript v3** (backend, không nằm trong app desktop) | `backend/` → bundle Lambda | Apache-2.0 (28 gói Apache-2.0, 3 MIT, 1 0BSD — `backend/THIRD_PARTY.md`) | Giữ thông báo khi phân phối lại | OK: Lambda chỉ deploy vào tài khoản AWS của chủ sở hữu, không phân phối cho bên thứ ba; danh mục và thông báo trong `backend/THIRD_PARTY.md` |

Dịch vụ Amazon Rekognition được dùng qua API theo điều khoản dịch vụ AWS; không lấy hay phân phối model.
Không dùng mã, model, giao diện hay tài sản của Aftershoot, Narrative, Imagen, Adobe, FilterPixel.

## 3. Quyền sử dụng dữ liệu thử nghiệm

| Bộ dữ liệu | Nguồn | Thử nội bộ | Gửi cloud (Rekognition) | Ghi chú |
|---|---|---|---|---|
| 5 mẫu RAW raw.pixls.us (CR2, CR3, NEF, RAF, DNG) | CC0-1.0 | Có | Có (CC0; ảnh vật thể, không có người) | Tải lại bằng `npm run fixtures` |
| Ảnh người dùng `C:\Users\vantr\OneDrive\Ảnh\MinhNguyen` (271 ARW + 271 JPG, Sony ILCE-7C) và fixture trích từ đó | Người dùng | Có | **Có** — người dùng xác nhận có quyền và có đồng ý của người trong ảnh (28/10/2026, trong phiên làm việc) | Không đưa vào repository, ZIP hay CI công khai |
| Ảnh tổng hợp do test tạo | Sinh trong test | Có | Không cần gửi | |
| Bộ nghiệm thu chất lượng ≥1.000 ảnh có nhãn | **Chưa có** | — | — | Chất lượng AI chưa nghiệm thu |

Ảnh gửi đi là JPEG phân tích (thu nhỏ, đã bỏ EXIF/GPS), không bao giờ là tệp RAW gốc.
