#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
축 2 추가비용 분류기 — 리뷰 1건 -> "추가비용 언급이 있는가" 0/1

주 지표는 Macro F1 + MCC다. 양성률이 0.676이라 "전부 양성"으로 찍기만 해도
양성 F1 0.807이 나온다(= pos F1은 변별력이 없다).

분할(--split):
  given : 제공된 dataset_ko_{train,val,test}.jsonl 그대로. 숙소(listing)가 95%
          겹치므로 여기서 나온 숫자는 상한(부풀려짐)이다.
  group : 982건을 합쳐 listing 단위로 재분할. 겹침 0건을 assert로 강제한다.

학습곡선(--train_frac): 같은 시드 안에서 60% ⊂ 80% ⊂ 100%가 되도록 한 번 섞은
순열의 앞에서부터 잘라 쓴다. val/test는 어떤 경우에도 100% 고정이다.
"""
import argparse, json, os, random, shutil
from collections import defaultdict
from math import ceil

import numpy as np
import torch
from torch.utils.data import Dataset
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score,
                             matthews_corrcoef, precision_recall_fscore_support)
from transformers import (AutoModelForSequenceClassification, AutoTokenizer,
                          DataCollatorWithPadding, Trainer, TrainingArguments,
                          set_seed)

HUMAN_SOURCES = {"human", "human(cost_info=N)"}
GROUP_KEY = "listing"


# ─────────────────────────────── data ───────────────────────────────

def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def load_split(data_dir, split_mode, split_seed, val_size=0.15, test_size=0.15):
    """(train_rows, val_rows, test_rows, info) 반환."""
    parts = {sp: read_jsonl(os.path.join(data_dir, f"dataset_ko_{sp}.jsonl"))
             for sp in ("train", "val", "test")}

    if split_mode == "given":
        tr, va, te = parts["train"], parts["val"], parts["test"]
        info = {"mode": "given", "note": "제공된 분할 그대로 사용 (숙소 누수 있음)"}
    else:
        from sklearn.model_selection import GroupShuffleSplit
        rows = parts["train"] + parts["val"] + parts["test"]
        groups = np.array([r.get(GROUP_KEY) for r in rows])
        y = np.array([int(r["label"]) for r in rows])

        # 1단계: (train) vs (val+test)
        gss1 = GroupShuffleSplit(n_splits=1, test_size=val_size + test_size,
                                 random_state=split_seed)
        idx_tr, idx_rest = next(gss1.split(rows, y, groups))
        # 2단계: (val+test)를 절반으로
        rest = [rows[i] for i in idx_rest]
        g_rest = groups[idx_rest]
        gss2 = GroupShuffleSplit(n_splits=1,
                                 test_size=test_size / (val_size + test_size),
                                 random_state=split_seed)
        idx_va, idx_te = next(gss2.split(rest, y[idx_rest], g_rest))

        tr = [rows[i] for i in idx_tr]
        va = [rest[i] for i in idx_va]
        te = [rest[i] for i in idx_te]
        info = {"mode": "group", "group_key": GROUP_KEY, "split_seed": split_seed,
                "note": f"{GROUP_KEY} 단위 GroupShuffleSplit, 겹침 0건 assert"}

    # 누수 점검 — group 모드면 강제, given 모드면 기록만
    gs = {k: {r.get(GROUP_KEY) for r in v} for k, v in
          (("train", tr), ("val", va), ("test", te))}
    leak = {}
    for sp in ("val", "test"):
        shared = gs["train"] & gs[sp]
        n_rows = sum(1 for r in (va if sp == "val" else te)
                     if r.get(GROUP_KEY) in shared)
        leak[f"train_vs_{sp}"] = {
            "shared_groups": len(shared),
            f"{sp}_groups": len(gs[sp]),
            "affected_rows": n_rows,
            f"{sp}_rows": len(va if sp == "val" else te),
            "affected_ratio": round(n_rows / max(1, len(va if sp == "val" else te)), 4),
        }
    if split_mode == "group":
        assert not (gs["train"] & gs["val"]), "group split인데 train∩val 겹침 발생"
        assert not (gs["train"] & gs["test"]), "group split인데 train∩test 겹침 발생"
        assert not (gs["val"] & gs["test"]), "group split인데 val∩test 겹침 발생"
    info["leakage"] = leak
    return tr, va, te, info


def subset_train(rows, frac, unit, seed):
    """60% ⊂ 80% ⊂ 100%가 보장되는 중첩 부분집합."""
    if frac >= 1.0:
        return rows, {"frac": 1.0, "unit": unit}
    rng = random.Random(seed)
    if unit == "row":
        order = list(range(len(rows)))
        rng.shuffle(order)
        keep = set(order[:ceil(frac * len(rows))])
        out = [r for i, r in enumerate(rows) if i in keep]
    else:  # group 단위
        gnames = sorted({r.get(GROUP_KEY) for r in rows})
        rng.shuffle(gnames)
        keep = set(gnames[:ceil(frac * len(gnames))])
        out = [r for r in rows if r.get(GROUP_KEY) in keep]
    return out, {"frac": frac, "unit": unit}


class FeeDataset(Dataset):
    def __init__(self, rows, tok, max_len):
        # klue/roberta 계열은 token_type_ids를 받지 않는다 -> 반드시 제외
        self.enc = tok([r["text"] for r in rows], truncation=True,
                       max_length=max_len, padding=False,
                       return_token_type_ids=False)
        self.labels = [int(r["label"]) for r in rows]

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, i):
        item = {k: v[i] for k, v in self.enc.items()}
        item["labels"] = self.labels[i]
        return item


# ────────────────────────────── metrics ──────────────────────────────

def score(y_true, y_pred):
    y_true = np.asarray(y_true); y_pred = np.asarray(y_pred)
    p, r, f1, _ = precision_recall_fscore_support(
        y_true, y_pred, average="binary", zero_division=0)
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    return {
        "macro_f1": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        # 한쪽으로 다 쏠린 예측이면 sklearn이 0.0을 준다 — 찍기 베이스라인이 MCC 0.000인 이유
        "mcc": float(matthews_corrcoef(y_true, y_pred)),
        "pos_f1": float(f1), "precision": float(p), "recall": float(r),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
        "n": int(len(y_true)),
    }


def compute_metrics(eval_pred):
    logits, labels = eval_pred
    return score(labels, np.argmax(logits, axis=-1))


def baselines(rows):
    """모든 결과표에 강제로 같이 찍는 두 줄 + 참고 한 줄."""
    y = [int(r["label"]) for r in rows]
    rule = [0 if r.get("rule_verdict") == "negated" else 1 for r in rows]
    return {
        "all_positive(찍기)": score(y, [1] * len(y)),
        "rule(rule_verdict!=negated)": score(y, rule),
        "all_negative": score(y, [0] * len(y)),
    }


def fee_type_breakdown(rows, preds):
    by = defaultdict(lambda: {"n": 0, "correct": 0, "pos": 0})
    for r, p in zip(rows, preds):
        b = by[r.get("fee_type", "unknown")]
        b["n"] += 1
        b["correct"] += int(int(p) == int(r["label"]))
        b["pos"] += int(r["label"])
    return {k: {**v, "acc": round(v["correct"] / v["n"], 4)} for k, v in by.items()}


# ─────────────────────── transformers 버전 흡수 ───────────────────────

def make_training_args(**kw):
    """evaluation_strategy / eval_strategy 인자명이 버전마다 다르다."""
    try:
        return TrainingArguments(eval_strategy="epoch", save_strategy="epoch", **kw)
    except TypeError:
        return TrainingArguments(evaluation_strategy="epoch", save_strategy="epoch", **kw)


def build_trainer(tok, **kw):
    try:
        return Trainer(processing_class=tok, **kw)
    except TypeError:
        return Trainer(tokenizer=tok, **kw)


# ──────────────────────────────── main ────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="klue/roberta-base")
    ap.add_argument("--data_dir", required=True)
    ap.add_argument("--out_dir", required=True)
    ap.add_argument("--split", choices=["given", "group"], default="given")
    ap.add_argument("--split_seed", type=int, default=42,
                    help="group 분할 자체의 시드. 시드별 run에서도 고정해 val/test를 안 건드린다")
    ap.add_argument("--train_frac", type=float, default=1.0)
    ap.add_argument("--subset_unit", choices=["auto", "row", "group"], default="auto")
    ap.add_argument("--epochs", type=float, default=4)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max_len", type=int, default=256)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--save_model", type=int, default=0,
                    help="1이면 best 체크포인트를 남긴다. 9~18 run 돌릴 땐 0 (디스크 절약)")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    if args.subset_unit == "auto":
        args.subset_unit = "row" if args.split == "given" else "group"

    set_seed(args.seed)
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    os.makedirs(args.out_dir, exist_ok=True)

    print(f"[env] torch={torch.__version__} cuda={torch.cuda.is_available()} "
          f"device={torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu'}",
          flush=True)
    print(f"[cfg] split={args.split} frac={args.train_frac} unit={args.subset_unit} "
          f"seed={args.seed} max_len={args.max_len} epochs={args.epochs}", flush=True)

    train_all, val_rows, test_rows, split_info = load_split(
        args.data_dir, args.split, args.split_seed)
    train_rows, sub_info = subset_train(train_all, args.train_frac,
                                        args.subset_unit, args.seed)

    n_groups = len({r.get(GROUP_KEY) for r in train_rows})
    print(f"[data] train={len(train_rows)}/{len(train_all)} (숙소 {n_groups}) "
          f"val={len(val_rows)} test={len(test_rows)}", flush=True)
    print(f"[split] {split_info['note']}", flush=True)
    for k, v in split_info["leakage"].items():
        print(f"  누수 {k}: 숙소 {v['shared_groups']}개 · 리뷰 "
              f"{v['affected_rows']}건 ({v['affected_ratio']:.1%})", flush=True)

    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(args.model, num_labels=2)

    # 실제 토큰 길이 — max_len 근거를 로그에 남긴다
    tl = sorted(len(x) for x in tok([r["text"] for r in train_all],
                                    return_token_type_ids=False)["input_ids"])
    print(f"[tok] train 토큰길이 med={tl[len(tl)//2]} p95={tl[int(len(tl)*.95)]} "
          f"max={tl[-1]} | max_len={args.max_len} -> 잘림 "
          f"{sum(t > args.max_len for t in tl)}/{len(tl)}건", flush=True)

    ds_tr = FeeDataset(train_rows, tok, args.max_len)
    ds_va = FeeDataset(val_rows, tok, args.max_len)
    ds_te = FeeDataset(test_rows, tok, args.max_len)

    ckpt_dir = os.path.join(args.out_dir, "ckpt")
    targs = make_training_args(
        output_dir=ckpt_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.bs,
        per_device_eval_batch_size=args.bs * 2,
        learning_rate=args.lr,
        warmup_ratio=0.1,
        weight_decay=0.01,
        logging_steps=20,
        save_total_limit=1,
        load_best_model_at_end=True,
        metric_for_best_model="eval_macro_f1",   # accuracy/pos_f1로 고르면 다수 클래스로 쏠린다
        greater_is_better=True,
        fp16=torch.cuda.is_available(),
        report_to=[],
        seed=args.seed,
        disable_tqdm=True,
    )
    trainer = build_trainer(
        tok, model=model, args=targs,
        train_dataset=ds_tr, eval_dataset=ds_va,
        data_collator=DataCollatorWithPadding(tok),
        compute_metrics=compute_metrics,
    )
    trainer.train()

    # ── 평가
    val_pred = trainer.predict(ds_va)
    val_preds = np.argmax(val_pred.predictions, axis=-1)
    val_m = score(val_pred.label_ids, val_preds)

    te_pred = trainer.predict(ds_te)
    te_preds = np.argmax(te_pred.predictions, axis=-1)
    test_m = score(te_pred.label_ids, te_preds)

    # 사람 라벨만 별도 평가 — LLM 라벨과의 일치가 아닌 유일한 숫자
    hu_idx = [i for i, r in enumerate(test_rows)
              if r.get("label_source") in HUMAN_SOURCES]
    human_m = (score([int(test_rows[i]["label"]) for i in hu_idx],
                     [te_preds[i] for i in hu_idx]) if hu_idx else None)
    hu_in_train = sum(1 for r in train_rows if r.get("label_source") in HUMAN_SOURCES)

    bl_val, bl_test = baselines(val_rows), baselines(test_rows)
    ft = fee_type_breakdown(test_rows, te_preds)

    def line(name, m):
        return (f"  {name:<28} macroF1={m['macro_f1']:.3f} MCC={m['mcc']:+.3f} "
                f"posF1={m['pos_f1']:.3f} P={m['precision']:.3f} R={m['recall']:.3f} "
                f"acc={m['accuracy']:.3f} (n={m['n']})")

    print("\n[val]", flush=True)
    print(line("MODEL", val_m), flush=True)
    for k, v in bl_val.items():
        print(line(k, v), flush=True)
    print("\n[test]", flush=True)
    print(line("MODEL", test_m), flush=True)
    for k, v in bl_test.items():
        print(line(k, v), flush=True)
    print(f"  혼동행렬 TP={test_m['tp']} FP={test_m['fp']} "
          f"FN={test_m['fn']} TN={test_m['tn']}", flush=True)

    print("\n[test/human-labeled only]", flush=True)
    if human_m:
        print(line("MODEL(human)", human_m), flush=True)
        if human_m["n"] < 30:
            print(f"  ⚠ n={human_m['n']}건뿐 — 신뢰구간이 매우 넓다. 경향만 보라.", flush=True)
    else:
        print("  test에 사람 라벨 없음", flush=True)
    print(f"  참고: 사람 라벨 {hu_in_train}건이 train에 포함돼 있다.", flush=True)

    print("\n[test/fee_type] (진단용 — 유형은 학습 목표가 아니다)", flush=True)
    for k, v in sorted(ft.items(), key=lambda x: -x[1]["n"]):
        print(f"  {k:<8} n={v['n']:<4} pos={v['pos']:<4} acc={v['acc']:.3f}", flush=True)

    out = {
        "config": vars(args),
        "split_info": split_info,
        "subset": {**sub_info, "train_rows": len(train_rows),
                   "train_rows_full": len(train_all), "train_groups": n_groups},
        "token_len": {"median": tl[len(tl) // 2], "p95": tl[int(len(tl) * .95)],
                      "max": tl[-1], "truncated": int(sum(t > args.max_len for t in tl))},
        "val": val_m, "test": test_m,
        "test_human_only": human_m,
        "human_rows_in_train": hu_in_train,
        "baselines_val": bl_val, "baselines_test": bl_test,
        "fee_type_test": ft,
        "caveats": [
            "라벨 대부분이 LLM 생성이다. F1은 '정답과의 일치'가 아니라 'LLM 라벨과의 일치'다.",
            "사람 라벨 150건 중 test에 있는 것만 test_human_only로 따로 쟀다.",
            "유형(fee_type)은 학습 목표가 아니다. breakdown은 진단용 숫자다.",
            "배포 불일치: 서버는 리뷰 전문을 받는데 학습 데이터는 중앙값 46자 조각이다. "
            "학습 종료 후 확장 프로그램 쪽 입력 단위를 맞춰야 한다.",
        ],
    }
    if args.split == "given":
        out["caveats"].insert(0,
            "⚠ 이 숫자는 상한이다. val/test 리뷰의 95%가 train에 나온 숙소(listing)에서 왔다. "
            "group 분할 결과와 직접 비교하지 말 것.")

    with open(os.path.join(args.out_dir, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    if args.save_model:
        best = os.path.join(args.out_dir, "best")
        trainer.save_model(best); tok.save_pretrained(best)
        print(f"[save] {best}", flush=True)
    else:
        del trainer, model
        shutil.rmtree(ckpt_dir, ignore_errors=True)  # 디스크 98% — 체크포인트는 버린다

    print(f"[done] {args.out_dir}", flush=True)


if __name__ == "__main__":
    main()
