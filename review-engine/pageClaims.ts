/**
 * 페이지 표기(공식 주장) — 수집(collect.ts)과 대조(analyze.ts)가 **같은 표**를 쓰게 한 곳.
 *
 * 2026-09-24 실측(리뷰 1500건·3사 페이지): 표기 수집이 아고다 문구 기준 하드코딩이라
 * 트립닷컴은 절반, 부킹닷컴은 유료 표기 0건이었다. 원인 네 가지를 여기서 한 번에 고친다.
 *   1. 유료 단서에 "부과·청구·결제 필요·요금이 발생"이 없었다 → 트립 "보증금 결제 필요" 못 잡음
 *   2. 기타현장결제·세금수수료는 대조 매핑이 없어 무조건 "숨은 비용"으로 올라갔다
 *   3. 비용 단어 목록이 rules.ts 의 FEE_KEYWORDS 와 따로 관리돼 확장 때마다 어긋났다 → 여기서 생성
 *   4. 금액을 유료 증거로 안 봐서 부킹 "조식 요금: KRW90,000" 을 버렸다 → 비용 단어와 25자 안이면 인정
 */
import { KO_TABLES } from "./rules";
import type { FeeType } from "./types";

/** 편의시설 — 리뷰 규칙 키워드엔 없지만 페이지에선 "사우나 별도 요금"처럼 유료 표기가 붙는 것들.
 *  구체 유형이 없으므로 기타현장결제로 대조한다. */
export const FACILITY_WORDS = [
  "수영장", "사우나", "스파", "피트니스", "헬스장", "짐", "세탁", "드라이 클리닝", "미니바",
  "와이파이", "Wi-Fi", "짐 보관", "셔틀", "욕탕", "온천", "회의실", "라운지", "주방", "바비큐", "BBQ",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
const alternation = (words: string[]) =>
  [...new Set(words)].sort((a, b) => b.length - a.length).map(escapeRe).join("|");

/** 비용 단어 — rules.ts 의 한국어 키워드 전부 + 편의시설. 키워드를 늘리면 여기도 같이 늘어난다. */
export const FEE_WORD = alternation([...Object.values(KO_TABLES.feeKeywords).flat(), ...FACILITY_WORDS]);

/** 유료라고 밝히는 단서 */
export const PAID_CUE =
  "유료|별도\\s*(?:요금|결제|부과|비용)|현장\\s*(?:결제|지불|징수)|추가\\s*(?:요금|비용|금액)|불포함|미포함|포함되지\\s*않|포함\\s*(?:안|아니)|부과|청구|결제\\s*(?:필요|해야)|요금이\\s*(?:발생|있)|요금\\s*:|별도\\s*[.)]?\\s*$";
/** 금액. 비용 단어와 25자 안에 붙어 있을 때만 유료 증거로 본다 (DISCLOSED_RE 가 그렇게 묶는다) */
export const MONEY =
  "(?:KRW|₩|USD|\\$|€|¥|£)\\s*\\d[\\d,.]*|\\d[\\d,.]*\\s*(?:원|만원|천원|달러|위안|엔|바트|유로)";

/** ① 무료·포함이라고 밝힌 표기 — 리뷰가 유료라고 하면 "표기와 다름" */
export const OFFICIAL_RE =
  /무료\s*(?:주차|와이파이|Wi-?Fi|조식|취소|셔틀)|조식\s*(?:포함|무료)|주차\s*(?:무료|가능)|세금\s*및\s*수수료\s*포함|추가\s*요금\s*없음|전\s*객실\s*금연/gi;

/** ② 유료라고 이미 밝힌 표기 — 비용 단어와 유료 단서(또는 금액)가 25자 안에 */
export const DISCLOSED_RE = new RegExp(
  `(?:${FEE_WORD})[^\\n]{0,25}?(?:${PAID_CUE}|${MONEY})|(?:${PAID_CUE}|${MONEY})[^\\n]{0,25}?(?:${FEE_WORD})`,
  "gi",
);
const PAID_WORD_RE = new RegExp(PAID_CUE, "i");
const MONEY_RE = new RegExp(MONEY, "i");
/** "조식 포함 120,000원" 처럼 금액만 있고 포함·무료라고 쓴 건 유료 표기가 아니다 */
const FREE_CUE_RE = /무료|공짜|포함(?!되지|\s*안|\s*아니)/;

/** "추가 요금 없이", "별도 요금은 없" — 단서 바로 뒤에 부정이 붙은 표기는 유료가 아니다 */
const NEG_ADJACENT_RE = /(?:추가\s*(?:요금|비용|금액)|별도\s*(?:요금|비용)|부과|청구)\s*(?:은|는|이|가|도)?\s*(?:없|않)/;
/** "…조건이 안내되어 있지 않습니다" — 정보가 없다는 문장 (아고다 반려동물 정책 보일러플레이트가 거의 모든 페이지에 있다) */
const NEG_ABSENT_RE = /안내(?:되어)?\s*있지\s*않|명시(?:되어)?\s*있지\s*않|조건이\s*안내|정보(?:가|는)?\s*없/;
/** 객실·요금제 제목 — "디럭스 더블룸(실내 수영장 + KRW110,000 호텔 크레딧)" 은 시설 안내가 아니다 */
const ROOM_TITLE_RE = /디럭스|스위트|트윈룸|더블룸|싱글룸|스탠다드|슈페리어|이그제큐티브|프리미어|패밀리룸|온돌|스튜디오/;
/** 청구 동사 — 객실 제목에는 없다. "사우나 추가 요금 부과(단, 스위트 투숙객 제외)" 는 등급이 언급돼도 유료 안내다 */
const PAID_VERB_RE = /부과|청구|지불|결제|발생|대여|유료|내야|받습니다|징수/;
/** 받는 돈 — 금액이 있어도 유료 증거가 아니다 */
const REWARD_RE = /크레딧|적립|할인|쿠폰|캐시백|상당|포인트|마일리지|티머니/;

/** 표기 문자열이 유료 증거를 담고 있는가 (단서 또는 금액). analyze.ts 의 findDisclosed 가 쓴다 */
export function looksPaid(claim: string): boolean {
  if (NEG_ADJACENT_RE.test(claim) || NEG_ABSENT_RE.test(claim)) return false;
  if (ROOM_TITLE_RE.test(claim) && !PAID_VERB_RE.test(claim)) return false;
  if (PAID_WORD_RE.test(claim)) return true;
  return MONEY_RE.test(claim) && !FREE_CUE_RE.test(claim) && !REWARD_RE.test(claim);
}

const DISCLOSED_TEST_RE = new RegExp(DISCLOSED_RE.source, "i"); // 비전역 사본 (test 용)
/** 페이지 텍스트를 표기 단위로 자른다 — 줄, 구분점(·•|), 문장부호. 너무 짧거나 긴 조각은 버린다 */
const SEGMENT_SPLIT = /\n+|\s*[·•|]\s*|(?<=[.!?。])\s+/;

/**
 * 페이지 본문에서 ①·② 표기를 뽑는다. 최대 30개.
 * ②는 최소 매치 문자열이 아니라 **조각 전체**를 표기로 남긴다 — "추가 요금이 부과되는 엑스트라 베드는
 * 사전 요청이 필요합니다"에서 "추가 요금이 부과"만 남기면 대조 때 엑스트라 베드를 못 찾는다(실측).
 */
export function extractClaims(text: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const official = (text.match(OFFICIAL_RE) ?? []).map(norm);
  const disclosed: string[] = [];
  for (const raw of text.split(SEGMENT_SPLIT)) {
    const seg = norm(raw);
    if (seg.length < 4 || seg.length > 160) continue;
    if (DISCLOSED_TEST_RE.test(seg) && looksPaid(seg)) disclosed.push(seg);
  }
  return Array.from(new Set([...official, ...disclosed])).slice(0, 30);
}

/** 유료 표기 → 비용 유형. rules.ts 키워드에서 생성하고, 기타현장결제엔 편의시설을 더한다. */
export const DISCLOSED_TO_FEE: [RegExp, FeeType][] = (Object.keys(KO_TABLES.feeKeywords) as FeeType[]).map(
  (ft) => [
    new RegExp(alternation([...KO_TABLES.feeKeywords[ft], ...(ft === "기타현장결제" ? FACILITY_WORDS : [])]), "i"),
    ft,
  ],
);
