// ── inspect.js — 리뷰 수집 시각화 패널 (콘솔 붙여넣기용) ──
//
// collect-reviews.js 를 먼저 붙여넣은 뒤 이 파일을 이어서 붙여넣는다.
// 화면 오른쪽에 패널이 뜨고, 탭 3개로 아래를 눈으로 확인할 수 있다:
//
//   [탐색]  어떤 요소들이 '리뷰 목록' 후보로 잡혔고 점수가 왜 그렇게 나왔는지.
//           행을 클릭하면 그 요소가 화면에서 하이라이트된다. 자동 선택이 틀렸으면
//           직접 다른 후보를 고를 수 있다.
//   [카드]  선택된 컨테이너의 자식이 각각 리뷰로 인정됐는지 / 왜 걸러졌는지.
//   [결과]  수집된 리뷰의 본문·날짜·평점. JSON 복사·저장.
//
// 판정 로직은 전부 collect-reviews.js 의 것을 그대로 쓴다(collectReviews._).
// UI가 로직을 복사해 가면 화면에 보이는 근거와 실제 수집 결과가 어긋나기 때문.
//
// 패널은 Shadow DOM 안에 있어서 사이트 CSS의 영향을 받지 않고, 사이트를 오염시키지도
// 않는다. 끄기: stopInspect()

(() => {
  if (!window.collectReviews || !window.collectReviews._) {
    console.error("❌ collect-reviews.js 를 먼저 붙여넣으세요.");
    return;
  }
  const API = window.collectReviews;
  const _ = API._;

  document.getElementById("__rvInspect")?.remove();

  // ── 하이라이트 ───────────────────────────────────────────────
  const HL = { el: null, prev: "" };
  function highlight(el, color = "#e11d48") {
    if (HL.el) HL.el.style.outline = HL.prev;
    if (!el) { HL.el = null; return; }
    HL.prev = el.style.outline || "";
    HL.el = el;
    el.style.outline = `3px solid ${color}`;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** 요소를 사람이 알아볼 수 있는 짧은 경로로 (태그 + 클래스 앞부분) */
  function pathOf(el, depth = 2) {
    const part = (n) => {
      const cls = (typeof n.className === "string" ? n.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      return n.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
    };
    const chain = [];
    let n = el;
    for (let i = 0; i <= depth && n && n.tagName; i++) { chain.unshift(part(n)); n = n.parentElement; }
    return chain.join(" › ");
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ── 패널 뼈대 ────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "__rvInspect";
  host.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;";
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
<style>
  :host, * { box-sizing: border-box; }
  .panel {
    width: 430px; max-height: 88vh; display: flex; flex-direction: column;
    background: #12181f; color: #e8eef4; border: 1px solid #2b3742; border-radius: 10px;
    box-shadow: 0 18px 50px -12px rgba(0,0,0,.65);
    font: 13px/1.5 -apple-system, "Malgun Gothic", system-ui, sans-serif;
  }
  .bar { display:flex; align-items:center; gap:8px; padding:9px 11px; border-bottom:1px solid #2b3742; cursor:move; }
  .bar b { font-size:12.5px; letter-spacing:.02em; }
  .bar .sp { flex:1; }
  .x { background:none; border:none; color:#8b9bab; cursor:pointer; font-size:16px; line-height:1; padding:2px 5px; border-radius:4px; }
  .x:hover { background:#22303c; color:#e8eef4; }

  .info { padding:8px 11px; font-size:11.5px; color:#8b9bab; border-bottom:1px solid #2b3742;
          font-family: ui-monospace, Consolas, monospace; word-break:break-all; }
  .info span { color:#5eead4; }

  .tabs { display:flex; border-bottom:1px solid #2b3742; }
  .tabs button { flex:1; background:none; border:none; border-bottom:2px solid transparent; color:#8b9bab;
                 padding:8px 4px; cursor:pointer; font-size:12.5px; font-family:inherit; }
  .tabs button.on { color:#5eead4; border-bottom-color:#5eead4; }
  .tabs button:hover:not(.on) { color:#c9d6e2; }

  .body { overflow-y:auto; padding:9px; flex:1; }
  .body::-webkit-scrollbar { width:9px; }
  .body::-webkit-scrollbar-thumb { background:#2b3742; border-radius:9px; }

  .row { border:1px solid #263039; border-radius:7px; padding:8px 9px; margin-bottom:6px; cursor:pointer; background:#161e26; }
  .row:hover { border-color:#3d4d5c; background:#1a242e; }
  .row.sel { border-color:#5eead4; background:#14262a; }
  .row .h { display:flex; align-items:center; gap:7px; margin-bottom:3px; }
  .row .p { font-family:ui-monospace, Consolas, monospace; font-size:11px; color:#c9d6e2;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .row .w { font-size:11.5px; color:#8b9bab; }
  .row .t { font-size:12px; color:#dbe6f0; margin-top:4px;
            display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }

  .tag { font-family:ui-monospace,Consolas,monospace; font-size:10.5px; font-weight:600;
         padding:1px 6px; border-radius:4px; white-space:nowrap; flex:none; }
  .t-score { background:#14313a; color:#5eead4; }
  .t-auto  { background:#3a2f12; color:#fbbf24; }
  .t-ok    { background:#14301f; color:#4ade80; }
  .t-no    { background:#331a1a; color:#f87171; }
  .t-mute  { background:#22303c; color:#8b9bab; }

  .meta { font-size:11px; color:#8b9bab; margin-top:4px; display:flex; gap:9px; flex-wrap:wrap;
          font-family:ui-monospace,Consolas,monospace; }

  .acts { display:flex; gap:6px; padding:9px; border-top:1px solid #2b3742; }
  .acts button { flex:1; background:#1d2932; border:1px solid #35434f; color:#e8eef4; padding:7px;
                 border-radius:6px; cursor:pointer; font-size:12px; font-family:inherit; }
  .acts button:hover { background:#26343f; border-color:#4a5b69; }
  .acts button.go { background:#0d9488; border-color:#0d9488; font-weight:600; }
  .acts button.go:hover { background:#14b8a6; }
  .acts button:disabled { opacity:.45; cursor:default; }

  .empty { color:#8b9bab; text-align:center; padding:26px 12px; font-size:12.5px; line-height:1.7; }
  .note { font-size:11.5px; color:#8b9bab; padding:0 1px 8px; line-height:1.6; }
  .note code { background:#1d2932; padding:1px 4px; border-radius:3px; font-size:11px; }
</style>

<div class="panel">
  <div class="bar" id="bar">
    <b>🔍 리뷰 수집 검사기</b><span class="sp"></span>
    <button class="x" id="close" title="닫기">✕</button>
  </div>
  <div class="info" id="info"></div>
  <div class="tabs">
    <button data-t="find" class="on">탐색</button>
    <button data-t="card">카드</button>
    <button data-t="out">결과</button>
  </div>
  <div class="body" id="body"></div>
  <div class="acts" id="acts"></div>
</div>`;

  const $ = (s) => root.querySelector(s);
  const body = $("#body"), acts = $("#acts"), info = $("#info");

  // ── 상태 ─────────────────────────────────────────────────────
  const S = { tab: "find", container: null, auto: null, cands: [], result: null, extract: null };

  function refresh() {
    S.cands = _.rankCandidates();
    S.auto = _.findReviewContainer();
    if (!S.container) S.container = S.auto;
    S.extract = S.container ? _.extractReviews(S.container) : null;
  }

  function renderInfo() {
    const btn = _.findOpenButton();
    info.innerHTML =
      `사이트 <span>${esc(_.siteOf())}</span> · 숙소 <span>${esc(_.listingIdOf())}</span><br>` +
      `모달버튼 ${btn ? `<span>"${esc((btn.innerText || "").trim().slice(0, 24))}"</span>` : "<span style='color:#f87171'>못 찾음</span>"}` +
      ` · 컨테이너 ${S.container ? `<span>${esc(pathOf(S.container, 1))}</span>` : "<span style='color:#f87171'>없음</span>"}`;
  }

  // ── 탭: 탐색 ─────────────────────────────────────────────────
  function renderFind() {
    if (!S.cands.length) {
      body.innerHTML = `<div class="empty">리뷰 목록 후보가 없습니다.<br><br>
        리뷰 섹션까지 스크롤했는지,<br>리뷰 모달을 열었는지 확인하세요.<br><br>
        <span style="color:#c9d6e2">아래 [모달 열기]를 눌러보세요.</span></div>`;
      return;
    }
    body.innerHTML =
      `<div class="note">후보 자격은 <b>"날짜가 있고 본문이 ${_.consts.MIN_BODY_LEN}자 이상"인 자식</b>이
       ${_.consts.MIN_CARDS}개 이상이고 전체의 절반을 넘을 것.<br>
       순위는 <b>리뷰다움</b>이 정합니다 — 평점·산문은 가점, 가격·예약버튼은 감점.
       개수로 고르면 <b>항목 많은 객실 목록이 이겨버립니다</b>.<br>
       행을 누르면 화면에서 <b style="color:#f87171">빨간 테두리</b>로 표시됩니다.</div>` +
      S.cands.map((c, i) => `
        <div class="row ${c.el === S.container ? "sel" : ""}" data-i="${i}">
          <div class="h">
            <span class="tag ${c.reviewness > 0 ? "t-score" : "t-no"}">리뷰다움 ${Number(c.reviewness).toFixed(2)}</span>
            <span class="tag t-mute">${c.ok}개</span>
            ${c.el === S.auto ? '<span class="tag t-auto">자동선택</span>' : ""}
          </div>
          <div class="p" style="margin:3px 0">${esc(pathOf(c.el))}</div>
          <div class="w">${esc(c.why)}</div>
        </div>`).join("");

    body.querySelectorAll(".row").forEach((r) => r.onclick = () => {
      const c = S.cands[+r.dataset.i];
      S.container = c.el;
      S.extract = _.extractReviews(c.el);
      highlight(c.el);
      renderInfo(); render();
    });
  }

  // ── 탭: 카드 ─────────────────────────────────────────────────
  function renderCard() {
    if (!S.container) { body.innerHTML = `<div class="empty">먼저 [탐색] 탭에서 리뷰 목록을 고르세요.</div>`; return; }
    const { detailed, rejected } = S.extract;
    const all = [
      ...detailed.map((r) => ({ i: r._index, ok: true, node: r._node, text: r.text, date: r.date, rating: r.rating })),
      ...rejected.map((r) => ({ i: r.index, ok: false, node: r.node, text: r.preview, why: r.why })),
    ].sort((a, b) => a.i - b.i);

    body.innerHTML =
      `<div class="note">선택된 목록의 자식 <b>${all.length}개</b> —
        <span style="color:#4ade80">채택 ${detailed.length}</span> /
        <span style="color:#f87171">제외 ${rejected.length}</span></div>` +
      all.map((c) => `
        <div class="row" data-i="${c.i}">
          <div class="h">
            <span class="tag ${c.ok ? "t-ok" : "t-no"}">${c.ok ? "채택" : "제외"}</span>
            <span class="tag t-mute">#${c.i}</span>
            ${c.ok ? "" : `<span class="w">${esc(c.why)}</span>`}
          </div>
          <div class="t">${esc(c.text) || "<i>(빈 카드)</i>"}</div>
          ${c.ok ? `<div class="meta"><span>📅 ${esc(c.date) || "날짜 없음"}</span><span>★ ${c.rating ?? "—"}</span><span>${c.text.length}자</span></div>` : ""}
        </div>`).join("");

    body.querySelectorAll(".row").forEach((r) => r.onclick = () => {
      const card = S.container.children[+r.dataset.i];
      highlight(card, "#fbbf24");
    });
  }

  // ── 탭: 결과 ─────────────────────────────────────────────────
  function renderOut() {
    const res = S.result;
    if (!res) {
      const n = S.extract?.detailed.length ?? 0;
      body.innerHTML = `<div class="empty">아직 수집하지 않았습니다.<br><br>
        지금 화면 기준으로는 <b style="color:#5eead4">${n}건</b>이 잡힙니다.<br>
        아래 <b>[수집 실행]</b>을 누르면 끝까지 스크롤해서<br>더 많이 모읍니다.</div>`;
      return;
    }
    body.innerHTML =
      `<div class="note">
        <b style="color:#5eead4">${res.reviewCount}건</b> 수집됨 ·
        공식 표기 ${res.official.length}개<br>
        ${res.official.map((o) => `<code>${esc(o)}</code>`).join(" ") || "<i>없음</i>"}
       </div>` +
      res.reviews.map((r, i) => `
        <div class="row" data-i="${i}">
          <div class="h"><span class="tag t-mute">#${i + 1}</span>
            <span class="w">${esc(r.date) || "날짜 없음"} · ★ ${r.rating ?? "—"}</span></div>
          <div class="t" style="-webkit-line-clamp:4">${esc(r.text)}</div>
        </div>`).join("");
  }

  // ── 하단 버튼 ────────────────────────────────────────────────
  function renderActs() {
    if (S.tab === "find") {
      acts.innerHTML = `<button id="open">모달 열기</button><button id="rescan">다시 스캔</button>`;
      $("#open").onclick = () => {
        const b = _.findOpenButton();
        if (!b) return alert("모달 버튼을 못 찾았습니다.\n화면에서 직접 리뷰 '모두 보기'를 누른 뒤 [다시 스캔]하세요.");
        b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        setTimeout(() => { S.container = null; refresh(); renderInfo(); render(); }, 1400);
      };
      $("#rescan").onclick = () => { S.container = null; refresh(); renderInfo(); render(); };
      return;
    }
    if (S.tab === "card") {
      acts.innerHTML = `<button id="rescan2">다시 스캔</button>`;
      $("#rescan2").onclick = () => { refresh(); renderInfo(); render(); };
      return;
    }
    acts.innerHTML =
      `<button class="go" id="run">수집 실행</button>
       <button id="cp" ${S.result ? "" : "disabled"}>복사</button>
       <button id="dl" ${S.result ? "" : "disabled"}>저장</button>`;
    $("#run").onclick = async () => {
      const b = $("#run"); b.disabled = true; b.textContent = "수집 중…";
      try {
        S.result = await API({ container: S.container, skipModal: true });
      } finally {
        b.disabled = false; b.textContent = "수집 실행";
        refresh(); renderInfo(); render();
      }
    };
    $("#cp").onclick = () => {
      navigator.clipboard.writeText(JSON.stringify(S.result, null, 2))
        .then(() => { $("#cp").textContent = "복사됨 ✓"; setTimeout(() => ($("#cp").textContent = "복사"), 1400); });
    };
    $("#dl").onclick = () => {
      const blob = new Blob([JSON.stringify(S.result, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${S.result.site}-${S.result.listingId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  }

  function render() {
    ({ find: renderFind, card: renderCard, out: renderOut })[S.tab]();
    renderActs();
  }

  root.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {
    root.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    S.tab = b.dataset.t; render();
  });

  $("#close").onclick = () => { highlight(null); host.remove(); };

  // 패널 드래그 (리뷰가 패널에 가릴 때 옮길 수 있게)
  (() => {
    const bar = $("#bar");
    let sx, sy, ox, oy, on = false;
    bar.onmousedown = (e) => {
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

  window.stopInspect = () => { highlight(null); host.remove(); };

  refresh(); renderInfo(); render();
  console.log("%c✅ 검사 패널 열림 — 끄기: stopInspect()", "color:#0d9488;font-weight:bold");
})();
