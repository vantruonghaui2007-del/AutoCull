# Dự toán chi phí API — pilot v0.2

Ngày lập: 29/10/2026. Nguồn đơn giá: AWS Price List công khai
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRekognition/current/ap-southeast-1/index.json`
(publicationDate `2026-09-11T12:45:04Z`), mục `APS1-Group2-ImagesProcessed` (DetectFaces, DetectLabels, …).
Tỷ giá: bán chuyển khoản Vietcombank 26.020 đ/USD (28/10/2026).

| Hạng mục | Đơn giá ap-southeast-1 | Khối lượng tối đa/tháng | USD | VND |
|---|---|---|---|---|
| Rekognition DetectFaces (0–1 triệu ảnh) | 0,0013 USD/ảnh | 4.000 ảnh (quota chung) | 5,20 | ≈ 135.300 |
| Lambda arm64 512 MB, ~1–2 s/lượt + request | ~0,0000134 USD/GB-s; 0,20 USD/1 triệu request | 4.000 lượt + đọc quota | < 0,05 | < 1.300 |
| DynamoDB on-demand (token, quota, kết quả ≤ vài KB, TTL) | theo request | ~20.000 request | < 0,05 | < 1.300 |
| CloudWatch Logs (14 ngày) | theo GB | vài MB | ≈ 0 | ≈ 0 |
| **Tổng ước tính (trước thuế/phí)** | | | **≈ 5,30** | **≈ 138.000** |

Kết luận: dự toán API (4.000 lượt) ≈ 135.000 đ, **dưới ngưỡng 150.000 đ/tháng**, nên giữ quota mặc định
4.000 lượt/tháng toàn pilot, 1.000 lượt/người. Biên còn lại nhỏ (~10%): thuế GTGT/phí giao dịch thẻ quốc tế hoặc tỷ giá
tăng có thể đẩy hóa đơn thực tế gần hoặc vượt 150.000 đ. Nếu cần chắc chắn dưới ngưỡng kể cả thuế/phí ~10%,
deploy với `GlobalMonthlyLimit=3800`.

Không dựa vào Free Tier. Quota giới hạn **số lượt gọi**, không phải trần hóa đơn: hãy bật AWS Budgets.

Kiểm thử thật đã được phép: ~60 lượt (≈ 0,08 USD). **Chưa chạy** — chưa có thông tin đăng nhập AWS trên máy (xem
`docs/TEST_REPORT_v0.2.md`).

## Một album thực tế tốn bao nhiêu lượt?

Mỗi ảnh logic (cặp RAW+JPEG tính là 1) được phân tích **một lần**; chạy lại AutoCull không gửi lại ảnh không đổi.
Album MinhNguyen: 542 tệp = 271 ảnh logic → 271 lượt ≈ 0,35 USD ≈ 9.200 đ. Quota 1.000 lượt/người ≈ 3–4 album cỡ này/tháng.
