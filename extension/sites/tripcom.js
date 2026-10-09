// Trip.com 어댑터. 계약은 ../sites.js 헤더 참고.
//
// 근거: 2026-09-22 실측 조사(윤서). 아래 "실측"은 그 조사에서 확인된 것이고 "미확인"은 아직
// 샘플이 없어 추정으로 둔 부분이다 — 샘플을 받으면 바로 고칠 것.
//
// 범위: 가격 + 취소 + 리뷰(규칙 판정). 리뷰 모델 서버(Cloud Run)는 CORS 가 아고다 origin 만
// 허용해서 Trip.com 에서는 호출이 막히고, 그러면 규칙 판정만으로 동작한다(서버 설정 변경 필요).
// 아직 없는 것:
//   · provisionalPrice — 요금표 로딩 전 임시 시작가. 해당 문구 미확인
//   · 취소 불가·수수료 요금 "행"에 보이는 문구 — 무료취소 행("무료 취소 9월 23일 23:59 전")만 실측

(function () {
  const DETAIL_PATH_RE = /\/hotels\/detail/;
  const isDetail = () => DETAIL_PATH_RE.test(location.pathname);

  // ── 페이지 판정 ────────────────────────────────────────────────────────────
  // 실측: 목록 /hotels/list, 상세 /hotels/detail. 브리핑 카드는 상세페이지에서만 띄운다 —
  // 그 밖의 페이지(홈·항공 등)는 계약상 "목록"과 같이 취급해 카드를 숨긴다.
  const isListingPage = () => !isDetail();

  // 실측: 상세 URL 쿼리의 hotelId. 숫자가 아니면 신뢰하지 않는다.
  function hotelId() {
    if (!isDetail()) return null;
    const id = new URLSearchParams(location.search).get("hotelId");
    return id && /^\d+$/.test(id) ? id : null;
  }

  // ── 숙박 날짜 ──────────────────────────────────────────────────────────────
  // 실측: 검색바는 "10월 5일(월)" 처럼 연도가 없어 공용 파서가 못 읽는다. 상세 URL 의
  // checkIn=2026-10-05 / checkOut=2026-10-06 이 정확하므로 그것을 쓴다.
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
  }
  function stayDates() {
    const q = new URLSearchParams(location.search);
    const checkin = parseYmd(q.get("checkIn"));
    return checkin ? { checkin, checkout: parseYmd(q.get("checkOut")) } : null;
  }
  function nightsFromUrl() {
    const s = stayDates();
    if (!s?.checkin || !s?.checkout) return null;
    const n = Math.round(
      (new Date(s.checkout.year, s.checkout.month - 1, s.checkout.day) -
        new Date(s.checkin.year, s.checkin.month - 1, s.checkin.day)) / 86400000
    );
    return n > 0 ? n : null;
  }

  // ── 가격 ───────────────────────────────────────────────────────────────────
  // 실측: 행의 큰 "현재 가격"(aria-label="현재 가격 …")은 **1박 기준**이고 "1박당" 같은 문구가
  // 없다. 2박 이상이면 행 하단에 "총금액: 961,935원 / 객실 1개 x 2박(세금&서비스비용 포함)"이
  // 따로 나온다(온천세 같은 현장 결제분까지 합친 값). 그래서 우선순위는:
  //   ① "총금액: N원"이 있으면 그것
  //   ② 없고 1박이면 현재 가격 그대로(세금 포함 문구가 있을 때만)
  //   ③ 없고 2박 이상이면 현재 가격 × 박수 (박수는 URL 기준, 근사값)
  //   박수를 모르면 단정하지 않고 null
  // "1박당" 문구로 박수 보정 여부를 판단하는 공용 로직(correctForPerNightPrice)은 이 사이트에서
  // 동작하지 않으므로, ③은 여기서 직접 곱해서 돌려준다.
  const TOTAL_RE = /총\s*금액\s*:?\s*([\d,]{4,})\s*원/;
  const TAX_INCLUDED_RE = /세금\s*[&및]\s*서비스\s*비용\s*포함/;

  function smallestMatch(scope, re) {
    let best = null;
    let bestLen = Infinity;
    for (const el of scope.querySelectorAll("div, span, p")) {
      const t = el.innerText || "";
      if (t.length >= bestLen || !re.test(t)) continue;
      best = el;
      bestLen = t.length;
    }
    return best;
  }

  function finalPrice(scope) {
    const totalNode = smallestMatch(scope, TOTAL_RE);
    if (totalNode) {
      const amount = parseInt(TOTAL_RE.exec(totalNode.innerText)[1].replace(/,/g, ""), 10);
      if (amount >= 1000) return { node: totalNode, amount };
    }

    const cur = scope.querySelector('[aria-label^="현재 가격"]');
    if (!cur) return null;
    const digits = ((cur.getAttribute("aria-label") || "") + " " + (cur.innerText || "")).match(/[\d,]{4,}/);
    const perNight = digits ? parseInt(digits[0].replace(/,/g, ""), 10) : NaN;
    if (!(perNight >= 1000)) return null;

    // 세금 포함 문구를 가격 요소와 함께 담는 가장 작은 블록. 없으면 총액이라고 단정하지 않는다.
    let node = null;
    for (let n = cur; n && scope.contains(n); n = n.parentElement) {
      if (TAX_INCLUDED_RE.test(n.innerText || "")) { node = n; break; }
    }
    if (!node) return null;

    const nights = nightsFromUrl();
    if (nights === 1) return { node, amount: perNight };
    if (nights > 1) return { node, amount: perNight * nights, perNightAmount: perNight, nights };
    return null;
  }

  // ── 취소 정책 ──────────────────────────────────────────────────────────────
  // 실측: 요금 행 안의 aria-label="추가 정보" 물음표 버튼이 취소 정책 모달을 연다.
  // 한 행에 물음표가 여러 개일 수 있어(미확인) 취소 문구에서 가장 가까운 것을 고른다:
  // 문구를 품은 가장 작은 조상 안에서, 문구 뒤에 오는 첫 버튼(없으면 마지막 버튼).
  // 행 안에서 못 찾으면 null — 다른 행의 버튼을 누르는 것보다 포기하는 편이 낫다.
  const TRIGGER_SEL = '[aria-label="추가 정보"]';
  const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
  function revealTrigger(scope, node) {
    if (!scope) return null;
    for (let cur = node; cur && scope.contains(cur); cur = cur.parentElement) {
      const hits = [...(cur.querySelectorAll?.(TRIGGER_SEL) ?? [])];
      if (!hits.length) continue;
      return hits.find((h) => node.compareDocumentPosition(h) & FOLLOWING) ?? hits[hits.length - 1];
    }
    return scope.querySelector(TRIGGER_SEL);
  }

  // 실측: 모달 클래스 .reservationNotesPopModal-specialMeal (role="dialog" 표기는 미확인).
  // 닫은 뒤에도 DOM 에 남을 수 있어 보이는 것만 고른다(sites.js 가 한 번 더 검사한다).
  function modal(doc) {
    const all = [...doc.querySelectorAll(".reservationNotesPopModal-specialMeal")];
    return all.find((el) => el.getBoundingClientRect().width > 0) ?? null;
  }

  // 실측: 모달 안 .reservationNotesInfoLayer-item-b 중 제목이 "취소"인 섹션의
  // .reservationNotesInfoLayer-item-content 에 전체 정책 원문이 있다. 제목 요소의 클래스는
  // 몰라서, 섹션 텍스트에서 본문 텍스트를 뺀 나머지를 제목으로 본다. "취소" 섹션이 없으면
  // 조식 등 다른 정책을 취소로 읽지 않도록 빈 문자열을 돌려준다.
  const ITEM_SEL = ".reservationNotesInfoLayer-item-b";
  const CONTENT_SEL = ".reservationNotesInfoLayer-item-content";
  function modalText(el) {
    for (const item of el.querySelectorAll(ITEM_SEL)) {
      const content = item.querySelector(CONTENT_SEL);
      if (!content) continue;
      const body = (content.innerText || "").trim();
      const title = (item.innerText || "").replace(content.innerText || "", "").trim();
      if (title === "취소") return body;
    }
    return "";
  }

  // 실측(2026-09-22): 이 모달의 닫기(X) 버튼은 공용 코드가 찾는 세 패턴
  // ([aria-label*="닫기"|"Close"] / button[class*="close"]) 중 어느 것과도 안 맞았다.
  // 대신 Escape 키를 누르면 닫히는 것을 직접 확인했다(아고다는 반대로 Escape가 안
  // 먹혀서 전역 Escape를 걷어냈었다 — 사이트마다 다르므로 이 어댑터에서만 쓴다).
  function closeModal() {
    const opts = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true };
    document.dispatchEvent(new KeyboardEvent("keydown", opts));
    document.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // 실측한 원문 4종(문구가 다르면 null → 공용 분류기로 넘어간다):
  //  A. "Y년 M월 D일 HH:MM 이전에 취소하실 경우, 요금을 전액 환불해 드립니다." + "… 이후에 …, 환불이 불가합니다."
  //  B. "취소 수수료: 해당 예약 취소 시, 수수료 170,491원 부과."   (처음부터 수수료)
  //  C. A 사이에 "… 이전에 취소하실 경우, 194,654원의 취소 수수료가 부과됩니다." 구간이 끼는 다단계
  //  D. A와 비슷하지만 마감 이후가 "환불 불가"가 아니라 고정 금액
  //     "… 이후에 취소하실 경우, 359,260원의 취소 수수료가 부과됩니다."(실측: 부산 신라스테이,
  //     당일 마감 케이스). "이전에…N원"(C)과 정반대로 "이후에…N원"이라 별도 정규식이 필요했다 —
  //     처음엔 이 패턴을 못 잡아 마지막 구간이 계속 "?"로 남았다.
  //  공통 꼬리: "체크인하지 않으실 경우, 취소 수수료가 청구됩니다." / "표시된 시간은 모두 호텔 현지 시간 기준입니다."
  //  행: "무료 취소 9월 23일 23:59 전"  (연도 없음, 첫 무료취소 마감만 표시)
  const DT = String.raw`(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2}):(\d{2})`;
  const FULL_REFUND_RE = new RegExp(DT + String.raw`\s*이전에\s*취소하실\s*경우,?\s*요금을\s*전액\s*환불`);
  const FEE_TIER_RE = new RegExp(DT + String.raw`\s*이전에\s*취소하실\s*경우,?\s*([\d,]+)\s*원의\s*취소\s*수수료`, "g");
  const NO_REFUND_AFTER_RE = new RegExp(DT + String.raw`\s*이후에\s*취소하실\s*경우,?\s*환불이\s*불가`);
  const FEE_AFTER_RE = new RegExp(DT + String.raw`\s*이후에\s*취소하실\s*경우,?\s*([\d,]+)\s*원의\s*취소\s*수수료`);
  const FEE_NOW_RE = /취소\s*수수료\s*:\s*해당\s*예약\s*취소\s*시,?\s*수수료\s*([\d,]+)\s*원\s*부과/;
  const ROW_FEE_RE = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2}):(\d{2})\s*전\s*취소\s*시\s*([\d,]+)\s*원의\s*수수료가?\s*부과/;
  const ROW_FREE_RE =/무료\s*취소\s*(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2}):(\d{2})\s*전/;
  const NOSHOW_RE = /체크인\s*하지\s*않으실\s*경우/;
  const LOCAL_TIME_RE = /호텔\s*현지\s*시간/;

  const won = (s) => parseInt(String(s).replace(/,/g, ""), 10);
  const pad = (s) => String(s).padStart(2, "0");
  // 마감 문구의 시:분까지 그대로 담는다 — 실측(2026-09-22): 예전엔 이 순간을 자정으로
  // 깎아서 썼는데(원래는 하루 단위로만 비교하는 공용 코드에 맞추려던 것), 마감일 당일
  // 오후 3시(마감 18시 전)인데도 "오늘 이미 위약금"으로 잘못 표시됐다. 공용 비교 로직
  // (briefing.js computeStepProjection)이 이제 정확한 시각으로 비교하도록 바뀌어서, 여기서
  // 더 이상 날짜로 깎을 필요가 없다 — 이 순간 자체가 곧 무료→유료 전환 경계다.
  const stamp = (m) => new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const label = (m) => `${m[1]}년 ${+m[2]}월 ${+m[3]}일 ${pad(m[4])}:${m[5]}`;

  const NOSHOW_NOTE = "예약하고 나타나지 않으면(노쇼) 요금이 부과될 수 있어요.";
  const withLocalTime = (note, text) => (LOCAL_TIME_RE.test(text) ? `${note} (표시 시각은 호텔 현지시간 기준)` : note);

  function inferYear(mo, d, ctx) {
    if (ctx?.checkin) {
      const ci = new Date(ctx.checkin.year, ctx.checkin.month - 1, ctx.checkin.day);
      const t = new Date(ci.getFullYear(), mo - 1, d);
      return t - ci > 86400000 ? ci.getFullYear() - 1 : ci.getFullYear();
    }
    const now = new Date();
    const t = new Date(now.getFullYear(), mo - 1, d);
    return now - t > 180 * 86400000 ? now.getFullYear() + 1 : now.getFullYear();
  }

  function parse(text, ctx) {
    const noShow = NOSHOW_RE.test(text);
    const common = {
      noShowNote: noShow ? NOSHOW_NOTE : null,
      noShowPenalty: noShow ? { percent: null, usesFirstNight: false } : null,
      raw: text,
    };

    // A·C: 무료취소 마감 + (수수료 구간) + 이후 환불불가
    const full = FULL_REFUND_RE.exec(text);
    if (full) {
      const tiers = [...text.matchAll(FEE_TIER_RE)]
        .map((m) => ({ t: stamp(m), amount: won(m[6]) }))
        .sort((a, b) => a.t - b.t);
      const after = NO_REFUND_AFTER_RE.exec(text);
      // "이후에 …, N원의 취소 수수료" — NO_REFUND_AFTER_RE(환불 불가)와 어순이 같아서 오매칭될
      // 걱정은 없다(전자는 "환불이 불가", 후자는 "N원의 취소 수수료"로 어미가 다르다).
      const feeAfter = !after ? FEE_AFTER_RE.exec(text) : null;
      let boundary = stamp(full);
      const lossSteps = [];
      for (const tier of tiers) {
        lossSteps.push({ thresholdDate: boundary, amount: tier.amount, percent: null, usesFirstNight: false });
        boundary = tier.t;
      }
      // 마지막 구간: 환불불가면 전액(100%), 고정 금액이 적혀 있으면 그 금액, 둘 다 없으면
      // 값을 특정하지 못한다(단정 금지).
      // feeAfter[1..5]는 DT(연·월·일·시·분), 금액은 그 다음인 [6].
      const lastAmount = feeAfter ? won(feeAfter[6]) : undefined;
      lossSteps.push({ thresholdDate: boundary, percent: after ? 100 : null, amount: lastAmount, usesFirstNight: false });
      const finalDesc = after
        ? "환불이 불가해요."
        : feeAfter
        ? `취소 수수료 ${lastAmount.toLocaleString("ko-KR")}원이 부과돼요.`
        : "취소 수수료가 발생할 수 있어요.";
      const note = tiers.length
        ? `그 이후엔 단계적으로 취소 수수료(${tiers.map((t) => t.amount.toLocaleString("ko-KR") + "원").join(" → ")})가 부과되고, 마지막엔 ${finalDesc}`
        : `그 이후엔 ${finalDesc}`;
      return { status: "free", deadline: label(full), penaltyNote: withLocalTime(note, text), lossSteps, ...common };
    }

    // E: 무료취소 없이 처음부터 수수료 구간이 있고, 마감 뒤에 환불불가(또는 고정 금액)로 넘어감
    //  "… 9월 24일 23:59 이전에 취소하실 경우, 125,389원의 취소 수수료가 부과됩니다.
    //   … 9월 24일 23:59 이후에 취소하실 경우, 환불이 불가합니다." (실측 2026-09-24, 로그 원문)
    // 예전엔 A(FULL_REFUND)가 없으면 통째로 null → 공용 분류기가 "환불이 불가"만 보고 처음부터
    // 환불불가·체크인일 100%로 읽어서, 앞의 125,389원 구간이 사라지고 "취소해도 전액 부담"이
    // 됐다. 지금(오늘 0시)부터 첫 구간 금액, 마감 시각부터 환불불가(100%)/고정 금액으로 잇는다.
    const feeTiers = [...text.matchAll(FEE_TIER_RE)]
      .map((m) => ({ t: stamp(m), amount: won(m[6]), m }))
      .sort((a, b) => a.t - b.t);
    if (feeTiers.length) {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const after = NO_REFUND_AFTER_RE.exec(text);
      const feeAfter = !after ? FEE_AFTER_RE.exec(text) : null;
      const lossSteps = [];
      let start = todayStart;
      feeTiers.forEach((tier, i) => {
        lossSteps.push({ thresholdDate: start, amount: tier.amount, percent: null, usesFirstNight: false, ...(i === 0 ? { immediate: true } : {}) });
        start = tier.t;
      });
      // 마감 뒤: 환불불가면 전액(100%), 고정 금액이 있으면 그 금액, 둘 다 없으면 모른다(단정 금지).
      lossSteps.push({ thresholdDate: start, percent: after ? 100 : null, amount: feeAfter ? won(feeAfter[6]) : undefined, usesFirstNight: false });
      const lastTier = feeTiers[feeTiers.length - 1];
      const finalDesc = after
        ? "환불이 불가해요."
        : feeAfter
        ? `취소 수수료 ${won(feeAfter[6]).toLocaleString("ko-KR")}원이 부과돼요.`
        : "취소 수수료가 발생할 수 있어요.";
      const note = `지금 취소하면 수수료 ${feeTiers[0].amount.toLocaleString("ko-KR")}원이 부과되고, ${label(lastTier.m)} 이후엔 ${finalDesc}`;
      return { status: "unclear", deadline: null, penaltyNote: withLocalTime(note, text), lossSteps, ...common };
    }

    // 행 요약: "9월 24일 23:59 전 취소 시 125,389원의 수수료가 부과됩니다" — 모달 원문(E)의 한 줄 요약.
    // 마감 이후 금액은 행엔 없어서 모르는 채로 둔다(percent 미상).
    const rowFee = ROW_FEE_RE.exec(text);
    if (rowFee) {
      const year = rowFee[1] ? +rowFee[1] : inferYear(+rowFee[2], +rowFee[3], ctx);
      const until = new Date(year, +rowFee[2] - 1, +rowFee[3], +rowFee[4], +rowFee[5]);
      const now = new Date();
      const amount = won(rowFee[6]);
      return {
        status: "unclear",
        deadline: null,
        penaltyNote: `지금 취소하면 수수료 ${amount.toLocaleString("ko-KR")}원이 부과돼요.`,
        lossSteps: [
          { thresholdDate: new Date(now.getFullYear(), now.getMonth(), now.getDate()), amount, percent: null, usesFirstNight: false, immediate: true },
          { thresholdDate: until, percent: null, usesFirstNight: false },
        ],
        ...common,
      };
    }

    // B: 처음부터 취소 수수료
    const feeNow = FEE_NOW_RE.exec(text);
    if (feeNow) {
      const amount = won(feeNow[1]);
      const today = new Date();
      return {
        status: "unclear",
        deadline: null,
        penaltyNote: `지금 취소하면 수수료 ${amount.toLocaleString("ko-KR")}원이 부과돼요.`,
        lossSteps: [{ thresholdDate: new Date(today.getFullYear(), today.getMonth(), today.getDate()), amount, percent: null, usesFirstNight: false }],
        ...common,
      };
    }

    // 행에 보이는 첫 무료취소 마감. 이후 금액은 모달을 열어야 알 수 있어 percent 를 모른다.
    const row = ROW_FREE_RE.exec(text);
    if (row) {
      const year = row[1] ? +row[1] : inferYear(+row[2], +row[3], ctx);
      const t = new Date(year, +row[2] - 1, +row[3], +row[4], +row[5]);
      return {
        status: "free",
        deadline: `${row[1] ? row[1] + "년 " : ""}${+row[2]}월 ${+row[3]}일 ${pad(row[4])}:${row[5]}`,
        penaltyNote: null,
        lossSteps: [{ thresholdDate: t, percent: null, usesFirstNight: false }],
        ...common,
      };
    }
    return null;
  }

  // ── 리뷰 ───────────────────────────────────────────────────────────────────
  // 실측: POST /restapi/soa2/34308/getHotelCommentInfo, credentials:"omit" 로도 응답한다.
  // 응답의 리뷰 배열은 groupList[0].commentList, 만점 10점(commentRating.fullRating).
  // 필드: content(원문) / language / translatedContent(한국어 번역) / translatedLanguage /
  //       createDate / checkInDate / rating.
  // 실측(2026-09-23, 페이지 안에서 fetch 후킹으로 확인):
  //   (1) 정렬은 commentFilterOptions.orderBy **문자열** — "0" 관련순(기본) · "1" 최신순 ·
  //       "2" 평점 높은순 · "3" 평점 낮은순. 낮은순 상위 10건 평점 2,2,2,3.5,… 로 서버 정렬 확인.
  //   (2) pageSize 는 100 까지 먹는다(200 은 100 으로 잘림). 예전 주석의 "상한 10" 은
  //       기본 요청값을 상한으로 오해한 것. 혹시 10 으로 잘리면 10 페이지 루프로 강등한다.
  //   (3) createDate "2026-08-11 21:11:33" (공백 구분), checkinDate 는 일자가 항상 01 —
  //       "최근 1년" 판정은 createDate 로 한다(recency.ts 가 공백을 T 로 바꿔 읽는다).
  //   (4) head.pageId 가 필수인지는 미확인 — 실측 요청의 값을 그대로 보낸다.
  const REVIEW_API = "/restapi/soa2/34308/getHotelCommentInfo";
  const ORDER_LOW_RATING_FIRST = "3";
  const ORDER_MOST_RECENT = "1";
  // 두 정렬을 합친다: 낮은 평점순 100 + 최신순 100. 저점 100건만 보면 대형 호텔에서 최근 1년
  // 저점 리뷰가 100건 밖으로 밀려 안 보일 수 있다(2026-09-24). 겹치는 건 앞 80자로 걸러낸다.
  const ORDERS = [ORDER_LOW_RATING_FIRST, ORDER_MOST_RECENT];
  const PAGE_SIZES = [100, 10]; // 앞에서부터 시도, 응답이 비면 다음 크기로
  const MAX_REVIEWS = 100; // 정렬 하나당 상한
  const HANGUL = /[가-힣]/;

  function reviewBody(id, pageIndex, pageSize, orderBy) {
    return {
      hotelId: Number(id),
      commentFilterOptions: { pageIndex, pageSize, repeatComment: 1, orderBy },
      sceneTypes: ["CommentList"],
      head: {
        platform: "H5", cver: "0", bu: "IBU", group: "trip", locale: "ko-KR",
        timezone: "9", currency: "KRW", pageId: "10320668147", isSSR: false,
      },
    };
  }

  async function callReviewApi(id, pageIndex, pageSize, orderBy) {
    const res = await fetch(REVIEW_API, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(reviewBody(id, pageIndex, pageSize, orderBy)),
    });
    if (!res.ok) throw new Error(`리뷰 API ${res.status}`);
    const json = await res.json();
    const root = json?.data?.data ?? json?.data ?? json;
    return root?.groupList?.[0]?.commentList ?? [];
  }

  // 모델은 한국어로 학습됐으므로 한글 본문을 우선한다: 원문이 한국어면 원문, 아니면
  // 한국어 번역본, 둘 다 아니면 원문(영어 등).
  function pickText(c) {
    const orig = c.content || "";
    if (HANGUL.test(orig)) return orig;
    const tr = c.translatedContent || "";
    return HANGUL.test(tr) ? tr : orig;
  }

  async function fetchReviews(onProgress) {
    const id = hotelId();
    if (!id) throw Object.assign(new Error("hotelId를 페이지에서 찾지 못했습니다"), { code: "NO_HOTEL_ID" });
    // 정렬 하나를 받는다. 큰 페이지부터 시도해서 100 이 먹으면 한 번에 끝나고, 서버가
    // 10 으로 자르면(list.length === 10 < 100) 10 짜리 루프로 이어서 받는다.
    async function fetchByOrder(orderBy, label, sofar) {
      const got = [];
      let pageSize = PAGE_SIZES[0];
      let page = 1;
      while (got.length < MAX_REVIEWS) {
        const list = await callReviewApi(id, page, pageSize, orderBy);
        if (!list.length && page === 1 && pageSize !== PAGE_SIZES[PAGE_SIZES.length - 1]) {
          pageSize = PAGE_SIZES[PAGE_SIZES.indexOf(pageSize) + 1];
          continue;
        }
        got.push(...list);
        onProgress?.(`리뷰 ${sofar + got.length}건 가져오는 중 (${label})`);
        if (!list.length) break;
        if (list.length < pageSize) {
          // 요청보다 적게 왔다 — 마지막 페이지이거나 서버가 잘랐다. 잘린 경우(정확히 10)만 강등.
          if (list.length === 10 && pageSize > 10) { pageSize = 10; page = 2; continue; }
          break;
        }
        page += 1;
      }
      if (got.length > MAX_REVIEWS) got.length = MAX_REVIEWS;
      return got;
    }
    const all = [];
    const seen = new Set();
    const labels = { [ORDER_LOW_RATING_FIRST]: "낮은 평점순", [ORDER_MOST_RECENT]: "최신순" };
    for (const orderBy of ORDERS) {
      let list;
      try {
        list = await fetchByOrder(orderBy, labels[orderBy], all.length);
      } catch (e) {
        if (!all.length) throw e; // 첫 정렬이 실패하면 예전과 같이 실패로 올린다
        break;                    // 두 번째 정렬 실패는 무시 — 첫 정렬 결과로 간다
      }
      for (const c of list) {
        const sig = (c.content || c.translatedContent || "").slice(0, 80);
        if (sig && seen.has(sig)) continue;
        seen.add(sig);
        all.push(c);
      }
    }
    if (!all.length) return null; // 호출부가 "빈 응답"으로 처리한다
    return all
      .map((c, i) => {
        const r = Number(c.rating);
        return {
          index: i,
          text: pickText(c).trim(),
          date: c.createDate || null,
          rating: Number.isFinite(r) && c.rating != null && c.rating !== "" ? r : null,
          ratingScale: 10,
          isHotelReply: false,
        };
      })
      .filter((r) => r.text.length > 0);
  }

  try {
    if (!window.__ccSites) throw new Error("sites.js 가 먼저 로드돼야 합니다");
    window.__ccSites.register({
      id: "tripcom",
      displayName: "트립닷컴",
      matches: (host) => /(^|\.)trip\.com$/.test(host),
      isListingPage,
      hotelId,
      stayDates,
      hints: {
        rateRow: "[data-saleroom-key]",
        rateRowVisibleOnly: true, // 실측: 숨은 행도 DOM 에 있다
        listingCard: "[data-offline-hotelid]",
      },
      // 실측 후보: 달력 관련 컨테이너. 날짜 변경 시 요금 영역이 통째로 교체되는 SPA 라
      // 달력 조작이 스캔을 유발하지 않게 뺀다(아고다 검색바 타이밍 간섭 사고와 같은 종류).
      excludeZones: [
        '[data-stop-blur="stop-calendar-blur"]',
        '.c-calendar[role="application"]',
        "#c-calender-modal-wrapper",
      ],
      price: { finalPrice },
      cancellation: { revealTrigger, modal, modalText, parse, closeModal },
      reviews: {
        source: "api",
        loadingHint: "트립닷컴에서 리뷰를 가져옵니다",
        fetch: fetchReviews,
      },
    });
  } catch (e) {
    console.error("[cc] 트립닷컴 어댑터 등록 중 예외:", e);
  }
})();
