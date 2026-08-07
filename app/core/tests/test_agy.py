"""agy(Antigravity CLI) 프로바이더 단위 테스트.

실제 agy 호출은 하지 않는다(쿼터 소비 금지). `_run` 을 스텁으로 대체해
파싱·후처리·이벤트 생성만 검증한다.
"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import ai_service
import config
from errors import ApiError
from providers import agy as agy_provider
from providers.agy import (
    AGY_MODELS,
    DEFAULT_MODEL,
    AgyProvider,
    build_agy_args,
    parse_agy_output,
    strip_followups,
)
from providers.base import ProviderError


@pytest.fixture
def agy_enabled(monkeypatch: pytest.MonkeyPatch) -> Path:
    """agy 를 "설치됨" 으로 만든다(가짜 경로). 실제 실행은 하지 않는다."""
    fake = Path("C:/fake/agy.exe")
    monkeypatch.setattr(agy_provider, "find_agy", lambda: fake)
    return fake


# ----------------------------------------------------------- build_agy_args
def test_flash_omits_effort() -> None:
    args = build_agy_args(
        agy_path=Path("agy.exe"),
        model="gemini-3-flash",
        effort="high",
        prompt="풀이해줘",
    )
    assert "--effort" not in args
    assert args[:2] == ["agy.exe", "-p"]
    assert "--dangerously-skip-permissions" in args
    assert "json" in args


def test_gemini_pro_omits_effort() -> None:
    # gemini-3.1-pro-low/high 는 effort 가 모델명에 내장돼 있어 --effort 를 붙이면
    # agy 가 "conflicts with --effort" 로 거부한다 → 절대 붙이지 않는다.
    for model in ("gemini-3.1-pro-low", "gemini-3.1-pro-high"):
        args = build_agy_args(
            agy_path=Path("agy.exe"),
            model=model,
            effort="medium",
            prompt="풀이해줘",
        )
        assert "--effort" not in args, model
        assert model in args


def test_claude_includes_effort_clamped() -> None:
    args = build_agy_args(
        agy_path=Path("agy.exe"),
        model="claude-sonnet-4-6",
        effort="max",  # agy 는 low|medium|high 만 → high 로 클램프
        prompt="풀이해줘",
    )
    assert "--effort" in args
    assert args[args.index("--effort") + 1] == "high"


def test_gemini_pro_keeps_long_timeout() -> None:
    # effort=False 로 바뀌어도 pro 는 느리므로 타임아웃은 flash 보다 길어야 한다.
    from providers.agy import _FLASH_TIMEOUT_SECONDS, _timeout_for

    assert _timeout_for("gemini-3.1-pro-low") > _FLASH_TIMEOUT_SECONDS
    assert _timeout_for("gemini-3.1-pro-high") > _FLASH_TIMEOUT_SECONDS
    assert _timeout_for("gemini-3-flash") == _FLASH_TIMEOUT_SECONDS


def test_build_args_rejects_unknown_model() -> None:
    with pytest.raises(ProviderError) as excinfo:
        build_agy_args(
            agy_path=Path("agy.exe"), model="gpt-9", effort="low", prompt="x"
        )
    assert excinfo.value.error_code == "unknown_model"


# -------------------------------------------------------- resolve_model(agy)
def test_resolve_model_agy_default_is_flash() -> None:
    assert ai_service.resolve_model(None, "agy") == DEFAULT_MODEL


def test_resolve_model_agy_rejects_claude_model() -> None:
    with pytest.raises(ApiError) as excinfo:
        ai_service.resolve_model("claude-opus-5", "agy")
    assert excinfo.value.status_code == 400
    assert excinfo.value.error_code == "unknown_model"


def test_resolve_model_agy_rejects_off_list() -> None:
    with pytest.raises(ApiError) as excinfo:
        ai_service.resolve_model("gemini-99", "agy")
    assert excinfo.value.status_code == 400


# ------------------------------------------------------------ strip_followups
def test_strip_followups_removes_english_tail() -> None:
    text = (
        "## 정답\n정답: 3\n\n---\n\n"
        "**Follow-up Question:** 이 문제와 비슷한 유형을 더 풀어볼까요?"
    )
    cleaned = strip_followups(text)
    assert "정답: 3" in cleaned
    assert "Follow-up" not in cleaned
    assert not cleaned.endswith("-")


def test_strip_followups_removes_korean_tail() -> None:
    text = "풀이 본문입니다.\n\n꼬리 질문: 다른 예제도 볼까요?"
    cleaned = strip_followups(text)
    assert cleaned == "풀이 본문입니다."


def test_strip_followups_removes_offer_tail() -> None:
    text = "정답은 5입니다.\n상세한 풀이 과정도 함께 제공해드릴까요?"
    cleaned = strip_followups(text)
    assert cleaned == "정답은 5입니다."


def test_strip_followups_keeps_clean_text() -> None:
    text = "## 풀이\n1단계입니다.\n\n## 정답\n정답: ②"
    assert strip_followups(text) == text.strip()


# --------------------------------------------------------- 경로 주입 방지
def test_validated_image_path_rejects_outside_data_dir() -> None:
    with pytest.raises(ProviderError) as excinfo:
        agy_provider._validated_image_path(Path("C:/Windows/System32/evil.png"))
    assert excinfo.value.error_code == "path_forbidden"


def test_validated_image_path_allows_data_dir() -> None:
    inside = config.crops_dir() / "ok.png"
    resolved = agy_provider._validated_image_path(inside)
    assert resolved.is_relative_to(config.data_dir().resolve())


# ----------------------------------------------------------- parse_agy_output
def test_parse_agy_output_extracts_json_among_logs() -> None:
    raw = 'some log line\n{"status": "SUCCESS", "response": "ok"}\ntrailing'
    data = parse_agy_output(raw)
    assert data["status"] == "SUCCESS"


def test_parse_agy_output_empty_raises() -> None:
    with pytest.raises(ProviderError) as excinfo:
        parse_agy_output("   ")
    assert excinfo.value.error_code == "agy_empty"


# --------------------------------------------------------------- availability
def test_availability_missing() -> None:
    # conftest 가 find_agy 를 None 으로 고정해 둔다.
    detected = agy_provider.availability()
    assert detected["available"] is False
    assert detected["reason"] == "agy_missing"


def test_availability_ok(agy_enabled: Path) -> None:
    detected = agy_provider.availability()
    assert detected["available"] is True
    assert detected["reason"] == "ok"
    models = detected["models"]
    assert isinstance(models, list)
    assert models[0]["id"] == DEFAULT_MODEL
    assert models[0]["default"] is True


# ------------------------------------------------------------ resolve_provider
def test_auto_prefers_agy_when_available(
    agy_enabled: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from providers import subscription as subscription_provider

    monkeypatch.setattr(subscription_provider, "is_available", lambda: True)
    provider = ai_service.resolve_provider("auto", "sk-ant-test")
    assert isinstance(provider, AgyProvider)


def test_explicit_agy_unavailable_returns_409() -> None:
    # conftest 로 agy 미설치 상태.
    with pytest.raises(ApiError) as excinfo:
        ai_service.resolve_provider("agy", None)
    assert excinfo.value.status_code == 409
    assert excinfo.value.error_code == "agy_unavailable"


# --------------------------------------------------------------- GET /api/env
def test_env_reports_agy_provider(client: TestClient, agy_enabled: Path) -> None:
    body = client.get("/api/env").json()
    providers = body["providers"]
    assert providers["agy"]["available"] is True
    assert providers["agy"]["reason"] == "ok"
    agy_model_ids = [model["id"] for model in providers["agy"]["models"]]
    assert agy_model_ids == list(AGY_MODELS)
    assert body["default_provider"] == "agy"
    # 하위호환: 최상위 models/subscription 은 그대로 있어야 한다.
    assert [model["id"] for model in body["models"]] == [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
    ]
    # 구독/API 키 프로바이더는 Claude 모델 목록을 노출한다.
    assert providers["subscription"]["models"][0]["id"] == "claude-opus-5"
    assert providers["apikey"]["models"][0]["id"] == "claude-opus-5"


def test_env_default_provider_falls_back_when_agy_missing(client: TestClient) -> None:
    body = client.get("/api/env").json()
    assert body["providers"]["agy"]["available"] is False
    # agy 없음 → subscription 여부에 따라 subscription/apikey.
    assert body["default_provider"] in {"subscription", "apikey"}


# --------------------------------------------------- 전체 스트림(agy 실행은 스텁)
SUCCESS_JSON = (
    '{"conversation_id": "abc", "status": "SUCCESS", '
    '"response": "## 정답\\n정답: 3\\n\\n---\\nFollow-up Question: 더 풀어볼까요?", '
    '"duration_seconds": 10.6, '
    '"usage": {"input_tokens": 36314, "output_tokens": 120, '
    '"thinking_tokens": 40, "cache_read_tokens": 0, "total_tokens": 36474}}'
)


async def test_stream_parses_and_strips_followups(
    agy_enabled: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_run(self: AgyProvider, args: list[str], timeout: float) -> str:
        return SUCCESS_JSON

    monkeypatch.setattr(AgyProvider, "_run", fake_run)
    provider = AgyProvider()

    image_b64 = base64.b64encode(b"fake-png-bytes").decode("ascii")
    events = [
        event
        async for event in provider.solve_problem(
            no=1,
            mode="image",
            text="",
            image_b64=image_b64,
            model="gemini-3-flash",
            effort="medium",
            max_tokens=8000,
        )
    ]

    assert events[0]["type"] == "delta"
    done = events[-1]
    assert done["type"] == "done"
    assert "정답: 3" in done["text"]
    assert "Follow-up" not in done["text"]  # 꼬리말 제거됨
    # 쿼터 기반 → cost 는 항상 None, usage 는 agy 값 그대로.
    assert done["cost"] is None
    usage = done["usage"]
    assert usage is not None
    assert usage["input_tokens"] == 36314
    assert usage["total_tokens"] == 36474
    # 임시 이미지가 정리됐는지(디렉터리에 png 가 남지 않음).
    tmp_dir = config.data_dir() / "agy_tmp"
    assert not list(tmp_dir.glob("*.png"))


async def test_stream_error_status_raises(
    agy_enabled: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_run(self: AgyProvider, args: list[str], timeout: float) -> str:
        return '{"status": "ERROR", "error": "quota exceeded"}'

    monkeypatch.setattr(AgyProvider, "_run", fake_run)
    provider = AgyProvider()
    with pytest.raises(ProviderError) as excinfo:
        async for _ in provider.solve_problem(
            no=1,
            mode="text",
            text="1+1=?",
            image_b64=None,
            model="gemini-3-flash",
            effort="low",
            max_tokens=8000,
        ):
            pass
    assert excinfo.value.error_code == "agy_failed"
    assert "quota exceeded" in (excinfo.value.message + str(excinfo.value.hint))
