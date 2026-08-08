"""`POST /api/files/{id}/problems/{no}/variant` (동일 유형 변형 문제 생성).

AI 호출은 스텁으로 대체한다(agy 실제 호출 없음).
"""

from __future__ import annotations

import pytest
from conftest import StubProvider, parse_sse, upload_test_pdf
from fastapi.testclient import TestClient

import ai_service
import prompts
from providers.base import ImagePart, ProviderError, TextPart

VARIANT_KINDS = ("number", "condition", "number_condition")


@pytest.mark.parametrize("kind", VARIANT_KINDS)
def test_variant_stream_ok_for_each_mode(
    client: TestClient, stub_provider: StubProvider, kind: str
) -> None:
    """각 변형 모드로 요청하면 200 + delta/done SSE 스트림이 나온다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/1/variant",
        json={"mode": kind, "provider": "auto", "effort": "low"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")

    events = parse_sse(response.text)
    names = [name for name, _ in events]
    assert names == ["delta", "delta", "done"]

    done = events[-1][1]
    assert done["no"] == 1
    assert done["solution"] == "풀이 완료"
    assert done["usage"] is None
    assert done["cost"] is None
    assert done["truncated"] is False


def test_variant_uses_variant_prompt_and_kind_guide(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """변형 전용 시스템 프롬프트와 선택한 kind 안내가 프로바이더로 전달된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/1/variant",
        json={"mode": "condition"},
    )
    assert response.status_code == 200, response.text

    call = stub_provider.calls[0]
    assert call["system"] == prompts.VARIANT_SYSTEM_PROMPT
    parts = call["turns"][-1].parts
    texts = [part.text for part in parts if isinstance(part, TextPart)]
    # condition 안내 문구가 지시문에 실려야 한다.
    assert any("조건·설정·상황" in text for text in texts)
    # 원본 문항이 이미지 모드이므로 크롭 이미지가 첨부된다(solve 와 동일 경로).
    assert any(isinstance(part, ImagePart) for part in parts)


def test_variant_does_not_save_solution(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """v1 은 생성·스트리밍만 한다. 풀이/문항 상태를 저장하지 않는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/1/variant",
        json={"mode": "number"},
    )
    assert response.status_code == 200, response.text

    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert saved == []
    detail = client.get(f"/api/files/{node_id}").json()
    assert all(problem["has_solution"] is False for problem in detail["problems"])


def test_variant_invalid_mode_422(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """mode 값이 셋 중 하나가 아니면 422."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/1/variant",
        json={"mode": "everything"},
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "invalid_request"


def test_variant_missing_mode_422(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """mode 는 필수 필드다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/1/variant", json={}
    )
    assert response.status_code == 422


def test_variant_unknown_problem_404(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """추출되지 않은 문항 번호는 404."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/999/variant",
        json={"mode": "number"},
    )
    assert response.status_code == 404
    assert response.json()["error_code"] == "not_found"


def test_variant_missing_file_404(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """없는 파일이면 404."""
    response = client.post(
        "/api/files/nonexistent/problems/1/variant",
        json={"mode": "number"},
    )
    assert response.status_code == 404


def test_variant_problem_no_zero_rejected(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """경로의 문항 번호는 1 이상이어야 한다(422)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/0/variant",
        json={"mode": "number"},
    )
    assert response.status_code == 422


def test_variant_provider_error_becomes_error_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """프로바이더 실패는 error 이벤트로 흘리고, 저장은 하지 않는다."""
    provider = StubProvider(fail=ProviderError("boom", "생성이 실패했습니다.", "힌트"))
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/problems/1/variant",
        json={"mode": "number"},
    )
    assert response.status_code == 200, response.text
    events = dict(parse_sse(response.text))
    assert events["error"]["error_code"] == "boom"
    assert events["error"]["message"] == "생성이 실패했습니다."
    assert client.get(f"/api/files/{node_id}/solutions").json()["solutions"] == []
