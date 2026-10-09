// 결제(체크아웃) 페이지 전용 — 화면에 보이는 KRW 금액과 실제 결제 통화가 다르면 알려주는
// 순수 읽기 전용 안내 배지.
//
// 숙소 상세페이지의 브리핑 카드(sites.js/briefing.js 전체)와 완전히 분리된 독립 스크립트다.
// 그쪽 로직을 재사용하지 않고, 이 파일은 페이지의 어떤 요소도 클릭하거나 값을 채우지 않는다
// — 읽기만 한다. 결제 페이지는 이 확장에서 제일 조심해야 할 영역(카드번호 입력·결제 버튼이
// 있는 화면)이라, "동작 범위를 결제 페이지까지 넓히는 것"과 "거기서 상호작용은 전혀 안 하는
// 것"을 분리해서 후자를 코드 구조로 못박아 둔다.
//
// 실측(2026-09-22, 오사카 숙소 예약 플로우 끝까지 진행):
//  · Booking.com(secure.booking.com/book.html): "KRW 통화로 표시된 금액은 추정치입니다.
//    실제 결제는 다음 통화로 진행됩니다: JPY. 결제 전에 환율이 변동될 수 있습니다."
//  · Trip.com(kr.trip.com/hotels/booknew): "숙소 결제" 섹션에 "약 252,660원"과 함께
//    "숙소 결제 통화: JPY29,300"이 붙어 나온다.
//  · Agoda(agoda.com/.../book/payment/)는 같은 예약 플로우를 결제 직전 단계까지 실측했지만
//    이런 문구가 없었다.
//
// 정정(2026-09-24, 세 사이트 결제 페이지 재비교): Booking.com·Agoda는 이 배지를 빼기로
// 했다 — Booking.com은 위 문구를 결제 페이지 자체가 이미 눈에 띄게 보여줘서 우리 배지가
// 그대로 겹친다(정보 중복, 사장님 판단). Agoda는 실측 결제 페이지(예: 합계 ₩1,102,776,
// 세금·서비스료까지 전부 원화)에 외화 관련 문구 자체가 없어 — "항상 원화 결제"라고
// 일반화하진 않지만, 지금 감지할 패턴이 없으니 로직을 만들 이유도 없다(다른 증거가
// 나오면 다시 추가). Trip.com만 자체 안내가 불충분해서("약 252,660원"이 실제로 그 금액이
// 청구된다는 오해를 살 수 있음) 이 배지가 남아 있을 값어치가 있다고 보고 유지한다.

(function () {
  const host = location.hostname;
  const path = location.pathname;

  // 결제 페이지가 맞을 때만 스캔한다. trip.com은 manifest에서 이미 호스트 전체
  // (https://*.trip.com/*)를 허용하고 있어서, 상세페이지 등 다른 페이지에서도 이 파일
  // 자체는 주입된다 — 경로로 한 번 더 좁혀야 엉뚱한 페이지에서 스캔을 안 돈다.
  // Booking.com·Agoda는 뺀 이유는 파일 위 설명(정정 2026-09-24) 참고.
  function isPaymentPage() {
    if (/(^|\.)trip\.com$/.test(host)) return /\/hotels\/booknew/.test(path);
    return false;
  }
  if (!isPaymentPage()) return;

  function isOwn(node) {
    return !!node.closest?.(".cc-ui");
  }

  // 리프 노드(자식 없는 텍스트 노드)만 본다 — 넓은 컨테이너를 통째로 매치하면 문장이 아닌
  // 페이지 전체 텍스트를 긁어와 엉뚱한 숫자를 집을 위험이 있다(이 확장 전체의 원칙과 동일).
  function scanLeaves(doc, re) {
    for (const el of doc.querySelectorAll("div, span, p, li, dd, td")) {
      if (isOwn(el) || el.children.length) continue;
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const m = re.exec(text);
      if (m) return m;
    }
    return null;
  }

  const TRIPCOM_RE = /숙소\s*결제\s*통화\s*:?\s*([A-Z]{3})\s*([\d,]+(?:\.\d+)?)/;
  function detectTripcom(doc) {
    const m = scanLeaves(doc, TRIPCOM_RE);
    return m ? { currency: m[1], amount: m[2] } : null;
  }

  function detect(doc) {
    if (/(^|\.)trip\.com$/.test(host)) return detectTripcom(doc);
    return null; // isPaymentPage()가 이미 trip.com만 통과시키므로 사실상 안 타는 경로
  }

  // 실사용 리포트(2026-09-24): "그 배지가 우리건지 트립닷컴이 띄워주는건지 분간이 안 가서
  // 우리 서비스인 게 티나게 개선해야 할 것 같아" — 이 파일은 briefing.js와 완전히 분리된
  // 독립 스크립트라(파일 위 설명 참고) 브랜드마크를 자체적으로 다시 만든다. briefing.js의
  // brandMarkHtml()과 같은 방식(확장 아이콘, 실패하면 글자 대체)을 그대로 쓴다.
  function extensionUrl(path) {
    try {
      return chrome.runtime.getURL(path);
    } catch (e) {
      return null;
    }
  }
  function brandMarkHtml() {
    const url = extensionUrl("icon48.png");
    return url
      ? `<img src="${url}" alt="ClearBooking" draggable="false" style="width:15px; height:15px; border-radius:4px; flex-shrink:0; display:block;">`
      : `<span style="display:inline-flex; align-items:center; justify-content:center; width:15px; height:15px; border-radius:4px; background:#173d9a; color:#fff; font:800 9px/1 -apple-system,sans-serif; flex-shrink:0;">C</span>`;
  }

  let badgeEl = null;
  function render(info) {
    if (!info) {
      badgeEl?.remove();
      badgeEl = null;
      return;
    }
    // 카드사 해외결제수수료는 우리가 계산하지 않는다 — 실제 환율은 카드사·카드網마다
    // 달라서 우리가 어떤 값을 계산해도 실제 청구액과 어긋날 수밖에 없다(사장님 판단:
    // 숫자를 잘못 단정하느니 아예 계산하지 않는 게 안전하다). 그래서 숫자가 아니라
    // "그럴 수 있다"는 일반적인 사실만 덧붙인다. 이 문장은 Booking.com 실측 원문에도
    // 있었다("신용카드 회사에서 해외 결제 수수료를 부과할 수 있습니다") — Trip.com
    // 원문엔 없었지만 카드사 수수료는 플랫폼과 무관한 일반 사실이라 공통으로 붙인다.
    const FEE_NOTE = "카드사에 따라 해외 결제 수수료가 추가로 부과될 수 있어요.";
    const text = info.amount
      ? `실제 결제는 ${info.currency} ${info.amount}로 진행돼요 — 화면 금액은 환산 추정치예요. 환율에 따라 최종 청구액이 달라질 수 있어요. ${FEE_NOTE}`
      : `실제 결제는 ${info.currency}로 진행돼요 — 화면 금액은 환산 추정치예요. 환율에 따라 최종 청구액이 달라질 수 있어요. ${FEE_NOTE}`;
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.className = "cc-ui";
      badgeEl.style.cssText = `
        position:fixed; right:16px; bottom:16px; z-index:2147483000; max-width:280px;
        background:#eef4ff; border:1px solid #b9d3ff; border-radius:10px; padding:10px 12px;
        font:12px/1.5 -apple-system,"Malgun Gothic",sans-serif; color:#1c3d7a;
        box-shadow:0 2px 10px rgba(0,0,0,.12);
      `;
      badgeEl.innerHTML =
        `<div style="display:flex; align-items:center; gap:6px; margin-bottom:5px;">` +
        brandMarkHtml() +
        `<b style="font-size:11px; font-weight:800; letter-spacing:-.01em; color:#173d9a;">ClearBooking</b>` +
        `<span style="color:#8aa3d6;">·</span>` +
        `<b style="font-size:11px; font-weight:700;">환율 안내</b>` +
        `</div><span class="cc-fx-text"></span>`;
      document.documentElement.appendChild(badgeEl);
    }
    badgeEl.querySelector(".cc-fx-text").textContent = text;
  }

  function scan() {
    try {
      render(detect(document));
    } catch (e) {
      console.error("[cc] 결제통화 안내 스캔 실패:", e);
    }
  }

  scan();
  // 프로모션 코드 적용 등으로 결제 페이지 금액이 뒤늦게 바뀔 수 있어 가볍게 재스캔한다.
  // 클릭 등 상호작용은 전혀 하지 않는 읽기 전용 스캔이라 자주 돌아도 사이드이펙트가 없다.
  let debounce = null;
  new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(scan, 500);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
