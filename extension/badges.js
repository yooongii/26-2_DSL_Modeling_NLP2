// 검색결과 안전도 배지 (B) — 목록 페이지에서 반복되는 "카드" 구조를 찾아 각 카드 옆에
// 🟢🟡🔴 배지를 붙인다. 상세/결제 페이지의 브리핑카드(A)와 달리 LLM 호출 없이 가벼운
// 판정만으로 훑어야 한다 — 카드가 보통 10~30개씩 한 화면에 있기 때문. 정밀 판단은
// 상세 페이지에서 A가 맡고, 여기는 "어디를 눈여겨봐야 할지" 빠르게 찍어주는 용도라
// 오탐이 있어도 큰 문제 없게(참고용 신호) 설계했다.
//
// 카드 "경계"는 여기서 구조적으로(가격 리프에서 위로 올라가며, 링크/버튼을 포함한 적당한
// 크기의 컨테이너) 찾는다 — pricing.js의 findAllRelevantBlocks(가격+취소문구가 같은
// 블록에 있어야 카드로 인정)를 그대로 쓰려다 실패했다: 목록 카드 중 일부는 취소 관련
// 문구를 아예 안 보여줄 수 있는데, 그러면 그 카드는 "정책 문구"를 찾아 조상을 계속
// 타고 올라가다 여러 카드를 통째로 감싸는 공통 컨테이너까지 가버리고, 그룹핑(같은 부모
// 공유 개수)이 깨져 전체 배지가 안 뜨는 문제가 실측(합성 테스트)에서 확인됐다. 대신
// 판정(취소조건 분류)만 cancellation.js를 재사용한다 — 이건 카드 경계와 무관하게
// 안전하게 재사용 가능하다.

(function () {
  const PRICE_RE = /₩\s*[\d,]{4,}|[\d,]{4,}\s*원/;
  const MIN_GROUP_SIZE = 3;
  // 실사이트(아고다) 실측: 숙소명+위치+거리+리뷰+편의시설만으로도 1200자는 쉽게 넘고,
  // 조상 탐색도 디자인시스템 래퍼가 많으면 8단계로는 부족할 수 있다(브리핑카드 쪽에서
  // 이미 확인된 교훈) — 넉넉히 잡는다.
  const MAX_CARD_TEXT_LEN = 3000;
  const MAX_ANCESTOR_DEPTH = 40;

  function isOwn(node) {
    return node.closest && node.closest(".cc-ui");
  }

  function findPriceLeaves(root) {
    const doc = root;
    const candidates = doc.querySelectorAll("span, strong, b, div, dd, td, p, li");
    const leaves = [];
    for (const node of candidates) {
      if (isOwn(node)) continue;
      if (node.children.length > 0) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > 40) continue;
      if (!PRICE_RE.test(text)) continue;
      leaves.push(node);
    }
    return leaves;
  }

  // 가격 리프에서 위로 올라가며 "링크나 버튼을 포함하고, 텍스트가 너무 길지 않은" 첫
  // 조상을 카드 컨테이너 후보로 삼는다. 상세페이지의 요금제 행은 <a> 없이 <button>인
  // 경우가 있었던 것과 같은 이유로 버튼도 인정한다.
  function findCardAncestor(priceLeaf) {
    let node = priceLeaf.parentElement;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && node; depth++) {
      const text = (node.innerText || "").trim();
      if (text.length > MAX_CARD_TEXT_LEN) return null;
      const hasLink = node.querySelector && node.querySelector("a, button");
      if (hasLink && text.length >= 20) return node;
      node = node.parentElement;
    }
    return null;
  }

  // className 문자열 비교로 그룹핑했더니 스폰서 카드만 class가 달라 그룹이 쪼개지는 문제가
  // 실사이트(아고다)에서 확인됐다 — 대신 "같은 부모 밑에 있는가"로 그룹핑한다.
  function findListingCards(doc) {
    // 아고다 검색결과는 카드마다 data-selenium="hotel-item"이 붙는다. 이걸 쓰면 커버리지가
    // 크게 올라간다(실측: 휴리스틱만 쓸 때 49개 중 7개(14%)에만 배지가 붙었다).
    // 없는 사이트/레이아웃에서는 기존 "같은 부모 그룹핑" 휴리스틱으로 폴백한다.
    // 선택자는 사이트 어댑터(hints.listingCard)가 준다.
    const cardSel = window.__ccSites?.hint("listingCard");
    const native = cardSel ? [...doc.querySelectorAll(cardSel)] : [];
    if (native.length >= MIN_GROUP_SIZE) {
      const out = [];
      for (const card of native) {
        const priceLeaf = findPriceLeaves(card)[0] ?? card.querySelector("span, div");
        if (priceLeaf) out.push({ card, priceLeaf });
      }
      if (out.length >= MIN_GROUP_SIZE) return out;
    }
    const leaves = findPriceLeaves(doc);
    const cardsByParent = new Map();
    const seen = new Set();
    for (const leaf of leaves) {
      const card = findCardAncestor(leaf);
      if (!card || seen.has(card)) continue;
      seen.add(card);
      const parent = card.parentElement;
      if (!parent) continue;
      if (!cardsByParent.has(parent)) cardsByParent.set(parent, []);
      cardsByParent.get(parent).push({ card, priceLeaf: leaf });
    }
    let best = [];
    for (const group of cardsByParent.values()) {
      if (group.length >= MIN_GROUP_SIZE && group.length > best.length) best = group;
    }
    return best; // [{card, priceLeaf}]
  }

  // cancellation.js의 분류를 재사용 — badges.js 자체 정규식으로 "환불불가만 빨강" 수준
  // 이던 v1보다 훨씬 정확하다(날짜 있는 진짜 무료취소를 확인해서 초록으로 표시하는 등).
  // doc는 항상 실제 document를 넘긴다.
  // 목록 카드에는 취소 "조건 원문"이 거의 없다. 상세페이지용 판정을 그대로 쓰면 대부분
  // "정보 없음"(노랑)이 되어 🟢🔴 구분이 사라진다(실측: 배지 7개 전부 노랑, 툴팁 동일).
  // 그래서 목록에서는 아고다가 카드에 직접 붙이는 표기만 본다 —
  // 무료취소 표기 → 👍 / 환불불가 표기 → 👎 / 아무 표기도 없으면 배지를 아예 안 단다.
  // "모르는 것은 표시하지 않는다"가 전부 노랑으로 칠하는 것보다 신뢰도가 높다.
  const FREE_MARK_RE = /무료\s*취소|무료취소/;
  const NONREF_MARK_RE = /환불\s*불가|환불불가|취소\s*불가/;

  function scoreCard(doc, card) {
    const text = (card.innerText || "").replace(/\s+/g, " ");
    const clean = text.replace(/취소\s*불가능한/g, ""); // 오탐 방지용 예외 문구
    if (NONREF_MARK_RE.test(clean)) {
      return { light: "red", reason: "환불 불가 요금제 — 취소해도 환불되지 않습니다" };
    }
    if (FREE_MARK_RE.test(clean)) {
      const cancellation = window.__ccCancellation.buildCancellationSummary(doc, card);
      const when = cancellation.deadline ? `${cancellation.deadline}까지 ` : "";
      return { light: "green", reason: `${when}무료 취소 가능` };
    }
    return null; // 판정 근거 없음 → 배지 없음
  }

  function clearBadges(doc) {
    doc.querySelectorAll(".cc-badge").forEach((n) => n.remove());
  }

  function renderBadge(priceLeaf, light, reason) {
    const badge = document.createElement("span");
    badge.className = "cc-badge cc-ui";
    badge.textContent = light === "green" ? "👍" : "👎";
    badge.title = reason;
    badge.style.cssText = `
      display:inline-block; margin-left:6px; font-size:15px; line-height:1; cursor:help;
      filter: drop-shadow(0 0 1px rgba(0,0,0,.25))
              ${light === "green" ? "hue-rotate(-15deg) saturate(1.25)" : "hue-rotate(-25deg) saturate(1.4)"};
    `;
    priceLeaf.insertAdjacentElement("afterend", badge);
  }

  // 배지가 없는 숙소가 "문제 없음"으로 오독될 수 있어 범례를 띄운다.
  // 화면 고정(position:fixed)으로 두면 사이트 자체 플로팅 요소에 가릴 수 있어서,
  // 목록 첫 카드 바로 위에 인라인으로 끼워 넣는다 — 사용자가 기대하는 위치이기도 하다.
  function ensureLegend(doc, shown) {
    doc.getElementById("cc-legend")?.remove();
    if (!shown) return;
    const first = doc.querySelector('[data-selenium="hotel-item"]');
    if (!first || !first.parentElement) return;
    const el = doc.createElement("div");
    el.id = "cc-legend";
    el.className = "cc-ui";
    el.style.cssText = `
      display:flex; align-items:center; flex-wrap:wrap; gap:8px;
      margin:0 0 12px; padding:9px 14px;
      background:#eaf1ff; border:1px solid #d9e1ed; border-radius:10px;
      font:12px -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif; color:#16233d;
    `;
    // 브리핑 카드 헤더와 같은 브랜드마크를 쓴다 — 예전엔 글자 "B"였는데 제품명과 맞지 않았다.
    // 확장 컨텍스트가 무효화되면 getURL이 던지므로 글자로 대체한다.
    let mark;
    try {
      mark = `<img src="${chrome.runtime.getURL("icon48.png")}" alt="ClearBooking" draggable="false"
                   style="width:20px;height:20px;border-radius:5px;display:block;flex:0 0 auto;">`;
    } catch (e) {
      mark = `<span style="display:grid;place-items:center;width:20px;height:20px;border-radius:5px;background:#173d9a;color:#fff;font-size:10px;font-weight:900;">C</span>`;
    }
    el.innerHTML = `
      ${mark}
      <span><b>👍 무료취소 확인됨</b></span>
      <span style="color:#c3cede;">|</span>
      <span><b>👎 환불불가</b></span>
      <span style="color:#c3cede;">|</span>
      <span style="color:#677288;">배지 없음 = 목록에 취소 정보가 없어 <b>미확인</b> (안전하다는 뜻이 아닙니다)</span>
      <span id="cc-legend-x" style="cursor:pointer;color:#98a2b5;margin-left:auto;">✕</span>
    `;
    el.querySelector("#cc-legend-x").addEventListener("click", () => el.remove());
    first.parentElement.insertBefore(el, first);
  }

  function runBadgeScan(doc) {
    clearBadges(doc);
    const cards = findListingCards(doc);
    if (cards.length < MIN_GROUP_SIZE) return { ran: false, count: 0 };
    let shown = 0;
    for (const { card, priceLeaf } of cards) {
      const score = scoreCard(doc, card);
      if (!score) continue; // 근거 없으면 표시하지 않는다
      renderBadge(priceLeaf, score.light, score.reason);
      shown++;
    }
    ensureLegend(doc, shown);
    return { ran: true, count: cards.length, shown };
  }

  window.__ccBadges = { runBadgeScan, findListingCards, scoreCard };
})();
