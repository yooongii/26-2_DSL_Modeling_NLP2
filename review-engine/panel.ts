/**
 * 탭 2 기본 렌더러.
 *
 * 팀원 UI 목업이 나오기 전까지 쓰는 것이고, 나온 뒤에도 그대로 꽂을 수 있게 만들었다.
 * 주어진 엘리먼트 **안에만** 그리고 바깥을 건드리지 않는다. 클래스는 전부 `rvx-` 접두사라
 * 어느 패널 안에 들어가도 스타일이 충돌하지 않는다.
 *
 * 표시에서 지킨 것:
 *  - **분모를 정직하게.** "45건 중 31건 분석 (한국어·영어)" — 언어 때문에 빠진 건 숨기지 않는다.
 *  - **숨긴 이유를 남긴다.** 노출 기준 미달 항목도 접어서 보여주고 왜 안 띄웠는지 적는다.
 *  - **지금이 규칙 층임을 밝힌다.** 하단에 어떤 층이 돌았는지 그대로 쓴다.
 */
import type { ClaimCandidate, ReviewInsights, RiskItem } from "./types";

const FEE_LABEL: Record<string, string> = {
  주차: "주차 유료",
  리조트피: "리조트피",
  보증금: "보증금",
  도시세: "도시세·숙박세",
  청소비: "청소비 별도",
  조식: "조식 별도결제",
  인원추가: "인원 추가요금",
  세금수수료: "세금·수수료",
  기타현장결제: "현장 결제",
  시설이용: "시설 이용료",
  미분류: "추가비용 언급",   // 모델이 유형까지는 못 가름 (Stage 2 미학습)
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const STYLE_ID = "rvx-style";
// 스타일 내용의 도장. 이 파일의 CSS 를 고치면 함께 올린다 —
// 아래 ensureStyle 이 도장이 다르면 옛 <style> 을 갈아끼운다.
// (확장을 새로고침해도 페이지에 남은 <style> 은 그대로라, 새 마크업에 옛 CSS 가
//  걸려 화면이 깨지는 일이 실제로 있었다 — briefing.js 의 CC_STYLE_REV 와 같은 이유.)
const STYLE_REV = "2026-09-23-financeui";

const CSS = `
/* 브리핑 카드(briefing.js)와 같은 톤. 색·모서리·여백을 그쪽 토큰에 맞춘다 —
   같은 카드 안의 두 탭이 서로 다른 디자인으로 보이면 안 된다. */
.rvx { font-size: 12.5px; line-height: 1.6; color: #14171c; }
.rvx-head { margin-bottom: 14px; }
.rvx-title { display: none; }
.rvx-sub { font-size: 11.5px; color: #6b7381; margin: 0; line-height: 1.6; }
.rvx-sub b { color: #14171c; font-weight: 700; }

/* 숫자 타일 4개(수집/분석/비용신호/판정불가)와 막대·범례는 개발 중에는 유용했지만
   사용자에게는 의미가 옅고 카드 폭을 크게 먹어서 걷어냈다(위 한 줄 문장이 대신한다).
   되살리려면 renderInsights 의 마크업과 이 자리의 규칙을 같이 되돌려야 한다. */

/* 신호 블록 — 예약 요약 탭의 상태 블록과 같은 모양(연한 바탕 + 연한 칩).
   다만 초록/빨강이 아니라 황토색이다. 확정이 아니라 **추정**이라는 뜻. */
.rvx-sec {
  font-size: 11.5px; font-weight: 700; color: #6b7381;
  margin: 14px 0 8px; letter-spacing: 0;
}
.rvx-risk {
  border: 0; border-radius: 14px; padding: 14px 16px;
  margin-bottom: 8px; background: #fdf7ef;
}
.rvx-risk.conflict { background: #fdf7ef; }
.rvx-risk.hidden-item { background: #f7f8fa; opacity: 1; }
.rvx-risk-h { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-bottom: 6px; }
.rvx-risk-h b { margin-right: auto; font-size: 17px; font-weight: 800; letter-spacing: -.03em; }
.rvx-pill {
  font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 999px;
  background: #f2f4f7; color: #6b7381; white-space: nowrap;
}
.rvx-pill.warn { background: #f7e6ce; color: #8a5417; }
.rvx-pill.mute { background: #f2f4f7; color: #98a0ac; }
.rvx-why { font-size: 12px; color: #7a6a55; margin-top: 2px; line-height: 1.55; }
.rvx-ev { margin-top: 9px; padding-left: 10px; border-left: 2px solid #e4e7ec; }
.rvx-ev p { margin: 0 0 5px; font-size: 11.5px; color: #4d5560; line-height: 1.65; }
.rvx-ev p:last-child { margin-bottom: 0; }
.rvx-ev mark { background: #fdf0d9; padding: 0 1px; border-radius: 2px; font-weight: 600; }
.rvx-ev .cue { text-decoration: underline; text-decoration-color: #d9a441; text-underline-offset: 2px; }
.rvx-ev .neg { text-decoration: underline; text-decoration-color: #b8bec7; text-underline-offset: 2px; }

/* 신호 없음 — "없다"가 아니라 "못 찾았다"로 쓴다(단정 금지). */
.rvx-empty {
  text-align: center; padding: 18px 16px; margin-top: 14px;
  background: #f2faf6; border-radius: 14px;
  font-size: 16px; font-weight: 800; letter-spacing: -.03em; line-height: 1.4; color: #14171c;
}
.rvx-empty small { display: block; margin-top: 6px; font-size: 12px; font-weight: 500; color: #5c7367; letter-spacing: 0; }
.rvx-check {
  display: inline-grid; place-items: center; width: 34px; height: 34px;
  border-radius: 999px; background: #dcf0e5; margin-bottom: 10px;
}

/* 꼬리말 — 판정 층 같은 개발용 문자열은 사용자에게 보이지 않는다(아래 renderInsights 참고). */
.rvx-foot {
  margin-top: 14px; padding: 11px 13px; border-top: 0;
  background: #f7f8fa; border-radius: 10px;
  font-size: 11px; color: #6b7381; line-height: 1.6;
}
.rvx-foot b { color: #14171c; font-weight: 700; }
.rvx-foot .dim { color: #98a0ac; }
.rvx-spin { display: inline-block; width: 9px; height: 9px; border: 2px solid #e4e7ec; border-top-color: #1b7a52;
  border-radius: 50%; animation: rvx-rot .7s linear infinite; vertical-align: -1px; margin-right: 5px; }
@keyframes rvx-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rvx-spin { animation: none; } }
`;

/**
 * 스타일을 **엘리먼트가 실제로 속한 루트**에 넣는다.
 *
 * document.head 에 넣으면 Shadow DOM 안에서는 무시된다 — 스타일 경계를 넘지 못하기 때문.
 * 패널이 shadow 안에 있을 때 CSS가 통째로 안 먹어 글자만 세로로 쌓이는 사고가 실제로 났다.
 * getRootNode() 는 shadow 안이면 ShadowRoot 를, 아니면 Document 를 준다.
 */
function ensureStyle(el: HTMLElement) {
  const root = el.getRootNode?.() as (Node & ParentNode) | undefined;
  // `instanceof ShadowRoot` 를 쓰면 가짜 DOM(linkedom)에 그 전역이 없어 터진다.
  // DOCUMENT_FRAGMENT_NODE(11) + host 로 판별하면 어느 환경에서든 동작한다.
  const isShadow = !!root && root.nodeType === 11 && "host" in root;
  const host: ParentNode =
    (isShadow ? root : el.ownerDocument.head) ?? el.ownerDocument.documentElement;
  const prev = (host as Element).querySelector?.(`#${STYLE_ID}`) as HTMLElement | null;
  if (prev && prev.dataset.rev === STYLE_REV) return;
  prev?.remove();
  const s = el.ownerDocument.createElement("style");
  s.id = STYLE_ID;
  s.dataset.rev = STYLE_REV;
  s.textContent = CSS;
  host.appendChild(s);
}

/**
 * 문장 안의 키워드와 단서를 하이라이트한다.
 * 문자열 치환이 아니라 **위치를 모아 겹치지 않게 자른다** — 치환을 쓰면 이미 넣은 태그
 * 안쪽을 또 치환해서 마크업이 깨진다(analyze.py 리포트에서 겪은 것과 같은 문제).
 */
function highlight(c: ClaimCandidate): string {
  type Span = { start: number; end: number; cls: string };
  const spans: Span[] = [{ start: c.keywordPos, end: c.keywordPos + c.keyword.length, cls: "kw" }];

  for (const [cues, cls] of [[c.costCues, "cue"], [c.negCues, "neg"]] as const) {
    for (const cue of cues) {
      let from = 0;
      for (;;) {
        const i = c.sentence.indexOf(cue, from);
        if (i < 0) break;
        spans.push({ start: i, end: i + cue.length, cls });
        from = i + cue.length;
      }
    }
  }

  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: string[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue; // 겹치면 앞선 것만 살린다
    out.push(esc(c.sentence.slice(pos, s.start)));
    const inner = esc(c.sentence.slice(s.start, s.end));
    out.push(s.cls === "kw" ? `<mark>${inner}</mark>` : `<span class="${s.cls}">${inner}</span>`);
    pos = s.end;
  }
  out.push(esc(c.sentence.slice(pos)));
  return out.join("");
}

/** 요금제마다 다른 조건 — 페이지 어딘가의 "조식 포함"은 다른 요금제 것일 수 있어 "표기와 다름"이라 단정하지 않는다 */
const RATE_LEVEL: ReadonlyMap<string, string> = new Map([["조식", "조식"], ["세금수수료", "세금·수수료"]]);

function riskRow(r: RiskItem): string {
  const label = FEE_LABEL[r.feeType] ?? r.feeType;
  const rateNoun = r.pageConflict ? RATE_LEVEL.get(r.feeType) : undefined;
  const rateLevel = rateNoun !== undefined;
  const cls = ["rvx-risk", r.pageConflict && !rateLevel ? "conflict" : "", r.shown ? "" : "hidden-item"]
    .filter(Boolean)
    .join(" ");
  const conflict = !r.pageConflict
    ? ""
    : rateLevel
      ? `<div class="rvx-why">이 숙소엔 <b>“${esc(r.pageConflict)}”</b> 요금제도 있어요. 선택한 요금제의 ${esc(rateNoun)} 조건을 확인하세요</div>`
      : `<div class="rvx-why">⚠ 페이지에는 <b>“${esc(r.pageConflict)}”</b>라고 표기돼 있어요</div>`;
  // 반대 방향 — 페이지가 이미 유료라고 밝힌 경우. 경고 톤을 쓰지 않는다.
  const disclosed = r.pageDisclosed
    ? `<div class="rvx-why">페이지에 <b>“${esc(r.pageDisclosed)}”</b>로 안내돼 있어요</div>`
    : "";
  // 근거는 서로 다른 리뷰에서 최대 3개까지
  const seen = new Set<number>();
  const ev = r.evidence
    .filter((c) => !seen.has(c.reviewIndex) && seen.add(c.reviewIndex))
    .slice(0, 3)
    .map((c) => `<p>${highlight(c)}</p>`)
    .join("");

  return `
<div class="${cls}">
  <div class="rvx-risk-h">
    <b>${esc(label)}</b>
    <span class="rvx-pill ${r.shown ? "" : "mute"}">리뷰 ${r.reviewCount}건</span>
    ${r.recentCount > 0 ? `<span class="rvx-pill mute">최근 1년 ${r.recentCount}건</span>` : ""}
    ${r.pageConflict ? (rateLevel ? '<span class="rvx-pill mute">요금제 확인</span>' : '<span class="rvx-pill warn">표기와 다름</span>') : ""}
    ${r.pageDisclosed ? '<span class="rvx-pill mute">페이지에 안내됨</span>' : ""}
  </div>
  ${conflict}
  ${disclosed}
  ${r.shown || r.pageDisclosed ? "" : `<div class="rvx-why">${esc(r.shownReason)} — 참고로만 표시</div>`}
  <div class="rvx-ev">${ev}</div>
</div>`;
}

export function renderInsights(el: HTMLElement, d: ReviewInsights): void {
  ensureStyle(el);
  el.classList.add("rvx");

  if (d.collecting && d.totalReviews === 0) {
    el.innerHTML = `<div class="rvx-empty"><span class="rvx-spin"></span>리뷰를 읽는 중…</div>`;
    return;
  }
  if (!d.collecting && d.totalReviews === 0) {
    el.innerHTML = `<div class="rvx-empty">이 페이지에서 리뷰를 찾지 못했어요.<br>
      숙소 상세 페이지인지 확인해 주세요.</div>`;
    return;
  }

  const shown = d.risks.filter((r) => r.shown);
  // 세 갈래로 나눈다. "페이지에 이미 안내됨"을 "근거 부족"과 같이 묶으면 라벨이 틀린다 —
  // 근거는 충분한데 알려줄 가치가 없는 것이라 성격이 다르다.
  const disclosed = d.risks.filter((r) => !r.shown && r.pageDisclosed);
  const hidden = d.risks.filter((r) => !r.shown && !r.pageDisclosed);

  const skipped = d.totalReviews - d.analyzedReviews;

  el.innerHTML = `
<div class="rvx-head">
  <p class="rvx-title">리뷰에서 찾은 것</p>
  <p class="rvx-sub">
    ${d.collecting ? '<span class="rvx-spin"></span>' : ""}
    공개 리뷰 <b>${d.totalReviews}건</b> 중 한국어·영어 <b>${d.analyzedReviews}건</b>을 분석했어요
  </p>
</div>

${
  shown.length
    ? `<div class="rvx-sec">추가 비용 가능성</div>${shown.map(riskRow).join("")}`
    : `<div class="rvx-empty">
        <span class="rvx-check"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#1b7a52" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13l5 5L20 6"></path></svg></span>
        반복되는 추가비용 언급이<br>발견되지 않았어요
        <small>리뷰 ${d.analyzedReviews}건을 살펴봤어요</small>
      </div>`
}

${disclosed.length ? `<div class="rvx-sec">페이지에 이미 안내된 비용</div>${disclosed.map(riskRow).join("")}` : ""}

${hidden.length ? `<div class="rvx-sec">신호는 있지만 근거가 부족한 것</div>${hidden.map(riskRow).join("")}` : ""}

<div class="rvx-foot" title="판정 층: ${d.stagesRun.join(" → ") || "없음"}">
  서로 다른 리뷰 <b>${MIN_TEXT}건 이상</b>일 때만 알려드려요. 한 명만 겪은 일은 숙소 전체의 문제가 아닐 수 있어서예요.<br>
  이 값은 리뷰에 근거한 <b>추정</b>이라, 위 예약 금액과 <b>합산하지 않습니다.</b>
  ${shown.length ? "" : '<span class="dim"><br>없다는 뜻은 아니고, 리뷰에서 못 찾았다는 뜻이에요.</span>'}
</div>`;
}

const MIN_TEXT = 2;

export interface MountHandle {
  update: (d: ReviewInsights) => void;
  destroy: () => void;
}

/** 팀원 UI 안의 아무 엘리먼트에나 붙일 수 있다. */
export function mountPanel(el: HTMLElement): MountHandle {
  return {
    update: (d) => renderInsights(el, d),
    destroy: () => {
      el.innerHTML = "";
      el.classList.remove("rvx");
    },
  };
}
