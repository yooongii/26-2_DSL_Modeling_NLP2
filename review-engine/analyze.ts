/**
 * 분석 파이프라인 + 집계.
 *
 * 층은 순서대로 돈다. 규칙이 후보를 만들고, 뒤에 붙는 층(NLI·LLM)은 그 후보의
 * `notes` 에 자기 판정을 **덧붙이기만** 한다. 최종 판정은 resolve()가 고른다.
 *
 *     [규칙] → [NLI] → [LLM]  →  resolve  →  집계(노출 규칙)  →  패널
 *      지금     나중     나중
 *
 * 이렇게 나눈 이유:
 *   - 모델을 끼울 때 규칙 코드를 안 건드린다.
 *   - 같은 문장 위에 층별 판정이 남아 "모델이 무엇을 바꿨는지"를 그대로 보여줄 수 있다.
 *     발표에서 기여를 가르는 축이 바로 이것이고, ambiguous 회복량이 정량 성과가 된다.
 *
 * 집계는 별개 관심사다. **문장 수준 정확도와 카드 수준 정확도는 다르다** —
 * 노출 원칙(서로 다른 리뷰 2건 이상)이 오탐을 한 번 더 걸러내기 때문이다.
 * 그래서 후보를 다 보관한 채로 `shown` 플래그만 세운다. 숨긴 이유도 남긴다.
 */
import type {
  AnalysisInput,
  ClaimAnalyzer,
  ClaimCandidate,
  FeeType,
  LangCode,
  Review,
  ReviewInsights,
  RiskItem,
  Verdict,
} from "./types";
import { ruleAnalyzer } from "./rules";
import { routeByLang } from "./lang";
import { isRecent, RECENT_DAYS } from "./recency";
import { DISCLOSED_TO_FEE, looksPaid } from "./pageClaims";

/** CLAUDE.md 노출 원칙: 서로 다른 리뷰 2건 이상일 때만 노출. */
export const MIN_DISTINCT_REVIEWS = 2;
/**
 * 날짜를 못 읽는 리뷰에만 쓰는 예비 기준 — 수집 순서 상위 N건을 '최근'으로 본다.
 * 날짜가 있으면 recency.ts 의 RECENT_DAYS(1년) 로 판정한다.
 */
const RECENT_WINDOW = 20;

/**
 * 층별 판정 중 하나를 고른다.
 *
 * 규칙: **나중 층이 이긴다.** 단, 확신이 낮으면(<0.5) 앞 층의 판정을 유지한다.
 * NLI·LLM은 규칙이 못 가른 것(ambiguous)을 푸는 게 목적이라 기본적으로 우선권을 준다.
 */
export function resolve(c: ClaimCandidate): ClaimCandidate {
  let best = c.notes[0];
  if (!best) return c; // 분석기가 하나도 안 돌았으면 그대로 둔다
  for (const n of c.notes.slice(1)) {
    if (n.confidence >= 0.5 || best.verdict === "ambiguous") best = n;
  }
  return { ...c, verdict: best.verdict, confidence: best.confidence, decidedBy: best.by };
}

/**
 * 후보들을 비용 유형별로 묶어 카드 ④행 후보를 만든다.
 * 노출 원칙을 여기서 적용하되 **탈락분도 남긴다** — 왜 안 보여줬는지 설명할 수 있어야 한다.
 */
function aggregate(
  candidates: ClaimCandidate[],
  officialClaims: string[],
  reviews: Review[] = [],
): RiskItem[] {
  // 리뷰 순번 → 날짜·평점. 세 사이트 모두 낮은 평점순으로 받으므로 순번만으로는
  // '최근'을 알 수 없다 — 날짜가 있으면 날짜(최근 1년)로, 없으면 순번으로 판정한다.
  const byIndex = new Map<number, Review>();
  for (const r of reviews) byIndex.set(r.index, r);
  const now = new Date();
  const recentOf = (idx: number): boolean => {
    const rv = byIndex.get(idx);
    const byDate = rv ? isRecent(rv.date, now) : null;
    return byDate ?? idx < RECENT_WINDOW;
  };
  // 낮은 평점(10점 만점 6 이하)을 앞에 세운다 — 비용 불만은 저점 리뷰에 몰린다.
  const lowRating = (idx: number): boolean => {
    const rv = byIndex.get(idx);
    if (rv?.rating == null) return false;
    const scale = rv.ratingScale ?? 10;
    return rv.rating / scale <= 0.6;
  };
  const mentions = candidates.filter((c) => c.verdict === "mention");
  const byType = new Map<FeeType, ClaimCandidate[]>();
  for (const c of mentions) {
    const arr = byType.get(c.feeType) ?? [];
    arr.push(c);
    byType.set(c.feeType, arr);
  }

  const items: RiskItem[] = [];
  for (const [feeType, evidence] of byType) {
    // **서로 다른 리뷰** 개수를 센다. 한 리뷰가 같은 말을 두 번 해도 1건이다.
    const distinct = new Set(evidence.map((c) => c.reviewIndex));
    const recent = new Set(evidence.filter((c) => recentOf(c.reviewIndex)).map((c) => c.reviewIndex));
    // 근거 문장은 최근 1년 → 낮은 평점 순으로. 패널이 위에서부터 보여주므로 순서가 곧 강조다.
    const rank = (c: ClaimCandidate) =>
      (recentOf(c.reviewIndex) ? 0 : 2) + (lowRating(c.reviewIndex) ? 0 : 1);
    evidence.sort((a, b) => rank(a) - rank(b) || a.reviewIndex - b.reviewIndex);

    // 페이지 표기와 충돌하는가. 지금은 문자열 대조뿐 —
    // 여기가 NLI(Page-Review Consistency)가 들어올 자리다.
    const conflict = findConflict(feeType, officialClaims);
    // 페이지가 이미 유료라고 밝혔는가. 충돌이 있으면 그쪽이 더 강한 신호라 우선한다
    // ("무료"라고 써놓고 받는 경우 — 건수와 무관하게 알려야 한다).
    const disclosed = conflict ? null : findDisclosed(feeType, officialClaims);

    const passes = distinct.size >= MIN_DISTINCT_REVIEWS;
    // 노출 기준을 넘겨도 페이지에 이미 안내돼 있으면 "숨은 비용"으로 올리지 않는다.
    // 지우지는 않는다 — 따로 묶어 "페이지에 이미 안내된 비용"으로 보여준다.
    const shown = passes && !disclosed;
    items.push({
      feeType,
      reviewCount: distinct.size,
      recentCount: recent.size,
      evidence,
      pageConflict: conflict,
      pageDisclosed: disclosed,
      shown,
      shownReason: disclosed
        ? "페이지에 이미 안내된 비용"
        : passes
          ? `서로 다른 리뷰 ${distinct.size}건`
          : `리뷰 ${distinct.size}건 — 노출 기준(${MIN_DISTINCT_REVIEWS}건) 미달`,
    });
  }

  // 노출 대상 먼저, 충돌 건은 위로(가장 강한 신호), 그다음 최근 1년 건수, 그다음 전체 건수.
  items.sort(
    (a, b) =>
      Number(b.shown) - Number(a.shown) ||
      Number(!!b.pageConflict) - Number(!!a.pageConflict) ||
      b.recentCount - a.recentCount ||
      b.reviewCount - a.reviewCount,
  );
  return items;
}

const CLAIM_TO_FEE: [RegExp, FeeType][] = [
  [/무료\s*주차|주차\s*무료/, "주차"],
  [/조식\s*(?:포함|무료)/, "조식"],
  [/세금\s*및\s*수수료\s*포함/, "세금수수료"],
];

function findConflict(feeType: FeeType, officialClaims: string[]): string | null {
  for (const claim of officialClaims) {
    for (const [re, ft] of CLAIM_TO_FEE) {
      if (ft === feeType && re.test(claim)) return claim;
    }
    if (/추가\s*요금\s*없음/.test(claim)) return claim; // 유형 무관하게 충돌
  }
  return null;
}

/**
 * 페이지가 **이미 유료라고 밝힌** 항목인가.
 *
 * findConflict 의 반대 방향이다. 그쪽은 "무료라 해놓고 받더라"(알려줄 가치가 큼),
 * 이쪽은 "유료라고 써 있고 실제로 받더라"(알려줄 게 없음).
 * 예: 정책 탭의 "연박 청소(유료서비스) 20,000원" ↔ 리뷰 "청소비 냈어요"
 *
 * 이걸 안 가르면 페이지에 버젓이 적힌 비용을 "숨은 비용"이라고 경고하게 된다.
 */
// DISCLOSED_TO_FEE · looksPaid 는 pageClaims.ts — 수집(collect.ts)과 같은 표를 쓴다.

function findDisclosed(feeType: FeeType, officialClaims: string[]): string | null {
  for (const claim of officialClaims) {
    if (!looksPaid(claim)) continue; // "무료 주차" 같은 표기는 여기 해당 없음
    for (const [re, ft] of DISCLOSED_TO_FEE) {
      if (ft === feeType && re.test(claim)) return claim;
    }
  }
  return null;
}

export interface RunOptions {
  /** 기본은 규칙 하나. NLI·LLM을 만들면 여기에 이어 붙인다 */
  analyzers?: ClaimAnalyzer[];
  supportedLangs?: LangCode[];
  collecting?: boolean;
}

/**
 * 리뷰 → 인사이트. 층을 순서대로 돌리고 집계한다.
 *
 * 층 추가 예시 (나중에):
 *   runPipeline(reviews, official, {
 *     analyzers: [ruleAnalyzer, nliConsistencyAnalyzer, llmClaimAnalyzer],
 *   })
 */
export async function runPipeline(
  reviews: Review[],
  officialClaims: string[],
  opts: RunOptions = {},
): Promise<ReviewInsights> {
  const analyzers = opts.analyzers ?? [ruleAnalyzer];
  const supported = opts.supportedLangs ?? ["ko"];

  // 답글은 리뷰가 아니다. 분모에서도 뺀다.
  const guest = reviews.filter((r) => !r.isHotelReply);
  const routing = routeByLang(guest, supported);

  const input: AnalysisInput = { reviews: routing.analyzable, officialClaims };

  let candidates: ClaimCandidate[] = [];
  const stagesRun: string[] = [];
  for (const a of analyzers) {
    // 언어 제약이 있는 층은 자기가 볼 수 있는 것만 받는다
    const scoped: AnalysisInput = a.langs
      ? { ...input, reviews: input.reviews.filter((r) => a.langs!.includes(r.lang ?? "other")) }
      : input;
    candidates = await a.analyze(scoped, candidates);
    stagesRun.push(a.name);
  }

  candidates = candidates.map(resolve);

  const verdictCounts: Record<Verdict, number> = { mention: 0, negated: 0, ambiguous: 0 };
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
    collecting: opts.collecting ?? false,
  };
}

/** 빈 상태 — 패널이 로딩 중에도 같은 모양을 그릴 수 있게. */
export function emptyInsights(collecting = true): ReviewInsights {
  return {
    totalReviews: 0,
    analyzedReviews: 0,
    langBreakdown: { ko: 0, en: 0, ja: 0, zh: 0, other: 0 },
    candidates: [],
    verdictCounts: { mention: 0, negated: 0, ambiguous: 0 },
    risks: [],
    officialClaims: [],
    stagesRun: [],
    collecting,
  };
}
