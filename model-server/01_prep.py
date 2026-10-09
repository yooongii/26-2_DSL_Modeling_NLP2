"""
01_prep.py — 데이터 로드 · 분할 · 베이스라인 측정

    python 01_prep.py

하는 일
  1. 축2_리뷰_라벨링_추가비용전용.csv 를 읽어 리뷰 단위로 접는다(다중 라벨 → 한 행).
  2. **hotel_id 기준으로** train/val/test 를 나눈다.
     무작위로 나누면 같은 숙소 리뷰가 train 과 test 에 동시에 들어간다. 같은 숙소는
     어휘와 비용 사실을 공유하므로 성능이 부풀려진다(누수).
  3. 학습 전에 **베이스라인 두 개를 먼저 재둔다.** 모델 숫자만 보면 잘한 건지 알 수 없다.
       - 언어 베이스라인: "영어면 추가비용" 이라고만 답하기
       - 다수 클래스: 전부 "추가비용 아님"
     이 데이터셋은 영어 리뷰의 78%가 양성, 한국어의 25%가 양성이라 언어와 라벨이
     교란돼 있다. 모델이 이 선을 못 넘으면 비용 의미가 아니라 언어를 배운 것이다.

출력: data/train.csv · data/val.csv · data/test.csv · data/baseline.md
"""
import io
import json
import pathlib
import re
import sys

import pandas as pd
from sklearn.model_selection import GroupShuffleSplit

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent / "축2_리뷰_라벨링_추가비용전용.csv"
OUT = HERE / "data"
SEED = 42

COST_TYPES = [
    "세금_숙박세", "보증금_현장", "조식_별도결제", "기타_추가요금", "주차_유료",
    "체크인체크아웃_추가요금", "리조트피_별도", "룸어메니티이용료", "수하물보관료", "청소비_별도",
]

HANGUL = re.compile(r"[가-힣]")
LATIN = re.compile(r"[A-Za-z]")


def is_english(t: str) -> bool:
    """스크립트 비율로 영어 여부. lang.ts 의 detectLang 과 같은 기준."""
    t = (t or "")[:400]
    h, l = len(HANGUL.findall(t)), len(LATIN.findall(t))
    return (h + l) >= 5 and l / (h + l) > 0.5


def prf(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def main() -> None:
    if not SRC.exists():
        print(f"❌ {SRC} 가 없습니다.")
        sys.exit(1)

    raw = pd.read_csv(SRC, encoding="utf-8-sig", keep_default_na=False)
    print(f"원본 {len(raw):,}행")

    # ── 리뷰 단위로 접기 ────────────────────────────────────────────────
    # 다중 라벨(한 리뷰에 유형 2개)이 여러 행으로 흩어져 있다. 리뷰 하나가 한 행이 되도록
    # 접고, 유형은 리스트로 모은다. 이진 라벨은 "비용 유형이 하나라도 있으면 1".
    rows = []
    for rid, g in raw.groupby("review_id", sort=False):
        types = sorted({t for t in g["claim_type"] if t in COST_TYPES})
        rows.append({
            "review_id": rid,
            "hotel_id": g["hotel_id"].iloc[0],
            "text": g["review_text"].iloc[0],
            "label": int(bool(types)),
            "types": json.dumps(types, ensure_ascii=False),
        })
    df = pd.DataFrame(rows)
    df["is_en"] = df["text"].map(is_english)

    print(f"리뷰 단위 {len(df):,}건 · 양성 {df.label.sum():,} ({df.label.mean():.1%}) · 숙소 {df.hotel_id.nunique():,}곳")

    # ── hotel_id 기준 분할 ─────────────────────────────────────────────
    gss = GroupShuffleSplit(n_splits=1, test_size=0.30, random_state=SEED)
    tr_idx, rest_idx = next(gss.split(df, groups=df.hotel_id))
    train, rest = df.iloc[tr_idx].copy(), df.iloc[rest_idx].copy()

    gss2 = GroupShuffleSplit(n_splits=1, test_size=0.50, random_state=SEED)
    v_idx, te_idx = next(gss2.split(rest, groups=rest.hotel_id))
    val, test = rest.iloc[v_idx].copy(), rest.iloc[te_idx].copy()

    OUT.mkdir(exist_ok=True)
    for name, d in (("train", train), ("val", val), ("test", test)):
        d.to_csv(OUT / f"{name}.csv", index=False, encoding="utf-8-sig")

    # 누수 검사 — 분할의 전제가 실제로 지켜졌는지 확인한다
    overlap = (set(train.hotel_id) & set(test.hotel_id)) | (set(train.hotel_id) & set(val.hotel_id))
    assert not overlap, f"숙소 누수: {list(overlap)[:5]}"

    lines = []
    def out(s=""):
        print(s)
        lines.append(s)

    out()
    out("=== 분할 (hotel_id 기준, 숙소 겹침 없음) ===")
    out(f"{'':8}{'리뷰':>8}{'양성':>8}{'양성률':>9}{'숙소':>7}{'영어':>8}")
    for name, d in (("train", train), ("val", val), ("test", test)):
        out(f"{name:<8}{len(d):>8,}{d.label.sum():>8,}{d.label.mean():>8.1%}{d.hotel_id.nunique():>7,}{d.is_en.mean():>8.0%}")

    # ── 베이스라인 (test 기준) ─────────────────────────────────────────
    out()
    out("=== 베이스라인 — 모델은 이 선을 넘어야 한다 (test 기준) ===")

    tp = int(((test.is_en) & (test.label == 1)).sum())
    fp = int(((test.is_en) & (test.label == 0)).sum())
    fn = int(((~test.is_en) & (test.label == 1)).sum())
    tn = int(((~test.is_en) & (test.label == 0)).sum())
    p, r, f = prf(tp, fp, fn)
    out(f"① 언어  ('영어면 추가비용')   P {p:.3f}  R {r:.3f}  F1 {f:.3f}  Acc {(tp+tn)/len(test):.3f}")

    p2, r2, f2 = prf(0, 0, int(test.label.sum()))
    out(f"② 다수  (전부 '아님')         P {p2:.3f}  R {r2:.3f}  F1 {f2:.3f}  Acc {1-test.label.mean():.3f}")

    out()
    out("→ ①이 이 데이터셋의 진짜 문턱이다. 언어와 라벨이 교란돼 있어")
    out("  모델이 ①을 못 넘으면 비용 의미가 아니라 언어를 배운 것이다.")

    out()
    out("=== 언어별 양성률 (교란의 크기) ===")
    for name, mask in (("한국어", ~df.is_en), ("영어", df.is_en)):
        g = df[mask]
        out(f"  {name}: {len(g):>5,}건 중 양성 {g.label.sum():>4,} ({g.label.mean():.0%})")

    out()
    out("=== 유형 분포 (2단계 유형 분류용) ===")
    cnt = {t: int(raw.claim_type.eq(t).sum()) for t in COST_TYPES}
    for t, n in sorted(cnt.items(), key=lambda x: -x[1]):
        mark = "" if n >= 80 else "   ← 표본 부족, 유형 분류에서 제외 권장"
        out(f"  {t:<22}{n:>5}{mark}")

    (OUT / "baseline.md").write_text(
        "# 베이스라인\n\n```\n" + "\n".join(lines) + "\n```\n", encoding="utf-8")
    print()
    print(f"✅ {OUT}  (train/val/test.csv, baseline.md)")


if __name__ == "__main__":
    main()
