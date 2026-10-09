// 취소/환불 조건 요약 — v3. "위약금이 발생할 수 있어요" 같은 서술문에서 끝내지 않고,
// 실제 원화 손실액까지 계산한다. 접근:
//  1. 문장에서 "언제부터 몇 %를 잃는지"를 계단식 구간(step)으로 뽑는다 — 예)
//     "체크인 13일 이내 50%, 체크인 8일 이내 100%"는 [{13일전, 50%}, {8일전, 100%}].
//     "무료취소 - 날짜" + 이후 위약금 %가 같이 적혀 있으면 그것도 같은 구조로 만든다.
//  2. 여기(cancellation.js)는 날짜·퍼센트를 "정확히 알 수 있을 때만" 구간을 만든다 —
//     퍼센트를 특정 못하면 그 구간은 아예 안 만든다(단정 금지 원칙, 오탐이 무탐보다 나쁨).
//  3. 실제 원화 계산(퍼센트 × 가격)은 가격을 아는 briefing.js가 한다 — 여기는 텍스트에서
//     날짜/퍼센트만 정확히 뽑아내는 역할까지만 한다.
//
// v2에서 넘어온 것들:
// - "예약 무료 취소 가능"과 마감일이 아이콘으로 갈라진 다른 DOM 텍스트 노드에 있어도
//   찾을 수 있게, 문자열 분할 대신 "가장 작은 블록의 innerText 전체"를 본다.
// - "노쇼(No-Show) 시 100% 부과"의 "노쇼"만 보고 전체를 "환불 불가"로 단정하지 않는다 —
//   노쇼(안 나타남)와 사전 취소는 다른 상황이라 별도 필드(noShowNote)로만 알려준다.
// - 근거가 약하면 "환불 불가"로 단정하지 않고 "확인 필요"로 내려간다.

(function () {
  function isOwn(node) {
    return node.closest && node.closest(".cc-ui");
  }

  const CANCEL_KEYWORD_RE = /취소|환불/;
  const MIN_BLOCK_LEN = 4;
  const MAX_BLOCK_LEN = 800; // 정책 모달 전문까지 담을 수 있게 넉넉히

  // 어떤 요금제는 "취소 정책" ℹ️ 라벨만 목록에 있고, 실제 날짜/조건은 그 라벨을 클릭해야
  // 열리는 팝업/모달에만 있어 DOM엔 아예 없다 — 없는 걸 계속 찾으려 하는 대신 "펼쳐야
  // 확인 가능"이라고 정직하게 표시한다.
  const GENERIC_LABEL_ONLY_RE = /^(취소\s*정책|환불\s*정책|취소\s*규정|취소\/환불\s*정책)$/;

  const FREE_SIGNAL_RE = /무료\s*취소|취소\s*(수수료|요금)(이|가)?\s*없습니다/;
  // 축1 규칙기반 평가(286건)에서 실측: nonrefundable 골드 31건이 전부 "환불하지
  // 않습니다"(능동태)/"취소 및 변경을 할 수 없습니다" 문구를 쓰는데, 원래 정규식은
  // "환불되지 않"/"환불받을 수 없"(수동태)만 잡아서 31건 전부 놓치고 있었다 — 능동태와
  // "할 수 없습니다"류를 추가한다.
  const NONFREE_STANDALONE_RE = /(환불|취소)\s*(이|가)?\s*불가|환불\s*(받을\s*수\s*없|되지\s*않|하지\s*않)|(취소|변경)\s*(을|를)?\s*할\s*수\s*없/;
  const NOSHOW_RE = /노쇼|No-?Show/i;
  // "노쇼일 경우 환불하지 않습니다"처럼 환불불가가 노쇼에만 조건부로 걸린 경우와,
  // "취소 및 변경을 할 수 없습니다"처럼 무조건 환불불가인 경우를 구분해야 한다(전자를
  // nonrefundable로 단정하면 안 됨 — 노쇼 안 하면 정상 환불될 수도 있으니까). 문서
  // 전체에 노쇼 단어가 있는지가 아니라, "그 환불불가 문구 바로 앞에 노쇼가 조건으로
  // 붙어있는지"만 좁게 확인한다.
  const NOSHOW_CONDITION_BEFORE_RE = /노쇼[^.]{0,20}$/i;

  const ABS_DEADLINE_RE = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*(오전|오후)\s*(\d{1,2}):(\d{2}))?/;
  const DAYS_BEFORE_DEADLINE_RE = /체크인\s*(?:날짜)?\s*(\d+)\s*일\s*전까지/;
  const MD_DEADLINE_RE = /(\d{1,2})월\s*(\d{1,2})일\s*(?:전|까지)/;

  const PENALTY_AFTER_RE = /(총\s*숙박\s*요금|예약\s*요금|숙박\s*요금)[^.\n]{0,10}(취소\s*요금으로\s*부과|위약금으로\s*부과|환불되지\s*않)/;
  const PENALTY_PERCENT_RE = /위약금[^.\n]{0,10}?(\d{1,3})\s*%|(\d{1,3})\s*%[^.\n]{0,10}(취소\s*요금|위약금)/;
  // "체크인 날짜 전 N일 이내 취소 시 [X%|전액] 부과"류 — 한 문서 안에 여러 구간이 있을 수
  // 있어(예: 13일 이내 50%, 8일 이내 100%) 전역 매치로 전부 뽑는다. "체크인 당일"(N일
  // 대신 숫자 없이 "당일")도 같은 구간 문법의 변형인데 원래 정규식이 숫자를 필수로 요구해서
  // 놓치고 있었다 — 축1 평가(286건)에서 tier 불일치 33건 전부가 이 케이스였다. group 1이
  // 비어있으면(당일 매치) daysBefore=0으로 아래 extractTierSteps에서 처리한다.
  const TIER_SEGMENT_RE = /체크인\s*(?:날짜)?\s*(?:전\s*(\d+)\s*일\s*이내|당일)[^.\n]{0,60}/g;

  // 검색창의 "2026년 9월 3일 → 2026년 9월 4일" 같은 체크인/체크아웃 날짜 표시를 한 번에
  // 찾는다(첫 매치=체크인, 두 번째 매치=체크아웃 — 사이트 관례). 카드마다 따로 다시
  // 스캔하면 느려지므로(실측: 요금제 15~20개 있는 페이지에서 체감될 정도), 스캔 한 번당
  // 딱 한 번만 호출해서 결과를 재사용하는 걸 전제로 한다 — 호출부(briefing.js)가 이미
  // 그렇게 쓰고 있다.
  function sameDate(a, b) {
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }

  function findStayDates(doc) {
    const candidates = doc.querySelectorAll("div, span, button, p");
    const dates = [];
    for (const node of candidates) {
      if (isOwn(node)) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > 30) continue;
      const m = text.match(ABS_DEADLINE_RE);
      if (!m) continue;
      const d = { year: +m[1], month: +m[2], day: +m[3] };
      // 체크인 날짜 텍스트가 부모/자식처럼 중첩된 요소 양쪽에 다 걸리는 경우가 실측에서
      // 확인됐다(예: 감싸는 div와 그 안의 span 둘 다 "2026년 9월 3일") — 그러면 같은
      // 날짜를 두 번 세서 "체크인=체크인, 체크아웃=체크인"이 되어 박수가 0으로 계산되고
      // (0박은 유효하지 않아) null로 떨어졌다. 마지막으로 찾은 것과 같은 날짜는 건너뛰고
      // "실제로 다른 날짜"만 체크인/체크아웃으로 취급한다.
      if (dates.length && sameDate(dates[dates.length - 1], d)) continue;
      dates.push(d);
      if (dates.length >= 2) break;
    }
    return { checkin: dates[0] ?? null, checkout: dates[1] ?? null };
  }

  function toDate(d) {
    return d ? new Date(d.year, d.month - 1, d.day) : null;
  }

  /** 체크인~체크아웃 사이 박수. 못 구하면 null(단정 안 함). */
  function computeNights(stayDates) {
    const ci = toDate(stayDates?.checkin);
    const co = toDate(stayDates?.checkout);
    if (!ci || !co) return null;
    const nights = Math.round((co - ci) / 86400000);
    return nights > 0 ? nights : null;
  }

  /** classifyBlock에 넘길 {checkin, nights} 묶음을 한 번에 계산한다(문서 스캔 1회). */
  function buildDateContext(doc) {
    // 사이트 어댑터(stayDates)가 URL 등에서 정확한 날짜를 주면 그것을 우선한다.
    let stayDates = null;
    try {
      stayDates = window.__ccSites?.current()?.stayDates?.(doc) ?? null;
    } catch (e) {}
    if (!stayDates?.checkin) stayDates = findStayDates(doc);
    return { checkin: stayDates.checkin, nights: computeNights(stayDates) };
  }

  function extractAbsDeadlineDate(text) {
    const abs = text.match(ABS_DEADLINE_RE);
    if (!abs) return null;
    return new Date(+abs[1], +abs[2] - 1, +abs[3]);
  }

  // "첫 1박 요금이 취소 요금으로 부과"류 — 전체 금액의 몇 %인지는 숙박 일수에 따라
  // 달라져(1박이면 전체와 같지만 여러 박이면 일부) 여기서 퍼센트로 단정하지 않는다.
  // 대신 usesFirstNight 표시만 해두고, 실제 원화 계산은 briefing.js가 카드에 적힌
  // "1박당 총 금액"을 직접 읽어서 한다(숙박 일수를 역산하는 것보다 안정적 — 사장님 제안).
  const FIRST_NIGHT_RE = /첫\s*1?\s*박\s*요금/;

  // 노쇼 페널티 — 기존엔 "노쇼 언급이 있다/없다"만 boolean으로 보고 문구는 항상 "요금
  // 전액"으로 고정해서 표시했다. 축1 평가(286건)에서 실제 노쇼 퍼센트가 100%가 아닌
  // 경우가 46건(12~91%로 다양)이나 확인돼서, "노쇼" 근처 문장에서 실제 퍼센트(또는
  // "첫 1박 요금")를 직접 읽어오도록 바꾼다.
  function extractNoShowPenalty(text) {
    const idx = text.search(NOSHOW_RE);
    if (idx === -1) return null;
    const window = text.slice(idx, idx + 120);
    const pctMatch = window.match(/(\d{1,3})\s*%/);
    if (pctMatch) return { percent: parseInt(pctMatch[1], 10), usesFirstNight: false };
    if (FIRST_NIGHT_RE.test(window)) return { percent: null, usesFirstNight: true };
    if (/전액|총\s*숙박\s*요금/.test(window)) return { percent: 100, usesFirstNight: false };
    return { percent: null, usesFirstNight: false }; // 노쇼 언급은 있으나 값을 특정 못함
  }

  function extractPenaltyPercent(text) {
    const pct = text.match(PENALTY_PERCENT_RE);
    if (pct) return parseInt(pct[1] || pct[2], 10);
    if (PENALTY_AFTER_RE.test(text)) return 100;
    return null;
  }

  /**
   * "체크인 N일 이내 X%"류를 전부 뽑아 [{thresholdDate, percent}, ...]로 반환(날짜 오름차순).
   * "첫 1박 요금"류는 percent 대신 usesFirstNight:true로 표시한다.
   */
  function extractTierSteps(text, checkinDate) {
    if (!checkinDate) return [];
    const checkin = new Date(checkinDate.year, checkinDate.month - 1, checkinDate.day);
    const steps = [];
    for (const m of text.matchAll(TIER_SEGMENT_RE)) {
      // m[1]은 "전 N일 이내"일 때만 잡힌다 — "당일" 매치는 그룹이 비어있으므로 0일 전으로 취급.
      const daysBefore = m[1] ? parseInt(m[1], 10) : 0;
      const segment = m[0];
      const pctMatch = segment.match(/(\d{1,3})\s*%/);
      let percent = null;
      let usesFirstNight = false;
      if (pctMatch) percent = parseInt(pctMatch[1], 10);
      else if (/총\s*숙박\s*요금|전액/.test(segment)) percent = 100;
      else if (FIRST_NIGHT_RE.test(segment)) usesFirstNight = true;
      if (percent == null && !usesFirstNight) continue; // 특정 못하면 이 구간은 만들지 않는다
      const thresholdDate = new Date(checkin);
      thresholdDate.setDate(thresholdDate.getDate() - daysBefore);
      steps.push({ thresholdDate, percent, usesFirstNight });
    }
    return steps;
  }

  // "예약 취소 시 예약 요금의 13%가 취소 요금으로 부과됩니다" — 날짜 조건 없이 예약한 순간부터
  // 적용되는 위약금(실측 2026-09-24, 아고다 취소 정책 모달). 뒤에 "체크인 날짜 전 4일 이내 …
  // 총 숙박 요금" 같은 상위 구간이 이어질 수 있어, 이 13%는 "오늘부터" 시작하는 첫 구간이다.
  // "체크인 …"으로 시작하는 구간 문장과 섞이지 않게 "예약 취소 시 예약 요금의 N%"로 좁게 잡는다.
  // "N일 이내 예약 취소 시 예약 요금의 X%"처럼 조건이 앞에 붙은 구간 문장은 제외한다.
  const IMMEDIATE_PENALTY_RE =
    /(?<!이내\s)(?<!이내에\s)예약\s*취소\s*시\s*예약\s*요금의\s*(\d{1,3})\s*%[^.\n]{0,10}취소\s*요금으로\s*부과/;
  function extractImmediatePenaltyStep(text) {
    const m = text.match(IMMEDIATE_PENALTY_RE);
    if (!m) return null;
    const percent = parseInt(m[1], 10);
    if (!(percent > 0 && percent <= 100)) return null;
    const start = new Date();
    start.setHours(0, 0, 0, 0); // 오늘 0시 — 항상 "이미 지난 구간"이 된다
    return { thresholdDate: start, percent, usesFirstNight: false, immediate: true };
  }

  // "체크인 날짜까지 7일 넘게 남아 있는 경우 -- 수수료 0%, 체크인 날짜 4~7일 전 -- 수수료 20%,
  // 체크인 날짜 2~3일 전 -- 수수료 50%, 체크인 날짜 1일 전 -- 수수료 80%, 체크인 당일 -- 수수료 100%"
  // (실측 2026-09-24, 아고다 취소 정책 모달). 구간 "A~B일 전"은 남은 기간이 B일 이하가 되는
  // 순간(체크인 B일 전)부터 시작한다 — "B일 넘게 남았으면 0%"라는 문장이 그 경계를 정해준다.
  // 하이픈은 사이트/폰트에 따라 -, –, — 로 다르게 오므로 모두 받는다.
  const DASH = "[-–—]{1,2}";
  const RANGE_TIER_RE = new RegExp(
    `체크인\\s*(?:날짜)?\\s*(?:(\\d+)\\s*[~～]\\s*)?(\\d+)\\s*일\\s*전\\s*${DASH}\\s*수수료\\s*(\\d{1,3})\\s*%|체크인\\s*당일\\s*${DASH}\\s*수수료\\s*(\\d{1,3})\\s*%`,
    "g"
  );
  const ZERO_FEE_RE = new RegExp(`(\\d+)\\s*일\\s*넘게\\s*남아\\s*있는\\s*경우\\s*${DASH}\\s*수수료\\s*0\\s*%`);
  function extractRangeTierSteps(text, checkinDate) {
    if (!checkinDate) return [];
    const checkin = new Date(checkinDate.year, checkinDate.month - 1, checkinDate.day);
    const steps = [];
    for (const m of text.matchAll(RANGE_TIER_RE)) {
      const daysBefore = m[2] ? parseInt(m[2], 10) : 0; // m[4] 쪽이면 "체크인 당일"
      const percent = parseInt(m[2] ? m[3] : m[4], 10);
      if (!(percent > 0)) continue; // 0%는 위약금 구간이 아니다
      const thresholdDate = new Date(checkin);
      thresholdDate.setDate(thresholdDate.getDate() - daysBefore);
      steps.push({ thresholdDate, percent, usesFirstNight: false });
    }
    return steps;
  }

  function findCancellationBlocks(root) {
    const candidates = root.querySelectorAll("div, span, li, p, td, dd, section, article");
    const blocks = [];
    for (const node of candidates) {
      if (isOwn(node)) continue;
      // 자기 자신이 .cc-ui가 아니어도 자식으로 우리 배지를 품고 있을 수 있다 —
      // 그 문구("환불 불가 요금제로 보임" 등)를 아고다 텍스트로 오인하면 우리 판정이
      // 우리 출력을 다시 읽는 순환이 된다. pricing.js의 헬퍼로 잘라낸다.
      const text = (window.__ccPricing?.textExcludingOwnUI?.(node) ?? (node.innerText || "")).trim();
      if (text.length < MIN_BLOCK_LEN || text.length > MAX_BLOCK_LEN) continue;
      if (!CANCEL_KEYWORD_RE.test(text)) continue;
      blocks.push({ node, text });
    }
    return blocks;
  }

  function formatDeadline(text) {
    const abs = text.match(ABS_DEADLINE_RE);
    if (abs) {
      const time = abs[4] ? ` ${abs[4]} ${abs[5]}:${abs[6]}` : "";
      return `${abs[1]}년 ${abs[2]}월 ${abs[3]}일${time}`;
    }
    const daysBefore = text.match(DAYS_BEFORE_DEADLINE_RE);
    if (daysBefore) return `체크인 ${daysBefore[1]}일 전`;
    const md = text.match(MD_DEADLINE_RE);
    if (md) return `${md[1]}월 ${md[2]}일`;
    return null;
  }

  function extractPenaltyNote(text) {
    if (FIRST_NIGHT_RE.test(text)) return "그 이후엔 첫 1박 요금이 취소 수수료로 부과될 수 있어요.";
    const percent = extractPenaltyPercent(text);
    if (percent == null) return null;
    return percent >= 100
      ? "그 이후엔 숙박 요금 전액이 취소 수수료로 부과될 수 있어요."
      : `그 이후엔 위약금 약 ${percent}%가 발생할 수 있어요.`;
  }

  // dateContext: { checkin: {year,month,day}|null } — 스캔 한 번당 한 번만 계산해서
  // (findStayDates) 여기로 넘긴다. 카드마다 다시 스캔하면 느려진다.
  function classifyBlock(text, dateContext) {
    const checkinDate = dateContext?.checkin ?? null;
    const rangeSteps = extractRangeTierSteps(text, checkinDate);
    let deadline = formatDeadline(text);
    // "N일 넘게 남았으면 수수료 0%" — 문구에 "무료취소"는 없어도 사실상 무료취소 구간이다.
    // 무료인 마지막 시점은 "N+1일 전"(N일 전부터 위약금 시작).
    const zeroFee = text.match(ZERO_FEE_RE);
    const freeByTier = !!zeroFee && !deadline;
    if (freeByTier) deadline = `체크인 ${parseInt(zeroFee[1], 10) + 1}일 전`;
    const hasFreeSignal = FREE_SIGNAL_RE.test(text);
    const hasNoShow = NOSHOW_RE.test(text);
    const nonfreeMatch = NONFREE_STANDALONE_RE.exec(text);
    const hasNonfree = !!nonfreeMatch;
    // 문서 전체에 노쇼 단어가 있는지가 아니라, 그 환불불가 문구 바로 앞(20자 이내)에
    // "노쇼"가 조건으로 붙어있는지만 본다 — "취소 및 변경을 할 수 없습니다. 노쇼일 경우
    // 환불하지 않습니다."처럼 무조건 환불불가 문장 뒤에 노쇼 문장이 별도로 따라오는
    // 경우(축1 평가 31건 전부 이 패턴)까지 억울하게 막지 않기 위함.
    const nonfreeIsNoShowScoped =
      hasNonfree && NOSHOW_CONDITION_BEFORE_RE.test(text.slice(Math.max(0, nonfreeMatch.index - 20), nonfreeMatch.index));
    const penaltyNote =
      extractPenaltyNote(text) ??
      (rangeSteps.length ? `그 이후엔 위약금 ${Math.min(...rangeSteps.map((s) => s.percent))}%부터 시작해 단계적으로 올라가요.` : null);
    const noShowPenalty = hasNoShow ? extractNoShowPenalty(text) : null;
    const noShowNote = noShowPenalty
      ? noShowPenalty.usesFirstNight
        ? "예약하고 나타나지 않으면(노쇼) 첫 1박 요금이 부과될 수 있어요."
        : noShowPenalty.percent != null
        ? `예약하고 나타나지 않으면(노쇼) 예약 요금의 약 ${noShowPenalty.percent}%가 부과될 수 있어요.`
        : "예약하고 나타나지 않으면(노쇼) 요금이 부과될 수 있어요."
      : null;

    // "언제부터 몇 %를(또는 첫 1박 요금을) 잃는지" 계단식 구간. 다단계(체크인 N일 이내
    // X%)가 있으면 그것을, 없고 무료취소 마감일 + 퍼센트를 알 수 있으면 그 한 구간을
    // 쓴다. 둘 다 없으면 빈 배열 — briefing.js는 이 경우 "정확한 금액은 원문에서 확인"
    // 정도로만 표시한다.
    let lossSteps = rangeSteps.length ? rangeSteps : extractTierSteps(text, checkinDate);
    if (!lossSteps.length) {
      const deadlineDate = extractAbsDeadlineDate(text);
      const percent = extractPenaltyPercent(text);
      // 퍼센트를 모르더라도(percent=null) 마감일 자체는 확실히 알고 있으면 구간을 만든다
      // — 정확한 손실 "금액"은 몰라도 "오늘이 마감일을 지났는지"는 판단할 수 있어야
      // 초록불(마감 전)에서 주황불(마감 지남)로 정확히 넘어간다. 금액이 필요한 곳에서는
      // resolveStepAmount가 percent=null이면 이미 null을 반환해 단정하지 않는다.
      if (hasFreeSignal && deadlineDate) {
        lossSteps = [{ thresholdDate: deadlineDate, percent, usesFirstNight: false }];
      } else if (hasNonfree && !nonfreeIsNoShowScoped && checkinDate) {
        // 환불 불가(nonrefundable) 확정 케이스는 "언제부터 몇 %"가 아니라 처음부터 항상
        // 100%라 별도 단계 구조가 없다 — 체크인 날짜를 앵커로 100% 단일 구간을 만든다.
        lossSteps = [{ thresholdDate: toDate(checkinDate), percent: 100, usesFirstNight: false }];
      }
    }
    const immediateStep = extractImmediatePenaltyStep(text);
    if (immediateStep) lossSteps = [immediateStep, ...lossSteps];
    lossSteps.sort((a, b) => a.thresholdDate - b.thresholdDate);

    let status;
    if ((hasFreeSignal && deadline) || freeByTier) {
      status = "free"; // 마감일이 명시된 무료취소 — 가장 신뢰도 높은 케이스, 항상 우선
    } else if (hasNonfree && !nonfreeIsNoShowScoped) {
      status = "nonrefundable"; // 노쇼에만 조건부로 걸린 게 아닌 "환불 불가"는 인정
    } else if (GENERIC_LABEL_ONLY_RE.test(text.trim())) {
      status = "collapsed"; // 라벨만 있고 실제 조건은 클릭해야 열림 — 없는 정보를 단정하지 않음
    } else if (CANCEL_KEYWORD_RE.test(text)) {
      status = "unclear";
    } else {
      status = "none";
    }
    // "모든 수수료는 세금 및 봉사료를 제외한 금액으로 계산되었습니다"(아고다 단계식 문구, 실측
    // 2026-09-24) — 위약금 퍼센트가 세금 제외 금액에 걸린다는 뜻이다. 우리는 화면의 세금 포함
    // 총액에 퍼센트를 곱하므로 실제 위약금보다 크게 나올 수 있다. 세금 제외 기준 금액을 우리가
    // 따로 계산하지는 않고(어떤 금액이 기준인지 검증할 수 없다 — 팀 결정), 카드에 안내만 붙인다.
    const feeExcludesTax = /(?:세금|봉사료)[^.\n]{0,12}제외/.test(text);
    return { status, deadline, penaltyNote, lossSteps, noShowNote, noShowPenalty, feeExcludesTax, raw: text };
  }

  // 사이트 어댑터(cancellation.parse)가 자기 사이트 문구를 직접 해석한다. 모르는 문구는 null 을
  // 돌려주고, 그러면 공용 분류기로 넘어간다. 예외도 공용 분류기로 넘긴다.
  function classify(text, ctx) {
    let r = null;
    try {
      r = window.__ccSites?.current()?.cancellation?.parse?.(text, ctx) ?? null;
    } catch (e) {}
    return r ?? classifyBlock(text, ctx);
  }

  const EMPTY_SUMMARY = { status: "none", deadline: null, penaltyNote: null, lossSteps: [], noShowNote: null, noShowPenalty: null, raw: null, node: null };

  /**
   * 취소 관련 블록을 찾아 가장 신뢰도 높은 판정 하나로 요약한다. scopeRoot(포커스 카드)를
   * 넘기면 그 안에서만 찾는다 — 안에 아무것도 없으면 다른 요금제 정보를 끌어오지 않고
   * "정보 없음(확인 중)"으로 정직하게 유지한다. scopeRoot를 생략하면 문서 전체에서 찾는다
   * (요금제가 하나뿐인 결제페이지는 이걸로 충분히 잘 동작했다).
   */
  function buildCancellationSummary(doc, scopeRoot, dateContext) {
    const root = scopeRoot ?? doc;
    const ctx = dateContext ?? buildDateContext(doc);
    // node를 같이 들고 다닌다 — status가 "collapsed"(펼쳐야 확인 가능)일 때 briefing.js가
    // 이 노드를 직접 클릭해서 자동으로 펼쳐볼 수 있어야 한다(실측 결론: 이 사이트는 클릭
    // 전엔 정책 원문이 네트워크에도 DOM에도 전혀 없어서, 자동 계산의 유일한 방법은 클릭
    // 시뮬레이션뿐이었다).
    const blocks = findCancellationBlocks(root).map((b) => ({ ...classify(b.text, ctx), node: b.node }));
    if (!blocks.length) return { ...EMPTY_SUMMARY };

    // 짧은 것 우선(원래 정렬)은 "여러 요금제를 담은 거대한 조상 블록"을 피하려는 방어였는데,
    // 부작용으로 같은 카드 안의 요약 줄이 전문을 항상 이겨 다단계 구간이 유실됐다.
    // 정보량을 1차, 길이를 2차 기준으로 둔다 — 정보량이 같을 때만 짧은 걸 고르므로
    // 조상 블록 방어는 그대로 유지된다.
    const FULL_POLICY_RE = /취소\s*요금|노쇼|No-?Show/i;
    const richness = (b) =>
      (b.lossSteps?.length ? 4 : 0) +
      (FULL_POLICY_RE.test(b.raw || "") ? 2 : 0) +
      (b.noShowNote ? 1 : 0);
    const byRichnessThenShort = (a, b) => richness(b) - richness(a) || a.raw.length - b.raw.length;

    const definitive = blocks
      .filter((b) => b.status === "free" || b.status === "nonrefundable")
      .sort(byRichnessThenShort);

    let best;
    if (definitive.length) {
      best = definitive[0];
    } else {
      // unclear는 실제 문장(원문 인용 가능)이 있는 상태고, collapsed는 "취소 정책" 같은
      // 빈 라벨뿐이라 보여줄 내용 자체가 없다 — 실제 내용이 있는 unclear를 우선한다.
      const unclear = blocks.filter((b) => b.status === "unclear").sort(byRichnessThenShort);
      const collapsed = blocks.filter((b) => b.status === "collapsed");
      best = unclear[0] ?? collapsed[0] ?? { ...EMPTY_SUMMARY };
    }

    if (!best.penaltyNote) {
      const withPenalty = blocks.find((b) => b.penaltyNote);
      if (withPenalty) best = { ...best, penaltyNote: withPenalty.penaltyNote };
    }
    if (!best.lossSteps.length) {
      const withSteps = blocks.find((b) => b.lossSteps.length);
      if (withSteps) best = { ...best, lossSteps: withSteps.lossSteps };
    }
    if (!best.noShowNote) {
      const withNoShow = blocks.find((b) => b.noShowNote);
      if (withNoShow) best = { ...best, noShowNote: withNoShow.noShowNote, noShowPenalty: withNoShow.noShowPenalty };
    }
    return best;
  }

  // "펼쳐야 확인 가능"(collapsed) 카드에서 실제로 "취소 정책"을 클릭하면, 대부분의 사이트는
  // 그 팝업/모달을 카드가 속한 DOM 트리 안이 아니라 body 최상단에 별도로 렌더링한다(React
  // 포털의 흔한 패턴) — 아무리 조상으로 올라가도 닿지 않는 위치라 카드 스코프 검색으로는
  // 원리적으로 못 찾는다. role="dialog"/aria-modal="true"로 명시적으로 표시된 요소만
  // 문서 전체에서 별도로 찾는다.
  function findModalCancellationBlock(doc, dateContext) {
    const ctx = dateContext ?? buildDateContext(doc);
    // 사이트 어댑터가 자기 모달(role="dialog" 표기가 없는 것 포함)을 알려주면 그것부터 읽는다.
    const siteModal = window.__ccSites?.cancellationModal(doc);
    if (siteModal && !isOwn(siteModal)) {
      let text = "";
      try {
        text = window.__ccSites.current().cancellation.modalText?.(siteModal) ?? siteModal.innerText ?? "";
      } catch (e) {}
      text = text.trim();
      if (text && text.length <= MAX_BLOCK_LEN * 4 && CANCEL_KEYWORD_RE.test(text)) {
        return classify(text, ctx);
      }
    }
    // 어댑터가 modal 훅 자체는 선언했는데 이번 호출에서 아직 못 찾았다면(예: 모달이 뜨는
    // 애니메이션 도중이라 사이트가 요구하는 최소 크기에 아직 못 미침) "아직 준비 안 됨"으로
    // 보고 여기서 포기한다 — 아무 role=dialog나 대신 읽지 않는다.
    // 실측(Booking.com, 2026-09): 모달 등장 애니메이션 초반 폴링에서 사이트 모달이 크기
    // 문턱 미달로 안 잡히자, 바로 아래 공용 휴리스틱이 그 순간 우연히 조건에 걸리는 다른
    // role=dialog(또는 아직 다 안 그려진 같은 모달)를 대신 읽어서 부정확한 결과(정확한
    // "첫 1박 요금" 대신 퍼센트 미상)가 캐시에 영구 저장됐다 — 자동 재시도가 없어 한 번
    // 잘못 읽으면 계속 그 값으로 남는다. 훅이 있는 사이트는 폴링(readWhenReady)이 계속
    // 돌면서 사이트 모달이 실제로 준비될 때까지 기다리게 한다.
    if (window.__ccSites?.current()?.cancellation?.modal) return null;
    const modals = doc.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    for (const modal of modals) {
      if (isOwn(modal)) continue;
      const text = (modal.innerText || "").trim();
      if (!text || text.length > MAX_BLOCK_LEN * 4 || !CANCEL_KEYWORD_RE.test(text)) continue;
      return classifyBlock(text, ctx);
    }
    return null;
  }

  function describeCancellation(summary) {
    if (summary.status === "free") {
      const detailParts = [summary.penaltyNote ?? "그 이후엔 취소 수수료가 발생할 수 있어요.", summary.noShowNote].filter(Boolean);
      return {
        light: "green",
        headline: summary.deadline ? `${summary.deadline}까지 무료취소 가능` : "무료취소 가능",
        detail: detailParts.join(" "),
        raw: summary.raw,
      };
    }
    if (summary.status === "nonrefundable") {
      return {
        light: "red",
        headline: "환불 불가 요금제",
        detail: "지금 취소해도 환불받지 못하는 요금제로 보여요.",
        raw: summary.raw,
      };
    }
    if (summary.status === "collapsed") {
      return {
        light: "yellow",
        headline: "펼쳐야 확인 가능",
        detail: "이 목록에는 취소 조건이 아직 안 보여요 — 카드의 '취소 정책'을 클릭해서 직접 확인하세요.",
        raw: summary.raw,
      };
    }
    if (summary.status === "unclear") {
      if (summary.lossSteps.length) {
        // truncation 없이 정확한 시각으로 비교한다 — briefing.js의 computeStepProjection
        // 주석 참고(아고다는 thresholdDate가 항상 자정이라 무해하고, 시각 포함 마감을
        // 정확히 비교하려는 목적).
        const today = new Date();
        const past = summary.lossSteps.some((s) => today >= s.thresholdDate);
        return {
          light: past ? "red" : "yellow",
          headline: past ? "위약금 구간에 들어섰어요" : "아직 위약금 구간 전이에요",
          detail: "결제 전 정확한 손실액은 브리핑카드의 손실액 계산을 확인하세요.",
          raw: summary.raw,
        };
      }
      return {
        light: "yellow",
        headline: "취소 조건 확인 필요",
        detail: "취소 관련 문구는 있지만 마감일을 정확히 읽어내지 못했어요. 원문을 직접 확인하세요.",
        raw: summary.raw,
      };
    }
    return { light: "gray", headline: "정보 확인 중", detail: "이 요금제의 취소 조건을 아직 찾지 못했어요 — 근거 없이 단정하지 않습니다.", raw: null };
  }

  window.__ccCancellation = { buildCancellationSummary, describeCancellation, findModalCancellationBlock, buildDateContext, classifyBlock, EMPTY_SUMMARY };
  // classifyBlock은 DOM 없이 텍스트+dateContext만으로 동작하는 순수 함수라, 축1(약관)
  // 규칙기반 평가 스크립트가 Node에서 직접 이 파일을 불러 재사용할 수 있게 export한다
  // (브라우저에서는 window가 있으니 무해하게 무시됨).
  if (typeof module !== "undefined") module.exports = { classifyBlock };
})();
