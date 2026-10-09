/**
 * 축 2 · 리뷰 IE — 공개 API.
 *
 * 팀원 UI에 붙이는 방법은 두 가지다. 목업이 어떤 모양이든 둘 중 하나는 맞는다.
 *
 * ── ① 그리기까지 맡긴다 (가장 간단)
 *
 *     import { mountReviewTab } from "@/lib/review";
 *     const tab2 = document.querySelector("#tab-review")!;
 *     const handle = mountReviewTab(tab2);
 *     // 탭이 사라질 때: handle.destroy()
 *
 * ── ② 데이터만 받고 직접 그린다 (목업 디자인을 그대로 쓸 때)
 *
 *     import { createReviewController } from "@/lib/review";
 *     const ctrl = createReviewController({
 *       onUpdate: (insights) => myRender(insights),   // 여러 번 불린다
 *     });
 *
 * 둘 다 **사용자 조작이 필요 없다.** 붙이는 순간 수집이 시작되고,
 * 첫 결과가 수십 ms 안에 오고, 뒤에서 더 모이는 대로 다시 불린다.
 *
 * ── 나중에 모델 층 끼우기
 *
 *     import { ruleAnalyzer } from "@/lib/review";
 *     createReviewController({
 *       onUpdate,
 *       analyzers: [ruleAnalyzer, nliConsistency, llmClaim],
 *     });
 *
 * 규칙 층은 후보를 만들고, 뒤 층은 그 후보의 notes 에 판정을 덧붙이기만 한다.
 * 자세한 규약은 types.ts 의 ClaimAnalyzer 주석에 있다.
 */
export type {
  AnalysisInput,
  ClaimAnalyzer,
  ClaimCandidate,
  FeeType,
  LangCode,
  Review,
  ReviewInsights,
  RiskItem,
  Verdict,
  VerdictNote,
} from "./types";

export { ruleAnalyzer, judge, findFeeHits, splitSentences, isHotelReply, createRuleAnalyzer, KO_TABLES } from "./rules";
export type { RuleTables } from "./rules";
export { ruleAnalyzerEn, EN_TABLES } from "./rulesEn";
export { modelAnalyzer, createModelAnalyzer } from "./modelAnalyzer";
export type { ModelAnalyzerOptions } from "./modelAnalyzer";
export { detectLang, looksTranslated, routeByLang } from "./lang";
export { autoCollect, findReviewContainer, collectOfficialClaims, watchPage } from "./collect";
export { runPipeline, resolve, emptyInsights, MIN_DISTINCT_REVIEWS } from "./analyze";
export { createReviewController } from "./controller";
export type { ReviewController, ControllerOptions } from "./controller";
export { renderInsights, mountPanel } from "./panel";
export type { MountHandle } from "./panel";

import { createReviewController, type ControllerOptions } from "./controller";
import { mountPanel } from "./panel";

export interface ReviewTabHandle {
  refresh: () => void;
  destroy: () => void;
}

/**
 * 수집 + 분석 + 렌더링을 한 번에. 탭 컨테이너만 넘기면 끝난다.
 */
export function mountReviewTab(
  el: HTMLElement,
  opts: Omit<ControllerOptions, "onUpdate"> = {},
): ReviewTabHandle {
  const view = mountPanel(el);
  const ctrl = createReviewController({ ...opts, onUpdate: view.update });
  return {
    refresh: ctrl.refresh,
    destroy: () => {
      ctrl.destroy();
      view.destroy();
    },
  };
}
