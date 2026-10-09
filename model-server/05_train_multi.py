"""
05_train_multi.py — 추가비용 여부 + 유형을 **한 모델로** 학습 (멀티라벨)

    python 05_train_multi.py                          # klue/roberta-small
    python 05_train_multi.py --model klue/roberta-base

출력 11개를 동시에 학습한다.

    [0]      is_cost        추가비용 언급이 있는가
    [1..10]  유형 10종      세금_숙박세 · 보증금_현장 · 조식_별도결제 · ...

왜 is_cost 를 따로 두는가
  "유형이 하나라도 켜지면 양성"으로 유도할 수도 있지만, 그러면 이진 판정이
  희소 유형의 성능에 끌려간다. is_cost 를 직접 감독하면 이진 성능이 유지되고
  (전용 이진 모델 F1 0.841 과 비교 가능) 유형은 덤으로 얻는다.

왜 한 모델인가
  브라우저에서 forward 한 번으로 0/1 과 유형이 같이 나온다. 모델 파일도 하나뿐이라
  배포와 교체가 단순하다.

평가에서 지키는 것
  - 유형별 F1 을 **표본 수와 함께** 낸다. 표본 30건 미만은 숫자가 요동쳐서 신뢰할 수 없으므로
    그렇게 표시한다. 평균만 내면 희소 유형의 실패가 가려진다.
  - 이진은 언어 베이스라인(F1 0.646)과 나란히 찍는다.

산출: ckpt/<모델명>_multi/
"""
import argparse
import json
import pathlib
import sys

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    Trainer,
    TrainingArguments,
)

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"

TYPES = [
    "세금_숙박세", "보증금_현장", "조식_별도결제", "기타_추가요금", "주차_유료",
    "체크인체크아웃_추가요금", "리조트피_별도", "룸어메니티이용료", "수하물보관료", "청소비_별도",
]

# --merge 로 켠다. 10종 그대로 두면 클래스당 표본이 8~206건으로 흩어져 대부분 학습이 안 된다
# (첫 학습에서 9/10 이 F1 0.000). 뜻이 가까운 것끼리 묶어 표본을 모은다.
MERGE_GROUPS: dict[str, list[str]] = {
    "세금·숙박세": ["세금_숙박세"],
    "보증금": ["보증금_현장"],
    "식음료": ["조식_별도결제"],
    "시설이용": ["주차_유료", "리조트피_별도", "룸어메니티이용료", "청소비_별도"],
    "기타부대": ["기타_추가요금", "체크인체크아웃_추가요금", "수하물보관료"],
}
MERGED = list(MERGE_GROUPS)
_TO_GROUP = {t: g for g, ts in MERGE_GROUPS.items() for t in ts}
LABELS = ["is_cost"] + TYPES
MIN_RELIABLE = 30      # test 표본이 이보다 적으면 유형 F1을 신뢰하지 않는다


def to_vec(row, types: list[str], merged: bool) -> list[float]:
    ts = set(json.loads(row["types"]))
    if merged:
        ts = {_TO_GROUP[t] for t in ts if t in _TO_GROUP}
    return [float(row["label"])] + [float(t in ts) for t in types]


class MultiDS(Dataset):
    def __init__(self, df: pd.DataFrame, tok, max_len: int, types: list[str], merged: bool):
        self.enc = tok(df["text"].astype(str).tolist(),
                       truncation=True, max_length=max_len, padding=False)
        self.y = [to_vec(r, types, merged) for _, r in df.iterrows()]

    def __len__(self) -> int:
        return len(self.y)

    def __getitem__(self, i: int) -> dict:
        item = {k: v[i] for k, v in self.enc.items()}
        item["labels"] = self.y[i]
        return item


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def col_scores(pred: np.ndarray, gold: np.ndarray) -> dict:
    tp = int(((pred == 1) & (gold == 1)).sum())
    fp = int(((pred == 1) & (gold == 0)).sum())
    fn = int(((pred == 0) & (gold == 1)).sum())
    p, r, f = prf(tp, fp, fn)
    return {"P": p, "R": r, "F1": f, "n_gold": int(gold.sum()), "tp": tp, "fp": fp, "fn": fn}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="klue/roberta-small")
    ap.add_argument("--epochs", type=int, default=6)   # 이진 학습에서 4에도 수렴 안 했으므로 늘림
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--merge", action="store_true", help="유형 10종을 5종으로 묶어 학습")
    args = ap.parse_args()

    types = MERGED if args.merge else TYPES
    labels = ["is_cost"] + types
    mk = lambda df: MultiDS(df, tok, args.max_len, types, args.merge)

    tr = pd.read_csv(DATA / "train.csv", encoding="utf-8-sig")
    va = pd.read_csv(DATA / "val.csv", encoding="utf-8-sig")
    te = pd.read_csv(DATA / "test.csv", encoding="utf-8-sig")

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"장치 {dev}" + (f" · {torch.cuda.get_device_name(0)}" if dev == "cuda" else ""))
    print(f"모델 {args.model} · 출력 {len(labels)}개 (is_cost + 유형 {len(types)})"
          + (" · 묶음 모드" if args.merge else ""))

    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=len(labels),
        problem_type="multi_label_classification",   # BCEWithLogitsLoss
        id2label={i: n for i, n in enumerate(labels)},
        label2id={n: i for i, n in enumerate(labels)},
    )

    def metrics(eval_pred):
        logits, labels = eval_pred
        probs = 1 / (1 + np.exp(-np.asarray(logits)))
        pred = (probs >= 0.5).astype(int)
        gold = np.asarray(labels).astype(int)
        s = col_scores(pred[:, 0], gold[:, 0])          # is_cost 로 모델을 고른다
        # 유형 macro F1 (표본 있는 것만)
        fs = [col_scores(pred[:, i + 1], gold[:, i + 1])["F1"]
              for i in range(len(types)) if gold[:, i + 1].sum() > 0]
        return {"f1": s["F1"], "precision": s["P"], "recall": s["R"],
                "type_macro_f1": float(np.mean(fs)) if fs else 0.0}

    steps_per_epoch = max(1, -(-len(tr) // args.batch))
    tag = args.model.replace("/", "_") + ("_multi5" if args.merge else "_multi")

    targs = TrainingArguments(
        output_dir=str(HERE / "runs" / tag),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        per_device_eval_batch_size=64,
        learning_rate=args.lr,
        warmup_steps=int(steps_per_epoch * args.epochs * 0.1),
        weight_decay=0.01,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        greater_is_better=True,
        save_total_limit=1,
        logging_steps=25,
        seed=args.seed,
        fp16=(dev == "cuda"),
        report_to=[],
    )

    trainer = Trainer(
        model=model, args=targs,
        train_dataset=mk(tr),
        eval_dataset=mk(va),
        processing_class=tok,
        data_collator=DataCollatorWithPadding(tok),
        compute_metrics=metrics,
    )
    trainer.train()

    # ── test 평가 ──────────────────────────────────────────────────────
    out = trainer.predict(mk(te))
    probs = 1 / (1 + np.exp(-np.asarray(out.predictions)))
    pred = (probs >= 0.5).astype(int)
    gold = np.array([to_vec(r, types, args.merge) for _, r in te.iterrows()]).astype(int)

    binary = col_scores(pred[:, 0], gold[:, 0])
    is_en = te["is_en"].astype(bool).to_numpy()
    lb = col_scores(is_en.astype(int), gold[:, 0])

    print()
    print("=" * 76)
    print("추가비용 여부 (is_cost)")
    print("-" * 76)
    print(f"{'':22}{'P':>8}{'R':>8}{'F1':>8}")
    print(f"{'언어 베이스라인':<20}{lb['P']:>8.3f}{lb['R']:>8.3f}{lb['F1']:>8.3f}")
    print(f"{'이 모델':<21}{binary['P']:>8.3f}{binary['R']:>8.3f}{binary['F1']:>8.3f}")
    print(f"  TP {binary['tp']} · FP {binary['fp']} · FN {binary['fn']}")

    print()
    print("유형별 (test 표본 수 함께)")
    print("-" * 76)
    print(f"{'유형':<24}{'test n':>8}{'P':>8}{'R':>8}{'F1':>8}   비고")
    per = {}
    for i, t in enumerate(types):
        s = col_scores(pred[:, i + 1], gold[:, i + 1])
        per[t] = s
        note = "" if s["n_gold"] >= MIN_RELIABLE else "표본 부족 — 신뢰 불가"
        print(f"{t:<24}{s['n_gold']:>8}{s['P']:>8.3f}{s['R']:>8.3f}{s['F1']:>8.3f}   {note}")

    ok = [t for t in types if per[t]["n_gold"] >= MIN_RELIABLE]
    if ok:
        print("-" * 76)
        print(f"신뢰 가능 유형({len(ok)}종) macro F1: "
              f"{np.mean([per[t]['F1'] for t in ok]):.3f}")

    print()
    print("언어별 (is_cost)")
    for name, mask in (("한국어", ~is_en), ("영어", is_en)):
        if mask.sum() == 0:
            continue
        s = col_scores(pred[mask, 0], gold[mask, 0])
        print(f"  {name:<6}{int(mask.sum()):>5}건  P {s['P']:.3f}  R {s['R']:.3f}  F1 {s['F1']:.3f}")
    print("=" * 76)

    ck = HERE / "ckpt" / tag
    ck.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(ck))
    tok.save_pretrained(str(ck))
    (ck / "eval.json").write_text(json.dumps(
        {"labels": labels, "binary": binary, "language_baseline": lb,
         "per_type": per, "args": vars(args)},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✅ {ck}")


if __name__ == "__main__":
    main()
