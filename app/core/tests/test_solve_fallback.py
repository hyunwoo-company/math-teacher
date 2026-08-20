"""이미지 풀이 실패 → 저장된 판독본으로 재시도 (`ai_service.solve_events`).

사용자가 손으로 하던 우회를 자동화한 경로다: 크롭 이미지로는 풀이가 실패하는
시험지를 텍스트로 옮겨 붙이면 풀린다. 그래서 **이미 판독본이 있는 문항만**
텍스트로 한 번 더 시도한다(판독을 새로 돌리지 않는다 = 추가 판독 비용 0).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from conftest import StubProvider, create_job, upload_test_pdf, wait_job
from fastapi.testclient import TestClient

import ai_service
import storage
from providers.base import DeltaEvent, DoneEvent, ImagePart, ProviderError, ProviderEvent

TRANSCRIPT = r"다음 식의 값을 구하시오. \(x^{2}+1\) [3점]"


class ImageFailingProvider(StubProvider):
    """이미지가 들어오면 실패하고 텍스트면 성공하는 스텁."""

    def __init__(self, *, error_code: str = "empty_response") -> None:
        super().__init__()
        self.error_code = error_code

    async def stream(self, **kwargs: Any) -> AsyncIterator[ProviderEvent]:
        self.calls.append(kwargs)
        parts = [part for turn in kwargs["turns"] for part in turn.parts]
        if any(isinstance(part, ImagePart) for part in parts):
            raise ProviderError(self.error_code, "이미지로는 풀지 못했습니다", None)
        text = "텍스트로 푼 풀이"
        yield DeltaEvent(type="delta", text=text)
        yield DoneEvent(
            type="done",
            text=text,
            usage=None,
            cost=None,
            truncated=False,
            stop_reason="end_turn",
        )


def _use(monkeypatch: pytest.MonkeyPatch, provider: StubProvider) -> None:
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )


def _set_transcript(node_id: str, no: int, text: str) -> None:
    with storage.transaction() as conn:
        storage.set_transcript(
            conn,
            node_id=node_id,
            no=no,
            transcript=text,
            source=storage.TRANSCRIPT_AI,
            note=None,
        )


def test_image_failure_retries_with_saved_transcript(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """이미지로 실패해도 판독본이 있으면 텍스트로 다시 풀어 저장한다."""
    provider = ImageFailingProvider()
    _use(monkeypatch, provider)
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, TRANSCRIPT)

    job_id = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])[
        "job"
    ]["id"]
    final = wait_job(client, job_id)

    assert final["status"] == "done"
    assert final["done_count"] == 1  # 재시도해도 진행 단위는 하나다
    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["no"] for item in saved] == [1]
    assert saved[0]["solution"] == "텍스트로 푼 풀이"

    # 호출 2회: 이미지 1 + 텍스트 1. 두 번째 호출에 판독본이 실려야 한다.
    assert len(provider.calls) == 2
    last_parts = [part for turn in provider.calls[-1]["turns"] for part in turn.parts]
    assert not any(isinstance(part, ImagePart) for part in last_parts)
    assert TRANSCRIPT in "".join(getattr(part, "text", "") for part in last_parts)


def test_no_transcript_means_no_retry(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """판독본이 없으면 예전처럼 실패로 끝난다(추가 호출 없음)."""
    provider = ImageFailingProvider()
    _use(monkeypatch, provider)
    node_id = upload_test_pdf(client)["node"]["id"]

    job_id = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])[
        "job"
    ]["id"]
    final = wait_job(client, job_id)

    assert final["status"] == "done"
    assert len(provider.calls) == 1
    assert client.get(f"/api/files/{node_id}/solutions").json()["solutions"] == []


def test_fallback_stops_after_it_also_fails(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """폴백까지 실패하면 남은 문항은 폴백하지 않는다 (쿼터 보호).

    이미지도 텍스트도 실패한다는 것은 문항이 아니라 프로바이더 쪽 문제(쿼터
    소진·CLI 다운)라는 뜻이다. 그 상태에서 문항마다 두 번씩 부르면 안 된다.
    """

    # 이미지든 텍스트든 무조건 실패하는 스텁(쿼터 소진 상황).
    provider = StubProvider(fail=ProviderError("agy_failed", "쿼터 소진", None))
    _use(monkeypatch, provider)
    node_id = upload_test_pdf(client)["node"]["id"]
    for no in (1, 2, 3):
        _set_transcript(node_id, no, TRANSCRIPT)

    job_id = create_job(
        client, kind="solve", node_id=node_id, problem_numbers=[1, 2, 3]
    )["job"]["id"]
    final = wait_job(client, job_id)

    assert final["status"] == "done"
    assert final["done_count"] == 3
    # 1번만 두 번(이미지+텍스트), 2·3번은 한 번씩.
    assert len(provider.calls) == 4
