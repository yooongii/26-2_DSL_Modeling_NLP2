/**
 * 페이지에서 리뷰를 **사용자 조작 없이** 모은다.
 *
 * `labeling/collect-reviews.js` 의 구조 휴리스틱을 포팅하되, 목적이 다르다.
 * 그쪽은 개발자가 콘솔에서 수동 실행하는 수집기라 스크롤·모달을 마음껏 조작해도 된다.
 * 이쪽은 **사용자가 보고 있는 화면 위에서** 도는 확장이라 화면이 흔들리면 안 된다.
 *
 * 그래서 지킨 두 가지:
 *   1. `scrollIntoView` / `window.scrollTo` 를 절대 쓰지 않는다.
 *      lazy load 가 필요하면 **컨테이너 자신의 scrollTop** 만 움직이고 원위치시킨다.
 *   2. 모달을 열어야 할 때는 열되 **눈에 안 보이게 억제**하고, 끝나면 닫고 스크롤을 복원한다.
 *
 * 그리고 단계마다 결과를 흘려보낸다(onProgress). 첫 화면은 즉시 뜨고,
 * 뒤에서 더 모이는 대로 숫자가 올라간다 — 사용자를 기다리게 하지 않기 위함이다.
 */
import type { Review } from "./types";
import { isHotelReply } from "./rules";
import { extractClaims } from "./pageClaims";

// ── 날짜 / 평점 인식 (collect-reviews.js 와 동일) ──────────────────────
const DATE_PATTERNS = [
  /\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?/,
  /\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}/,
  /\d{1,2}\s*월\s*\d{4}/,
  /\d+\s*(?:일|주|개월|달|년)\s*전/,
  /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}/i,
  /\d+\s+(?:days?|weeks?|months?|years?)\s+ago/i,
];
const hasDate = (t: string) => DATE_PATTERNS.some((re) => re.test(t));
const findDate = (t: string): string | null => {
  for (const re of DATE_PATTERNS) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  return null;
};

/** 아고다는 10점, 에어비앤비는 5점. 척도를 같이 남겨야 나중에 정규화할 수 있다. */
const RATING_PATTERNS: [RegExp, number | null][] = [
  [/별점\s*([\d.]+)\s*점/, null],
  [/([\d.]+)\s*(?:점|점\s*만점에|\/\s*10|out of 10)/i, 10],
  [/([\d.]+)\s*(?:\/\s*5|out of 5|stars?)/i, 5],
  [/rating[:\s]+([\d.]+)/i, null],
];

function findRating(el: HTMLElement): { value: number; scale: number } | null {
  const t = (el.innerText || "").slice(0, 400);
  for (const [re, scale] of RATING_PATTERNS) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    const v = parseFloat(m[1]);
    if (!Number.isFinite(v)) continue;
    const s = scale ?? (v > 5 ? 10 : 5);
    if (v < 0 || v > s) continue;
    return { value: v, scale: s };
  }
  return null;
}

const MIN_BODY_LEN = 15;
const MAX_BODY_LEN = 4000;
const MIN_CARDS = 3;

function ownText(el: Element): string {
  let s = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.nodeValue ?? "";
  return s.trim();
}

/** 카드에서 본문을 뽑는다. 호텔 답글이 손님 리뷰보다 길어 본문으로 뽑히는 것을 막는다. */
function extractBody(card: HTMLElement): string {
  let best = "";
  for (const n of Array.from(card.querySelectorAll("*"))) {
    const raw = n.children.length === 0 ? (n.textContent ?? "") : ownText(n);
    const t = raw.trim().replace(/\s+/g, " ");
    if (t.length > MAX_BODY_LEN) continue;
    if (isHotelReply(t)) continue;
    if (t.length > best.length) best = t;
  }
  if (best.length < MIN_BODY_LEN) {
    best = (card.innerText || "").trim().replace(/\s+/g, " ").slice(0, MAX_BODY_LEN);
  }
  return best;
}

const PRICE_RE = /₩|\$|\d{1,3}(?:,\d{3})+\s*원?/;
const CTA_RE =
  /예약하기|지금\s*예약|객실\s*(?:보기|선택)|선택하기|장바구니|담기|book now|select room|reserve now/i;

/** 자식이 리뷰처럼 생겼는지 — 평점·산문은 가점, 가격·예약버튼은 감점. */
function reviewnessOf(kids: HTMLElement[]): number {
  let rating = 0, prose = 0, price = 0, cta = 0;
  for (const k of kids) {
    const t = (k.innerText || "").trim();
    if (findRating(k)) rating++;
    if (/[.!?。]/.test(t) || t.length >= 80) prose++;
    if (PRICE_RE.test(t)) price++;
    if (CTA_RE.test(t)) cta++;
  }
  const n = Math.max(1, kids.length);
  return (rating / n) * 2 + (prose / n) * 2 - (price / n) * 1.5 - (cta / n) * 2;
}

function looksLikeCard(node: HTMLElement): boolean {
  const t = (node.innerText || "").trim();
  if (t.length < MIN_BODY_LEN || t.length > MAX_BODY_LEN) return false;
  return hasDate(t);
}

interface Candidate {
  el: HTMLElement;
  ok: number;
  reviewness: number;
  depth: number;
}

function depthOf(el: HTMLElement): number {
  let d = 0;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) d++;
  return d;
}

function scoreContainer(el: HTMLElement): Candidate | null {
  const kids = Array.from(el.children) as HTMLElement[];
  if (kids.length < MIN_CARDS) return null;
  const ok = kids.filter(looksLikeCard).length;
  if (ok < MIN_CARDS || ok < kids.length / 2) return null;
  return { el, ok, reviewness: reviewnessOf(kids), depth: depthOf(el) };
}

/**
 * 리뷰 목록을 찾는다. 선택자를 하드코딩하지 않는 이유는 사이트마다 다르고 수시로 바뀌기 때문.
 * **개수가 아니라 리뷰다움으로 고른다** — 개수로 고르면 항목이 더 많은 객실 목록이 이긴다
 * (객실 카드에도 날짜(무료취소 기한)와 긴 설명이 있어 '리뷰 모양'으로 채점된다).
 */
/** 카드가 왜 채택/탈락했는지. 수집 수가 화면과 안 맞을 때 원인을 본다. */
export function explainCards(container: HTMLElement) {
  return (Array.from(container.children) as HTMLElement[]).map((card, i) => {
    const t = (card.innerText || "").trim();
    const body = extractBody(card);
    return {
      i,
      카드길이: t.length,
      날짜: hasDate(t),
      본문길이: body.length,
      호텔답글: isHotelReply(body),
      채택: looksLikeCard(card) && body.length >= MIN_BODY_LEN,
      본문앞: body.slice(0, 40),
    };
  });
}

/** '다음' 버튼이 컨테이너에서 몇 단계 위에 있는지. searchScopeFor 의 maxUp 을 정하는 근거. */
export function explainPagination(container: HTMLElement) {
  const NEXT = /^\s*(?:다음|다음\s*페이지|next(?:\s*page)?|›|»|>|＞|⟩|→|▶|▷)\s*$/i;
  const all = Array.from(document.querySelectorAll<HTMLElement>('button,a,[role="button"],[aria-label]'));
  const hits = all.filter((el) => {
    const t = (el.innerText || "").trim();
    const label = el.getAttribute("aria-label") ?? "";
    return NEXT.test(t) || (!!label && /다음\s*(?:페이지)?|next\s*(?:page)?/i.test(label) && t.length <= 6);
  });
  const levelOf = (el: Element) => {
    let n: HTMLElement | null = container;
    for (let i = 0; i < 40 && n; i++, n = n.parentElement) if (n.contains(el)) return i;
    return -1;
  };
  return {
    현재_findNextButton: findNextButton(container) ? "찾음" : "못 찾음",
    후보수: hits.length,
    후보: hits.slice(0, 8).map((el) => ({
      글자: (el.innerText || "").trim().slice(0, 12),
      aria: el.getAttribute("aria-label"),
      몇단계위: levelOf(el),
      클릭가능: isClickable(el),
    })),
    숫자2버튼: Array.from(document.querySelectorAll<HTMLElement>('button,a,[role="button"]'))
      .filter((e) => (e.innerText || "").trim() === "2")
      .map((e) => ({ 몇단계위: levelOf(e), 클릭가능: isClickable(e) })),
  };
}

/** 후보 랭킹 전체를 돌려준다. 왜 그걸 골랐는지 사람이 봐야 휴리스틱을 고칠 수 있다. */
export function rankContainers(root: ParentNode = document): Candidate[] {
  const cands: Candidate[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("ul,ol,div,section"))) {
    const c = scoreContainer(el);
    if (c) cands.push(c);
  }
  cands.sort((a, b) => b.reviewness - a.reviewness || b.ok - a.ok || b.depth - a.depth);
  return cands;
}

export function findReviewContainer(root: ParentNode = document): HTMLElement | null {
  const cands: Candidate[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("ul,ol,div,section"))) {
    const c = scoreContainer(el);
    if (c) cands.push(c);
  }
  cands.sort((a, b) => b.reviewness - a.reviewness || b.ok - a.ok || b.depth - a.depth);
  return cands[0]?.el ?? null;
}

function extractFrom(container: HTMLElement): Review[] {
  const out: Review[] = [];
  const kids = Array.from(container.children) as HTMLElement[];
  kids.forEach((card, i) => {
    if (!looksLikeCard(card)) return;
    const text = extractBody(card);
    if (text.length < MIN_BODY_LEN) return;
    const r = findRating(card);
    out.push({
      index: i,
      text,
      date: findDate((card.innerText || "").trim()),
      rating: r?.value ?? null,
      ratingScale: r?.scale ?? null,
      isHotelReply: isHotelReply(text),
    });
  });
  return out;
}

// ── 공식 표기 수집 ──────────────────────────────────────────────────────
// NLI 층(Page-Review Consistency)의 premise가 된다. **두 방향을 다 모은다.**
//
//   ① "무료"라고 써놓은 것  → 리뷰가 유료라고 하면 표기와 다름(가장 강한 신호)
//   ② "유료"라고 밝힌 것    → 리뷰가 같은 말을 해도 **숨은 비용이 아니다**
//
// ②가 없으면 "연박 청소(유료서비스) 20,000원" 처럼 페이지에 버젓이 적힌 비용까지
// "화면 밖에서 낼 수 있는 비용"으로 올라간다 — 사용자가 이미 아는 것을 경고하는 셈이다.

// 정규식·표는 pageClaims.ts 에 있다 — analyze.ts 의 대조와 같은 표를 써야 하기 때문이다.

export function collectOfficialClaims(): string[] {
  const text = document.body?.innerText ?? "";
  // 두 종류를 함께 담는다. 어느 쪽인지는 analyze.ts 가 문자열을 보고 가른다
  // (수집기는 페이지에서 읽는 일만 하고, 판정은 분석 층에 모아둔다).
  return extractClaims(text);
}

// ── 비파괴 확장 ─────────────────────────────────────────────────────────
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 카드 안의 "더 보기"를 눌러 잘린 본문을 편다.
 *  이게 없으면 `"…주차비는"` 처럼 **정작 필요한 뒷부분이 잘린 채** 수집된다. */
const MORE_RE = /^\s*(?:더\s*보기|더보기|자세히\s*보기|read\s*more|show\s*more)\s*$/i;

async function expandTruncated(container: HTMLElement): Promise<number> {
  const btns = Array.from(
    container.querySelectorAll<HTMLElement>("button,a,span[role='button']"),
  ).filter((b) => MORE_RE.test(b.innerText || ""));
  for (const b of btns) {
    // click() 은 스크롤을 유발하지 않는다. dispatchEvent 도 마찬가지.
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  if (btns.length) await wait(200);
  return btns.length;
}

/** 컨테이너를 감싸는 스크롤 가능한 조상 (없으면 null) */
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    const ov = getComputedStyle(n).overflowY;
    if ((ov === "auto" || ov === "scroll") && n.scrollHeight > n.clientHeight + 40) return n;
  }
  return null;
}

/**
 * lazy load 를 유발하되 **사용자 화면은 그대로 둔다.**
 * 컨테이너 자신의 스크롤 박스만 내렸다가 원위치시킨다. 그런 박스가 없으면 아무것도 안 한다
 * (window 를 움직이면 사용자가 보던 위치가 튄다 — 그건 하지 않기로 한 것).
 */
async function nudgeLazyLoad(container: HTMLElement, rounds = 6): Promise<void> {
  const box = scrollableAncestor(container);
  if (!box) return;
  const original = box.scrollTop;
  let last = container.children.length;
  for (let i = 0; i < rounds; i++) {
    box.scrollTop = box.scrollHeight;
    await wait(350);
    const now = container.children.length;
    if (now === last) break;
    last = now;
  }
  box.scrollTop = original; // 반드시 원위치
}

// ── 리뷰 모달 ───────────────────────────────────────────────────────────
// 아고다 숙소 페이지에 **보이는 리뷰는 요약 캐러셀 5건뿐**이다(실측 2026-08-30).
// 진짜 목록과 페이지네이션은 '모두 보기' 모달 안에만 있다. 모달을 안 열면 영원히 5건이다.
//
// 그래서 열되, 사용자 화면에 **안 보이게 억제**하고 끝나면 닫는다. 억제 없이 열면
// 사용자가 보던 화면을 우리가 덮어버린다 — 그건 하지 않기로 한 것.
const OPEN_SPECIFIC_RE =
  /후기\s*[\d,]*\s*개?\s*(?:모두|전체)|리뷰\s*[\d,]*\s*개?\s*(?:모두|전체)|모든\s*(?:후기|리뷰)|(?:후기|리뷰)\s*(?:전체|더\s*보기)|(?:show|read|see)\s+all.*reviews?/i;
const OPEN_GENERIC_RE =
  /^\s*(?:모두\s*보기|전체\s*보기|더\s*보기|see\s+all|show\s+all|view\s+all)\s*$/i;
const REVIEW_CONTEXT_RE = /이용후기|후기|리뷰|평점|reviews?\b/i;
const CONTEXT_MAX_TEXT = 1200;

/**
 * 조상 몇 단계 안에 리뷰 맥락이 있는가 — '모두 보기' 같은 범용 문구의 오채택 방지.
 * body까지 올라가면 안 된다. 페이지 어딘가에 '이용후기'가 있으면 모든 버튼이 통과해
 * 검사가 무의미해진다(사진 갤러리의 '모두 보기'가 리뷰 버튼으로 잡히던 실제 버그).
 */
function nearReviewContext(el: HTMLElement, levels = 4): boolean {
  let n: HTMLElement | null = el;
  for (let i = 0; i < levels; i++) {
    n = n?.parentElement ?? null;
    if (!n || n === document.body || n === document.documentElement) return false;
    const t = n.innerText || "";
    if (t.length > CONTEXT_MAX_TEXT) return false;
    if (REVIEW_CONTEXT_RE.test(t)) return true;
  }
  return false;
}

export function findOpenButton(): HTMLElement | null {
  const clickable = Array.from(
    document.querySelectorAll<HTMLElement>('button,a,[role="button"],[role="link"]'),
  );
  // 1순위: 문구 자체에 '후기/리뷰'가 든 버튼
  for (const el of clickable) {
    const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
    if (!t || t.length > 40) continue;
    if (OPEN_SPECIFIC_RE.test(t)) return el;
  }
  // 2순위: '모두 보기'처럼 범용 문구 — 리뷰 섹션 안에 있을 때만
  for (const el of clickable) {
    const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
    if (!t || t.length > 20) continue;
    if (OPEN_GENERIC_RE.test(t) && nearReviewContext(el)) return el;
  }
  return null;
}

const HIDE_STYLE_ID = "__rvHideModal";

/** 모달을 화면에서 감춘다. 우리가 여는 동안 사용자에게 보이지 않게. */
function hideModals(): void {
  if (document.getElementById(HIDE_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = HIDE_STYLE_ID;
  // visibility 대신 opacity+pointer-events — display:none 이면 사이트가 렌더를 건너뛰어
  // 리뷰가 아예 안 그려질 수 있다. 레이아웃은 살리고 눈에만 안 보이게 한다.
  s.textContent = `[role="dialog"],[aria-modal="true"]{opacity:0!important;pointer-events:none!important}`;
  document.head.appendChild(s);
}

function unhideModals(): void {
  document.getElementById(HIDE_STYLE_ID)?.remove();
}

function findCloseButton(modal: HTMLElement): HTMLElement | null {
  const RE = /^\s*(?:닫기|close|×|✕|x)\s*$/i;
  for (const el of Array.from(modal.querySelectorAll<HTMLElement>('button,[role="button"]'))) {
    const t = (el.innerText || "").trim();
    const label = el.getAttribute("aria-label") ?? "";
    if (RE.test(t) || RE.test(label)) return el;
  }
  return null;
}

/**
 * 리뷰 모달을 조용히 연다. 성공하면 모달 루트를, 실패하면 null.
 * 실패해도 화면은 원래대로 되돌린다.
 */
async function openFullReviews(before: HTMLElement): Promise<HTMLElement | null> {
  const btn = findOpenButton();
  if (!btn) return null;

  const beforeSig = pageSignature(before);
  hideModals();                     // 모달로 뜨는 사이트를 대비 (아고다는 아니다)
  const scrollY = window.scrollY;
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  for (let i = 0; i < 16; i++) {
    await wait(250);

    // ① 모달로 뜨는 사이트
    const modal = document.querySelector<HTMLElement>('[role="dialog"],[aria-modal="true"]');
    if (modal && findReviewContainer(modal)) {
      if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
      return modal;
    }

    // ② 페이지가 리뷰 화면으로 바뀌는 사이트 (아고다 실측 2026-08-30)
    //    dialog 가 아예 안 생긴다. 대신 리뷰 목록이 교체되고 페이지네이션이 나타난다.
    const now = findReviewContainer(document);
    if (now && (now !== before || pageSignature(now) !== beforeSig || findNextButton(now))) {
      unhideModals();               // 모달이 아니므로 숨김을 풀어야 화면이 정상으로 보인다
      if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
      return document.body;         // 이 뒤로는 문서 전체에서 찾으면 된다
    }
  }

  unhideModals();
  if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
  return null;
}

async function closeReviewModal(modal: HTMLElement): Promise<void> {
  const scrollY = window.scrollY;
  const close = findCloseButton(modal);
  if (close) {
    close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  } else {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  await wait(400);
  unhideModals();
  if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
}

function openDialogs(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"],[aria-modal="true"]'),
  ).filter((d) => d.isConnected);
}

/**
 * 시작 시점에 없던 다이얼로그를 닫는다.
 *
 * 수집 중 누르는 버튼('더 보기', 페이지 번호)이 리뷰와 무관한 팝업을 열 수 있다.
 * 실측: '아동 정책' 모달이 열린 채 남아 사용자 화면을 덮었다. 우리가 연 것은 우리가 치운다.
 */
async function closeStrayDialogs(before: HTMLElement[]): Promise<void> {
  const stray = openDialogs().filter((d) => !before.includes(d));
  if (!stray.length) return;
  for (const d of stray) {
    const close = findCloseButton(d);
    if (close) close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(200);
  }
  unhideModals();
}

// ── 페이지네이션 ────────────────────────────────────────────────────────
// 아고다는 리뷰를 **페이지당 5건**만 보여준다(실측). 넘기지 않으면 영원히 5건이라
// 노출 기준(서로 다른 리뷰 2건)을 채울 표본 자체가 안 모인다.
const NEXT_RE = /^\s*(?:다음|다음\s*페이지|next(?:\s*page)?|›|»|>|＞|⟩|→|▶|▷)\s*$/i;
const NEXT_LABEL_RE = /다음\s*(?:페이지)?|next\s*(?:page)?/i;

// 사고 사례(2026-09): 이전엔 document 전체에서 후보를 찾은 뒤 container 근처인지
// "확인"만 했다(isNearContainer) — 그런데 리뷰 섹션이 없는 페이지(검색/캘린더 화면)에서
// 이전 페이지의 리뷰수집 루프가 SPA 라우팅 이후에도 백그라운드에서 계속 돌면서, 문서 전체
// 검색이 아고다 자체 달력의 "다음 달" 화살표나 날짜 숫자를 리뷰 페이지네이션 버튼으로
// 착각해 자동 클릭했다 — 체크인 날짜·인원수가 사용자 조작 없이 계속 넘어가는 사고로 이어짐.
// 그래서 이제 검색 자체를 container 의 조상 범위 안으로 제한한다(문서 전체를 보지 않음).
//
// 이 수정은 윤서가 번들(reviewtab.js)에 직접 넣어 v1.0.0/v1.0.1 로 배포·검증됐고,
// 빌드하면 덮여 사라지므로 여기 원본으로 옮겨 왔다(2026-09-22).
function searchScopeFor(container: HTMLElement, maxUp: number): HTMLElement {
  let scope: HTMLElement = container;
  for (let i = 0; i < maxUp && scope.parentElement; i++) scope = scope.parentElement;
  return scope;
}

function isClickable(el: Element): boolean {
  const e = el as HTMLElement & { disabled?: boolean };
  if (e.disabled || el.getAttribute("aria-disabled") === "true") return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 8 && r.height >= 8;
}

function findNextButton(container: HTMLElement): HTMLElement | null {
  const scope = searchScopeFor(container, 8);
  for (const el of Array.from(
    scope.querySelectorAll<HTMLElement>('button,a,[role="button"],[aria-label]'),
  )) {
    const t = (el.innerText || "").trim();
    const label = el.getAttribute("aria-label") ?? "";
    const hit = NEXT_RE.test(t) || (!!label && NEXT_LABEL_RE.test(label) && t.length <= 6);
    if (!hit || !isClickable(el)) continue;
    return el;
  }
  return null;
}

/** 화살표를 못 찾을 때의 폴백 — '1 2 3 …' 에서 번호 버튼을 직접 누른다. */
function findPageNumber(container: HTMLElement, no: number): HTMLElement | null {
  const scope = searchScopeFor(container, 10);
  for (const el of Array.from(
    scope.querySelectorAll<HTMLElement>('button,a,[role="button"]'),
  )) {
    if ((el.innerText || "").trim() !== String(no)) continue;
    if (!isClickable(el)) continue;
    return el;
  }
  return null;
}

/** 목록 상태를 한 문자열로. 첫 카드만 보면 렌더 도중에 '바뀌었다'고 오판한다. */
function pageSignature(container: HTMLElement): string {
  return Array.from(container.children)
    .slice(0, 5)
    .map((c) => ((c as HTMLElement).innerText || "").slice(0, 40))
    .join("|");
}

/**
 * 목록이 실제로 바뀔 때까지 기다리고 **바뀐(교체된) 컨테이너를 돌려준다.**
 *
 * 아고다는 페이지를 넘길 때 리뷰 목록 `<ol>` 을 통째로 갈아끼운다. 들고 있던 참조는
 * 화면에서 떨어져 나간 노드가 되고, 그 노드는 영원히 안 바뀌므로 조기 종료된다
 * (실측: 3~4페이지에서 매번 멈춘 진짜 원인).
 */
async function waitForPageChange(
  refind: () => HTMLElement | null,
  container: HTMLElement,
  before: string,
  tries = 20,
): Promise<HTMLElement | null> {
  for (let i = 0; i < tries; i++) {
    await wait(250);
    let c: HTMLElement | null = container;
    if (!c.isConnected || !c.children.length) {
      c = refind();
      if (!c) continue;
    }
    const now = pageSignature(c);
    if (now && now !== before) {
      await wait(400); // 나머지 카드까지 다 그려지도록
      return c.isConnected ? c : (refind() ?? c);
    }
  }
  return null;
}

// ── 수집 본체 ───────────────────────────────────────────────────────────
export type CollectPhase =
  | "dom" | "expand" | "lazy" | "modal" | "page" | "restore" | "done" | "empty";

export interface CollectOptions {
  /** 단계마다 호출된다. 첫 화면을 즉시 그리기 위한 것 */
  onProgress?: (reviews: Review[], phase: CollectPhase) => void;
  /** 페이지를 떠나거나 사용자가 껐을 때 중단 */
  signal?: AbortSignal;
  /** 넘겨볼 리뷰 페이지 수. 아고다는 페이지당 5건이라 40이면 약 200건 */
  maxPages?: number;
  /** 전체 시간 예산(ms). 넘으면 거기까지만 쓴다 — 사용자를 무한정 기다리게 하지 않는다 */
  budgetMs?: number;
  /** 끝나고 1페이지로 되돌릴지. 사용자가 보던 상태를 복원한다 */
  restorePage?: boolean;
  /** 리뷰 모달을 열어서까지 모을지. 끄면 페이지에 보이는 것(아고다는 5건)만 */
  useModal?: boolean;
}

function dedupe(reviews: Review[]): Review[] {
  const seen = new Set<string>();
  const out: Review[] = [];
  for (const r of reviews) {
    const sig = r.text.slice(0, 80);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ ...r, index: out.length });
  }
  return out;
}

/**
 * 리뷰를 자동 수집한다. 사용자는 아무것도 누르지 않는다.
 *
 * 단계별로 결과를 흘려보내므로 패널은 1단계 결과(보통 수십 ms)로 즉시 그리고,
 * 2·3단계가 끝나면 숫자가 올라간다.
 */
export async function autoCollect(opts: CollectOptions = {}): Promise<Review[]> {
  const {
    onProgress,
    signal,
    maxPages = 40,
    budgetMs = 150_000,
    restorePage = true,
    useModal = true,
  } = opts;
  const started = Date.now();
  const overBudget = () => Date.now() - started > budgetMs;
  const emit = (rs: Review[], p: CollectPhase) => onProgress?.(rs, p);

  // 우리가 열지 않은 다이얼로그는 건드리지 않기 위해 시작 상태를 기억해둔다
  const dialogsAtStart = openDialogs();

  let container = findReviewContainer();
  if (!container) {
    emit([], "empty");
    return [];
  }

  // 모달 안에서 시작했으면 **그 모달 안에서만** 다시 찾는다. 배경 페이지에도 리뷰 목록
  // (상위 몇 건)이 있어서, 문서 전체에서 다시 찾으면 이미 수집한 그 목록으로 갈아타
  // 새 리뷰 0건 → 조기 종료된다.
  const modalRoot = container.closest<HTMLElement>('[role="dialog"],[aria-modal="true"]');
  const all: Review[] = [];
  const push = () => {
    all.push(...extractFrom(container!));
    return dedupe(all);
  };

  // 1단계 — 지금 DOM에 있는 것만. 즉시.
  let reviews = push();
  emit(reviews, "dom");
  if (signal?.aborted) return reviews;

  // 2단계 — 잘린 본문 펴기. 비용 문장이 잘려 있는 경우가 많다.
  await expandTruncated(container);
  if (signal?.aborted) return reviews;
  all.length = 0;
  reviews = push();
  emit(reviews, "expand");

  // 3단계 — 컨테이너 스크롤 박스만 흔들어 lazy load 유발 (무한스크롤형 사이트용)
  await nudgeLazyLoad(container);
  if (signal?.aborted) return reviews;
  await expandTruncated(container);
  all.length = 0;
  reviews = push();
  emit(reviews, "lazy");

  // 4단계 — 리뷰 모달 열기.
  // 아고다 상세 페이지에 보이는 건 요약 캐러셀 5건뿐이고, 진짜 목록과 페이지네이션은
  // 모달 안에만 있다. 여기서 열지 못하면 5건에서 끝난다.
  let modal: HTMLElement | null = modalRoot;
  if (useModal && !modal) {
    modal = await openFullReviews(container);
    if (modal) {
      const inModal = findReviewContainer(modal);
      if (inModal) {
        container = inModal;
        await expandTruncated(container);
        await nudgeLazyLoad(container);
        reviews = push();
        emit(reviews, "modal");
      }
    }
  }

  // 모달을 열었으면 그 안에서만 다시 찾아야 한다 — 배경 페이지의 캐러셀로 갈아타면
  // 이미 수집한 5건이라 "새 리뷰 0건"으로 조기 종료된다.
  const activeRoot = () => (modal?.isConnected ? modal : document);
  const refindHere = (): HTMLElement | null => findReviewContainer(activeRoot());

  // 5단계 — 페이지 넘기기. 아고다는 페이지당 5건이라 여기가 실제 수집량을 결정한다.
  let page = 1;
  while (page < maxPages && !signal?.aborted && !overBudget()) {
    const before = pageSignature(container);
    const btn = findNextButton(container) ?? findPageNumber(container, page + 1);
    if (!btn) break; // 마지막 페이지이거나 페이지네이션이 없는 사이트

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const next = await waitForPageChange(refindHere, container, before);
    if (!next) break; // 내용이 안 바뀜 — 더 못 간다

    container = next;
    page += 1;
    await expandTruncated(container);
    reviews = push();
    emit(reviews, "page");
  }

  // 사용자가 보던 상태로 되돌린다. 리뷰 목록만 12페이지에 남겨두면 안 된다.
  if (restorePage && page > 1) {
    const first = findPageNumber(container, 1);
    if (first) {
      const before = pageSignature(container);
      first.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await waitForPageChange(refindHere, container, before, 8);
      emit(reviews, "restore");
    }
  }

  // 우리가 연 모달은 우리가 닫는다. 사용자가 열어둔 모달(modalRoot)은 건드리지 않는다.
  // 모달로 열린 경우만 닫는다. body 는 "페이지가 리뷰 화면으로 바뀐 것"이라 닫을 대상이 없다.
  if (modal && modal !== modalRoot && modal !== document.body) await closeReviewModal(modal);

  // 수집 중 클릭이 다른 모달을 열었을 수 있다 — '아동 정책' 팝업이 남는 사고가 실제로 났다.
  // 시작 시점에 없던 다이얼로그는 전부 우리 책임이므로 닫는다.
  await closeStrayDialogs(dialogsAtStart);

  emit(reviews, "done");
  return reviews;
}

/**
 * SPA 대응. 아고다는 숙소를 옮겨도 페이지를 새로 안 읽는 경로가 있어서
 * URL 변화와 DOM 교체를 같이 본다.
 * 반환값을 호출하면 감시를 끝낸다.
 */
export function watchPage(onChange: () => void): () => void {
  let lastUrl = location.href;
  let timer: number | undefined;

  const fire = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(onChange, 600); // 연속 변경을 한 번으로 묶는다
  };

  const check = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    fire();
  };

  const mo = new MutationObserver(check);
  mo.observe(document.body, { childList: true, subtree: true });
  const iv = window.setInterval(check, 1000);

  return () => {
    mo.disconnect();
    window.clearInterval(iv);
    window.clearTimeout(timer);
  };
}
