"""접속 비밀번호 게이트 테스트.

로컬(비번 미설정)에서는 인증이 비활성이어야 하고, 배포(비번 설정)에서는
`/api/health`·`/api/env`·`/api/login` 을 뺀 모든 `/api/*` 가 헤더를 요구한다.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import config

PW = "unit-test-pw-9999"


def _client(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *, password: str | None
) -> TestClient:
    monkeypatch.setenv(config.DATA_DIR_ENV, str(tmp_path))
    if password is None:
        monkeypatch.delenv(config.ACCESS_PASSWORD_ENV, raising=False)
    else:
        monkeypatch.setenv(config.ACCESS_PASSWORD_ENV, password)
    config.use_data_dir(tmp_path)
    import main

    importlib.reload(main)
    return TestClient(main.app)


@pytest.fixture
def auth_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[TestClient]:
    with _client(monkeypatch, tmp_path, password=PW) as client:
        yield client


@pytest.fixture
def open_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[TestClient]:
    with _client(monkeypatch, tmp_path, password=None) as client:
        yield client


def test_env_reports_auth_required_when_password_set(auth_client: TestClient) -> None:
    body = auth_client.get("/api/env").json()
    assert body["auth_required"] is True


def test_env_and_health_are_exempt(auth_client: TestClient) -> None:
    assert auth_client.get("/api/env").status_code == 200
    assert auth_client.get("/api/health").status_code == 200


def test_protected_route_requires_password(auth_client: TestClient) -> None:
    resp = auth_client.get("/api/tree")
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "unauthorized"


def test_wrong_password_rejected(auth_client: TestClient) -> None:
    resp = auth_client.get("/api/tree", headers={"X-Access-Password": "wrong"})
    assert resp.status_code == 401


def test_correct_password_allows(auth_client: TestClient) -> None:
    resp = auth_client.get("/api/tree", headers={"X-Access-Password": PW})
    assert resp.status_code == 200


def test_login_validates_password(auth_client: TestClient) -> None:
    assert auth_client.post("/api/login", json={"password": PW}).status_code == 200
    assert auth_client.post("/api/login", json={"password": "nope"}).status_code == 401


def test_binary_assets_allow_access_query(auth_client: TestClient) -> None:
    """헤더를 못 붙이는 바이너리 GET 만 `?access=` 쿼리 인증을 허용한다.

    401(게이트에 막힘)이 아니라 404(라우트까지 도달)면 미들웨어를 통과한 것이다.
    `.hwpx` 를 빠뜨리면 배포 환경에서 한글 내보내기가 401 로 막힌다.
    """
    for path in (
        "/api/files/nope/raw",
        "/api/files/nope/problems/1/crop",
        "/api/files/nope/export.docx",
        "/api/files/nope/export.hwpx",
        "/api/files/nope/variants/export.docx",
        "/api/files/nope/variants/export.hwpx",
        "/api/notes/nope/export.docx",
        "/api/notes/nope/export.hwpx",
    ):
        assert auth_client.get(path).status_code == 401, path
        assert auth_client.get(f"{path}?access={PW}").status_code == 404, path


def test_access_query_is_not_allowed_for_json_routes(auth_client: TestClient) -> None:
    """일반 JSON 라우트는 쿼리 인증을 허용하지 않는다(헤더 전용)."""
    assert auth_client.get(f"/api/files/nope/variants?access={PW}").status_code == 401
    assert auth_client.get(f"/api/tree?access={PW}").status_code == 401


def test_local_mode_disables_auth(open_client: TestClient) -> None:
    # 비번 미설정: auth_required=false, 보호 라우트도 헤더 없이 통과.
    assert open_client.get("/api/env").json()["auth_required"] is False
    assert open_client.get("/api/tree").status_code == 200
    # 로컬에서는 로그인도 항상 성공.
    resp = open_client.post("/api/login", json={"password": "anything"})
    assert resp.status_code == 200
