# Mã nguồn và dựng lại v0.2

Gói `EventStory-Cull-0.2.0-source.zip` chứa snapshot các tệp được Git theo dõi, gồm app, backend SAM, helper C++,
tarball LibRaw đúng phiên bản, giấy phép và tài liệu. Không chứa ảnh riêng, token, `node_modules` hoặc tệp cài đặt.
`EventStory-Cull-0.2.0-history.bundle` giữ lịch sử commit/task; có thể mở thành repository:

```powershell
git clone EventStory-Cull-0.2.0-history.bundle eventstory-cull
cd eventstory-cull
git switch feat/v0.2
```

## Windows x64

Cần Node.js 24, npm, Git, Visual Studio Build Tools với MSVC C++ x64. AWS CLI/SAM chỉ cần nếu dựng/deploy backend.

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File native/build-raw-helper.ps1
npm run typecheck
npm run test:unit
npm run dev
npm run dist
```

Helper kiểm SHA-256 tarball LibRaw trước khi dựng. Không sửa source LibRaw, không demosaic pack/RawSpeed/DNG SDK.
Hướng dẫn chi tiết và cấu hình camera-WB: `native/README.md`.

## Kiểm thử đầy đủ

`npm run fixtures` tải các mẫu công khai và kiểm SHA-256. Các ARW/JPG riêng của người dùng không nằm trong source archive;
trên máy khác cần cung cấp các mẫu đúng manifest (hoặc thay bộ dữ liệu có quyền sử dụng và cập nhật manifest một cách minh bạch).
Test báo thiếu thay vì giả vờ đã chạy camera đó.

```powershell
npm run test:integration
npm run test:electron
```

Chạy hai bộ trên **tuần tự**, không song song: kiểm cleanup tiến trình của Electron sẽ nhìn thấy ExifTool của integration
nếu chúng cùng chạy trong repository. Không xóa assertion hoặc kết thúc các tiến trình không thuộc test của mình.

Sau khi đóng gói:

```powershell
node scripts/smoke-installed.mjs --app '<đường dẫn EventStory Cull.exe>' --fixtures tests/fixtures/files --workflow
```

## Backend SAM

Trong `backend/`: `npm ci`, `npx vitest run`, `npx tsc --noEmit`, `sam validate --lint`, `sam build`.
Deploy, AI opt-out, cấp token/quota và live test: `backend/README.md`. Không gửi ảnh thật trước khi đã bật và xác minh opt-out.

## Những gì chưa được bảo đảm

Không có bản Mac đã kiểm thử, không nghiệm thu chất lượng AI bằng mock, không tuyên bố mã độc quyền hoặc giấy phép
phát hành công khai. Mã ứng dụng giữ `UNLICENSED/private`; kiểm kê và mục giấy phép còn mở trong `docs/LICENSES.md`.
