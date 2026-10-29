# EventStory Cull 0.2 — Hướng dẫn nhanh

EventStory Cull lọc ảnh sự kiện **trước Lightroom**: gom các khung giống nhau, đề xuất ảnh tốt nhất mỗi nhóm,
cho bạn sửa lựa chọn, rồi xuất **nguyên bản** (RAW, JPEG đi kèm, XMP) sang một thư mục mới. Ảnh nguồn chỉ được đọc —
không sửa, không đổi tên, không xóa.

## 1. Cài đặt

Windows 10/11 x64: chạy `EventStory-Cull-0.2.0-win-x64-setup.exe` (hoặc giải nén bản ZIP và chạy `EventStory Cull.exe`).
Bản cài chưa ký số nên Windows SmartScreen có thể cảnh báo: chọn *More info → Run anyway*.
macOS: **chưa kiểm thử**, chưa phát hành.

## 2. Dự án và nguồn ảnh

1. **Tạo dự án** → đặt tên → chọn thư mục lưu dự án (không đặt trong thư mục ảnh).
2. **Thêm nguồn** → chọn thư mục thẻ nhớ/ảnh. App đọc EXIF, preview nhúng và tạo ảnh xem trước.
3. Nếu có cặp RAW+JPEG cùng tên, bấm **Xác nhận cặp** để coi là một ảnh.

## 3. Phân tích AI (tùy chọn, cần token pilot)

Nút **Phân tích AI** → nhập địa chỉ dịch vụ và token được cấp → **Lưu** → đọc thông báo và tích **Tôi đã hiểu và đồng ý**.

- Chỉ gửi **ảnh xem trước JPEG thu nhỏ** (tối đa 3.840 px, đã bỏ EXIF/GPS). **Tệp RAW gốc không rời máy.**
- Ảnh được gửi tới Amazon Rekognition (Singapore) qua máy chủ pilot; máy chủ không lưu ảnh, kết quả không còn đọc được sau 24 giờ.
- Chỉ phân tích ảnh bạn có quyền xử lý trên cloud và người trong ảnh đã đồng ý.
- Hộp cài đặt hiện số lượt đã dùng trong tháng (của bạn và của cả pilot).

Không có AI (chưa cấu hình, mất mạng, hết lượt), app vẫn mở, gom nhóm, duyệt và xuất bình thường; ảnh chưa phân tích nằm ở
**Cần xem lại** và thanh trạng thái nói rõ lý do.

## 4. AutoCull

Bấm **Chạy AutoCull**. App sẽ:

1. tìm bản sao giống hệt (xác nhận bằng SHA-256 toàn tệp),
2. gom nhóm khung chụp liên tiếp (dự án mới: cách nhau ≤ 4 s, cả nhóm ≤ 10 s, hình giống nhau),
3. phân tích khuôn mặt những ảnh chưa có kết quả (nếu bật AI),
4. chấm 5 tiêu chí — nét 40%, mắt 30%, ánh sáng 15%, bố cục 10%, biểu cảm 5% — và chọn ảnh tốt nhất mỗi nhóm.

Kết quả chia ba danh sách:

| Danh sách | Ý nghĩa |
|---|---|
| **Đề xuất giữ** | Ảnh được chọn (tự động hoặc do bạn chọn). Đây là ảnh sẽ được xuất. |
| **Có phương án tốt hơn** | Nhóm đã có ảnh tốt hơn; xem lý do (ví dụ "Có người nhắm mắt rõ", "Gần ngang ảnh được chọn"). |
| **Cần xem lại** | Chưa đủ bằng chứng: chưa phân tích, cả nhóm không có ảnh đạt, số mặt thay đổi hẳn, phân tích lỗi… |

Bấm vào một ảnh để xem lý do và điểm từng tiêu chí ("chưa rõ" nghĩa là không đủ dữ kiện — ví dụ mặt quá nhỏ, nghiêng,
kính râm — và **không** bị tính như nhắm mắt). **So với ảnh được chọn** mở so sánh hai ảnh, có khung mặt và trạng thái mắt.

Chạy AutoCull nhiều lần không tốn thêm lượt cho ảnh không đổi, và **không bao giờ ghi đè lựa chọn của bạn**.
Bấm **Hủy AutoCull** bất cứ lúc nào; lần chạy sau tiếp tục phần còn thiếu.

Nếu đổi cặp RAW+JPEG, thay tệp hoặc sửa nhóm, đề xuất cũ bị đánh dấu hết hiệu lực và không tự chọn để xuất.
Hãy chạy lại AutoCull; lựa chọn giữ thủ công vẫn được ưu tiên. Ngưỡng nét tuyệt đối và điểm 5 tiêu chí hiện là
**thử nghiệm**, chưa được nghiệm thu bằng bộ ảnh có nhãn. Ảnh bạn đã bấm **Bỏ** không bị đưa lại vào hàng cần duyệt;
ảnh bấm **Xem lại** luôn nằm ở **Cần xem lại**.

## 5. Sửa lựa chọn

- **Chọn ảnh này** (phím K): giữ thủ công. Nhóm có ảnh giữ thủ công thì chỉ những ảnh đó được chọn (giữ được nhiều ảnh).
- **Bỏ ảnh này** (X) hoặc **Xem lại** (R): loại khỏi lựa chọn tự động; app chọn ảnh đạt tiếp theo trong nhóm.
- **Về tự động** (U): bỏ lựa chọn thủ công, dùng lại đề xuất.
- Sao 0–5 (phím 0–5), hoàn tác Ctrl/⌘+Z. Phím mũi tên để di chuyển, C so sánh, Space xem lớn.

Dự án cũ (0.1) vẫn dùng cách gom 2 giây cho tới khi bạn chọn gom lại theo cách mới.
Bộ chọn "Trả nhanh/Hậu kỳ" và mục tiêu bàn giao của bản 0.1 nằm trong mục **Dữ liệu cũ (v0.1)**.

## 6. Xuất cho Lightroom

**Xuất ảnh đã chọn** → chọn kiểu (sao chép nguyên bản + manifest, hoặc chỉ manifest) → chọn nơi xuất → xem trước → **Bắt đầu xuất**.

- App tạo thư mục mới `EventStory_DaChon_<ngày-giờ>`, sao chép RAW + JPEG đi kèm + XMP có sẵn, tạo XMP mới (sao, từ khóa)
  cho RAW chưa có XMP, và kiểm tra SHA-256 từng tệp.
- `eventstory-manifest.csv/json` ghi lựa chọn, lý do, điểm 5 tiêu chí và kết quả từng tệp.
- Nếu sau khi xem trước bạn đổi lựa chọn, tệp nguồn thay đổi hoặc AutoCull tính lại, app yêu cầu xem trước lại.

Trong Lightroom Classic: *File → Import* thư mục vừa xuất (Add hoặc Copy).

## 7. Mang sang máy khác

**Lưu tệp phiên…** ghi các lựa chọn thủ công (không chứa ảnh, token hay kết quả AI). Trên máy kia: **Mở tệp phiên từ máy khác…**.
