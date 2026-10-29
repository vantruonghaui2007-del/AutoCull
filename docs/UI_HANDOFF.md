# Bàn giao UI — EventStory Cull / Fit Media

## Phạm vi

Mục tiêu: cải thiện UI/UX của ứng dụng desktop đang chạy, **không thay bằng bản demo web mất chức năng**.
Giữ chỉnh sửa branding/logo hiện có. Source snapshot gồm cả local MediaPipe và các chỉnh sửa UI đang có trên máy.
Không gọi AWS, gửi ảnh, train model, thêm chức năng chưa có hoặc thay đổi backend chỉ để đổi UI.

## Luồng chính phải giữ

1. Tạo/mở dự án, chọn nơi lưu; khôi phục dự án gần nhất.
2. Thêm nguồn, quét metadata/preview, báo tiến trình/hủy/lỗi; quản lý nguồn offline và liên kết lại.
3. Xác nhận RAW+JPEG; hiển thị số ảnh logic khác số tệp vật lý; máy ảnh và lệch giờ trong dự án.
4. Duyệt lưới/theo nhóm; tìm tên tệp; lọc; chọn nhiều; tách/gộp/gom lại nhóm.
5. Chọn model local đã pin và AutoCull local; AWS phải là luồng tùy chọn riêng, có consent.
6. Ba danh sách: Đề xuất giữ / Có phương án tốt hơn / Cần xem lại; số lượng, hạng, lý do, năm tiêu chí.
7. Giữ/bỏ qua/xem lại/về tự động; sao 0–5; hoàn tác; quyết định thủ công luôn ưu tiên.
8. So sánh cạnh nhau, zoom/pan đồng bộ, khung/crop mặt, trạng thái mắt; cảnh báo vượt độ phân giải preview.
9. Xuất lựa chọn: preview kế hoạch, chọn đích, sao chép nguyên bản hoặc chỉ manifest, tiến trình/hủy/báo cáo/mở thư mục.
10. Lưu/mở tệp phiên (không chứa ảnh, token hoặc kết quả AI).
11. Giữ panel nâng cao thu gọn: Trả nhanh/Hậu kỳ, ghim, mục tiêu, đồng ý, độ bao phủ và ghi nhận bàn giao.

## Thành phần và trạng thái cần thiết kế

- Welcome: tên dự án, tạo/mở/import phiên. Không cần đăng ký hoặc đăng nhập để dùng local.
- Sidebar: nguồn online/offline, máy ảnh, thông tin cặp và bộ lọc.
- Toolbar: AutoCull local, tiến trình/hủy, xuất số ảnh đã chọn; AWS phân biệt rõ.
- Grid/groups: focus khác selected; sao, nhãn culling, lựa chọn thủ công, lỗi/preview nhỏ/kết quả cũ.
- Detail: preview, metadata, lý do, năm điểm (known/unknown/not-applicable), mặt/mắt, nút quyết định.
- Dialogs: compare, model, AWS, export; phím tắt không tác động ảnh khi đang nhập hoặc trong dialog.
- Footer/toast: worker khởi động/ready/restarting, version, lỗi có cách phục hồi.
- Empty/loading/error/cancelled/paused/complete/stale phải phân biệt, không thay bằng spinner vĩnh viễn.

## Ràng buộc không được phá

- `window.eventstory`: API qua preload, xem `src/shared/contracts.ts`. Không dùng Node/fs/ipcRenderer trực tiếp trong React.
- Không bật `nodeIntegration`, tắt sandbox hoặc nới network/CSP để đổi UI.
- Không đụng renderer MediaPipe ẩn (`local-analysis.html`, `local-inference.ts`) khi chỉ thiết kế giao diện người dùng.
- Ảnh nguồn chỉ đọc; **bỏ qua không phải xóa tệp**. Không ghi lên nguồn để chấm sao hoặc sửa lựa chọn.
- Giữ `data-testid` hiện có; test Electron dùng các ID này. Giữ keyboard handlers và debounce/pagination.
- Không đổi kiểu dữ liệu, schema SQLite, scoring, grouping, cache hoặc quy tắc export trong một PR UI.
- Không hiển thị face/eye confidence giả: local trả null vì runtime không cung cấp xác suất đó.
- Điểm chỉ hỗ trợ so trong nhóm. Bố cục chỉ kiểm tra mặt sát mép; smile không phải cảm xúc bên trong.
- Không mô tả model là tự học, nhận diện danh tính, hiểu nội dung sự kiện hoặc tự retouch — chưa có.
- Model hiện phải chọn riêng, chỉ nhận đúng checksum. Không thiết kế nút tải/cập nhật/train model như đã hoạt động.

## Kiểm tra khi bàn giao

Chạy `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run build`.
Sau đó mở Electron và kiểm tra dự án mới/mở lại, nguồn JPEG, duyệt/chọn, so sánh, AutoCull local (nếu có model), xuất.
Integration/Electron test đầy đủ cần mẫu RAW và mẫu người dùng không nằm trong repo; ghi rõ test nào chưa chạy.
Môi trường AI không có desktop chỉ được coi là preview/mock, không tuyên bố app đã chạy end-to-end.
