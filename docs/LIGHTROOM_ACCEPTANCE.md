# Nghiệm thu với Lightroom Classic — **CHƯA THỰC HIỆN**

Máy phát triển có Lightroom Classic **12.0** (bản 202210031128). Import và kiểm tra cần thao tác giao diện của người
dùng; chưa mở catalog hay import nên không tuyên bố ứng dụng đã được nghiệm thu với Lightroom.

## Bộ thử đã chuẩn bị

Lệnh tạo dữ liệu:

```powershell
npx vitest run --project manual tests/manual/lightroom-prep.test.ts
```

- Ảnh/XMP: `C:\SICPR\work\lightroom-acceptance\EventStory_HauKy_20261028-045337`
- Bảng kỳ vọng theo tệp: `C:\SICPR\work\lightroom-acceptance\EXPECTED.md`
- Có CR2, CR3, NEF, RAF, ARW, DNG, JPEG; cặp ARW+JPEG có sidecar Develop cũ (Exposure +1.00, Temp 3200K).
- XMP sidecar phải nằm cạnh RAW. DNG/JPEG độc lập cố ý chỉ có dữ liệu trong manifest, không có XMP sao/từ khóa do app tạo.

## Cách thử

1. Mở Lightroom Classic → **File › New Catalog…**. Đặt catalog thử ở
   `C:\SICPR\work\lightroom-acceptance\catalog-test`. Không dùng catalog đang làm việc và không lưu catalog trong thư mục ảnh.
2. File › Import Photos and Video… → chọn thư mục `EventStory_HauKy_20261028-045337`.
3. Chọn **Add** ở đầu cửa sổ import (không Copy/Move), bật hiển thị mọi ảnh rồi Import.
4. So số sao và Keyword List của từng RAW với `EXPECTED.md`. Kiểm cây `EventStory|…` nếu Lightroom hiển thị từ khóa phân cấp.
5. Chọn `ACH07358.ARW` và kiểm Develop: Exposure +1.00, Temp 3200K. Đây là sidecar cũ cần được giữ nguyên.
6. Kiểm `ACH07358.ARW`/`.JPG`: Lightroom có thể gộp cặp hoặc hiển thị hai ảnh tùy Preferences › General › Import Options ›
   “Treat JPEG files next to raw files as separate photos”. Ghi trạng thái tùy chọn và số ảnh thực tế.
7. DNG/JPEG độc lập không cần có sao/từ khóa trong Lightroom; đối chiếu quyết định của chúng trong `eventstory-manifest.csv`.

Không gửi catalog `.lrcat` hay ảnh gốc qua chat. Chỉ cần ghi bảng kết quả và gửi ảnh chụp giao diện có tên tệp. Nếu phát sinh
cảnh báo hoặc XMP không được nhận, chụp cả phần Metadata/Develop liên quan.

## Kết quả

| Mục | Kết quả | Ghi chú |
|---|---|---|
| Sao cho CR2/CR3/NEF/RAF/ARW không có XMP cũ | chưa thử | |
| Từ khóa (`dc:subject`, `lr:hierarchicalSubject`) | chưa thử | |
| XMP Develop cũ được giữ (ACH07358) | chưa thử | |
| Cặp RAW+JPEG | chưa thử | |
| DNG/JPEG chỉ có manifest | chưa thử | |
| Tổng ảnh nhận diện / tùy chọn gộp JPEG | chưa thử | |

Phiên bản Lightroom đã cài: 12.0 (chưa kiểm tra import). Người thử: —. Ngày: —.
