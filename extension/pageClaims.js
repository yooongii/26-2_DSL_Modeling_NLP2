// 페이지 자체의 어메니티/위치 설명 텍스트에서 "이런 점이 좋다"는 마케팅 문구를
// 구조화해서 뽑는다("신규 기능: 페이지 설명 vs 리뷰 실제 대조"의 페이지 쪽 절반).
//
// reviews.js의 checkPageDisclosure(비용 공개 여부: free/paid_disclosed/not_mentioned)와는
// 다른 개념이다 — 그건 "이미 유료라고 투명하게 밝혔는가"를 보고, 여기는 "페이지가 긍정적
// 마케팅 문구로 뭘 약속하는가"를 본다. 이걸 reviews.js의 리스크 4종(청결위생/소음방음/
// 위치접근성/시설불일치) negative 리뷰와 대조하면 "방음 완비로 표시 ↔ 소음 리뷰 12건"
// 같은 표시-실제 불일치를 잡을 수 있다.
//
// 시설불일치는 대조 대상에서 뺐다 — 페이지가 문장으로 "시설이 사진과 같다"를 약속하는
// 경우는 거의 없고(사진/체크리스트로 보여주는 게 보통), 라벨링 데이터에서도 가장 희소한
// 유형(8/873)이라 텍스트 패턴을 만들 근거가 부족했다. reviews.js 쪽은 이 유형도 리뷰
// 언급 건수만으로는 그대로 노출한다(대조 없이).

(function () {
  const SECTION_ANCHOR_RE = /숙소\s*설명|호텔\s*소개|시설\s*및\s*서비스|편의\s*시설|주변\s*환경|교통\s*및\s*위치/;
  const ANCHOR_MAX_TEXT_LEN = 30;
  const MAX_ANCESTOR_DEPTH = 15;
  const MAX_SECTION_TEXT_LEN = 20000;

  function isOwn(node) {
    return node.closest && node.closest(".cc-ui");
  }

  // pricing.js/badges.js와 같은 패턴: 짧은 제목 리프를 앵커로 찾고, 그 조상 중 텍스트가
  // 충분히 커지는(=본문을 담기 시작하는) 첫 지점을 스코프로 삼는다.
  function findSectionScope(doc) {
    const candidates = doc.querySelectorAll("h1,h2,h3,h4,span,div,strong,b");
    for (const node of candidates) {
      if (isOwn(node)) continue;
      if (node.children.length > 0) continue;
      const text = (node.innerText || "").trim();
      if (!text || text.length > ANCHOR_MAX_TEXT_LEN) continue;
      if (!SECTION_ANCHOR_RE.test(text)) continue;

      let n = node.parentElement;
      let candidate = null;
      for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && n; depth++) {
        const t = (n.innerText || "").trim();
        if (t.length > MAX_SECTION_TEXT_LEN) break;
        if (t.length > 80) candidate = n;
        n = n.parentElement;
      }
      if (candidate) return candidate;
    }
    return null;
  }

  function clipSpan(text, index, matchLen, radius = 20) {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + matchLen + radius);
    return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
  }

  // riskType 이름은 reviews.js의 RISK_TYPES와 맞춘다 — 대조 시 문자열 비교 하나로 매칭.
  const CLAIM_PATTERNS = [
    {
      riskType: "소음방음",
      re: /방음\s*(완비|시설|잘\s*(되|돼)|우수)|무소음|조용한\s*(객실|위치)/g,
    },
    {
      riskType: "위치접근성",
      re: /(지하철|전철|역)\s*(에서|까지)?\s*도보\s*\d+\s*분|\d+\s*분\s*(이내|거리)\s*(에|이내)?\s*(지하철|역|공항)|공항\s*(셔틀|근접|인접)/g,
    },
    {
      riskType: "청결위생",
      re: /(매일|정기적으로)\s*(객실\s*)?청소\s*(제공|서비스|진행)|위생\s*(관리|점검)\s*(철저|엄격)/g,
    },
  ];

  function extractPageClaims(doc) {
    const scope = findSectionScope(doc);
    if (!scope) return [];
    const text = (scope.innerText || "").trim();
    if (!text) return [];

    const claims = [];
    const seen = new Set();
    for (const { riskType, re } of CLAIM_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const span = clipSpan(text, m.index, m[0].length);
        const key = riskType + "|" + span;
        if (!seen.has(key)) {
          seen.add(key);
          claims.push({ riskType, span });
        }
        if (re.lastIndex === m.index) re.lastIndex++; // 빈 매치로 인한 무한루프 방지
      }
    }
    return claims;
  }

  window.__ccPageClaims = { extractPageClaims };
})();
