"""비용 언급 라벨링 도구.

    python label.py init    out/후보.jsonl  →  labels/라벨링.csv  (엑셀로 열어서 채운다)
    python label.py score   labels/라벨링.csv 채점 → 규칙 베이스라인 성적표

왜 CSV로 빼는가:
  analyze.py는 실행할 때마다 out/ 전체를 다시 쓴다. 후보.jsonl 안에서 라벨을 채우면
  다음 실행에 전부 날아간다. labels/ 는 analyze.py가 건드리지 않으므로 안전하다.

왜 init 이 병합인가:
  리뷰를 더 수집하면 후보가 늘어난다. 그때마다 처음부터 다시 라벨링하면 못 버틴다.
  이미 채운 라벨은 cand_id 로 찾아 그대로 옮기고, 새 후보만 빈 칸으로 덧붙인다.
"""

import argparse
import csv
import hashlib
import json
import pathlib
import sys
from collections import Counter

HERE = pathlib.Path(__file__).resolve().parent

COLUMNS = [
    "cand_id",       # 자동 — 건드리지 말 것
    "gold",          # ★ 사람이 채우는 칸: 1 / 0 / ?
    "rule_verdict",  # 규칙 판정 (참고용, 정답 아님)
    "fee_type",
    "keyword",
    "sentence",
    "cost_cues",
    "neg_cues",
    "listingId",
    "date",
    "rating",
    "note",          # 자유 메모
]

GOLD_HELP = """gold 칸에 넣을 값
  1  이 문장은 실제로 '돈을 더 냈다/내야 한다'는 얘기다
  0  아니다 (무료였다 · 비용 얘기가 아니다 · 칭찬이다)
  ?  판단 보류 — 사람이 봐도 모르겠다"""


def cand_id(rec: dict) -> str:
    """후보를 다시 만들어도 같은 문장이면 같은 id가 나와야 병합이 된다."""
    raw = "|".join(str(rec.get(k, "")) for k in
                   ("file", "listingId", "reviewIdx", "fee_type", "keyword", "sentence"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def read_candidates(path: pathlib.Path) -> list[dict]:
    if not path.exists():
        print(f"❌ {path} 가 없습니다.")
        print("   먼저 python analyze.py 를 실행하세요.")
        sys.exit(1)
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def read_csv(path: pathlib.Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    # utf-8-sig: 엑셀이 저장한 BOM을 벗겨낸다
    with path.open(encoding="utf-8-sig", newline="") as f:
        return {r["cand_id"]: r for r in csv.DictReader(f) if r.get("cand_id")}


def cmd_init(args) -> None:
    cands = read_candidates(HERE / args.candidates)
    out_path = HERE / args.labels
    out_path.parent.mkdir(parents=True, exist_ok=True)

    existing = read_csv(out_path)
    rows, kept, added = [], 0, 0

    for rec in cands:
        cid = cand_id(rec)
        prev = existing.get(cid)
        gold = (prev or {}).get("gold", "").strip()
        note = (prev or {}).get("note", "").strip()
        if gold:
            kept += 1
        else:
            added += 1
        rows.append({
            "cand_id": cid,
            "gold": gold,
            "rule_verdict": rec.get("rule_verdict", ""),
            "fee_type": rec.get("fee_type", ""),
            "keyword": rec.get("keyword", ""),
            "sentence": rec.get("sentence", ""),
            "cost_cues": " ".join(rec.get("cost_cues") or []),
            "neg_cues": " ".join(rec.get("neg_cues") or []),
            "listingId": rec.get("listingId", ""),
            "date": rec.get("date", ""),
            "rating": rec.get("rating", ""),
            "note": note,
        })

    # 아직 안 채운 것부터 위로. 매번 스크롤해서 이어붙일 자리를 찾지 않아도 된다.
    rows.sort(key=lambda r: (bool(r["gold"]), r["fee_type"], r["sentence"]))

    with out_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)

    orphan = len(existing) - kept
    print(f"✅ {out_path}")
    print(f"   전체 {len(rows):,}건 · 이미 채운 라벨 {kept:,}건 유지 · 새 후보 {added:,}건")
    if orphan > 0:
        print(f"   ⚠ 이전 라벨 {orphan:,}건은 지금 후보에 없어 빠졌습니다 (데이터가 바뀐 경우)")
    print()
    print(GOLD_HELP)


def cmd_score(args) -> None:
    path = HERE / args.labels
    rows = list(read_csv(path).values())
    if not rows:
        print(f"❌ {path} 를 읽을 수 없습니다. 먼저 python label.py init 을 실행하세요.")
        sys.exit(1)

    labeled = [r for r in rows if r.get("gold", "").strip() in ("0", "1")]
    held = [r for r in rows if r.get("gold", "").strip() == "?"]
    blank = len(rows) - len(labeled) - len(held)

    print(f"📂 {path.name}")
    print(f"   전체 {len(rows):,} · 라벨 완료 {len(labeled):,} · 보류(?) {len(held):,} · 미작성 {blank:,}")
    if not labeled:
        print("\n채점할 라벨이 없습니다. gold 칸을 채우고 다시 실행하세요.")
        return

    def score(subset, ambiguous_as_positive: bool):
        tp = fp = fn = tn = 0
        for r in subset:
            g = r["gold"].strip() == "1"
            v = r["rule_verdict"]
            p = v == "mention" or (ambiguous_as_positive and v == "ambiguous")
            if p and g: tp += 1
            elif p and not g: fp += 1
            elif not p and g: fn += 1
            else: tn += 1
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        return tp, fp, fn, tn, prec, rec, f1

    lines = []

    def out(s=""):
        print(s)
        lines.append(s)

    out()
    out("=== 규칙 베이스라인 성적표 ===")
    out()
    for label, flag in (("ambiguous 를 '아님'으로 처리 (엄격)", False),
                        ("ambiguous 를 '비용 언급'으로 처리 (관대)", True)):
        tp, fp, fn, tn, prec, rec, f1 = score(labeled, flag)
        out(f"[{label}]")
        out(f"  Precision {prec:.3f}  Recall {rec:.3f}  F1 {f1:.3f}")
        out(f"  TP {tp}  FP {fp}  FN {fn}  TN {tn}")
        out()

    # 판정별로 실제 정답이 어땠는지 — 어느 판정이 못 미더운지가 여기서 보인다
    out("[규칙 판정별 실제 정답 비율]")
    by_verdict = {}
    for r in labeled:
        by_verdict.setdefault(r["rule_verdict"], []).append(r["gold"].strip() == "1")
    for v in ("mention", "ambiguous", "negated"):
        vals = by_verdict.get(v, [])
        if not vals:
            continue
        pos = sum(vals)
        out(f"  {v:<10} {len(vals):>4}건 중 실제 비용 언급 {pos:>4}건 ({pos / len(vals):.1%})")
    out()

    amb = by_verdict.get("ambiguous", [])
    if amb:
        out(f"→ 모델이 회복해야 할 구간: ambiguous {len(amb)}건 중 {sum(amb)}건이 실제 비용 언급.")
        out("  이 숫자가 '규칙으로는 여기까지'의 정량 증거다.")
        out()

    out("[비용 유형별]")
    tot = Counter(r["fee_type"] for r in labeled)
    pos = Counter(r["fee_type"] for r in labeled if r["gold"].strip() == "1")
    for t, n in tot.most_common():
        out(f"  {t:<12} {pos[t]:>3} / {n:>3}")

    # 문장이 안 들어가므로 커밋해도 안전하다
    report = HERE / args.labels
    report = report.parent / "채점.md"
    report.write_text("# 규칙 베이스라인 채점\n\n```\n" + "\n".join(lines) + "\n```\n",
                      encoding="utf-8")
    print()
    print(f"✅ 저장: {report}  (문장이 없어 커밋해도 안전합니다)")


def main() -> None:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    # 옵션을 부모 파서에 두고 물려준다 — 그래야 `label.py init --labels ...` 처럼
    # 하위 명령 뒤에 써도 받는다. 최상위에만 두면 argparse가 거부한다.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--candidates", default="out/후보.jsonl")
    common.add_argument("--labels", default="labels/라벨링.csv")

    ap = argparse.ArgumentParser(description="비용 언급 라벨링 도구", parents=[common])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", parents=[common], help="후보를 CSV로 빼낸다 (기존 라벨은 유지)")
    sub.add_parser("score", parents=[common], help="채운 라벨로 규칙 베이스라인을 채점한다")

    args = ap.parse_args()
    {"init": cmd_init, "score": cmd_score}[args.cmd](args)


if __name__ == "__main__":
    main()
