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
#
# cv2 는 **headless 빌드로 바꿔 넣는다.** rapidocr-onnxruntime 의 의존성은
# `opencv-python`(GUI 빌드)인데, 그 휠은 Qt5 를 함께 담고 있어 libGL.so.1 ·
# libglib-2.0.so.0 · libX11.so.6 · libICE/libSM/libXext/libxcb 를 OS 에서
# 요구한다(실측: 휠 안 .so 들의 DT_NEEDED). slim 이미지에는 이것들이 없어
# `import cv2` 가 그대로 깨지고, apt 로 넣자니 패키지 이름이 데비안 릴리스마다
# 다르다(bookworm `libglib2.0-0` vs trixie `libglib2.0-0t64`). headless 휠은 같은
# cv2 API 를 주면서 libstdc++/libz 만 요구하므로 apt 추가가 아예 필요 없고
# 13MB(74 -> 61MB) 더 작다.
#
# 순서가 중요하다. 반대로 하면 나중에 지우는 GUI 패키지가 공유하는 `cv2/` 파일을
# 함께 지워 headless 까지 망가진다.
#
# 마지막 import 는 **빌드 시점 연막 검사**다. 공유 라이브러리가 모자라면 k8s 에
# 배포된 뒤가 아니라 CI 빌드에서 크게 터진다.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y opencv-python \
    && pip install --no-cache-dir opencv-python-headless \
    && python -c "import cv2, rapidocr_onnxruntime; rapidocr_onnxruntime.RapidOCR()"

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
