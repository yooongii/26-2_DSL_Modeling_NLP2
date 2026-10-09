/**
 * 리뷰 언어 판별과 라우팅.
 *
 * 왜 필요한가 — 규칙 키워드가 전부 한국어라, 언어를 안 가리면 두 가지가 동시에 망가진다.
 *   1. 외국어 리뷰가 후보에서 조용히 빠지는데 **분모에는 남아** 비용 언급 비율이 낮아 보인다.
 *   2. 반대로 "deposit", "resort fee" 처럼 영어 키워드가 우연히 걸리면 한국어 단서 규칙이
 *      주변에 없어 전부 ambiguous 로 쌓인다.
 * 그래서 분석 대상과 분모를 명시적으로 가른다. 패널은 "45건 중 31건 분석"처럼 표시한다.
 *
 * 실측에서 나온 사실 하나 — **아고다는 표시 언어가 한국어면 리뷰를 자동번역해 내려준다.**
 * 수집분에 "코스파 좋음", "~라고 생각했습니다" 같은 번역체가 섞여 있던 게 그 증거다.
 * 그래서 실무상 대부분은 한국어로 들어오고, 진짜 외국어로 남는 건 일부다.
 * 다만 번역체는 비용 표현을 뭉개므로("추가로 지불" → "별도 지불이 필요합니다") 따로 표시해 둔다.
 */
import type { LangCode, Review } from "./types";

const HANGUL = /[가-힣ᄀ-ᇿ]/g;
const KANA = /[぀-ゟ゠-ヿ]/g;
const HAN = /[一-鿿]/g;
const LATIN = /[A-Za-z]/g;

function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

/**
 * 스크립트 비율로 판별한다. 통계 모델을 쓰지 않는 이유:
 * 온디바이스에서 즉시 돌아야 하고, 리뷰는 짧아서 스크립트만으로 충분히 갈린다.
 */
export function detectLang(text: string): LangCode {
  const s = (text || "").slice(0, 400);
  const letters = count(s, HANGUL) + count(s, KANA) + count(s, HAN) + count(s, LATIN);
  if (letters < 5) return "other";

  const hangul = count(s, HANGUL) / letters;
  const kana = count(s, KANA) / letters;
  const han = count(s, HAN) / letters;
  const latin = count(s, LATIN) / letters;

  // 한국어 리뷰에도 영문 고유명사·숫자가 흔히 섞이므로 문턱을 낮게 잡는다
  if (hangul > 0.15) return "ko";
  if (kana > 0.05) return "ja";      // 가나가 조금이라도 있으면 일본어
  if (han > 0.3) return "zh";        // 가나 없이 한자만 → 중국어
  if (latin > 0.5) return "en";
  return "other";
}

/**
 * 번역체 신호. 아고다 자동번역본에서 반복적으로 관찰된 표현들이다.
 * 판정을 바꾸지는 않고 **표시만** 한다 — 번역체라고 해서 내용이 틀린 건 아니기 때문.
 * 나중에 LLM 층이 붙으면 "이 문장은 번역체라 원문 확인이 필요" 신호로 쓸 수 있다.
 */
const TRANSLATIONESE = [
  "코스파",
  "라고 생각했습니다",
  "생각합니다만",
  "해 주셨습니다",
  "이었습니다만",
  "매우 좋았습니다",
  "느낌이었습니다",
  "이라고 느꼈습니다",
];

export function looksTranslated(text: string): boolean {
  const s = text || "";
  return TRANSLATIONESE.filter((t) => s.includes(t)).length >= 2;
}

export interface LangRouting {
  /** 규칙 층이 실제로 볼 리뷰 */
  analyzable: Review[];
  /** 지금 층으로는 못 보는 리뷰 — 분모에서 빼되 숨기지 않는다 */
  unsupported: Review[];
  breakdown: Record<LangCode, number>;
  /** 번역체로 보이는 리뷰 수 — 패널 각주로 쓴다 */
  translatedCount: number;
}

/**
 * 언어별로 가른다.
 *
 * 지금은 `ko` 만 분석한다. 영어 키워드 팩을 급조하면 커버리지는 늘지만
 * 한국어 단서 규칙(COST_CUE/NEG_CUE)이 영어 문장에 안 맞아 ambiguous 만 쌓인다 —
 * 정확도가 아니라 **미측정 구간**이 늘어난다. 그래서 정직하게 빼두고,
 * 여기가 나중에 번역 LLM 층이 들어올 자리다:
 *
 *     unsupported → (translate) → analyzable
 */
export function routeByLang(reviews: Review[], supported: LangCode[] = ["ko"]): LangRouting {
  const breakdown: Record<LangCode, number> = { ko: 0, en: 0, ja: 0, zh: 0, other: 0 };
  const analyzable: Review[] = [];
  const unsupported: Review[] = [];
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
