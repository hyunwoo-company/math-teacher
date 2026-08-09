"""작업 큐 (`/api/jobs`) 테스트.

이 스펙의 핵심은 하나다: **작업의 수명이 HTTP 연결과 무관하다.**
예전에는 응답 스트림이 곧 작업이라 브라우저가 끊으면 작업도 멈췄다.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from conftest import (
    StubProvider,
    create_job,
    parse_sse,
    upload_test_pdf,
    wait_job,
)
from fastapi.testclient import TestClient

import storage


def test_create_job_returns_immediately(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """작업 생성은 스트림을 기다리지 않고 바로 돌아온다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(
        client, kind="solve", node_id=node_id, problem_numbers=[1, 2], effort="low"
    )

    assert body["existing"] is False
    job = body["job"]
    assert job["kind"] == "solve"
    assert job["node_id"] == node_id
    assert job["total"] == 2
    assert job["status"] in ("queued", "running")
    # 배너에 쓸 이름 스냅샷이 들어 있다.
    assert job["node_name"]


def test_job_finishes_without_any_subscriber(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """**구독자가 하나도 없어도** 작업이 끝까지 돌고 결과가 저장된다.

    이 스펙의 존재 이유. 이벤트를 아무도 안 듣는 상태로 완료를 기다린다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1, 2])

    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert final["done_count"] == 2

    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["no"] for item in saved] == [1, 2]
    assert saved[0]["solution"] == "풀이 완료"


def test_job_events_emit_snapshot_first(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """구독하면 `snapshot` 을 먼저 받는다(늦게 붙어도 진행 상황을 안다)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])
    job_id = body["job"]["id"]

    response = client.get(f"/api/jobs/{job_id}/events")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    events = parse_sse(response.text)
    assert events[0][0] == "snapshot"
    snapshot = events[0][1]
    assert set(snapshot) == {
        "status",
        "total",
        "done_count",
        "current_no",
        "partial_text",
    }
    assert events[-1][0] == "end"


def test_job_survives_subscriber_disconnect(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """구독을 끊었다 다시 붙어도 작업은 계속된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    job_id = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1, 2, 3])[
        "job"
    ]["id"]

    # 한 번 붙었다 떨어진다(응답을 끝까지 읽고 닫는다).
    client.get(f"/api/jobs/{job_id}/events")
    # 다시 붙어도 끝난다.
    final = wait_job(client, job_id)

    assert final["status"] == "done"
    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["no"] for item in saved] == [1, 2, 3]


def test_jobs_run_sequentially(client: TestClient, stub_provider: StubProvider) -> None:
    """작업 2개를 넣으면 순차로 돈다(쿼터 보호·캐시 히트)."""
    first_id = upload_test_pdf(client)["node"]["id"]
    second_id = upload_test_pdf(client)["node"]["id"]

    job_a = create_job(client, kind="solve", node_id=first_id, problem_numbers=[1, 2])
    job_b = create_job(client, kind="solve", node_id=second_id, problem_numbers=[3])

    # 두 번째는 큐에서 기다린다.
    assert job_b["position"] >= 0

    wait_job(client, job_a["job"]["id"])
    wait_job(client, job_b["job"]["id"])

    assert client.get(f"/api/files/{first_id}/solutions").json()["solutions"]
    assert client.get(f"/api/files/{second_id}/solutions").json()["solutions"]


def test_duplicate_job_returns_existing(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """**같은 대상**을 이미 처리 중이면 새로 만들지 않는다(버튼 두 번 방지)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1, 2])
    second = create_job(client, kind="solve", node_id=node_id, problem_numbers=[2, 3])

    assert second["existing"] is True
    assert second["job"]["id"] == first["job"]["id"]


def test_different_targets_are_separate_jobs(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """같은 시험지라도 대상이 겹치지 않으면 별개 작업이다.

    시험지 단위로만 막으면 다른 문항 풀이나 다른 변형이 통째로 무시된다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])
    second = create_job(client, kind="solve", node_id=node_id, problem_numbers=[2])

    assert second["existing"] is False
    assert second["job"]["id"] != first["job"]["id"]

    wait_job(client, first["job"]["id"])
    wait_job(client, second["job"]["id"])
    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["no"] for item in saved] == [1, 2]


def test_different_variant_modes_are_separate_jobs(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """같은 문항이라도 변형 종류가 다르면 별개 작업이다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(client, kind="variant", node_id=node_id, no=1, modes=["number"])
    second = create_job(
        client, kind="variant", node_id=node_id, no=1, modes=["condition"]
    )

    assert second["existing"] is False
    wait_job(client, first["job"]["id"])
    wait_job(client, second["job"]["id"])
    assert len(stub_provider.calls) == 2


def test_already_solved_problems_are_excluded(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """이미 풀린 문항은 대상에서 빠지고, 남는 게 없으면 400 이다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    job_id = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])[
        "job"
    ]["id"]
    wait_job(client, job_id)

    response = client.post(
        "/api/jobs",
        json={"kind": "solve", "node_id": node_id, "problem_numbers": [1]},
    )
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "already_solved"
    assert "이미" in body["message"]


def test_force_reruns_solved_problems(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """`force` 면 이미 풀린 문항도 다시 푼다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])
    wait_job(client, first["job"]["id"])

    again = create_job(
        client, kind="solve", node_id=node_id, problem_numbers=[1], force=True
    )
    assert again["existing"] is False
    final = wait_job(client, again["job"]["id"])
    assert final["status"] == "done"


def test_cancel_queued_job(client: TestClient, stub_provider: StubProvider) -> None:
    """취소하면 `canceled` 로 끝난다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    job_id = create_job(client, kind="solve", node_id=node_id, problem_numbers=None)[
        "job"
    ]["id"]

    assert client.delete(f"/api/jobs/{job_id}").status_code == 200
    final = wait_job(client, job_id)
    assert final["status"] == "canceled"


def test_cancel_unknown_job_404(client: TestClient) -> None:
    assert client.delete("/api/jobs/nope").status_code == 404


def test_events_unknown_job_404(client: TestClient) -> None:
    assert client.get("/api/jobs/nope/events").status_code == 404


def test_variant_job_generates_each_mode(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """변형 작업은 요청한 종류 수만큼 생성한다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(
        client,
        kind="variant",
        node_id=node_id,
        no=1,
        modes=["number", "condition"],
    )
    assert body["job"]["total"] == 2

    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert final["done_count"] == 2
    assert len(stub_provider.calls) == 2


def test_variant_job_requires_no(client: TestClient, stub_provider: StubProvider) -> None:
    """변형 작업에 문항 번호가 없으면 400."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        "/api/jobs", json={"kind": "variant", "node_id": node_id, "modes": ["number"]}
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "no_required"


def test_job_error_does_not_stop_remaining(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """한 문항이 실패해도 다음 문항이 실행되고 작업은 끝난다."""
    import ai_service
    from providers.base import ProviderError, ProviderEvent

    calls: list[int] = []

    class FlakyProvider(StubProvider):
        async def stream(self, **kwargs: Any) -> AsyncIterator[ProviderEvent]:
            calls.append(1)
            if len(calls) == 1:
                raise ProviderError("stub_fail", "일부러 실패", None)
            async for event in super().stream(**kwargs):
                yield event

    provider = FlakyProvider()
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )

    client_node = upload_test_pdf(client)["node"]["id"]
    job_id = create_job(
        client, kind="solve", node_id=client_node, problem_numbers=[1, 2]
    )["job"]["id"]
    final = wait_job(client, job_id)

    assert final["status"] == "done"
    assert final["done_count"] == 2  # 실패도 진행 단위로 센다
    saved = client.get(f"/api/files/{client_node}/solutions").json()["solutions"]
    assert [item["no"] for item in saved] == [2]  # 성공한 것만 저장


def test_stale_jobs_marked_interrupted_on_startup(client: TestClient) -> None:
    """서버 시작 시 남아 있던 대기·실행 작업은 `interrupted` 가 된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    with storage.transaction() as conn:
        storage.insert_job(
            conn,
            job_id="stale-job",
            kind="solve",
            node_id=node_id,
            node_name="예전 시험지",
            targets=[1],
            params={},
            total=1,
        )
        storage.update_job(conn, "stale-job", status="running")

    with storage.transaction() as conn:
        count = storage.interrupt_unfinished_jobs(conn)
        record = storage.get_job(conn, "stale-job")

    assert count >= 1
    assert record is not None
    assert record["status"] == "interrupted"
