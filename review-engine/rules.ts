/**
 * 비용 언급 규칙 베이스라인 — `labeling/analyze.py` 의 포팅.
 *
 * 파이썬과 **같은 입력 → 같은 판정**이 나와야 한다. 브라우저 판정과 오프라인 집계가
 * 어긋나면 라벨링해 둔 골드가 무의미해지기 때문이다.
 * 여기를 고치면 analyze.py 도 같이 고치고, `scripts/review-parity.mjs` 로 확인할 것.
 *
 * 규칙의 한계는 의도된 것이다 — `ambiguous` 건수가 곧 "모델이 넘어야 할 선"이고,
 * 그 숫자를 재는 게 이 층의 목적이다. 여기서 억지로 정확도를 끌어올리지 않는다.
 */
import type {
  AnalysisInput, ClaimAnalyzer, ClaimCandidate, FeeType, LangCode, Verdict,
} from "./types";

/**
 * 언어별 규칙 표. 판정 로직(문장 분할 → 키워드 → 창 안 단서 → 3분류)은 언어와 무관하고,
 * 표만 다르다. 한국어 표는 labeling/analyze.py, 영어 표는 labeling/rules_en.py 와 1:1 이다 —
 * 한쪽을 고치면 다른 쪽도 고치고 `node run.mjs parity` 로 같은 판정인지 확인할 것.
 */
export interface RuleTables {
  feeKeywords: Record<FeeType, string[]>;
  /** 그 자체로는 비용이 아닌 편의시설 이름 — costContextRe 가 있을 때만 후보로 본다 */
  amenityTypes: ReadonlySet<FeeType>;
  costContextRe: RegExp;
  costCue: string[];
  negCue: string[];
  /** 키워드 주변 몇 글자까지를 같은 문맥으로 볼지 */
  window: number;
  sentSplit: RegExp;
  hotelReplyRe: RegExp;
  /** 영어처럼 대소문자를 무시해야 하는 언어 */
  caseInsensitive: boolean;
}

// ── 한국어 표 (labeling/analyze.py 와 같음) ────────────────────────────────
export const FEE_KEYWORDS: Record<FeeType, string[]> = {
  // 2026-09-24 확장: 실제 Trip.com 한국어 리뷰 141건에서 후보가 3건뿐이었다(놓친 예:
  // "발렛비", "체크인시 추가 금액"). 유형별로 사용자가 실제로 쓰는 표현을 더한다.
  주차: ["주차비", "주차 요금", "주차요금", "주차료", "발렛비", "발렛 요금", "발렛파킹", "발레파킹", "발렛", "발레 파킹", "주차"],
  리조트피: ["리조트피", "리조트 피", "리조트 요금", "resort fee", "시설 이용료", "시설이용료", "리조트 이용료", "시설 사용료"],
  보증금: ["보증금", "디파짓", "deposit", "예치금", "보증 금액", "선결제 보증"],
  도시세: ["도시세", "숙박세", "관광세", "city tax", "숙박 세금", "시티택스", "시티 택스", "환경세", "온천세", "입탕세"],
  청소비: ["청소비", "청소 요금", "청소료", "클리닝 피", "클리닝피"],
  조식: ["조식", "아침 식사", "아침식사", "브렉퍼스트", "조식권", "조식 뷔페", "조식뷔페", "아침 뷔페"],
  인원추가: ["인원 추가", "인원추가", "추가 인원", "추가인원", "1인 추가", "인원당", "엑스트라 베드", "엑스트라베드", "추가 침대", "침대 추가", "간이침대", "성인 추가", "아이 추가", "어린이 추가"],
  세금수수료: ["세금", "수수료", "부가세", "봉사료", "서비스 차지", "서비스차지", "서비스 요금", "택스", "환전 수수료", "카드 수수료"],
  기타현장결제: ["현장 결제", "현장결제", "현장에서 결제", "체크인 때 결제", "따로 결제", "추가 금액", "추가금액", "추가 요금", "추가요금", "추가 비용", "추가비용", "별도 요금", "별도요금", "별도 비용", "추가로 결제", "추가 결제", "현장 지불", "현금으로 내", "현금 결제"],
} as Record<FeeType, string[]>;

/**
 * '조식·주차·세금'은 그 자체로 비용이 아니라 **편의시설 이름**이다.
 * 실측(리조트 383건): 게이트 없이 세면 후보 102건 중 90건(88%)이 "조식 맛있었어요" 류 소음.
 */
export const AMENITY_TYPES: ReadonlySet<FeeType> = new Set<FeeType>(["조식", "주차", "세금수수료"]);

const COST_CONTEXT_RE =
  /요금|가격|비용|금액|\d+\s*(?:원|엔|바트|달러|만원|천원|위안|유로|링깃|동|페소|USD|THB|JPY|EUR|CNY|KRW|₩|\$)|유료|무료|결제|지불|청구|부과|추가|별도|불포함|미포함|포함되지|따로|내야|냈|받더/;

// ── analyze.py: COST_CUE / NEG_CUE ──────────────────────────────────────
const COST_CUE = [
  // '유료'는 NEG_CUE의 '무료'와 짝이 되는 단서인데 빠져 있었다(2026-08-30 발견).
  // 실측 718건에서 가장 흔한 비용 단서가 '유료'라, 없으면 가장 흔한 신호를 통째로 놓친다.
  "유료",
  "별도", "따로", "추가로", "추가 요금", "추가요금", "더 내", "더 냈", "더 받",
  "받더라", "받았", "받습니다", "받아요", "내야", "냈어요", "냈습니다", "지불",
  "결제해야", "청구", "부과", "요구", "달라고", "붙어요", "붙습니다", "포함 안",
  "포함되지 않", "불포함", "미포함", "제외",
  // 2026-09-24 추가: 실제 리뷰에서 자주 쓰는 표현
  "내라고", "내야 했", "내야했", "지불해야", "결제했", "결제하", "요금이", "비용이", "금액을", "돈을", "돈 내",
  "청구됐", "청구되", "차감", "공제", "선결제", "현금으로",
];

const NEG_CUE = [
  "무료", "공짜", "없었", "없어요", "없습니다", "없고", "없는", "안 받", "안받",
  "포함되어", "포함돼", "포함이라", "포함이었", "포함해서", "제공", "서비스로",
  "따로 안", "추가 요금 없", "추가요금 없", "부담 없",
  // 2026-09-24 추가
  "무상", "포함된", "포함입니다", "포함이에요", "0원",
];

/** 키워드 주변 몇 글자까지를 '같은 문맥'으로 볼지. analyze.py 의 WINDOW. */
export const WINDOW = 30; // 25→30 (2026-09-24): "주차시설불편 … 따로 냈어요" 처럼 단서가 살짝 멀리 있는 문장을 잡는다

const SENT_SPLIT = /(?<=[.!?。])\s+|\n+/;

/**
 * 호텔이 쓴 답글 — 아고다는 사업자 답글을 리뷰 목록 안에 넣는다(실측 27%).
 * 안 거르면 비용 언급 비율이 그만큼 희석된다.
 */
export const HOTEL_REPLY_RE =
  /리뷰를?\s*남겨\s*주셔서\s*감사|소중한\s*(?:의견|후기|리뷰)|이용해\s*주(?:셔서|시고)\s*(?:진심으로\s*)?감사|저희\s*(?:호텔|숙소|리조트)|다시\s*뵙기를\s*(?:기대|희망)|(?:총지배인|매니저|호텔)\s*드림|thank you for (?:your (?:review|stay)|choosing)/i;

export const KO_TABLES: RuleTables = {
  feeKeywords: FEE_KEYWORDS,
  amenityTypes: AMENITY_TYPES,
  costContextRe: COST_CONTEXT_RE,
  costCue: COST_CUE,
  negCue: NEG_CUE,
  window: WINDOW,
  sentSplit: SENT_SPLIT,
  hotelReplyRe: HOTEL_REPLY_RE,
  caseInsensitive: false,
};

// ── 언어 무관 로직 ───────────────────────────────────────────────────────

/** 매칭용 문자열. 영어는 소문자로 맞춘다(길이가 같을 때만 — 위치가 어긋나지 않게). */
function matchable(s: string, t: RuleTables): string {
  if (!t.caseInsensitive) return s;
  const lower = s.toLowerCase();
  return lower.length === s.length ? lower : s;
}

export function isHotelReplyWith(text: string, t: RuleTables): boolean {
  return t.hotelReplyRe.test(text);
}

export function splitSentencesWith(text: string, t: RuleTables): string[] {
  return (text || "").split(t.sentSplit).map((s) => s.trim()).filter(Boolean);
}

export interface FeeHit {
  feeType: FeeType;
  keyword: string;
  pos: number;
}

/** 문장에서 (비용유형, 키워드, 위치)를 찾는다. 긴 키워드 우선, 유형당 한 번만. */
export function findFeeHitsWith(sentence: string, t: RuleTables): FeeHit[] {
  const hay = matchable(sentence, t);
  const hasCostContext = t.costContextRe.test(sentence);
  const hits: FeeHit[] = [];
  for (const feeType of Object.keys(t.feeKeywords) as FeeType[]) {
    // 편의시설 이름만 나온 문장은 비용 얘기가 아니다
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

/**
 * 키워드 **주변 창** 안의 단서만 센다.
 * 문장 전체를 보면 "주차는 무료인데 조식은 따로 받아요"에서 두 단서가 다 잡혀 판정이 뒤집힌다.
 */
function cuesNear(sentence: string, pos: number, kwLen: number, cues: string[], t: RuleTables): string[] {
  const lo = Math.max(0, pos - t.window);
  const hi = Math.min(sentence.length, pos + kwLen + t.window);
  const scope = matchable(sentence.slice(lo, hi), t);
  return cues.filter((c) => scope.includes(t.caseInsensitive ? c.toLowerCase() : c));
}

export function judgeWith(
  sentence: string,
  keyword: string,
  pos: number,
  t: RuleTables,
): { verdict: Verdict; costCues: string[]; negCues: string[] } {
  const costCues = cuesNear(sentence, pos, keyword.length, t.costCue, t);
  const negCues = cuesNear(sentence, pos, keyword.length, t.negCue, t);
  if (costCues.length && !negCues.length) return { verdict: "mention", costCues, negCues };
  if (negCues.length && !costCues.length) return { verdict: "negated", costCues, negCues };
  // 둘 다 있거나 둘 다 없으면 규칙으로는 못 가른다 → 모델이 이겨야 할 구간
  return { verdict: "ambiguous", costCues, negCues };
}

/**
 * 규칙의 확신도. 단서가 한쪽으로 많이 쏠릴수록 높다.
 * 모델 층과 같은 축에서 비교하기 위한 값이지 확률이 아니다 — 캘리브레이션돼 있지 않다.
 */
function ruleConfidence(verdict: Verdict, nCost: number, nNeg: number): number {
  if (verdict === "ambiguous") return nCost + nNeg === 0 ? 0.15 : 0.35;
  const strong = Math.max(nCost, nNeg);
  return Math.min(0.9, 0.55 + 0.12 * strong);
}

/** 규칙 층을 만든다. 후보를 **만드는** 유일한 분석기 종류다 — 모델 층은 이 후보에 판정만 얹는다. */
export function createRuleAnalyzer(name: string, langs: LangCode[], t: RuleTables): ClaimAnalyzer {
  return {
    name,
    stage: "rule",
    langs,
    // prev 를 이어받아야 한다. runPipeline 은 분석기를 차례로 돌리며 앞 층의 후보를
    // 넘기는데(candidates = a.analyze(scoped, candidates)), 이걸 무시하면 두 번째
    // 규칙층(en)이 첫 번째(ko)의 후보를 통째로 버린다 — 실측: Trip.com 240건에서
    // ko 후보 3건이 사라지고 en 8건만 남아 한국어 모델이 한 번도 호출되지 않았다.
    analyze(input: AnalysisInput, prev: ClaimCandidate[] = []): ClaimCandidate[] {
      const out: ClaimCandidate[] = [...prev];
      for (const r of input.reviews) {
        if (r.isHotelReply || isHotelReplyWith(r.text, t)) continue;
        for (const sentence of splitSentencesWith(r.text, t)) {
          for (const { feeType, keyword, pos } of findFeeHitsWith(sentence, t)) {
            const { verdict, costCues, negCues } = judgeWith(sentence, keyword, pos, t);
            const confidence = ruleConfidence(verdict, costCues.length, negCues.length);
            const reason =
              verdict === "ambiguous"
                ? costCues.length && negCues.length
                  ? `비용 단서(${costCues.join("·")})와 무료 단서(${negCues.join("·")})가 함께 있어 규칙으로는 못 가름`
                  : "키워드 주변에 판단 단서가 없음"
                : verdict === "mention"
                  ? `비용 단서: ${costCues.join("·")}`
                  : `무료 단서: ${negCues.join("·")}`;
            out.push({
              reviewIndex: r.index, sentence, feeType, keyword, keywordPos: pos, costCues, negCues,
              notes: [{ by: name, stage: "rule", verdict, confidence, reason }],
              verdict, confidence, decidedBy: name,
            });
          }
        }
      }
      return out;
    },
  };
}

// ── 한국어 기본 인스턴스 · 기존 호출부(parity.mjs, index.ts, briefing.js) 호환 ──
export const isHotelReply = (text: string): boolean => isHotelReplyWith(text, KO_TABLES);
export const splitSentences = (text: string): string[] => splitSentencesWith(text, KO_TABLES);
export const findFeeHits = (sentence: string): FeeHit[] => findFeeHitsWith(sentence, KO_TABLES);
export const judge = (sentence: string, keyword: string, pos: number) => judgeWith(sentence, keyword, pos, KO_TABLES);

/** 한국어 규칙 층. */
export const ruleAnalyzer: ClaimAnalyzer = createRuleAnalyzer("rule-baseline", ["ko"], KO_TABLES);
