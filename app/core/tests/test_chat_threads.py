"""문항별 대화 스레드 테스트 (ARCHITECTURE 6-B). AI 는 스텁."""

from __future__ import annotations

import pytest
from conftest import StubProvider, parse_sse, upload_test_pdf
from fastapi.testclient import TestClient

import config


def _chat(
    client: TestClient, node_id: str, message: str, problem_no: int | None = None
) -> list[tuple[str, dict[str, object]]]:
    body: dict[str, object] = {"message": message}
    if problem_no is not None:
        body["problem_no"] = problem_no
    response = client.post(f"/api/files/{node_id}/chat", json=body)
    assert response.status_code == 200, response.text
    return parse_sse(response.text)


def test_threads_are_isolated_by_problem_no(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _chat(client, node_id, "5번 알려주세요", 5)

    five = client.get(f"/api/files/{node_id}/chat", params={"problem_no": 5}).json()
    assert [item["role"] for item in five["messages"]] == ["user", "assistant"]
    assert five["problem_no"] == 5

    six = client.get(f"/api/files/{node_id}/chat", params={"problem_no": 6}).json()
    assert six["messages"] == []
    assert client.get(f"/api/files/{node_id}/chat").json()["messages"] == []
    assert stub_provider.calls


def test_thread_history_not_mixed_into_other_thread(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _chat(client, node_id, "5번 질문", 5)
    _chat(client, node_id, "6번 질문", 6)

    # 6번 호출에는 5번 스레드 이력이 섞이지 않는다(= 새 user 턴 1개뿐).
    turns = stub_provider.calls[1]["turns"]
    assert len(turns) == 1
    assert turns[0].role == "user"


def test_thread_history_is_carried_over_within_thread(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _chat(client, node_id, "5번 질문", 5)
    _chat(client, node_id, "5번 추가 질문", 5)
    turns = stub_provider.calls[1]["turns"]
    assert [turn.role for turn in turns] == ["user", "assistant", "user"]


def test_threads_listing(client: TestClient, stub_provider: StubProvider) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _chat(client, node_id, "전역 질문")
    _chat(client, node_id, "5번 질문", 5)
    _chat(client, node_id, "5번 추가 질문", 5)

    threads = client.get(f"/api/files/{node_id}/chat/threads").json()["threads"]
    assert [thread["problem_no"] for thread in threads] == [None, 5]
    assert [thread["turns"] for thread in threads] == [2, 4]
    assert all(thread["updated_at"] for thread in threads)
    assert stub_provider.calls


def test_threads_listing_marks_only_used_thread(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _chat(client, node_id, "5번 질문", 5)
    threads = client.get(f"/api/files/{node_id}/chat/threads").json()["threads"]
    assert [(t["problem_no"], t["turns"]) for t in threads] == [(5, 2)]
    assert stub_provider.calls


def test_delete_one_thread_keeps_others(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _chat(client, node_id, "전역 질문")
    _chat(client, node_id, "5번 질문", 5)

    assert client.delete(
        f"/api/files/{node_id}/chat", params={"problem_no": 5}
    ).json() == {"ok": True}
    assert client.get(f"/api/files/{node_id}/chat", params={"problem_no": 5}).json()[
        "messages"
    ] == []
    global_messages = client.get(f"/api/files/{node_id}/chat").json()["messages"]
    assert len(global_messages) == 2
    assert stub_provider.calls


def test_history_truncation_is_signalled(
    client: TestClient,
    stub_provider: StubProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """이력 truncation(요약 아님)을 조용히 하지 않고 SSE/조회로 알린다."""
    monkeypatch.setattr(config, "CHAT_HISTORY_LIMIT", 2)
    node_id = upload_test_pdf(client)["node"]["id"]

    first = _chat(client, node_id, "1번째 질문", 5)
    done = dict(first[-1][1])
    assert done["history_truncated"] is False
    assert done["truncated_before"] == 0

    # 2번째 호출 시점의 저장된 이력은 2개(user+assistant) — 상한과 같으므로 안 잘린다.
    second = _chat(client, node_id, "2번째 질문", 5)
    assert dict(second[-1][1])["truncated_before"] == 0

    # 3번째 호출 시점의 이력은 4개 → 앞 2개가 **버려진다**(요약 아님).
    third = _chat(client, node_id, "3번째 질문", 5)
    done = dict(third[-1][1])
    assert done["history_truncated"] is True
    assert done["truncated_before"] == 2
    assert done["problem_no"] == 5

    # 컨텍스트에는 최근 2개 + 새 질문만 실렸다.
    turns = stub_provider.calls[2]["turns"]
    assert len(turns) == 3

    thread = client.get(f"/api/files/{node_id}/chat", params={"problem_no": 5}).json()
    # 조회는 전체를 돌려주되, 다음 호출에서 몇 개가 잘릴지 함께 알려준다.
    assert len(thread["messages"]) == 6
    assert thread["truncated_before"] == 4


def test_thread_endpoints_reject_note_node(client: TestClient) -> None:
    response = client.post("/api/notes", json={"name": "노트"})
    note_id = response.json()["node"]["id"]
    assert client.get(f"/api/files/{note_id}/chat").status_code == 400
    assert client.get(f"/api/files/{note_id}/chat/threads").status_code == 400


def test_problem_no_zero_rejected(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.get(f"/api/files/{node_id}/chat", params={"problem_no": 0})
    assert response.status_code == 422
