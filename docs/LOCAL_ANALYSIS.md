# MediaPipe local prototype

## Chạy trên Windows

1. Mở bản prototype mới (bản 0.2.0 đã phát hành trước đây không có tính năng này).
2. Tạo/mở dự án và thêm thư mục ảnh. Đợi quét xong.
3. Bấm **Chọn model local…**, chọn file `face_landmarker.task` đã tải riêng.
4. Đợi **Model local đã sẵn sàng**, bấm **AutoCull local (thử nghiệm)**.
5. Xem các danh sách Đề xuất giữ / Có phương án tốt hơn / Cần xem lại, mở ảnh để đọc lý do.
   Chọn thủ công vẫn được ưu tiên. Không có thao tác xóa hay sửa nguồn.

Không cần AWS, API key, Python hoặc dịch vụ ngoài. Các nút **AutoCull AWS** và **Phân tích qua AWS**
là luồng cloud cũ, độc lập; không dùng chúng để chạy local. Không tự động bật local hoặc tự chuyển sang AWS.

Model được kiểm tra: 3,758,596 bytes, SHA-256
`64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.
Nguồn upstream: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
File được lưu trong `userData/local-models/face_landmarker.task`, không nằm trong bộ cài.
Trên máy phát triển hiện tại, bản tải riêng nằm tại
`C:\Users\vantr\AppData\Local\Temp\opencode\face_landmarker.task`.
Chưa xác minh giấy phép/provenance cho bundle cụ thể để phân phối lại; không đóng gói model vào release.

## Kiến trúc và giới hạn

- Một renderer Chromium ẩn, sandbox + context isolation, không Node/preload/API ứng dụng.
  Phiên trình duyệt riêng chặn HTTP(S)/WebSocket và chỉ cho phép tài nguyên đã build + blob local.
- Worker chuẩn bị JPEG đúng chiều từ JPEG/RAW qua pipeline hiện có; chuyển byte qua IPC tới renderer ẩn.
  JS/WASM/model lấy từ đĩa, không CDN. CPU delegate; quét toàn khung và 4 vùng 60% chồng lấn,
  loại mặt bị cắt ở biên tile và khử trùng box theo IoU. Giới hạn detector 20 mặt/lượt quét;
  không đảm bảo tìm đủ người trong ảnh đông, mặt rất nhỏ hoặc bị che.
- Landmark, blendshape và matrix chuyển về worker. Mắt chỉ được kết luận khi geometry và blink cùng đồng ý,
  mặt đủ lớn, tư thế đủ thẳng. Không tạo confidence giả từ coefficient. Độ tin cậy mặt/mắt là null vì API không cấp.
- Nụ cười/miệng là tín hiệu hình học quan sát được, không suy đoán cảm xúc. Không có detector kính râm/che mặt:
  các trường đó để null; landmark vẫn có thể đoán sai khi mắt bị che. Ngưỡng chưa hiệu chuẩn trên ảnh có nhãn.
- Đo sáng mặt bằng luminance crop, clipping và nét bằng phép đo hiện có. Bố cục **chỉ** là kiểm tra mặt sát mép,
  không phải nhận xét thẩm mỹ toàn cảnh. Điểm chỉ để so trong nhóm, không phải phần trăm chất lượng AI.
- Cache theo input + model/provider/rules; không dùng nhầm cache AWS. Chạy lại tiếp tục ảnh thiếu/lỗi,
  hủy không ghi kết quả đến muộn. Một frame đang chạy có thể hoàn tất trong renderer sau khi bấm hủy.
  Lỗi runtime dừng phân tích và báo rõ; không gọi cloud. Timeout đóng renderer sau tối đa 90 giây.
- Manual decisions/nguồn giữ nguyên. Khởi động lại app phải bấm AutoCull local để tiếp tục, không tự chạy AI.

## Kiểm thử

```
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
$env:EVENTSTORY_TEST_MODEL='C:\path\to\face_landmarker.task'
npx playwright test
```

Test adapter dùng landmark tổng hợp: **chỉ kiểm tra logic**, không đo độ chính xác model.
Electron opt-in test dùng model thật và JPEG fixture hiện có, quét/gom nhóm/xếp hạng, chặn mạng,
và không cần cloud credentials. Chưa benchmark chất lượng trên bộ có nhãn, 1.000 RAW/8GB hoặc macOS.

Build thử riêng, không ghi đè release cũ:
`npx electron-builder --dir --config.directories.output=release/local-prototype --config.extraMetadata.version=0.2.1-local.1`

## Bằng chứng chạy thử trên máy phát triển (29/10/2026)

- Typecheck + build qua; 118 unit, 119 integration qua (1 test integration opt-in cũ bỏ qua).
- 27 Electron test qua, có model MediaPipe thật và JPEG fixture có người. Luồng local tự gom nhóm/chọn
  một ảnh từ hai bản sao, hiển thị mặt và tiêu chí; chạy lại dùng cache, SHA-256 nguồn không đổi.
- Bản packaged `release/local-prototype/win-unpacked/EventStory Cull.exe` (0.2.1-local.1) đã qua cùng test local thật.
- Test logic riêng kiểm tra mắt đóng/mở, cache, lỗi/retry, hủy, không gọi fetch kể cả khi có cấu hình cloud.
  Test renderer thật không thấy request HTTP(S) trong inference và xác nhận request ngoài bị chặn.
- Đây là bằng chứng **tích hợp chạy được**, không phải benchmark độ chính xác AI hoặc chấp nhận sản phẩm hoàn chỉnh.
