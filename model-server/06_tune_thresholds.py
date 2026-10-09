"""
06_tune_thresholds.py — 유형별 임계값을 val 에서 고르고 test 로 평가

    python 06_tune_thresholds.py --model klue/roberta-small

왜 필요한가
  멀티라벨을 0.5 고정 임계값으로 읽으면 **희소 유형이 전부 0으로 예측된다.**
  학습셋에서 세금_숙박세는 16%지만 보증금 7%, 조식 6.7%, 청소비 0.6% 라
  확률이 0.5를 넘을 일이 거의 없다. 실제로 05 학습 후 9/10 유형의 F1 이 0.000 이었다.

  이건 "모델이 못 배웠다"와 다르다. **순위는 배웠는데 자르는 위치가 틀렸을 수 있다.**
  그래서 먼저 임계값과 무관한 PR-AUC 로 학습 여부를 확인하고,
  그 다음 val 에서 유형별 최적 임계값을 골라 test 에 적용한다.

  임계값을 test 에서 고르면 그건 test 에 맞춘 것이라 성능이 부풀려진다. 반드시 val 에서 고른다.

출력: ckpt/<모델명>_multi/thresholds.json  (서버가 이 값을 읽어 쓴다)
"""
import argparse
import json
import pathlib
import sys

import numpy as np
import pandas as pd
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
# 라벨 구성은 체크포인트의 config.json(id2label)에서 읽는다.
# 10종 모델(_multi)과 5종 묶음 모델(_multi5)을 같은 스크립트로 다루기 위함.
MERGE_GROUPS = {
    "세금·숙박세": ["세금_숙박세"],
    "보증금": ["보증금_현장"],
    "식음료": ["조식_별도결제"],
    "시설이용": ["주차_유료", "리조트피_별도", "룸어메니티이용료", "청소비_별도"],
    "기타부대": ["기타_추가요금", "체크인체크아웃_추가요금", "수하물보관료"],
}
_TO_GROUP = {t: g for g, ts in MERGE_GROUPS.items() for t in ts}


def to_vec(row, labels):
    ts = set(json.loads(row["types"]))
    merged = any(t in MERGE_GROUPS for t in labels[1:])
    if merged:
        ts = {_TO_GROUP[t] for t in ts if t in _TO_GROUP}
    return [float(row["label"])] + [float(t in ts) for t in labels[1:]]


def f1_at(prob, gold, thr):
    pred = (prob >= thr).astype(int)
    tp = int(((pred == 1) & (gold == 1)).sum())
    fp = int(((pred == 1) & (gold == 0)).sum())
    fn = int(((pred == 0) & (gold == 1)).sum())
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return (2 * p * r / (p + r) if p + r else 0.0), p, r


def pr_auc(prob, gold) -> float:
    """평균 정밀도. 임계값과 무관해서 '순위를 배웠는가'를 본다.
    무작위면 양성 비율과 비슷한 값이 나온다."""
    if gold.sum() == 0:
        return float("nan")
    order = np.argsort(-prob)
    g = gold[order]
    tp = np.cumsum(g)
    prec = tp / np.arange(1, len(g) + 1)
    return float((prec * g).sum() / g.sum())


@torch.no_grad()
def infer(texts, ckpt, max_len=512, batch=32):
    tok = AutoTokenizer.from_pretrained(ckpt)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModelForSequenceClassification.from_pretrained(ckpt).to(dev).eval()
    outs = []
    for i in range(0, len(texts), batch):
        enc = tok([str(t) for t in texts[i:i + batch]], truncation=True,
                  max_length=max_len, padding=True, return_tensors="pt").to(dev)
        outs.append(torch.sigmoid(model(**enc).logits).cpu().numpy())
    return np.vstack(outs)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="klue/roberta-small")
    ap.add_argument("--merge", action="store_true", help="5종 묶음 모델(_multi5)")
    args = ap.parse_args()

    ckpt = HERE / "ckpt" / (args.model.replace("/", "_") + ("_multi5" if args.merge else "_multi"))
    if not ckpt.exists():
        print(f"❌ {ckpt} 가 없습니다. 05_train_multi.py 를 먼저 실행하세요.")
        sys.exit(1)

    cfg = json.loads((ckpt / "config.json").read_text(encoding="utf-8"))
    labels = [cfg["id2label"][str(i)] for i in range(len(cfg["id2label"]))]

    va = pd.read_csv(DATA / "val.csv", encoding="utf-8-sig")
    te = pd.read_csv(DATA / "test.csv", encoding="utf-8-sig")
    gv = np.array([to_vec(r, labels) for _, r in va.iterrows()]).astype(int)
    gt = np.array([to_vec(r, labels) for _, r in te.iterrows()]).astype(int)

    pv = infer(va["text"].tolist(), ckpt)
    pt = infer(te["text"].tolist(), ckpt)

    grid = np.arange(0.05, 0.96, 0.01)
    thresholds, rows = {}, []
    for i, name in enumerate(labels):
        # val 에서 F1 이 최대가 되는 임계값
        best_thr, best_f1 = 0.5, -1.0
        for t in grid:
            f, _, _ = f1_at(pv[:, i], gv[:, i], t)
            if f > best_f1:
                best_f1, best_thr = f, float(t)
        thresholds[name] = round(best_thr, 2)

        f05, p05, r05 = f1_at(pt[:, i], gt[:, i], 0.5)
        ftu, ptu, rtu = f1_at(pt[:, i], gt[:, i], best_thr)
        rows.append({
            "label": name, "n": int(gt[:, i].sum()), "thr": best_thr,
            "f1_05": f05, "f1_tuned": ftu, "P": ptu, "R": rtu,
            "pr_auc": pr_auc(pt[:, i], gt[:, i]),
            "base_rate": gt[:, i].mean(),
        })

    print()
    print("=" * 92)
    print(f"{'라벨':<24}{'test n':>7}{'양성률':>8}{'PR-AUC':>9}{'임계값':>8}"
          f"{'F1@0.5':>9}{'F1(조정)':>10}{'P':>8}{'R':>8}")
    print("-" * 92)
    for r in rows:
        star = "" if r["n"] >= 20 else "  *"
        print(f"{r['label']:<24}{r['n']:>7}{r['base_rate']:>8.1%}{r['pr_auc']:>9.3f}"
              f"{r['thr']:>8.2f}{r['f1_05']:>9.3f}{r['f1_tuned']:>10.3f}"
              f"{r['P']:>8.3f}{r['R']:>8.3f}{star}")
    print("-" * 92)
    print("* test 표본 20건 미만 — 숫자가 요동친다")
    print()
    print("PR-AUC 읽는 법: 양성률과 비슷하면 '순위를 못 배움', 훨씬 높으면 '배웠는데 임계값 문제'")

    ok = [r for r in rows if r["label"] != "is_cost" and r["n"] >= 20]
    if ok:
        print()
        print(f"유형 macro F1 (test 20건 이상 {len(ok)}종): "
              f"0.5 고정 {np.mean([r['f1_05'] for r in ok]):.3f} → "
              f"조정 후 {np.mean([r['f1_tuned'] for r in ok]):.3f}")
    print("=" * 92)

    (ckpt / "thresholds.json").write_text(
        json.dumps(thresholds, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✅ {ckpt / 'thresholds.json'}")


if __name__ == "__main__":
    main()
