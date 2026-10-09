/**
 * 실사이트 테스트용 떠 있는 패널.
 *
 * 확장을 빌드·로드하지 않고 **아고다 페이지 콘솔에 붙여넣어** 탭 2를 바로 확인한다.
 * 팀원 UI 목업이 나오기 전에 실사이트에서 수집 휴리스틱을 검증하는 것이 목적이고,
 * 목업이 나오면 이 파일은 안 써도 된다 — `mountReviewTab()` 이 본체다.
 *
 * 여기 있는 것(드래그·닫기·탭 껍데기)은 전부 **테스트 편의**이지 제품 코드가 아니다.
 * 그래서 lib/review 의 다른 파일들과 달리 이 파일만 화면에 자기 UI를 띄운다.
 */
import { mountReviewTab, type ReviewTabHandle } from "./index";
import { ruleAnalyzer } from "./rules";
import { createModelAnalyzer } from "./modelAnalyzer";
import { rankContainers, findReviewContainer, findOpenButton, explainCards, explainPagination } from "./collect";

const HOST_ID = "__reviewDevPanel";

/**
 * 이 패널은 **개발용**이라 로컬 분류 서버 주소를 직접 준다.
 * 배포되는 익스텐션(reviewtab.js)은 주소를 주지 않아 규칙 층만으로 돈다 —
 * 자세한 배경은 modelAnalyzer.ts 의 주석 참고.
 */
const DEV_ENDPOINT = "http://127.0.0.1:8799/classify";

export function openDevPanel(): () => void {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483647;";
  document.body.appendChild(host);

  // Shadow DOM: 사이트 CSS가 패널을 망가뜨리지도, 패널이 사이트를 오염시키지도 않는다.
  // 리뷰 스캔이 패널 자신을 긁는 사고도 막힌다(querySelectorAll 이 shadow 안을 못 본다).
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  :host, * { box-sizing: border-box; }
  .p { width: 400px; max-height: 86vh; display: flex; flex-direction: column;
       background: #fff; color: #1f2937; border: 1px solid #d1d5db; border-radius: 10px;
       box-shadow: 0 18px 50px -12px rgba(0,0,0,.35);
       font: 13px/1.6 -apple-system, "Malgun Gothic", system-ui, sans-serif; }
  .bar { display:flex; align-items:center; gap:8px; padding:9px 11px;
         border-bottom:1px solid #e5e7eb; cursor:move; background:#f9fafb;
         border-radius:10px 10px 0 0; }
  .bar b { font-size:12.5px; }
  .sp { flex:1; }
  .bar button { background:none; border:none; color:#6b7280; cursor:pointer;
                font-size:12px; padding:3px 7px; border-radius:5px; font-family:inherit; }
  .bar button:hover { background:#e5e7eb; color:#111827; }
  .tabs { display:flex; border-bottom:1px solid #e5e7eb; }
  .tabs button { flex:1; background:none; border:none; border-bottom:2px solid transparent;
                 color:#6b7280; padding:8px 4px; cursor:pointer; font-size:12.5px; font-family:inherit; }
  .tabs button.on { color:#0d9488; border-bottom-color:#0d9488; font-weight:600; }
  .body { overflow-y:auto; padding:12px; flex:1; }
  .stub { color:#6b7280; text-align:center; padding:30px 14px; font-size:12.5px; line-height:1.8; }
</style>
<div class="p">
  <div class="bar" id="bar">
    <b>🧪 예약 브리핑 (개발용)</b><span class="sp"></span>
    <button id="re">다시</button><button id="x">✕</button>
  </div>
  <div class="tabs">
    <button data-t="cost">비용·환불</button>
    <button data-t="review" class="on">리뷰</button>
  </div>
  <div class="body" id="body"></div>
</div>`;

  const $ = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const body = $<HTMLElement>("#body");

  // 탭 2만 실제로 붙인다. 탭 1은 다른 담당자 몫이라 자리만 잡아둔다.
  const reviewHost = document.createElement("div");
  // 규칙 층 뒤에 학습 모델 층을 얹는다. 서버(serve.py)가 안 떠 있으면
  // 모델 층이 조용히 건너뛰고 규칙 결과만 보인다.
  let handle: ReviewTabHandle | null = mountReviewTab(reviewHost, {
    analyzers: [ruleAnalyzer, createModelAnalyzer({ endpoint: DEV_ENDPOINT })],
  });
  body.appendChild(reviewHost);

  root.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      body.innerHTML = "";
      if (b.dataset.t === "review") body.appendChild(reviewHost);
      else body.innerHTML = `<div class="stub">탭 1 · 비용/환불<br>다른 담당자 작업 영역입니다.</div>`;
    };
  });

  $<HTMLButtonElement>("#re").onclick = () => handle?.refresh();

  const close = () => {
    handle?.destroy();
    handle = null;
    host.remove();
  };
  $<HTMLButtonElement>("#x").onclick = close;

  // 패널이 리뷰를 가릴 때 옮길 수 있게
  (() => {
    const bar = $<HTMLElement>("#bar");
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    bar.onmousedown = (e: MouseEvent) => {
      on = true; sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    };
    window.addEventListener("mousemove", (e) => {
      if (!on) return;
      host.style.left = `${ox + e.clientX - sx}px`;
      host.style.top = `${oy + e.clientY - sy}px`;
      host.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (on = false));
  })();

  return close;
}

/**
 * 왜 그 컨테이너를 골랐는지 콘솔에서 확인한다.
 * 휴리스틱이 틀린 걸 고치려면 후보와 점수를 눈으로 봐야 한다.
 */
function reviewDebug(): void {
  const picked = findReviewContainer(document);
  const btn = findOpenButton();
  console.log("열기 버튼:", btn ? `"${(btn.innerText || "").trim()}"` : "(없음)");
  console.log("선택된 컨테이너:", picked
    ? `${picked.tagName}.${picked.className} · 자식 ${picked.children.length}`
    : "(없음)");
  if (picked) {
    console.log("카드별 채택/탈락:");
    console.table(explainCards(picked));
    console.log("페이지네이션:", explainPagination(picked));
    console.table(explainPagination(picked).후보);
  }
  console.log("후보 순위 (상위 8):");
  console.table(rankContainers(document).slice(0, 8).map((c) => ({
    요소: `${c.el.tagName}.${String(c.el.className).slice(0, 34)}`,
    자식: c.el.children.length,
    리뷰모양: c.ok,
    리뷰다움: Number(c.reviewness.toFixed(2)),
    깊이: c.depth,
    선택: c.el === picked ? "◀" : "",
  })));
}

declare global {
  interface Window {
    openReviewPanel: typeof openDevPanel;
    closeReviewPanel: () => void;
    reviewDebug: typeof reviewDebug;
  }
}

// 콘솔에서 다시 열고 닫을 수 있게 전역에 노출
window.openReviewPanel = openDevPanel;
window.reviewDebug = reviewDebug;
window.closeReviewPanel = openDevPanel();
