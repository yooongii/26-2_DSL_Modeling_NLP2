/**
 * 수집 휴리스틱 회귀 테스트 (가짜 DOM).
 *
 * `labeling/test-heuristic.mjs` 와 같은 방침으로 **함정을 일부러 심는다** —
 * 리뷰 목록과 헷갈리는 것들(객실 목록·편의시설·달력)을 같이 놓고 올바른 걸 고르는지 본다.
 * 개수로 고르면 객실 목록이 이기기 때문에 그게 핵심 검사다.
 *
 * 실사이트를 대신하지는 못한다. 실사이트 검증은 out/review-panel.console.js 를
 * 아고다 콘솔에 붙여넣어서 한다.
 *
 *     npm run review:collect-test
 */
import { loadLinkedom } from "./linkedom.mjs";

const linkedom = await loadLinkedom();
if (!linkedom) {
  console.log("⏭️  linkedom 이 없어 건너뜁니다. clearclause/extension 에서 npm install 하세요.");
  process.exit(0);
}
const { parseHTML } = linkedom;

const dom = parseHTML(`<!doctype html><html><head></head><body>
  <!-- 함정 1: 편의시설 목록 — 자식은 많지만 날짜가 없다 -->
  <ul id="amenities">
    ${["무료 Wi-Fi", "주차장", "수영장", "피트니스", "레스토랑"].map((s) => `<li>${s}</li>`).join("")}
  </ul>

  <!-- 함정 2: 객실 목록 — 날짜(무료취소 기한)도 있고 설명도 길다. 항목이 리뷰보다 많다 -->
  <div id="rooms">
    ${Array.from({ length: 9 }, (_, i) => `
      <div>
        <h3>디럭스 트윈 ${i + 1}</h3>
        <p>2026년 10월 ${i + 1}일 전 무료 취소 가능합니다. 최대 성인 2명, 34제곱미터, 도시 전망 객실입니다.</p>
        <span>₩ 194,573</span>
        <button>객실 선택</button>
      </div>`).join("")}
  </div>

  <!-- 함정 3: 예약 가능 날짜 그리드 — 날짜는 있는데 본문이 짧다 -->
  <div id="calendar">
    ${Array.from({ length: 8 }, (_, i) => `<div>2026. 9. ${i + 1}.</div>`).join("")}
  </div>

  <!-- 진짜 리뷰 목록 -->
  <ol id="reviews">
    ${[
      "주차장이라고 되어있어서 당연히 무료인줄 알았는데 나중에 보니 유료주차라네요. 그 외에는 만족합니다.",
      "한국과 달리 호텔 주차장은 유료라서 조금 아쉬웠지만, 위치도 좋고 직원분들도 친절했습니다.",
      "조식 포함으로 예약했는데 마지막 날 추가 요금을 받고, 직원분도 친절하지 않았어요.",
      "지하주차장도 무료이니 참고요. 신라스테이는 룸 구조도 깔끔합니다.",
      "위치가 아주 좋고 동대문과 가깝습니다. 나가면 바로 지하철역이 있어서 이동이 매우 편리합니다.",
      "리뷰를 남겨 주셔서 감사합니다. 저희 호텔을 이용해 주셔서 진심으로 감사드립니다. 총지배인 드림",
    ].map((t, i) => `
      <li>
        <span>2026년 ${8 - i}월</span><span>8.${i} 점</span>
        <p>${t}</p>
      </li>`).join("")}
  </ol>
</body></html>`);

const w = dom.window ?? dom;
globalThis.window = w;
globalThis.document = dom.document;
globalThis.location = { href: "https://www.agoda.com/ko-kr/x/hotel/y.html" };
for (const k of ["HTMLElement", "MouseEvent", "MutationObserver"]) globalThis[k] = dom[k] ?? w[k];
globalThis.getComputedStyle = () => ({ overflowY: "visible" });

const { findReviewContainer, autoCollect } = await import("../collect.ts");
const { runPipeline } = await import("../analyze.ts");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

console.log("수집 휴리스틱");
const container = findReviewContainer();
check("리뷰 목록을 고른다 (객실 목록·달력·편의시설 아님)",
  container?.id === "reviews", `고른 것: #${container?.id ?? "(없음)"}`);

const reviews = await autoCollect();
check("리뷰를 뽑는다", reviews.length > 0, `${reviews.length}건`);
check("호텔 답글을 표시한다",
  reviews.some((r) => r.isHotelReply), "isHotelReply 가 하나도 없음");
check("날짜를 뽑는다", reviews.every((r) => r.date), "date 가 빈 리뷰 있음");
check("10점 척도 평점을 뽑는다",
  reviews.some((r) => r.rating != null && r.ratingScale === 10),
  `rating 예: ${reviews[0]?.rating} / scale ${reviews[0]?.ratingScale}`);

console.log("\n분석 파이프라인");
const insights = await runPipeline(reviews, ["무료 주차", "조식 포함"], { collecting: false });
check("답글은 분모에서 빠진다",
  insights.totalReviews === reviews.filter((r) => !r.isHotelReply).length,
  `total=${insights.totalReviews} vs 손님리뷰=${reviews.filter((r) => !r.isHotelReply).length}`);
check("'유료'를 비용 단서로 인식한다",
  insights.candidates.some((c) => c.costCues.includes("유료")),
  "COST_CUE 에 '유료' 가 빠졌을 때 회귀");
check("근거 1건짜리는 노출하지 않는다 (노출 원칙)",
  insights.risks.filter((r) => r.reviewCount < 2).every((r) => !r.shown));

// ── 알려진 한계 (통과시키지 않고 드러낸다) ─────────────────────────────
// find_fee_hits 는 유형당 **첫 매칭 한 번만** 본다. 그래서 아래 문장에서
// '주차장'(pos 0)이 잡히고 진짜 신호인 '유료주차'(pos 33)는 검사되지 않는다.
//   "주차장이라고 되어있어서 당연히 무료인줄 알았는데 나중에 보니 유료주차라네요"
//   → 창 안에 '무료'만 들어와 negated 로 판정된다. 실제로는 명백한 비용 발생.
// 고치려면 '단서가 가장 강한 위치'를 고르게 해야 하는데, 그건 재현율을 올리고
// 정밀도를 낮추는 방향이라 베이스라인 수치가 바뀐다 — 라벨링·발표 수치에 영향이 있어
// 팀 결정 사항으로 남겨둔다. 지금은 사실을 기록만 한다.
const parkingMentions = insights.risks.find((r) => r.feeType === "주차")?.reviewCount ?? 0;
console.log(
  `  ⚠️  알려진 한계: 주차 mention ${parkingMentions}건 ` +
  `— '유료주차'가 첫 매칭('주차장') 뒤에 있어 검사되지 않음 (유형당 1회 제한)`,
);
check("표기 충돌을 잡는다",
  insights.risks.some((r) => r.pageConflict),
  "pageConflict 가 전부 null");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
if (fail) process.exit(1);
