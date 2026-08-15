"""경로·배포모드·API 키 저장 등 런타임 설정.

데이터 디렉터리는 기본값이 `app/core/data` 이고, 환경변수
`MATH_TEACHER_DATA_DIR` 로 바꿀 수 있다(테스트/샌드박스용).
`/tmp` 는 쓰지 않는다.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Final, Literal

DeployMode = Literal["desktop", "web"]

CORE_DIR: Final[Path] = Path(__file__).resolve().parent
_DEFAULT_DATA_DIR: Final[Path] = CORE_DIR / "data"

DATA_DIR_ENV: Final[str] = "MATH_TEACHER_DATA_DIR"
DEPLOY_MODE_ENV: Final[str] = "MATH_TEACHER_MODE"
API_KEY_ENV: Final[str] = "ANTHROPIC_API_KEY"
# 배포 시 친구 전용 접속 비밀번호(k8s Secret 으로 주입). 없으면 인증 비활성(로컬).
ACCESS_PASSWORD_ENV: Final[str] = "MATH_TEACHER_ACCESS_PASSWORD"
# 배포판 agy 전용 스위치. 켜지면 API 키·구독 provider 를 완전히 비활성화한다.
AGY_ONLY_ENV: Final[str] = "MATH_TEACHER_AGY_ONLY"

MAX_UPLOAD_BYTES: Final[int] = 50 * 1024 * 1024  # 50MB
MAX_NAME_LENGTH: Final[int] = 200
# 사용자가 직접 고친 판독본(`problems.transcript`) 한 건의 길이 상한.
# 문항 하나가 이보다 길 일은 없고, 상한이 없으면 실수나 장난으로 DB 가 부푼다.
# 요청 검증(`schemas`)과 서비스 검증(`service.save_transcript`)이 같은 값을 쓴다.
MAX_TRANSCRIPT_LENGTH: Final[int] = 20_000

# 풀이 1건의 출력 상한. API 키 모드에서만 강제된다(구독 모드는 CLI 가 관리).
DEFAULT_MAX_TOKENS: Final[int] = 8000

# 채팅 컨텍스트로 이어붙이는 최근 메시지 수 상한(토큰 폭주 방지).
CHAT_HISTORY_LIMIT: Final[int] = 20

MODEL_LABELS: Final[dict[str, str]] = {
    "claude-opus-5": "Claude Opus 5 (가장 정확, 가장 비쌈)",
    "claude-sonnet-5": "Claude Sonnet 5 (균형)",
    "claude-haiku-4-5": "Claude Haiku 4.5 (가장 저렴)",
}

_data_dir: Path = Path(os.environ.get(DATA_DIR_ENV) or _DEFAULT_DATA_DIR)


def data_dir() -> Path:
    """데이터 루트(`app.db`, `files/`, `crops/`, `settings.json`)."""
    return _data_dir


def use_data_dir(path: Path) -> None:
    """데이터 루트를 바꾼다. 테스트에서만 사용한다."""
    global _data_dir
    _data_dir = Path(path)
    ensure_dirs()


def db_path() -> Path:
    """SQLite 파일 경로."""
    return data_dir() / "app.db"


def files_dir() -> Path:
    """업로드 원본 PDF 디렉터리."""
    return data_dir() / "files"


def crops_dir() -> Path:
    """문제별 크롭 PNG 디렉터리."""
    return data_dir() / "crops"


def note_crops_dir() -> Path:
    """오답노트 항목의 크롭 **스냅샷** 디렉터리.

    원본 시험지가 지워져도 오답노트가 남아야 하므로 `crops/` 를 참조하지 않고
    추가 시점의 PNG 를 여기로 복사해 둔다.
    """
    return data_dir() / "note_crops"


def bank_crops_dir() -> Path:
    """공용 문항 코퍼스(`bank_problems`)의 크롭 PNG 디렉터리.

    사용자 업로드 크롭(`crops/`)과 **분리한다.** 코퍼스 문항은 업로드 노드와
    수명이 다르다 — 시험지를 지워도 코퍼스는 남아야 하므로, 노드 삭제가 훑는
    `crops/` 밑에 두면 안 된다.
    """
    return data_dir() / "bank"


def settings_path() -> Path:
    """설정(API 키) 파일 경로."""
    return data_dir() / "settings.json"


def ensure_dirs() -> None:
    """데이터 디렉터리를 만든다(이미 있으면 통과)."""
    files_dir().mkdir(parents=True, exist_ok=True)
    crops_dir().mkdir(parents=True, exist_ok=True)
    note_crops_dir().mkdir(parents=True, exist_ok=True)
    bank_crops_dir().mkdir(parents=True, exist_ok=True)


def deploy_mode() -> DeployMode:
    """`desktop`(Tauri sidecar / 로컬 실행) 또는 `web`(서버 실행).

    기본값은 `desktop`. 웹으로 배포할 때 `MATH_TEACHER_MODE=web` 을 설정한다.
    """
    return "web" if os.environ.get(DEPLOY_MODE_ENV, "").lower() == "web" else "desktop"


def _read_settings() -> dict[str, Any]:
    path = settings_path()
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _write_settings(settings: dict[str, Any]) -> None:
    ensure_dirs()
    settings_path().write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def stored_api_key() -> str | None:
    """`data/settings.json` 에 저장된 키(없으면 환경변수 `ANTHROPIC_API_KEY`)."""
    stored = _read_settings().get("anthropic_api_key")
    if isinstance(stored, str) and stored.strip():
        return stored.strip()
    from_env = os.environ.get(API_KEY_ENV, "").strip()
    return from_env or None


def save_api_key(key: str) -> None:
    """키를 평문으로 저장한다(데스크톱 전용, README 경고 참조)."""
    settings = _read_settings()
    settings["anthropic_api_key"] = key.strip()
    _write_settings(settings)


def clear_api_key() -> None:
    """저장된 키를 지운다(환경변수는 건드리지 않는다)."""
    settings = _read_settings()
    settings.pop("anthropic_api_key", None)
    _write_settings(settings)


def agy_only() -> bool:
    """배포판에서 agy 만 허용하고 API 키·구독 provider 를 비활성화한다.

    `MATH_TEACHER_AGY_ONLY=1` 이면 켜진다. 배포 시 API 키 도용·과금 사고를
    원천 차단하기 위한 스위치다(키 기능 자체를 노출하지 않음). 로컬은 기본 꺼짐.
    """
    return os.environ.get(AGY_ONLY_ENV, "").strip() not in ("", "0", "false", "False")


def access_password() -> str | None:
    """배포용 접속 비밀번호. 환경변수 `MATH_TEACHER_ACCESS_PASSWORD` 에서 읽는다.

    설정돼 있으면 모든 `/api/*` 요청이 `X-Access-Password` 헤더로 이 값을
    제출해야 한다(로그인 게이트). 없으면(로컬 개발) 인증을 비활성화한다.
    """
    value = os.environ.get(ACCESS_PASSWORD_ENV, "").strip()
    return value or None


def auth_required() -> bool:
    """접속 비밀번호 인증이 켜져 있는지."""
    return access_password() is not None
