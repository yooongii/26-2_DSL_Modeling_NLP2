"""
02_train.py — 추가비용 이진 분류기 학습 (Stage 1)

    python 02_train.py                     # 기본 (klue/roberta-base)
    python 02_train.py --model klue/roberta-small
    python 02_train.py --epochs 3 --batch 32

"이 리뷰에 추가비용 언급이 있는가"를 0/1 로 판정한다.

평가에서 지키는 것
  - **F1(양성 기준)** 으로 모델을 고른다. accuracy 로 고르면 다수 클래스로 쏠린다.
  - 매 epoch 끝에 **언어 베이스라인과 나란히** 찍는다. 이 데이터셋은 언어와 라벨이
    교란돼 있어(영어 75% 양성 / 한국어 23% 양성), 그 선을 넘는지가 유일하게 의미 있는 신호다.
  - 마지막에 **언어별로 쪼갠 성능**을 낸다. 한국어에서만 성능이 무너지면
    모델이 언어를 학습했다는 뜻이다.

산출: ckpt/<모델명>/  (config.json · model.safetensors · tokenizer)
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


class ReviewDS(Dataset):
    def __init__(self, df: pd.DataFrame, tok, max_len: int):
        self.enc = tok(
            df["text"].astype(str).tolist(),
            truncation=True, max_length=max_len, padding=False,
        )
        self.labels = df["label"].astype(int).tolist()

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, i: int) -> dict:
        item = {k: v[i] for k, v in self.enc.items()}
        item["labels"] = self.labels[i]
        return item


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def scores(pred: np.ndarray, gold: np.ndarray) -> dict:
    tp = int(((pred == 1) & (gold == 1)).sum())
    fp = int(((pred == 1) & (gold == 0)).sum())
    fn = int(((pred == 0) & (gold == 1)).sum())
    tn = int(((pred == 0) & (gold == 0)).sum())
    p, r, f = prf(tp, fp, fn)
    return {"precision": p, "recall": r, "f1": f,
            "accuracy": (tp + tn) / max(1, len(gold)),
            "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="klue/roberta-base")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    # 512 인 이유: 리뷰 토큰 길이 중앙값은 123이지만 95분위가 445라 256으로 자르면 19%가
    # 잘린다. 비용 언급은 리뷰 뒷부분에 오는 경우가 많아("...좋았는데 주차비를 따로 받더라고요")
    # 잘리면 정작 신호를 버린다. 512면 97%가 안 잘리고 VRAM 3.9GB(8.5GB 중)로 여유가 있다.
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    if not (DATA / "train.csv").exists():
        print("❌ data/ 가 없습니다. 먼저 python 01_prep.py 를 실행하세요.")
        sys.exit(1)

    tr = pd.read_csv(DATA / "train.csv", encoding="utf-8-sig")
    va = pd.read_csv(DATA / "val.csv", encoding="utf-8-sig")
    te = pd.read_csv(DATA / "test.csv", encoding="utf-8-sig")

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"장치 {dev}" + (f" · {torch.cuda.get_device_name(0)}" if dev == "cuda" else ""))
    print(f"모델 {args.model} · train {len(tr):,} / val {len(va):,} / test {len(te):,}")

    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(args.model, num_labels=2)

    def metrics(eval_pred):
        logits, labels = eval_pred
        return scores(np.asarray(logits).argmax(-1), np.asarray(labels))

    out_dir = HERE / "ckpt" / args.model.replace("/", "_")

    # transformers 5.x 에는 warmup_ratio 가 없고 warmup_steps 만 있다. 전체 스텝의 10%.
    steps_per_epoch = max(1, -(-len(tr) // args.batch))
    warmup_steps = int(steps_per_epoch * args.epochs * 0.1)

    targs = TrainingArguments(
        output_dir=str(HERE / "runs" / args.model.replace("/", "_")),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        per_device_eval_batch_size=64,
        learning_rate=args.lr,
        warmup_steps=warmup_steps,
        weight_decay=0.01,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1",     # accuracy 로 고르면 다수 클래스로 쏠린다
        greater_is_better=True,
        save_total_limit=1,
        logging_steps=25,
        seed=args.seed,
        fp16=(dev == "cuda"),
        report_to=[],
    )

    # 데이터셋이 padding=False 로 토크나이즈하므로 배치마다 동적 패딩이 필요하다.
    # transformers 5.x 는 tokenizer= 대신 processing_class= 를 받는다.
    trainer = Trainer(
        model=model, args=targs,
        train_dataset=ReviewDS(tr, tok, args.max_len),
        eval_dataset=ReviewDS(va, tok, args.max_len),
        processing_class=tok,
        data_collator=DataCollatorWithPadding(tok),
        compute_metrics=metrics,
    )
    trainer.train()

    # ── test 평가 ──────────────────────────────────────────────────────
    pred_out = trainer.predict(ReviewDS(te, tok, args.max_len))
    pred = np.asarray(pred_out.predictions).argmax(-1)
    gold = te["label"].to_numpy()
    m = scores(pred, gold)

    # 언어 베이스라인 (같은 test 셋)
    lang_pred = te["is_en"].astype(bool).to_numpy().astype(int)
    lb = scores(lang_pred, gold)

    print()
    print("=" * 62)
    print(f"{'':22}{'P':>8}{'R':>8}{'F1':>8}{'Acc':>8}")
    print("-" * 62)
    print(f"{'언어 베이스라인':<20}{lb['precision']:>8.3f}{lb['recall']:>8.3f}{lb['f1']:>8.3f}{lb['accuracy']:>8.3f}")
    print(f"{'모델':<22}{m['precision']:>8.3f}{m['recall']:>8.3f}{m['f1']:>8.3f}{m['accuracy']:>8.3f}")
    print("-" * 62)
    gain = m["f1"] - lb["f1"]
    print(f"F1 차이: {gain:+.3f}" + ("  ← 베이스라인을 못 넘었다" if gain <= 0 else ""))
    print(f"TP {m['tp']}  FP {m['fp']}  FN {m['fn']}  TN {m['tn']}")

    # 언어별로 쪼개 보기 — 한국어에서만 무너지면 언어를 학습한 것이다
    print()
    print("언어별:")
    for name, mask in (("한국어", ~te["is_en"].astype(bool)), ("영어", te["is_en"].astype(bool))):
        idx = mask.to_numpy()
        if idx.sum() == 0:
            continue
        s = scores(pred[idx], gold[idx])
        print(f"  {name:<6}{int(idx.sum()):>5}건  P {s['precision']:.3f}  R {s['recall']:.3f}  F1 {s['f1']:.3f}")
    print("=" * 62)

    out_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(out_dir))
    tok.save_pretrained(str(out_dir))
    (out_dir / "eval.json").write_text(
        json.dumps({"model": m, "language_baseline": lb, "args": vars(args)},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✅ {out_dir}")


if __name__ == "__main__":
    main()
