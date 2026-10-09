// ── collect-reviews.js — 숙소 리뷰 수집기 (콘솔 붙여넣기용) ──
//
// 사용법:
//   1. 에어비앤비/아고다 등 숙소 상세 페이지를 연다
//   2. F12 → 콘솔 → 이 파일 전체를 붙여넣는다
//   3. await collectReviews()
//      → 리뷰 모달 열기 → 끝까지 스크롤 → 잘린 리뷰 펼치기 → 추출
//      → 결과가 클립보드에 복사되고 window.__reviews 에도 남는다
//   4. 붙여넣어 data/{사이트}-{숙소id}.json 으로 저장
//
// 옵션:
//   await collectReviews({ maxScrolls: 200 })   // 리뷰가 아주 많은 숙소
//   await collectReviews({ skipModal: true })   // 이미 모달을 열어둔 경우
//   collectReviews.probe()                      // 수집 없이 구조 정찰만 (1-1 단계용)
//
// ⚠️ 이 파일은 darkpattern/docs/탐지기-작성-규칙.md 의 "DOM 조작 금지" 규칙 밖에 있다.
//    리뷰가 lazy load라 스크롤·클릭이 반드시 필요해서, '탐지기'가 아니라 '수집기'로 분류한다.
//    관제탑 통합 대상이 아니며, 개발자가 수동으로 1회 실행하는 도구다.
//
// ⚠️ 선택자를 하드코딩하지 않는다. 사이트마다 클래스명이 다르고 수시로 바뀌기 때문에,
//    "날짜를 담은 형제 요소가 3개 이상 반복되는 컨테이너"라는 구조 휴리스틱으로 찾는다.
//    (findTotalPriceNode가 7개 사이트에서 사이트별 규칙 없이 통한 것과 같은 접근)
//    아직 실사이트 검증 전이므로, 안 잡히면 probe()로 무엇이 후보에 올랐는지 먼저 볼 것.

(() => {
  // 고칠 때마다 콘솔에 다시 붙여넣어야 하는데, 어느 버전이 돌고 있는지 알 방법이 없어서
  // 이미 고친 버그를 몇 번이나 다시 디버깅했다. 버전을 찍어서 그 혼동을 없앤다.
  const VERSION = "2026-08-29-e";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 날짜 인식 ────────────────────────────────────────────────
  // 한국어/영어 + 상대표기(3일 전)까지. 리뷰 카드를 식별하는 1차 신호다.
  const DATE_PATTERNS = [
    /\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?/,       // 2026년 9월 13일
    /\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}/,          // 2026. 9. 13. / 2026-09-13
    /\d{1,2}\s*월\s*\d{4}/,                                  // 9월 2026
    /\d+\s*(?:일|주|개월|달|년)\s*전/,                        // 3일 전, 2개월 전
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}/i,
    /\d+\s+(?:days?|weeks?|months?|years?)\s+ago/i,
  ];
  const hasDate = (t) => DATE_PATTERNS.some((re) => re.test(t));
  const findDate = (t) => {
    for (const re of DATE_PATTERNS) {
      const m = t.match(re);
      if (m) return m[0].trim();
    }
    return null;
  };

  // ── 평점 인식 ────────────────────────────────────────────────
  // 사이트마다 척도가 다르다. 에어비앤비는 5점, 아고다·부킹닷컴은 10점.
  // 실측(아고다 2026-08-29): 10점 척도라 0~5만 받던 옛 코드가 전부 null을 냈다.
  // 그래서 척도를 같이 기록한다 — 나중에 정규화하려면 원래 척도를 알아야 한다.
  const RATING_PATTERNS = [
    [/별점\s*([\d.]+)\s*점/, null],
    [/([\d.]+)\s*(?:점|점\s*만점에|\/\s*10|out of 10)/i, 10],
    [/([\d.]+)\s*(?:\/\s*5|out of 5|stars?)/i, 5],
    [/rating[:\s]+([\d.]+)/i, null],
  ];

  function parseRating(s) {
    for (const [re, scaleHint] of RATING_PATTERNS) {
      const m = String(s).match(re);
      if (!m) continue;
      const v = parseFloat(m[1]);
      if (!Number.isFinite(v) || v < 0 || v > 10) continue;
      // 척도 힌트가 없으면 값으로 추정한다 (5 초과면 10점 척도)
      const scale = scaleHint ?? (v > 5 ? 10 : 5);
      if (v > scale) continue;
      return { rating: v, ratingScale: scale };
    }
    return null;
  }

  function findRating(el) {
    // aria-label을 먼저 본다 — 별 아이콘은 텍스트가 없고 접근성 라벨에만 점수가 있다
    for (const n of [el, ...el.querySelectorAll("[aria-label],[title]")]) {
      const label = n.getAttribute?.("aria-label") || n.getAttribute?.("title") || "";
      const r = label && parseRating(label);
      if (r) return r;
    }
    const r = parseRating((el.innerText || "").slice(0, 120));
    if (r) return r;
    // 아고다처럼 점수를 라벨 없이 숫자만 크게 박아두는 경우 (예: "9.2")
    const bare = (el.innerText || "").match(/(?:^|\s)(10(?:\.0)?|[0-9](?:\.\d)?)(?:\s|$)/);
    if (bare) {
      const v = parseFloat(bare[1]);
      if (v > 5 && v <= 10) return { rating: v, ratingScale: 10 };
    }
    return null;
  }

  // ── 리뷰 본문 추출 ───────────────────────────────────────────
  // 카드 안에서 "가장 긴 텍스트 덩어리"를 본문으로 본다. 작성자명·날짜·평점은
  // 전부 짧아서 자연히 걸러진다. 라벨과 본문이 다른 태그로 쪼개진 마크업에 대비해
  // hidden-info.js의 ownText와 같은 방식으로 직접 텍스트만 읽는 경로도 함께 본다.
  const MIN_BODY_LEN = 15;
  const MAX_BODY_LEN = 4000;

  function ownText(el) {
    let s = "";
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
    return s.trim();
  }

  function extractBody(card) {
    let best = "";
    for (const n of card.querySelectorAll("*")) {
      const t = (n.children.length === 0 ? n.textContent || "" : ownText(n))
        .trim().replace(/\s+/g, " ");
      if (t.length > MAX_BODY_LEN) continue;
      // 아고다는 호텔 답글을 리뷰 카드 **안에** 넣는다(실측 2026-08-29). 답글이 손님
      // 리뷰보다 길면 답글이 본문으로 뽑혀서, 실제 리뷰를 잃고 홍보문을 저장하게 된다.
      // 게다가 답글은 정형문이라 앞부분이 서로 같아 중복 제거에 걸려 페이지가 통째로 날아간다.
      if (isHotelReply(t)) continue;
      if (t.length > best.length) best = t;
    }
    // 자식이 하나뿐인 단순 카드는 위 루프에서 아무것도 못 건질 수 있다.
    // (카드 전체가 답글인 경우도 여기로 온다 — 그건 isHotelReply 표시로 걸러진다)
    if (best.length < MIN_BODY_LEN) {
      best = (card.innerText || "").trim().replace(/\s+/g, " ").slice(0, MAX_BODY_LEN);
    }
    return best;
  }

  // ── 리뷰 컨테이너 찾기 ───────────────────────────────────────
  // "날짜를 포함하고 본문 길이가 그럴듯한 자식"이 3개 이상인 요소들을 점수화해서 고른다.
  // 같은 점수면 더 깊은(구체적인) 쪽을 택한다 — 조상은 항상 자식과 같은 점수를 받으므로.
  const MIN_CARDS = 3;

  function depthOf(el) {
    let d = 0;
    for (let n = el; n; n = n.parentElement) d++;
    return d;
  }

  /** 카드 하나가 리뷰로 인정되는지 + 그 이유.
   *  이유 문자열을 남기는 건 inspect.js가 UI에 그대로 보여주기 위해서다 —
   *  "왜 이건 걸러졌나"를 사람이 눈으로 확인할 수 있어야 휴리스틱을 고칠 수 있다. */
  function cardReason(node) {
    const t = (node.innerText || "").trim();
    if (t.length < MIN_BODY_LEN) return { ok: false, why: `본문 ${t.length}자 — 최소 ${MIN_BODY_LEN}자 미달` };
    if (t.length > MAX_BODY_LEN) return { ok: false, why: `본문 ${t.length}자 — 최대 ${MAX_BODY_LEN}자 초과` };
    if (!hasDate(t)) return { ok: false, why: "날짜 표기를 못 찾음" };
    return { ok: true, why: `날짜 "${findDate(t)}" · 본문 ${t.length}자` };
  }

  // ── 리뷰다움 ─────────────────────────────────────────────────
  // 개수만으로 고르면 **항목이 많은 객실 목록이 리뷰 목록을 이긴다.**
  // (아고다 실측 2026-08-29: 객실 카드 10개 vs 한 페이지 리뷰 5개 → 객실이 선택됨)
  // 객실 카드에도 날짜(무료취소 기한)와 긴 설명이 있어 '리뷰 모양'으로 채점되기 때문.
  // 그래서 '얼마나 리뷰처럼 생겼는가'를 따로 재서 순위를 정한다.
  const PRICE_RE = /₩|\$|\d{1,3}(?:,\d{3})+\s*원?/;
  // '예약'만 보면 리뷰 본문("예약했는데…")에 걸리므로 버튼 문구 형태로 좁힌다
  const CTA_RE = /예약하기|지금\s*예약|객실\s*(?:보기|선택)|선택하기|장바구니|담기|book now|select room|reserve now/i;

  /** 자식 카드들이 리뷰처럼 생겼는지 — 평점·산문은 가점, 가격·예약버튼은 감점 */
  function reviewnessOf(kids) {
    let rating = 0, prose = 0, price = 0, cta = 0;
    for (const k of kids) {
      const t = (k.innerText || "").trim();
      if (findRating(k)) rating++;
      // 리뷰는 문장이고, 객실 카드는 라벨의 나열이다
      if (/[.!?。]/.test(t) || t.length >= 80) prose++;
      if (PRICE_RE.test(t)) price++;
      if (CTA_RE.test(t)) cta++;
    }
    const n = Math.max(1, kids.length);
    const s = {
      ratingRatio: rating / n, proseRatio: prose / n,
      priceRatio: price / n, ctaRatio: cta / n,
    };
    s.reviewness = s.ratingRatio * 2 + s.proseRatio * 2 - s.priceRatio * 1.5 - s.ctaRatio * 2;
    return s;
  }

  /** 컨테이너 후보 판정.
   *  `score`(리뷰 모양 자식 수)는 **후보 자격**만 정하고, 순위는 `reviewness`가 정한다. */
  function scoreDetail(el) {
    const kids = [...el.children];
    const base = { el, kids: kids.length, ok: 0, score: 0, reviewness: -Infinity };
    if (kids.length < MIN_CARDS) {
      return { ...base, why: `자식 ${kids.length}개 — 최소 ${MIN_CARDS}개 미달` };
    }
    let ok = 0;
    for (const k of kids) if (cardReason(k).ok) ok++;
    if (ok < MIN_CARDS) {
      return { ...base, ok, why: `리뷰 모양 자식 ${ok}개 — 최소 ${MIN_CARDS}개 미달` };
    }
    // 절반 이상이 리뷰 모양이어야 리스트로 인정 (헤더 한두 개 섞이는 건 허용)
    if (ok < kids.length * 0.5) {
      return { ...base, ok, why: `리뷰 모양 ${ok}/${kids.length} — 절반 미만이라 리스트로 안 봄` };
    }
    // 여기까지 온 것만 리뷰다움을 잰다 (비싼 계산이라 후보에만 적용)
    const sig = reviewnessOf(kids);
    return {
      ...base, ...sig, ok, score: ok,
      why: `리뷰 모양 ${ok}/${kids.length} · 리뷰다움 ${sig.reviewness.toFixed(2)}`
        + ` (평점 ${(sig.ratingRatio * 100) | 0}% 산문 ${(sig.proseRatio * 100) | 0}%`
        + ` 가격 ${(sig.priceRatio * 100) | 0}% 예약버튼 ${(sig.ctaRatio * 100) | 0}%)`,
    };
  }

  const scoreContainer = (el) => scoreDetail(el).score;

  /** 후보를 **리뷰다움 우선**으로 정렬. 개수는 동점 처리용으로 강등했다. */
  function rankCandidates(root = document, limit = 8) {
    const out = [];
    for (const el of root.querySelectorAll("div,ul,ol,section,main")) {
      const d = scoreDetail(el);
      if (d.score > 0) out.push({ ...d, depth: depthOf(el) });
    }
    out.sort((a, b) =>
      (b.reviewness - a.reviewness) || (b.ok - a.ok) || (b.depth - a.depth));
    return out.slice(0, limit);
  }

  /** 후보 중 **가장 리뷰다운** 것. 개수가 아니라 리뷰다움이 1순위다
   *  (개수로 고르면 객실 목록에 진다 — reviewnessOf 주석 참고). */
  function findReviewContainer(root = document) {
    return rankCandidates(root, 1)[0]?.el || null;
  }

  // ── 모달 열기 ────────────────────────────────────────────────
  // 버튼 문구가 사이트마다 다르다. 에어비앤비는 "후기 60개 모두 보기"처럼 '후기'가
  // 문구에 들어 있지만, 아고다는 그냥 "모두 보기"다(실측 2026-08-27). 후자는 사진·
  // 편의시설 등 다른 섹션에도 똑같이 있어서, 문구만으로는 리뷰 버튼인지 알 수 없다.
  // → 문구에 '후기/리뷰'가 있으면 바로 채택하고, 없으면 조상에 리뷰 맥락이 있을 때만 채택.
  const OPEN_SPECIFIC_RE = /후기\s*[\d,]*\s*개?\s*(?:모두|전체)|리뷰\s*[\d,]*\s*개?\s*(?:모두|전체)|모든\s*(?:후기|리뷰)|(?:후기|리뷰)\s*(?:전체|더\s*보기)|(?:show|read|see)\s+all.*reviews?/i;
  const OPEN_GENERIC_RE = /^\s*(?:모두\s*보기|전체\s*보기|더\s*보기|see\s+all|show\s+all|view\s+all)\s*$/i;
  const REVIEW_CONTEXT_RE = /이용후기|후기|리뷰|평점|reviews?\b/i;

  /** 조상 몇 단계 안에 리뷰 맥락(후기·리뷰·평점)이 있는가 — 범용 문구 버튼의 오채택 방지.
   *
   *  body까지 올라가면 안 된다. 페이지 어딘가에 '이용후기'가 있으면 모든 버튼이 통과해서
   *  검사가 무의미해진다 — 실제로 아고다 픽스처에서 사진 갤러리의 '모두 보기'가
   *  body 텍스트 덕에 통과하는 버그가 있었다(test-heuristic.mjs 시나리오 B가 잡음).
   *  그래서 body/html 직전에 멈추고, 조상이 지나치게 크면(=섹션이 아니라 페이지 덩어리)
   *  맥락으로 인정하지 않는다. */
  const CONTEXT_MAX_TEXT = 1200;

  function nearReviewContext(el, levels = 4) {
    let n = el;
    for (let i = 0; i < levels; i++) {
      n = n?.parentElement;
      if (!n || n === document.body || n === document.documentElement) return false;
      const t = n.innerText || "";
      if (t.length > CONTEXT_MAX_TEXT) return false; // 이 위로는 더 봐도 의미 없다
      if (REVIEW_CONTEXT_RE.test(t)) return true;
    }
    return false;
  }

  function findOpenButton() {
    const clickable = [...document.querySelectorAll('button,a,[role="button"],[role="link"]')];
    // 1순위: 문구 자체에 '후기/리뷰'가 들어간 버튼
    for (const el of clickable) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (!t || t.length > 40) continue;
      if (OPEN_SPECIFIC_RE.test(t)) return el;
    }
    // 2순위: "모두 보기"처럼 범용 문구 — 리뷰 섹션 안에 있을 때만
    for (const el of clickable) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (!t || t.length > 20) continue;
      if (OPEN_GENERIC_RE.test(t) && nearReviewContext(el)) return el;
    }
    return null;
  }

  // ── 스크롤 가능한 조상 찾기 ──────────────────────────────────
  // 모달 안의 리뷰 리스트는 window가 아니라 모달 내부 div가 스크롤된다.
  function scrollableAncestor(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      const canScroll = /auto|scroll|overlay/.test(s.overflowY);
      if (canScroll && n.scrollHeight > n.clientHeight + 10) return n;
    }
    return null; // null이면 window를 스크롤한다
  }

  async function autoScroll(container, { maxScrolls = 120, settleMs = 450 } = {}) {
    const scroller = scrollableAncestor(container);
    let stable = 0;
    let lastCount = container.children.length;

    for (let i = 0; i < maxScrolls; i++) {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
      await wait(settleMs);

      const now = container.children.length;
      if (now === lastCount) {
        // 3연속 안 늘면 끝난 것으로 본다 (네트워크 지연으로 한 번 멈추는 경우 대비)
        if (++stable >= 3) break;
      } else {
        stable = 0;
        lastCount = now;
      }
    }
    return lastCount;
  }

  // ── 페이지네이션 ─────────────────────────────────────────────
  // 아고다는 무한스크롤이 아니라 **한 페이지에 5개씩** 끊어 보여준다(실측 2026-08-29).
  // 스크롤만으로는 5개에서 멈추므로 '다음' 버튼을 눌러가며 모아야 한다.
  // 화살표는 사이트마다 다른 글자를 쓴다(›, >, ＞, », →, ▶). 전체가 화살표 하나일 때만
  // 인정하므로 본문에 '>'가 섞인 요소가 걸릴 일은 없다.
  const NEXT_RE = /^\s*(?:다음|다음\s*페이지|next(?:\s*page)?|›|»|>|＞|⟩|→|▶|▷)\s*$/i;
  const NEXT_LABEL_RE = /다음\s*(?:페이지)?|next\s*(?:page)?/i;

  /** '다음 페이지' 버튼. 비활성 상태면 null (마지막 페이지) */
  function findNextButton(container) {
    const cands = [...document.querySelectorAll('button,a,[role="button"],[aria-label]')];
    for (const el of cands) {
      const t = (el.innerText || "").trim();
      const label = el.getAttribute?.("aria-label") || "";
      const hit = NEXT_RE.test(t) || (label && NEXT_LABEL_RE.test(label) && t.length <= 6);
      if (!hit) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      // 리뷰 영역 근처의 것만 — 사진 갤러리·지도에도 '다음' 화살표가 있다
      if (container && !isNearContainer(el, container)) continue;
      return el;
    }
    return null;
  }

  /** 두 요소가 같은 영역에 있는가 — 공통 조상까지의 거리로 판단 */
  function isNearContainer(el, container, maxUp = 8) {
    let n = container;
    for (let i = 0; i < maxUp && n; i++, n = n.parentElement) {
      if (n.contains(el)) return true;
    }
    return false;
  }

  /** 화살표를 못 찾을 때의 폴백 — '1 2 3 … 2116' 형태에서 **다음 번호 버튼**을 직접 누른다.
   *  현재 페이지 하이라이트를 알아내는 건 사이트마다 방식이 달라 불안정하므로,
   *  우리가 센 페이지 번호로 찾는다. */
  function findNextByNumber(container, nextPageNo) {
    for (const el of document.querySelectorAll('button,a,[role="button"]')) {
      if ((el.innerText || "").trim() !== String(nextPageNo)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (container && !isNearContainer(el, container, 10)) continue;
      return el;
    }
    return null;
  }

  /** 목록 상태를 한 문자열로. 첫 카드만 보면 렌더 도중에 '바뀌었다'고 오판한다
   *  (실측: 4페이지에서 첫 카드는 바뀌었는데 나머지가 아직 이전 내용이라 새 리뷰 0건). */
  function pageSignature(container) {
    return [...container.children].slice(0, 5)
      .map((c) => (c.innerText || "").slice(0, 40)).join("|");
  }

  /** 목록이 실제로 바뀔 때까지 기다린다. **바뀐(또는 교체된) 컨테이너를 돌려준다.**
   *
   *  아고다는 페이지를 넘길 때 리뷰 목록 <ol>을 통째로 갈아끼운다. 그러면 우리가 들고 있던
   *  참조는 화면에서 떨어져 나간 노드가 되고, 그 노드는 영원히 안 바뀌므로
   *  "내용이 안 바뀜"으로 조기 종료된다. (실측: 3~4페이지에서 매번 멈춘 진짜 원인)
   *  그래서 매 폴링마다 살아있는지 확인하고, 죽었으면 다시 찾는다. */
  async function waitForPageChange(refind, container, before, tries = 24) {
    for (let i = 0; i < tries; i++) {
      await wait(250);
      let c = container;
      if (!c.isConnected || !c.children.length) {
        c = refind();
        if (!c) continue;
      }
      const now = pageSignature(c);
      if (now && now !== before) {
        await wait(500); // 나머지 카드까지 다 그려지도록 잠깐 더 기다린다
        return c.isConnected ? c : (refind() || c);
      }
    }
    return null;
  }

  /** 페이지를 넘겨가며 전부 모은다. 스크롤형 사이트에서는 첫 바퀴만 돌고 끝난다. */
  async function collectAllPages(container, { maxPages = 60, onProgress } = {}) {
    const seen = new Set();
    const all = [];
    let rejected = [];
    let pages = 0;
    let stopReason = "maxPages 도달";

    // 리뷰 모달 안에서 시작했으면 **그 모달 안에서만** 다시 찾는다.
    // 배경 페이지에도 리뷰 목록(상위 몇 건)이 있어서, 문서 전체에서 다시 찾으면
    // 이미 수집한 그 목록으로 갈아타 버린다 → 새 리뷰 0건 → 조기 종료.
    const modalRoot = container.closest('[role="dialog"],[aria-modal="true"]');
    const refind = () => {
      const root = modalRoot && modalRoot.isConnected ? modalRoot : document;
      return findReviewContainer(root);
    };

    for (let p = 0; p < maxPages; p++) {
      pages++;
      if (!container.isConnected || !container.children.length) {
        const fresh = refind();
        if (!fresh) { stopReason = "목록이 화면에서 사라짐"; break; }
        container = fresh;
      }

      await expandAll(container);
      const r = extractReviews(container, seen);
      all.push(...r.reviews);
      rejected = r.rejected;
      onProgress?.(pages, all.length);

      // 화살표 → 없으면 숫자 페이지 버튼
      const next = findNextButton(container) || findNextByNumber(container, pages + 1);
      if (!next) { stopReason = "다음 버튼 없음 (마지막 페이지로 보임)"; break; }

      const before = pageSignature(container);
      next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const moved = await waitForPageChange(refind, container, before);
      if (!moved) { stopReason = "눌렀지만 내용이 안 바뀜 (마지막 페이지이거나 버튼이 엉뚱함)"; break; }
      container = moved;
    }
    return { reviews: all, rejected, pages, container, stopReason };
  }

  // ── 잘린 리뷰 펼치기 ─────────────────────────────────────────
  // 이게 없으면 "…주차비는" 처럼 정작 필요한 뒷부분이 잘린 채로 수집된다.
  const EXPAND_RE = /^\s*(?:더\s*보기|더보기|자세히\s*보기|show more|read more|더 읽기)\s*$/i;

  async function expandAll(container) {
    // 펼치기 클릭이 엉뚱한 모달을 열 수 있어(아고다 '자세히 보기' → 아동 정책 모달)
    // 클릭 전 모달 목록을 찍어두고, 새로 열린 것만 나중에 닫는다.
    const before = new Set(visibleModals());
    let clicked = 0;
    for (const el of container.querySelectorAll('button,a,[role="button"],span')) {
      const t = (el.innerText || "").trim();
      if (!EXPAND_RE.test(t)) continue;
      try {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        clicked++;
      } catch { /* 클릭이 막힌 요소는 조용히 넘어간다 */ }
    }
    if (clicked) {
      await wait(600);
      await closeStrayModals(before);
    }
    return clicked;
  }

  // ── 공식 표기 수집 ───────────────────────────────────────────
  // 3단계(표기 vs 실태 모순)의 premise가 될 값들. 지금은 "이 페이지가 무엇을 약속했는가"를
  // 문구 단위로 기록만 해둔다 — 1-3의 '공식 표기와 충돌하는 후보 건수' 집계에 필요.
  const OFFICIAL_CLAIMS = [
    "무료 주차", "무료주차", "주차 무료", "무료 주차 공간", "주차 가능",
    "무료 Wi-Fi", "무료 와이파이", "무료 인터넷",
    "조식 포함", "조식 무료", "아침 식사 포함",
    "무료 취소", "무료취소", "취소 수수료 없음",
    "셀프 체크인", "무료 생수", "무료 셔틀",
    "세금 및 수수료 포함", "세금 포함", "추가 요금 없음",
  ];

  function collectOfficialClaims() {
    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ");
    return OFFICIAL_CLAIMS.filter((c) => pageText.includes(c));
  }

  // ── 모달 안전장치 ────────────────────────────────────────────
  // 실측(아고다 2026-08-29): 객실 카드의 "자세히 보기"를 눌러 **아동 정책 모달**이 열렸고
  // Escape로 닫히지 않아 화면을 덮은 채로 남았다. 우리가 연 모달은 우리가 닫는다.
  function visibleModals() {
    const out = [];
    for (const el of document.querySelectorAll('[role="dialog"],[aria-modal="true"]')) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      out.push(el);
    }
    return out;
  }

  const CLOSE_TEXT_RE = /^\s*(?:×|✕|✖|X|닫기)\s*$/i;
  const CLOSE_LABEL_RE = /닫기|close|dismiss/i;

  /** 모달 하나를 닫는다. 닫기 버튼 → 모달에 Escape → document에 Escape 순으로 시도. */
  async function closeModal(el) {
    const gone = () => !document.contains(el) || !visibleModals().includes(el);

    const btn = [...el.querySelectorAll('button,[role="button"],a')].find((b) => {
      const t = (b.innerText || "").trim();
      const label = b.getAttribute?.("aria-label") || "";
      return CLOSE_TEXT_RE.test(t) || (label && CLOSE_LABEL_RE.test(label));
    });
    if (btn) {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await wait(350);
      if (gone()) return true;
    }
    for (const target of [el, document]) {
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
      }));
      await wait(300);
      if (gone()) return true;
    }
    return false;
  }

  /** before 이후에 새로 열린 모달만 닫는다 (리뷰 모달처럼 일부러 연 건 남겨둔다) */
  async function closeStrayModals(before) {
    let failed = 0;
    for (const m of visibleModals()) {
      if (before.has(m)) continue;
      if (!(await closeModal(m))) {
        failed++;
        console.warn("[collect] 모달이 안 닫힙니다 — 화면에서 직접 닫아주세요:", m);
      }
    }
    return failed;
  }

  // ── 취소·환불 정책 수집 ──────────────────────────────────────
  // 리뷰와 함께 '숙소가 공식적으로 약속한 조건'을 같이 모은다.
  // 이게 있어야 나중에 "표기 vs 실태" 대조를 할 수 있고, 취소 타임라인도 뽑을 수 있다.
  const POLICY_OPEN_RE = /취소\s*(?:및\s*환불\s*)?정책|환불\s*(?:정책|규정)|정책\s*(?:및\s*안내)?\s*보기|취소\s*수수료|cancellation policy/i;
  // 진짜 정책 문장은 **기한 + 결과**가 함께 나온다.
  //   "체크인 날짜 전 1일 이내 예약 취소 시 첫 1박 요금이 취소 요금으로 부과됩니다" ← 정책
  //   "여행 계획 변경 시 예약 '무료 취소' 가능합니다!"                              ← 광고 문구
  // 실측(2026-08-29): 결과 조건 없이 잡았더니 6건 중 5건이 광고 문구였다.
  const _DEADLINE = "(?:체크인|입실|예약)[^.]{0,50}(?:전|이내|까지)"
    + "|\\d{1,2}\\s*일\\s*(?:전|이내)"
    + "|\\d{4}\\s*년[^.]{0,25}(?:전|까지)";
  const _OUTCOME = "부과|청구|환불|반환|공제|위약|취소\\s*요금|취소\\s*수수료|무료\\s*취소|\\d+\\s*%|전액";
  // 순서를 양방향으로 연다. 실측(괌 2026-08-29): 아고다는 결과를 앞에 두기도 한다 —
  //   "예약 무료 취소 가능 - 2026년 9월 20일 전 예약 취소 시"  (결과 → 기한)
  // 한 방향만 보면 이런 문장을 통째로 놓쳐서 정책이 0건이 된다.
  const POLICY_SENT_RE = new RegExp(
    `(?:${_DEADLINE})[^.]{0,90}(?:${_OUTCOME})`
    + `|(?:${_OUTCOME})[^.]{0,90}(?:${_DEADLINE})`
    + `|(?:노\\s*쇼|no-?show)[^.]{0,60}(?:부과|전액|100)`
    + `|환불[^.]{0,30}(?:불가|되지\\s*않)`,
    "i",
  );
  const POLICY_MAX = 1200;

  /** 정책 모달/섹션을 열어본다. 열기 전 모달 목록을 같이 돌려줘서 나중에 정확히 닫게 한다. */
  async function openPolicy() {
    const before = new Set(visibleModals());
    for (const el of document.querySelectorAll('button,a,[role="button"]')) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (!t || t.length > 30) continue;
      if (!POLICY_OPEN_RE.test(t)) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await wait(900);
      return { el, before };
    }
    return null;
  }

  /** 화면 전체에서 취소·환불 조건 문장을 긁는다 */
  function scrapePolicyText() {
    const out = [];
    const seen = new Set();
    for (const n of document.querySelectorAll("p,div,span,li,td,dd,section")) {
      if (n.closest("#__rvInspect")) continue;
      const t = (n.children.length === 0 ? n.textContent || "" : ownText(n))
        .trim().replace(/\s+/g, " ");
      if (t.length < 15 || t.length > POLICY_MAX) continue;
      if (!POLICY_SENT_RE.test(t)) continue;
      const key = t.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  const CHECK_RE = {
    checkIn: /체크인[^\d]{0,12}(\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*시)/,
    checkOut: /체크아웃[^\d]{0,12}(\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*시)/,
  };

  async function collectPolicy() {
    // 먼저 현재 화면에서 긁고, 부족하면 모달을 열어 다시 긁는다
    let texts = scrapePolicyText();
    let opened = null;
    if (texts.length < 2) {
      opened = await openPolicy();
      if (opened) texts = scrapePolicyText();
    }
    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ");
    const grab = (re) => (pageText.match(re) || [])[1] || null;

    if (opened) {
      // 열었던 모달은 닫아준다 — 열어둔 채로 두면 화면을 덮어 이후 조작을 방해한다
      await closeStrayModals(opened.before);
    }

    return {
      cancellation: texts.slice(0, 8),
      checkIn: grab(CHECK_RE.checkIn),
      checkOut: grab(CHECK_RE.checkOut),
      freeCancelUntil: (pageText.match(/(\d{1,2}\s*월\s*\d{1,2}\s*일)[^.]{0,20}(?:까지|전까지)[^.]{0,20}무료\s*취소/) || [])[1]
        || (pageText.match(/무료\s*취소[^.]{0,20}(\d{1,2}\s*월\s*\d{1,2}\s*일)/) || [])[1] || null,
    };
  }

  // ── 객실별 취소정책 수집 ────────────────────────────────────
  // 팀 제출 형식이 **객실/요금제 단위**다:
  //   [1] 체크인: 2026-09-10 / 숙소: OO호텔 스탠다드룸(리조트)
  //   원문: "체크인 3일 전까지 무료 취소, 이후 첫 1박 요금 부과"
  // 같은 호텔이라도 '무료취소 요금제'와 '환불불가 특가'의 정책이 완전히 다르므로,
  // 페이지 전체에서 문장만 긁는 collectPolicy()로는 객실 구분이 안 된다.
  //
  // **리뷰와 무관하게 객실 목록 화면에서만 돌면 된다** — 리뷰 모달을 열 필요가 없다.
  const ROOM_NAME_RE = /(룸|room|스위트|suite|디럭스|deluxe|스탠다드|standard|슈페리어|superior|트윈|twin|더블|double|킹|king|퀸|queen|빌라|villa|방갈로|bungalow|스튜디오|studio|오션|ocean|가든|garden|시티\s*뷰|한실|온돌)/i;
  const ROOM_CARD_MAX = 1500;

  /** 정책 문장이 속한 '객실 카드'를 찾는다 — 객실명이 같이 들어 있는 가장 가까운 조상 */
  function cardOfPolicy(node, maxUp = 8) {
    let n = node;
    for (let i = 0; i < maxUp && n?.parentElement; i++) {
      n = n.parentElement;
      const t = (n.innerText || "").trim();
      if (t.length > ROOM_CARD_MAX) return null; // 카드보다 커지면 객실 단위가 아니다
      if (ROOM_NAME_RE.test(t)) return n;
    }
    return null;
  }

  /** 카드 안에서 객실명으로 보이는 가장 짧은 텍스트 */
  function roomNameOf(card) {
    let best = null;
    for (const n of card.querySelectorAll("*")) {
      const t = (n.children.length === 0 ? n.textContent || "" : ownText(n))
        .trim().replace(/\s+/g, " ");
      if (t.length < 3 || t.length > 60) continue;
      if (!ROOM_NAME_RE.test(t)) continue;
      if (POLICY_SENT_RE.test(t)) continue;          // 정책 문장은 객실명이 아니다
      if (!best || t.length < best.length) best = t;
    }
    return best;
  }

  // 객실 카드의 요금제 라벨은 **아주 짧다**(실측 발리 2026-08-29):
  //   "환불 불가 (낮은 요금)" 13자 · "예약 무료 취소" 8자
  // 문장용 최소 길이(15자)를 그대로 쓰면 131개 카드를 다 보고도 0건이 나온다.
  const RATE_LABEL_RE = /^(?:⊘|✓|·|\s)*(?:예약\s*)?(?:무료\s*취소|환불\s*불가|환불\s*가능|부분\s*환불|취소\s*불가)(?:\s*\([^)]{0,20}\))?\s*$/;
  const POLICY_MIN_LABEL = 5;

  /** 객실/요금제별 취소정책. 리뷰와 독립이라 객실 목록 화면에서 바로 실행하면 된다.
   *  짧은 요금제 라벨(kind:"label")과 완전한 정책 문장(kind:"sentence") 둘 다 모은다. */
  function collectRoomPolicies() {
    const out = [];
    const seen = new Set();

    for (const n of document.querySelectorAll("div,li,td,dd,p,span,section")) {
      if (n.closest("#__rvInspect")) continue;
      const t = (n.children.length === 0 ? n.textContent || "" : ownText(n))
        .trim().replace(/\s+/g, " ");
      if (t.length < POLICY_MIN_LABEL || t.length > POLICY_MAX) continue;

      const isLabel = RATE_LABEL_RE.test(t);
      const isSentence = t.length >= 15 && POLICY_SENT_RE.test(t);
      if (!isLabel && !isSentence) continue;

      const card = cardOfPolicy(n);
      const roomName = card ? roomNameOf(card) : null;
      // 객실명 + 정책으로 중복 제거 (같은 정책이 여러 요소에 중복 렌더되는 경우가 많다)
      const key = `${roomName || "-"}|${t.slice(0, 70)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ roomName, policy: t, kind: isSentence ? "sentence" : "label" });
    }

    // 객실명 있는 것 → 완전한 문장 순으로 (제출 형식에 객실명이 필요하다)
    out.sort((a, b) =>
      ((a.roomName ? 0 : 1) - (b.roomName ? 0 : 1))
      || ((a.kind === "sentence" ? 0 : 1) - (b.kind === "sentence" ? 0 : 1)));
    return out;
  }

  // ── [정책] 탭 — 숨은 비용이 공식적으로 적혀 있는 곳 ──────────
  // 실측(발리 2026-08-29): 이 탭에 우리가 리뷰에서 찾으려던 게 그대로 있다.
  //   주차료(1일): 0 IDR / 조식 요금(객실 요금에 불포함 시): 425000 IDR
  //   "오사카부 숙소세는 숙소에서 별도로 징수됩니다" / "6세 이상 아동은 추가 침대 및 조식 요금이 부과됩니다"
  // 리뷰보다 훨씬 확실한 출처라 별도로 구조화해서 담는다.
  const FEE_LABEL_RE = /주차료|주차\s*요금|조식\s*요금|숙박세|숙소세|도시세|관광세|리조트\s*(?:피|요금)|서비스\s*요금|청소비|보증금|추가\s*침대|엑스트라\s*베드|공항\s*이동|셔틀\s*요금|시설\s*이용료/;
  const VALUE_RE = /(?:\d[\d,]*\s*(?:원|KRW|IDR|JPY|USD|THB|VND|₩|\$|엔)|무료|없음|불포함|포함)/i;

  /** "라벨: 값" 형태의 요금 항목. 라벨과 값이 다른 태그로 쪼개진 경우도 처리한다. */
  function collectFees() {
    const fees = {};
    for (const n of document.querySelectorAll("div,li,td,dd,p,span,dt")) {
      if (n.closest("#__rvInspect")) continue;
      const t = (n.children.length === 0 ? n.textContent || "" : ownText(n))
        .trim().replace(/\s+/g, " ");
      if (!t || t.length > 120) continue;
      if (!FEE_LABEL_RE.test(t)) continue;

      // ① 한 덩어리에 "라벨: 값"이 다 있는 경우
      const m = t.match(/^(.{2,60}?)\s*[:：]\s*(.+)$/);
      if (m && VALUE_RE.test(m[2])) { fees[m[1].trim()] = m[2].trim(); continue; }
      // ② 값이 형제 요소에 있는 경우
      const sib = (n.nextElementSibling?.innerText || "").trim().replace(/\s+/g, " ");
      if (sib && sib.length <= 40 && VALUE_RE.test(sib)) { fees[t.replace(/[:：]\s*$/, "")] = sib; continue; }
      // ③ 값이 같은 텍스트 안에 붙어 있는 경우 ("주차료(1일) 0 IDR")
      if (VALUE_RE.test(t) && t.length <= 60) {
        const v = t.match(VALUE_RE);
        if (v) fees[t.slice(0, v.index).replace(/[:：]\s*$/, "").trim() || t] = v[0].trim();
      }
    }
    return fees;
  }

  /** 세금·추가요금을 알리는 안내 문장 ("숙소에서 알립니다", "기타 안내" 등) */
  const NOTICE_FEE_RE = /별도로?\s*징수|별도\s*부과|추가\s*요금|요금이?\s*부과|징수됩니다|포함되어\s*있지\s*않|불포함|납부하셔야|별도\s*결제|현장\s*(?:에서\s*)?(?:지불|결제|납부)/;

  function collectNotices() {
    const out = [];
    const seen = new Set();
    for (const n of document.querySelectorAll("li,p,div,span,dd")) {
      if (n.closest("#__rvInspect")) continue;
      const t = (n.children.length === 0 ? n.textContent || "" : ownText(n))
        .trim().replace(/\s+/g, " ");
      if (t.length < 12 || t.length > 600) continue;
      if (!NOTICE_FEE_RE.test(t)) continue;
      const key = t.slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out.slice(0, 20);
  }

  /** 정책을 세 갈래로 나눠 받는다. 리뷰 수집과 완전히 분리된 경로.
   *
   *  ① roomPolicies — 객실/요금제별 취소정책   [객실 상품 보기] 화면에서
   *  ② fees         — 주차료·조식요금 등 금액   [정책] 탭에서
   *  ③ notices      — 숙박세·추가요금 안내문    [정책] 탭에서
   *
   *  화면마다 있는 게 달라서, **두 화면에서 각각 한 번씩 실행하면 자동으로 합쳐진다.** */
  async function collectPolicies() {
    const rooms = collectRoomPolicies();
    const named = rooms.filter((r) => r.roomName);
    const fees = collectFees();
    const notices = collectNotices();

    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ");
    const grab = (re) => (pageText.match(re) || [])[1] || null;

    // 같은 숙소를 다른 화면에서 또 돌리면 이전 결과에 합친다 (객실 목록 ↔ 정책 탭)
    const prev = window.__policies;
    const sameListing = prev && prev.listingId === listingIdOf();
    const mergeRooms = () => {
      if (!sameListing) return rooms;
      const seen = new Set(rooms.map((r) => `${r.roomName || "-"}|${r.policy.slice(0, 70)}`));
      const kept = (prev.roomPolicies || []).filter(
        (r) => !seen.has(`${r.roomName || "-"}|${r.policy.slice(0, 70)}`));
      return [...rooms, ...kept];
    };

    const result = {
      site: siteOf(),
      listingId: listingIdOf(),
      listingName: listingNameOf(),
      url: location.href,
      collectedAt: new Date().toISOString(),
      collectorVersion: VERSION,
      checkIn: new URLSearchParams(location.search).get("checkIn")
        || new URLSearchParams(location.search).get("checkin") || null,
      checkInTime: grab(CHECK_RE.checkIn),
      checkOutTime: grab(CHECK_RE.checkOut),
      roomPolicies: mergeRooms(),
      fees: sameListing ? { ...(prev.fees || {}), ...fees } : fees,
      notices: sameListing
        ? [...new Set([...(prev.notices || []), ...notices])]
        : notices,
    };

    window.__policies = result;
    console.log(`%c[policy] ✅ 취소정책 ${result.roomPolicies.length}건(객실명 ${named.length})`
      + ` · 요금항목 ${Object.keys(result.fees).length}개 · 안내문 ${result.notices.length}건`,
      "color:green;font-weight:bold");
    if (Object.keys(result.fees).length) console.table(result.fees);
    if (result.notices.length) {
      console.log("안내문(숨은 비용):");
      for (const t of result.notices.slice(0, 6)) console.log("   ·", t.slice(0, 90));
    }
    if (!Object.keys(result.fees).length && !result.notices.length) {
      console.log("%c[policy] 💡 상단 [정책] 탭에서도 한 번 실행하면 주차료·조식요금·숙박세가 추가됩니다",
        "color:#0d9488");
    }

    if (!result.roomPolicies.length && !Object.keys(result.fees).length) {
      // 왜 0건인지 갈라서 알려준다 — "안 나온다"만으로는 뭘 고쳐야 할지 알 수 없다
      const roomish = [...document.querySelectorAll("div,li,section")]
        .filter((n) => {
          const t = (n.innerText || "").trim();
          return t.length > 20 && t.length < ROOM_CARD_MAX && ROOM_NAME_RE.test(t);
        }).length;
      console.log("%c[policy] ⚠️ 아무것도 못 찾았습니다.", "color:#c60;font-weight:bold");
      if (visibleModals().length) {
        console.log("%c  → 모달(리뷰 창 등)이 열려 있습니다. 닫고 다시 실행하세요.", "color:#c60");
      }
      console.log(`%c  → 객실 카드 ${roomish}개 감지. [객실 상품 보기]와 상단 [정책] 탭에서 각각 한 번씩 실행하세요.`,
        "color:#c60");
    }
    console.table(rooms.slice(0, 8).map((r) => ({
      객실: r.roomName || "(못 찾음)", 정책: r.policy.slice(0, 70),
    })));

    await saveResult({ ...result, _kind: "policy" },
      `${result.site}-${result.listingId}.policy.json`);
    return result;
  }

  // ── 메타 ─────────────────────────────────────────────────────
  function siteOf() {
    const h = location.hostname;
    if (h.includes("airbnb")) return "airbnb";
    if (h.includes("agoda")) return "agoda";
    if (h.includes("trip.com")) return "tripcom";
    if (h.includes("booking.com")) return "booking";
    if (h.includes("yeogi")) return "yeogi";
    if (h.includes("yanolja")) return "yanolja";
    return h.replace(/^www\./, "").split(".")[0];
  }

  function listingIdOf() {
    // 1) 경로의 긴 숫자 덩어리 (airbnb /rooms/1004020027854453112)
    const nums = location.pathname.match(/\d{4,}/g) || [];
    if (nums.length) return nums.sort((a, b) => b.length - a.length)[0];

    // 2) 쿼리 파라미터 (trip.com hotelId, booking.com hotel_id 등)
    const q = new URLSearchParams(location.search);
    for (const k of ["hotelId", "hotel_id", "productId", "propertyId", "itemId"]) {
      const v = q.get(k);
      if (v) return v;
    }

    // 3) 경로 슬러그 — 아고다는 숫자 id가 URL에 없다 (실측 2026-08-29).
    //    /ko-kr/hotel-gracery-shinjuku/hotel/tokyo-jp.html → hotel-gracery-shinjuku
    //    언어코드(ko-kr)·확장자·범용어(hotel, rooms)를 걸러내고 가장 긴 조각을 쓴다.
    const GENERIC = /^(hotel|hotels|rooms|room|stays|property|ko-kr|en-us|ko|en|www)$/i;
    const seg = location.pathname.split("/")
      .map((s) => s.replace(/\.(html?|php|aspx)$/i, ""))
      .filter((s) => s && !GENERIC.test(s) && !/^[a-z]{2}(-[a-z]{2})?$/i.test(s))
      .sort((a, b) => b.length - a.length)[0];
    return seg || "unknown";
  }

  /** 숙소 이름 — 파일만 보고 어느 숙소인지 알아볼 수 있게 (h1이 가장 안정적) */
  function listingNameOf() {
    const h1 = document.querySelector("h1");
    const t = (h1?.innerText || document.title || "").trim().replace(/\s+/g, " ");
    return t.slice(0, 120) || null;
  }

  // ── 호텔 답글 걸러내기 ───────────────────────────────────────
  // 실측(아고다 2026-08-29): 리뷰 목록에 호텔이 쓴 답글이 섞여 들어왔다.
  //   "고객님 그레이스리 신주쿠를 이용해 주시고 리뷰를 남겨 주셔서 감사합니다..."
  // 사업자가 쓴 문장이라 '소비자가 겪은 추가비용' 분석에 넣으면 안 된다.
  //
  // 문구를 통째로 외우는 방식은 금방 깨진다 — 실측(괌 2026-08-29)에서
  // "Thank you **again** for choosing…"처럼 단어 하나가 끼자 못 잡았고,
  // 그 답글이 리뷰 본문으로 저장되면서 페이지가 통째로 중복 처리됐다.
  // 그래서 **구조 신호**(답변일 표기, 편지 형식, 서명)를 먼저 본다.
  const HOTEL_REPLY_RE = [
    // ① 구조 — 아고다는 답글에 '답변일', 손님 리뷰에 '작성일'을 쓴다. 가장 확실한 신호.
    /답변일\s*[:：]/,
    /(?:reply|response)\s*(?:date|on)\s*[:：]/i,
    // ② 편지 형식 — 손님 리뷰는 "Dear ○○," 로 시작하지 않는다
    /^\s*Dear\s+[^\s,][^\n,]{0,40},/mi,
    /(?:sincerely|best|warm|kind)\s+regards/i,
    /sincerely\s+yours/i,
    // ③ 서명(직함) — 답글 끝에 붙는다
    /(?:general\s+manager|director\s+of\s+rooms|guest\s+relations|front\s+office|assistant\s+manager)/i,
    /(?:총지배인|지배인|매니저|호텔|리조트)\s*드림/,
    // ④ 한국어 상투구
    /리뷰를?\s*남겨\s*주셔서\s*감사/,
    /소중한\s*(?:의견|후기|리뷰)/,
    /이용해\s*주(?:셔서|시고)\s*(?:진심으로\s*)?감사/,
    /저희\s*(?:호텔|숙소|리조트)/,
    /다시\s*뵙기를\s*(?:기대|희망)/,
    // ⑤ 영어 상투구 — 사이에 단어가 끼어도 잡히게 (again, so much 등)
    /thank\s+you\b[^.]{0,40}\bfor\s+(?:choosing|staying|booking|sharing|your)/i,
    /we\s+(?:look\s+forward\s+to|hope\s+to|would\s+love\s+to)\s+\w*\s*(?:welcoming|seeing|hosting)\s+you/i,
    /we(?:'re| are)\s+(?:delighted|glad|pleased|thrilled)\s+to\s+(?:know|hear)/i,
  ];
  const isHotelReply = (t) => HOTEL_REPLY_RE.some((re) => re.test(t));

  // ── 카드 → 리뷰 ─────────────────────────────────────────────
  /** 컨테이너의 자식을 리뷰로 변환. 제외된 카드도 이유와 함께 돌려준다
   *  (inspect.js가 "왜 이 카드는 빠졌나"를 보여줄 수 있게). */
  function extractReviews(container, seen = new Set()) {
    const reviews = [];
    const rejected = [];

    [...container.children].forEach((card, i) => {
      const raw = (card.innerText || "").trim();
      const r = cardReason(card);
      if (!r.ok) { rejected.push({ index: i, why: r.why, preview: raw.slice(0, 60), node: card }); return; }

      const text = extractBody(card);
      if (text.length < MIN_BODY_LEN) {
        rejected.push({ index: i, why: `본문 추출 실패 (${text.length}자)`, preview: raw.slice(0, 60), node: card });
        return;
      }
      // 같은 리뷰가 두 번 잡히는 경우(가상 스크롤 재렌더 / 페이지 이동 실패) 제거
      const key = text.slice(0, 80);
      if (seen.has(key)) {
        rejected.push({ index: i, why: "중복 (이미 수집됨)", preview: text.slice(0, 60), node: card });
        return;
      }
      seen.add(key);

      const rt = findRating(card);
      reviews.push({
        text,
        date: findDate(raw),
        rating: rt?.rating ?? null,
        ratingScale: rt?.ratingScale ?? null,
        // 사업자가 쓴 답글은 소비자 경험이 아니다. 지우지 않고 표시만 해서 분석에서 거르게 한다
        ...(isHotelReply(text) ? { isHotelReply: true } : {}),
        _node: card, _index: i,
      });
    });

    // _node/_index는 UI 하이라이트 전용이라 JSON으로 나갈 땐 뺀다
    return { reviews: reviews.map(({ _node, _index, ...r }) => r), detailed: reviews, rejected, seen };
  }

  // ── 파일 저장 ────────────────────────────────────────────────
  // 브라우저는 보안상 임의 폴더에 파일을 쓸 수 없다. 방법은 셋뿐이다:
  //   1) File System Access API — 사용자가 폴더를 한 번 고르면 그 폴더엔 바로 쓸 수 있다
  //      (Chrome/Edge 지원). 숙소 20~30곳을 모을 땐 이게 유일하게 쓸 만하다.
  //   2) 다운로드 — 항상 브라우저 기본 다운로드 폴더로 간다. 나중에 옮겨야 한다.
  //   3) 클립보드 — 새 파일 만들어 붙여넣기. 매번 하기엔 번거롭다.
  // 1을 우선 쓰고, 안 되면 2로 떨어지고, 그것도 막히면 3이 남아 있다.
  let _dirHandle = null;

  /** data/ 폴더를 한 번 지정해두면 이후 수집은 자동 저장된다. */
  async function pickSaveFolder() {
    if (!window.showDirectoryPicker) {
      console.warn("[collect] 이 브라우저는 폴더 저장을 지원하지 않습니다 (Chrome/Edge에서 가능). 다운로드로 받으세요.");
      return null;
    }
    _dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    console.log(`%c[collect] ✅ 저장 폴더 지정됨: ${_dirHandle.name} — 이후 수집은 자동 저장됩니다`,
      "color:green;font-weight:bold");
    return _dirHandle;
  }

  async function writeToFolder(name, json) {
    if (!_dirHandle) return false;
    try {
      // 권한이 만료됐을 수 있어 매번 확인한다
      const perm = await _dirHandle.queryPermission?.({ mode: "readwrite" });
      if (perm !== "granted") {
        const asked = await _dirHandle.requestPermission?.({ mode: "readwrite" });
        if (asked !== "granted") return false;
      }
      const fh = await _dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(json);
      await w.close();
      return true;
    } catch (e) {
      console.warn("[collect] 폴더 저장 실패, 다운로드로 대체합니다:", e?.message || e);
      return false;
    }
  }

  function downloadJson(name, json) {
    try {
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 1000);
      return true;
    } catch { return false; }
  }

  /** 결과를 저장한다. 폴더 → 다운로드 → 클립보드 순으로 시도하고 어디에 저장됐는지 알린다. */
  async function saveResult(result, fileName) {
    const name = fileName || `${result.site}-${result.listingId}.json`;
    const json = JSON.stringify(result, null, 2);

    if (await writeToFolder(name, json)) {
      console.log(`%c[collect] 💾 ${_dirHandle.name}/${name} 에 저장했습니다`, "color:green;font-weight:bold");
      return "folder";
    }
    if (downloadJson(name, json)) {
      console.log(`%c[collect] 💾 ${name} 다운로드됨 — data/ 폴더로 옮기세요`, "color:green;font-weight:bold");
      console.log("%c   매번 옮기기 번거로우면: await pickSaveFolder() 로 data/ 폴더를 한 번 지정하세요",
        "color:#0d9488");
      return "download";
    }
    try {
      copy(json); // DevTools 콘솔 전용
      console.log(`[collect] 클립보드에 복사됨 — data/${name} 으로 붙여넣어 저장하세요`);
      return "clipboard";
    } catch {
      console.log(`[collect] copy(JSON.stringify(__reviews)) 로 복사해서 data/${name} 에 저장하세요`);
      return "manual";
    }
  }

  // ── 지켜보기 모드 — 페이지는 사람이 넘긴다 ───────────────────
  // 자동 페이지 넘김은 사이트가 목록을 갈아끼우는 방식에 계속 걸려 넘어졌다.
  // 이 모드는 **넘기는 걸 아예 안 한다.** 화면이 바뀔 때마다 보이는 리뷰를 담을 뿐이라
  // 사람이 직접 다음 페이지를 누르면 그대로 쌓인다. 깨질 구석이 없다.
  let _watch = null;

  function watchReviews() {
    if (_watch) { console.log("[watch] 이미 켜져 있습니다. 끄려면 saveWatched()"); return; }

    const seen = new Set();
    const all = [];
    let lastCount = -1;

    const capture = () => {
      const c = findReviewContainer();
      if (!c) return;
      const before = all.length;
      const { reviews } = extractReviews(c, seen);
      all.push(...reviews);
      if (all.length !== before) {
        console.log(`%c[watch] +${all.length - before}건 · 누적 ${all.length}건`, "color:#0d9488");
      }
      lastCount = all.length;
    };

    capture();
    const obs = new MutationObserver(() => {
      clearTimeout(_watch.timer);
      _watch.timer = setTimeout(capture, 400); // 렌더가 끝난 뒤에 한 번만
    });
    obs.observe(document.body, { childList: true, subtree: true });

    _watch = { obs, seen, all, timer: null };
    console.log("%c[watch] ✅ 켜졌습니다 — 이제 직접 페이지를 넘기세요. 보이는 리뷰가 자동으로 쌓입니다.",
      "color:green;font-weight:bold");
    console.log("   다 모았으면:  await saveWatched()");
    return _watch;
  }

  async function saveWatched() {
    if (!_watch) { console.warn("[watch] 켜져 있지 않습니다. watchReviews() 먼저 실행하세요."); return null; }
    clearTimeout(_watch.timer);
    _watch.obs.disconnect();
    const reviews = _watch.all;
    _watch = null;

    const guest = reviews.filter((r) => !r.isHotelReply);
    const result = {
      site: siteOf(),
      listingId: listingIdOf(),
      listingName: listingNameOf(),
      url: location.href,
      collectedAt: new Date().toISOString(),
      collectorVersion: VERSION,
      collectorVersion: VERSION,
      mode: "watch",
      official: collectOfficialClaims(),
      reviewCount: reviews.length,
      guestReviewCount: guest.length,
      reviews,
    };
    window.__reviews = result;
    console.log(`%c[watch] ✅ ${reviews.length}건 (실제 리뷰 ${guest.length}건)`,
      "color:green;font-weight:bold");
    await saveResult(result);
    return result;
  }

  // ── 정찰 모드 (1-1 단계) ─────────────────────────────────────
  function probe() {
    const openBtn = findOpenButton();
    const container = findReviewContainer();

    console.group("%c[probe] 리뷰 구조 정찰", "font-weight:bold");
    console.log("사이트:", siteOf(), "/ 숙소 id:", listingIdOf());
    console.log("리뷰 모달 버튼:", openBtn ? `"${(openBtn.innerText || "").trim()}"` : "❌ 못 찾음");
    console.log("리뷰 컨테이너:", container || "❌ 못 찾음");

    if (container) {
      const scroller = scrollableAncestor(container);
      console.log("카드 수(현재 DOM):", container.children.length);
      console.log("스크롤 주체:", scroller || "window");
      const sample = [...container.children].slice(0, 3).map((c) => {
        const r = findRating(c);  // {rating, ratingScale} — 표에는 숫자만 보여준다
        return {
          본문: extractBody(c).slice(0, 60),
          날짜: findDate(c.innerText || ""),
          평점: r ? `${r.rating}/${r.ratingScale}` : null,
        };
      });
      console.table(sample);
      container.style.outline = "3px dashed red";
      console.log("→ 빨간 점선이 리뷰 리스트를 정확히 감쌌는지 화면에서 확인할 것");
    } else {
      // 컨테이너를 못 찾았을 때 왜 못 찾았는지 볼 수 있게 후보를 보여준다
      const cands = [...document.querySelectorAll("div,ul,ol,section")]
        .map((el) => ({ el, score: scoreContainer(el) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      console.log("점수 > 0 후보:", cands.length ? cands : "없음 — 리뷰가 아직 DOM에 없을 수 있음(모달을 먼저 열어볼 것)");
      console.log("%c→ 탈출구: Elements 탭에서 리뷰 목록을 감싸는 요소를 클릭한 뒤", "color:#c60");
      console.log("%c   await collectReviews({ container: $0 })", "color:#c60;font-weight:bold");
    }

    if (!openBtn) {
      // 버튼을 못 찾았을 때, 눌러볼 만한 것들을 직접 보여준다
      const maybe = [...document.querySelectorAll('button,a,[role="button"]')]
        .map((el) => ({ el, t: (el.innerText || "").trim() }))
        .filter((x) => x.t && x.t.length <= 20 && /모두|전체|더\s*보기|all/i.test(x.t))
        .slice(0, 10);
      if (maybe.length) {
        console.log("눌러볼 만한 버튼 후보:", maybe.map((m) => m.t));
        console.log("%c→ 화면에서 직접 리뷰 모달을 연 뒤 await collectReviews({ skipModal: true })", "color:#c60");
      }
    }
    console.log("공식 표기(페이지 전체에서 발견):", collectOfficialClaims());
    console.groupEnd();

    return { openBtn, container };
  }

  // ── 본 수집 ──────────────────────────────────────────────────
  async function collectReviews(opts = {}) {
    const { skipModal = false, maxScrolls = 120, container: forced = null } = opts;

    if (!skipModal && !forced) {
      const btn = findOpenButton();
      if (btn) {
        console.log(`[collect] 리뷰 모달 열기: "${(btn.innerText || "").trim()}"`);
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await wait(1200);
      } else {
        console.log("[collect] 모달 버튼을 못 찾음 — 현재 화면에서 바로 수집을 시도한다");
      }
    }

    // forced: Elements 탭에서 고른 요소($0)를 직접 넘길 수 있는 탈출구.
    // 휴리스틱이 실패하는 사이트에서도 수집은 계속할 수 있어야 한다.
    let container = forced || findReviewContainer();
    if (!container) {
      console.error("[collect] 리뷰 컨테이너를 못 찾았습니다.");
      console.log("  1) collectReviews.probe() 로 후보를 확인하거나");
      console.log("  2) Elements 탭에서 리뷰 목록을 클릭하고 await collectReviews({ container: $0 })");
      return null;
    }
    if (forced) console.log("[collect] 지정된 컨테이너 사용:", forced);

    // 정책은 리뷰보다 먼저 — 모달을 열었다 닫으므로 리뷰 목록 상태를 건드리지 않게.
    // skipPolicy로 끌 수 있다(정책만 따로 받고 싶을 때).
    let policy = null;
    if (opts.skipPolicy !== true) {
      console.log("[collect] 취소·환불 정책 수집 중…");
      try {
        policy = await collectPolicy();
        console.log(`[collect] 정책 문장 ${policy.cancellation.length}건`
          + (policy.freeCancelUntil ? ` · 무료취소 ${policy.freeCancelUntil}까지` : ""));
      } catch (e) {
        console.warn("[collect] 정책 수집 실패(리뷰 수집은 계속):", e?.message || e);
      }
      // 모달을 닫으면 리스트가 다시 그려질 수 있어 컨테이너를 재확보
      if (!forced) container = findReviewContainer() || container;
    }

    console.log(`[collect] 스크롤 시작 (현재 ${container.children.length}개)`);
    await autoScroll(container, { maxScrolls });

    // 스크롤 중 리스트가 통째로 교체되는 사이트가 있어 컨테이너를 다시 잡는다.
    // 단 사용자가 직접 지정한 경우엔 그 선택을 존중한다.
    if (!forced) container = findReviewContainer() || container;

    // 스크롤로 안 늘어나는 사이트(아고다: 한 페이지 5개)는 '다음' 버튼을 눌러가며 모은다
    const paged = await collectAllPages(container, {
      maxPages: opts.maxPages ?? 60,
      onProgress: (p, n) => console.log(`[collect]   ${p}페이지 · 누적 ${n}건`),
    });
    const reviews = paged.reviews;
    console.log(`[collect] 페이지 ${paged.pages}개 · 종료 사유: ${paged.stopReason}`);
    if (paged.stopReason.startsWith("maxPages")) {
      console.log(`%c[collect] ⚠️ 리뷰가 더 있습니다 — 더 모으려면 maxPages를 올리세요`
        + ` (예: await collectReviews({ maxPages: ${paged.pages * 2} }))`, "color:#c60");
    }

    const guest = reviews.filter((r) => !r.isHotelReply);
    const replies = reviews.length - guest.length;
    if (replies) console.log(`[collect] 호텔 답글 ${replies}건은 표시해 뒀습니다(분석에서 제외됨)`);

    const result = {
      site: siteOf(),
      listingId: listingIdOf(),
      listingName: listingNameOf(),
      url: location.href,
      collectedAt: new Date().toISOString(),
      collectorVersion: VERSION,
      official: collectOfficialClaims(),
      policy,
      pages: paged.pages,
      reviewCount: reviews.length,
      guestReviewCount: guest.length,
      reviews,
    };

    window.__reviews = result;
    console.log(`%c[collect] ✅ ${reviews.length}건 수집 (실제 리뷰 ${guest.length}건)`,
      "color:green;font-weight:bold");
    await saveResult(result);
    console.table(reviews.slice(0, 5).map((r) => ({
      날짜: r.date, 평점: r.rating, 본문: r.text.slice(0, 50),
    })));

    return result;
  }

  collectReviews.probe = probe;

  // inspect.js(시각화 UI)가 같은 판정 로직을 그대로 쓰도록 내부 함수를 열어둔다.
  // UI가 로직을 복사해 가면 둘이 어긋나서, 화면에 보이는 근거와 실제 수집 결과가
  // 달라진다 — 그게 제일 나쁜 경우라 단일 출처를 유지한다.
  collectReviews._ = {
    scoreDetail, rankCandidates, cardReason, extractReviews,
    extractBody, findDate, findRating, findReviewContainer,
    findOpenButton, scrollableAncestor, collectOfficialClaims,
    autoScroll, expandAll, siteOf, listingIdOf, listingNameOf,
    collectAllPages, findNextButton, collectPolicy, isHotelReply,
    reviewnessOf, visibleModals, closeModal, closeStrayModals,
    saveResult, downloadJson, scrapePolicyText, watchReviews, saveWatched, pageSignature,
    collectRoomPolicies, cardOfPolicy, roomNameOf, collectFees, collectNotices,
    isPolicySentence: (t) => POLICY_SENT_RE.test(t),
    consts: { MIN_CARDS, MIN_BODY_LEN, MAX_BODY_LEN },
  };

  collectReviews.version = VERSION;

  window.collectReviews = collectReviews;
  // 페이지 전체에서 정책 문장만 (객실 구분 없음)
  window.collectPolicy = collectPolicy;
  // **객실/요금제별** 정책 — 팀 제출 형식이 요구하는 것. 리뷰와 무관하게 단독 실행 가능
  window.collectPolicies = collectPolicies;
  // 자동 넘김 없이, 사람이 페이지를 넘기는 동안 보이는 리뷰를 쌓는다
  window.watchReviews = watchReviews;
  window.saveWatched = saveWatched;
  // data/ 폴더를 한 번 지정해두면 이후 수집이 자동 저장된다
  window.pickSaveFolder = pickSaveFolder;

  console.log(`%c✅ collect-reviews 준비됨  [버전 ${VERSION}]`, "color:green;font-weight:bold");
  console.log("%c   ↑ 이 버전이 안 바뀌었으면 옛 코드가 도는 겁니다. 새로고침 후 다시 붙여넣으세요.",
    "color:#888");
  console.log("   저장폴더:  await pickSaveFolder()   ← 먼저 data/ 폴더를 지정하면 자동 저장됩니다");
  console.log("%c   약관수집:  await collectPolicies()  ← [객실 상품 보기]와 [정책] 탭에서 각각 한 번씩",
    "color:#0d9488;font-weight:bold");
  console.log("   리뷰수집:  await collectReviews({ maxPages: 40 })   ← 자동으로 페이지를 넘김");
  console.log("%c   리뷰수집(수동): watchReviews() → 직접 페이지 넘기기 → await saveWatched()",
    "color:#0d9488;font-weight:bold");
  console.log("%c              ↑ 자동 넘김이 자꾸 멈추면 이걸 쓰세요. 깨질 구석이 없습니다.", "color:#888");
  console.log("   리뷰정찰:  collectReviews.probe()");
})();
