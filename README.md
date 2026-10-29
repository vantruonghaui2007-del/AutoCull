# AutoCull / EventStory Cull

Ứng dụng desktop Electron + React + TypeScript hỗ trợ gom nhóm, chọn và xuất ảnh sự kiện trước Lightroom.
Repository này chứa **mã nguồn đầy đủ tại thư mục gốc**, không phải bản EXE và không cần lấy submodule.

## Trạng thái

- Có quét JPEG/RAW, preview, nhóm ảnh tương tự, duyệt thủ công, so sánh, AutoCull và xuất nguyên bản/XMP/manifest.
- Prototype **MediaPipe local** đã được tích hợp; chạy trên máy, không cần AWS. Model nạp riêng, không phân phối trong repo.
- Điểm nét/mắt/sáng/bố cục/biểu cảm là tín hiệu hỗ trợ lựa chọn; chưa nghiệm thu độ chính xác AI trên bộ ảnh có nhãn.
- Bố cục local chỉ kiểm tra mặt sát/cắt mép. Không có nhận diện danh tính, train/tự học hoặc chỉnh sửa ảnh.
- Luồng AWS là tùy chọn riêng; chỉ hoạt động khi có backend, token và đồng ý gửi preview. Không cần để sửa UI/chạy local.
- Windows x64 đã chạy thử. macOS, Windows máy sạch và Lightroom acceptance chưa hoàn tất.

## Cài dependency và mở ứng dụng để sửa UI

Yêu cầu Node.js 24, npm, môi trường desktop hỗ trợ Electron.

```powershell
git clone https://github.com/vantruonghaui2007-del/AutoCull.git
cd AutoCull
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run dev
```

Build một lần trước `dev` để có trang riêng cho inference local trong `out/renderer/`.
Đây là ứng dụng desktop, **không phải website chạy độc lập**: mở React trên trình duyệt thông thường sẽ thiếu
`window.eventstory`, hộp thoại hệ thống và worker. Môi trường AI chỉ có browser cần mock API để preview UI;
mock không thay thế kiểm thử Electron thật.

### RAW đầy đủ và đóng gói Windows

JPEG và các RAW có preview phù hợp dùng pipeline ExifTool. Để fallback giải mã RAW và đóng gói đầy đủ,
cài Visual Studio Build Tools với C++ rồi build helper từ mã nguồn:

```powershell
powershell -ExecutionPolicy Bypass -File native/build-raw-helper.ps1
npm run package:dir
# Hoặc tạo installer/ZIP:
npm run dist
```

Source LibRaw đã pin và giấy phép đi kèm ở `native/`. Không cần đưa EXE build sẵn vào Git.
Xem [native/README.md](native/README.md).

### Build EXE/DMG bằng GitHub Actions

Workflow `build` (`.github/workflows/build.yml`) đóng gói Windows (`.exe` cài đặt + `.zip`) và macOS
(`.dmg` + `.zip`, cho Apple Silicon và Intel):

- Vào tab **Actions → build → Run workflow** để chạy tay; tải file ở mục **Artifacts** của lần chạy.
- Hoặc đẩy tag phiên bản (`git tag v0.2.1 && git push origin v0.2.1`): file được gắn vào một
  **GitHub Release nháp** để bạn kiểm tra rồi phát hành.

Bản macOS chưa ký/notarize: lần đầu mở cần chuột phải → Open, hoặc chạy `xattr -cr "/Applications/EventStory Cull.app"`.

### Bật MediaPipe local

Xem [docs/LOCAL_ANALYSIS.md](docs/LOCAL_ANALYSIS.md): chọn file model đã pin trong ứng dụng, rồi chạy
**AutoCull local (thử nghiệm)**. Model không tự tải từ CDN và không tự chuyển sang cloud khi lỗi.
Chưa xác minh quyền phân phối lại bundle model cụ thể; không thêm `.task` vào repo/installer.

## Dành cho AI sửa giao diện

Đọc **[docs/UI_HANDOFF.md](docs/UI_HANDOFF.md)** trước. File chính:

| Đường dẫn | Vai trò |
|---|---|
| `src/renderer/App.tsx` | Màn hình bắt đầu, workspace, trạng thái và luồng tương tác |
| `src/renderer/styles.css` | Giao diện Liquid Glass, tông vàng/cam (không dùng logo, chỉ tên sản phẩm) |
| `src/renderer/liquid.tsx` | Hiệu ứng kính lỏng: thấu kính SVG, ánh sáng theo con trỏ, thanh chọn trượt — chỉ trình bày |
| `src/renderer/components/` | Grid, Compare, CullPanel, FacePanel, ExportDialog, SourcePanel, bộ chọn và AI settings |
| `src/shared/contracts.ts` | Hợp đồng API, dữ liệu và progress; không tự đổi khi chỉ thiết kế UI |
| `src/preload/index.ts` | Bridge API hạn chế `window.eventstory` |
| `src/worker/` | Quét ảnh, phân tích, nhóm và AutoCull |
| `src/main/local-analysis-host.ts` | Renderer ẩn sandbox cho MediaPipe |
| `src/renderer/local-inference.ts` | Inference local; không phải màn hình UI để trang trí |

## Kiểm thử

```powershell
npm run typecheck
npm run test:unit
# Cần chuẩn bị ảnh fixture riêng trước hai lệnh tiếp theo:
npm run fixtures
npm run test:integration
npm run test:electron
```

Ảnh riêng tư và model không nằm trong repo. Manifest fixture có cả mẫu công khai và mẫu người dùng:
`npm run fixtures` sẽ báo lỗi nếu không có mẫu người dùng ở vị trí đã ghi; không đồng nghĩa source bị thiếu.
Test logic tổng hợp vẫn chạy bằng `test:unit`. Test MediaPipe thật cần biến `EVENTSTORY_TEST_MODEL` và ảnh fixture.
Xem `tests/fixtures/manifest.json`, `docs/LOCAL_ANALYSIS.md`, `docs/TEST_REPORT_v0.2.md`.

## Quy tắc Git

Chỉ commit source, lockfile, cấu hình, icon/logo và tài liệu. Không commit `node_modules/`, `work/`,
`out/`, `release/`, ảnh nguồn, dữ liệu dự án, model, credential hoặc installer/ZIP ứng dụng.
File phát hành cho người dùng nên đặt ở **GitHub Releases**, không phải lịch sử Git.

Source app là dự án riêng tư/proprietary (`UNLICENSED`), không tự suy ra quyền phân phối từ việc xem repo.
Thành phần bên thứ ba có giấy phép riêng: xem `LICENSES/THIRD_PARTY.md`.
