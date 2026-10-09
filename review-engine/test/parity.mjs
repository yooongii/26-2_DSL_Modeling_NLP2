/**
 * lib/review/rules.ts 가 labeling/analyze.py 와 **같은 판정**을 내는지 검증한다.
 *
 * 왜 필요한가: 브라우저 판정과 오프라인 집계가 어긋나면 라벨링해 둔 골드가 무의미해진다.
 * 규칙을 고칠 때 한쪽만 고치는 사고가 실제로 나기 쉬운 자리라 자동으로 막는다.
 *
 *     node scripts/review-parity.mjs
 *
 * 파이썬이 없으면 건너뛴다(테스트 실패로 치지 않는다) — segment.ts 의 parity 와 같은 방침.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.resolve(HERE, "../../labeling");

/** 실측에서 실제로 나온 문장들 + 규칙이 걸려 넘어지는 것들을 일부러 섞었다. */
const SAMPLES = [
  "주차장이라고 되어있어서 당연히 무료인줄 알았는데 나중에 보니 유료주차라네요.",
  "지하주차장도 무료이니 참고요~",
  "세탁기를 사용하려면 추가로 30바트를 지불해야 하며 무료 아침 식사가 없습니다.",
  "인원 추가 요금이 있다는 안내가 명확해서 좋았어요.",
  "조식 포함으로 예약했는데 마지막 날 추가 요금을 받고, 한국인 직원분도 친절하지도 않고…",
  "청소비가 좀 비싼 편이지만 그만큼 깨끗했습니다.",
  "조식이 정말 맛있었어요. 가격도 저렴하고.",
  "주차는 무료인데 조식은 따로 받아요.",
  "청구역에서 도보 1분 이내, 동대문 디자인 프라자까지 도보 10분 정도로 위치도 좋았습니다.",
  "체크인할 때 100엔을 결제해야 하는데 트래블 월렛 카드로 결제가 안돼 힘들었습니다.",
  "보증금은 체크아웃할 때 돌려받았습니다.",
  "리조트 요금이 별도로 부과된다는 걸 현장에서 알았어요.",
  "수건이 유료인게 아쉬웠네요.",
  "세금 및 수수료 포함 가격이라 추가 요금 없었습니다.",
  "이 가격에 조식 포함인게 대단.",
];

// 샘플은 stdin이 아니라 **utf-8 임시 파일**로 넘긴다.
// 한글 Windows에서 파이썬 stdin 기본 인코딩이 cp949라 utf-8 입력이 깨진다(실측).
const IN_FILE = path.join(os.tmpdir(), `review-parity-${process.pid}.json`);
const OUT_FILE = path.join(os.tmpdir(), `review-parity-${process.pid}-out.json`);

const PY = `
import json, sys, io
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import analyze
samples = json.load(io.open(${JSON.stringify(IN_FILE)}, encoding="utf-8"))
out = []
for text in samples:
    for sent in analyze.split_sentences(text):
        for fee_type, kw, pos in analyze.find_fee_hits(sent):
            verdict, cost, neg = analyze.judge(sent, kw, pos)
            out.append({
                "sentence": sent, "feeType": fee_type, "keyword": kw,
                "pos": pos, "verdict": verdict,
                "costCues": cost, "negCues": neg,
            })
io.open(${JSON.stringify(OUT_FILE)}, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False))
`;

function runPython() {
  fs.writeFileSync(IN_FILE, JSON.stringify(SAMPLES), "utf-8");
  try {
    for (const exe of ["python", "python3", "py"]) {
      try {
        execFileSync(exe, ["-c", PY], { stdio: ["ignore", "pipe", "pipe"] });
        return JSON.parse(fs.readFileSync(OUT_FILE, "utf-8"));
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        console.error(String(e.stderr ?? e.message).slice(0, 600));
        return null;
      }
    }
    return null;
  } finally {
    for (const f of [IN_FILE, OUT_FILE]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

async function runTs() {
  const { splitSentences, findFeeHits, judge } = await import("../rules.ts");
  const out = [];
  for (const text of SAMPLES) {
    for (const sentence of splitSentences(text)) {
      for (const { feeType, keyword, pos } of findFeeHits(sentence)) {
        const { verdict, costCues, negCues } = judge(sentence, keyword, pos);
        out.push({ sentence, feeType, keyword, pos, verdict, costCues, negCues });
      }
    }
  }
  return out;
}

const key = (r) => `${r.sentence}|${r.feeType}|${r.keyword}|${r.pos}`;
const norm = (a) => [...a].sort().join(",");

const py = runPython();
if (!py) {
  console.log("⏭️  파이썬을 찾지 못해 건너뜁니다 (parity 미검증)");
  process.exit(0);
}
if (!fs.existsSync(path.join(PY_DIR, "analyze.py"))) {
  console.log(`⏭️  ${PY_DIR}/analyze.py 가 없어 건너뜁니다`);
  process.exit(0);
}

const ts = await runTs();

const pyMap = new Map(py.map((r) => [key(r), r]));
const tsMap = new Map(ts.map((r) => [key(r), r]));
const allKeys = new Set([...pyMap.keys(), ...tsMap.keys()]);

let fail = 0;
for (const k of allKeys) {
  const p = pyMap.get(k);
  const t = tsMap.get(k);
  if (!p) { console.error(`❌ TS에만 있음: ${k}`); fail++; continue; }
  if (!t) { console.error(`❌ PY에만 있음: ${k}`); fail++; continue; }
  if (p.verdict !== t.verdict) {
    console.error(`❌ 판정 불일치 [${k}]\n     py=${p.verdict}  ts=${t.verdict}`);
    fail++;
  } else if (norm(p.costCues) !== norm(t.costCues) || norm(p.negCues) !== norm(t.negCues)) {
    console.error(
      `❌ 단서 불일치 [${k}]\n     py cost=${norm(p.costCues)} neg=${norm(p.negCues)}` +
      `\n     ts cost=${norm(t.costCues)} neg=${norm(t.negCues)}`,
    );
    fail++;
  }
}

const counts = ts.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {});
console.log(
  `문장 ${SAMPLES.length}개 → 후보 ${ts.length}건 ` +
  `(mention ${counts.mention ?? 0} · ambiguous ${counts.ambiguous ?? 0} · negated ${counts.negated ?? 0})`,
);

if (fail) {
  console.error(`\n❌ parity 실패 ${fail}건 — rules.ts 와 analyze.py 가 어긋났습니다.`);
  process.exit(1);
}
console.log(`✅ parity 통과 — ${allKeys.size}건 전부 일치`);
