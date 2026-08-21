"""바이너리 다운로드용 단기 서명 토큰.

왜 필요한가:
    `<a href>` 다운로드와 `<img src>` / pdf.js 는 브라우저가 직접 GET 을 날리므로
    커스텀 헤더(`X-Access-Password`)를 붙일 수 없다. 그래서 지금까지는
    `?access=<비밀번호>` 로 **공유 비밀번호를 URL 에 평문으로** 실어 왔다.
    URL 은 브라우저 방문 기록·서버 액세스 로그·Referer 에 남는다. 비밀번호가
    전원 공용 하나뿐이라 한 번 새면 앱 전체가 열리고 교체 비용도 크다.

    이 모듈은 그 자리를 대신할 **단기·범위 제한 토큰**을 만든다. 토큰이 새도
    (a) 몇 분 뒤 만료되고 (b) 해당 노드의 파일만 열리며 (c) 비밀번호 자체는
    복원되지 않는다.

설계 요약:
    형식   `v1.<만료 epoch 초>.<HMAC-SHA256 서명(base64url, 패딩 없음)>`
           점·숫자·base64url 문자만 쓰므로 쿼리스트링에서 깨지지 않는다.
    서명   `HMAC(파생키, "v1|<만료>|<범위>")`. 범위는 토큰 문자열에 넣지 않고
           **검증 시 요청 경로에서 다시 계산**해 맞춘다. 즉 범위가 다르면
           서명이 어긋나 자동으로 거부된다(토큰이 짧아지는 부수 효과도 있다).
    상태   서버에 아무것도 저장하지 않는다. 자기검증형이라 프로세스 재시작이나
           k8s 다중 파드에서도 그대로 검증된다(공유 저장소 불필요).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from functools import lru_cache
from typing import Final

import config

# 토큰 버전. 형식이나 서명 입력이 바뀌면 올린다(구 토큰은 즉시 거부된다).
_VERSION: Final[str] = "v1"

# 바이너리 GET 이 토큰을 받는 쿼리 파라미터 이름.
QUERY_PARAM: Final[str] = "token"

# 토큰 유효 시간(초).
#
# 왜 15분인가:
#   * 게이트는 **요청이 도착한 시점**에만 만료를 본다. 전송이 오래 걸리는
#     대용량 PDF 라도 시작만 유효하면 끝까지 내려간다. 즉 필요한 여유는
#     "전송 시간"이 아니라 "토큰을 URL 에 박아둔 뒤 사용자가 실제로 클릭할
#     때까지의 체류 시간"이다.
#   * 프론트는 화면을 그릴 때 토큰을 만들어 `<img src>` / `<a href>` 에 심는다.
#     사용자가 시험지를 열어 두고 몇 분 뒤 내려받는 일이 흔하므로 1~2분은
#     짧다(다운로드가 401 로 실패한다).
#   * 반대로 시간이 길수록 기록에 남은 URL 이 살아 있는 창이 커진다.
#   * 파드 간 시계 오차(NTP 동기 환경에서 보통 1초 미만)를 신경 쓰지 않아도 되고,
#     노출 창은 "영구"였던 기존 비밀번호와 비교 불가하게 짧다.
#
# 15분 -> 30분 (2026-08-21): 이미 열어 둔 PDF 는 pdf.js 가 페이지를 넘길 때
# **최초 URL 로** 추가 요청을 보낸다. 프론트가 토큰을 백그라운드로 갱신해도 그
# 문서에 박힌 URL 은 바뀌지 않으므로(바꾸면 문서가 통째로 재로딩되어 읽던 자리를
# 잃는다), 한 번 연 문서를 계속 읽을 수 있는 시간이 곧 이 TTL 이다. 시험지 한 부를
# 훑는 데 15분은 짧다는 판단으로 30분으로 늘렸다. 노출 창이 그만큼 커지지만,
# 토큰은 여전히 노드 하나로 범위가 묶여 있고 만료도 확실하다.
TTL_SECONDS: Final[int] = 1800

# 서명키 파생 파라미터.
#
# 왜 비밀번호에서 파생하는가: 새 환경변수를 만들면 배포 절차(k8s Secret)가 늘고,
# 값을 안 넣은 파드가 생기면 조용히 인증이 갈린다. 비밀번호는 이미 모든 파드에
# 같은 값으로 주입돼 있어 별도 배포 없이 모든 파드가 같은 키를 얻는다.
#
# 왜 PBKDF2 인가: 비밀번호는 사람이 외우는 저엔트로피 값이다. 단순 HMAC 한 번으로
# 파생하면, 유출된 토큰 하나로 오프라인 사전 공격을 초당 수백만 번 돌려 비밀번호를
# 되찾을 수 있다(그러면 URL 노출을 없앤 의미가 사라진다). 20만 회 스트레칭이면
# 후보 하나당 수십 ms 가 들어 대량 추측이 비현실적으로 비싸진다.
# 파생 결과는 캐시하므로 요청당 비용은 0 이다.
_KEY_SALT: Final[bytes] = b"math-teacher/download-token/v1"
_KEY_ITERATIONS: Final[int] = 200_000
_KEY_LENGTH: Final[int] = 32

# 범위를 만들 수 있는 컬렉션. 바이너리 자산은 전부 이 둘 밑에 있다
# (`/api/files/{id}/...`, `/api/notes/{id}/...`).
_SCOPED_COLLECTIONS: Final[frozenset[str]] = frozenset({"files", "notes"})

# 아래 세 정규식은 모두 `fullmatch` 로 쓴다. `re.match` 는 `$` 앞에 오는 문자열 끝
# 개행 하나를 눈감아 줘서, 만료 필드에 `%0A` 를 붙인 변종 토큰이 통과해 버린다
# (`int()` 도 공백·개행을 알아서 떼므로 서명까지 그대로 맞는다). 인증 우회는
# 아니지만 같은 토큰의 변종이 무한히 생기는 것은 막는 편이 낫다.

# 노드 ID 허용 문자(라우트의 `NodeId` 와 같은 상한 64자). 경로에서 뽑은 값을
# 그대로 서명 입력에 넣으므로, 이상한 문자가 섞인 경로는 아예 범위로 인정하지
# 않는다.
_NODE_ID_RE: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9_-]{1,64}")

# 방어적 상한. 정상 토큰은 60자 안팎이라 이보다 길면 볼 것도 없이 거부한다.
_MAX_TOKEN_LENGTH: Final[int] = 256

# 만료 필드는 ASCII 숫자만 받는다. `str.isdigit()` 이나 `\d` 는 유니코드 숫자까지
# 통과시켜 `int()` 에서 예기치 않은 예외가 날 수 있다(예: 위첨자 '²').
_EXPIRES_RE: Final[re.Pattern[str]] = re.compile(r"[0-9]{1,12}")

# 서명 필드도 형식을 먼저 확인한다. `secrets.compare_digest` 는 **non-ASCII `str`
# 을 받으면 TypeError 를 던진다.** 그대로 두면 `?token=v1.1999999999.한글` 한 번에
# 인증 실패가 500 으로 둔갑하고 서버 로그가 오염된다. 게이트는 어떤 입력이 와도
# 조용히 401 로 떨어져야 하므로, 비교 전에 base64url 문자만 통과시킨다.
# 길이 43 은 고정이다: HMAC-SHA256 = 32바이트 -> base64url 패딩 제거 시 43자.
# (해시를 바꾸면 `_VERSION` 을 올려야 하므로 버전당 상수로 못박아도 안전하다.)
_SIGNATURE_RE: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9_-]{43}")


@lru_cache(maxsize=8)
def _derive_key(password: str) -> bytes:
    """접속 비밀번호에서 서명키를 파생한다(같은 비밀번호면 어느 파드든 같은 키).

    Args:
        password: 접속 비밀번호(`MATH_TEACHER_ACCESS_PASSWORD`).

    Returns:
        HMAC 서명에 쓸 32바이트 키.
    """
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), _KEY_SALT, _KEY_ITERATIONS, dklen=_KEY_LENGTH
    )


def warm_up() -> None:
    """서명키를 미리 파생해 캐시에 올린다(기동 시 1회, 블로킹 CPU 작업).

    미들웨어는 `async` 라 첫 요청에서 PBKDF2 를 돌리면 그동안 이벤트 루프가
    멈춘다. 인증이 꺼진 환경에서는 파생할 것이 없으므로 아무것도 하지 않는다.
    """
    password = config.access_password()
    if password is not None:
        _derive_key(password)


def scope_for(path: str) -> str | None:
    """요청 경로가 속한 토큰 범위(`/api/files/{id}` 또는 `/api/notes/{id}`).

    범위를 노드 단위로 잡은 이유: 시험지 하나를 열면 원본 PDF 1건과 문항 크롭
    수십 건을 한꺼번에 로드한다. 파일 하나마다 토큰을 발급하면 화면 진입마다
    수십 번의 왕복이 생긴다. 반대로 범위를 없애면 토큰 하나로 남의 시험지까지
    열리므로, "열어 둔 노드 하나" 를 경계로 삼는 것이 비용과 노출의 균형점이다.

    Args:
        path: 요청 경로. 쿼리스트링/프래그먼트가 붙어 있어도 된다.

    Returns:
        범위 문자열. 범위를 만들 수 없는 경로면 `None`.
    """
    clean = path.split("?", 1)[0].split("#", 1)[0]
    parts = clean.split("/")
    # ["", "api", "<컬렉션>", "<노드 id>", ...]
    if len(parts) < 4 or parts[0] != "" or parts[1] != "api":
        return None
    collection, node_id = parts[2], parts[3]
    if collection not in _SCOPED_COLLECTIONS or not _NODE_ID_RE.fullmatch(node_id):
        return None
    return f"/api/{collection}/{node_id}"


def _signature(scope: str, expires_at: int, password: str) -> str:
    """`(범위, 만료)` 쌍에 대한 base64url 서명 문자열."""
    message = f"{_VERSION}|{expires_at}|{scope}".encode()
    digest = hmac.new(_derive_key(password), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def sign(scope: str, password: str, *, ttl_seconds: int = TTL_SECONDS) -> str:
    """범위에 묶인 단기 토큰을 만든다.

    Args:
        scope: `scope_for` 가 돌려준 범위 문자열.
        password: 접속 비밀번호(서명키 파생용).
        ttl_seconds: 유효 시간. 테스트에서 만료 토큰을 만들 때 음수를 줄 수 있다.

    Returns:
        `v1.<만료 epoch 초>.<서명>` 형식의 토큰.
    """
    expires_at = int(time.time()) + ttl_seconds
    return f"{_VERSION}.{expires_at}.{_signature(scope, expires_at, password)}"


def verify(token: str, path: str, password: str) -> bool:
    """토큰이 이 경로에 대해 유효한지.

    만료와 범위 모두 서명 입력에 들어가므로, 만료를 늘리거나 다른 노드에 쓰려고
    값을 고치면 서명이 깨진다. 비교는 기존 게이트와 같이 `secrets.compare_digest`
    로 해 타이밍 공격을 피한다.

    **이 함수는 어떤 입력에도 예외를 던지지 않는다.** 미들웨어에서 부르므로 예외가
    나면 인증 실패가 500 이 된다. 그래서 각 필드를 정규식으로 먼저 걸러 낸 뒤에만
    `int()` 와 `compare_digest` 를 부른다(둘 다 이상한 문자에 예외를 던진다).

    Args:
        token: 쿼리로 받은 토큰 문자열.
        path: 실제 요청 경로(여기서 범위를 다시 계산한다).
        password: 접속 비밀번호(서명키 파생용).

    Returns:
        유효하면 True.
    """
    if not token or len(token) > _MAX_TOKEN_LENGTH:
        return False
    scope = scope_for(path)
    if scope is None:
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    version, expires_text, signature = parts
    if version != _VERSION or not _EXPIRES_RE.fullmatch(expires_text):
        return False
    if not _SIGNATURE_RE.fullmatch(signature):
        return False
    expires_at = int(expires_text)
    if expires_at <= time.time():
        return False
    return secrets.compare_digest(signature, _signature(scope, expires_at, password))
