// 예약 브리핑 - content script.
//
// 역할은 페이지 변화를 감지해서 브리핑카드(briefing.js)와 검색결과 안전도 배지(badges.js)를
// 다시 그리라고 신호를 주는 것뿐이다. briefing.js 자신은 스캔을 언제 다시 돌릴지 모르므로
// (자체 타이머/옵저버가 없음) 이 파일이 "언제"를 판단하는 오케스트레이션 레이어다.
//
// 다크패턴 탐지(Track4)는 별도 기능이라 분리했다 — 코드는 로컬에만 보관.

(function () {
  // 페이지가 SPA라 content script가 남아있는 상태로 새 페이지처럼 다시 주입될 수 있어서
  // 중복 리스너 등록을 막는다.
  if (window.__ccInjected) return;
  window.__ccInjected = true;

  // --- 예약 브리핑(A) + 검색결과 안전도 배지(B) ------------------------------
  // 사용자가 페이지를 보고 있기만 해도 바로 도움이 되는 게 이 기능의 요점이라, 버튼 뒤에
  // 숨기지 않고 항상 켜져 있다.
  function runBriefingScan() {
    try {
      window.__ccBriefing.runBriefing(document);
      window.__ccBadges.runBadgeScan(document);
    } catch (e) {
      console.error("[cc] 브리핑 스캔 오류:", e);
    }
  }

  let briefingDebounceTimer = null;
  function scheduleBriefingScan() {
    clearTimeout(briefingDebounceTimer);
    briefingDebounceTimer = setTimeout(runBriefingScan, 900);
  }

  // --- SPA 라우팅/큰 DOM 변화 감지 -> 자동 재스캔 -----------------------------
  function hookHistoryChanges() {
    const wrap = (fn) =>
      function (...args) {
        const ret = fn.apply(this, args);
        window.dispatchEvent(new Event("cc:locationchange"));
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", () => window.dispatchEvent(new Event("cc:locationchange")));
    window.addEventListener("cc:locationchange", scheduleBriefingScan);
  }

  function isOwnNode(node) {
    if (node.nodeType !== 1) return false; // 텍스트 노드 등은 우리가 만든 게 아님 -> 그대로 통과
    return !!node.classList?.contains("cc-ui"); // 브리핑카드(A)/안전도배지(B)
  }

  // 사고 원인(2026-09-17, Subtree modification 진단으로 확정): 체크인/체크아웃/인원선택
  // 검색바(#SearchBoxContainer)도 아고다 자신이 role="dialog" aria-modal="true"로 팝업을
  // 띄운다. 아래 containsModal이 "취소 정책 모달"과 구분하지 못하고 똑같이 반응해서,
  // 그 팝업이 뜨는 바로 그 순간 디바운스 없이 무거운 동기 스캔(가격/취소조건/리뷰/배지
  // 전체)을 돌렸다 — 그 스캔이 메인스레드를 점유하는 동안 아고다 팝업 자신의 초기화
  // 애니메이션 타이밍이 꼬여서 달력이 저절로 다음 달로, 인원선택도 저절로 한 번 더
  // 진행되는 버그로 실측 확인됐다(재현 시 호출스택이 전부 아고다 자체 번들 코드였고,
  // 확장을 끄면 재현되지 않음 — 우리가 클릭한 게 아니라 우리 스캔이 타이밍을 건드린 것).
  // 검색바 내부에서 일어나는 변화는 브리핑과 무관하므로 아예 감지 대상에서 제외한다.
  function isSearchWidgetNode(node) {
    if (node.nodeType !== 1) return false;
    // 제외 영역은 사이트 어댑터(excludeZones)가 준다.
    return (window.__ccSites?.excludeZones() ?? []).some((sel) => !!node.closest?.(sel));
  }

  // "취소 정책" 클릭 시 뜨는 모달은 다른 DOM 변화와 똑같이 900ms 디바운스를 거치면 반응이
  // 늦게 느껴진다(실측: 2~3초) — 모달처럼 사용자가 방금 직접 클릭해서 연 것이 분명한
  // 경우엔 디바운스 없이 그 즉시 재분석한다.
  function containsModal(node) {
    if (node.nodeType !== 1) return false;
    if (node.matches?.('[role="dialog"], [aria-modal="true"]')) return true;
    return !!node.querySelector?.('[role="dialog"], [aria-modal="true"]');
  }

  function hookDomMutations() {
    // isOwnNode/isSearchWidgetNode 필터는 각각 "우리 UI 자신의 변화로 인한 무한루프"와
    // "아고다 검색바 팝업 타이밍 간섭"을 막는 안전장치다.
    const isIgnorable = (n) => isOwnNode(n) || isSearchWidgetNode(n);
    const observer = new MutationObserver((mutations) => {
      const addedNodes = mutations.flatMap((m) => [...m.addedNodes]).filter((n) => !isIgnorable(n));
      const relevant = mutations.some((m) =>
        [...m.addedNodes, ...m.removedNodes].some((n) => !isIgnorable(n))
      );
      if (!relevant) return;
      if (addedNodes.some(containsModal)) {
        runBriefingScan(); // 모달 등장 — 디바운스 없이 즉시
        // 모달이 막 추가된 이 순간엔 내용(취소 정책 원문)이 아직 안 채워져 있을 수 있다 —
        // 방금 즉시 스캔이 빈 모달을 본 채로 끝났더라도, 900ms 뒤 한 번 더 돌아서 내용이
        // 채워진 뒤의 상태로 따라잡는다(브리핑 카드가 옛 정보에 멈춰있는 것 방지).
        scheduleBriefingScan();
      } else {
        scheduleBriefingScan();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    hookHistoryChanges();
    hookDomMutations();
    // 가격/취소 문구가 뒤늦게 렌더되는 사이트가 많아 초기 로드 직후 한 번 더 지연 실행
    setTimeout(scheduleBriefingScan, 1200);
    // 스크롤로 DOM 변화 없이 다른 요금제가 뷰포트 중앙에 들어와도(포커스 카드가 바뀜)
    // 브리핑이 갱신돼야 한다 — capture:true라 안쪽 스크롤 컨테이너의 스크롤도 잡힌다.
    // scheduleBriefingScan 자체가 900ms 디바운스라 스크롤이 멈춘 뒤에만 실제로 재분석한다.
    window.addEventListener("scroll", scheduleBriefingScan, { capture: true, passive: true });

    // "요금 N개 더 보기"로 행이 펼쳐지면 새 요금들이 DOM에 추가된다. 커서가 이미 그
    // 자리에 있으면 mouseenter 가 안 오고, 통상 스캔은 900ms 디바운스라 반응이 늦다
    // (실측: 펼친 직후 직전 요금 정보가 남아 있음). 펼치기 버튼만 즉시 재스캔한다.
    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target?.closest?.("button, [role='button'], a");
        if (!btn) return;
        if (!/요금\s*\d+\s*개?\s*더\s*보기|더\s*보기|show\s*more/i.test(btn.innerText || "")) return;
        setTimeout(runBriefingScan, 300);
      },
      true,
    );
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
