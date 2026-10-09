# -*- coding: utf-8 -*-
"""최종 채택안: 1단계(전체 555건)만 학습하고 저장한다. clean fine-tune(2단계)은
실측 결과 오히려 성능을 떨어뜨려서(test F1 0.911->0.883) 채택하지 않음."""
import csv
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset
from sklearn.metrics import precision_recall_fscore_support, accuracy_score
from transformers import AutoTokenizer, AutoModelForSequenceClassification, Trainer, TrainingArguments

HERE = Path(__file__).parent
DATA_DIR = HERE.parent / "영어_학습데이터_풀림"
MODEL_NAME = "distilbert-base-uncased"
MAX_LEN = 128
EPOCHS = 6
BATCH = 32
LR = 2e-5
SEED = 42
HUMAN_SOURCES = {"human", "human(cost_info=N)"}


def read_csv(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


class ReviewDataset(Dataset):
    def __init__(self, rows, tokenizer):
        self.texts = [r["text"] for r in rows]
        self.labels = [int(r["label"]) for r in rows]
        enc = tokenizer(self.texts, truncation=True, padding="max_length", max_length=MAX_LEN)
        self.input_ids = enc["input_ids"]
        self.attention_mask = enc["attention_mask"]

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        return {
            "input_ids": torch.tensor(self.input_ids[idx]),
            "attention_mask": torch.tensor(self.attention_mask[idx]),
            "labels": torch.tensor(self.labels[idx]),
        }


def compute_metrics_fn(eval_pred):
    logits, labels = eval_pred
    preds = np.argmax(logits, axis=-1)
    prec, rec, f1, _ = precision_recall_fscore_support(labels, preds, average="binary", zero_division=0)
    acc = accuracy_score(labels, preds)
    return {"precision": prec, "recall": rec, "f1": f1, "accuracy": acc}


def eval_subset(trainer, rows, tokenizer, name):
    if not rows:
        return
    ds = ReviewDataset(rows, tokenizer)
    m = trainer.evaluate(ds)
    print(f"  [{name}] n={len(rows)}  P={m['eval_precision']:.3f} R={m['eval_recall']:.3f} "
          f"F1={m['eval_f1']:.3f} Acc={m['eval_accuracy']:.3f}", flush=True)


def main():
    train_rows = read_csv(DATA_DIR / "dataset_en_train.csv")
    val_rows = read_csv(DATA_DIR / "dataset_en_val.csv")
    test_rows = read_csv(DATA_DIR / "dataset_en_test.csv")
    human_val = [r for r in val_rows if r["label_source"] in HUMAN_SOURCES]
    human_test = [r for r in test_rows if r["label_source"] in HUMAN_SOURCES]

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, num_labels=2)

    train_ds = ReviewDataset(train_rows, tokenizer)
    val_ds = ReviewDataset(val_rows, tokenizer)
    steps = -(-len(train_rows) // BATCH) * EPOCHS
    args = TrainingArguments(
        output_dir=str(HERE / "ckpt_tmp"),
        num_train_epochs=EPOCHS,
        per_device_train_batch_size=BATCH,
        per_device_eval_batch_size=64,
        learning_rate=LR,
        warmup_steps=max(1, int(0.1 * steps)),
        eval_strategy="epoch",
        save_strategy="no",
        logging_strategy="epoch",
        seed=SEED,
        report_to=[],
        fp16=False,
    )
    trainer = Trainer(model=model, args=args, train_dataset=train_ds, eval_dataset=val_ds,
                       compute_metrics=compute_metrics_fn)
    trainer.train()

    print("\n-- 최종 평가 --", flush=True)
    eval_subset(trainer, val_rows, tokenizer, "val 전체")
    eval_subset(trainer, human_val, tokenizer, "val 사람라벨만")
    eval_subset(trainer, test_rows, tokenizer, "test 전체")
    eval_subset(trainer, human_test, tokenizer, "test 사람라벨만")

    save_dir = HERE / "ckpt_en_final"
    model.save_pretrained(save_dir)
    tokenizer.save_pretrained(save_dir)
    print(f"\n저장 완료: {save_dir}", flush=True)


if __name__ == "__main__":
    main()
