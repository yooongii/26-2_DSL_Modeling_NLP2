"""
serve.py — 학습된 추가비용 분류기를 HTTP로 띄운다

    python serve.py                                   # 통합 멀티라벨 모델 (기본)
    python serve.py --model klue/roberta-small --binary  # 이진 전용 모델 (한국어 · 09-23 base→small 교체)

의존성을 늘리지 않으려고 표준 라이브러리 http.server 를 쓴다.

  POST /classify   {"texts": ["리뷰1", ...]}
  →  {"results": [{"label": 1, "prob": 0.93, "types": [{"name":"세금_숙박세","prob":0.88}]}],
      "ms": 120}

  GET  /health     {"ok": true, "model": "...", "device": "cuda", "types": [...]}

모델은 기동 시 1회 로드해 메모리에 둔다(요청마다 재로드하면 수 초씩 걸린다).

── 로컬과 배포가 같은 파일로 돈다
어느 쪽이든 모델은 `ckpt/` 에서만 읽는다. 로컬은 팀원-실행법.md 대로 폴더를 두고
`python serve.py` 하면 127.0.0.1:8799 다. 배포는 Dockerfile 이 `ckpt/` 를 이미지에
구워 넣으므로 실행 중 네트워크가 필요 없다 — 콜드스타트에 261MB 를 받지 않는다.
아래 "배포 설정" 블록의 주석에 각 값의 의미가 있다.

── 유형을 다 내보내지 않는 이유
06_tune_thresholds.py 로 측정한 결과, 유형 10종 중 실제로 쓸 만한 것은 둘뿐이다.

    세금_숙박세   PR-AUC 0.967 · F1 0.904
    보증금_현장   PR-AUC 0.825 · F1 0.727   (임계값 0.28 로 내려야 살아난다)
    조식_별도결제 PR-AUC 0.084 ← 양성률 7.9% 보다 낮다. 무작위 이하
    나머지        표본 부족(test 1~15건)이라 판단 자체가 불가

그래서 신뢰 가능한 유형만 내보내고 나머지는 유형 없이 "추가비용 언급"으로만 알린다.
못 믿을 유형을 화면에 띄우면 사용자가 틀린 근거를 보게 된다.
데이터가 보강되면 RELIABLE_TYPES 를 넓히면 된다.
"""
import argparse
import inspect
import re
import json
import os
import pathlib
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

HERE = pathlib.Path(__file__).resolve().parent

# 06_tune_thresholds.py 실측 기준. 근거는 위 주석 참고.
#
# 노출할 유형. 비우면 유형 없이 "추가비용 언급"으로만 알린다.
#
# 5종 묶음 모델(_multi5) 기준 test 303건 성능:
#   세금·숙박세  P 0.974 · F1 0.962      쓸 만함
#   보증금       P 0.909 · F1 0.800      쓸 만함
#   기타부대     P 0.643 · F1 0.514      애매
#   시설이용     P 0.500 · F1 0.526      절반이 오탐
#   식음료       P 0.214 · F1 0.158      못 배움 (PR-AUC 0.182)
#
# 지금은 파이프라인 연결 확인이 우선이라 전부 켜둔다. 데이터 보강·재라벨링 후
# 다시 측정해서 못 믿을 유형은 여기서 빼면 된다(코드 변경 없음).
RELIABLE_TYPES: set[str] = {"세금·숙박세", "보증금", "식음료", "시설이용", "기타부대"}

# ── 배포 설정 ───────────────────────────────────────────────────────────
#
# 모델을 어디서 읽는가
#   `ckpt/<태그>/` 하나뿐이다. 가중치는 261MB 라 git 에 못 올리므로,
#   로컬은 팀원-실행법.md 대로 드라이브에서 받아 두고 배포는 Dockerfile 이 구워 넣는다.
#
#   예전에는 여기에 Hugging Face Hub 저장소(HF_REPO)를 받는 대체 경로가 있었다.
#   HF Spaces 로 서빙하던 시절의 잔재인데, 콜드스타트마다 261MB 를 받느라 40초가
#   걸려서(익스텐션은 8초에 포기한다) Cloud Run + 이미지에 굽는 방식으로 옮겼다.
#   그 뒤로 이 분기는 한 번도 타지 않았고, 오히려 두 가지를 조용히 망가뜨릴 수 있었다:
#     · 저장소에 남아 있던 건 세대가 다른 모델(multi5)이었다 — 받아 올렸다면 출력 형태가 다르다
#     · 저장소가 하나뿐이라 영어 모델 자리에 한국어 모델이 올라간다
#   그래서 지웠다. ckpt/ 가 없으면 이제 조용히 대체하지 않고 명확히 실패한다.

# 우리 서버를 부를 수 있는 곳.
#
# ⚠️ 여기를 chrome-extension://... 으로 좁히면 **모든 요청이 막힌다.**
#    익스텐션 코드는 아고다 페이지 안에서 fetch 하므로, 브라우저가 붙이는 Origin 은
#    확장 ID 가 아니라 아고다다. 로컬 개발도 같은 Origin 이라 그대로 동작한다.
ALLOWED_ORIGINS = {
    o.strip() for o in
    os.environ.get("CC_ALLOWED_ORIGINS", "https://www.agoda.com,https://agoda.com").split(",")
    if o.strip()
}
# 익스텐션이 도는 사이트의 도메인 접미사. Trip.com 은 kr./www./hk. 처럼 서브도메인이 여럿이라
# 정확 일치 목록으로는 다 못 적는다 — 확장의 sites/*.js `matches` 와 같은 규칙으로 판정한다.
# https 만 허용한다(확장 manifest 의 matches 도 https 뿐).
ALLOWED_ORIGIN_SUFFIXES = tuple(
    s.strip().lstrip(".") for s in
    os.environ.get("CC_ALLOWED_ORIGIN_SUFFIXES", "agoda.com,trip.com,booking.com").split(",")
    if s.strip()
)

def origin_allowed(origin: str) -> bool:
    if origin in ALLOWED_ORIGINS:
        return True
    m = re.match(r"^https://([a-z0-9.-]+)$", origin, re.I)
    if not m:
        return False
    host = m.group(1).lower()
    return any(host == suf or host.endswith("." + suf) for suf in ALLOWED_ORIGIN_SUFFIXES)

# 요청 상한. 공개 엔드포인트라 없으면 큰 본문 하나로 메모리를 채울 수 있다.
MAX_BODY_BYTES = 1_000_000
MAX_TEXTS = 100
MAX_CHARS = 2000

# 언어별 모델. 한국어·영어 분류기가 아키텍처도 학습데이터도 달라 따로 올린다.
#   MODELS["ko"] = {tok, model, dev, name, binary, max_len, thresholds, labels}
# 하나만 올려도 동작한다 — 그 언어 요청만 받고 나머지는 400 을 준다.
MODELS: dict[str, dict] = {}

# lang 을 안 보내는 클라이언트를 위한 기본값. **바꾸지 말 것** —
# 배포된 익스텐션(v1.0.x)은 {"texts": [...]} 만 보낸다. 기본값이 없으면 서버를
# 교체하는 순간 기존 사용자가 전부 깨진다.
DEFAULT_LANG = "ko"


def load(lang: str, model_name: str, binary: bool, max_len: int, multi10: bool = False) -> None:
    tag = model_name.replace("/", "_") + ("" if binary else ("_multi" if multi10 else "_multi5"))
    ckpt = HERE / "ckpt" / tag

    # 모델은 ckpt/ 에서만 읽는다(위 '모델을 어디서 읽는가' 주석 참고).
    if not ckpt.exists():
        if lang != DEFAULT_LANG:
            # 보조 언어가 없으면 그 언어만 끈다 — 클라이언트는 400 을 받고 규칙으로 폴백한다.
            print(f"⚠️  {lang} 모델이 {ckpt} 에 없어 {lang} 라우팅을 끕니다.")
            return
        print(f"❌ 기본 언어({lang}) 모델이 {ckpt} 에 없습니다.")
        print("   로컬: 팀원-실행법.md 대로 드라이브에서 ckpt 폴더를 받아 두세요")
        print("   배포: Dockerfile 의 COPY ckpt/ 가 실제로 들어갔는지 확인하세요")
        sys.exit(1)

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"모델 로드 중... {tag} ({dev})")
    try:
        model = AutoModelForSequenceClassification.from_pretrained(str(ckpt)).to(dev).eval()
    except Exception as e:
        print(f"❌ 모델을 불러오지 못했습니다: {type(e).__name__}: {e}")
        print(f"   {ckpt} 안에 config.json · model.safetensors · 토크나이저 파일이 다 있는지 확인하세요")
        sys.exit(1)

    # thresholds.json 은 우리가 만든 파일이라 from_pretrained 가 안 가져온다. 따로 읽는다.
    thresholds: dict = {}
    try:
        thr_file = ckpt / "thresholds.json"
        if thr_file.exists():
            thresholds = json.loads(thr_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"⚠️  thresholds.json 을 읽지 못했습니다: {type(e).__name__}: {e}")

    if not binary and not thresholds:
        print("⚠️  thresholds.json 이 없습니다. 0.5 고정으로 돕니다 —")
        print("   희소 유형이 전부 0으로 나옵니다. python 06_tune_thresholds.py 를 먼저 실행하세요.")

    labels = [model.config.id2label[i] for i in range(model.config.num_labels)] if not binary else []

    MODELS[lang] = {
        "tok": AutoTokenizer.from_pretrained(str(ckpt)),
        "model": model, "dev": dev, "name": tag, "binary": binary,
        # forward 가 받는 인자 이름. 토크나이저가 만드는 키 중 모델이 모르는 건 걸러낸다(classify 참고).
        "fwd": set(inspect.signature(model.forward).parameters),
        "max_len": max_len, "thresholds": thresholds, "labels": labels,
    }
    if not binary:
        shown = [t for t in labels[1:] if t in RELIABLE_TYPES]
        print(f"유형 {len(labels)-1}종 중 노출 {len(shown)}종: {', '.join(shown)}")
    print("준비 완료")


def classify(texts: list[str], lang: str = DEFAULT_LANG) -> list[dict]:
    st = MODELS.get(lang)
    if st is None:
        raise ValueError(f"{lang} 모델이 올라와 있지 않습니다 (가용: {', '.join(sorted(MODELS)) or '없음'})")
    tok, model, dev = st["tok"], st["model"], st["dev"]
    binary, thr, labels = st["binary"], st["thresholds"], st["labels"]
    # 길이순 정렬 + 작은 배치. padding=True 는 배치 안 최장 문장에 맞춰 패딩하므로
    # 긴 문장 하나가 배치 32개 전체 계산을 늘렸다(실측: 2 vCPU 서버, 40문장 10.3s,
    # 문장 토큰 중앙값 31·최대 165). 비슷한 길이끼리 8개씩 묶으면 출력은 같고
    # (40문장 확률차 0.000) 약 3배 빠르다. 결과는 원래 순서로 되돌려 준다.
    texts = [str(t) for t in texts]
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    out: list[dict] = []
    B = 8
    with torch.no_grad():
        for i in range(0, len(order), B):
            enc = tok([texts[j] for j in order[i:i + B]], truncation=True,
                      max_length=st["max_len"], padding=True,
                      return_tensors="pt").to(dev)
            # 영어 체크포인트의 tokenizer_config 가 BertTokenizer 라 token_type_ids 를 만드는데
            # DistilBert.forward 는 그 인자를 받지 않는다(실측 TypeError). 학습 스크립트는
            # input_ids·attention_mask 만 골라 넘겨서 몰랐던 문제 — 여기서도 모델이 아는 키만 넘긴다.
            enc = {k: v for k, v in enc.items() if k in st["fwd"]}
            # ckpt/config.json 에 torchscript:true 가 들어가 있으면 transformers 가
            # return_dict=False 로 동작해 ModelOutput 대신 tuple 을 준다
            # (실측: AttributeError: 'tuple' object has no attribute 'logits').
            # 모델 파일을 건드리지 않고 양쪽을 다 받는다.
            raw = model(**enc)
            logits = raw.logits if hasattr(raw, "logits") else raw[0]
            if binary:
                for p in torch.softmax(logits, dim=-1)[:, 1].tolist():
                    out.append({"label": int(p >= 0.5), "prob": round(p, 4), "types": []})
            else:
                for row in torch.sigmoid(logits).tolist():
                    p_cost = row[0]
                    types = [
                        {"name": labels[j], "prob": round(row[j], 4)}
                        for j in range(1, len(labels))
                        if labels[j] in RELIABLE_TYPES
                        and row[j] >= thr.get(labels[j], 0.5)
                    ]
                    types.sort(key=lambda x: -x["prob"])
                    out.append({
                        "label": int(p_cost >= thr.get("is_cost", 0.5)),
                        "prob": round(p_cost, 4),
                        "types": types,
                    })
    # 길이순으로 계산했으니 요청 순서로 되돌린다
    restored: list[dict] = [None] * len(texts)  # type: ignore[list-item]
    for j, r in zip(order, out):
        restored[j] = r
    return restored


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        """허용 목록에 있는 Origin 에만 CORS 를 연다.

        목록에 없으면 헤더를 아예 안 보낸다 → 브라우저가 응답을 버린다.
        curl 처럼 Origin 이 없는 요청은 CORS 대상이 아니라 그냥 통과한다.
        """
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")  # 캐시가 Origin 별로 나뉘게
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:          # noqa: N802
        """CORS preflight. **본문을 붙이면 안 된다.**

        예전에는 `self._send(204, {})` 였는데, 그러면 204 에 Content-Length 와 본문 `{}`
        가 같이 나간다. 204(No Content)는 본문을 가질 수 없다(RFC 9110).
        로컬 파이썬 서버는 넘어갔지만 Cloud Run 앞단 프록시는 프로토콜 위반으로 보고
        502 를 돌려줬다 — 그러면 브라우저 preflight 가 실패해서 본 요청이 아예 안 나간다.
        (실측: GET /health 는 200 인데 OPTIONS /classify 만 502)
        """
        self.send_response(204)
        self._cors()
        # preflight 결과를 하루 캐시한다. OPTIONS 요청이 줄면 콜드스타트도 덜 겪는다.
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:              # noqa: N802
        # /panel.js 는 없앴다. 콘솔에 붙여넣을 JS 를 서버가 내려주던 개발용 경로인데,
        # 배포 서버가 실행 가능한 코드를 제공하는 모양이라 보안·심사상 좋지 않다.
        # 그 번들이 필요하면 review-engine/out/review-panel.console.js 를 직접 쓴다.
        if self.path.startswith("/health"):
            # model/device/types 는 옛 클라이언트가 읽던 키라 그대로 둔다(기본 언어 기준).
            base = MODELS.get(DEFAULT_LANG) or next(iter(MODELS.values()), None)
            self._send(200, {
                "ok": bool(MODELS),
                "model": base["name"] if base else None,
                "device": base["dev"] if base else None,
                "types": sorted(t for t in base["labels"][1:] if t in RELIABLE_TYPES) if base else [],
                "langs": {lg: st["name"] for lg, st in sorted(MODELS.items())},
                "default_lang": DEFAULT_LANG,
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:             # noqa: N802
        if not self.path.startswith("/classify"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            # 본문을 읽기 **전에** 크기를 본다. 읽고 나서 재면 이미 메모리에 올라간 뒤다.
            if n > MAX_BODY_BYTES:
                self._send(413, {"error": f"요청 본문은 최대 {MAX_BODY_BYTES // 1000}KB 입니다"})
                return
            req = json.loads(self.rfile.read(n) or b"{}")
            texts = req.get("texts") or []
            if not isinstance(texts, list):
                raise ValueError("texts 는 배열이어야 합니다")
            if len(texts) > MAX_TEXTS:
                self._send(413, {"error": f"texts 는 한 번에 최대 {MAX_TEXTS}건입니다"})
                return
            # 길이 초과는 거절하지 않고 자른다 — 모델도 어차피 max_len 에서 자른다.
            texts = [str(t)[:MAX_CHARS] for t in texts]
            # lang 없으면 기본 언어. 배포된 익스텐션은 이 키를 안 보낸다(DEFAULT_LANG 주석 참고).
            lang = str(req.get("lang") or DEFAULT_LANG).lower()
            if lang not in MODELS:
                self._send(400, {"error": f"지원하지 않는 언어: {lang}",
                                 "langs": sorted(MODELS)})
                return
            t0 = time.perf_counter()
            results = classify(texts, lang) if texts else []
            self._send(200, {"results": results, "lang": lang,
                             "ms": round((time.perf_counter() - t0) * 1000)})
        except Exception as e:             # 클라이언트가 원인을 보게 그대로 돌려준다
            self._send(400, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *a) -> None:
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="klue/roberta-small",
                    help="기본 언어(ko) 모델. 하위호환을 위해 이름을 유지한다")
    ap.add_argument("--model-en", default=os.environ.get("CC_MODEL_EN"),
                    help="영어 모델. 주면 en 라우팅이 켜진다")
    ap.add_argument("--multi10", action="store_true", help="옛 10종 모델(_multi)")
    ap.add_argument("--binary", action="store_true", help="이진 전용 모델(02_train.py 산출)을 쓴다")
    # 클라우드는 PORT 환경변수로 포트를 지정해준다. 로컬은 예전 그대로 8799.
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8799)))
    # 로컬 기본값은 127.0.0.1("이 컴퓨터 안에서만") 그대로 둔다 — 같은 와이파이의
    # 다른 기기에 서버가 열리지 않게. 컨테이너에서는 HOST=0.0.0.0 을 넣어 띄운다.
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--max-len", type=int, default=512)
    args = ap.parse_args()

    load(DEFAULT_LANG, args.model, args.binary, args.max_len, args.multi10)
    if args.model_en:
        # 영어는 별도 학습(distilbert 계열)이라 항상 이진이다.
        load("en", args.model_en, True, args.max_len)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"http://{args.host}:{args.port}  (POST /classify · GET /health)")
    loaded = ", ".join(f"{lg}={st['name']}" for lg, st in sorted(MODELS.items()))
    print(f"언어: {loaded}")
    print(f"CORS 허용: {', '.join(sorted(ALLOWED_ORIGINS)) or '(없음)'} + *.{' / *.'.join(ALLOWED_ORIGIN_SUFFIXES)}")
    print("끄기: Ctrl+C")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료")


if __name__ == "__main__":
    main()
