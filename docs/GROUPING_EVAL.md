# Đánh giá gom cụm — bộ ảnh thật (28/10/2026)

Cấu hình: `group-v1` (dHash Hamming ≤ 10/64, histogram ≥ 0,85, khoảng cách ≤ 2 s, độ dài cụm ≤ 10 s;
thiếu giờ: ≤ 6 và ≥ 0,92, độ tin cậy thấp). Đặc trưng: `feat-v1` trên preview đã xoay đúng, cạnh dài ≤ 512.

Bộ ảnh: thư mục của người dùng (Sony ILCE-7C, 271 ARW + 271 JPG, một buổi thuyết trình, ảnh dọc và ngang).
Chạy bằng `EVAL_SOURCE=<thư mục> npx vitest run --project manual`; báo cáo và contact sheet ở
`work/reports/grouping-eval/`. Nguồn chỉ được đọc.

## Kết quả

- 542 tài sản (ARW và JPG chưa được xác nhận cặp nên là hai ảnh riêng; mỗi khung xuất hiện hai lần trong cùng cụm — đúng, vì thời gian và hình giống hệt).
- 239 cụm: 213 cụm chỉ một khung (ARW+JPG), 22 cụm 2 khung, 2 cụm 3 khung, 2 cụm 4 khung.
- Thời gian quét và trích preview 542 tệp: ~82 s (Windows, 16 GB, 4 metadata + 2 image jobs). Đây là một lần chạy, không phải benchmark.

## Đánh giá thủ công (xem contact sheet 0 và 3)

- **Gộp nhầm (false grouping): không thấy** trong các cụm đã xem; các khung trong một cụm cùng tư thế/bố cục.
- **Tách thừa cần sửa:** nhiều khung gần như giống hệt bị tách vì người chụp bấm cách nhau 2,5–4 s, vượt ngưỡng 2 s.
  Ví dụ: cụm 0–3 (ACH07358–ACH07361, cách 2,0–3,9 s), cụm 44–46, 49–51, 52 với 53.
- Ảnh dọc và ảnh ngang cạnh nhau không bị gộp.

## Quyết định

Giữ nguyên ngưỡng mặc định của kế hoạch: tách thừa sửa được bằng thao tác gộp cụm (giữ là cụm thủ công),
còn gộp nhầm nguy hiểm hơn vì người dùng có thể bỏ sót ảnh khác cảnh. Nới khoảng cách lên ~4 s có thể
giảm tách thừa cho kiểu chụp hội thảo này, nhưng cần thêm bộ ảnh sự kiện khác (cưới, sân khấu) trước khi
đổi mặc định; khi đổi phải tăng `version` của cấu hình. Không công bố độ chính xác từ một bộ ảnh.
