"""바이너리 다운로드용 단기 서명 토큰 테스트.

게이트를 통과했는지는 상태코드로 판정한다: 401 이면 미들웨어에 막힌 것이고,
404 면 라우트까지 도달한 것(= 통과)이다. 실제 파일은 만들지 않는다.
"""

from __future__ import annotations

import importlib
import string
from collections.abc import Iterator
from pathlib import Path
from typing import Final

import pytest
from fastapi.testclient import TestClient

import config
import download_token

PW = "download-token-test-pw"
NODE = "abc123def456"
RAW = f"/api/files/{NODE}/raw"
CROP = f"/api/files/{NODE}/problems/1/crop"
EXPORT = f"/api/files/{NODE}/export.docx"
OTHER_RAW = "/api/files/zzz999zzz999/raw"


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


def _issue(client: TestClient, path: str) -> str:
    resp = client.post(
        "/api/download-tokens",
        json={"path": path},
        headers={"X-Access-Password": PW},
    )
    assert resp.status_code == 200, resp.text
    token = resp.json()["token"]
    assert isinstance(token, str) and token
    return token


# ------------------------------------------------------------------ 발급
def test_issue_requires_header_auth(auth_client: TestClient) -> None:
    """토큰으로 토큰을 못 만들게, 발급은 헤더 인증만 받는다."""
    resp = auth_client.post("/api/download-tokens", json={"path": RAW})
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "unauthorized"


def test_issue_returns_scoped_token(auth_client: TestClient) -> None:
    resp = auth_client.post(
        "/api/download-tokens", json={"path": RAW}, headers={"X-Access-Password": PW}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["scope"] == f"/api/files/{NODE}"
    assert body["expires_in"] == download_token.TTL_SECONDS
    # 비밀번호가 토큰에 그대로 들어가면 고치는 의미가 없다.
    assert PW not in body["token"]
    assert body["token"].startswith("v1.")


def test_issue_rejects_non_binary_path(auth_client: TestClient) -> None:
    resp = auth_client.post(
        "/api/download-tokens",
        json={"path": f"/api/files/{NODE}/variants"},
        headers={"X-Access-Password": PW},
    )
    assert resp.status_code == 400
    assert resp.json()["error_code"] == "invalid_download_path"


def test_issue_rejects_path_outside_api(auth_client: TestClient) -> None:
    resp = auth_client.post(
        "/api/download-tokens",
        json={"path": "/static/secret.pdf"},
        headers={"X-Access-Password": PW},
    )
    assert resp.status_code == 422


def test_issue_accepts_path_with_query_string(auth_client: TestClient) -> None:
    """프론트가 완성된 URL 을 그대로 넘겨도 된다(쿼리는 서버가 뗀다)."""
    resp = auth_client.post(
        "/api/download-tokens",
        json={"path": f"{EXPORT}?include=full&body=text"},
        headers={"X-Access-Password": PW},
    )
    assert resp.status_code == 200
    assert resp.json()["scope"] == f"/api/files/{NODE}"


# ------------------------------------------------------------------ 검증
def test_valid_token_allows_binary_get(auth_client: TestClient) -> None:
    token = _issue(auth_client, RAW)
    assert auth_client.get(RAW).status_code == 401
    assert auth_client.get(f"{RAW}?token={token}").status_code == 404


def test_token_covers_other_assets_of_same_node(auth_client: TestClient) -> None:
    """범위는 노드 단위다. 시험지 하나를 열 때 크롭 수십 개를 다시 발급받지 않는다."""
    token = _issue(auth_client, RAW)
    for path in (CROP, EXPORT, f"/api/files/{NODE}/export.hwpx"):
        assert auth_client.get(f"{path}?token={token}").status_code == 404, path


def test_expired_token_rejected(auth_client: TestClient) -> None:
    expired = download_token.sign(f"/api/files/{NODE}", PW, ttl_seconds=-5)
    assert auth_client.get(f"{RAW}?token={expired}").status_code == 401


def test_extending_expiry_breaks_signature(auth_client: TestClient) -> None:
    """만료가 서명 입력에 들어가므로 숫자만 늘려도 통하지 않는다."""
    version, expires, signature = _issue(auth_client, RAW).split(".")
    forged = f"{version}.{int(expires) + 86400}.{signature}"
    assert auth_client.get(f"{RAW}?token={forged}").status_code == 401


def test_tampered_signature_rejected(auth_client: TestClient) -> None:
    token = _issue(auth_client, RAW)
    flipped = token[:-1] + ("A" if token[-1] != "A" else "B")
    assert auth_client.get(f"{RAW}?token={flipped}").status_code == 401


@pytest.mark.parametrize(
    "token",
    ["", "garbage", "v1.abc.def", "v2.99999999999.AAAA", "v1.9999999999", "v1..AAAA"],
)
def test_malformed_token_rejected(auth_client: TestClient, token: str) -> None:
    assert auth_client.get(f"{RAW}?token={token}").status_code == 401


# ------------------------------------------------- 이상한 문자 (500 회귀 방지)
# `secrets.compare_digest` 는 non-ASCII `str` 을 비교하면 TypeError 를 던진다.
# 게이트 미들웨어 안에서 터지면 인증 실패가 500 이 되고 로그가 오염되므로,
# 어떤 쓰레기 입력이 와도 조용히 401 이어야 한다.
_A43 = "A" * 43
_JUNK_TOKENS: Final[list[str]] = [
    f"v1.1999999999.{'한글서명'}",  # 서명부 한글
    "v1.1999999999.서명" + "A" * 39,  # 서명부 한글(길이 43)
    f"v1.1999999999.é{'A' * 42}",  # 서명부 라틴1 확장 (é)
    f"v1.1999999999.{_A43[:-1]}é",  # 서명 끝 한 글자만 é
    f"v1.1999999999.Ａ{'A' * 42}",  # 서명부 전각 A
    f"v1.1999999999.​{'A' * 42}",  # 서명부 제로폭 공백
    f"v1.１９９９９９９９９９.{_A43}",  # 전각 숫자
    f"v1.١٩٩٩٩٩٩٩٩٩.{_A43}",  # 아랍-인도 숫자
    f"v1.².{_A43}",  # 위첨자 2 (`\d` 는 놓치고 int() 는 터진다)
    f"v1.1999999999\n.{_A43}",  # 만료부 끝 개행 (`$` 가 눈감아 주는 자리)
    f"v1.1999999999.{_A43}\n",  # 서명부 끝 개행
    f"버전.1999999999.{_A43}",  # 버전부 한글
    f"v١.1999999999.{_A43}",  # 버전부 아랍-인도 숫자
    "한글토큰",  # 점이 없는 한글 덩어리
    f"v1.1999999999.{'한' * 43}",  # 서명부 전부 한글
]


@pytest.mark.parametrize("token", _JUNK_TOKENS)
def test_non_ascii_token_is_401_not_500(auth_client: TestClient, token: str) -> None:
    """실제 HTTP 표면에서 이상한 토큰이 500 이 아니라 401 이 되는지."""
    resp = auth_client.get(RAW, params={"token": token})
    assert resp.status_code == 401, f"{token!r} -> {resp.status_code}"
    assert resp.json()["error_code"] == "unauthorized"


@pytest.mark.parametrize("token", _JUNK_TOKENS)
def test_verify_never_raises_on_junk(token: str) -> None:
    """`verify()` 는 어떤 입력에도 예외 없이 bool 만 돌려준다."""
    assert download_token.verify(token, RAW, PW) is False


def test_verify_never_raises_on_mutated_valid_token() -> None:
    """유효 토큰의 모든 자리를 non-ASCII 로 바꿔 봐도 예외가 없어야 한다."""
    token = download_token.sign(f"/api/files/{NODE}", PW)
    for index in range(len(token)):
        for char in ("한", "é", " ", "​", "\ud800", "\n"):
            mutated = token[:index] + char + token[index + 1 :]
            assert download_token.verify(mutated, RAW, PW) is False


def test_signature_is_43_base64url_chars() -> None:
    """`_SIGNATURE_RE` 의 길이 43 이 실제 서명 길이와 맞는지 못박는다."""
    signature = download_token.sign(f"/api/files/{NODE}", PW).split(".")[2]
    assert len(signature) == 43
    assert set(signature) <= set(string.ascii_letters + string.digits + "-_")


def test_token_out_of_scope_rejected(auth_client: TestClient) -> None:
    """다른 노드의 파일은 열리면 안 된다."""
    token = _issue(auth_client, RAW)
    assert auth_client.get(f"{OTHER_RAW}?token={token}").status_code == 401


def test_token_query_ignored_on_json_route(auth_client: TestClient) -> None:
    """같은 범위라도 바이너리가 아닌 경로는 헤더 전용이다."""
    token = _issue(auth_client, RAW)
    assert auth_client.get(f"/api/files/{NODE}/variants?token={token}").status_code == 401
    assert auth_client.get(f"/api/tree?token={token}").status_code == 401


def test_token_query_ignored_for_non_get_method(auth_client: TestClient) -> None:
    token = _issue(auth_client, RAW)
    assert auth_client.post(f"{EXPORT}?token={token}").status_code == 401


def test_token_from_other_password_rejected() -> None:
    """서명키가 비밀번호에서 파생되므로 비밀번호를 바꾸면 기존 토큰이 죽는다."""
    scope = f"/api/files/{NODE}"
    token = download_token.sign(scope, "old-password")
    assert download_token.verify(token, RAW, "new-password") is False
    assert download_token.verify(token, RAW, "old-password") is True


# ------------------------------------------------------- 하위호환 / 게이트 오프
def test_access_query_still_works(auth_client: TestClient) -> None:
    """프론트 전환 전이라 `?access=` 를 지우면 앱이 깨진다."""
    assert auth_client.get(f"{RAW}?access={PW}").status_code == 404
    assert auth_client.get(f"{CROP}?access={PW}").status_code == 404


def test_invalid_token_falls_back_to_access_query(auth_client: TestClient) -> None:
    assert auth_client.get(f"{RAW}?token=garbage&access={PW}").status_code == 404


def test_header_auth_still_works(auth_client: TestClient) -> None:
    resp = auth_client.get("/api/tree", headers={"X-Access-Password": PW})
    assert resp.status_code == 200
    assert auth_client.get(RAW, headers={"X-Access-Password": PW}).status_code == 404


def test_gate_off_returns_null_token(open_client: TestClient) -> None:
    resp = open_client.post("/api/download-tokens", json={"path": RAW})
    assert resp.status_code == 200
    body = resp.json()
    assert body["token"] is None
    assert body["expires_in"] is None
    assert body["scope"] == f"/api/files/{NODE}"


def test_gate_off_allows_binary_get_without_query(open_client: TestClient) -> None:
    assert open_client.get(RAW).status_code == 404
    assert open_client.get(f"{RAW}?token=garbage").status_code == 404


# ------------------------------------------------------------------ 범위 계산
@pytest.mark.parametrize(
    ("path", "expected"),
    [
        (RAW, f"/api/files/{NODE}"),
        (CROP, f"/api/files/{NODE}"),
        ("/api/notes/n1/items/i2/crop", "/api/notes/n1"),
        ("/api/notes/n1/export.hwpx", "/api/notes/n1"),
        (f"{EXPORT}?include=full", f"/api/files/{NODE}"),
        ("/api/tree", None),
        ("/api/files", None),
        ("/api/files/", None),
        ("/api/jobs/abc/events", None),
        ("/api/files/../secret/raw", None),
        ("", None),
    ],
)
def test_scope_for(path: str, expected: str | None) -> None:
    assert download_token.scope_for(path) == expected
