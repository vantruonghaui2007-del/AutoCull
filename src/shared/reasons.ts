/** Short Vietnamese explanations of AutoCull reason codes (UI and export manifest). */
export const REASON_TEXT: Record<string, string> = {
  SHARPNESS_UNKNOWN: 'Chưa đủ dữ liệu đánh giá độ nét',
  BEST_IN_GROUP: 'Ảnh tốt nhất trong nhóm',
  NEAR_EQUAL: 'Gần ngang ảnh được chọn',
  EYES_CLOSED: 'Có người nhắm mắt rõ',
  EYES_UNKNOWN: 'Chưa rõ mắt (mặt nhỏ, nghiêng, bị che hoặc kính râm)',
  NO_FACES: 'Không phát hiện khuôn mặt',
  FACE_COUNT_CHANGED: 'Số khuôn mặt khác hẳn các ảnh cùng nhóm',
  BLURRY: 'Mặt (hoặc ảnh) mờ hơn hẳn trong nhóm',
  CLIPPING: 'Có vùng cháy sáng hoặc bết tối',
  FACE_AT_EDGE: 'Mặt sát hoặc bị cắt ở mép khung',
  GROUP_NO_ACCEPTABLE_SHOT: 'Cả nhóm không có ảnh đạt',
  EXACT_DUPLICATE: 'Bản sao giống hệt từng byte của ảnh khác',
  NOT_ANALYZED: 'Chưa phân tích khuôn mặt',
  ANALYSIS_FAILED: 'Phân tích khuôn mặt lỗi',
  ANALYSIS_STALE: 'Kết quả phân tích cũ không còn khớp ảnh',
  RESULT_STALE: 'Ảnh hoặc nhóm đã thay đổi sau lần AutoCull gần nhất — hãy chạy lại AutoCull',
};

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}
