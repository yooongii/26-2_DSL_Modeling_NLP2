// 사이트 어댑터 레지스트리 (v0 초안)
//
// 확장 코어(briefing.js·pricing.js·badges.js·content.js)가 "지금 이 사이트가 뭐냐"에 따라
// 갈라져야 하는 지점을 한 곳에 모은다. 사이트를 추가할 때는 어댑터 객체 하나를
// register() 하면 되고, 공용 코드는 건드리지 않는다.
//
// 로드 순서: manifest.json 의 content_scripts.js 에서 **가장 먼저** 로드한다(다른 파일이
// 스캔 시점에 window.__ccSites 를 읽는다). 어댑터 파일은 sites.js 뒤, **content.js 앞**에
// 둔다 — 조회(current)는 스캔 때 일어나므로 첫 스캔(content.js) 전에만 등록이 끝나 있으면 된다.
//
// ── 어댑터 계약 ────────────────────────────────────────────────────────────
// 필수
//   id                 소문자 식별자. 예: "agoda"
//   displayName        사용자에게 보이는 사이트 이름. 안내 문구에 들어간다. 예: "아고다"
//   matches(host)      location.hostname 이 이 사이트인가(boolean)
//   isListingPage(doc) 검색결과/목록 페이지인가. true 면 브리핑카드를 띄우지 않는다
//                      (목록은 안전도 배지 담당)
//   hotelId(doc)       숙소 상세페이지의 숙소 식별자. 상세페이지가 아니거나 못 찾으면 null
//
// 선택
//   localeNotice(doc)       이 페이지의 언어 UI 를 못 읽을 때 {url} (같은 숙소의 지원 언어 페이지 주소),
//                           읽을 수 있으면 null. 값을 반환하면 카드는 값을 만들지 않고 "한국어 페이지에서
//                           동작해요 + 링크" 안내만 띄운다(가격·취소 파서가 한국어 문구 전제라서)
//   provisionalPrice(doc)   요금표가 뜨기 전 임시로 보여줄 "시작가"(원 단위 숫자) 또는 null
//   hints.rateRow           요금 행 노드를 정확히 잡는 CSS 선택자. 없으면 공용 휴리스틱만 쓴다
//   hints.rateRowVisibleOnly  true 면 rateRow 중 화면에 실제로 보이는 것(크기 > 0)만 쓴다.
//                           숨은 행이 DOM 에 남아 있는 사이트용(Trip.com). 기본 false
//   hints.listingCard       목록 카드 노드 선택자. 없으면 공용 휴리스틱만 쓴다
//   hints.pickAnchor        rateRow 안에서 "✓ 이 요금제 보기"/"✓ 선택됨" 플로팅 버튼·칩을
//                           띄울 때 기준으로 쓸 좁은 노드의 CSS 선택자(rateRow 기준
//                           querySelector). 없으면 rateRow 전체의 우측 상단을 기준으로 쓴다
//                           — Agoda/Trip.com처럼 rateRow 자체가 이미 좁은 "카드"면 문제없지만,
//                           rateRow가 화면 폭 전체를 차지하는 표의 tr인 사이트(Booking.com
//                           실측)는 "행의 우측 상단"이 그 사이트 자신의 다른 UI(수량 선택
//                           드롭다운 등)와 겹친다 — 그럴 때 가격처럼 실제로 좁은 노드를
//                           가리키는 선택자를 준다
//   price.finalPrice(scope) 요금 행(scope) 하나에서 **세금 포함 총 결제액**을 읽어 {node, amount}
//                           또는 null 로 돌려준다. 공용 코드는 "총 금액" 같은 라벨이 붙은 가격만
//                           잡는데, 라벨 없이 "세금 포함" 문구만 붙는 사이트에서 쓴다.
//                           이 훅이 있으면 findPriceGap(헤드라인 vs 총액 격차 탐지)은 자동으로
//                           꺼진다 — 그 탐지는 "같은 총액인데 숨은 수수료로 다르게 보임"을
//                           잡는 용도라, 헤드라인이 원래 1박 가격인 사이트(Trip.com)에서는
//                           박수 곱셈만으로 항상 오탐한다
//                           null 이면 공용 방식으로 폴백한다. amount 는 전체 숙박 기준이어야 한다
//                           ⚠️ node는 인라인 배지가 insertAdjacentElement("afterend", …)로 그
//                           바로 뒤에 형제로 끼어든다 — tr/td/tbody 같은 표 구조 요소를 넘기면
//                           표 레이아웃 규칙 밖에서 삽입돼 배지 위치가 행마다 제각각으로
//                           깨진다(실측: Booking.com, tr을 그대로 넘겼다가 발생). 행 안에서
//                           가격 텍스트를 담은 가장 작은 span/div 같은 인라인-세이프 노드를
//                           찾아서 넘길 것 — 못 찾으면 행 자체보다는 null 이 낫다.
//   price.perNightAmount(scope) 요금 행(scope) 하나에서 "1박 요금"을 읽어 {node, amount} 또는
//                           null. cancellation.parse가 usesFirstNight로 답한 구간(예: "첫 1박
//                           요금이 위약금으로 부과됩니다")의 실제 원화 금액을 이걸로 계산한다.
//                           공용 코드는 화면에서 "1박당"/"박당" 라벨이 붙은 텍스트를 직접
//                           찾는데(스코프 안에 그런 라벨이 없으면 실패해 금액이 "?"로 남는다),
//                           총액만 보여주고 1박 단가를 안 보여주는 사이트(Booking.com)는 이
//                           훅으로 finalPrice÷박수 같은 평균값을 직접 계산해 준다 — 이 경우
//                           "정확한 1박치"가 아니라 평균 추정치라는 걸 호출부 문구가 구분해야
//                           할 수도 있으니 이 훅을 쓸 땐 꼭 그 사실을 코드 주석에 남길 것.
//                           null 이면 공용 방식(1박당 라벨 스캔)으로 폴백한다.
//   cancellation            취소 정책 원문이 모달 안에만 있는 사이트용. 셋 다 선택
//     .revealTrigger(scope, node)  모달을 여는 버튼(Element). scope=포커스된 요금 행,
//                           node=행 안에서 찾은 취소 문구 노드. 못 찾으면 null(→ 자동으로 열지 않음).
//                           **실제 페이지 이동을 일으키는 링크를 돌려주면 안 된다.** 없으면
//                           공용 방식(취소 문구 자체나 가까운 button/a 를 클릭)을 쓴다
//     .modal(doc)           지금 열려 있는 취소 정책 모달 Element 또는 null.
//                           role="dialog" 가 없는 모달을 인식시키는 용도
//     .modalText(modal)     모달에서 취소 정책 부분의 원문. 없으면 모달 전체 텍스트
//     .closeModal(modal)    모달을 닫는다(반환값 없음). 공용 코드는 닫기 버튼을
//                           [aria-label*="닫기"|"Close"] / button[class*="close"] 로만 찾는데,
//                           이 셋 다 없는 사이트에서 쓴다. 실측(Trip.com): Escape 키로 닫힘
//                           (아고다는 실측으로 Escape가 안 먹혀서 전역 Escape는 걷어냈다 —
//                           여기서만, 이 사이트가 확실할 때만 눌러야 안전하다)
//     .parse(text, ctx)     취소 문구를 이 사이트 표현대로 직접 해석한다. ctx={checkin:{year,month,day}|null,
//                           nights}. 공용 분류기(classifyBlock)와 같은 모양의 객체
//                           {status, deadline, penaltyNote, lossSteps, noShowNote, noShowPenalty, raw}
//                           를 돌려주고, 모르는 문구면 null(→ 공용 분류기).
//                           lossSteps 원소: {thresholdDate, percent | amount | usesFirstNight}.
//                           thresholdDate 는 "그 날부터 이 손실이 시작되는" 날이고, amount 는
//                           원문이 적은 절대 금액(원)이다. 공용 코드는 날짜를 하루 단위로만 비교한다
//   stayDates(doc)          체크인/체크아웃을 {checkin:{year,month,day}, checkout:{...}} 로. URL 처럼
//                           화면 텍스트보다 정확한 출처가 있을 때만 구현. null 이면 화면 텍스트에서 찾는다
//   excludeZones            DOM 변화 감지에서 제외할 영역의 선택자 배열
//                           (사이트 자체 검색바·팝업이 스캔을 유발하는 걸 막는 용도)
//   reviews                 없거나 source 가 "none" 이면 "리뷰 분석 미지원" 안내만 표시한다
//     .source               "api" | "none"
//     .loadingHint          로딩 중 보조 문구. 예: "아고다에서 낮은 평점 순으로 가져옵니다"
//     .fetch(onProgress)    Promise<Review[] | null>. 리뷰를 아래 Review 형태로 정규화해서 반환.
//                           onProgress(문구) 로 진행 안내를 보낼 수 있다.
//                           상세페이지가 아니라서 숙소를 못 찾았을 때는 e.code = "NO_HOTEL_ID" 로
//                           던진다 → 공용 코드가 폴백 없이 조용히 접는다.
//     .sectionAnchor(doc)   "리뷰 섹션으로 이동" 버튼이 스크롤할 노드 또는 null
//
// Review = { index, text, date, rating, ratingScale, isHotelReply }
//   rating/ratingScale 은 사이트마다 만점이 다르다(아고다 10점). 반드시 함께 넘긴다.
//
// 이 파일은 계약만 검증한다. 사이트별 로직은 각 어댑터에 둔다.

(function () {
  if (window.__ccSites) return;

  const REQUIRED = ["id", "displayName", "matches", "isListingPage", "hotelId"];
  const adapters = [];

  // 잘못된 어댑터가 확장 전체를 죽이지 않게, 던지지 않고 콘솔에 사유를 남긴 뒤 false 를 돌려준다.
  function register(adapter) {
    const missing = REQUIRED.filter((k) => adapter == null || adapter[k] == null);
    if (missing.length) {
      console.error(`[cc] 어댑터 등록 실패(${adapter?.id ?? "?"}): 필수 항목 없음 — ${missing.join(", ")}`);
      return false;
    }
    if (adapters.some((a) => a.id === adapter.id)) {
      console.error(`[cc] 어댑터 등록 실패: id 중복 — ${adapter.id}`);
      return false;
    }
    adapters.push(adapter);
    return true;
  }

  function pick(hostname) {
    return (
      adapters.find((a) => {
        try {
          return a.matches(hostname);
        } catch (e) {
          return false;
        }
      }) ?? null
    );
  }

  // 지금 페이지의 어댑터. 지원하지 않는 사이트면 null — 공용 코드는 이때 아무것도 하지 않는다.
  // MutationObserver 콜백처럼 노드마다 불리는 곳이 있어서 찾은 결과는 호스트별로 캐시한다.
  // (못 찾은 결과는 캐시하지 않는다 — 어댑터가 나중에 등록될 수 있다.)
  const found = new Map();
  function current() {
    const host = location.hostname;
    if (found.has(host)) return found.get(host);
    const a = pick(host);
    if (a) found.set(host, a);
    return a;
  }

  // 선택자 힌트. 없으면 null 이라 호출부는 공용 휴리스틱으로 간다.
  function hint(name) {
    return current()?.hints?.[name] ?? null;
  }

  function excludeZones() {
    return current()?.excludeZones ?? [];
  }

  // 어댑터가 알려준 취소 정책 모달이 "실제로 화면에 보이는" 상태일 때만 돌려준다.
  // 닫아도 DOM 에 숨겨만 두는 모달이 있어서(아고다 사례) 존재 여부만으로는 판단할 수 없다.
  function cancellationModal(doc) {
    let el = null;
    try {
      el = current()?.cancellation?.modal?.(doc) ?? null;
    } catch (e) {
      return null;
    }
    if (!el || !el.isConnected || el.closest?.(".cc-ui")) return null;
    if (el.getAttribute("aria-hidden") === "true") return null;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return null;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return null;
    return el;
  }

  window.__ccSites = { register, pick, current, hint, excludeZones, cancellationModal, list: () => adapters.map((a) => a.id) };
})();
