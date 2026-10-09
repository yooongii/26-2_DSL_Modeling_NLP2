// ── collect-reviews.js 휴리스틱 회귀 테스트 ──
//
// 실행:  node test-heuristic.mjs
//
// 리뷰 컨테이너·모달 버튼 탐색은 선택자를 하드코딩하지 않고 구조 휴리스틱으로 하기
// 때문에, 조건을 조금만 건드려도 엉뚱한 요소를 잡기 쉽다. 실사이트를 열지 않고도
// 그 회귀를 잡으려고 가짜 DOM으로 검증한다.
//
// 시나리오:
//   A. 버튼 문구에 '후기'가 들어감 ("후기 60개 모두 보기")
//   B. 버튼이 그냥 "모두 보기" — 사진 갤러리에도 같은 문구가 있어 구분이 필요
//   C. 객실 목록이 리뷰 목록보다 항목이 많음 (개수로 고르면 객실이 이긴다)
//   C2~C6. 카드 안의 호텔 답글 / 정책 문장 vs 광고 / 짧은 요금제 라벨 / 목록 교체
//   D. 런타임 스모크 — 내보낸 함수를 실제로 호출

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "collect-reviews.js"), "utf8");
// linkedom을 찾는다. 이 폴더에 설치돼 있으면 그걸 쓰고, 없으면 저장소 안의 다른 곳을 본다.
// 어디에도 없으면 테스트를 건너뛴다 — 필수 도구가 아니라 보조 장치다.
const LINKEDOM = [
  "node_modules/linkedom/esm/index.js",
  "../node_modules/linkedom/esm/index.js",
  "../../clearclause/extension/node_modules/linkedom/esm/index.js",
].map((p) => path.resolve(HERE, p)).find((p) => fs.existsSync(p));

if (!LINKEDOM) {
  console.log("⏭️  linkedom이 없어 테스트를 건너뜁니다.");
  console.log("   `npm i -D linkedom` 후 다시 실행하세요.");
  process.exit(0);
}
const { parseHTML } = await import(pathToFileURL(LINKEDOM).href);

// ── 공통: 리뷰 카드 ──────────────────────────────────────────
const REVIEWS = [
  ["김민수", "2026년 7월", "별점 5점", "위치도 좋고 깨끗했어요. 주차는 무료라서 편했습니다."],
  ["이서연", "2026년 6월", "별점 4점", "다 좋았는데 주차비를 현장에서 따로 받더라고요. 하루 2만원이었습니다."],
  ["박지훈", "2026년 5월", "별점 4점", "호스트분이 친절하셨어요. 조식은 포함이 아니라 별도로 결제해야 했습니다."],
  ["최유진", "2026년 4월", "별점 3점", "보증금 10만원을 체크인 때 요구했어요. 나중에 돌려받긴 했습니다."],
  ["정하늘", "2026년 3월", "별점 5점", "재방문 의사 100%입니다. 뷰가 정말 좋아요."],
  ["강도윤", "2026년 2월", "별점 3점", "청소비가 좀 비싼 편이지만 그만큼 깨끗했습니다."],
];

const cards = REVIEWS.map(([name, date, rating, body]) => `
  <div class="_c8x9k">
    <div class="_hdr"><span class="_nm">${name}</span><span class="_dt">${date}</span></div>
    <div class="_st" aria-label="${rating}">★★★★★</div>
    <div class="_bd"><span>${body}</span></div>
  </div>`).join("");

// 함정: 날짜를 가진 자식이 6개인데 본문이 짧다 (MIN_BODY_LEN 미만)
const dateDecoys = ["2026. 9. 1.", "2026. 9. 2.", "2026. 9. 3.", "2026. 9. 4.", "2026. 9. 5.", "2026. 9. 6."]
  .map((d) => `<div class="_dcell"><span>${d}</span></div>`).join("");

const COMMON_DECOYS = `
  <nav><a href="/">홈</a><a href="/help">도움말</a><a href="/host">호스팅 하기</a></nav>
  <div class="_amen"><ul><li>무료 주차</li><li>무료 Wi-Fi</li><li>셀프 체크인</li><li>조식 포함</li></ul></div>
  <div class="_cal"><h3>예약 가능 날짜</h3><div class="_grid">${dateDecoys}</div></div>
  <div class="_price"><span>총액 ₩436,214</span><span>2026. 9. 13.</span></div>
  <footer><span>2026 회사</span></footer>`;

// A. 에어비앤비형 — 버튼 문구에 '후기'가 있다
const HTML_AIRBNB = `<html><body>
  <h1>한옥 돌담집, Private 야외 자쿠지</h1>
  ${COMMON_DECOYS}
  <section class="_rv">
    <h2>후기 60개</h2>
    <button>후기 60개 모두 보기</button>
    <div class="_lst">${cards}</div>
  </section>
</body></html>`;

// B. 아고다형 — 버튼이 그냥 "모두 보기".
//    사진 갤러리에도 똑같은 "모두 보기"가 있어서, 리뷰 쪽을 골라야 한다.
const HTML_AGODA = `<html><body>
  <h1>호텔 그레이스리 신주쿠 (Hotel Gracery Shinjuku)</h1>
  <section class="_gallery"><h2>객실 사진</h2><button>모두 보기</button></section>
  ${COMMON_DECOYS}
  <section class="_rvbox">
    <div class="_score"><span>8.7</span><span>우수</span><span>30,165 건의 이용후기</span><button>모두 보기</button></div>
    <div class="_lst">${cards}</div>
  </section>
</body></html>`;

// 아고다는 호텔 답글을 리뷰 카드 **안에** 넣는다(실측 2026-08-29).
// 답글이 손님 리뷰보다 길면 "가장 긴 텍스트"를 뽑는 로직이 답글을 본문으로 저장해버린다.
// 게다가 답글은 정형문이라 앞 80자가 서로 같아 중복 제거에 걸려 페이지가 통째로 날아간다.
const REPLY_TEXT = "고객님 이번에 저희 호텔을 이용해 주셔서 진심으로 감사드립니다. "
  + "또한 훌륭한 후기를 남겨 주셔서 깊이 감사드립니다. 신주쿠역에서의 접근성과 직원들의 응대에 "
  + "만족해 주셨다니 매우 기쁩니다. 앞으로도 고객님께 만족스러운 서비스를 제공할 수 있도록 "
  + "노력하겠습니다. 다시 뵙기를 진심으로 기다리고 있겠습니다.";

const cardsWithReply = REVIEWS.slice(0, 4).map(([name, date, rating, body]) => `
  <li class="_c8x9k">
    <div class="_hdr"><span class="_nm">${name}</span><span class="_dt">${date}</span></div>
    <div class="_st" aria-label="별점 ${rating}점">★★★★★</div>
    <div class="_bd"><span>${body}</span></div>
    <div class="_reply"><span>${REPLY_TEXT}</span></div>
  </li>`).join("");

const HTML_AGODA_REPLY = `<html><body>
  <h1>호텔 그레이스리 신주쿠</h1>
  ${COMMON_DECOYS}
  <section class="_rvbox"><ol class="Review-comments">${cardsWithReply}</ol></section>
</body></html>`;

// C. 아고다 실사용형 — **객실 목록이 리뷰 목록보다 항목이 많다** (실측 2026-08-29).
//    객실 카드에도 날짜(무료취소 기한)와 긴 설명이 있어 "리뷰 모양"으로 채점된다.
//    리뷰는 한 페이지에 5개뿐이라, 개수로만 고르면 객실 목록이 이긴다.
//    → 개수가 아니라 '리뷰다움'(평점·산문 유무, 가격·예약버튼 없음)으로 골라야 한다.
const ROOMS = [
  ["트윈룸 - 금연실", "377,706"], ["더블룸 - 금연실", "392,410"],
  ["스탠다드 트윈", "401,220"], ["디럭스 더블 - 시티뷰", "455,900"],
  ["슈페리어 트윈", "468,330"], ["코너 트윈룸", "512,040"],
  ["패밀리룸 4인", "598,110"], ["스위트 - 시티뷰", "731,250"],
  ["이그제큐티브 더블", "802,400"], ["펜트하우스 스위트", "1,120,000"],
];
const roomCards = ROOMS.map(([name, price]) => `
  <div class="_rmcard">
    <div class="_rmname">${name}</div>
    <div class="_rmopt">조식 불포함 · 무료 취소 (2026년 9월 21일까지) · 침대 2개</div>
    <div class="_rmprice">₩${price}</div>
    <button>예약하기</button>
  </div>`).join("");

// 모달을 하나 띄워둔다 — 이게 없으면 visibleModals()의 **루프 본문이 아예 안 돌아서**
// 그 안의 오류(예: 정의 안 된 헬퍼 호출)를 테스트가 못 잡는다. 실제로 그렇게 놓쳤다.
const HTML_AGODA_LIVE = `<html><body>
  <h1>호텔 그레이스리 신주쿠 (Hotel Gracery Shinjuku)</h1>
  ${COMMON_DECOYS}
  <div role="dialog" aria-modal="true" class="_childpolicy">
    <button aria-label="닫기">×</button>
    <h3>아동 정책</h3><p>미취학 아동은 침대 및 식사 미제공 시 무료입니다.</p>
  </div>
  <section class="_rooms"><h2>객실 선택</h2>
    <div class="RoomGrid-content">${roomCards}</div>
  </section>
  <section class="_rvbox">
    <div class="_score"><span>8.7</span><span>우수</span><span>29,887 건의 이용후기</span><button>모두 보기</button></div>
    <ol class="Review-comments">${cards}</ol>
  </section>
</body></html>`;

// ── 시나리오 실행기 ──────────────────────────────────────────
function setup(html, hostname, pathname) {
  const { window, document } = parseHTML(html);

  // linkedom엔 innerText가 없다. 렌더링 개념이 없으니 textContent로 대체한다
  // (실제 브라우저의 innerText는 줄바꿈을 반영하지만 컨테이너 판별에는 영향 없음).
  const ElementProto = Object.getPrototypeOf(document.createElement("div"));
  if (!("innerText" in ElementProto)) {
    Object.defineProperty(ElementProto, "innerText", {
      get() { return this.textContent; },
      configurable: true,
    });
  }
  window.getComputedStyle = () => ({ overflowY: "visible", visibility: "visible", display: "block" });
  // linkedom은 Event만 제공한다. 평범한 객체를 dispatchEvent에 넘기면 내부에서 터지므로
  // 반드시 진짜 Event를 상속해야 한다 (그냥 흉내내면 클릭 경로가 통째로 안 돌아 버그를 놓친다).
  window.MouseEvent = class MouseEvent extends window.Event {};
  window.KeyboardEvent = class KeyboardEvent extends window.Event {
    constructor(type, o = {}) { super(type, o); Object.assign(this, o); }
  };
  window.location = { hostname, pathname, search: "", href: `https://${hostname}${pathname}` };
  // linkedom엔 레이아웃이 없어 getBoundingClientRect가 전부 0을 준다.
  // 크기로 거르는 코드(visibleModals, findNextButton)가 전부 통과 못 하므로 값을 준다.
  const EP2 = Object.getPrototypeOf(document.createElement("div"));
  EP2.scrollIntoView = function () {};
  EP2.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 };
  };
  EP2.click = function () {};   // 다운로드 저장 경로가 a.click()을 부른다

  Object.assign(globalThis, {
    window, document,
    location: window.location,
    getComputedStyle: window.getComputedStyle,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    URLSearchParams,
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
  });
  // node의 URL은 getter라 Object.assign으로 못 덮는다. createObjectURL만 있으면 된다.
  Object.defineProperty(globalThis, "URL", {
    value: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    configurable: true,
  });

  // 로드 시 찍는 안내 로그는 검증 출력과 섞이니 삼킨다
  const real = { log: console.log, group: console.group, groupEnd: console.groupEnd, table: console.table };
  console.log = console.group = console.groupEnd = console.table = () => {};
  (0, eval)(SRC);
  const api = window.collectReviews;
  const result = api.probe();          // probe 로그도 삼킨 상태에서 실행
  Object.assign(console, real);
  return { ...result, document, window };
}

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`); fail++; }
};

// ── A. 에어비앤비형 ──────────────────────────────────────────
console.log("\n[A] 에어비앤비형 — 버튼 문구에 '후기' 포함\n");
{
  const { container, openBtn } = setup(HTML_AIRBNB, "www.airbnb.co.kr", "/rooms/1004020027854453112");

  check("리뷰 컨테이너를 찾았다", !!container);
  check("정확히 리뷰 리스트(._lst)를 잡았다", container?.className === "_lst",
    `→ 실제: <${container?.tagName?.toLowerCase()} class="${container?.className}">`);
  check("카드 6개를 모두 인식했다", container?.children.length === 6, `→ 실제: ${container?.children.length}`);
  check("편의시설 목록에 낚이지 않았다", !container?.querySelector("li"));
  check("날짜만 있고 본문이 짧은 달력 그리드에 낚이지 않았다", container?.className !== "_grid");
  check("모달 버튼을 찾았다", !!openBtn);
  check("모달 버튼 텍스트가 맞다", (openBtn?.innerText || "").includes("후기 60개 모두 보기"),
    `→ 실제: "${openBtn?.innerText}"`);

  if (container?.children.length) {
    const second = container.children[1];
    check("본문에 리뷰 내용이 들어 있다",
      second.textContent.replace(/\s+/g, " ").includes("주차비를 현장에서 따로 받더라고요"));
    check("평점 aria-label을 읽었다",
      second.querySelector("[aria-label]")?.getAttribute("aria-label") === "별점 4점");
  }
}

// ── B. 아고다형 ──────────────────────────────────────────────
console.log("\n[B] 아고다형 — 버튼이 그냥 '모두 보기' (사진 갤러리에도 동일 문구 존재)\n");
{
  const { container, openBtn } = setup(HTML_AGODA, "www.agoda.com", "/ko-kr/hotel-gracery-shinjuku/hotel/tokyo-jp.html");

  check("리뷰 컨테이너를 찾았다", !!container);
  check("정확히 리뷰 리스트(._lst)를 잡았다", container?.className === "_lst",
    `→ 실제: <${container?.tagName?.toLowerCase()} class="${container?.className}">`);
  check("범용 문구 '모두 보기' 버튼을 찾았다", !!openBtn,
    "→ 못 찾으면 아고다에서 모달이 안 열린다");
  check("사진 갤러리의 '모두 보기'가 아니라 리뷰 쪽을 골랐다",
    openBtn?.closest?.("._rvbox") != null && openBtn?.closest?.("._gallery") == null,
    `→ 실제 조상: ${openBtn?.parentElement?.className}`);
}

// ── C. 아고다 실사용형 — 객실 목록 10개 vs 리뷰 5개 ──────────
console.log("\n[C] 아고다 실사용형 — 객실 목록이 리뷰보다 항목이 많다\n");
{
  const { container } = setup(HTML_AGODA_LIVE, "www.agoda.com", "/ko-kr/hotel-gracery-shinjuku/hotel/tokyo-jp.html");
  const cls = typeof container?.className === "string" ? container.className : "";

  check("리뷰 컨테이너를 찾았다", !!container);
  check("**객실 목록이 아니라 리뷰 목록**을 골랐다", cls.includes("Review-comments"),
    `→ 실제로 고른 것: <${container?.tagName?.toLowerCase()} class="${cls}">`);
  check("리뷰 카드 6건을 인식했다", container?.children.length === 6, `→ ${container?.children.length}`);

  // 객실 카드가 후보로는 잡히되(날짜·긴 설명이 있으니) 순위에서 져야 정상이다
  const api = window.collectReviews._;
  const ranked = api.rankCandidates();
  const room = ranked.find((c) => (typeof c.el.className === "string" ? c.el.className : "").includes("RoomGrid"));
  const rev = ranked.find((c) => (typeof c.el.className === "string" ? c.el.className : "").includes("Review-comments"));
  check("객실 목록도 후보에는 오른다 (날짜·본문이 있으므로)", !!room);
  if (room && rev) {
    check("리뷰다움 점수는 리뷰 목록이 더 높다",
      rev.reviewness > room.reviewness,
      `→ 리뷰 ${rev.reviewness?.toFixed(2)} vs 객실 ${room.reviewness?.toFixed(2)}`);
    check("개수는 객실 목록이 더 많다 (그래서 개수로 고르면 진다)", room.ok > rev.ok,
      `→ 객실 ${room.ok} vs 리뷰 ${rev.ok}`);
  }
}

// ── C2. 호텔 답글이 리뷰 본문을 밀어내는 문제 ────────────────
console.log("\n[C2] 호텔 답글이 카드 안에 있을 때 — 손님 리뷰를 뽑아야 한다\n");
{
  const { container } = setup(HTML_AGODA_REPLY, "www.agoda.com", "/ko-kr/x/hotel/tokyo-jp.html");
  const api = window.collectReviews._;
  check("리뷰 목록을 찾았다", !!container);

  const { reviews } = api.extractReviews(container);
  check("답글 때문에 리뷰가 날아가지 않았다 (4건 유지)", reviews.length === 4,
    `→ ${reviews.length}건`);
  check("본문이 **손님 리뷰**다 (호텔 답글이 아니라)",
    reviews[0]?.text.includes("위치도 좋고 깨끗했어요"),
    `→ "${reviews[0]?.text.slice(0, 45)}…"`);
  check("답글이 본문으로 새어 들어오지 않았다",
    !reviews.some((r) => r.text.includes("진심으로 감사드립니다")));
  check("정상 리뷰가 호텔답글로 오분류되지 않았다",
    !reviews.some((r) => r.isHotelReply));

  // 실측(괌 두짓타니 2026-08-29): 답글이 **영어**였고 "Thank you again for choosing"처럼
  // 중간에 단어가 껴서 문구 매칭이 빗나갔다. 그 결과 답글이 본문으로 저장되고,
  // 정형문이라 앞부분이 같아 2페이지가 통째로 중복 처리됐다.
  const api2 = window.collectReviews._;
  const ENG_REPLIES = [
    "Dear PARK, Thank you again for choosing Dusit Thani Guam Resort. We hope to have the "
      + "pleasure of welcoming you back for another memorable stay. Sincerely Yours, Yumi Oka, "
      + "Admin Assistant to the Director of Rooms",
    "Dear Kim, We're delighted to know you enjoyed the warm service from our front desk team. "
      + "Best regards, General Manager",
    "고객님 이번에 저희 호텔을 이용해 주셔서 진심으로 감사드립니다.",
    "답변일: 2025년 9월 7일 일요일",
  ];
  for (const t of ENG_REPLIES) {
    check(`답글로 인식: "${t.slice(0, 28)}…"`, api2.isHotelReply(t));
  }
  // 진짜 리뷰가 잘못 걸리면 리뷰를 통째로 잃는다 — 반대 방향도 확인
  const REAL = [
    "두짓타니는 이번이 3번 째 숙박이었습니다. 항상 친절한 프런트 직원의 안내로 방을 배정 받으면 눈앞에 펼쳐지는 투몬 비치에 절로 힐링이 됩니다.",
    "다 좋았는데 주차비를 현장에서 따로 받더라고요. 하루 2만원이었습니다.",
    "Great location and very clean rooms. The staff were friendly and helpful throughout our stay.",
  ];
  for (const t of REAL) {
    check(`리뷰로 인식(오분류 아님): "${t.slice(0, 24)}…"`, !api2.isHotelReply(t));
  }
}

// ── C3. 정책 문장 vs 광고 문구 ───────────────────────────────
// 실측 2026-08-29: 결과 조건 없이 잡았더니 정책 6건 중 5건이 광고 문구였다
// ("여행 계획 변경 시 무료 취소 가능합니다!"). 진짜 정책은 **기한 + 결과**가 함께 있다.
console.log("\n[C3] 취소정책 문장만 골라내는가\n");
{
  setup(HTML_AGODA_REPLY, "www.agoda.com", "/ko-kr/x/hotel/tokyo-jp.html");
  const isPol = window.collectReviews._.isPolicySentence;

  const POLICY = [
    "유연한 예약! 2026년 9월 22일 화요일 전 예약 취소 시 무료 취소 가능 체크인 날짜 전 1일 이내 "
      + "예약 취소 시 첫 1박 요금이 취소 요금으로 부과됩니다.",
    "체크인 날짜 전 8일 이내 예약 취소 시 예약 요금의 41%가 취소 요금으로 부과됩니다",
    "예약한 호텔에 체크인하지 않을 경우 노쇼(No-Show)로 간주되며 예약 요금의 100%가 부과됩니다",
    "이 요금은 환불이 불가합니다",
    "체크인 3일 전 18시까지 무료 취소, 이후 첫 1박 요금 부과",
    // 실측(괌 2026-08-29): **결과가 기한보다 앞에** 오는 형태. 한 방향만 보면
    // 이런 문장을 통째로 놓쳐서 정책이 0건이 됐다.
    "예약 무료 취소 가능 - 2026년 9월 20일 전 예약 취소 시",
  ];
  const ADS = [
    "여행 계획 변동 가능성이 있는 경우 예약 무료 취소 가능 상품을 예약해 변화하는 상황에 유연하게 대처하세요",
    "이 숙소의 모든 객실 상품 >> 예약 무료 취소 가능",
    "여기서 객실 예약 후 여행 계획 변경 시 예약 무료 취소 가능합니다!",
    "조식 포함 · 트윈룸 · 금연실",
  ];
  for (const t of POLICY) check(`정책으로 인식: "${t.slice(0, 30)}…"`, isPol(t));
  for (const t of ADS) check(`광고로 제외: "${t.slice(0, 30)}…"`, !isPol(t));
}

// ── C4. 객실별 취소정책 — 팀 제출 형식이 요구하는 단위 ───────
console.log("\n[C4] 객실/요금제별 정책을 객실명과 짝지어 뽑는가\n");
{
  const ROOMS_HTML = `<html><body>
    <h1>두짓타니 괌 리조트</h1>
    <section class="RoomGrid-content">
      <div class="rm">
        <div class="nm">스탠다드 트윈 - 금연실</div>
        <div class="opt">조식 불포함</div>
        <div class="pol">체크인 날짜 전 3일 이내 예약 취소 시 첫 1박 요금이 취소 요금으로 부과됩니다.</div>
        <div class="pr">₩457,348</div><button>예약하기</button>
      </div>
      <div class="rm">
        <div class="nm">클럽 오션프런트 스위트</div>
        <div class="opt">조식 포함 · 특가</div>
        <div class="pol">이 요금은 환불이 불가합니다.</div>
        <div class="pr">₩612,000</div><button>예약하기</button>
      </div>
      <div class="rm">
        <div class="nm">디럭스 더블 - 시티뷰</div>
        <div class="opt">조식 포함</div>
        <div class="pol">체크인 날짜 전 8일 이내 예약 취소 시 예약 요금의 41%가 취소 요금으로 부과됩니다.</div>
        <div class="pr">₩498,000</div><button>예약하기</button>
      </div>
    </section>
  </body></html>`;

  setup(ROOMS_HTML, "www.agoda.com", "/ko-kr/dusit-thani-guam-resort/hotel/guam-gu.html");
  const rooms = window.collectReviews._.collectRoomPolicies();

  check("정책 3건을 찾았다", rooms.length === 3, `→ ${rooms.length}건`);
  check("전부 객실명이 붙었다", rooms.every((r) => r.roomName),
    `→ ${rooms.map((r) => r.roomName || "(없음)").join(" / ")}`);
  check("객실명이 정확하다", rooms.some((r) => r.roomName === "스탠다드 트윈 - 금연실"),
    `→ ${rooms.map((r) => r.roomName).join(" / ")}`);
  check("환불불가 요금제도 잡았다", rooms.some((r) => r.policy.includes("환불이 불가")));
  check("정책과 객실이 올바르게 짝지어졌다",
    rooms.find((r) => r.roomName === "클럽 오션프런트 스위트")?.policy.includes("환불이 불가"));
  check("가격·버튼이 정책으로 새어들지 않았다",
    !rooms.some((r) => r.policy.includes("₩") || r.policy.includes("예약하기")));
}

// ── C5. 실사용 화면 — 짧은 요금제 라벨 + [정책] 탭의 숨은 비용 ──
// 실측(발리 우마나 2026-08-29): 객실 카드의 정책 문구는 "환불 불가 (낮은 요금)" 13자,
// "예약 무료 취소" 8자다. 문장용 최소 길이(15자)를 쓰면 131개 카드를 보고도 0건이 나온다.
// 그리고 [정책] 탭에는 주차료·조식요금·숙박세가 **공식적으로** 적혀 있다 —
// 리뷰에서 찾으려던 바로 그 정보다.
console.log("\n[C5] 실사용 화면 — 짧은 라벨과 [정책] 탭 숨은 비용\n");
{
  const LIVE_HTML = `<html><body>
    <h1>우마나 발리, LXR 호텔 앤 리조트</h1>
    <section class="RoomGrid-content">
      <div class="rm">
        <div class="nm">One Bedroom Valley Pool Villa</div>
        <div class="opt">조식 포함</div>
        <div class="pol">환불 불가 (낮은 요금)</div>
        <div class="pr">₩626,885</div><button>예약하기</button>
      </div>
      <div class="rm">
        <div class="nm">(OD09WL) Bali Getaway 디럭스 트윈</div>
        <div class="opt">조식 포함</div>
        <div class="pol">예약 무료 취소</div>
        <div class="pr">₩813,428</div><button>예약하기</button>
      </div>
    </section>
    <section class="policytab">
      <h3>주차 정보</h3><div>주차료(1일): 0 IDR</div>
      <h3>추가 정보</h3><div>조식 요금(객실 요금에 불포함 시): 425000 IDR</div>
      <div>공항 이동 교통편 서비스 요금: 435000 IDR</div>
      <h3>기타 안내</h3>
      <ul>
        <li>오사카부 숙소세는 숙소에서 별도로 징수됩니다. 해당 세금은 예약 요금에 포함되어 있지 않으니 참고하시기 바랍니다.</li>
        <li>6세 이상 아동에게는 추가 침대 및 조식 요금이 부과됩니다.</li>
      </ul>
    </section>
  </body></html>`;

  setup(LIVE_HTML, "www.agoda.com", "/ko-kr/umana-bali-lxr-hotels-resorts/hotel/bali-id.html");
  const api = window.collectReviews._;

  const rooms = api.collectRoomPolicies();
  check("짧은 요금제 라벨을 잡았다 (15자 미만)", rooms.length >= 2, `→ ${rooms.length}건`);
  check("'환불 불가 (낮은 요금)'을 잡았다", rooms.some((r) => r.policy.includes("환불 불가")));
  check("'예약 무료 취소'를 잡았다", rooms.some((r) => r.policy.includes("예약 무료 취소")));
  check("객실명이 붙었다", rooms.every((r) => r.roomName),
    `→ ${rooms.map((r) => r.roomName || "(없음)").join(" / ")}`);

  const fees = api.collectFees();
  check("주차료를 뽑았다", Object.keys(fees).some((k) => k.includes("주차료")),
    `→ ${JSON.stringify(fees)}`);
  check("조식 요금(불포함 시)을 뽑았다", Object.keys(fees).some((k) => k.includes("조식 요금")));
  check("금액 값이 붙었다", Object.values(fees).some((v) => /425000|IDR/.test(v)),
    `→ ${JSON.stringify(fees)}`);

  const notices = api.collectNotices();
  check("숙박세 안내를 잡았다", notices.some((t) => t.includes("숙소세")), `→ ${notices.length}건`);
  check("아동 추가요금 안내를 잡았다", notices.some((t) => t.includes("추가 침대")));
}

// ── C6. 컨테이너가 통째로 교체돼도 이어서 모으는가 ───────────
// 실측(아고다 2026-08-29): 페이지를 넘기면 리뷰 목록 <ol>이 통째로 갈아끼워진다.
// 우리가 들고 있던 참조는 화면에서 떨어져 나간 노드가 되고, 그 노드는 영원히 안 바뀌므로
// "내용이 안 바뀜"으로 3~4페이지에서 매번 멈췄다. 이게 진짜 원인이었다.
console.log("\n[C6] 목록이 교체돼도 이어서 수집하는가\n");
{
  const { window: w, document: d } = (() => {
    setup(HTML_AGODA_LIVE, "www.agoda.com", "/ko-kr/x/hotel/tokyo-jp.html");
    return { window: globalThis.window, document: globalThis.document };
  })();
  const api = w.collectReviews._;

  const list = d.querySelector("ol.Review-comments");
  check("시작 목록을 찾았다", !!list);

  // 지문이 목록 내용을 반영하는지
  const sig1 = api.pageSignature(list);
  check("페이지 지문이 만들어진다", sig1.length > 0);

  // 목록을 통째로 교체 — 실사이트에서 벌어지는 일과 같은 상황
  const fresh = d.createElement("ol");
  fresh.className = "Review-comments";
  fresh.innerHTML = `
    <li><div><span>박서준</span><span>2026년 1월</span></div>
      <div aria-label="별점 4점">★</div><div><span>주차비가 하루 3만원씩 따로 나갔습니다. 미리 알았으면 좋았을 텐데요.</span></div></li>
    <li><div><span>이하늘</span><span>2025년 12월</span></div>
      <div aria-label="별점 5점">★</div><div><span>리조트피가 1박당 별도로 부과된다는 안내를 체크인 때 처음 들었습니다.</span></div></li>
    <li><div><span>최민지</span><span>2025년 11월</span></div>
      <div aria-label="별점 5점">★</div><div><span>전망이 아주 좋았고 직원분들도 친절했습니다. 다시 오고 싶은 곳이에요.</span></div></li>`;
  list.replaceWith(fresh);

  check("옛 참조는 화면에서 떨어져 나갔다", !list.isConnected);
  check("교체된 목록을 다시 찾는다", api.findReviewContainer()?.className === "Review-comments");

  // 옛 참조로 지문을 재면 안 바뀐 것처럼 보인다 — 이게 조기 종료의 원인이었다
  check("옛 참조의 지문은 그대로다 (조기 종료의 원인)", api.pageSignature(list) === sig1);

  const { reviews } = api.extractReviews(api.findReviewContainer());
  check("교체된 목록에서 새 리뷰를 뽑는다", reviews.length === 3, `→ ${reviews.length}건`);
  check("비용 언급 리뷰가 들어 있다", reviews.some((r) => r.text.includes("주차비")));
}

// ── D. 런타임 스모크 — 내보낸 함수를 실제로 한 번씩 호출한다 ──
//
// 실측 2026-08-29: `visibleModals` 안에서 정의되지 않은 `styleOf`를 부르는 바람에
// 실사이트 수집이 통째로 죽었다. 그런데 이 테스트들은 전부 통과했다 —
// probe()만 부르고 **실제 수집 경로(expandAll → visibleModals)는 한 번도 안 탔기 때문**이다.
// node --check(구문 검사)로도 안 잡힌다. 그래서 함수를 실제로 호출해 본다.
console.log("\n[D] 런타임 스모크 — 내보낸 함수가 실제로 돌아가는지\n");
{
  const { container } = setup(HTML_AGODA_LIVE, "www.agoda.com", "/ko-kr/hotel-gracery-shinjuku/hotel/tokyo-jp.html");
  const api = window.collectReviews._;

  // 함수를 '호출만' 해서는 부족하다 — 루프 본문이 안 돌면 그 안의 오류를 못 잡는다.
  // 픽스처에 모달을 넣어뒀으니, 닫기 전에 먼저 '찾아내는지'를 확인한다.
  try {
    check("visibleModals()가 모달을 찾는다 (루프 본문이 돌았다는 증거)",
      api.visibleModals().length === 1, `→ ${api.visibleModals().length}개`);
  } catch (e) {
    check("visibleModals()가 모달을 찾는다", false, `→ ${e.message}`);
  }

  // 가짜 DOM에는 모달을 닫아줄 페이지 코드가 없다. 실제 사이트처럼 반응하게 붙여준다 —
  // 이래야 "닫기 버튼을 찾아 눌렀고 실제로 닫혔다"는 경로가 검사된다.
  const modal = document.querySelector('[role="dialog"]');
  modal.querySelector("button")?.addEventListener("click", () => modal.remove());

  const calls = [
    ["closeStrayModals", () => api.closeStrayModals(new Set())],
    ["expandAll", () => api.expandAll(container)],
    ["findNextButton", () => api.findNextButton(container)],
    ["collectOfficialClaims", () => api.collectOfficialClaims()],
    ["siteOf", () => api.siteOf()],
    ["listingIdOf", () => api.listingIdOf()],
    ["listingNameOf", () => api.listingNameOf()],
    ["reviewnessOf", () => api.reviewnessOf([...container.children])],
    ["extractReviews", () => api.extractReviews(container)],
    ["collectPolicy", () => api.collectPolicy()],
    ["collectAllPages", () => api.collectAllPages(container, { maxPages: 1 })],
    ["downloadJson", () => api.downloadJson("t.json", "{}")],
    ["saveResult", () => api.saveResult({ site: "agoda", listingId: "x", reviews: [] })],
  ];

  for (const [name, fn] of calls) {
    try {
      await fn();
      check(`${name}()`, true);
    } catch (e) {
      check(`${name}()`, false, `→ ${e.message}`);
    }
  }

  // closeStrayModals(빈 Set) = "전부 낯선 모달" 이므로 아동 정책 모달이 닫혀 있어야 한다
  check("closeStrayModals()가 모달을 실제로 닫았다",
    api.visibleModals().length === 0, `→ 아직 ${api.visibleModals().length}개 남음`);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
