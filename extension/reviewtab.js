(() => {
  // rules.ts
  var FEE_KEYWORDS = {
    // 2026-09-24 확장: 실제 Trip.com 한국어 리뷰 141건에서 후보가 3건뿐이었다(놓친 예:
    // "발렛비", "체크인시 추가 금액"). 유형별로 사용자가 실제로 쓰는 표현을 더한다.
    \uC8FC\uCC28: ["\uC8FC\uCC28\uBE44", "\uC8FC\uCC28 \uC694\uAE08", "\uC8FC\uCC28\uC694\uAE08", "\uC8FC\uCC28\uB8CC", "\uBC1C\uB81B\uBE44", "\uBC1C\uB81B \uC694\uAE08", "\uBC1C\uB81B\uD30C\uD0B9", "\uBC1C\uB808\uD30C\uD0B9", "\uBC1C\uB81B", "\uBC1C\uB808 \uD30C\uD0B9", "\uC8FC\uCC28"],
    \uB9AC\uC870\uD2B8\uD53C: ["\uB9AC\uC870\uD2B8\uD53C", "\uB9AC\uC870\uD2B8 \uD53C", "\uB9AC\uC870\uD2B8 \uC694\uAE08", "resort fee", "\uC2DC\uC124 \uC774\uC6A9\uB8CC", "\uC2DC\uC124\uC774\uC6A9\uB8CC", "\uB9AC\uC870\uD2B8 \uC774\uC6A9\uB8CC", "\uC2DC\uC124 \uC0AC\uC6A9\uB8CC"],
    \uBCF4\uC99D\uAE08: ["\uBCF4\uC99D\uAE08", "\uB514\uD30C\uC9D3", "deposit", "\uC608\uCE58\uAE08", "\uBCF4\uC99D \uAE08\uC561", "\uC120\uACB0\uC81C \uBCF4\uC99D"],
    \uB3C4\uC2DC\uC138: ["\uB3C4\uC2DC\uC138", "\uC219\uBC15\uC138", "\uAD00\uAD11\uC138", "city tax", "\uC219\uBC15 \uC138\uAE08", "\uC2DC\uD2F0\uD0DD\uC2A4", "\uC2DC\uD2F0 \uD0DD\uC2A4", "\uD658\uACBD\uC138", "\uC628\uCC9C\uC138", "\uC785\uD0D5\uC138"],
    \uCCAD\uC18C\uBE44: ["\uCCAD\uC18C\uBE44", "\uCCAD\uC18C \uC694\uAE08", "\uCCAD\uC18C\uB8CC", "\uD074\uB9AC\uB2DD \uD53C", "\uD074\uB9AC\uB2DD\uD53C"],
    \uC870\uC2DD: ["\uC870\uC2DD", "\uC544\uCE68 \uC2DD\uC0AC", "\uC544\uCE68\uC2DD\uC0AC", "\uBE0C\uB809\uD37C\uC2A4\uD2B8", "\uC870\uC2DD\uAD8C", "\uC870\uC2DD \uBDD4\uD398", "\uC870\uC2DD\uBDD4\uD398", "\uC544\uCE68 \uBDD4\uD398"],
    \uC778\uC6D0\uCD94\uAC00: ["\uC778\uC6D0 \uCD94\uAC00", "\uC778\uC6D0\uCD94\uAC00", "\uCD94\uAC00 \uC778\uC6D0", "\uCD94\uAC00\uC778\uC6D0", "1\uC778 \uCD94\uAC00", "\uC778\uC6D0\uB2F9", "\uC5D1\uC2A4\uD2B8\uB77C \uBCA0\uB4DC", "\uC5D1\uC2A4\uD2B8\uB77C\uBCA0\uB4DC", "\uCD94\uAC00 \uCE68\uB300", "\uCE68\uB300 \uCD94\uAC00", "\uAC04\uC774\uCE68\uB300", "\uC131\uC778 \uCD94\uAC00", "\uC544\uC774 \uCD94\uAC00", "\uC5B4\uB9B0\uC774 \uCD94\uAC00"],
    \uC138\uAE08\uC218\uC218\uB8CC: ["\uC138\uAE08", "\uC218\uC218\uB8CC", "\uBD80\uAC00\uC138", "\uBD09\uC0AC\uB8CC", "\uC11C\uBE44\uC2A4 \uCC28\uC9C0", "\uC11C\uBE44\uC2A4\uCC28\uC9C0", "\uC11C\uBE44\uC2A4 \uC694\uAE08", "\uD0DD\uC2A4", "\uD658\uC804 \uC218\uC218\uB8CC", "\uCE74\uB4DC \uC218\uC218\uB8CC"],
    \uAE30\uD0C0\uD604\uC7A5\uACB0\uC81C: ["\uD604\uC7A5 \uACB0\uC81C", "\uD604\uC7A5\uACB0\uC81C", "\uD604\uC7A5\uC5D0\uC11C \uACB0\uC81C", "\uCCB4\uD06C\uC778 \uB54C \uACB0\uC81C", "\uB530\uB85C \uACB0\uC81C", "\uCD94\uAC00 \uAE08\uC561", "\uCD94\uAC00\uAE08\uC561", "\uCD94\uAC00 \uC694\uAE08", "\uCD94\uAC00\uC694\uAE08", "\uCD94\uAC00 \uBE44\uC6A9", "\uCD94\uAC00\uBE44\uC6A9", "\uBCC4\uB3C4 \uC694\uAE08", "\uBCC4\uB3C4\uC694\uAE08", "\uBCC4\uB3C4 \uBE44\uC6A9", "\uCD94\uAC00\uB85C \uACB0\uC81C", "\uCD94\uAC00 \uACB0\uC81C", "\uD604\uC7A5 \uC9C0\uBD88", "\uD604\uAE08\uC73C\uB85C \uB0B4", "\uD604\uAE08 \uACB0\uC81C"]
  };
  var AMENITY_TYPES = /* @__PURE__ */ new Set(["\uC870\uC2DD", "\uC8FC\uCC28", "\uC138\uAE08\uC218\uC218\uB8CC"]);
  var COST_CONTEXT_RE = /요금|가격|비용|금액|\d+\s*(?:원|엔|바트|달러|만원|천원|위안|유로|링깃|동|페소|USD|THB|JPY|EUR|CNY|KRW|₩|\$)|유료|무료|결제|지불|청구|부과|추가|별도|불포함|미포함|포함되지|따로|내야|냈|받더/;
  var COST_CUE = [
    // '유료'는 NEG_CUE의 '무료'와 짝이 되는 단서인데 빠져 있었다(2026-08-30 발견).
    // 실측 718건에서 가장 흔한 비용 단서가 '유료'라, 없으면 가장 흔한 신호를 통째로 놓친다.
    "\uC720\uB8CC",
    "\uBCC4\uB3C4",
    "\uB530\uB85C",
    "\uCD94\uAC00\uB85C",
    "\uCD94\uAC00 \uC694\uAE08",
    "\uCD94\uAC00\uC694\uAE08",
    "\uB354 \uB0B4",
    "\uB354 \uB0C8",
    "\uB354 \uBC1B",
    "\uBC1B\uB354\uB77C",
    "\uBC1B\uC558",
    "\uBC1B\uC2B5\uB2C8\uB2E4",
    "\uBC1B\uC544\uC694",
    "\uB0B4\uC57C",
    "\uB0C8\uC5B4\uC694",
    "\uB0C8\uC2B5\uB2C8\uB2E4",
    "\uC9C0\uBD88",
    "\uACB0\uC81C\uD574\uC57C",
    "\uCCAD\uAD6C",
    "\uBD80\uACFC",
    "\uC694\uAD6C",
    "\uB2EC\uB77C\uACE0",
    "\uBD99\uC5B4\uC694",
    "\uBD99\uC2B5\uB2C8\uB2E4",
    "\uD3EC\uD568 \uC548",
    "\uD3EC\uD568\uB418\uC9C0 \uC54A",
    "\uBD88\uD3EC\uD568",
    "\uBBF8\uD3EC\uD568",
    "\uC81C\uC678",
    // 2026-09-24 추가: 실제 리뷰에서 자주 쓰는 표현
    "\uB0B4\uB77C\uACE0",
    "\uB0B4\uC57C \uD588",
    "\uB0B4\uC57C\uD588",
    "\uC9C0\uBD88\uD574\uC57C",
    "\uACB0\uC81C\uD588",
    "\uACB0\uC81C\uD558",
    "\uC694\uAE08\uC774",
    "\uBE44\uC6A9\uC774",
    "\uAE08\uC561\uC744",
    "\uB3C8\uC744",
    "\uB3C8 \uB0B4",
    "\uCCAD\uAD6C\uB410",
    "\uCCAD\uAD6C\uB418",
    "\uCC28\uAC10",
    "\uACF5\uC81C",
    "\uC120\uACB0\uC81C",
    "\uD604\uAE08\uC73C\uB85C"
  ];
  var NEG_CUE = [
    "\uBB34\uB8CC",
    "\uACF5\uC9DC",
    "\uC5C6\uC5C8",
    "\uC5C6\uC5B4\uC694",
    "\uC5C6\uC2B5\uB2C8\uB2E4",
    "\uC5C6\uACE0",
    "\uC5C6\uB294",
    "\uC548 \uBC1B",
    "\uC548\uBC1B",
    "\uD3EC\uD568\uB418\uC5B4",
    "\uD3EC\uD568\uB3FC",
    "\uD3EC\uD568\uC774\uB77C",
    "\uD3EC\uD568\uC774\uC5C8",
    "\uD3EC\uD568\uD574\uC11C",
    "\uC81C\uACF5",
    "\uC11C\uBE44\uC2A4\uB85C",
    "\uB530\uB85C \uC548",
    "\uCD94\uAC00 \uC694\uAE08 \uC5C6",
    "\uCD94\uAC00\uC694\uAE08 \uC5C6",
    "\uBD80\uB2F4 \uC5C6",
    // 2026-09-24 추가
    "\uBB34\uC0C1",
    "\uD3EC\uD568\uB41C",
    "\uD3EC\uD568\uC785\uB2C8\uB2E4",
    "\uD3EC\uD568\uC774\uC5D0\uC694",
    "0\uC6D0"
  ];
  var WINDOW = 30;
  var SENT_SPLIT = /(?<=[.!?。])\s+|\n+/;
  var HOTEL_REPLY_RE = /리뷰를?\s*남겨\s*주셔서\s*감사|소중한\s*(?:의견|후기|리뷰)|이용해\s*주(?:셔서|시고)\s*(?:진심으로\s*)?감사|저희\s*(?:호텔|숙소|리조트)|다시\s*뵙기를\s*(?:기대|희망)|(?:총지배인|매니저|호텔)\s*드림|thank you for (?:your (?:review|stay)|choosing)/i;
  var KO_TABLES = {
    feeKeywords: FEE_KEYWORDS,
    amenityTypes: AMENITY_TYPES,
    costContextRe: COST_CONTEXT_RE,
    costCue: COST_CUE,
    negCue: NEG_CUE,
    window: WINDOW,
    sentSplit: SENT_SPLIT,
    hotelReplyRe: HOTEL_REPLY_RE,
    caseInsensitive: false
  };
  function matchable(s, t) {
    if (!t.caseInsensitive) return s;
    const lower = s.toLowerCase();
    return lower.length === s.length ? lower : s;
  }
  function isHotelReplyWith(text, t) {
    return t.hotelReplyRe.test(text);
  }
  function splitSentencesWith(text, t) {
    return (text || "").split(t.sentSplit).map((s) => s.trim()).filter(Boolean);
  }
  function findFeeHitsWith(sentence, t) {
    const hay = matchable(sentence, t);
    const hasCostContext = t.costContextRe.test(sentence);
    const hits = [];
    for (const feeType of Object.keys(t.feeKeywords)) {
      if (t.amenityTypes.has(feeType) && !hasCostContext) continue;
      const words = [...t.feeKeywords[feeType]].sort((a, b) => b.length - a.length);
      for (const w of words) {
        const i = hay.indexOf(t.caseInsensitive ? w.toLowerCase() : w);
        if (i >= 0) {
          hits.push({ feeType, keyword: w, pos: i });
          break;
        }
      }
    }
    return hits;
  }
  function cuesNear(sentence, pos, kwLen, cues, t) {
    const lo = Math.max(0, pos - t.window);
    const hi = Math.min(sentence.length, pos + kwLen + t.window);
    const scope = matchable(sentence.slice(lo, hi), t);
    return cues.filter((c) => scope.includes(t.caseInsensitive ? c.toLowerCase() : c));
  }
  function judgeWith(sentence, keyword, pos, t) {
    const costCues = cuesNear(sentence, pos, keyword.length, t.costCue, t);
    const negCues = cuesNear(sentence, pos, keyword.length, t.negCue, t);
    if (costCues.length && !negCues.length) return { verdict: "mention", costCues, negCues };
    if (negCues.length && !costCues.length) return { verdict: "negated", costCues, negCues };
    return { verdict: "ambiguous", costCues, negCues };
  }
  function ruleConfidence(verdict, nCost, nNeg) {
    if (verdict === "ambiguous") return nCost + nNeg === 0 ? 0.15 : 0.35;
    const strong = Math.max(nCost, nNeg);
    return Math.min(0.9, 0.55 + 0.12 * strong);
  }
  function createRuleAnalyzer(name, langs, t) {
    return {
      name,
      stage: "rule",
      langs,
      // prev 를 이어받아야 한다. runPipeline 은 분석기를 차례로 돌리며 앞 층의 후보를
      // 넘기는데(candidates = a.analyze(scoped, candidates)), 이걸 무시하면 두 번째
      // 규칙층(en)이 첫 번째(ko)의 후보를 통째로 버린다 — 실측: Trip.com 240건에서
      // ko 후보 3건이 사라지고 en 8건만 남아 한국어 모델이 한 번도 호출되지 않았다.
      analyze(input, prev = []) {
        const out = [...prev];
        for (const r of input.reviews) {
          if (r.isHotelReply || isHotelReplyWith(r.text, t)) continue;
          for (const sentence of splitSentencesWith(r.text, t)) {
            for (const { feeType, keyword, pos } of findFeeHitsWith(sentence, t)) {
              const { verdict, costCues, negCues } = judgeWith(sentence, keyword, pos, t);
              const confidence = ruleConfidence(verdict, costCues.length, negCues.length);
              const reason = verdict === "ambiguous" ? costCues.length && negCues.length ? `\uBE44\uC6A9 \uB2E8\uC11C(${costCues.join("\xB7")})\uC640 \uBB34\uB8CC \uB2E8\uC11C(${negCues.join("\xB7")})\uAC00 \uD568\uAED8 \uC788\uC5B4 \uADDC\uCE59\uC73C\uB85C\uB294 \uBABB \uAC00\uB984` : "\uD0A4\uC6CC\uB4DC \uC8FC\uBCC0\uC5D0 \uD310\uB2E8 \uB2E8\uC11C\uAC00 \uC5C6\uC74C" : verdict === "mention" ? `\uBE44\uC6A9 \uB2E8\uC11C: ${costCues.join("\xB7")}` : `\uBB34\uB8CC \uB2E8\uC11C: ${negCues.join("\xB7")}`;
              out.push({
                reviewIndex: r.index,
                sentence,
                feeType,
                keyword,
                keywordPos: pos,
                costCues,
                negCues,
                notes: [{ by: name, stage: "rule", verdict, confidence, reason }],
                verdict,
                confidence,
                decidedBy: name
              });
            }
          }
        }
        return out;
      }
    };
  }
  var isHotelReply = (text) => isHotelReplyWith(text, KO_TABLES);
  var ruleAnalyzer = createRuleAnalyzer("rule-baseline", ["ko"], KO_TABLES);

  // rulesEn.ts
  var FEE_KEYWORDS_EN = {
    \uC8FC\uCC28: ["parking fee", "parking charge", "self-parking", "self parking", "valet parking", "valet fee", "overnight parking", "parking"],
    \uB9AC\uC870\uD2B8\uD53C: ["resort fee", "resort charge", "destination fee", "amenity fee", "facility fee"],
    \uBCF4\uC99D\uAE08: ["security deposit", "incidental deposit", "deposit hold", "hold on my card", "authorization hold", "deposit"],
    \uB3C4\uC2DC\uC138: ["city tax", "tourist tax", "occupancy tax", "tourism fee", "local tax", "visitor levy"],
    \uCCAD\uC18C\uBE44: ["cleaning fee", "housekeeping fee"],
    \uC870\uC2DD: ["breakfast buffet", "continental breakfast", "breakfast"],
    \uC778\uC6D0\uCD94\uAC00: ["extra person", "additional guest", "per person charge", "extra guest fee", "third person"],
    \uC138\uAE08\uC218\uC218\uB8CC: ["taxes and fees", "tax and fees", "service charge", "surcharge", "booking fee", "resort tax", "tax", "fees"],
    \uAE30\uD0C0\uD604\uC7A5\uACB0\uC81C: ["charged at check-in", "charged on arrival", "pay at the property", "paid on site", "pay on arrival", "charged at the front desk"]
  };
  var AMENITY_TYPES_EN = /* @__PURE__ */ new Set(["\uC870\uC2DD", "\uC8FC\uCC28", "\uC138\uAE08\uC218\uC218\uB8CC"]);
  var COST_CONTEXT_RE_EN = /fee|charge|charged|price|cost|pay|paid|billed|deposit|surcharge|free|complimentary|included|extra|additional|separate|per night|per day|[$€£]\s*\d|\d+\s*(?:usd|eur|gbp|dollars?|euros?)/i;
  var COST_CUE_EN = [
    "not included",
    "not inclusive",
    "excluded",
    "on top of",
    "in addition to",
    "extra",
    "additional",
    "separate",
    "separately",
    "surcharge",
    "hidden",
    "charged",
    "charge",
    "charges",
    "billed",
    "they charged",
    "had to pay",
    "have to pay",
    "must pay",
    "required to pay",
    "made us pay",
    "paid extra",
    "cost us",
    "per night",
    "per day",
    "per person",
    "added to",
    "tacked on",
    "upcharge",
    "mandatory",
    "non-optional",
    "$",
    "usd",
    "eur",
    "gbp"
  ];
  var NEG_CUE_EN = [
    "free",
    "complimentary",
    "no charge",
    "no fee",
    "no extra",
    "no additional",
    "at no cost",
    "included",
    "inclusive",
    "was included",
    "comes with",
    "provided",
    "on the house",
    "waived",
    "did not charge",
    "didn't charge",
    "no hidden",
    "without any charge",
    "gratis"
  ];
  var SENT_SPLIT_EN = /(?<!\bMr)(?<!\bMrs)(?<!\bMs)(?<!\bDr)(?<!\bSt)(?<!\bJr)(?<!\bSr)(?<!\bvs)(?<!\betc)(?<!\ba\.m)(?<!\bp\.m)(?<!\bU\.S)(?<=[.!?])\s+(?=[A-Z"'(])|\n+/;
  var HOTEL_REPLY_RE_EN = /thank you for (?:your (?:review|stay|feedback)|choosing|taking the time)|we (?:appreciate|value) your (?:feedback|review|comments)|we (?:hope|look forward) to (?:welcome|see|serve) you|(?:general manager|guest relations|front office manager)|on behalf of (?:the|our) (?:entire )?team/i;
  var EN_TABLES = {
    feeKeywords: FEE_KEYWORDS_EN,
    amenityTypes: AMENITY_TYPES_EN,
    costContextRe: COST_CONTEXT_RE_EN,
    costCue: COST_CUE_EN,
    negCue: NEG_CUE_EN,
    // 영어는 한 단어가 길어 한국어(25자)보다 창을 넓게 잡는다.
    window: 60,
    sentSplit: SENT_SPLIT_EN,
    hotelReplyRe: HOTEL_REPLY_RE_EN,
    caseInsensitive: true
  };
  var ruleAnalyzerEn = createRuleAnalyzer("rule-baseline-en", ["en"], EN_TABLES);

  // recency.ts
  function parseReviewDate(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const ko = s.match(/(\d{4})\s*[년.\/-]\s*(\d{1,2})(?:\s*[월.\/-]\s*(\d{1,2}))?/);
    if (ko) {
      const y = Number(ko[1]), m = Number(ko[2]), d = ko[3] ? Number(ko[3]) : 1;
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        const dt2 = new Date(y, m - 1, d);
        return Number.isNaN(dt2.getTime()) ? null : dt2;
      }
    }
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(" ", "T") : s;
    const dt = new Date(iso);
    if (!Number.isNaN(dt.getTime())) return dt;
    if (/^\d{10}(\d{3})?$/.test(s)) {
      const n = Number(s);
      return new Date(s.length === 10 ? n * 1e3 : n);
    }
    return null;
  }
  var RECENT_DAYS = 365;
  function isRecent(raw, now = /* @__PURE__ */ new Date(), days = RECENT_DAYS) {
    const d = parseReviewDate(raw);
    if (!d) return null;
    const age = (now.getTime() - d.getTime()) / 864e5;
    return age >= -1 && age <= days + 1;
  }

  // modelAnalyzer.ts
  function createModelAnalyzer(opts = {}) {
    const {
      endpoint,
      lang = "ko",
      langs = [lang],
      threshold = 0.5,
      batchSize = 50,
      optional = true,
      timeoutMs = 8e3,
      maxSentences = 50
    } = opts;
    return {
      // 언어가 달라도 이름은 같다 — 패널·게이트가 이 문자열로 층을 알아본다.
      name: "cost-model",
      stage: "model",
      langs,
      async analyze(input, prev) {
        if (!endpoint) return prev;
        const guest = input.reviews.filter((r) => !r.isHotelReply);
        const mine = new Set(guest.map((r) => r.index));
        const byIndex = new Map(guest.map((r) => [r.index, r]));
        let targets = prev.map((c, i) => ({ c, i })).filter(({ c }) => mine.has(c.reviewIndex) && c.sentence.trim());
        if (!targets.length) return prev;
        if (targets.length > maxSentences) {
          const now = /* @__PURE__ */ new Date();
          const rank = ({ c }) => {
            const r = byIndex.get(c.reviewIndex);
            const recent = r ? isRecent(r.date, now) : null;
            const low = r?.rating != null && r.rating / (r.ratingScale ?? 10) <= 0.6;
            return (c.verdict === "ambiguous" ? 0 : 4) + (recent ? 0 : 2) + (low ? 0 : 1);
          };
          targets = targets.map((t) => ({ t, k: rank(t) })).sort((a, b) => a.k - b.k || a.t.i - b.t.i).slice(0, maxSentences).map(({ t }) => t).sort((a, b) => a.i - b.i);
        }
        const results = [];
        try {
          for (let i = 0; i < targets.length; i += batchSize) {
            const chunk = targets.slice(i, i + batchSize);
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), timeoutMs);
            let res;
            try {
              res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ texts: chunk.map(({ c }) => c.sentence), lang }),
                signal: ac.signal
              });
            } finally {
              clearTimeout(timer);
            }
            if (!res.ok) throw new Error(`\uC11C\uBC84 \uC751\uB2F5 ${res.status}`);
            const json = await res.json();
            results.push(...json.results);
          }
        } catch (e) {
          if (!optional) throw e;
          const timedOut = e instanceof DOMException && e.name === "AbortError";
          console.warn(
            timedOut ? `[cost-model:${lang}] ${timeoutMs}ms \uC548\uC5D0 \uC751\uB2F5\uC774 \uC5C6\uC5B4 \uAC74\uB108\uB701\uB2C8\uB2E4(\uC11C\uBC84\uAC00 \uC790\uACE0 \uC788\uC744 \uC218 \uC788\uC74C)` : `[cost-model:${lang}] \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD558\uC9C0 \uBABB\uD574 \uAC74\uB108\uB701\uB2C8\uB2E4:`,
            timedOut ? "" : e
          );
          return prev;
        }
        const out = [...prev];
        targets.forEach(({ c, i }, k) => {
          const hit = results[k];
          if (!hit) return;
          const isCost = hit.prob >= threshold;
          const confidence = isCost ? hit.prob : 1 - hit.prob;
          out[i] = {
            ...c,
            notes: [
              ...c.notes,
              {
                by: "cost-model",
                stage: "model",
                verdict: isCost ? "mention" : "negated",
                confidence,
                reason: `\uD559\uC2B5 \uBAA8\uB378(${lang}) \uBE44\uC6A9 \uD655\uB960 ${(hit.prob * 100).toFixed(0)}%`
              }
            ]
          };
        });
        return out;
      }
    };
  }
  var modelAnalyzer = createModelAnalyzer();

  // lang.ts
  var HANGUL = /[가-힣ᄀ-ᇿ]/g;
  var KANA = /[぀-ゟ゠-ヿ]/g;
  var HAN = /[一-鿿]/g;
  var LATIN = /[A-Za-z]/g;
  function count(s, re) {
    return (s.match(re) ?? []).length;
  }
  function detectLang(text) {
    const s = (text || "").slice(0, 400);
    const letters = count(s, HANGUL) + count(s, KANA) + count(s, HAN) + count(s, LATIN);
    if (letters < 5) return "other";
    const hangul = count(s, HANGUL) / letters;
    const kana = count(s, KANA) / letters;
    const han = count(s, HAN) / letters;
    const latin = count(s, LATIN) / letters;
    if (hangul > 0.15) return "ko";
    if (kana > 0.05) return "ja";
    if (han > 0.3) return "zh";
    if (latin > 0.5) return "en";
    return "other";
  }
  var TRANSLATIONESE = [
    "\uCF54\uC2A4\uD30C",
    "\uB77C\uACE0 \uC0DD\uAC01\uD588\uC2B5\uB2C8\uB2E4",
    "\uC0DD\uAC01\uD569\uB2C8\uB2E4\uB9CC",
    "\uD574 \uC8FC\uC168\uC2B5\uB2C8\uB2E4",
    "\uC774\uC5C8\uC2B5\uB2C8\uB2E4\uB9CC",
    "\uB9E4\uC6B0 \uC88B\uC558\uC2B5\uB2C8\uB2E4",
    "\uB290\uB08C\uC774\uC5C8\uC2B5\uB2C8\uB2E4",
    "\uC774\uB77C\uACE0 \uB290\uAF08\uC2B5\uB2C8\uB2E4"
  ];
  function looksTranslated(text) {
    const s = text || "";
    return TRANSLATIONESE.filter((t) => s.includes(t)).length >= 2;
  }
  function routeByLang(reviews, supported = ["ko"]) {
    const breakdown = { ko: 0, en: 0, ja: 0, zh: 0, other: 0 };
    const analyzable = [];
    const unsupported = [];
    let translatedCount = 0;
    for (const r of reviews) {
      const lang = r.lang ?? detectLang(r.text);
      breakdown[lang] += 1;
      const tagged = { ...r, lang };
      if (looksTranslated(r.text)) translatedCount += 1;
      if (supported.includes(lang)) analyzable.push(tagged);
      else unsupported.push(tagged);
    }
    return { analyzable, unsupported, breakdown, translatedCount };
  }

  // pageClaims.ts
  var FACILITY_WORDS = [
    "\uC218\uC601\uC7A5",
    "\uC0AC\uC6B0\uB098",
    "\uC2A4\uD30C",
    "\uD53C\uD2B8\uB2C8\uC2A4",
    "\uD5EC\uC2A4\uC7A5",
    "\uC9D0",
    "\uC138\uD0C1",
    "\uB4DC\uB77C\uC774 \uD074\uB9AC\uB2DD",
    "\uBBF8\uB2C8\uBC14",
    "\uC640\uC774\uD30C\uC774",
    "Wi-Fi",
    "\uC9D0 \uBCF4\uAD00",
    "\uC154\uD2C0",
    "\uC695\uD0D5",
    "\uC628\uCC9C",
    "\uD68C\uC758\uC2E4",
    "\uB77C\uC6B4\uC9C0",
    "\uC8FC\uBC29",
    "\uBC14\uBE44\uD050",
    "BBQ"
  ];
  var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  var alternation = (words) => [...new Set(words)].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  var FEE_WORD = alternation([...Object.values(KO_TABLES.feeKeywords).flat(), ...FACILITY_WORDS]);
  var PAID_CUE = "\uC720\uB8CC|\uBCC4\uB3C4\\s*(?:\uC694\uAE08|\uACB0\uC81C|\uBD80\uACFC|\uBE44\uC6A9)|\uD604\uC7A5\\s*(?:\uACB0\uC81C|\uC9C0\uBD88|\uC9D5\uC218)|\uCD94\uAC00\\s*(?:\uC694\uAE08|\uBE44\uC6A9|\uAE08\uC561)|\uBD88\uD3EC\uD568|\uBBF8\uD3EC\uD568|\uD3EC\uD568\uB418\uC9C0\\s*\uC54A|\uD3EC\uD568\\s*(?:\uC548|\uC544\uB2C8)|\uBD80\uACFC|\uCCAD\uAD6C|\uACB0\uC81C\\s*(?:\uD544\uC694|\uD574\uC57C)|\uC694\uAE08\uC774\\s*(?:\uBC1C\uC0DD|\uC788)|\uC694\uAE08\\s*:|\uBCC4\uB3C4\\s*[.)]?\\s*$";
  var MONEY = "(?:KRW|\u20A9|USD|\\$|\u20AC|\xA5|\xA3)\\s*\\d[\\d,.]*|\\d[\\d,.]*\\s*(?:\uC6D0|\uB9CC\uC6D0|\uCC9C\uC6D0|\uB2EC\uB7EC|\uC704\uC548|\uC5D4|\uBC14\uD2B8|\uC720\uB85C)";
  var OFFICIAL_RE = /무료\s*(?:주차|와이파이|Wi-?Fi|조식|취소|셔틀)|조식\s*(?:포함|무료)|주차\s*(?:무료|가능)|세금\s*및\s*수수료\s*포함|추가\s*요금\s*없음|전\s*객실\s*금연/gi;
  var DISCLOSED_RE = new RegExp(
    `(?:${FEE_WORD})[^\\n]{0,25}?(?:${PAID_CUE}|${MONEY})|(?:${PAID_CUE}|${MONEY})[^\\n]{0,25}?(?:${FEE_WORD})`,
    "gi"
  );
  var PAID_WORD_RE = new RegExp(PAID_CUE, "i");
  var MONEY_RE = new RegExp(MONEY, "i");
  var FREE_CUE_RE = /무료|공짜|포함(?!되지|\s*안|\s*아니)/;
  var NEG_ADJACENT_RE = /(?:추가\s*(?:요금|비용|금액)|별도\s*(?:요금|비용)|부과|청구)\s*(?:은|는|이|가|도)?\s*(?:없|않)/;
  var NEG_ABSENT_RE = /안내(?:되어)?\s*있지\s*않|명시(?:되어)?\s*있지\s*않|조건이\s*안내|정보(?:가|는)?\s*없/;
  var ROOM_TITLE_RE = /디럭스|스위트|트윈룸|더블룸|싱글룸|스탠다드|슈페리어|이그제큐티브|프리미어|패밀리룸|온돌|스튜디오/;
  var PAID_VERB_RE = /부과|청구|지불|결제|발생|대여|유료|내야|받습니다|징수/;
  var REWARD_RE = /크레딧|적립|할인|쿠폰|캐시백|상당|포인트|마일리지|티머니/;
  function looksPaid(claim) {
    if (NEG_ADJACENT_RE.test(claim) || NEG_ABSENT_RE.test(claim)) return false;
    if (ROOM_TITLE_RE.test(claim) && !PAID_VERB_RE.test(claim)) return false;
    if (PAID_WORD_RE.test(claim)) return true;
    return MONEY_RE.test(claim) && !FREE_CUE_RE.test(claim) && !REWARD_RE.test(claim);
  }
  var DISCLOSED_TEST_RE = new RegExp(DISCLOSED_RE.source, "i");
  var SEGMENT_SPLIT = /\n+|\s*[·•|]\s*|(?<=[.!?。])\s+/;
  function extractClaims(text) {
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const official = (text.match(OFFICIAL_RE) ?? []).map(norm);
    const disclosed = [];
    for (const raw of text.split(SEGMENT_SPLIT)) {
      const seg = norm(raw);
      if (seg.length < 4 || seg.length > 160) continue;
      if (DISCLOSED_TEST_RE.test(seg) && looksPaid(seg)) disclosed.push(seg);
    }
    return Array.from(/* @__PURE__ */ new Set([...official, ...disclosed])).slice(0, 30);
  }
  var DISCLOSED_TO_FEE = Object.keys(KO_TABLES.feeKeywords).map(
    (ft) => [
      new RegExp(alternation([...KO_TABLES.feeKeywords[ft], ...ft === "\uAE30\uD0C0\uD604\uC7A5\uACB0\uC81C" ? FACILITY_WORDS : []]), "i"),
      ft
    ]
  );

  // collect.ts
  var DATE_PATTERNS = [
    /\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?/,
    /\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}/,
    /\d{1,2}\s*월\s*\d{4}/,
    /\d+\s*(?:일|주|개월|달|년)\s*전/,
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}/i,
    /\d+\s+(?:days?|weeks?|months?|years?)\s+ago/i
  ];
  var hasDate = (t) => DATE_PATTERNS.some((re) => re.test(t));
  var findDate = (t) => {
    for (const re of DATE_PATTERNS) {
      const m = t.match(re);
      if (m) return m[0].trim();
    }
    return null;
  };
  var RATING_PATTERNS = [
    [/별점\s*([\d.]+)\s*점/, null],
    [/([\d.]+)\s*(?:점|점\s*만점에|\/\s*10|out of 10)/i, 10],
    [/([\d.]+)\s*(?:\/\s*5|out of 5|stars?)/i, 5],
    [/rating[:\s]+([\d.]+)/i, null]
  ];
  function findRating(el) {
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
  var MIN_BODY_LEN = 15;
  var MAX_BODY_LEN = 4e3;
  var MIN_CARDS = 3;
  function ownText(el) {
    let s = "";
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.nodeValue ?? "";
    return s.trim();
  }
  function extractBody(card) {
    let best = "";
    for (const n of Array.from(card.querySelectorAll("*"))) {
      const raw = n.children.length === 0 ? n.textContent ?? "" : ownText(n);
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
  var PRICE_RE = /₩|\$|\d{1,3}(?:,\d{3})+\s*원?/;
  var CTA_RE = /예약하기|지금\s*예약|객실\s*(?:보기|선택)|선택하기|장바구니|담기|book now|select room|reserve now/i;
  function reviewnessOf(kids) {
    let rating = 0, prose = 0, price = 0, cta = 0;
    for (const k of kids) {
      const t = (k.innerText || "").trim();
      if (findRating(k)) rating++;
      if (/[.!?。]/.test(t) || t.length >= 80) prose++;
      if (PRICE_RE.test(t)) price++;
      if (CTA_RE.test(t)) cta++;
    }
    const n = Math.max(1, kids.length);
    return rating / n * 2 + prose / n * 2 - price / n * 1.5 - cta / n * 2;
  }
  function looksLikeCard(node) {
    const t = (node.innerText || "").trim();
    if (t.length < MIN_BODY_LEN || t.length > MAX_BODY_LEN) return false;
    return hasDate(t);
  }
  function depthOf(el) {
    let d = 0;
    for (let n = el; n; n = n.parentElement) d++;
    return d;
  }
  function scoreContainer(el) {
    const kids = Array.from(el.children);
    if (kids.length < MIN_CARDS) return null;
    const ok = kids.filter(looksLikeCard).length;
    if (ok < MIN_CARDS || ok < kids.length / 2) return null;
    return { el, ok, reviewness: reviewnessOf(kids), depth: depthOf(el) };
  }
  function findReviewContainer(root = document) {
    const cands = [];
    for (const el of Array.from(root.querySelectorAll("ul,ol,div,section"))) {
      const c = scoreContainer(el);
      if (c) cands.push(c);
    }
    cands.sort((a, b) => b.reviewness - a.reviewness || b.ok - a.ok || b.depth - a.depth);
    return cands[0]?.el ?? null;
  }
  function extractFrom(container) {
    const out = [];
    const kids = Array.from(container.children);
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
        isHotelReply: isHotelReply(text)
      });
    });
    return out;
  }
  function collectOfficialClaims() {
    const text = document.body?.innerText ?? "";
    return extractClaims(text);
  }
  var wait = (ms) => new Promise((r) => setTimeout(r, ms));
  var MORE_RE = /^\s*(?:더\s*보기|더보기|자세히\s*보기|read\s*more|show\s*more)\s*$/i;
  async function expandTruncated(container) {
    const btns = Array.from(
      container.querySelectorAll("button,a,span[role='button']")
    ).filter((b) => MORE_RE.test(b.innerText || ""));
    for (const b of btns) {
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    if (btns.length) await wait(200);
    return btns.length;
  }
  function scrollableAncestor(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const ov = getComputedStyle(n).overflowY;
      if ((ov === "auto" || ov === "scroll") && n.scrollHeight > n.clientHeight + 40) return n;
    }
    return null;
  }
  async function nudgeLazyLoad(container, rounds = 6) {
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
    box.scrollTop = original;
  }
  var OPEN_SPECIFIC_RE = /후기\s*[\d,]*\s*개?\s*(?:모두|전체)|리뷰\s*[\d,]*\s*개?\s*(?:모두|전체)|모든\s*(?:후기|리뷰)|(?:후기|리뷰)\s*(?:전체|더\s*보기)|(?:show|read|see)\s+all.*reviews?/i;
  var OPEN_GENERIC_RE = /^\s*(?:모두\s*보기|전체\s*보기|더\s*보기|see\s+all|show\s+all|view\s+all)\s*$/i;
  var REVIEW_CONTEXT_RE = /이용후기|후기|리뷰|평점|reviews?\b/i;
  var CONTEXT_MAX_TEXT = 1200;
  function nearReviewContext(el, levels = 4) {
    let n = el;
    for (let i = 0; i < levels; i++) {
      n = n?.parentElement ?? null;
      if (!n || n === document.body || n === document.documentElement) return false;
      const t = n.innerText || "";
      if (t.length > CONTEXT_MAX_TEXT) return false;
      if (REVIEW_CONTEXT_RE.test(t)) return true;
    }
    return false;
  }
  function findOpenButton() {
    const clickable = Array.from(
      document.querySelectorAll('button,a,[role="button"],[role="link"]')
    );
    for (const el of clickable) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (!t || t.length > 40) continue;
      if (OPEN_SPECIFIC_RE.test(t)) return el;
    }
    for (const el of clickable) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (!t || t.length > 20) continue;
      if (OPEN_GENERIC_RE.test(t) && nearReviewContext(el)) return el;
    }
    return null;
  }
  var HIDE_STYLE_ID = "__rvHideModal";
  function hideModals() {
    if (document.getElementById(HIDE_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = HIDE_STYLE_ID;
    s.textContent = `[role="dialog"],[aria-modal="true"]{opacity:0!important;pointer-events:none!important}`;
    document.head.appendChild(s);
  }
  function unhideModals() {
    document.getElementById(HIDE_STYLE_ID)?.remove();
  }
  function findCloseButton(modal) {
    const RE = /^\s*(?:닫기|close|×|✕|x)\s*$/i;
    for (const el of Array.from(modal.querySelectorAll('button,[role="button"]'))) {
      const t = (el.innerText || "").trim();
      const label = el.getAttribute("aria-label") ?? "";
      if (RE.test(t) || RE.test(label)) return el;
    }
    return null;
  }
  async function openFullReviews(before) {
    const btn = findOpenButton();
    if (!btn) return null;
    const beforeSig = pageSignature(before);
    hideModals();
    const scrollY = window.scrollY;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 16; i++) {
      await wait(250);
      const modal = document.querySelector('[role="dialog"],[aria-modal="true"]');
      if (modal && findReviewContainer(modal)) {
        if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
        return modal;
      }
      const now = findReviewContainer(document);
      if (now && (now !== before || pageSignature(now) !== beforeSig || findNextButton(now))) {
        unhideModals();
        if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
        return document.body;
      }
    }
    unhideModals();
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    return null;
  }
  async function closeReviewModal(modal) {
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
  function openDialogs() {
    return Array.from(
      document.querySelectorAll('[role="dialog"],[aria-modal="true"]')
    ).filter((d) => d.isConnected);
  }
  async function closeStrayDialogs(before) {
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
  var NEXT_RE = /^\s*(?:다음|다음\s*페이지|next(?:\s*page)?|›|»|>|＞|⟩|→|▶|▷)\s*$/i;
  var NEXT_LABEL_RE = /다음\s*(?:페이지)?|next\s*(?:page)?/i;
  function searchScopeFor(container, maxUp) {
    let scope = container;
    for (let i = 0; i < maxUp && scope.parentElement; i++) scope = scope.parentElement;
    return scope;
  }
  function isClickable(el) {
    const e = el;
    if (e.disabled || el.getAttribute("aria-disabled") === "true") return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  }
  function findNextButton(container) {
    const scope = searchScopeFor(container, 8);
    for (const el of Array.from(
      scope.querySelectorAll('button,a,[role="button"],[aria-label]')
    )) {
      const t = (el.innerText || "").trim();
      const label = el.getAttribute("aria-label") ?? "";
      const hit = NEXT_RE.test(t) || !!label && NEXT_LABEL_RE.test(label) && t.length <= 6;
      if (!hit || !isClickable(el)) continue;
      return el;
    }
    return null;
  }
  function findPageNumber(container, no) {
    const scope = searchScopeFor(container, 10);
    for (const el of Array.from(
      scope.querySelectorAll('button,a,[role="button"]')
    )) {
      if ((el.innerText || "").trim() !== String(no)) continue;
      if (!isClickable(el)) continue;
      return el;
    }
    return null;
  }
  function pageSignature(container) {
    return Array.from(container.children).slice(0, 5).map((c) => (c.innerText || "").slice(0, 40)).join("|");
  }
  async function waitForPageChange(refind, container, before, tries = 20) {
    for (let i = 0; i < tries; i++) {
      await wait(250);
      let c = container;
      if (!c.isConnected || !c.children.length) {
        c = refind();
        if (!c) continue;
      }
      const now = pageSignature(c);
      if (now && now !== before) {
        await wait(400);
        return c.isConnected ? c : refind() ?? c;
      }
    }
    return null;
  }
  function dedupe(reviews) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const r of reviews) {
      const sig = r.text.slice(0, 80);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ ...r, index: out.length });
    }
    return out;
  }
  async function autoCollect(opts = {}) {
    const {
      onProgress,
      signal,
      maxPages = 40,
      budgetMs = 15e4,
      restorePage = true,
      useModal = true
    } = opts;
    const started = Date.now();
    const overBudget = () => Date.now() - started > budgetMs;
    const emit = (rs, p) => onProgress?.(rs, p);
    const dialogsAtStart = openDialogs();
    let container = findReviewContainer();
    if (!container) {
      emit([], "empty");
      return [];
    }
    const modalRoot = container.closest('[role="dialog"],[aria-modal="true"]');
    const all = [];
    const push = () => {
      all.push(...extractFrom(container));
      return dedupe(all);
    };
    let reviews = push();
    emit(reviews, "dom");
    if (signal?.aborted) return reviews;
    await expandTruncated(container);
    if (signal?.aborted) return reviews;
    all.length = 0;
    reviews = push();
    emit(reviews, "expand");
    await nudgeLazyLoad(container);
    if (signal?.aborted) return reviews;
    await expandTruncated(container);
    all.length = 0;
    reviews = push();
    emit(reviews, "lazy");
    let modal = modalRoot;
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
    const activeRoot = () => modal?.isConnected ? modal : document;
    const refindHere = () => findReviewContainer(activeRoot());
    let page = 1;
    while (page < maxPages && !signal?.aborted && !overBudget()) {
      const before = pageSignature(container);
      const btn = findNextButton(container) ?? findPageNumber(container, page + 1);
      if (!btn) break;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const next = await waitForPageChange(refindHere, container, before);
      if (!next) break;
      container = next;
      page += 1;
      await expandTruncated(container);
      reviews = push();
      emit(reviews, "page");
    }
    if (restorePage && page > 1) {
      const first = findPageNumber(container, 1);
      if (first) {
        const before = pageSignature(container);
        first.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitForPageChange(refindHere, container, before, 8);
        emit(reviews, "restore");
      }
    }
    if (modal && modal !== modalRoot && modal !== document.body) await closeReviewModal(modal);
    await closeStrayDialogs(dialogsAtStart);
    emit(reviews, "done");
    return reviews;
  }
  function watchPage(onChange) {
    let lastUrl = location.href;
    let timer;
    const fire = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onChange, 600);
    };
    const check = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      fire();
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    const iv = window.setInterval(check, 1e3);
    return () => {
      mo.disconnect();
      window.clearInterval(iv);
      window.clearTimeout(timer);
    };
  }

  // analyze.ts
  var MIN_DISTINCT_REVIEWS = 2;
  var RECENT_WINDOW = 20;
  function resolve(c) {
    let best = c.notes[0];
    if (!best) return c;
    for (const n of c.notes.slice(1)) {
      if (n.confidence >= 0.5 || best.verdict === "ambiguous") best = n;
    }
    return { ...c, verdict: best.verdict, confidence: best.confidence, decidedBy: best.by };
  }
  function aggregate(candidates, officialClaims, reviews = []) {
    const byIndex = /* @__PURE__ */ new Map();
    for (const r of reviews) byIndex.set(r.index, r);
    const now = /* @__PURE__ */ new Date();
    const recentOf = (idx) => {
      const rv = byIndex.get(idx);
      const byDate = rv ? isRecent(rv.date, now) : null;
      return byDate ?? idx < RECENT_WINDOW;
    };
    const lowRating = (idx) => {
      const rv = byIndex.get(idx);
      if (rv?.rating == null) return false;
      const scale = rv.ratingScale ?? 10;
      return rv.rating / scale <= 0.6;
    };
    const mentions = candidates.filter((c) => c.verdict === "mention");
    const byType = /* @__PURE__ */ new Map();
    for (const c of mentions) {
      const arr = byType.get(c.feeType) ?? [];
      arr.push(c);
      byType.set(c.feeType, arr);
    }
    const items = [];
    for (const [feeType, evidence] of byType) {
      const distinct = new Set(evidence.map((c) => c.reviewIndex));
      const recent = new Set(evidence.filter((c) => recentOf(c.reviewIndex)).map((c) => c.reviewIndex));
      const rank = (c) => (recentOf(c.reviewIndex) ? 0 : 2) + (lowRating(c.reviewIndex) ? 0 : 1);
      evidence.sort((a, b) => rank(a) - rank(b) || a.reviewIndex - b.reviewIndex);
      const conflict = findConflict(feeType, officialClaims);
      const disclosed = conflict ? null : findDisclosed(feeType, officialClaims);
      const passes = distinct.size >= MIN_DISTINCT_REVIEWS;
      const shown = passes && !disclosed;
      items.push({
        feeType,
        reviewCount: distinct.size,
        recentCount: recent.size,
        evidence,
        pageConflict: conflict,
        pageDisclosed: disclosed,
        shown,
        shownReason: disclosed ? "\uD398\uC774\uC9C0\uC5D0 \uC774\uBBF8 \uC548\uB0B4\uB41C \uBE44\uC6A9" : passes ? `\uC11C\uB85C \uB2E4\uB978 \uB9AC\uBDF0 ${distinct.size}\uAC74` : `\uB9AC\uBDF0 ${distinct.size}\uAC74 \u2014 \uB178\uCD9C \uAE30\uC900(${MIN_DISTINCT_REVIEWS}\uAC74) \uBBF8\uB2EC`
      });
    }
    items.sort(
      (a, b) => Number(b.shown) - Number(a.shown) || Number(!!b.pageConflict) - Number(!!a.pageConflict) || b.recentCount - a.recentCount || b.reviewCount - a.reviewCount
    );
    return items;
  }
  var CLAIM_TO_FEE = [
    [/무료\s*주차|주차\s*무료/, "\uC8FC\uCC28"],
    [/조식\s*(?:포함|무료)/, "\uC870\uC2DD"],
    [/세금\s*및\s*수수료\s*포함/, "\uC138\uAE08\uC218\uC218\uB8CC"]
  ];
  function findConflict(feeType, officialClaims) {
    for (const claim of officialClaims) {
      for (const [re, ft] of CLAIM_TO_FEE) {
        if (ft === feeType && re.test(claim)) return claim;
      }
      if (/추가\s*요금\s*없음/.test(claim)) return claim;
    }
    return null;
  }
  function findDisclosed(feeType, officialClaims) {
    for (const claim of officialClaims) {
      if (!looksPaid(claim)) continue;
      for (const [re, ft] of DISCLOSED_TO_FEE) {
        if (ft === feeType && re.test(claim)) return claim;
      }
    }
    return null;
  }
  async function runPipeline(reviews, officialClaims, opts = {}) {
    const analyzers = opts.analyzers ?? [ruleAnalyzer];
    const supported = opts.supportedLangs ?? ["ko"];
    const guest = reviews.filter((r) => !r.isHotelReply);
    const routing = routeByLang(guest, supported);
    const input = { reviews: routing.analyzable, officialClaims };
    let candidates = [];
    const stagesRun = [];
    for (const a of analyzers) {
      const scoped = a.langs ? { ...input, reviews: input.reviews.filter((r) => a.langs.includes(r.lang ?? "other")) } : input;
      candidates = await a.analyze(scoped, candidates);
      stagesRun.push(a.name);
    }
    candidates = candidates.map(resolve);
    const verdictCounts = { mention: 0, negated: 0, ambiguous: 0 };
    for (const c of candidates) verdictCounts[c.verdict] += 1;
    return {
      totalReviews: guest.length,
      analyzedReviews: routing.analyzable.length,
      langBreakdown: routing.breakdown,
      candidates,
      verdictCounts,
      risks: aggregate(candidates, officialClaims, guest),
      recentDays: RECENT_DAYS,
      officialClaims,
      stagesRun,
      collecting: opts.collecting ?? false
    };
  }
  function emptyInsights(collecting = true) {
    return {
      totalReviews: 0,
      analyzedReviews: 0,
      langBreakdown: { ko: 0, en: 0, ja: 0, zh: 0, other: 0 },
      candidates: [],
      verdictCounts: { mention: 0, negated: 0, ambiguous: 0 },
      risks: [],
      officialClaims: [],
      stagesRun: [],
      collecting
    };
  }

  // controller.ts
  function createReviewController(opts) {
    const { onUpdate, analyzers, supportedLangs, followNavigation = true } = opts;
    let abort = null;
    let stopWatch = null;
    let dead = false;
    async function run() {
      if (dead) return;
      abort?.abort();
      const ac = new AbortController();
      abort = ac;
      onUpdate(emptyInsights(true));
      const official = collectOfficialClaims();
      const analyzeAndEmit = async (reviews2, done) => {
        if (ac.signal.aborted || dead) return;
        const insights = await runPipeline(reviews2, official, {
          analyzers,
          supportedLangs,
          collecting: !done
        });
        if (ac.signal.aborted || dead) return;
        onUpdate(insights);
      };
      let pending = Promise.resolve();
      const reviews = await autoCollect({
        signal: ac.signal,
        onProgress: (rs, phase) => {
          pending = pending.then(() => analyzeAndEmit(rs, phase === "done" || phase === "empty"));
        }
      });
      await pending;
      await analyzeAndEmit(reviews, true);
    }
    run();
    if (followNavigation) {
      stopWatch = watchPage(() => run());
    }
    return {
      refresh: () => void run(),
      destroy: () => {
        dead = true;
        abort?.abort();
        stopWatch?.();
      }
    };
  }

  // panel.ts
  var FEE_LABEL = {
    \uC8FC\uCC28: "\uC8FC\uCC28 \uC720\uB8CC",
    \uB9AC\uC870\uD2B8\uD53C: "\uB9AC\uC870\uD2B8\uD53C",
    \uBCF4\uC99D\uAE08: "\uBCF4\uC99D\uAE08",
    \uB3C4\uC2DC\uC138: "\uB3C4\uC2DC\uC138\xB7\uC219\uBC15\uC138",
    \uCCAD\uC18C\uBE44: "\uCCAD\uC18C\uBE44 \uBCC4\uB3C4",
    \uC870\uC2DD: "\uC870\uC2DD \uBCC4\uB3C4\uACB0\uC81C",
    \uC778\uC6D0\uCD94\uAC00: "\uC778\uC6D0 \uCD94\uAC00\uC694\uAE08",
    \uC138\uAE08\uC218\uC218\uB8CC: "\uC138\uAE08\xB7\uC218\uC218\uB8CC",
    \uAE30\uD0C0\uD604\uC7A5\uACB0\uC81C: "\uD604\uC7A5 \uACB0\uC81C",
    \uC2DC\uC124\uC774\uC6A9: "\uC2DC\uC124 \uC774\uC6A9\uB8CC",
    \uBBF8\uBD84\uB958: "\uCD94\uAC00\uBE44\uC6A9 \uC5B8\uAE09"
    // 모델이 유형까지는 못 가름 (Stage 2 미학습)
  };
  var esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  var STYLE_ID = "rvx-style";
  var STYLE_REV = "2026-09-23-financeui";
  var CSS = `
/* \uBE0C\uB9AC\uD551 \uCE74\uB4DC(briefing.js)\uC640 \uAC19\uC740 \uD1A4. \uC0C9\xB7\uBAA8\uC11C\uB9AC\xB7\uC5EC\uBC31\uC744 \uADF8\uCABD \uD1A0\uD070\uC5D0 \uB9DE\uCD98\uB2E4 \u2014
   \uAC19\uC740 \uCE74\uB4DC \uC548\uC758 \uB450 \uD0ED\uC774 \uC11C\uB85C \uB2E4\uB978 \uB514\uC790\uC778\uC73C\uB85C \uBCF4\uC774\uBA74 \uC548 \uB41C\uB2E4. */
.rvx { font-size: 12.5px; line-height: 1.6; color: #14171c; }
.rvx-head { margin-bottom: 14px; }
.rvx-title { display: none; }
.rvx-sub { font-size: 11.5px; color: #6b7381; margin: 0; line-height: 1.6; }
.rvx-sub b { color: #14171c; font-weight: 700; }

/* \uC22B\uC790 \uD0C0\uC77C 4\uAC1C(\uC218\uC9D1/\uBD84\uC11D/\uBE44\uC6A9\uC2E0\uD638/\uD310\uC815\uBD88\uAC00)\uC640 \uB9C9\uB300\xB7\uBC94\uB840\uB294 \uAC1C\uBC1C \uC911\uC5D0\uB294 \uC720\uC6A9\uD588\uC9C0\uB9CC
   \uC0AC\uC6A9\uC790\uC5D0\uAC8C\uB294 \uC758\uBBF8\uAC00 \uC605\uACE0 \uCE74\uB4DC \uD3ED\uC744 \uD06C\uAC8C \uBA39\uC5B4\uC11C \uAC77\uC5B4\uB0C8\uB2E4(\uC704 \uD55C \uC904 \uBB38\uC7A5\uC774 \uB300\uC2E0\uD55C\uB2E4).
   \uB418\uC0B4\uB9AC\uB824\uBA74 renderInsights \uC758 \uB9C8\uD06C\uC5C5\uACFC \uC774 \uC790\uB9AC\uC758 \uADDC\uCE59\uC744 \uAC19\uC774 \uB418\uB3CC\uB824\uC57C \uD55C\uB2E4. */

/* \uC2E0\uD638 \uBE14\uB85D \u2014 \uC608\uC57D \uC694\uC57D \uD0ED\uC758 \uC0C1\uD0DC \uBE14\uB85D\uACFC \uAC19\uC740 \uBAA8\uC591(\uC5F0\uD55C \uBC14\uD0D5 + \uC5F0\uD55C \uCE69).
   \uB2E4\uB9CC \uCD08\uB85D/\uBE68\uAC15\uC774 \uC544\uB2C8\uB77C \uD669\uD1A0\uC0C9\uC774\uB2E4. \uD655\uC815\uC774 \uC544\uB2C8\uB77C **\uCD94\uC815**\uC774\uB77C\uB294 \uB73B. */
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

/* \uC2E0\uD638 \uC5C6\uC74C \u2014 "\uC5C6\uB2E4"\uAC00 \uC544\uB2C8\uB77C "\uBABB \uCC3E\uC558\uB2E4"\uB85C \uC4F4\uB2E4(\uB2E8\uC815 \uAE08\uC9C0). */
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

/* \uAF2C\uB9AC\uB9D0 \u2014 \uD310\uC815 \uCE35 \uAC19\uC740 \uAC1C\uBC1C\uC6A9 \uBB38\uC790\uC5F4\uC740 \uC0AC\uC6A9\uC790\uC5D0\uAC8C \uBCF4\uC774\uC9C0 \uC54A\uB294\uB2E4(\uC544\uB798 renderInsights \uCC38\uACE0). */
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
  function ensureStyle(el) {
    const root = el.getRootNode?.();
    const isShadow = !!root && root.nodeType === 11 && "host" in root;
    const host = (isShadow ? root : el.ownerDocument.head) ?? el.ownerDocument.documentElement;
    const prev = host.querySelector?.(`#${STYLE_ID}`);
    if (prev && prev.dataset.rev === STYLE_REV) return;
    prev?.remove();
    const s = el.ownerDocument.createElement("style");
    s.id = STYLE_ID;
    s.dataset.rev = STYLE_REV;
    s.textContent = CSS;
    host.appendChild(s);
  }
  function highlight(c) {
    const spans = [{ start: c.keywordPos, end: c.keywordPos + c.keyword.length, cls: "kw" }];
    for (const [cues, cls] of [[c.costCues, "cue"], [c.negCues, "neg"]]) {
      for (const cue of cues) {
        let from = 0;
        for (; ; ) {
          const i = c.sentence.indexOf(cue, from);
          if (i < 0) break;
          spans.push({ start: i, end: i + cue.length, cls });
          from = i + cue.length;
        }
      }
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let pos = 0;
    for (const s of spans) {
      if (s.start < pos) continue;
      out.push(esc(c.sentence.slice(pos, s.start)));
      const inner = esc(c.sentence.slice(s.start, s.end));
      out.push(s.cls === "kw" ? `<mark>${inner}</mark>` : `<span class="${s.cls}">${inner}</span>`);
      pos = s.end;
    }
    out.push(esc(c.sentence.slice(pos)));
    return out.join("");
  }
  var RATE_LEVEL = /* @__PURE__ */ new Map([["\uC870\uC2DD", "\uC870\uC2DD"], ["\uC138\uAE08\uC218\uC218\uB8CC", "\uC138\uAE08\xB7\uC218\uC218\uB8CC"]]);
  function riskRow(r) {
    const label = FEE_LABEL[r.feeType] ?? r.feeType;
    const rateNoun = r.pageConflict ? RATE_LEVEL.get(r.feeType) : void 0;
    const rateLevel = rateNoun !== void 0;
    const cls = ["rvx-risk", r.pageConflict && !rateLevel ? "conflict" : "", r.shown ? "" : "hidden-item"].filter(Boolean).join(" ");
    const conflict = !r.pageConflict ? "" : rateLevel ? `<div class="rvx-why">\uC774 \uC219\uC18C\uC5D4 <b>\u201C${esc(r.pageConflict)}\u201D</b> \uC694\uAE08\uC81C\uB3C4 \uC788\uC5B4\uC694. \uC120\uD0DD\uD55C \uC694\uAE08\uC81C\uC758 ${esc(rateNoun)} \uC870\uAC74\uC744 \uD655\uC778\uD558\uC138\uC694</div>` : `<div class="rvx-why">\u26A0 \uD398\uC774\uC9C0\uC5D0\uB294 <b>\u201C${esc(r.pageConflict)}\u201D</b>\uB77C\uACE0 \uD45C\uAE30\uB3FC \uC788\uC5B4\uC694</div>`;
    const disclosed = r.pageDisclosed ? `<div class="rvx-why">\uD398\uC774\uC9C0\uC5D0 <b>\u201C${esc(r.pageDisclosed)}\u201D</b>\uB85C \uC548\uB0B4\uB3FC \uC788\uC5B4\uC694</div>` : "";
    const seen = /* @__PURE__ */ new Set();
    const ev = r.evidence.filter((c) => !seen.has(c.reviewIndex) && seen.add(c.reviewIndex)).slice(0, 3).map((c) => `<p>${highlight(c)}</p>`).join("");
    return `
<div class="${cls}">
  <div class="rvx-risk-h">
    <b>${esc(label)}</b>
    <span class="rvx-pill ${r.shown ? "" : "mute"}">\uB9AC\uBDF0 ${r.reviewCount}\uAC74</span>
    ${r.recentCount > 0 ? `<span class="rvx-pill mute">\uCD5C\uADFC 1\uB144 ${r.recentCount}\uAC74</span>` : ""}
    ${r.pageConflict ? rateLevel ? '<span class="rvx-pill mute">\uC694\uAE08\uC81C \uD655\uC778</span>' : '<span class="rvx-pill warn">\uD45C\uAE30\uC640 \uB2E4\uB984</span>' : ""}
    ${r.pageDisclosed ? '<span class="rvx-pill mute">\uD398\uC774\uC9C0\uC5D0 \uC548\uB0B4\uB428</span>' : ""}
  </div>
  ${conflict}
  ${disclosed}
  ${r.shown || r.pageDisclosed ? "" : `<div class="rvx-why">${esc(r.shownReason)} \u2014 \uCC38\uACE0\uB85C\uB9CC \uD45C\uC2DC</div>`}
  <div class="rvx-ev">${ev}</div>
</div>`;
  }
  function renderInsights(el, d) {
    ensureStyle(el);
    el.classList.add("rvx");
    if (d.collecting && d.totalReviews === 0) {
      el.innerHTML = `<div class="rvx-empty"><span class="rvx-spin"></span>\uB9AC\uBDF0\uB97C \uC77D\uB294 \uC911\u2026</div>`;
      return;
    }
    if (!d.collecting && d.totalReviews === 0) {
      el.innerHTML = `<div class="rvx-empty">\uC774 \uD398\uC774\uC9C0\uC5D0\uC11C \uB9AC\uBDF0\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC5B4\uC694.<br>
      \uC219\uC18C \uC0C1\uC138 \uD398\uC774\uC9C0\uC778\uC9C0 \uD655\uC778\uD574 \uC8FC\uC138\uC694.</div>`;
      return;
    }
    const shown = d.risks.filter((r) => r.shown);
    const disclosed = d.risks.filter((r) => !r.shown && r.pageDisclosed);
    const hidden = d.risks.filter((r) => !r.shown && !r.pageDisclosed);
    const skipped = d.totalReviews - d.analyzedReviews;
    el.innerHTML = `
<div class="rvx-head">
  <p class="rvx-title">\uB9AC\uBDF0\uC5D0\uC11C \uCC3E\uC740 \uAC83</p>
  <p class="rvx-sub">
    ${d.collecting ? '<span class="rvx-spin"></span>' : ""}
    \uACF5\uAC1C \uB9AC\uBDF0 <b>${d.totalReviews}\uAC74</b> \uC911 \uD55C\uAD6D\uC5B4\xB7\uC601\uC5B4 <b>${d.analyzedReviews}\uAC74</b>\uC744 \uBD84\uC11D\uD588\uC5B4\uC694
  </p>
</div>

${shown.length ? `<div class="rvx-sec">\uCD94\uAC00 \uBE44\uC6A9 \uAC00\uB2A5\uC131</div>${shown.map(riskRow).join("")}` : `<div class="rvx-empty">
        <span class="rvx-check"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#1b7a52" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13l5 5L20 6"></path></svg></span>
        \uBC18\uBCF5\uB418\uB294 \uCD94\uAC00\uBE44\uC6A9 \uC5B8\uAE09\uC774<br>\uBC1C\uACAC\uB418\uC9C0 \uC54A\uC558\uC5B4\uC694
        <small>\uB9AC\uBDF0 ${d.analyzedReviews}\uAC74\uC744 \uC0B4\uD3B4\uBD24\uC5B4\uC694</small>
      </div>`}

${disclosed.length ? `<div class="rvx-sec">\uD398\uC774\uC9C0\uC5D0 \uC774\uBBF8 \uC548\uB0B4\uB41C \uBE44\uC6A9</div>${disclosed.map(riskRow).join("")}` : ""}

${hidden.length ? `<div class="rvx-sec">\uC2E0\uD638\uB294 \uC788\uC9C0\uB9CC \uADFC\uAC70\uAC00 \uBD80\uC871\uD55C \uAC83</div>${hidden.map(riskRow).join("")}` : ""}

<div class="rvx-foot" title="\uD310\uC815 \uCE35: ${d.stagesRun.join(" \u2192 ") || "\uC5C6\uC74C"}">
  \uC11C\uB85C \uB2E4\uB978 \uB9AC\uBDF0 <b>${MIN_TEXT}\uAC74 \uC774\uC0C1</b>\uC77C \uB54C\uB9CC \uC54C\uB824\uB4DC\uB824\uC694. \uD55C \uBA85\uB9CC \uACAA\uC740 \uC77C\uC740 \uC219\uC18C \uC804\uCCB4\uC758 \uBB38\uC81C\uAC00 \uC544\uB2D0 \uC218 \uC788\uC5B4\uC11C\uC608\uC694.<br>
  \uC774 \uAC12\uC740 \uB9AC\uBDF0\uC5D0 \uADFC\uAC70\uD55C <b>\uCD94\uC815</b>\uC774\uB77C, \uC704 \uC608\uC57D \uAE08\uC561\uACFC <b>\uD569\uC0B0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.</b>
  ${shown.length ? "" : '<span class="dim"><br>\uC5C6\uB2E4\uB294 \uB73B\uC740 \uC544\uB2C8\uACE0, \uB9AC\uBDF0\uC5D0\uC11C \uBABB \uCC3E\uC558\uB2E4\uB294 \uB73B\uC774\uC5D0\uC694.</span>'}
</div>`;
  }
  var MIN_TEXT = 2;
  function mountPanel(el) {
    return {
      update: (d) => renderInsights(el, d),
      destroy: () => {
        el.innerHTML = "";
        el.classList.remove("rvx");
      }
    };
  }

  // index.ts
  function mountReviewTab(el, opts = {}) {
    const view = mountPanel(el);
    const ctrl = createReviewController({ ...opts, onUpdate: view.update });
    return {
      refresh: ctrl.refresh,
      destroy: () => {
        ctrl.destroy();
        view.destroy();
      }
    };
  }

  // _cc_entry.ts
  globalThis.__ccReviewTab = {
    mountReviewTab,
    createReviewController,
    ruleAnalyzer,
    // 영어 규칙 층. 영어 리뷰에서 후보를 만든다 — 영어 모델은 이 후보에만 판정을 얹는다.
    ruleAnalyzerEn,
    // 주소 없는 기성품. 넣어도 아무 일도 하지 않는다(호환용으로 남겨둠).
    modelAnalyzer,
    // 주소를 받아 모델 층을 만든다. 배포본은 주소를 주지 않아 모델을 안 쓰고,
    // 개발·클라우드 서버를 붙일 때 이 함수에 주소만 넘기면 된다.
    createModelAnalyzer,
    runPipeline,
    emptyInsights,
    MIN_DISTINCT_REVIEWS,
    mountPanel,
    renderInsights,
    collectOfficialClaims
  };
})();
