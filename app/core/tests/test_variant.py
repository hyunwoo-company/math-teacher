"""변형 문제 생성 (`POST /api/jobs` 의 `kind="variant"`).

AI 호출은 스텁으로 대체한다(agy 실제 호출 없음).

풀이와 마찬가지로 변형도 작업 큐로 들어간다. 예전 전용 라우트
(`POST /api/files/{id}/problems/{no}/variant`)는 응답 스트림이 곧 작업이라
브라우저가 끊으면 생성도 멈춰서 없앴다.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence

import pytest
from conftest import StubProvider, create_job, upload_test_pdf, wait_job
from fastapi.testclient import TestClient

import ai_service
import prompts
import storage
from providers.base import (
    DoneEvent,
    Effort,
    ImagePart,
    ProviderError,
    ProviderEvent,
    TextPart,
    Turn,
)

VARIANT_KINDS = ("number", "condition", "number_condition")


@pytest.mark.parametrize("kind", VARIANT_KINDS)
def test_variant_job_ok_for_each_mode(
    client: TestClient, stub_provider: StubProvider, kind: str
) -> None:
    """각 변형 모드로 작업을 걸면 정상 완료된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(
        client,
        kind="variant",
        node_id=node_id,
        no=1,
        modes=[kind],
        provider="auto",
        effort="low",
    )
    assert body["job"]["total"] == 1

    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert final["done_count"] == 1
    assert len(stub_provider.calls) == 1


def test_variant_uses_variant_prompt_and_kind_guide(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """변형 전용 시스템 프롬프트와 선택한 kind 안내가 프로바이더로 전달된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(
        client, kind="variant", node_id=node_id, no=1, modes=["condition"]
    )
    wait_job(client, body["job"]["id"])

    call = stub_provider.calls[0]
    assert call["system"] == prompts.VARIANT_SYSTEM_PROMPT
    parts = call["turns"][-1].parts
    texts = [part.text for part in parts if isinstance(part, TextPart)]
    # condition 안내 문구가 지시문에 실려야 한다.
    assert any("조건·설정·상황" in text for text in texts)
    # 원본 문항이 이미지 모드이므로 크롭 이미지가 첨부된다(solve 와 동일 경로).
    assert any(isinstance(part, ImagePart) for part in parts)


def test_variant_does_not_save_as_solution(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """변형 결과를 풀이(solutions)로 저장하지 않는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(client, kind="variant", node_id=node_id, no=1, modes=["number"])
    wait_job(client, body["job"]["id"])

    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert saved == []
    detail = client.get(f"/api/files/{node_id}").json()
    assert all(problem["has_solution"] is False for problem in detail["problems"])


def test_variant_multiple_modes_in_one_job(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """한 작업에 여러 변형 종류를 넣으면 순차로 만든다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(
        client,
        kind="variant",
        node_id=node_id,
        no=1,
        modes=list(VARIANT_KINDS),
    )
    assert body["job"]["total"] == 3

    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert len(stub_provider.calls) == 3


def test_variant_invalid_mode_422(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """mode 값이 셋 중 하나가 아니면 422."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        "/api/jobs",
        json={
            "kind": "variant",
            "node_id": node_id,
            "no": 1,
            "modes": ["everything"],
        },
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "invalid_request"


def test_variant_unknown_problem_404(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """추출되지 않은 문항 번호는 404."""
    response = client.post(
        "/api/jobs",
        json={
            "kind": "variant",
            "node_id": upload_test_pdf(client)["node"]["id"],
            "no": 999,
            "modes": ["number"],
        },
    )
    assert response.status_code == 404
    assert response.json()["error_code"] == "not_found"


def test_variant_missing_file_404(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """없는 파일이면 404."""
    response = client.post(
        "/api/jobs",
        json={
            "kind": "variant",
            "node_id": "nonexistent",
            "no": 1,
            "modes": ["number"],
        },
    )
    assert response.status_code == 404


def test_variant_provider_error_finishes_job(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """프로바이더가 실패해도 작업은 끝나고, 풀이로 저장되지 않는다."""
    provider = StubProvider(fail=ProviderError("boom", "생성이 실패했습니다.", "힌트"))
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(client, kind="variant", node_id=node_id, no=1, modes=["number"])

    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert client.get(f"/api/files/{node_id}/solutions").json()["solutions"] == []
    # 실패했으므로 변형도 남지 않는다.
    assert client.get(f"/api/files/{node_id}/variants").json()["variants"] == []


# ------------------------------------------------------- 저장 / 조회
class TextStubProvider(StubProvider):
    """지정한 텍스트를 done 으로 흘리는 스텁(덮어쓰기 검증용)."""

    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text

    async def stream(
        self,
        *,
        system: str,
        turns: Sequence[Turn],
        model: str,
        effort: Effort,
        max_tokens: int,
    ) -> AsyncIterator[ProviderEvent]:
        self.calls.append({"system": system, "turns": list(turns), "model": model})
        yield DoneEvent(
            type="done",
            text=self.text,
            usage=None,
            cost=None,
            truncated=False,
            stop_reason="end_turn",
        )


def _use_provider(monkeypatch: pytest.MonkeyPatch, provider: StubProvider) -> None:
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )


def test_variant_is_saved_and_listed(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """변형이 완료되면 DB 에 저장되고 조회 API 로 돌아온다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(client, kind="variant", node_id=node_id, no=1, modes=["number"])
    wait_job(client, body["job"]["id"])

    saved = client.get(f"/api/files/{node_id}/variants").json()["variants"]
    assert len(saved) == 1
    assert saved[0]["no"] == 1
    assert saved[0]["mode"] == "number"
    assert saved[0]["text"] == "풀이 완료"
    assert saved[0]["created_at"]


def test_variant_regeneration_overwrites_same_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """같은 (시험지, 문항, 종류)를 다시 만들면 덮어쓴다(이력을 쌓지 않는다)."""
    _use_provider(monkeypatch, TextStubProvider("## 문제\n첫 번째 변형"))
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(client, kind="variant", node_id=node_id, no=1, modes=["number"])
    wait_job(client, first["job"]["id"])

    _use_provider(monkeypatch, TextStubProvider("## 문제\n두 번째 변형"))
    second = create_job(
        client, kind="variant", node_id=node_id, no=1, modes=["number"], force=True
    )
    wait_job(client, second["job"]["id"])

    saved = client.get(f"/api/files/{node_id}/variants").json()["variants"]
    assert len(saved) == 1
    assert saved[0]["text"] == "## 문제\n두 번째 변형"


def test_variants_are_listed_by_no_then_mode(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """조회 순서는 문항 번호 → 변형 종류(프론트 탭 순서)다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(
        client,
        kind="variant",
        node_id=node_id,
        no=2,
        modes=["number_condition", "number", "condition"],
    )
    wait_job(client, body["job"]["id"])

    saved = client.get(f"/api/files/{node_id}/variants").json()["variants"]
    assert [item["mode"] for item in saved] == [
        "number",
        "condition",
        "number_condition",
    ]
    assert all(item["no"] == 2 for item in saved)


def test_variants_of_unknown_file_404(client: TestClient) -> None:
    assert client.get("/api/files/does-not-exist/variants").status_code == 404


def test_variants_are_deleted_with_the_node(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """시험지를 지우면 변형도 함께 지워진다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(client, kind="variant", node_id=node_id, no=1, modes=["number"])
    wait_job(client, body["job"]["id"])
    assert client.delete(f"/api/nodes/{node_id}").status_code == 200

    with storage.transaction() as conn:
        assert storage.list_variants(conn, node_id) == []
