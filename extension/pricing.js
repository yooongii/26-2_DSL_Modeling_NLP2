// 가격 추출 — darkpattern/detectors/sequential-pricing.js에서 검증된 알고리즘을 그대로 이식.
// (라벨+가격을 동시에 담는 "가장 작은 블록"을 페이지 전체에서 찾는 방식 — React 트리
// 깊이가 사이트마다 달라 조상 단계를 하드코딩하는 방식은 버렸다는 경위는 그쪽 파일 참고)
//
// 여기서 새로 추가하는 것: "화면에 크게 보이는 가격(헤드라인)"과 "총액 라벨이 붙은 실제
// 가격"을 같은 페이지 안에서 비교하는 findPriceGap(). 이전 세션에서 여러 페이지를 오가며
// priceHistory를 쌓아 비교하던 방식(순차공개 가격책정 탐지기)은 SPA 네비게이션에 의존해
// 데모 안정성이 낮았다 — 아고다 사례(큰 글씨 60,194원 vs 작은 글씨 실제총액 72,835원)는
// 사실 페이지 하나 안에서도 이미 드러나 있었으므로, 단일 스냅샷 비교로 바꿔 더 안정적으로
// 데모 가능하게 만들었다.

(function () {
  const TOTAL_LABEL_RE = /총\s*(결제)?\s*금액|합계|최종\s*결제|총액|결제\s*금액|총\s*요금|결제할\s*금액/;
  const PRICE_RE_GLOBAL = /₩\s*([\d,]{4,})|([\d,]{4,})\s*원/g;
  const MAX_CANDIDATE_TEXT_LEN = 400;
  const MAX_LEAF_TEXT_LEN = 40;

  function extractAmounts(text) {
    const amounts = [];
    for (const m of text.matchAll(PRICE_RE_GLOBAL)) {
      const digits = m[1] ?? m[2];
      if (!digits) continue;
      const amount = parseInt(digits.replace(/,/g, ""), 10);
      if (amount >= 1000) amounts.push(amount);
    }
    return amounts;
  }

  function isOwn(node) {
    return node.closest && node.closest(".cc-ui");
  }

  function findTotalPriceNode(doc) {
    const candidates = doc.querySelectorAll("div, span, strong, b, td, dd, p, li, section, article");
    let best = null;
    let bestScopeLen = Infinity;
    let bestAmount = null;
    for (const node of candidates) {
      if (isOwn(node)) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > MAX_CANDIDATE_TEXT_LEN) continue;
      if (!TOTAL_LABEL_RE.test(text)) continue;
      if (text.length >= bestScopeLen) continue;
      const amounts = extractAmounts(text);
      if (!amounts.length) continue;
      best = node;
      bestScopeLen = text.length;
      bestAmount = Math.max(...amounts);
    }
    return best ? { node: best, amount: bestAmount } : null;
  }

  // "첫 1박 요금이 취소 요금으로 부과됩니다"류 취소 페널티를 원화로 계산하려면 1박 요금이
  // 필요하다 — 숙박 일수를 체크인/체크아웃 날짜로 역산해서 (총액÷박수)로 추정할 수도
  // 있지만, 카드에 이미 "1박당 총 금액"이라고 명시돼 있으면 그걸 직접 읽는 게 날짜 파싱
  // 오류에 덜 취약하다(사장님 제안).
  const PER_NIGHT_LABEL_RE = /1박당|박당/;

  function findPerNightPriceNode(doc) {
    const candidates = doc.querySelectorAll("div, span, strong, b, td, dd, p, li, section, article");
    let best = null;
    let bestScopeLen = Infinity;
    let bestAmount = null;
    for (const node of candidates) {
      if (isOwn(node)) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > MAX_CANDIDATE_TEXT_LEN) continue;
      if (!PER_NIGHT_LABEL_RE.test(text)) continue;
      if (text.length >= bestScopeLen) continue;
      const amounts = extractAmounts(text);
      if (!amounts.length) continue;
      best = node;
      bestScopeLen = text.length;
      bestAmount = Math.max(...amounts);
    }
    return best ? { node: best, amount: bestAmount } : null;
  }

  // 부킹닷컴형(총액 라벨 자체가 없이 "기본금액" + "+세금 및 기타요금"을 따로만 보여주는 사이트) 폴백.
  const FEE_ADDENDUM_RE = /[+＋]\s*세금\s*(?:및|과)?\s*(?:기타)?\s*요금/;

  function findFeeAddendumTotal(doc) {
    const candidates = doc.querySelectorAll("div, span, strong, b, td, dd, p, li, section, article");
    let feeAmount = null;
    let feeNode = null;
    for (const node of candidates) {
      if (isOwn(node)) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > 120) continue;
      if (!FEE_ADDENDUM_RE.test(text)) continue;
      const amounts = extractAmounts(text);
      if (!amounts.length) continue;
      feeAmount = amounts[0];
      feeNode = node;
      break;
    }
    if (feeAmount == null || !feeNode) return null;
    let ancestor = feeNode.parentElement;
    for (let depth = 0; depth < 4 && ancestor; depth++) {
      const text = (ancestor.innerText || "").trim();
      if (text.length > 400) break;
      const amounts = extractAmounts(text);
      const base = amounts.find((a) => a !== feeAmount);
      if (base != null) {
        return { node: ancestor, amount: base + feeAmount };
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  // 헤드라인 후보: 자식 요소 없는 리프 노드 중 가격 하나만 짧게 담고 있고, 글자 크기가 큰 것.
  function findHeadlinePrice(doc, excludeNode) {
    const candidates = doc.querySelectorAll("span, strong, b, div, dd, td, p");
    let best = null;
    let bestFontPx = 0;
    for (const node of candidates) {
      if (isOwn(node)) continue;
      if (node.children.length > 0) continue; // 리프만
      if (excludeNode && (node === excludeNode || excludeNode.contains(node))) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > MAX_LEAF_TEXT_LEN) continue;
      const amounts = extractAmounts(text);
      if (amounts.length !== 1) continue; // 헤드라인은 보통 가격 하나만 단독 표시
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const fontPx = parseFloat(style.fontSize) || 0;
      if (fontPx < 16) continue; // 헤드라인이라 부를 만큼 커야 함
      if (fontPx > bestFontPx) {
        bestFontPx = fontPx;
        best = { node, amount: amounts[0], fontPx };
      }
    }
    return best;
  }

  /**
   * 최종 결제액 계산. scopeRoot를 넘기면 그 안에서만 찾는다(다른 요금제 정보 혼입 방지) —
   * scopeRoot를 생략하면 기존처럼 문서 전체에서 찾는다(결제페이지처럼 요금제가 하나뿐인
   * 화면은 이걸로 충분히 잘 동작했다 — 사장님 확인 완료).
   */
  function computeFinalPrice(doc, scopeRoot) {
    const root = scopeRoot ?? doc;
    // 사이트 어댑터(price.finalPrice)가 있으면 먼저 시도한다. 라벨 없이 "세금 포함"만 붙는
    // 사이트용이고, 못 읽으면(null) 아래 공용 방식으로 넘어간다. 어댑터 예외는 삼킨다.
    let custom = null;
    try {
      custom = window.__ccSites?.current()?.price?.finalPrice?.(root) ?? null;
    } catch (e) {}
    return custom ?? findTotalPriceNode(root) ?? findFeeAddendumTotal(root);
  }

  /** 헤드라인(크게 보이는) 가격과 실제 총액이 5% 이상 차이나면 격차로 판단 */
  // 아고다에서 이 탐지가 잡는 것: "같은 1박짜리 총액"인데 숨은 수수료 때문에 화면에 크게
  // 보이는 가격과 실제 결제액이 달라지는 경우(예: 60,194원 vs 72,835원). 사이트 어댑터가
  // price.finalPrice 를 직접 제공하면(Trip.com 실측: 큰 글씨=1박 가격, 별도 "총금액:"=
  // 박수×가격+세금) 얘기가 다르다 — 그 사이트가 이미 "총액: N원, 객실 1개 x K박"으로
  // 스스로 투명하게 밝히고 있고, 둘의 차이는 숨김이 아니라 단순 박수 곱셈이라 5% 문턱을
  // 항상, 크게 넘는다(실측: 5박에서 +995,808원 = 400%). 이 경우 일반 탐지를 적용하면
  // 정상적인 다박 표기를 매번 "가격이 다르다"고 오탐한다 — 어댑터가 total 을 직접 계산해
  // 준다는 것 자체가 "이 사이트는 헤드라인·총액 관계가 이미 알려진 패턴"이라는 뜻이므로
  // 그 경우엔 이 일반 탐지를 건너뛴다.
  function findPriceGap(doc, scopeRoot) {
    if (window.__ccSites?.current()?.price?.finalPrice) return null;
    const root = scopeRoot ?? doc;
    const total = computeFinalPrice(doc, root);
    if (!total) return null;
    const headline = findHeadlinePrice(root, total.node);
    if (!headline) return null;
    if (headline.amount === total.amount) return null;
    const deltaPct = (total.amount - headline.amount) / headline.amount;
    if (Math.abs(deltaPct) < 0.05) return null;
    return {
      headlineAmount: headline.amount,
      headlineNode: headline.node,
      totalAmount: total.amount,
      totalNode: total.node,
      deltaPct,
    };
  }

  // ---- 포커스 카드: "지금 사용자가 보고 있는 요금제" 찾기 ------------------------------
  // v1(문서 전체에서 가장 작은 블록)의 근본 문제: 목록/상세 페이지엔 요금제가 여러 개
  // 동시에 DOM에 있고, 그중 어느 것과도 무관하게 "우연히 조건에 맞고 우연히 작은" 블록을
  // 집어왔다 — 스크롤로 새 요금제가 로드/노출될 때마다 완전히 다른 요금제의 가격·취소조건이
  // 섞여 들어와 초록↔빨강이 튀는 원인이었다(아고다 실측). 뷰포트 중앙에 가장 가까운 가격
  // 카드를 "포커스 카드"로 정하고, 가격·취소조건 검색을 그 카드 안으로만 제한한다.
  const PRICE_RE_TEST = /₩\s*[\d,]{4,}|[\d,]{4,}\s*원/;
  const CARD_MAX_TEXT_LEN = 3000;
  // 아고다 실측: 디자인시스템 래퍼(ae018-box류)가 자식 하나만 감싼 채 텍스트가 똑같은
  // 채로 여러 겹 이어지는 경우가 많아, 가격 패널과 취소문구가 실제로는 "같은 행" 안에
  // 있어도 8단계로는 공통 조상에 못 닿는 경우가 실측에서 확인됐다(같은 교훈을 이미
  // briefing.js의 가격 보강 탐색에 적용했었는데, 정작 포커스 카드 자체를 찾는 여기엔
  // 빠져 있었다) — 단계 수 제한을 사실상 없애고 텍스트 길이 상한만으로 안전을 보장한다.
  const CARD_MAX_ANCESTOR_DEPTH = 40;

  function findPriceLeavesLoose(doc) {
    const candidates = doc.querySelectorAll("span, strong, b, div, dd, td, p, li");
    const leaves = [];
    for (const node of candidates) {
      if (isOwn(node)) continue;
      if (node.children.length > 0) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > 40) continue;
      if (!PRICE_RE_TEST.test(text)) continue;
      leaves.push(node);
    }
    return leaves;
  }

  // 아고다 실측 결과: badges.js처럼 "링크가 있어야 카드"로 정의했더니, 상세페이지의
  // 요금제 행은 <a> 없이 <button>이거나 그냥 div인 경우가 있어 카드를 하나도 못 찾았다 —
  // 그러면 "카드 구조가 아예 없는 페이지"로 오인해 문서 전체 폴백으로 빠지고, 그 폴백엔
  // 뷰포트 제한이 없어서 화면 밖 다른 요금제의 정보를 계속 집어오는 문제가 재발했다.
  // 링크 유무 대신, 우리가 실제로 필요한 것 그대로 정의를 바꿨다: "이 가격과 취소 관련
  // 문구를 동시에 담는 가장 작은 블록" — pricing.js/cancellation.js 둘 다에 직접 쓸모
  // 있는 조건이라 badges.js(목록 페이지의 반복 카드 탐지, 용도가 다름)보다 더 안정적이다.
  const CANCEL_KEYWORD_TEST = /취소|환불/;
  // 아고다 실측(디럭스 트윈베드): 가격 바로 옆에 "예약 무료 취소"처럼 날짜 없는 짧은
  // 배지가 따로 있고, 진짜 날짜가 들어간 상세 문구("예약 무료 취소 가능 - 2026년 8월
  // 28일...")는 반대편 컬럼(상세 목록)에 별도로 있는 경우가 있다. 그냥 "취소" 키워드만
  // 있으면 멈추면 이 배지에서 먼저 멈춰버려서 진짜 상세 문구까진 올라가지도 못한다 —
  // "실제 정책처럼 보이는 내용"(날짜/불가/위약금/체크인 N일)이 있어야만 멈추도록 조건을
  // 좁혀서, 의미 없는 배지는 지나치고 진짜 상세 문구가 있는 조상까지 계속 올라가게 한다.
  // "취소 정책"류 콜랩스 라벨도 멈춰야 할 지점에 포함시킨다 — 이것마저 빼면 콜랩스 카드는
  // 라벨을 넘어 계속 올라가다 엉뚱한 옆 방의 진짜 정책과 다시 섞이는 문제가 재발한다.
  const LOOKS_LIKE_POLICY_RE =
    /\d{1,2}월\s*\d{1,2}일|불가|위약금|체크인\s*(?:날짜)?\s*(?:전\s*)?\d+\s*일\s*(?:전까지|이내)|취소\s*정책|환불\s*정책|취소\s*규정/;

  /**
   * 우리가 페이지에 그려 넣은 UI(.cc-ui)의 글자를 뺀 텍스트.
   *
   * badges.js가 가격 옆에 "환불 불가 요금제로 보임" 같은 배지를 그리는데, 그 문구가
   * CANCEL_KEYWORD_TEST(환불)와 LOOKS_LIKE_POLICY_RE(불가)를 둘 다 통과해버린다.
   * 그래서 climbToRelevantBlock이 진짜 요금제 카드까지 올라가지 못하고 "가격 + 우리
   * 배지"만 담긴 작은 블록(실측 79자)에서 멈췄고, 그 블록에서 .cc-ui를 걸러내고 나면
   * 남는 게 없어 status=none("취소 조건을 아직 확인 못했어요")이 떴다.
   * — 우리 출력이 우리 입력으로 되돌아오는 자기간섭이라, 판정 전에 잘라내야 한다.
   */
  function textExcludingOwnUI(node) {
    if (!node.querySelector || !node.querySelector(".cc-ui")) {
      return (node.innerText || "").trim(); // 우리 UI가 없으면 기존 경로 그대로(빠름)
    }
    let out = "";
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(t) {
        return t.parentElement && t.parentElement.closest(".cc-ui")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) out += walker.currentNode.nodeValue + " ";
    return out.replace(/\s+/g, " ").trim();
  }

  function climbToRelevantBlock(leaf) {
    let node = leaf.parentElement;
    for (let depth = 0; depth < CARD_MAX_ANCESTOR_DEPTH && node; depth++) {
      const text = textExcludingOwnUI(node);
      if (text.length > CARD_MAX_TEXT_LEN) return null;
      if (text.length >= 20 && CANCEL_KEYWORD_TEST.test(text) && LOOKS_LIKE_POLICY_RE.test(text)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 화면에 걸쳐 있는 "가격+취소문구" 블록들 중 뷰포트 중앙에 가장 가까운 것을 반환한다.
   * 반환값의 hasCardStructure로 두 가지 상황을 구분한다:
   *  - hasCardStructure=false: 이 페이지엔 그런 블록이 아예 없다(결제페이지처럼 요금제가
   *    하나뿐인 단순 구조) → 호출부는 문서 전체 검색으로 폴백해도 안전하다.
   *  - hasCardStructure=true, card=null: 블록은 존재하지만 지금 화면엔 하나도 안 보인다
   *    (예: 상세페이지 진입 직후 사진 영역만 보이고 요금제는 아직 스크롤 전) → 이때는
   *    절대 폴백하면 안 된다 — 화면 밖 다른 요금제 정보가 섞여 들어오는 게 바로 이번에
   *    재현된 버그였다.
   */
  // 아고다 요금 행은 data-testid="room-offer-price-info" 를 갖는다. 이게 원본 요금과
  // "요금 N개 더 보기"로 펼친 요금 **양쪽에 모두** 있는 유일한 안정 속성이다
  // (data-element-name / data-context-id 는 펼친 쪽에 없다 — 실측).
  //
  // 그런데 offer 노드 자체는 시각적 행보다 작다(실측: 노드 87px vs 시각 행 266px).
  // 그 차이 179px 위에 커서를 두면 어느 행에도 안 걸려 직전 값이 그대로 남는다.
  // 그래서 "형제 요금을 품기 직전"까지 조상을 타고 올라가 시각적 행 전체를 잡는다.
  // 선택자 자체는 사이트 어댑터(sites.js → hints.rateRow)가 준다. 어댑터가 없거나 힌트가
  // 없으면 null 이라 아래 휴리스틱(findPriceLeavesLoose)으로 간다.
  const offerSel = () => window.__ccSites?.hint("rateRow") ?? null;
  function offerHitTarget(offerNode, sel = offerSel()) {
    let node = offerNode;
    if (!sel) return node;
    while (node.parentElement) {
      const p = node.parentElement;
      if (p.querySelectorAll(sel).length > 1) break;      // 옆 요금까지 삼키기 직전
      if (p.getBoundingClientRect().height > window.innerHeight * 0.8) break;
      node = p;
    }
    return node;
  }

  function findAllRelevantBlocks(doc) {
    // 사이트 구조를 알아볼 수 있으면 그걸 쓴다 — 휴리스틱보다 경계가 정확하다.
    const sel = offerSel();
    let offers = sel ? [...doc.querySelectorAll(sel)] : [];
    // 숨은 행이 DOM 에 남아 있는 사이트는 보이는 행만 쓴다(hints.rateRowVisibleOnly).
    if (window.__ccSites?.hint("rateRowVisibleOnly")) {
      offers = offers.filter((o) => {
        const r = o.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }
    if (offers.length) {
      const seen = new Set();
      const rows = [];
      for (const o of offers) {
        const hit = offerHitTarget(o, sel);
        if (seen.has(hit)) continue;
        seen.add(hit);
        rows.push(hit);
      }
      if (rows.length) return rows;
    }

    const leaves = findPriceLeavesLoose(doc);
    const seen = new Set();
    const blocks = [];
    for (const leaf of leaves) {
      const block = climbToRelevantBlock(leaf);
      if (!block || seen.has(block)) continue;
      seen.add(block);
      blocks.push(block);
    }
    // 같은 요금제 안에 가격 표기가 여러 개(1박가 / 총액 / 할인 전 가격)라 각각이 서로
    // 다른 조상에서 멈추면서, 한 객실에서 블록이 2개 이상 잡히는 일이 생긴다. 그러면
    // 마우스 위치에 따라 "안쪽 블록(요약만 있음)"과 "바깥 블록(전문까지 있음)"이 번갈아
    // 잡혀 같은 객실인데 답이 달라진다(실측: 오른쪽에선 82,812원, 왼쪽으론 ?).
    // 포함 관계면 바깥 것만 남긴다 — 정보가 더 많은 쪽이다.
    return blocks.filter((b) => !blocks.some((other) => other !== b && other.contains(b)));
  }

  // allBlocks를 미리 계산해서 넘길 수 있게 분리했다 — findFocusCard/findVisibleCards가
  // 각자 findAllRelevantBlocks(가격 전체를 훑고 최대 40단계까지 조상을 타는, 페이지에
  // 요금제가 많으면 꽤 무거운 함수)를 따로 호출하던 걸 스캔 한 번에 한 번만 하도록
  // 묶을 수 있다(실측: 요금제 15~20개 페이지에서 스크롤 반응이 눈에 띄게 느려졌었다).
  function findFocusCardFromBlocks(allBlocks) {
    if (!allBlocks.length) return { card: null, hasCardStructure: false, dist: Infinity };

    const viewportH = window.innerHeight;
    const centerY = viewportH / 2;
    let best = null;
    let bestDist = Infinity;
    for (const block of allBlocks) {
      const rect = block.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= viewportH) continue; // 화면 밖은 후보 제외
      const dist = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      if (dist < bestDist) {
        bestDist = dist;
        best = block;
      }
    }
    // dist도 같이 반환한다 — briefing.js의 히스테리시스가 "이전 카드가 화면에 조금이라도
    // 걸쳐 있으면 무조건 유지"가 아니라 "새 후보보다 확실히 밀리지 않을 때만 유지"로
    // 판단하려면 두 후보의 중앙 거리를 비교해야 한다.
    return { card: best, hasCardStructure: true, dist: bestDist };
  }

  function findFocusCard(doc) {
    return findFocusCardFromBlocks(findAllRelevantBlocks(doc));
  }

  /**
   * "같은 화면 내 요금제 비교" 용 — 지금 뷰포트에 걸쳐 있는 "가격+취소문구" 블록을
   * 전부 반환한다(포커스 카드처럼 하나만 고르지 않음). 화면 밖 요금제는 비교 대상에서
   * 제외한다 — 지금 보고 있는 것끼리 비교해야 의미가 있고, 화면 밖 것까지 끌어오면
   * 다른 버그들과 같은 이유로 엉뚱한 비교가 될 위험이 있다.
   */
  function findVisibleCards(doc) {
    const allBlocks = findAllRelevantBlocks(doc);
    const viewportH = window.innerHeight;
    return allBlocks.filter((block) => {
      const rect = block.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < viewportH;
    });
  }

  window.__ccPricing = {
    textExcludingOwnUI,
    offerHitTarget,
    computeFinalPrice,
    findPriceGap,
    findTotalPriceNode,
    findFeeAddendumTotal,
    findPerNightPriceNode,
    extractAmounts,
    findFocusCard,
    findFocusCardFromBlocks,
    findVisibleCards,
    findAllRelevantBlocks,
  };
})();
