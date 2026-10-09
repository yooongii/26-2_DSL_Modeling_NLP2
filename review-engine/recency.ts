/**
 * 리뷰 날짜 해석 — 사이트마다 형식이 다르다.
 *
 *   Agoda    reviewDate "2025-03-12T00:00:00" 또는 formattedReviewDate "2025년 3월 12일"
 *   Trip.com createDate "2026-08-11 21:11:33" (T 없이 공백 — Safari 는 Invalid Date)
 *   Booking  reviewedDate "2025-08-12"
 *
 * 못 읽으면 null. 호출부는 null 이면 "위치 기준" 으로 되돌아간다.
 */
export function parseReviewDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // "2025년 3월 12일" / "2025년 3월" / "2025.03.12" / "2025/3/12"
  const ko = s.match(/(\d{4})\s*[년.\/-]\s*(\d{1,2})(?:\s*[월.\/-]\s*(\d{1,2}))?/);
  if (ko) {
    const y = Number(ko[1]), m = Number(ko[2]), d = ko[3] ? Number(ko[3]) : 1;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(y, m - 1, d);
      return Number.isNaN(dt.getTime()) ? null : dt;
    }
  }
  // "2026-08-11 21:11:33" → ISO 로 정규화
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(" ", "T") : s;
  const dt = new Date(iso);
  if (!Number.isNaN(dt.getTime())) return dt;
  // 유닉스 초/밀리초
  if (/^\d{10}(\d{3})?$/.test(s)) {
    const n = Number(s);
    return new Date(s.length === 10 ? n * 1000 : n);
  }
  return null;
}

/** 최근으로 볼 기간. 리뷰 탭 문구("최근 1년")와 같이 바꿔야 한다. */
export const RECENT_DAYS = 365;

export function isRecent(raw: string | null | undefined, now: Date = new Date(), days = RECENT_DAYS): boolean | null {
  const d = parseReviewDate(raw);
  if (!d) return null;
  const age = (now.getTime() - d.getTime()) / 86_400_000;
  // 하루 여유: 시간대·자정 경계에서 딱 1년째 리뷰가 빠지지 않게
  return age >= -1 && age <= days + 1;
}
