/**
 * 축 2(리뷰 IE) 공용 타입.
 *
 * 설계 원칙 하나: **분석기는 판정을 덮어쓰지 않고 덧붙인다.**
 * 규칙이 낸 판정 위에 NLI·LLM이 자기 판정을 얹고, 마지막에 resolver가 하나를 고른다.
 * 나중에 모델을 끼울 때 규칙 코드를 건드리지 않아도 되고, 발표에서 "규칙 vs 모델"을
 * 같은 문장 위에서 나란히 보여줄 수 있다(어느 쪽이 뭘 바꿨는지가 남는다).
 */

/** analyze.py 의 FEE_KEYWORDS 키와 같은 값을 쓴다. 파이썬 집계와 이름이 어긋나면 안 된다. */
export type FeeType =
  | "주차"
  | "리조트피"
  | "보증금"
  | "도시세"
  | "청소비"
  | "조식"
  | "인원추가"
  | "세금수수료"
  | "기타현장결제"
  | "시설이용"
  /** 학습 모델이 "추가비용 언급 있음"이라고만 판정한 경우.
   *  모델은 리뷰 단위 0/1 만 내고 유형을 모른다(유형 분류 Stage 2 미학습).
   *  Stage 2 가 붙으면 이 값은 실제 유형으로 대체된다. */
  | "미분류";

/** analyze.py 의 judge() 반환값과 동일. */
export type Verdict = "mention" | "negated" | "ambiguous";

/** 어느 층이 낸 판정인지. 발표에서 기여를 가르는 축이기도 하다. */
export type AnalyzerStage = "rule" | "model" | "nli" | "llm";

export interface Review {
  /** 페이지 안에서의 순번 — 같은 리뷰를 다시 수집했는지 판별에 쓴다 */
  index: number;
  text: string;
  date?: string | null;
  rating?: number | null;
  ratingScale?: number | null;
  /** 사업자 답글은 분석에서 제외한다(아고다 실측 27%) */
  isHotelReply?: boolean;
  lang?: LangCode;
}

export type LangCode = "ko" | "en" | "ja" | "zh" | "other";

/** 한 분석기가 문장 하나에 대해 내린 판정. */
export interface VerdictNote {
  by: string;
  stage: AnalyzerStage;
  verdict: Verdict;
  /** 0~1. 규칙은 근거 개수로 거칠게 낸다 — 모델과 비교 가능한 축을 만들기 위함 */
  confidence: number;
  /** 왜 그렇게 봤는지. 패널의 '판단 근거'와 라벨링 검수에 그대로 쓰인다 */
  reason?: string;
}

/** 비용 언급 후보 문장 하나. */
export interface ClaimCandidate {
  reviewIndex: number;
  sentence: string;
  feeType: FeeType;
  keyword: string;
  /** 문장 안에서 키워드가 시작하는 위치 — 하이라이트에 쓴다 */
  keywordPos: number;
  costCues: string[];
  negCues: string[];
  /** 층별 판정이 쌓인다. 마지막 원소가 최신이지만, 최종 판정은 resolve()가 정한다 */
  notes: VerdictNote[];
  /** resolve() 결과 */
  verdict: Verdict;
  confidence: number;
  decidedBy: string;
}

export interface AnalysisInput {
  reviews: Review[];
  /** 숙소가 페이지에 공식적으로 표기한 것 — "무료 주차", "조식 포함" 등.
   *  NLI 층(Page-Review Consistency)의 premise가 된다. 지금 규칙 층은 쓰지 않는다. */
  officialClaims: string[];
}

/**
 * 분석기 하나. 지금은 규칙만 구현돼 있고, 나중에 이 인터페이스로
 * NliAnalyzer / LlmAnalyzer 를 추가하면 파이프라인에 그대로 꽂힌다.
 *
 * 규약:
 *  - 후보를 **새로 만드는** 분석기(규칙)는 candidates 가 비어 있을 때 채운다.
 *  - 후보를 **다듬는** 분석기(NLI·LLM)는 받은 candidates 의 notes 에만 덧붙인다.
 *    문장을 지우거나 새로 만들지 않는다 — 그래야 층 간 비교가 성립한다.
 */
export interface ClaimAnalyzer {
  readonly name: string;
  readonly stage: AnalyzerStage;
  /** 이 분석기가 다룰 수 있는 언어. 비우면 전부 */
  readonly langs?: LangCode[];
  analyze(
    input: AnalysisInput,
    candidates: ClaimCandidate[],
  ): ClaimCandidate[] | Promise<ClaimCandidate[]>;
}

/** 카드 ④행에 실제로 노출할 한 줄. */
export interface RiskItem {
  feeType: FeeType;
  /** 서로 다른 리뷰 개수. 노출 원칙의 기준값 */
  reviewCount: number;
  /** 최근 1년(ReviewInsights.recentDays) 리뷰에서 몇 건인지. 날짜 없는 리뷰는 수집 상위 20건을 최근으로 본다 */
  recentCount: number;
  /** 근거 문장. 패널에서 펼쳐 보여준다 */
  evidence: ClaimCandidate[];
  /** 페이지 공식 표기와 충돌하는가. NLI 층이 붙기 전에는 문자열 대조로만 채운다 */
  pageConflict: string | null;
  /**
   * 페이지가 **이미 유료라고 밝힌** 표기. 채워져 있으면 "숨은 비용"이 아니다 —
   * 사용자가 페이지에서 이미 볼 수 있는 정보라 우리가 새로 알려줄 게 없다.
   * (pageConflict 와 반대 방향이다. 그쪽은 "무료라 해놓고 받더라")
   */
  pageDisclosed: string | null;
  /** 노출 원칙을 통과했는가 */
  shown: boolean;
  /** 통과/탈락 이유 — 숨긴 것을 설명할 수 있어야 한다 */
  shownReason: string;
}

export interface ReviewInsights {
  /** 수집된 전체 리뷰 수(답글 제외) */
  totalReviews: number;
  /** 그중 실제로 분석된 수 — 언어가 지원되지 않으면 빠진다 */
  analyzedReviews: number;
  langBreakdown: Record<LangCode, number>;
  candidates: ClaimCandidate[];
  verdictCounts: Record<Verdict, number>;
  risks: RiskItem[];
  /** recentCount 의 기준 일수(365). 패널 문구용 */
  recentDays?: number;
  officialClaims: string[];
  /** 어느 층들이 돌았는지 — 패널 하단에 표시해 "지금은 규칙만"임을 숨기지 않는다 */
  stagesRun: string[];
  /** 수집이 아직 진행 중인지 */
  collecting: boolean;
}
