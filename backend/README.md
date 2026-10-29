# EventStory Cull — backend pilot (AWS SAM)

Proxy có xác thực và giới hạn lượt gọi tới **Amazon Rekognition DetectFaces**, vùng `ap-southeast-1` (Singapore).
Không lưu ảnh ở bất cứ đâu. Kết quả phân tích được giữ trong DynamoDB để tránh tính phí hai lần và
**không còn đọc được sau 24 giờ** (TTL của DynamoDB dọn nền sau đó, có thể chậm hơn).

| Endpoint | Hành vi |
|---|---|
| `POST /v1/face-analysis` | Thân là JPEG (≤ 2,5 MiB). Header `Authorization: Bearer <token>`, `Idempotency-Key`. Kiểm token → giữ 1 lượt quota (transaction) → gọi DetectFaces đúng một lần (`maxAttempts: 1`). Cùng key + cùng ảnh: trả lại kết quả cũ, không gọi AWS. Cùng key + ảnh khác: 409. |
| `GET /v1/requests/:requestId` | Đọc trạng thái/kết quả, không gọi AWS. |
| `GET /v1/quota` | Lượt đã dùng của bạn và của cả pilot, thời điểm đặt lại (đầu tháng UTC). |

Thuộc tính khuôn mặt trả về: khung mặt, độ tin cậy, pose, chất lượng (nét/sáng), mắt mở, cười, miệng mở,
biểu cảm dự đoán (3 cao nhất), hướng mắt, che mặt, kính râm, kính thường. **Không** tuổi, giới tính, danh tính.

Cấu hình mặc định (tham số stack): `GlobalMonthlyLimit=4000`, quota mỗi người 1.000 (đặt khi cấp token),
tối đa 5 người dùng đang hoạt động, Lambda Node.js 24 arm64, timeout 45 s, reserved concurrency 2.

> Quota là **trần số lượt gọi**, không phải trần hóa đơn AWS. Hãy đặt thêm AWS Budgets (mục 6).

## 1. Chuẩn bị (một lần)

- AWS CLI v2 và AWS SAM CLI; Node.js 24.
- Tài khoản AWS và profile có quyền CloudFormation, Lambda, IAM, DynamoDB, Logs, Organizations (cho bước opt-out):
  ```
  aws configure --profile eventstory      # region ap-southeast-1, output json
  aws sts get-caller-identity --profile eventstory
  ```
- `cd backend && npm ci`

## 2. Bật AI services opt-out (BẮT BUỘC trước khi gửi ảnh thật)

Ngăn AWS dùng ảnh/kết quả của bạn để cải thiện dịch vụ AI. Cần AWS Organizations (miễn phí):

```
$env:AWS_PROFILE='eventstory'
aws organizations describe-organization   # nếu báo chưa có: aws organizations create-organization --feature-set ALL
aws organizations enable-policy-type --root-id <r-xxxx> --policy-type AISERVICES_OPT_OUT_POLICY
aws organizations create-policy --name eventstory-ai-optout --type AISERVICES_OPT_OUT_POLICY `
  --description "Opt out of all AI services data use" `
  --content '{\"services\":{\"default\":{\"opt_out_policy\":{\"@@assign\":\"optOut\"}}}}'
aws organizations attach-policy --policy-id <p-xxxx> --target-id <r-xxxx>
aws organizations describe-effective-policy --policy-type AISERVICES_OPT_OUT_POLICY   # kiểm tra: optOut
```
(`<r-xxxx>` lấy từ `aws organizations list-roots`.) Hoặc trên Console: AWS Organizations → Policies →
AI services opt-out policies → tạo chính sách `default: optOut` và gắn vào Root.

## 3. Deploy

```
$env:AWS_PROFILE='eventstory'
sam build
sam deploy --stack-name eventstory-cull-pilot --region ap-southeast-1 --resolve-s3 --capabilities CAPABILITY_IAM
```
Tài khoản mới có giới hạn 10 concurrent executions không cho đặt reserved concurrency; khi đó thêm
`--parameter-overrides UseReservedConcurrency=false`. Đầu ra `FunctionUrl` là địa chỉ nhập vào app.

## 4. Cấp, thu hồi token và quota

Token chỉ hiện **một lần** khi tạo; bảng chỉ lưu SHA-256 của token. Gửi token cho người dùng qua kênh riêng.

```
node scripts/token.mjs create --label "Pilot 1" [--limit 1000]
node scripts/token.mjs list
node scripts/token.mjs set-limit --label "Pilot 1" --limit 500
node scripts/token.mjs revoke --label "Pilot 1"
node scripts/token.mjs usage
```
Đổi quota chung: deploy lại với `--parameter-overrides GlobalMonthlyLimit=3000`. Quota chung được ưu tiên:
hết quota chung thì mọi người dừng, kể cả khi quota cá nhân còn.

Trong app: **Phân tích AI** → dán địa chỉ `FunctionUrl` và token → Lưu → đọc thông báo và tích **Tôi đã hiểu và đồng ý**.
Token được mã hóa bằng hệ điều hành (Windows DPAPI / macOS Keychain qua `safeStorage`); máy không hỗ trợ thì chỉ giữ trong RAM.

## 5. Kiểm tra trên AWS thật

```
node scripts/live-test.mjs --url <FunctionUrl> --token-file <tệp chứa token> --image <JPEG có mặt người ≤2,5 MiB> --out live-report.json
```
Kiểm: token sai → 401, ảnh quá lớn → 413, request bị từ chối không trừ lượt, hai request đồng thời cùng key chỉ trừ
**một** lượt, gửi lại cùng key trả kết quả cũ, cùng key ảnh khác → 409, đọc lại kết quả. Tốn 1 lượt DetectFaces.

## 6. Chi phí và giám sát

- Đơn giá DetectFaces ap-southeast-1 (Price List công khai, phát hành 11/09/2026): **0,0013 USD/ảnh** (0–1 triệu ảnh/tháng).
  4.000 ảnh/tháng ≈ 5,20 USD ≈ 135.000 đồng (tỷ giá bán Vietcombank 26.020 đ/USD ngày 28/10/2026), chưa gồm thuế/phí thẻ.
  Chi tiết: `docs/COST_ESTIMATE.md`.
- Nên tạo AWS Budget (ví dụ 7 USD/tháng, cảnh báo 80%).
- Log CloudWatch giữ 14 ngày, chỉ ghi đường dẫn, mã trạng thái, thời gian, kích thước; không ghi ảnh, token hay dữ liệu khuôn mặt.

## 7. Giới hạn đã biết của pilot

- Function URL để `AuthType: NONE` (xác thực bằng token trong Lambda). Ai biết địa chỉ có thể gửi request rác; mỗi request
  bị từ chối vẫn tốn một lần đọc DynamoDB và, với reserved concurrency 2, có thể làm người dùng thật phải chờ/thử lại.
  Không tốn lượt Rekognition. Khi mở rộng: đặt CloudFront + AWS WAF (rate limit) phía trước.
- Request bị bỏ dở (Lambda chết giữa chừng): bản ghi `reserving` quá 60 s được nhận lại (chưa trừ lượt); `processing` quá
  120 s được báo `failed/ABANDONED` (lượt đã trừ, không gọi lại AWS — người dùng có thể bấm *Thử phân tích lại*).
- Xung đột giao dịch quota tạm thời trả `503` (không trừ lượt, không gọi AWS); app tự gửi lại ở lần chạy sau.
- Không nâng timeout Lambda qua 60 s mà không sửa các ngưỡng phục hồi request (hiện timeout 45 s, reserving 60 s,
  processing 120 s). Complete/fail cũng bị ràng buộc owner để một invocation cũ không ghi vào request của owner mới.
- Sau 24 giờ, key cũ không phát lại kết quả: POST dưới key đó là yêu cầu mới và có thể tính một lượt mới.

## 8. Gỡ bỏ

```
sam delete --stack-name eventstory-cull-pilot --region ap-southeast-1
```
Xóa Lambda, Function URL, bảng DynamoDB (token, quota, kết quả) và log group.

## Phát triển

`npx vitest run` (logic với store trong bộ nhớ, provider giả lập — **không** chứng minh AWS hoạt động),
`npx tsc --noEmit`, `sam validate --lint`, `sam build`.
