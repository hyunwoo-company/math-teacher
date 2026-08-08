"""전역(파일 무관) 자유 대화 테스트. AI 는 스텁."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from conftest import StubProvider, parse_sse, upload_test_pdf
from fastapi.testclient import TestClient

import prompts
import storage


def _create(client: TestClient, title: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {} if title is None else {"title": title}
    response = client.post("/api/conversations", json=body)
    assert response.status_code == 201, response.text
    payload: dict[str, Any] = response.json()
    return payload


def _chat(
    client: TestClient,
    conversation_id: str,
    message: str,
    file_id: str | None = None,
    problem_no: int | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    body: dict[str, Any] = {"message": message}
    if file_id is not None:
        body["file_id"] = file_id
    if problem_no is not None:
        body["problem_no"] = problem_no
    response = client.post(f"/api/conversations/{conversation_id}/chat", json=body)
    assert response.status_code == 200, response.text
    return parse_sse(response.text)


def _set_updated_at(conversation_id: str, stamp: str) -> None:
    with storage.transaction() as conn:
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (stamp, conversation_id),
        )


def test_create_uses_default_and_custom_title(client: TestClient) -> None:
    default = _create(client)
    assert default["title"] == "새 대화"
    assert default["preview"] is None
    assert default["created_at"] == default["updated_at"]

    custom = _create(client, "미적분 질문 모음")
    assert custom["title"] == "미적분 질문 모음"
    assert custom["id"] != default["id"]


def test_list_orders_by_updated_at_desc(client: TestClient) -> None:
    older = _create(client, "오래된 대화")["id"]
    newer = _create(client, "최근 대화")["id"]
    # updated_at 을 명시적으로 벌려 정렬을 결정적으로 만든다.
    _set_updated_at(older, "2020-01-01T00:00:00+09:00")
    _set_updated_at(newer, "2026-01-01T00:00:00+09:00")

    conversations = client.get("/api/conversations").json()["conversations"]
    assert [c["id"] for c in conversations] == [newer, older]


def test_rename(client: TestClient) -> None:
    conversation_id = _create(client)["id"]
    response = client.patch(
        f"/api/conversations/{conversation_id}", json={"title": "새 이름"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["title"] == "새 이름"

    listed = client.get("/api/conversations").json()["conversations"]
    assert listed[0]["title"] == "새 이름"


def test_delete_cascades_messages(
    client: TestClient, stub_provider: StubProvider
) -> None:
    conversation_id = _create(client)["id"]
    _chat(client, conversation_id, "안녕하세요")

    # 메시지가 실제로 저장됐는지 확인.
    with storage.transaction() as conn:
        assert storage.count_conversation_messages(conn, conversation_id) == 2

    assert client.delete(f"/api/conversations/{conversation_id}").json() == {
        "ok": True
    }

    # 대화도 메시지도 사라진다.
    assert client.get("/api/conversations").json()["conversations"] == []
    with storage.transaction() as conn:
        assert storage.count_conversation_messages(conn, conversation_id) == 0
    # 이후 조회/삭제는 404.
    assert (
        client.get(f"/api/conversations/{conversation_id}/messages").status_code
        == 404
    )


def test_messages_saved_and_retrieved_in_order(
    client: TestClient, stub_provider: StubProvider
) -> None:
    conversation_id = _create(client)["id"]
    events = _chat(client, conversation_id, "첫 질문")
    assert events[-1][0] == "done"
    assert events[-1][1]["content"] == "풀이 완료"
    assert events[-1][1]["file_id"] is None
    assert events[-1][1]["problem_no"] is None

    messages = client.get(
        f"/api/conversations/{conversation_id}/messages"
    ).json()["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[0]["content"] == "첫 질문"
    assert messages[1]["content"] == "풀이 완료"
    assert stub_provider.calls


def test_chat_sets_auto_title_and_touches_updated_at(
    client: TestClient, stub_provider: StubProvider
) -> None:
    conversation_id = _create(client)["id"]
    _set_updated_at(conversation_id, "2000-01-01T00:00:00+09:00")

    _chat(client, conversation_id, "이차방정식 판별식이 뭐예요?")

    conversation = client.get("/api/conversations").json()["conversations"][0]
    # 첫 사용자 메시지 앞부분으로 자동 제목이 붙는다.
    assert conversation["title"] == "이차방정식 판별식이 뭐예요?"
    # updated_at 은 대화 활동으로 갱신된다(과거 값보다 최신).
    assert conversation["updated_at"] > "2000-01-01T00:00:00+09:00"
    assert conversation["preview"] == "풀이 완료"


def test_auto_title_only_on_first_message(
    client: TestClient, stub_provider: StubProvider
) -> None:
    conversation_id = _create(client)["id"]
    _chat(client, conversation_id, "첫 질문 제목이 됩니다")
    _chat(client, conversation_id, "두 번째 질문은 제목을 안 바꾼다")

    conversation = client.get("/api/conversations").json()["conversations"][0]
    assert conversation["title"] == "첫 질문 제목이 됩니다"


def test_renamed_title_is_not_overwritten_by_auto_title(
    client: TestClient, stub_provider: StubProvider
) -> None:
    conversation_id = _create(client, "내가 정한 제목")["id"]
    _chat(client, conversation_id, "이 메시지로 제목이 바뀌면 안 된다")
    conversation = client.get("/api/conversations").json()["conversations"][0]
    assert conversation["title"] == "내가 정한 제목"


def test_chat_with_file_attaches_problem_context(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    conversation_id = _create(client)["id"]

    _chat(client, conversation_id, "이 문제 풀어주세요", file_id=node_id, problem_no=5)

    # 스텁에 전달된 마지막 턴에 문항 컨텍스트가 실렸는지.
    turns = stub_provider.calls[-1]["turns"]
    last = turns[-1]
    assert last.role == "user"
    texts = [getattr(part, "text", "") for part in last.parts]
    assert any("컨텍스트" in text for text in texts)
    assert any("5번 문항" in text for text in texts)

    # 저장된 사용자 메시지에 file_id/problem_no 가 남는다.
    messages = client.get(
        f"/api/conversations/{conversation_id}/messages"
    ).json()["messages"]
    assert messages[0]["file_id"] == node_id
    assert messages[0]["problem_no"] == 5

    # 문항이 첨부됐으므로 풀이 스킬(SOLVE_SYSTEM_PROMPT)이 적용된다.
    assert stub_provider.calls[-1]["system"] == prompts.SOLVE_SYSTEM_PROMPT


def test_chat_with_file_but_no_problem_uses_chat_prompt(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """파일만 첨부(문항 미지정)한 대화는 풀이 스킬을 쓰지 않는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    conversation_id = _create(client)["id"]

    _chat(client, conversation_id, "이 시험지 어때요?", file_id=node_id)

    assert stub_provider.calls[-1]["system"] == prompts.CHAT_SYSTEM_PROMPT


def test_free_chat_uses_chat_prompt(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """파일 무관 자유 대화는 기존대로 채팅 프롬프트를 쓴다."""
    conversation_id = _create(client)["id"]

    _chat(client, conversation_id, "안녕하세요")

    assert stub_provider.calls[-1]["system"] == prompts.CHAT_SYSTEM_PROMPT


def test_chat_with_missing_problem_rejected(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    conversation_id = _create(client)["id"]
    response = client.post(
        f"/api/conversations/{conversation_id}/chat",
        json={"message": "없는 문항", "file_id": node_id, "problem_no": 99999},
    )
    assert response.status_code == 400, response.text


def test_missing_conversation_returns_404(client: TestClient) -> None:
    assert client.get("/api/conversations/nope/messages").status_code == 404
    assert (
        client.patch("/api/conversations/nope", json={"title": "x"}).status_code
        == 404
    )
    assert client.delete("/api/conversations/nope").status_code == 404
    assert (
        client.post(
            "/api/conversations/nope/chat", json={"message": "안녕"}
        ).status_code
        == 404
    )


def test_usage_summary_includes_conversation_usage(client: TestClient) -> None:
    conversation_id = _create(client)["id"]
    recent = (datetime.now(storage.KST) - timedelta(hours=1)).isoformat(
        timespec="seconds"
    )
    with storage.transaction() as conn:
        conn.execute(
            "INSERT INTO conversation_messages"
            " (id, conversation_id, role, content, file_id, problem_no,"
            "  usage_json, cost_json, created_at)"
            " VALUES (?, ?, 'assistant', ?, NULL, NULL, ?, NULL, ?)",
            (
                storage.new_id(),
                conversation_id,
                "답변",
                json.dumps({"total_tokens": 42}),
                recent,
            ),
        )

    windows = client.get("/api/usage/summary").json()["windows"]
    assert windows["total"] == {"tokens": 42, "calls": 1}
    assert windows["last_24h"] == {"tokens": 42, "calls": 1}
