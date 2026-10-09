// ── inspect.js 스모크 테스트 ──
//
// 실행:  node test-inspect.mjs
//
// 검사 패널은 콘솔에 붙여넣어야 볼 수 있어서, 고칠 때마다 브라우저를 열면 느리다.
// 가짜 DOM에 패널을 띄워서 (1) 예외 없이 뜨는지 (2) 세 탭이 내용을 그리는지 확인한다.
// 렌더링 결과의 '모양'까지는 못 보지만, 깨진 채로 붙여넣는 사고는 막을 수 있다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// linkedom을 찾는다. 이 폴더에 설치돼 있으면 그걸 쓰고, 없으면 저장소 안의 다른 곳을 본다.
// 어디에도 없으면 테스트를 건너뛴다 — 필수 도구가 아니라 보조 장치다.
const LINKEDOM = [
  "node_modules/linkedom/esm/index.js",
  "../node_modules/linkedom/esm/index.js",
  "../../clearclause/extension/node_modules/linkedom/esm/index.js",
].map((p) => path.resolve(HERE, p)).find((p) => fs.existsSync(p));

if (!LINKEDOM) {
  console.log("⏭️  linkedom이 없어 테스트를 건너뜁니다.");
  console.log("   `npm i -D linkedom` 후 다시 실행하세요.");
  process.exit(0);
}
const { parseHTML } = await import(pathToFileURL(LINKEDOM).href);

const COLLECT = fs.readFileSync(path.join(HERE, "collect-reviews.js"), "utf8");
const INSPECT = fs.readFileSync(path.join(HERE, "inspect.js"), "utf8");

// ── 가짜 페이지 (test-heuristic.mjs와 같은 함정 구성) ────────
const REVIEWS = [
  ["김민수", "2026년 7월", "별점 5점", "위치도 좋고 깨끗했어요. 주차는 무료라서 편했습니다."],
  ["이서연", "2026년 6월", "별점 4점", "다 좋았는데 주차비를 현장에서 따로 받더라고요. 하루 2만원이었습니다."],
  ["박지훈", "2026년 5월", "별점 4점", "호스트분이 친절하셨어요. 조식은 포함이 아니라 별도로 결제해야 했습니다."],
  ["최유진", "2026년 4월", "별점 3점", "보증금 10만원을 체크인 때 요구했어요. 나중에 돌려받긴 했습니다."],
];
const cards = REVIEWS.map(([n, d, r, b]) => `
  <div class="_c8x9k"><div class="_hdr"><span>${n}</span><span>${d}</span></div>
  <div aria-label="${r}">★</div><div><span>${b}</span></div></div>`).join("");
const decoy = ["2026. 9. 1.", "2026. 9. 2.", "2026. 9. 3.", "2026. 9. 4."]
  .map((d) => `<div><span>${d}</span></div>`).join("");

const HTML = `<html><body>
  <h1>한옥 돌담집</h1>
  <div class="_amen"><ul><li>무료 주차</li><li>무료 Wi-Fi</li><li>셀프 체크인</li></ul></div>
  <div class="_cal"><div class="_grid">${decoy}</div></div>
  <section class="_rv"><h2>후기 60개</h2><button>후기 60개 모두 보기</button>
    <div class="_lst">${cards}</div></section>
  <footer><span>2026 회사</span></footer>
</body></html>`;

// ── 브라우저 API 셰임 ────────────────────────────────────────
const { window, document } = parseHTML(HTML);
const EP = Object.getPrototypeOf(document.createElement("div"));
if (!("innerText" in EP)) {
  Object.defineProperty(EP, "innerText", { get() { return this.textContent; }, configurable: true });
}
EP.scrollIntoView = function () {};
EP.getBoundingClientRect = function () { return { left: 0, top: 0, width: 400, height: 600 }; };

window.getComputedStyle = () => ({ overflowY: "visible", visibility: "visible", display: "block" });
window.MouseEvent = class { constructor(type) { this.type = type; } };
window.location = { hostname: "www.airbnb.co.kr", pathname: "/rooms/1004020027854453112", search: "", href: "x" };

Object.assign(globalThis, {
  window, document, location: window.location, URLSearchParams,
  getComputedStyle: window.getComputedStyle, MouseEvent: window.MouseEvent,
  alert: () => {}, setTimeout,
});
// node의 navigator/URL은 getter만 있어 Object.assign으로는 못 덮는다
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } }, configurable: true,
});
Object.defineProperty(globalThis, "URL", {
  value: { createObjectURL: () => "", revokeObjectURL: () => {} }, configurable: true,
});

// ── 검증 ─────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (n, c, x = "") => {
  if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${x ? "  " + x : ""}`); fail++; }
};

console.log("\n[inspect.js 스모크 테스트]\n");

const real = { ...console };
console.log = console.group = console.groupEnd = console.table = () => {};
try {
  (0, eval)(COLLECT);
  (0, eval)(INSPECT);
  Object.assign(console, real);
  check("두 스크립트가 예외 없이 실행됐다", true);
} catch (e) {
  Object.assign(console, real);
  check("두 스크립트가 예외 없이 실행됐다", false, `→ ${e.message}`);
  console.log(`\n결과: 패널이 뜨지 않습니다.\n`);
  process.exit(1);
}

const host = document.getElementById("__rvInspect");
check("패널 호스트가 body에 붙었다", !!host);
const sr = host?.shadowRoot;
check("Shadow DOM이 만들어졌다 (사이트 CSS와 격리)", !!sr);

if (sr) {
  const q = (s) => sr.querySelector(s);
  const bodyHTML = () => q("#body")?.innerHTML || "";
  const actsHTML = () => q("#acts")?.innerHTML || "";

  check("탭 3개가 있다", sr.querySelectorAll(".tabs button").length === 3);
  check("상단 정보줄에 사이트가 표시된다", (q("#info")?.innerHTML || "").includes("airbnb"));
  check("컨테이너를 찾았다고 표시된다", !(q("#info")?.innerHTML || "").includes("없음"));

  // [탐색]
  check("[탐색] 후보 행이 그려졌다", (bodyHTML().match(/class="row/g) || []).length > 0);
  check("[탐색] 점수 배지가 있다", bodyHTML().includes("t-score"));
  check("[탐색] 자동선택 배지가 있다", bodyHTML().includes("t-auto"));
  check("[탐색] 하단에 모달 열기 버튼", actsHTML().includes("모달 열기"));

  // [카드]
  sr.querySelector('.tabs button[data-t="card"]').onclick();
  check("[카드] 채택/제외가 표시된다", bodyHTML().includes("채택"));
  check("[카드] 리뷰 4건이 채택됐다", (bodyHTML().match(/t-ok/g) || []).length === 4,
    `→ ${(bodyHTML().match(/t-ok/g) || []).length}건`);

  // [결과]
  sr.querySelector('.tabs button[data-t="out"]').onclick();
  check("[결과] 수집 전 안내가 뜬다", bodyHTML().includes("아직 수집하지 않았습니다"));
  check("[결과] 현재 잡히는 건수를 보여준다", bodyHTML().includes("4건"));
  check("[결과] 수집 실행 버튼이 있다", actsHTML().includes("수집 실행"));

  check("stopInspect()가 노출됐다", typeof globalThis.stopInspect === "function");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
