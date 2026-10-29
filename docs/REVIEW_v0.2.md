# Rà soát độc lập v0.2 — 29/10/2026

Reviewer độc lập, chỉ đọc mã; không dùng kết quả review làm bằng chứng AWS thật. Đợt đầu đọc tới `ce653a8`:
không có Critical, 6 Important và 9 mục Minor. Bảng dưới ghi cách khắc phục; lần rà soát lại và kết quả kiểm thử
cuối cùng được ghi trong `docs/TEST_REPORT_v0.2.md` và ledger.

| # | Phát hiện | Sửa / kiểm tra |
|---|---|---|
| 1 | Đề xuất cũ vẫn chọn/xuất sau thay tệp, cặp, nhóm | Revision sống gồm thành viên nhóm, đầu vào phân tích, phiên bản, metadata tệp và tín hiệu. Không khớp → `RESULT_STALE`, không tự chọn; giữ thủ công vẫn thắng. Test `export-selection`. |
| 2 | Request treo; POST đọc được kết quả quá 24 h | Owner nonce, takeover có điều kiện, transaction token chống lặp; reserving >60 s nhận lại, processing >120 s báo `ABANDONED`; hết 24 h không phát lại kết quả. Test backend `app` + `dynamo-store`. |
| 3 | Xung đột quota tạm thời thành lỗi vĩnh viễn | Trả 503, không trừ lượt hay gọi provider; app giữ pending để lần sau tiếp tục. Test backend. |
| 4 | Ghép cặp trong lúc chuẩn bị/xếp hạng gây lỗi FK | Kiểm lại asset/input sau await; insert đề xuất chỉ khi asset còn tồn tại. Test `review-v02`. |
| 5 | Ảnh mờ đơn lẻ/cả nhóm vẫn thắng; bỏ qua nét mặt provider | `quality-v2`: kết hợp nét mặt provider và crop; thêm sàn nét tuyệt đối, thiếu nét → review. Chỉ dùng mặt chính (diện tích ≥40% mặt lớn nhất) để tránh loại ảnh vì hậu cảnh xóa phông; giữ thứ tự crop có null. Ngưỡng thử nghiệm, chưa đo chất lượng. Test `ranking`. |
| 6 | Token scan chỉ đọc 1 MB | Theo `LastEvaluatedKey` cho tới hết bảng. |
| 7 | Manual review/pass nằm sai danh sách | Review luôn ở Cần xem lại; pass không đòi duyệt lại. Test `selection`. |
| 8 | Không thấy mặt trong đa số shot có thể thắng | Shot không mặt phải review nếu bất kỳ shot cùng nhóm có mặt. Test `ranking`. |
| 9 | JPEG 61 MP bị chặn bởi giới hạn RAW | JPEG shrink-on-load, giới hạn riêng 100 MP. Test `ai-analysis`. |
| 10 | Scan và AI có thể chạy nhiều LibRaw | Cổng tuần tự dùng chung, chỉ nhả sau settlement. Test `serial-gate` + `libraw`. |
| 11 | Đóng project đợi scan/HTTP quá lâu | Hủy scan trước khi await AutoCull, truyền AbortSignal tới HTTP. Test `review-v02`. |
| 12 | Lưu endpoint sai lần đầu vẫn ghi token | Xác thực HTTPS/loopback trước khi lưu, worker kiểm trước persist. Test `schemas`, Electron AI. |
| 13 | Full-hash cache chỉ gắn sampled hash | Cache version mới gồm bytes + mtime + sample; stat trước/sau băm; bỏ file stale. Test `review-v02`. |
| 14 | Function URL công khai dễ bị flood | Ghi rõ giới hạn pilot trong `backend/README.md`; WAF/CloudFront chưa triển khai, không tuyên bố đã có rate limit. |
| 15 | Thu hồi consent không dừng run; tiến độ 0/N; portable đổi preset | Thu hồi gọi hủy job; tiến độ analysis cập nhật AutoCull; portable v1 giữ `group-v1`. Test `review-v02` và hồi quy Electron. |

Không có bộ ảnh gán nhãn để xác minh ngưỡng nét hay chất lượng winner/nhắm mắt. Không tuyên bố các thay đổi xếp hạng
là cải thiện chất lượng đã đo được; trạng thái vẫn experimental.

Đợt review lại xác nhận fencing quota, revision sống, race xóa asset, cancel, consent và cache hash đã đúng; phát hiện thêm
cần bỏ qua mặt hậu cảnh khi chấm nét (đã có test riêng). Các góp ý nhỏ được bổ sung: GET 404 cho reservation bị bỏ dở,
owner-fencing khi complete/fail, scan RAW và AI cùng queue chuẩn bị, tương thích khóa prep-v2 cũ để không gửi lại mất phí.

Lần đọc cuối sau các bổ sung trên: reviewer không phát hiện regression mức Important. Đây là kết luận đọc mã,
không thay thế kiểm thử hoặc chứng minh AWS thật. Giới hạn vẫn được giữ nguyên: ngưỡng nét chưa hiệu chỉnh bằng nhãn,
timeout Lambda 45 s phải nhỏ hơn ngưỡng takeover 60 s, Function URL pilot chưa có WAF/rate limit.

Kiểm bổ sung sau review: đầu vào bị đánh dấu missing/stale không được coi là kết quả phân tích còn mới, kể cả khi chạy
lại AutoCull. Regression riêng trong `export-selection` bảo đảm một ảnh nguồn mất không bị tự chọn lại bằng cache cũ.
