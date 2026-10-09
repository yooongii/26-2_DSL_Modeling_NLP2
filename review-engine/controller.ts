/**
 * 수집 → 분석을 묶어 돌리고 결과를 흘려보낸다. **화면을 그리지 않는다.**
 *
 * 렌더링과 분리한 이유: 팀원의 UI 목업이 아직 없다. 목업이 나오면 그쪽이
 * `createReviewController` 만 쓰고 자기 방식으로 그리면 되고, 급하면 이 폴더의
 * 기본 렌더러(panel.ts)를 그대로 꽂아도 된다. 어느 쪽이든 이 파일은 안 바뀐다.
 *
 * 갱신은 여러 번 온다 — 수집 단계마다 다시 분석해서 보내기 때문이다.
 * 첫 결과는 보통 수십 ms 안에 오고(이미 DOM에 있는 리뷰), 그 뒤 숫자가 올라간다.
 */
import type { ClaimAnalyzer, LangCode, ReviewInsights } from "./types";
import { autoCollect, collectOfficialClaims, watchPage } from "./collect";
import { emptyInsights, runPipeline } from "./analyze";

export interface ControllerOptions {
  onUpdate: (insights: ReviewInsights) => void;
  /** 기본은 규칙 하나. NLI·LLM 층이 생기면 여기로 넘긴다 */
  analyzers?: ClaimAnalyzer[];
  supportedLangs?: LangCode[];
  /** SPA에서 숙소가 바뀌면 자동으로 다시 돈다. 끄려면 false */
  followNavigation?: boolean;
}

export interface ReviewController {
  /** 수동 재수집 (사용자가 '다시 분석'을 눌렀을 때) */
  refresh: () => void;
  destroy: () => void;
}

export function createReviewController(opts: ControllerOptions): ReviewController {
  const { onUpdate, analyzers, supportedLangs, followNavigation = true } = opts;

  let abort: AbortController | null = null;
  let stopWatch: (() => void) | null = null;
  let dead = false;

  async function run() {
    if (dead) return;
    abort?.abort();
    const ac = new AbortController();
    abort = ac;

    onUpdate(emptyInsights(true));

    const official = collectOfficialClaims();

    // 수집 단계마다 분석을 다시 돌린다. 규칙 층은 45건 기준 수 ms라 매번 돌려도 싸다.
    // 나중에 LLM 층이 붙으면 여기서 debounce 하거나 done 단계에서만 돌리면 된다.
    const analyzeAndEmit = async (reviews: Parameters<typeof runPipeline>[0], done: boolean) => {
      if (ac.signal.aborted || dead) return;
      const insights = await runPipeline(reviews, official, {
        analyzers,
        supportedLangs,
        collecting: !done,
      });
      if (ac.signal.aborted || dead) return;
      onUpdate(insights);
    };

    let pending: Promise<void> = Promise.resolve();
    const reviews = await autoCollect({
      signal: ac.signal,
      onProgress: (rs, phase) => {
        // 단계별 결과를 순서대로 처리한다(뒤 결과가 앞 결과에 덮이지 않게)
        pending = pending.then(() => analyzeAndEmit(rs, phase === "done" || phase === "empty"));
      },
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
    },
  };
}
