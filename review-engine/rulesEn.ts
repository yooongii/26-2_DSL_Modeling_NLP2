/**
 * 영어 규칙 표 — labeling/rules_en.py 와 1:1. 판정 로직은 rules.ts 의 것을 그대로 쓴다.
 *
 * 영어 리뷰가 필요한 이유: 아고다는 표시 언어가 한국어면 리뷰를 자동번역해 주지만
 * 전부는 아니고, 해외 숙소는 원문 영어가 그대로 오는 비율이 높다(실측). 그 리뷰들을
 * 분석 대상에 넣지 않으면 분모에서만 빠져 "비용 언급 비율"이 실제보다 낮아 보인다.
 *
 * 영어 모델(distilbert)은 **이 규칙이 뽑은 후보 문장**을 입력으로 학습했다
 * (labeling/dataset_en_*.jsonl 의 text = 키워드가 든 문장 1개). 그래서 이 층이 없으면
 * 영어 모델은 돌 후보 자체가 없다.
 */
import type { FeeType } from "./types";
import { createRuleAnalyzer, type RuleTables } from "./rules";

export const FEE_KEYWORDS_EN: Record<FeeType, string[]> = {
  주차: ["parking fee", "parking charge", "self-parking", "self parking", "valet parking", "valet fee", "overnight parking", "parking"],
  리조트피: ["resort fee", "resort charge", "destination fee", "amenity fee", "facility fee"],
  보증금: ["security deposit", "incidental deposit", "deposit hold", "hold on my card", "authorization hold", "deposit"],
  도시세: ["city tax", "tourist tax", "occupancy tax", "tourism fee", "local tax", "visitor levy"],
  청소비: ["cleaning fee", "housekeeping fee"],
  조식: ["breakfast buffet", "continental breakfast", "breakfast"],
  인원추가: ["extra person", "additional guest", "per person charge", "extra guest fee", "third person"],
  세금수수료: ["taxes and fees", "tax and fees", "service charge", "surcharge", "booking fee", "resort tax", "tax", "fees"],
  기타현장결제: ["charged at check-in", "charged on arrival", "pay at the property", "paid on site", "pay on arrival", "charged at the front desk"],
} as Record<FeeType, string[]>;

export const AMENITY_TYPES_EN: ReadonlySet<FeeType> = new Set<FeeType>(["조식", "주차", "세금수수료"]);

// 편의시설 이름만 나온 문장을 거르는 게이트 (한국어판 COST_CONTEXT_RE 대응)
const COST_CONTEXT_RE_EN =
  /fee|charge|charged|price|cost|pay|paid|billed|deposit|surcharge|free|complimentary|included|extra|additional|separate|per night|per day|[$€£]\s*\d|\d+\s*(?:usd|eur|gbp|dollars?|euros?)/i;

// 추가비용이 '실제로 발생했다'는 쪽 단서
const COST_CUE_EN = [
  "not included", "not inclusive", "excluded", "on top of", "in addition to",
  "extra", "additional", "separate", "separately", "surcharge", "hidden",
  "charged", "charge", "charges", "billed", "they charged",
  "had to pay", "have to pay", "must pay", "required to pay", "made us pay",
  "paid extra", "cost us", "per night", "per day", "per person",
  "added to", "tacked on", "upcharge", "mandatory", "non-optional",
  "$", "usd", "eur", "gbp",
];

// 오히려 '무료였다'는 쪽 단서
const NEG_CUE_EN = [
  "free", "complimentary", "no charge", "no fee", "no extra", "no additional",
  "at no cost", "included", "inclusive", "was included", "comes with",
  "provided", "on the house", "waived", "did not charge", "didn't charge",
  "no hidden", "without any charge", "gratis",
];

// 영어 문장 분리 — 약어(Mr. / U.S. / a.m.) 뒤에서 자르지 않는다.
const SENT_SPLIT_EN =
  /(?<!\bMr)(?<!\bMrs)(?<!\bMs)(?<!\bDr)(?<!\bSt)(?<!\bJr)(?<!\bSr)(?<!\bvs)(?<!\betc)(?<!\ba\.m)(?<!\bp\.m)(?<!\bU\.S)(?<=[.!?])\s+(?=[A-Z"'(])|\n+/;

const HOTEL_REPLY_RE_EN =
  /thank you for (?:your (?:review|stay|feedback)|choosing|taking the time)|we (?:appreciate|value) your (?:feedback|review|comments)|we (?:hope|look forward) to (?:welcome|see|serve) you|(?:general manager|guest relations|front office manager)|on behalf of (?:the|our) (?:entire )?team/i;

export const EN_TABLES: RuleTables = {
  feeKeywords: FEE_KEYWORDS_EN,
  amenityTypes: AMENITY_TYPES_EN,
  costContextRe: COST_CONTEXT_RE_EN,
  costCue: COST_CUE_EN,
  negCue: NEG_CUE_EN,
  // 영어는 한 단어가 길어 한국어(25자)보다 창을 넓게 잡는다.
  window: 60,
  sentSplit: SENT_SPLIT_EN,
  hotelReplyRe: HOTEL_REPLY_RE_EN,
  caseInsensitive: true,
};

/** 영어 규칙 층. */
export const ruleAnalyzerEn = createRuleAnalyzer("rule-baseline-en", ["en"], EN_TABLES);
