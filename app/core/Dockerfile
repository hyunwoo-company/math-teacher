# 수학 문제풀이 백엔드 (FastAPI).
#
# AI 는 agy(Antigravity CLI)로만 호출한다. agy 바이너리와 인증 토큰은
# 이미지에 넣지 않고, k8s hostPath 로 런타임에 마운트한다
# (`/home/hyunwoo/.local/bin/agy`, `~/.gemini`). 그래서 이미지에는 어떤 비밀도
# 담기지 않는다. agy 는 표준 glibc 동적 링크라 slim(Debian) 에서 그대로 실행된다.
FROM python:3.12-slim

# agy 가 네트워크(TLS)로 Antigravity 백엔드에 붙을 때 필요한 CA 인증서.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저(레이어 캐시). claude-agent-sdk 는 웹/agy 배포에서 불필요하나
# requirements 에 있어도 무방하다.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 코드.
COPY . .

# 데이터는 hostPath 볼륨(`/data`)에 저장한다. 배포 기본값.
ENV MATH_TEACHER_DATA_DIR=/data \
    MATH_TEACHER_MODE=web \
    MATH_TEACHER_AGY_ONLY=1 \
    PATH="/home/hyunwoo/.local/bin:${PATH}" \
    HOME=/home/hyunwoo \
    PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
