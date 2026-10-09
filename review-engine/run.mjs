/**
 * 이 폴더의 스크립트를 돌리는 실행기.
 *
 *     node run.mjs parity        규칙 포팅이 analyze.py 와 같은 판정을 내는지
 *     node run.mjs collect-test  수집 휴리스틱 회귀 테스트 (가짜 DOM)
 *     node run.mjs demo [파일]    분석·렌더링 결과를 out/review-tab.html 로
 *     node run.mjs bundle        아고다 콘솔에 붙여넣을 번들 생성
 *
 * .ts 를 직접 import 하므로 tsx 가, 번들에는 esbuild 가 필요하다.
 * 이 폴더에 node_modules 를 새로 만들지 않고 **저장소 안에 이미 있는 것을 찾아 쓴다**
 * (review-mining/test-heuristic.mjs 가 linkedom 을 찾는 방식과 같다).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_OUT = path.join(HERE, "out/review-panel.console.js");
// 익스텐션이 실제로 읽는 파일. bundle-ext 가 여기로 내보낸다.
// 2026-09-17 에 폴더가 extension_08.30 -> extension 으로, 09-22 에 최상위 extension/ 으로 옮겨졌다.
// 없는 폴더에 쓰면 ENOENT 로 죽으므로, 쓰기 전에 존재를 확인한다(copyToExtension).
const EXT_OUT = path.join(HERE, "../extension/reviewtab.js");

const BIN_DIRS = [
  path.join(HERE, "node_modules/.bin"),
  // clearclause/ 는 2026-09-17 저장소 정리(8710d32)로 archive/ 아래로 옮겨졌다.
  // 옛 경로도 남겨둔다 — 정리 전에 클론해 둔 사람의 작업 폴더에서는 그쪽이 맞다.
  path.join(HERE, "../archive/clearclause-fulldemo/extension/node_modules/.bin"),
  path.join(HERE, "../node_modules/.bin"),
];

function findBin(name) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of BIN_DIRS) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const TASKS = {
  parity: { bin: "tsx", args: ["test/parity.mjs"] },
  "collect-test": { bin: "tsx", args: ["test/collect-test.mjs"] },
  demo: { bin: "tsx", args: ["test/demo.mjs"] },
  "model-e2e": { bin: "tsx", args: ["test/model-e2e.mjs"] },
  bundle: {
    bin: "esbuild",
    args: [
      "devpanel.ts",
      "--bundle",
      "--format=iife",
      "--target=chrome110",
      // 한글을 \uXXXX 로 escape 해 **순수 ASCII 파일**로 만든다.
      // 이 파일은 콘솔에 붙여넣어 쓰는데, 경로 어딘가에서 UTF-8이 cp949로 읽히면
      // 정규식 안의 한글이 깨져 SyntaxError 가 난다(Windows `clip` 에서 실측).
      // ASCII 로만 두면 어떤 인코딩을 거쳐도 안 깨진다.
      "--charset=ascii",
      "--outfile=out/review-panel.console.js",
    ],
  },
  // 익스텐션용 번들. 진입점이 devpanel.ts 가 아니라 _cc_entry.ts 다 —
  // 화면을 만들지 않고 window.__ccReviewTab 으로 API 만 내놓는다.
  //
  // 출력은 일단 out/ 에 받고 아래에서 Node 로 복사한다. 최종 경로에 한글과 공백이
  // 들어 있어서(`DSL Project` 등) Windows 셸 인자로 넘기면 코드페이지에 따라
  // 깨질 수 있다 — Node 의 fs 는 그런 문제가 없다.
  "bundle-ext": {
    bin: "esbuild",
    args: [
      "_cc_entry.ts",
      "--bundle",
      "--format=iife",
      "--target=chrome110",
      "--charset=ascii",
      "--outfile=out/reviewtab.js",
    ],
  },
};

const [task, ...rest] = process.argv.slice(2);
const t = TASKS[task];
if (!t) {
  console.error(`사용법: node run.mjs <${Object.keys(TASKS).join(" | ")}> [인자]`);
  process.exit(1);
}

// 저장소 안에서 못 찾으면 npx 로 받아서 쓴다. 폴더 정리 때 node_modules 가 통째로
// 사라져서 빌드가 막히는 일이 있었다(2026-09) — 그때 설치 안내만 띄우고 멈추는 대신
// 바로 돌아가게 한다. 네트워크가 없으면 npx 가 알아서 실패를 알려준다.
let bin = findBin(t.bin);
let viaNpx = false;
if (!bin) {
  bin = process.platform === "win32" ? "npx.cmd" : "npx";
  viaNpx = true;
  console.log(`ℹ️  저장소에서 ${t.bin} 을 찾지 못해 npx 로 실행합니다.`);
}

// Windows의 .cmd 래퍼는 shell 없이는 실행되지 않는다(조용히 실패한다).
// shell을 쓰면 인자에 공백이 있을 때 깨지므로 따옴표로 감싼다.
const win = process.platform === "win32";
const q = (s) => (win && /[\s&()[\]{}^=;!'+,`~]/.test(s) ? `"${s}"` : s);
const argv = viaNpx ? ["--yes", t.bin, ...t.args, ...rest] : [...t.args, ...rest];

const r = win
  ? spawnSync(q(bin), argv.map(q), { cwd: HERE, stdio: "inherit", shell: true })
  : spawnSync(bin, argv, { cwd: HERE, stdio: "inherit", shell: false });

if (r.error) {
  console.error(`❌ 실행 실패: ${r.error.message}`);
  process.exit(1);
}

if (task === "bundle" && r.status === 0) asciify(BUNDLE_OUT);
if (task === "bundle-ext" && r.status === 0) copyToExtension();

process.exit(r.status ?? 1);

/**
 * 익스텐션 폴더로 번들을 옮긴다.
 *
 * asciify 는 하지 않는다. 그건 **콘솔에 붙여넣을 때** 인코딩이 깨지는 걸 막는 장치인데,
 * 익스텐션은 크롬이 manifest 를 통해 UTF-8 로 읽으므로 그 경로가 없다.
 * (기존 reviewtab.js 도 정규식 안 한글이 그대로였다 — 같은 모양을 유지한다.)
 */
function copyToExtension() {
  const from = path.join(HERE, "out/reviewtab.js");
  if (!existsSync(from)) {
    console.error(`❌ ${from} 이 만들어지지 않았습니다.`);
    process.exit(1);
  }
  const dir = path.dirname(EXT_OUT);
  if (!existsSync(dir)) {
    console.error(`❌ 대상 폴더가 없습니다: ${dir}`);
    console.error(`   확장 폴더 이름이 바뀌었다면 run.mjs 의 EXT_OUT 을 고치세요.`);
    process.exit(1);
  }
  writeFileSync(EXT_OUT, readFileSync(from));
  console.log(`→ ${EXT_OUT}`);
}

/**
 * 번들을 **순수 ASCII** 로 만든다.
 *
 * esbuild 는 문자열 리터럴의 비ASCII 는 \uXXXX 로 escape 하지만
 * **정규식 리터럴 안은 그대로 출력한다**(`/요금|가격|.../`). 이 파일은 콘솔에 붙여넣어
 * 쓰는데, 중간에 UTF-8 이 cp949 로 읽히는 경로가 하나라도 있으면(Windows `clip` 실측)
 * 정규식 안의 한글이 깨져 `Invalid regular expression` 으로 죽는다.
 *
 * \uXXXX 는 정규식 안에서도 같은 문자를 뜻하므로 통째로 치환해도 동작이 같다.
 */
function asciify(file) {
  const src = readFileSync(file, "utf-8");
  let out = "";
  for (const ch of src) {
    const cp = ch.codePointAt(0);
    if (cp < 128) { out += ch; continue; }
    // 서로게이트 쌍(이모지 등)까지 안전하게 — 코드 유닛 단위로 쪼개 escape
    for (let i = 0; i < ch.length; i++) {
      out += "\\u" + ch.charCodeAt(i).toString(16).padStart(4, "0");
    }
  }
  writeFileSync(file, out, "ascii");
  const left = [...out].filter((c) => c.codePointAt(0) > 127).length;
  console.log(
    left === 0
      ? `✅ ASCII 전용으로 변환 — 인코딩이 깨질 여지 없음 (${out.length} bytes)`
      : `⚠️ 비ASCII ${left}자가 남았습니다`,
  );
}
