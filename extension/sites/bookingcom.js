// Booking.com 어댑터. 계약은 ../sites.js 헤더 참고.
//
// 근거: 2026-09-22 실측 조사(윤서). 아래 "실측"은 그 조사에서 확인된 것이고 "미확인"은 아직
// 샘플이 없어 추정으로 둔 부분이다 — 샘플을 받으면 바로 고칠 것.
//
// 범위: 가격 + 취소 + 체크인/체크아웃 + 리뷰.
//   실측(2026-09-22~23): 리뷰 요청은 POST https://www.booking.com/dml/graphql,
//   operationName: "ReviewList", credentials:"omit"으로도 200 응답(reviewCard 10건 확인).
//   요청 바디는 operationName·variables·query(GraphQL 문서 전체, 실측 원문을 QUERY_DOCUMENT
//   에 그대로 넣었다)·extensions(={} , persisted-query 아님) 4개 필드다. variables 구조도
//   전체 실측됐다(아래 reviewVariables 참고: hotelId, hotelCountryCode, sorter,
//   filters.scoreRange, skip/limit, hotelScore, upsortReviewUrl, searchFeatures).
//   sorter: SCORE_ASC 로 낮은 평점 우선(아고다와 같은 관례) — NEWEST_FIRST/OLDEST_FIRST 도
//   응답 sorter 필드에서 존재는 확인됐으나 우리는 SCORE_ASC 만 쓴다.
//   실측(query 문서에서 확인): reviewListFrontend 는 유니온 타입이라 정상 응답
//   (ReviewListFrontendResult) 말고 ReviewsFrontendError(statusCode·message)로도 올 수
//   있다 — HTTP 200, 최상위 GraphQL errors 도 없이. callReviewApi 가 __typename 을 확인해서
//   이 경우를 "리뷰 0건"으로 묻지 않고 에러로 던진다.
//   ufi(목적지 ID): 실측 샘플 1건에서 input.ufi === input.searchFeatures.destId === (그
//   요청 URL의) dest_id 였다. 이 관계가 모든 상세페이지에서 항상 성립한다고 일반화된 건
//   아니다. 상세페이지 자체 URL에 dest_id 가 실리는지는 확인 안 돼서(확인된 건 "그 요청의
//   URL"이지 브라우저 주소창의 상세페이지 URL이 아니다), 페이지 URL 쿼리와 hotel_id 와 같은
//   방식의 페이지 내부 JS 변수 스캔 둘 다 최선 노력으로 시도한다 — 확정된 값이 아니다.
//
// 아직 없는 것/미확인:
//   · provisionalPrice — 요금표 로딩 전 임시 시작가. 확인 안 됨
//   · ufi 추출 위치 — 위 설명 참고(최선 노력, 확정 아님)
//   · ROW_SEL(tr.e2e-hprt-table-row)·TOTAL_PRICE_SEL(.bui-price-display__value.prco-f-font-heading)
//     은 실사용 리포트로 딱 한 행에서 교차 확인(실결제액과 일치, 수량선택 <option>의 괄호
//     금액과도 일치)한 것이지 여러 호텔·객실에서 검증한 건 아니다. 이 price 소스는 이미
//     두 번 틀렸었다(data-hotel-rounded-price → 엉뚱한 값, .hprt-reservation-total-price →
//     ⓘ 아이콘 눌러야만 DOM에 생기는 팝업 전용 노드였음 — 아래 가격 섹션 주석 참고). 그러니
//     이 페이지 구조도 호텔마다 다를 가능성을 염두에 둘 것 — 가격이 이상하면 여기부터
//     의심한다.
//   · 취소 정책 모달의 닫기 버튼이 공용 [aria-label*="닫기"] 패턴으로 실제로 닫히는지는
//     트리거의 data-modal-close-aria-label 값으로 추정한 것이지 직접 클릭해서 닫히는 것까지
//     확인한 건 아니다 — 안 닫히면 Trip.com처럼 closeModal(Escape 디스패치 등) 훅이 필요하다
//   · 목록 페이지 달력 등 UI 간섭 여부 — 미확인이라 excludeZones 비워둠

(function () {
  // ⚠️ 정정(2026-09-23): 처음엔 /hotel/{country}/{slug}.ko.html 처럼 언제나 .ko. 로케일
  // 접미사가 붙는다고 실측했었는데, 실사용 리포트로 반례가 나왔다 — 상세페이지에서 날짜를
  // 바꾸면(부킹닷컴 자체 "검색 변경") URL이 /hotel/jp/premium-monday-asakusa-one.html 처럼
  // .ko. 없이 바뀌는 경우가 있었다. 이걸 상세가 아니라고 오판하면 isDetail()에 기대는
  // hotelId·stayDates·isListingPage가 전부 연쇄로 망가지고, 브리핑 카드 자체가 사라진다
  // (실측: 정확히 이 증상으로 리포트됨 — 카드·배지 안 뜨고 요금제 선택도 안 먹힘, 호버
  // 기반의 픽 버튼만 살아남았는데 그건 isDetail()을 안 거치는 별도 경로라서였다). 로케일
  // 접미사는 있어도 없어도 되는 걸로 완화한다.
  const DETAIL_PATH_RE = /\/hotel\/[^/]+\/[^/]+\.html/;
  const isDetail = () => DETAIL_PATH_RE.test(location.pathname);

  // ── 페이지 판정 ────────────────────────────────────────────────────────────
  // 실측: 목록 /searchresults.ko.html, 상세 /hotel/{country}/{slug}.ko.html. 그 밖의
  // 페이지(결제 페이지 secure.booking.com 포함)는 계약상 "목록"과 같이 취급해 카드를 숨긴다
  // — 결제 페이지에서 이 카드를 띄울 이유가 없고, 그쪽은 paymentCurrency.js가 따로 맡는다.
  const isListingPage = () => !isDetail();

  // 실측: 상세 URL에는 숫자 hotelId가 직접 없다 — 페이지 내부 데이터에서 읽어야 한다.
  // ⚠️ 정정(2026-09-23, 실사용 리포트): 매물마다 변수명 관례가 다르다 — 첫 실측(아사쿠사
  // 매물)에서는 snake_case(hotel_id = 803986, b_hotel_id = "803986")였는데, 다른 매물
  // (마이하마 매물)은 그 패턴이 아예 없고 대신 camelCase JSON("hotelId":15905929, Apollo
  // 캐시 스크립트 안)만 있었다. 정확한 등장 위치(인라인 <script>의 JS 변수 대입 vs JSON
  // 블록)는 못 봐서, 아고다 방식과 같이 페이지 HTML 전체에서 두 관례를 모두 느슨하게
  // 찾는다. 후보가 하나뿐이면 그대로 신뢰하고(비교 대상이 없으니 노이즈가 섞일 수 없다 —
  // 아고다에서 겪은 교훈), 여럿이면(두 관례가 같이 매치되거나 노이즈가 섞이면) 다수결로
  // 거른다.
  const HOTEL_ID_PATTERNS = [
    /\bb?_?hotel_id["']?\s*[:=]\s*"?(\d+)"?/g, // snake_case: hotel_id / b_hotel_id
    /"hotelId"\s*:\s*"?(\d+)"?/g, // camelCase JSON: "hotelId":NNN
  ];
  function hotelId() {
    if (!isDetail()) return null;
    const html = document.documentElement.innerHTML;
    const matches = HOTEL_ID_PATTERNS.flatMap((re) => [...html.matchAll(re)]).map((m) => m[1]);
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    const counts = new Map();
    for (const id of matches) counts.set(id, (counts.get(id) || 0) + 1);
    let best = null, bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) { best = id; bestCount = count; }
    }
    return bestCount >= matches.length / 2 ? best : null;
  }

  // ── 체크인/체크아웃 ────────────────────────────────────────────────────────
  // 실측: 상세 페이지 URL 쿼리에 checkin=2026-10-14, checkout=2026-10-30 형태(YYYY-MM-DD)로
  // 그대로 들어 있다. 화면 텍스트를 스캔하는 공용 코드보다 정확한 출처라 여기서 직접 읽는다.
  // 날짜 변경 시 상세 페이지가 풀 리로드된다는 점(실측)을 감안하면 이 값은 항상 "지금 URL의
  // 현재 조회 조건"과 일치한다고 볼 수 있다.
  const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function parseYmdParam(v) {
    const m = v && YMD_RE.exec(v);
    return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
  }
  function stayDates() {
    if (!isDetail()) return null;
    const q = new URLSearchParams(location.search);
    const checkin = parseYmdParam(q.get("checkin"));
    const checkout = parseYmdParam(q.get("checkout"));
    return checkin && checkout ? { checkin, checkout } : null;
  }

  // ── 가격 ───────────────────────────────────────────────────────────────────
  // 실측(2026-09-22): 요금 옵션의 root는 div가 아니라 <tr>다(class에 e2e-hprt-table-row가
  // 붙는다 — "e2e"는 보통 자동화 테스트용 식별자라 클래스명 중에선 비교적 안정적이라고
  // 본다). data-block-id도 안정적으로 붙는다(같은 행의 수량 선택 <select>의
  // data-block-id·data-room-id와 일치하는 것까지 실측 확인).
  //
  // ⚠️ 정정(2026-09-23): 처음엔 data-hotel-rounded-price 속성값이 화면에 크게 보이는
  // 총액과 같다고 실측했었는데, 그건 우연히 맞은 샘플이었다 — 실사용 중 이 속성이
  // 1,590,270인데 실제 결제 확정 총액(사용자가 "지금 예약"으로 직접 확인)은 13,949,535인
  // 경우가 나왔다(같은 행의 다른 텍스트 "환불 불가 · 총 1,590,270원"과는 일치해서, 저
  // 속성이 뭔가 다른 값을 가리키긴 하는데 정확히 뭔지는 특정 못 했다). 그래서 이 속성은
  // 더 이상 가격 소스로 쓰지 않는다 — ROW_SEL 매칭용으로 쓰지도 않는다(값을 못 믿는데
  // 존재 여부까지 믿을 근거는 약하다).
  //
  // ⚠️ 정정 2(2026-09-23): .hprt-reservation-total-price로 다시 옮겼었는데, 그것도 틀렸다 —
  // 새로고침 직후(아무 상호작용 없는 상태)에는 이 노드가 아예 존재하지 않는다는 게 실사용
  // 리포트로 반복 확인됐다. 대화를 되짚어보니, 이 노드가 "처음" 잡혔던 건 가격 옆 ⓘ
  // 아이콘(정보 아이콘, 클릭하면 "식사/예약취소/선결제" 요금 상세 팝업이 뜨는 그 버튼)을
  // 사용자가 이미 눌러본 뒤였다 — 즉 .hprt-reservation-total-price는 그 팝업 안쪽에만
  // 있는, 클릭해야 DOM에 붙는 요소였다(팝업을 안 열면 존재 자체를 안 한다).
  //
  // 진짜로 항상 존재하는 노드는 처음부터 실측했던 헤드라인 가격 자체다: .bui-price-display__value
  // 클래스가 붙은 div 안의 .prco-valign-middle-helper 스팬(₩13,949,535 텍스트). 이 div에는
  // 추가로 .prco-f-font-heading이 붙는데, 취소선 처리된 원래 가격(.js-hp-rt-total-strikethrough,
  // .prco-f-font-body — heading이 아니라 body임)과 구분하는 데 쓴다. 팝업 안의
  // .hprt-reservation-total-price도 같은 .bui-price-display__value 클래스를 공유하지만
  // .prco-f-font-heading은 없어서, 이 선택자는 팝업이 열려 있어도 안 열려 있어도 항상
  // 헤드라인 쪽만 잡는다.
  //
  // "추가 요금이 발생할 수 있습니다" 문구가 있어 이 총액이 현장 결제분까지 다 포함한
  // 최종 결제액이라고 단정하지 않는다 — 다만 이건 아고다·Trip.com의 "총 금액"에도 똑같이
  // 있는 통상적인 단서 조항이라, 화면에 표시된 공식 총액으로는 그대로 신뢰한다(숨은 비용은
  // 이 확장의 리뷰 분석이 별도로 다루는 영역).
  const ROW_SEL = "tr[data-block-id].e2e-hprt-table-row";
  const TOTAL_PRICE_SEL = ".bui-price-display__value.prco-f-font-heading";

  function extractAmount(text) {
    const m = (text || "").match(/[\d,]{4,}/);
    return m ? parseInt(m[0].replace(/,/g, ""), 10) : null;
  }

  // node는 TOTAL_PRICE_SEL 노드(div) 자체를 돌려준다 — tr/td 같은 표 구조 요소가 아니라
  // 일반 div라, 인라인 배지(briefing.js renderInlineBadges)가 이 바로 뒤에
  // insertAdjacentElement("afterend", …)로 형제를 끼워 넣어도 표 레이아웃이 깨지지 않는다
  // (실측 리포트였던 "카드 배지가 위치가 제각각" 문제의 원인이 tr을 그대로 node로 썼던
  // 것이었다).
  function finalPrice(scope) {
    const row = scope.matches?.(ROW_SEL) ? scope : scope.querySelector?.(ROW_SEL) ?? scope.closest?.(ROW_SEL);
    if (!row) return null;
    const node = row.querySelector(TOTAL_PRICE_SEL);
    if (!node) return null;
    const amount = extractAmount(node.innerText);
    return amount >= 1000 ? { node, amount } : null;
  }

  // 실측(2026-09-23): usesFirstNight 구간(패턴 B — 위약금 = 첫 1박 요금)의 실제 원화 금액을
  // 보여주려면 1박 단가가 필요한데, 이 사이트는 "1박당" 라벨 자체가 없어(총액만 표시) 공용
  // 스캔(findPerNightPriceNode)이 항상 실패해서 위약금이 "?"로 표시되는 문제가 리포트됐다.
  // stayDates(URL의 checkin/checkout)로 박수를 구해 총액÷박수로 **평균** 1박가를 추정한다 —
  // 요일별로 가격이 다르면 실제 "첫날" 가격과는 다를 수 있는 근사치다(정확한 1박 단가를
  // 페이지가 별도로 보여주는지는 확인 안 됨).
  function perNightAmount(scope) {
    const price = finalPrice(scope);
    const dates = stayDates();
    if (!price || !dates) return null;
    const ci = new Date(dates.checkin.year, dates.checkin.month - 1, dates.checkin.day);
    const co = new Date(dates.checkout.year, dates.checkout.month - 1, dates.checkout.day);
    const nights = Math.round((co - ci) / 86400000);
    if (!(nights > 0)) return null;
    return { node: price.node, amount: Math.round(price.amount / nights) };
  }

  // ── 취소 정책 ──────────────────────────────────────────────────────────────
  // 실측(2026-09-23, 실사용 리포트로 발견): 행에 붙은 짧은 문구("OO년 O월 O일 전까지 무료
  // 취소 가능")와 달리, 정확한 위약금 조건(패턴 A/B)은 "?" 아이콘을 눌러야 뜨는 모달
  // 안에만 있다 — 클릭 없이 화면에 보이는 게 아니었다(이전 "미확인" 항목이 이제 확인됨).
  // 이 훅이 없으면 공용 코드가 클릭을 안 시켜서 행 문구만 잡히고 정확한 조건은 놓친다.
  //
  // 실측: 트리거는 data-testid="policy-modal-trigger" 버튼(행 안에 있음, type="button"이라
  // 페이지 이동 없음), aria-controls로 자기 모달의 id(policyModal_{...})를 가리킨다.
  // ⚠️ 부킹닷컴 페이지엔 role="dialog"인 모달이 여러 개 동시에 떠 있을 수 있다(실측: 지도
  // 모달도 role="dialog"였다) — 공용 코드의 "보이는 dialog 아무거나" 방식은 엉뚱한 걸
  // 잡을 수 있어서, id가 policyModal_로 시작하는 것만 고른다.
  // 닫기 버튼은 트리거의 data-modal-close-aria-label="닫기" 값으로 미루어 aria-label="닫기"로
  // 렌더될 것으로 보고, 공용 닫기 버튼 패턴([aria-label*="닫기"])에 맡긴다(Trip.com처럼
  // Escape 디스패치가 필요한지는 미확인 — 모달이 안 닫히면 여기부터 의심할 것).
  const POLICY_TRIGGER_SEL = '[data-testid="policy-modal-trigger"]';
  const POLICY_MODAL_SEL = '[id^="policyModal_"]';

  function revealTrigger(scope) {
    return scope?.querySelector?.(POLICY_TRIGGER_SEL) ?? null;
  }

  function modal(doc) {
    const candidates = [...doc.querySelectorAll(POLICY_MODAL_SEL)];
    return (
      candidates.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) ?? null
    );
  }

  // 모달 전체 텍스트를 그대로 돌려준다 — "식사/예약 취소/선결제"가 한 모달에 섞여 있지만,
  // 아래 parse()의 정규식들은 문장을 통째로 찾으므로 섹션을 따로 잘라낼 필요가 없다
  // (Trip.com처럼 "취소" 섹션만 골라내는 처리가 필요 없다 — 구조가 더 단순하다).
  function modalText(el) {
    return el.innerText || "";
  }

  // 실측한 원문 2종(문구가 다르면 null → 공용 분류기로 넘어간다):
  //  A. "취소, 변경, 노쇼 시에는 총 예약 요금이 위약금으로 부과됩니다." — 환불불가(항상 전액).
  //     시점과 무관하게 100%라 lossSteps가 아니라 status: "nonrefundable"로 바로 답한다
  //     (공용 분류기의 nonrefundable과 같은 뜻 — briefing.js가 이 상태를 가장 정확하게
  //     다룬다: 평평한 손실선, 무료취소 대안과의 차액 비교 등).
  //  B. "체크인 날짜까지 N일 이상 남은 경우 무료 취소가 가능합니다. 체크인 날짜까지 N일
  //     남은 시점부터는 취소하실 경우 위약금으로 첫 1박 요금이 부과됩니다. 노쇼 발생 시,
  //     위약금으로 취소 위약금과 동일한 금액이 부과됩니다." — Trip.com에 없던 새 유형:
  //     위약금이 퍼센트/고정금액이 아니라 "첫 1박 요금"(usesFirstNight, 공용 코드에
  //     이미 있는 개념 — 아고다의 "첫 1박 요금" 패턴과 동일하게 처리된다).
  //  목록 카드에는 마감 "시각" 없이 날짜만 나온다("2026년 10월 7일 전까지 무료 취소 가능").
  //  이 행 문구는 절대 날짜라 체크인 계산이 필요 없어 우선 사용한다.
  //
  // ⚠️ 날짜 경계 해석은 실측 문구를 그대로 옮긴 것이지 제3의 예시로 재검증한 게 아니다 —
  // "OO일 전까지 무료"는 그날까지 포함(다음날부터 위약금)으로, "N일 남은 시점부터 위약금"은
  // 체크인 N일 전 그날부터 위약금 시작으로 읽었다. 실제 체크인 날짜와 화면에 뜬 무료취소
  // 마감일을 하나 골라 "며칠 전"인지 직접 대조해서 맞는지 확인해줘야 한다.
  const FULL_PRICE_PENALTY_RE = /취소,?\s*변경,?\s*노쇼\s*시에는\s*총\s*예약\s*요금이\s*위약금으로\s*부과됩니다/;
  const FREE_UNTIL_N_DAYS_RE = /체크인\s*날짜까지\s*(\d+)\s*일\s*이상\s*남은\s*경우\s*무료\s*취소가?\s*가능합니다/;
  const FIRST_NIGHT_AFTER_N_DAYS_RE = /체크인\s*날짜까지\s*(\d+)\s*일\s*남은\s*시점부터는\s*취소하실\s*경우\s*위약금으로\s*첫\s*1?\s*박\s*요금이\s*부과됩니다/;
  const NOSHOW_SAME_RE = /노쇼\s*발생\s*시,?\s*위약금으로\s*취소\s*위약금과\s*동일한\s*금액이\s*부과됩니다/;
  const ROW_FREE_RE = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*전까지\s*무료\s*취소\s*가능/;

  //  C. "체크인 당일 00:00까지 무료 취소가 가능합니다. 체크인 당일 00:00 이후에 취소하실 경우
  //     위약금으로 첫 1박 요금이 부과됩니다. 노쇼 발생 시, …" — 실측(2026-09-24, 체크인 9/28):
  //     모달 첫머리에 "예약 취소 2026년 9월 28일 전까지 무료 취소 가능"이 같이 있다.
  //     체크인 날짜와 같은 "9월 28일 전까지"가 "체크인 당일 00:00까지"와 같은 뜻이므로,
  //     "OO일 전까지"는 그날을 **포함하지 않는다**(그날 0시부터 위약금). 예전엔 "그날까지 무료,
  //     다음날부터 위약금"으로 읽어 시작일이 하루 늦게 표시됐다(이 주석의 ⚠️가 예고한 미검증 항목).
  const CHECKIN_DAY_FREE_RE = /체크인\s*당일\s*(\d{1,2}):(\d{2})\s*까지\s*무료\s*취소가?\s*가능합니다/;
  const FIRST_NIGHT_AFTER_CHECKIN_DAY_RE = /체크인\s*당일\s*(\d{1,2}):(\d{2})\s*이후에\s*취소하실\s*경우\s*위약금으로\s*첫\s*1?\s*박\s*요금이\s*부과됩니다/;

  const NOSHOW_NOTE_SAME = "예약하고 나타나지 않으면(노쇼) 취소 위약금과 같은 금액이 부과돼요.";

  // "OO일 전까지 무료" — 그날 0시 전까지가 무료이므로 위약금은 그날 0시부터 시작한다.
  function startOfDay(y, m, d) {
    return new Date(y, m - 1, d);
  }
  // 마지막 무료 날짜(0시 경계면 그 전날, 시각이 있으면 그날 그 시각) 표시 문구.
  function lastFreeLabel(t) {
    const pad = (n) => String(n).padStart(2, "0");
    if (t.getHours() === 0 && t.getMinutes() === 0) {
      const prev = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
      return `${prev.getFullYear()}년 ${prev.getMonth() + 1}월 ${prev.getDate()}일`;
    }
    return `${t.getFullYear()}년 ${t.getMonth() + 1}월 ${t.getDate()}일 ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }

  function parse(text, ctx) {
    // A: 항상 전액 위약금 — lossSteps 없이 상태만으로 끝낸다(공용 코드가 가장 정확히 다룸).
    if (FULL_PRICE_PENALTY_RE.test(text)) {
      return {
        status: "nonrefundable",
        deadline: null,
        penaltyNote: "취소·변경·노쇼 시 총 예약 요금 전액이 위약금으로 부과돼요.",
        lossSteps: [],
        noShowNote: null,
        noShowPenalty: null,
        raw: text,
      };
    }

    // C: 체크인 당일 HH:MM까지 무료 → 그 이후 첫 1박 요금 위약금.
    const dayFree = CHECKIN_DAY_FREE_RE.exec(text);
    const dayFirstNight = FIRST_NIGHT_AFTER_CHECKIN_DAY_RE.exec(text);
    if (dayFree || dayFirstNight) {
      const hm = dayFirstNight ?? dayFree;
      const hh = +hm[1], mm = +hm[2];
      let threshold = null;
      if (ctx?.checkin) {
        threshold = new Date(ctx.checkin.year, ctx.checkin.month - 1, ctx.checkin.day, hh, mm);
      } else {
        // 체크인을 못 구했으면 모달 첫머리의 절대 날짜("2026년 9월 28일 전까지")를 체크인으로 쓴다.
        const abs = ROW_FREE_RE.exec(text);
        if (abs) threshold = new Date(+abs[1], +abs[2] - 1, +abs[3], hh, mm);
      }
      const noShow = NOSHOW_SAME_RE.test(text);
      return {
        status: "free",
        deadline: threshold ? lastFreeLabel(threshold) : null,
        penaltyNote: "그 이후엔 첫 1박 요금이 위약금으로 부과될 수 있어요.",
        lossSteps: threshold ? [{ thresholdDate: threshold, percent: null, usesFirstNight: true }] : [],
        noShowNote: noShow ? NOSHOW_NOTE_SAME : null,
        noShowPenalty: noShow ? { percent: null, usesFirstNight: true } : null,
        raw: text,
      };
    }

    // B: 무료취소 → 체크인 N일 전부터 첫 1박 요금 위약금.
    const freeUntil = FREE_UNTIL_N_DAYS_RE.exec(text);
    const firstNightAfter = FIRST_NIGHT_AFTER_N_DAYS_RE.exec(text);
    if (freeUntil || firstNightAfter) {
      const n = +(firstNightAfter?.[1] ?? freeUntil?.[1]);
      const noShow = NOSHOW_SAME_RE.test(text);
      let lossSteps = [];
      let deadline = n ? `체크인 ${n}일 전` : null;
      if (ctx?.checkin && n) {
        const ci = new Date(ctx.checkin.year, ctx.checkin.month - 1, ctx.checkin.day);
        const thresholdDate = new Date(ci.getFullYear(), ci.getMonth(), ci.getDate() - n);
        lossSteps = [{ thresholdDate, percent: null, usesFirstNight: true }];
        const md = `${thresholdDate.getMonth() + 1}월 ${thresholdDate.getDate()}일`;
        deadline = `${md}(체크인 ${n}일 전)`;
      }
      return {
        status: "free",
        deadline,
        penaltyNote: "그 이후엔 첫 1박 요금이 위약금으로 부과될 수 있어요.",
        lossSteps,
        noShowNote: noShow ? NOSHOW_NOTE_SAME : null,
        noShowPenalty: noShow ? { percent: null, usesFirstNight: true } : null,
        raw: text,
      };
    }

    // 목록 카드에 보이는 절대 날짜("OO년 O월 O일 전까지 무료 취소 가능") — 체크인 계산이
    // 필요 없다. 이후 위약금 형태(전액인지 첫1박인지)는 이 문구만으로는 알 수 없어 단정하지
    // 않는다(percent/amount/usesFirstNight 전부 비움 → "?"로 표시되고, 상세 문구를 만나면
    // 그쪽 결과로 갈아끼워진다 — briefing.js가 "구간을 더 많이 아는 쪽"을 우선한다).
    const row = ROW_FREE_RE.exec(text);
    if (row) {
      const y = +row[1], m = +row[2], d = +row[3];
      const threshold = startOfDay(y, m, d);
      return {
        status: "free",
        deadline: lastFreeLabel(threshold),
        penaltyNote: null,
        lossSteps: [{ thresholdDate: threshold, percent: null, usesFirstNight: false }],
        noShowNote: null,
        noShowPenalty: null,
        raw: text,
      };
    }

    return null;
  }

  // ── 리뷰 ───────────────────────────────────────────────────────────────────
  // 실측(2026-09-22): POST https://www.booking.com/dml/graphql, operationName:
  // "ReviewList". 응답은 reviewListFrontend.reviewCard[] 안에 reviewScore, reviewedDate,
  // textDetails.{title,positiveText,negativeText,lang} 로 들어온다(bookingDetails 는 지금
  // 안 씀). 만점 10점은 부킹닷컴이 사이트 전체에서 공개적으로 쓰는 표시 관례를 따른 것이고,
  // API 응답에 별도 max 필드가 있는 걸 확인한 건 아니다.
  // 실측 정정(2026-09-23): reviewedDate는 "2025-08-12" 같은 날짜 문자열이 아니라 유닉스
  // 타임스탬프(초) 숫자였다(예: 1712480771). 그대로 review.date에 담아도 문제없다 —
  // review-engine/recency.ts의 parseReviewDate가 문자열로 강제 변환한 뒤 10자리 숫자
  // 패턴(/^\d{10}(\d{3})?$/)으로 유닉스 초/밀리초를 이미 따로 처리한다.
  // 실측(2026-09-23): 매물에 따라 리뷰 자체가 진짜로 하나도 없을 수 있다(빈
  // reviewCard) — 그 경우 "리뷰 본문을 하나도 읽지 못했습니다" 안내가 뜨는 게 맞는
  // 동작이다(버그 아님, 실제로 그 매물 리뷰가 비어 있었던 것으로 확인됨).
  const REVIEW_API = "https://www.booking.com/dml/graphql";
  const REVIEW_OPERATION = "ReviewList";
  const PAGE_SIZE = 10; // 실측 limit=10
  const MAX_PAGES = 8; // Trip.com과 같은 상한(80건) — Booking 쪽 실측 근거는 없는 안전값

  // 실측(2026-09-23): 캡처된 query 문서 원문 그대로. reviewListFrontend 는 유니온 타입이라
  // 응답이 ReviewListFrontendResult(정상: reviewCard 등) 또는 ReviewsFrontendError(statusCode·
  // message) 둘 중 하나로 온다 — 후자는 HTTP 200 에 GraphQL errors 도 없이 올 수 있어서
  // callReviewApi 에서 __typename 을 따로 확인한다(안 그러면 "리뷰 없음"으로 조용히 묻힌다).
  const QUERY_DOCUMENT = `query ReviewList($input: ReviewListFrontendInput!, $shouldShowReviewListPhotoAltText: Boolean = false, $shouldGetUserReviewCount: Boolean = false) {
  reviewListFrontend(input: $input) {
    ... on ReviewListFrontendResult {
      ratingScores {
        name
        translation
        value
        count
        ufiScoresAverage {
          ufiScoreLowerBound
          ufiScoreHigherBound
          __typename
        }
        __typename
      }
      topicFilters {
        id
        name
        isSelected
        translation {
          id
          name
          __typename
        }
        __typename
      }
      reviewScoreFilter {
        name
        value
        count
        __typename
      }
      languageFilter {
        name
        value
        count
        countryFlag
        __typename
      }
      timeOfYearFilter {
        name
        value
        count
        __typename
      }
      customerTypeFilter {
        count
        name
        value
        __typename
      }
      roomTypeFilter {
        name
        roomTypeId
        count
        roomIds
        __typename
      }
      reviewCard {
        reviewUrl
        canChangeVote
        guestDetails {
          username
          avatarUrl
          countryCode
          countryName
          avatarColor
          showCountryFlag
          anonymous
          guestTypeTranslation
          userReviewCount @include(if: $shouldGetUserReviewCount)
          joinedDate @include(if: $shouldGetUserReviewCount)
          __typename
        }
        bookingDetails {
          customerType
          roomId
          roomType {
            id
            name
            __typename
          }
          checkoutDate
          checkinDate
          numNights
          stayStatus
          __typename
        }
        reviewedDate
        isTranslatable
        helpfulVotesCount
        reviewScore
        textDetails {
          title
          positiveText
          negativeText
          textTrivialFlag
          lang
          __typename
        }
        isApproved
        partnerReply {
          reply
          __typename
        }
        positiveHighlights {
          start
          end
          __typename
        }
        negativeHighlights {
          start
          end
          __typename
        }
        editUrl
        photos {
          id
          urls {
            size
            url
            __typename
          }
          kind
          mlTagHighestProbability @include(if: $shouldShowReviewListPhotoAltText)
          __typename
        }
        __typename
      }
      reviewsCount
      sorters {
        name
        value
        __typename
      }
      __typename
    }
    ... on ReviewsFrontendError {
      statusCode
      message
      __typename
    }
    __typename
  }
}
`;

  // 실측: 상세 URL 경로의 country 세그먼트(/hotel/{country}/{slug}.ko.html)가
  // hotelCountryCode 와 같은 값이다.
  const COUNTRY_FROM_PATH_RE = /\/hotel\/([^/]+)\//;
  function hotelCountryCode() {
    const m = COUNTRY_FROM_PATH_RE.exec(location.pathname);
    return m ? m[1] : null;
  }

  // 미확인(최선 노력): ufi 는 두 경로를 순서대로 시도한다 — ① 상세 페이지 URL 쿼리의
  // dest_id(실측된 건 "ReviewList 요청 자체의 URL"이지 브라우저 주소창의 상세페이지 URL이
  // 아니라 여기 있을지는 확인 안 됐지만, 있으면 URL이 DOM 스캔보다 정확한 출처다) ② hotel_id
  // 와 같은 관례로 페이지 내부 JS 변수. 둘 다 못 찾으면 그 필드 자체를 안 보낸다 — 선택
  // 필드일 가능성에 건다.
  const UFI_RE = /\bb?_?ufi["']?\s*[:=]\s*(-?\d+)/;
  function findUfi() {
    const fromUrl = new URLSearchParams(location.search).get("dest_id");
    if (fromUrl != null && /^-?\d+$/.test(fromUrl)) return +fromUrl;
    const m = UFI_RE.exec(document.documentElement.innerHTML);
    return m ? +m[1] : null;
  }

  function reviewVariables(id, skip) {
    const input = {
      hotelId: Number(id),
      hotelCountryCode: hotelCountryCode(),
      sorter: "SCORE_ASC",
      filters: { scoreRange: "ALL" },
      skip,
      limit: PAGE_SIZE,
      upsortReviewUrl: "",
    };
    const ufi = findUfi();
    if (ufi != null) {
      input.ufi = ufi;
      input.searchFeatures = { destId: ufi, destType: "CITY" };
    }
    return { shouldShowReviewListPhotoAltText: true, shouldGetUserReviewCount: false, input };
  }

  async function callReviewApi(id, skip) {
    const res = await fetch(REVIEW_API, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        operationName: REVIEW_OPERATION,
        variables: reviewVariables(id, skip),
        query: QUERY_DOCUMENT,
        extensions: {},
      }),
    });
    if (!res.ok) throw new Error(`리뷰 API ${res.status}`);
    const json = await res.json();
    if (json?.errors?.length) throw new Error(json.errors[0]?.message || "리뷰 API 오류 응답");
    const result = json?.data?.reviewListFrontend;
    // 실측: reviewListFrontend 는 유니온 타입이라 ReviewsFrontendError 로도 올 수 있다(HTTP
    // 200, 최상위 errors 없이). 이걸 놓치면 "리뷰 0건"으로 조용히 묻힌다.
    if (result?.__typename === "ReviewsFrontendError") {
      throw new Error(result.message || `리뷰 API 오류(${result.statusCode})`);
    }
    return result?.reviewCard ?? [];
  }

  function pickText(card) {
    const td = card.textDetails || {};
    return [td.title, td.positiveText, td.negativeText].filter(Boolean).join("\n").trim();
  }

  // reviewtab.js 의 routeByLang 은 r.lang 이 있으면 그걸 그대로 쓰고(없으면 본문에서
  // 추정) ko/en 만 실제 분석 대상이다. textDetails.lang(실측 필드)을 그 타입 집합
  // {ko,en,ja,zh,other} 에 맞춰 정규화해서 넘긴다 — 제목+장점+단점을 합친 본문에서
  // 다시 추정하는 것보다 원문 언어 태그가 더 정확하다.
  function normalizeLang(raw) {
    const l = String(raw || "").toLowerCase();
    if (l.startsWith("ko")) return "ko";
    if (l.startsWith("en")) return "en";
    if (l.startsWith("ja")) return "ja";
    if (l.startsWith("zh")) return "zh";
    return "other";
  }

  async function fetchReviews(onProgress) {
    const id = hotelId();
    if (!id) throw Object.assign(new Error("hotelId를 페이지에서 찾지 못했습니다"), { code: "NO_HOTEL_ID" });
    const all = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const list = await callReviewApi(id, page * PAGE_SIZE);
      all.push(...list);
      onProgress?.(`리뷰 ${all.length}건 가져오는 중`);
      if (list.length < PAGE_SIZE) break;
    }
    if (!all.length) return null;
    return all
      .map((card, i) => {
        const r = Number(card.reviewScore);
        return {
          index: i,
          text: pickText(card),
          date: card.reviewedDate || null,
          rating: Number.isFinite(r) ? r : null,
          ratingScale: 10,
          isHotelReply: false,
          lang: normalizeLang(card.textDetails?.lang),
        };
      })
      .filter((r) => r.text.length > 0);
  }

  try {
    if (!window.__ccSites) throw new Error("sites.js 가 먼저 로드돼야 합니다");
    window.__ccSites.register({
      id: "bookingcom",
      displayName: "부킹닷컴",
      matches: (host) => /(^|\.)booking\.com$/.test(host),
      isListingPage: () => !isDetail(),
      hotelId,
      stayDates,
      hints: {
        rateRow: ROW_SEL,
        // 실측: rateRow(tr)는 표 전체 폭이라 그 우측 상단에 플로팅 버튼/칩을 띄우면
        // 부킹닷컴 자신의 수량 선택 드롭다운과 겹친다 — 실제 좁은 가격 노드를 기준으로 쓴다.
        pickAnchor: TOTAL_PRICE_SEL,
      },
      price: { finalPrice, perNightAmount },
      cancellation: { parse, revealTrigger, modal, modalText },
      reviews: {
        source: "api",
        loadingHint: "부킹닷컴에서 낮은 평점 순으로 가져옵니다",
        fetch: fetchReviews,
      },
    });
  } catch (e) {
    console.error("[cc] 부킹닷컴 어댑터 등록 중 예외:", e);
  }
})();
