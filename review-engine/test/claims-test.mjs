/**
 * 페이지 표기 수집·대조 회귀 테스트 — 3사(아고다·트립닷컴·부킹닷컴) 실제 문구.
 *
 * 2026-09-24 실측: 표기 수집이 아고다 문구 하드코딩이라 트립 보증금("결제 필요"), 부킹 조식("요금: KRW90,000"),
 * 엑스트라 베드("추가 요금이 부과되는 …")를 못 잡아 페이지에 적힌 비용을 "숨은 비용"으로 경고했다.
 *
 *     node test/claims-test.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(os.tmpdir(), `review-claims-${process.pid}.mjs`);
execFileSync("npx", ["--yes", "esbuild", path.join(HERE, "..", "index.ts"), "--bundle", "--format=esm", "--platform=node", `--outfile=${OUT}`, "--log-level=warning"], { stdio: "inherit" });
const api = await import(OUT);

const cases = [
  // [페이지 문구, 리뷰 유형, 기대]  기대: disclosed = 페이지에 이미 안내됨 · conflict = 표기와 모순 · none
  ["보증금 규정\n보증금  보증금 결제 필요\n보증금 수납 방법  보증금은 투숙 기간에 따라 결정되며, 1박당 200,000원의 요금이 부과됩니다.", "보증금", "disclosed"],
  ["야외 수영장별도 요금 · 사우나별도 요금 · 스파별도 요금 · 회의실별도 요금", "기타현장결제", "disclosed"],
  ["더 파크뷰 조식 요금: 성인: KRW90,000, 아동: KRW45,000", "조식", "disclosed"],
  ["추가 요금이 부과되는 엑스트라 베드는 사전 요청이 필요합니다", "인원추가", "disclosed"],
  ["사우나는 유료 시설입니다. 입장 시 추가 요금이 부과되니 참고하시기 바랍니다", "기타현장결제", "disclosed"],
  ["세금 및 봉사료 10% 별도", "세금수수료", "disclosed"],
  ["주차: 별도 요금 또는 보증금", "주차", "disclosed"],
  ["무료 주차 · 조식 포함", "주차", "conflict"],
  ["조식 포함 총액 120,000원", "조식", "conflict"],       // 금액만으론 유료 표기가 아니다 — "포함"이 남아 충돌
  ["객실 요금 120,000원 · 체크인 15:00", "조식", "none"],  // 비용 단어 없음
  ["수영장 이용 시간 07:00~22:00", "기타현장결제", "none"], // 유료 단서 없음
  // 2026-09-24 1500건 대조에서 나온 오탐 — 이 6건은 "안내됨"이 되면 안 된다
  ["반려동물 정책\n제공된 정책 정보에는 반려동물 관련 별도 요금 또는 보증금에 관한 구체적인 조건이 안내되어 있지 않습니다.", "기타현장결제", "none"], // 아고다 보일러플레이트: 정보가 "없다"는 문장
  ["제공된 정책 정보에는 반려동물 관련 별도 요금 또는 보증금에 관한 구체적인 조건이 안내되어 있지 않습니다.", "보증금", "none"],
  ["[2박 이상] 그랜드 코너 디럭스 더블룸(실내 수영장만 이용 가능 +숙박당 KRW110,000 호텔 크레딧)", "기타현장결제", "none"], // 객실명 + 받는 돈(크레딧)
  ["주차장은 별도의 추가 비용 없이 이용할 수 있어요", "주차", "none"], // 단서 바로 뒤 부정
  ["수영장은 별도로 운영됩니다", "기타현장결제", "none"],           // 단독 '별도' 는 유료 단서가 아니다
  ["조식 별도 요청 사항은 프런트에 문의", "조식", "none"],
  // 객실 등급이 예외 조항으로 언급돼도 청구 동사가 있으면 유료 안내다 (아고다 실측, 객실명 가드 과차단 사례)
  ["- 사우나 이용 시 추가 요금이 부과됩니다(단, 이그제큐티브 객실 및 스위트 투숙객 제외).", "기타현장결제", "disclosed"],
  ["이그제큐티브 비즈니스 디럭스 트윈룸 (라운지 이용 포함, 야외 수영장 이용 불포함)", "기타현장결제", "none"], // 객실명: 불포함만 있고 청구 동사 없음
  ["[티머니 KRW10,000] 디럭스 더블룸 - 실내 수영장 이용 가능", "기타현장결제", "none"],
];

let bad = 0;
for (const [page, ft, exp] of cases) {
  globalThis.document = { body: { innerText: page } };
  const claims = api.collectOfficialClaims();
  const reviews = [{ index: 0, text: "리뷰" }, { index: 1, text: "리뷰" }];
  const cands = [0, 1].map((i) => ({ reviewIndex: i, sentence: "x", feeType: ft, verdict: "mention", confidence: 0.9, notes: [{ by: "t", stage: "rule", verdict: "mention", confidence: 0.9, reason: "" }] }));
  const ins = await api.runPipeline(reviews, claims, { analyzers: [{ name: "fake", stage: "rule", analyze: () => cands }], supportedLangs: ["ko"] });
  const r = ins.risks[0];
  const got = r?.pageConflict ? "conflict" : r?.pageDisclosed ? "disclosed" : "none";
  const ok = got === exp; if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${ft.padEnd(7)} 기대 ${exp.padEnd(9)} 결과 ${got.padEnd(9)} | ${JSON.stringify(claims).slice(0, 60)}`);
}
fs.rmSync(OUT, { force: true });
console.log(bad ? `❌ ${bad}건 실패` : `✅ 표기 대조 통과 — ${cases.length}건 전부 일치`);
process.exit(bad ? 1 : 0);
