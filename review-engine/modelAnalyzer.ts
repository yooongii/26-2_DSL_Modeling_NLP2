/**
 * 학습된 추가비용 분류기를 분석 층으로 꽂는다.
 *
 * ── 구조 (2026-09-22 변경) — 규칙 후보에 판정만 얹는다
 *
 *   리뷰 → 규칙 층: 키워드가 든 **문장** 후보 + 유형 + 1차 판정
 *        → 모델 층: 그 후보 문장을 서버로 보내 "비용 언급인가"를 다시 판정   ← 여기
 *
 * 예전엔 모델이 리뷰 **전문**을 따로 받아 자기 후보를 새로 만들었다. 두 가지가 어긋났다:
 *   1. 모델은 규칙이 뽑은 문장(중앙값 46자, 키워드 포함 100%)으로 학습됐는데 추론은 전문을 받았다
 *      (model-server/ckpt_kr METRICS.md 경고 4번).
 *   2. 새 모델(ckpt_kr, ckpt_en_final)은 이진이라 유형을 모른다. 유형은 규칙이 키워드로 이미 알고
 *      있으므로(학습 데이터의 fee_type 이 그렇게 만들어졌다) 규칙 후보를 쓰면 유형이 저절로 따라온다.
 * 덤으로 서버로 나가는 양이 리뷰 전문 수십 건 → 문장 수십 개로 줄어 개인정보 고지 부담도 준다.
 *
 * ── 규칙과의 관계
 * 판정은 note 로 **덧붙인다**. 최종 판정은 analyze.ts resolve() 가 정한다 — 뒤 층의 확신도가
 * 0.5 이상이면 그쪽을 따르므로, 모델은 사실상 규칙 판정을 덮어쓴다(negated 후보도 살려낸다:
 * 학습셋의 negated 192건 중 42건이 실제 비용이었다). 뒤에 오는 money-gate 는 그 위에 다시 얹힌다.
 *
 * ── 언어
 * 서버는 lang 으로 모델을 고른다(ko: klue/roberta-base, en: distilbert). 인스턴스를 언어별로
 * 하나씩 만들고 `langs` 로 파이프라인이 리뷰를 걸러준다. 후보는 리뷰 index 로 다시 거른다.
 *
 * ── 주소는 호출부가 준다 (기본값 없음)
 * `endpoint` 를 주지 않으면 이 층은 아무것도 하지 않는다. 개발 중 붙이려면 서버를 띄우고
 *     cd model-server && python serve.py --model klue/roberta-base --binary --model-en distilbert-base-uncased
 * 콘솔에서 localStorage.cc_model_endpoint = "<서버 주소>/classify" 후 새로고침(briefing.js 가 읽는다).
 */
import { isRecent } from "./recency";
import type { AnalysisInput, ClaimAnalyzer, ClaimCandidate, LangCode } from "./types";

export interface ModelAnalyzerOptions {
  /** 분류 서버 주소. **주지 않으면 모델 층을 통째로 건너뛴다.** */
  endpoint?: string;
  /** 서버에 보낼 언어 코드. 서버가 이 값으로 모델을 고른다. 기본 ko */
  lang?: LangCode;
  /** 이 인스턴스가 맡을 리뷰 언어. 보통 [lang] */
  langs?: LangCode[];
  /** 이 값 이상이면 추가비용으로 본다. 이진 모델의 softmax 양성 확률 기준 */
  threshold?: number;
  /** 한 번에 보낼 문장 수. 서버 상한 100 */
  batchSize?: number;
  /** 서버가 없거나 죽었을 때 조용히 건너뛸지. false 면 예외를 던진다 */
  optional?: boolean;
  /**
   * 한 배치를 기다릴 최대 시간(ms). 요청이 없으면 0으로 줄어드는 호스팅(Cloud Run)은
   * 첫 요청에 수십 초가 걸린다 — 넘기면 모델 층만 포기하고 규칙 판정으로 간다.
   */
  timeoutMs?: number;
  /** 서버로 보내는 문장 상한. 넘치면 ambiguous → 최근 1년 → 낮은 평점 순으로 고른다 (기본 50) */
  maxSentences?: number;
}

interface ClassifyResult {
  label: number;
  prob: number;
  /** 이진 모델은 비어 온다. 유형은 규칙 후보가 이미 갖고 있으므로 쓰지 않는다. */
  types?: { name: string; prob: number }[];
}

export function createModelAnalyzer(opts: ModelAnalyzerOptions = {}): ClaimAnalyzer {
  const {
    endpoint,
    lang = "ko",
    langs = [lang],
    threshold = 0.5,
    batchSize = 50,
    optional = true,
    timeoutMs = 8000,
    maxSentences = 50,
  } = opts;

  return {
    // 언어가 달라도 이름은 같다 — 패널·게이트가 이 문자열로 층을 알아본다.
    name: "cost-model",
    stage: "model",
    langs,

    async analyze(input: AnalysisInput, prev: ClaimCandidate[]): Promise<ClaimCandidate[]> {
      if (!endpoint) return prev;

      // 파이프라인은 input.reviews 만 언어로 걸러준다. 후보는 리뷰 index 로 내 것만 고른다.
      const guest = input.reviews.filter((r) => !r.isHotelReply);
      const mine = new Set(guest.map((r) => r.index));
      const byIndex = new Map(guest.map((r) => [r.index, r] as const));
      let targets = prev
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => mine.has(c.reviewIndex) && c.sentence.trim());
      if (!targets.length) return prev;
      // 서버로 보내는 문장 수에 상한을 둔다 — 서버 시간은 문장 수에 비례한다(40문장 ≈ 1.2s).
      // 리뷰 표본을 늘려도 지연이 그대로이도록, "모델 판단이 값어치 있는" 순으로 골라 보낸다:
      // 규칙이 못 가른 것(ambiguous) → 최근 1년 → 낮은 평점. 캡에 걸린 문장은 규칙 판정으로 남는다.
      if (targets.length > maxSentences) {
        const now = new Date();
        const rank = ({ c }: { c: ClaimCandidate }) => {
          const r = byIndex.get(c.reviewIndex);
          const recent = r ? isRecent(r.date, now) : null;
          const low = r?.rating != null && r.rating / (r.ratingScale ?? 10) <= 0.6;
          return (c.verdict === "ambiguous" ? 0 : 4) + (recent ? 0 : 2) + (low ? 0 : 1);
        };
        targets = targets
          .map((t) => ({ t, k: rank(t) }))
          .sort((a, b) => a.k - b.k || a.t.i - b.t.i)
          .slice(0, maxSentences)
          .map(({ t }) => t)
          .sort((a, b) => a.i - b.i);
      }

      const results: ClassifyResult[] = [];
      try {
        for (let i = 0; i < targets.length; i += batchSize) {
          const chunk = targets.slice(i, i + batchSize);
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          let res: Response;
          try {
            res = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ texts: chunk.map(({ c }) => c.sentence), lang }),
              signal: ac.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
          const json = (await res.json()) as { results: ClassifyResult[] };
          results.push(...json.results);
        }
      } catch (e) {
        if (!optional) throw e;
        const timedOut = e instanceof DOMException && e.name === "AbortError";
        console.warn(
          timedOut
            ? `[cost-model:${lang}] ${timeoutMs}ms 안에 응답이 없어 건너뜁니다(서버가 자고 있을 수 있음)`
            : `[cost-model:${lang}] 서버에 연결하지 못해 건너뜁니다:`,
          timedOut ? "" : e,
        );
        return prev;
      }

      const out = [...prev];
      targets.forEach(({ c, i }, k) => {
        const hit = results[k];
        if (!hit) return;
        const isCost = hit.prob >= threshold;
        // 확신도는 "판정 쪽" 확률로 둔다 — 부정도 확신 있게 부정해야 resolve() 가 규칙을 덮는다.
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
              reason: `학습 모델(${lang}) 비용 확률 ${(hit.prob * 100).toFixed(0)}%`,
            },
          ],
        };
      });
      return out;
    },
  };
}

/** 주소 없는 인스턴스 — **아무것도 하지 않는다.** 기존 호출부 호환용. */
export const modelAnalyzer = createModelAnalyzer();
