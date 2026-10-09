/**
 * 익스텐션 번들 진입점.
 *
 * 브라우저는 .ts 를 못 읽으므로 이 폴더의 모듈들을 .js 하나로 합쳐
 * `extension/reviewtab.js` 로 내보낸다. 그 파일을 content script 로 읽은
 * briefing.js 가 `window.__ccReviewTab` 으로 여기 있는 것들을 꺼내 쓴다.
 *
 *     node run.mjs bundle-ext
 *
 * ── 왜 이 파일이 저장소에 있어야 하는가
 * 원래 이 진입점은 커밋되지 않았고, reviewtab.js 는 빌드한 사람의 임시 폴더에만 있는
 * 설정으로 만들어졌다(생성물 2번째 줄의 `/private/tmp/.../_cc_entry.ts` 주석이 그 흔적).
 * 그래서 .ts 를 고쳐도 익스텐션에 반영할 방법이 없었다. 이 파일과 run.mjs 의
 * `bundle-ext` 태스크가 그 경로를 저장소 안으로 되돌린다.
 *
 * ── devpanel.ts 와 다른 점
 * devpanel.ts 는 `node run.mjs bundle` 의 진입점으로, 아고다 콘솔에 붙여넣어 쓰는
 * 테스트용이다(로드되는 순간 화면에 개발용 패널을 띄운다). 이 파일은 UI 를 만들지 않고
 * **API 만 노출한다** — 화면은 briefing.js 가 그린다.
 */
import {
  collectOfficialClaims,
  createModelAnalyzer,
  createReviewController,
  emptyInsights,
  MIN_DISTINCT_REVIEWS,
  modelAnalyzer,
  mountPanel,
  mountReviewTab,
  renderInsights,
  ruleAnalyzer,
  ruleAnalyzerEn,
  runPipeline,
} from "./index";

// briefing.js 가 `window.__ccReviewTab` 으로 집는다. 이 목록이 곧 익스텐션에 대한
// 공개 API 라서, 여기 없는 것은 briefing.js 에서 쓸 수 없다.
(globalThis as Record<string, unknown>).__ccReviewTab = {
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
  collectOfficialClaims,
};
