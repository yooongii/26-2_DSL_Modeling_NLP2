/**
 * 팀원 UI 목업이 나오기 전에 탭 2를 눈으로 확인하는 개발용 하네스.
 *
 *     npm run review:demo            # 내장 샘플로
 *     npm run review:demo -- <파일>   # 수집기 json 또는 md2json 결과로
 *
 * 브라우저를 안 열고 linkedom 가짜 DOM 위에 실제 렌더러를 돌린 뒤 out/review-tab.html 로
 * 저장한다. 수집 단계(autoCollect)는 건너뛰고 **분석 + 렌더링만** 검증한다 —
 * 수집은 실제 사이트에서만 의미가 있어서 여기서 흉내내면 오히려 오해를 만든다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLinkedom } from "./linkedom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../out/review-tab.html");

// 실측에서 나온 문장들을 리뷰 모양으로 묶었다(같은 유형이 2건 이상 되도록 — 노출 규칙 확인용)
const SAMPLE = [
  "위치도 좋고 깨끗했어요. 주차장이라고 되어있어서 당연히 무료인줄 알았는데 나중에 보니 유료주차라네요.",
  "한국과 달리 호텔 주차장은 유료라서 조금 아쉬웠지만, 위치도 좋고 직원분들도 친절했습니다.",
  "지하주차장도 무료이니 참고요~ 신라스테이는 룸 구조도 깔끔합니다.",
  "세탁기를 사용하려면 추가로 30바트를 지불해야 하며 무료 아침 식사가 없습니다.",
  "조식 포함으로 예약했는데 마지막 날 추가 요금을 받고, 직원분도 친절하지 않았어요.",
  "이 가격에 조식 포함인게 대단. 먹지는 않았지만요.",
  "인원 추가 요금이 있다는 안내가 명확해서 좋았어요.",
  "청소비가 좀 비싼 편이지만 그만큼 깨끗했습니다.",
  "체크인할 때 100엔을 결제해야 하는데 트래블 월렛 카드로 결제가 안돼 힘들었습니다.",
  "Great location and very clean room. Staff were friendly and helpful.",
  "駅から近くて便利でした。部屋も清潔で満足しています。",
  "고질라 뷰가 신기했어요. 신주쿠역에서 가깝고 위치가 최고입니다.",
];

function loadReviews(file) {
  if (!file) {
    return SAMPLE.map((text, index) => ({ index, text, date: null, rating: null }));
  }
  const d = JSON.parse(fs.readFileSync(file, "utf-8"));
  const rs = d.reviews ?? [];
  return rs.map((r, index) => ({
    index,
    text: r.text ?? "",
    date: r.date ?? null,
    rating: r.rating ?? null,
  }));
}

const linkedom = await loadLinkedom();
if (!linkedom) {
  console.log("⏭️  linkedom 이 없어 건너뜁니다. clearclause/extension 에서 npm install 하세요.");
  process.exit(0);
}

const { document } = linkedom.parseHTML(
  `<!doctype html><html><head><meta charset="utf-8"><title>탭 2 미리보기</title></head>
   <body style="margin:0;background:#f3f4f6">
     <div id="tab" style="max-width:420px;margin:24px auto;background:#fff;padding:16px;
          border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08)"></div>
   </body></html>`,
);

// 렌더러는 브라우저 전역을 쓴다 — 가짜 DOM을 전역에 얹어준다
globalThis.document = document;
globalThis.HTMLElement = document.defaultView.HTMLElement;

const { runPipeline } = await import("../analyze.ts");
const { renderInsights } = await import("../panel.ts");

const file = process.argv[2];
const reviews = loadReviews(file);
const official = ["무료 주차", "조식 포함"]; // 표기 충돌 표시를 확인하기 위한 값

const insights = await runPipeline(reviews, official, { collecting: false });

const el = document.getElementById("tab");
renderInsights(el, insights);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `<!doctype html>\n${document.documentElement.outerHTML}`, "utf-8");

console.log(`리뷰 ${insights.totalReviews}건 · 분석 ${insights.analyzedReviews}건`);
console.log(
  `언어: ${Object.entries(insights.langBreakdown)
    .filter(([, n]) => n)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ")}`,
);
console.log(
  `판정: mention ${insights.verdictCounts.mention} · ` +
  `ambiguous ${insights.verdictCounts.ambiguous} · negated ${insights.verdictCounts.negated}`,
);
console.log("노출 대상:");
for (const r of insights.risks) {
  console.log(`  ${r.shown ? "✅" : "  "} ${r.feeType} — ${r.shownReason}` +
    (r.pageConflict ? ` · 표기 충돌: "${r.pageConflict}"` : ""));
}
console.log(`\n✅ ${OUT}`);
