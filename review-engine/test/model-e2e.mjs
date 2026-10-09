/**
 * 학습 모델 층까지 붙은 파이프라인이 실제로 도는지 확인한다.
 *
 *   1) model-server 에서 serve.py 를 띄운다
 *   2) node run.mjs model-e2e
 *
 * 서버가 없으면 건너뛴다(모델 층은 optional 이라 규칙 결과만 나오는 게 정상 동작).
 * 여기서 보는 것은 "모델이 규칙이 놓친 것을 실제로 잡아 오는가" 하나다.
 */
import { loadLinkedom } from "./linkedom.mjs";

const ENDPOINT = "http://127.0.0.1:8799";

// 규칙이 실패하는 것으로 이미 확인된 문장들 + 명백한 음성
const REVIEWS = [
  "주차장이라고 되어있어서 당연히 무료인줄 알았는데 나중에 보니 유료주차라네요. 그 외에는 만족합니다.",
  "수건이 유료인게 아쉬웠네요. 시설은 깨끗했습니다.",
  "체크인할 때 도시세를 1박당 3.5유로 따로 받았습니다.",
  "위치도 좋고 직원분들도 친절했습니다. 다음에 또 오고 싶어요.",
  "조식이 정말 맛있었어요. 종류도 다양하고 만족스러웠습니다.",
];

const linkedom = await loadLinkedom();
if (!linkedom) {
  console.log("⏭️  linkedom 이 없어 건너뜁니다.");
  process.exit(0);
}

// 서버 확인
let up = false;
try {
  const r = await fetch(`${ENDPOINT}/health`);
  up = r.ok;
  if (up) console.log("서버:", JSON.stringify(await r.json()));
} catch {
  /* 아래에서 처리 */
}
if (!up) {
  console.log(`⏭️  ${ENDPOINT} 에 서버가 없어 건너뜁니다.`);
  console.log("   먼저: cd model-server && ./.venv/Scripts/python.exe serve.py");
  process.exit(0);
}

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
globalThis.window = dom.window ?? dom;
globalThis.document = dom.document;

const { runPipeline } = await import("../analyze.ts");
const { ruleAnalyzer } = await import("../rules.ts");
// 주소를 명시해서 만든다. modelAnalyzer(기성품)는 주소가 없어 아무것도 하지 않으므로
// 그걸 쓰면 이 테스트가 "모델이 한 건도 못 잡았다"고 잘못 보고한다.
const { createModelAnalyzer } = await import("../modelAnalyzer.ts");
const modelAnalyzer = createModelAnalyzer({ endpoint: `${ENDPOINT}/classify` });

const reviews = REVIEWS.map((text, index) => ({ index, text, date: null, rating: null }));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

console.log("\n[규칙만]");
const ruleOnly = await runPipeline(reviews, [], { analyzers: [ruleAnalyzer], collecting: false });
const ruleHits = new Set(ruleOnly.candidates.filter((c) => c.verdict === "mention").map((c) => c.reviewIndex));
console.log("  mention 리뷰:", [...ruleHits].sort().join(", ") || "(없음)");

console.log("\n[규칙 + 모델]");
const both = await runPipeline(reviews, [], {
  analyzers: [ruleAnalyzer, modelAnalyzer], collecting: false,
});
const modelCands = both.candidates.filter((c) => c.decidedBy === "cost-model");
const modelHits = new Set(modelCands.map((c) => c.reviewIndex));
console.log("  모델 판정 리뷰:", [...modelHits].sort().join(", ") || "(없음)");
for (const c of modelCands) {
  console.log(`    #${c.reviewIndex} p=${c.confidence.toFixed(3)}  ${c.sentence.slice(0, 46)}…`);
}

console.log("\n검사");
check("모델 층이 실제로 호출됐다", both.stagesRun.includes("cost-model"), both.stagesRun.join(" → "));
check("양성 3건(0,1,2)을 모두 잡는다", [0, 1, 2].every((i) => modelHits.has(i)),
  `잡은 것: ${[...modelHits].sort()}`);
check("음성 2건(3,4)은 안 잡는다", ![3, 4].some((i) => modelHits.has(i)));
check("규칙이 놓친 것을 모델이 잡았다", [...modelHits].some((i) => !ruleHits.has(i)),
  `규칙 ${[...ruleHits].sort()} vs 모델 ${[...modelHits].sort()}`);
check("패널에 노출된다(2건 이상 규칙 통과)", both.risks.some((r) => r.shown),
  both.risks.map((r) => `${r.feeType}:${r.reviewCount}`).join(" "));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
if (fail) process.exit(1);
