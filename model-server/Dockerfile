# 추가비용 분류 서버 — Google Cloud Run 용
#
# **모델을 이미지에 굽는다.**
#
# Cloud Run 은 요청이 없으면 인스턴스를 0으로 줄였다가 요청이 오면 다시 띄운다.
# 깨어날 때마다 Hub 에서 261MB 를 받으면 콜드스타트가 40초쯤 되는데, 익스텐션은
# 8초에서 포기하므로(modelAnalyzer 의 timeoutMs) 모델이 거의 항상 건너뛰어진다.
# 이미지에 넣어두면 모델 로드만 하면 돼서 10초 안쪽으로 줄어든다.
#
# 대신 이미지가 1.5GB 쯤 된다. Cloud Run 은 이미지를 스트리밍해서 띄우므로
# 그 크기 자체는 문제가 되지 않는다.
#
# 빌드 위치는 이 파일이 있는 폴더다 — serve.py 와 ckpt/ 가 같이 있어야 하기 때문.
#     cd model-server
#     gcloud run deploy clear-booking-cost-api --source . --region asia-northeast3

FROM python:3.11-slim

WORKDIR /app

# torch 는 CPU 전용 인덱스에서 받는다.
# 기본 PyPI 로 받으면 CUDA 런타임이 딸려와 이미지가 2.5GB 를 더 먹는다 — GPU 가 없는
# Cloud Run 에서는 통째로 낭비다.
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY serve.py .

# serve.py 는 모델을 ckpt/ 에서만 읽는다. 이미지에 넣어두면 실행 시 네트워크가 필요 없다.
# 이 COPY 가 빠지면 서버가 기동 중에 명확히 실패한다(load() 참고).
COPY ckpt/ ./ckpt/

# Cloud Run 이 PORT 를 주입한다(기본 8080).
# HOST 는 컨테이너 밖에서 닿아야 하므로 0.0.0.0 — serve.py 의 로컬 기본값(127.0.0.1)은
# 그대로 두고 여기서만 덮어쓴다.
ENV HOST=0.0.0.0 \
    PORT=8080

# 두 모델을 올린다. 폴더 이름은 serve.py load() 규칙(model_name 의 / → _)을 따른다:
#   ckpt/klue_roberta-small/        ← 한국어 (train_ko_fee.py, 이진 · 09-23 base→small)
#   ckpt/distilbert-base-uncased/   ← 영어  (final_train_save.py, 이진)
# 둘 다 이진 모델이라 유형(types)은 안 나온다 — 유형은 클라이언트 규칙 층이 붙인다.
CMD ["python", "serve.py", "--model", "klue/roberta-small", "--binary", "--model-en", "distilbert-base-uncased"]
