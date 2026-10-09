// ── 리포트.html 렌더링 회귀 테스트 ──
//
// 실행:  python analyze.py --data-dir <데이터> --out <출력>
//        node test-report.mjs <출력>/리포트.html
//
// analyze.py가 만드는 리포트는 인라인 JS로 화면을 그린다. 파이썬에서 문자열로
// 조립하기 때문에 따옴표 하나만 어긋나도 **브라우저에서 빈 화면**이 되는데,
// 파이썬 단에서는 아무 오류도 안 난다. 그래서 실제로 스크립트를 실행해 본다.
//
// 인자를 안 주면 out/리포트.html 을 찾는다. 파일이 없으면 건너뛴다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(HERE, "out", "리포트.html");
// linkedom을 찾는다. 이 폴더에 설치돼 있으면 그걸 쓰고, 없으면 저장소 안의 다른 곳을 본다.
// 어디에도 없으면 테스트를 건너뛴다 — 필수 도구가 아니라 보조 장치다.
const LINKEDOM = [
  "node_modules/linkedom/esm/index.js",
  "../node_modules/linkedom/esm/index.js",
  "../../clearclause/extension/node_modules/linkedom/esm/index.js",
].map((p) => path.resolve(HERE, p)).find((p) => fs.existsSync(p));

if (!fs.existsSync(target)) {
  console.log(`⏭️  리포트가 없어 건너뜁니다: ${target}`);
  console.log("   먼저 analyze.py 를 실행하세요.");
  process.exit(0);
}
if (!LINKEDOM) {
  console.log("⏭️  linkedom이 없어 건너뜁니다 (npm i -D linkedom).");
  process.exit(0);
}
const { parseHTML } = await import(pathToFileURL(LINKEDOM).href);

const { window, document } = parseHTML(fs.readFileSync(target, "utf8"));
Object.assign(globalThis, { window, document });

let pass = 0, fail = 0;
const check = (n, c, x = "") => {
  if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${x ? "  " + x : ""}`); fail++; }
};

console.log(`\n[리포트.html 렌더링 검증]\n${target}\n`);

const scripts = [...document.querySelectorAll("script")];
try {
  (0, eval)(scripts[scripts.length - 1].textContent);
  check("스크립트가 예외 없이 실행됐다", true);
} catch (e) {
  check("스크립트가 예외 없이 실행됐다", false, `→ ${e.message}`);
  console.log("\n결과: 렌더링 실패 — 브라우저에서도 빈 화면이 됩니다.\n");
  process.exit(1);
}

const pick = (id) => document.getElementById(id)?.innerHTML || "";
const cards = pick("cards"), verdict = pick("verdict"), filters = pick("filters"), list = pick("list");
const nRv = (list.match(/class="rv"/g) || []).length;

check("지표 카드 6개가 그려졌다", (cards.match(/class="c[ "]/g) || []).length === 6);
check("중단 기준 판정이 그려졌다", verdict.includes("중단 기준"));
check("판정 막대가 그려졌다", verdict.includes('class="bars"'));
check("필터 버튼 5개", (filters.match(/<button/g) || []).length === 5);
check("리뷰가 1건 이상 렌더됐다", nRv > 0, `→ ${nRv}건`);

// 데이터에 해당 판정이 있을 때만 하이라이트를 요구한다 (표본에 따라 없을 수 있음)
const raw = document.getElementById("data").textContent.replace(/<\\\//g, "</");
const D = JSON.parse(raw);
const has = (v) => D.reviews.some((r) => r.hits.some((h) => h.verdict === v));
const anyHit = D.reviews.some((r) => r.hits.length);

if (anyHit) {
  check("키워드 하이라이트가 들어갔다", list.includes('<mark class="kw">'));
  if (has("mention")) check("비용단서 하이라이트가 들어갔다", list.includes('<mark class="cc">'));
  if (has("negated")) check("부정단서 하이라이트가 들어갔다", list.includes('<mark class="nc">'));
}
// 위치 기반으로 자르지 않으면 <mark> 안에 <mark>가 생겨 마크업이 깨진다
check("중첩된 <mark>가 없다", !/<mark[^>]*>[^<]*<mark/.test(list));

if (anyHit) {
  console.log("\n[하이라이트 샘플]");
  for (const s of [...list.matchAll(/<div class="tx">(.*?)<\/div>/gs)].slice(0, 3)) {
    console.log("  " + s[1].replace(/<mark class="(\w+)">(.*?)<\/mark>/g, (_, c, t) => `[${c}:${t}]`));
  }
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
