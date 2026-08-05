"""배포판 agy 전용 모드 테스트.

`MATH_TEACHER_AGY_ONLY=1` 이면 API 키·구독 provider 가 완전히 비활성화되어야
한다(과금 사고 방지). env 에서 숨겨지고, apikey/subscription 요청과 키 저장이
막힌다.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import config


@pytest.fixture
def agy_only_client(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[TestClient]:
    monkeypatch.setenv(config.DATA_DIR_ENV, str(tmp_path))
    monkeypatch.setenv(config.AGY_ONLY_ENV, "1")
    config.use_data_dir(tmp_path)
    import main

    importlib.reload(main)
    with TestClient(main.app) as client:
        yield client


def test_env_hides_apikey_and_subscription(agy_only_client: TestClient) -> None:
    body = agy_only_client.get("/api/env").json()
    assert body["providers"]["apikey"]["available"] is False
    assert body["providers"]["subscription"]["available"] is False
    assert body["api_key_set"] is False
    assert body["default_provider"] == "agy"


def test_apikey_save_blocked(agy_only_client: TestClient) -> None:
    resp = agy_only_client.post(
        "/api/settings/apikey", json={"key": "sk-should-be-blocked-123456"}
    )
    assert resp.status_code == 409
    assert resp.json()["error_code"] == "provider_disabled"
