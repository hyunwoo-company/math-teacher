"""프로바이더 선택 로직 + SSE 스트리밍 테스트 (AI 호출은 스텁)."""

from __future__ import annotations

import httpx
import pytest
from conftest import StubProvider, parse_sse, upload_test_pdf
from fastapi.testclient import TestClient

import ai_service
import config
import main
import prompts
from errors import ApiError
from providers import subscription as subscription_provider
from providers.apikey import ApiKeyProvider
from providers.base import ImagePart, Provider, ProviderError, TextPart, Turn
from providers.subscription import SubscriptionProvider, _prompt_message


# ------------------------------------------------------------- 선택 로직
class FakeSubscriptionProvider(StubProvider):
    """구독 프로바이더 자리에 끼워 넣는 가짜."""

    name = "fake-subscription"


def test_auto_prefers_subscription(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subscription_provider, "is_available", lambda: True)
    monkeypatch.setattr(
        subscription_provider, "SubscriptionProvider", FakeSubscriptionProvider
    )
    assert isinstance(
        ai_service.resolve_provider("auto", "sk-ant-test"), FakeSubscriptionProvider
    )


def test_auto_falls_back_to_apikey(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subscription_provider, "is_available", lambda: False)
    provider = ai_service.resolve_provider("auto", "sk-ant-test")
    assert isinstance(provider, ApiKeyProvider)


def test_auto_without_anything_returns_409(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subscription_provider, "is_available", lambda: False)
    with pytest.raises(ApiError) as excinfo:
        ai_service.resolve_provider("auto", None)
    assert excinfo.value.status_code == 409
    assert excinfo.value.error_code == "no_provider"
    assert "AI 연결" in excinfo.value.message


def test_explicit_subscription_unavailable_returns_409(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(subscription_provider, "is_available", lambda: False)
    with pytest.raises(ApiError) as excinfo:
        ai_service.resolve_provider("subscription", "sk-ant-test")
    assert excinfo.value.status_code == 409
    assert excinfo.value.error_code == "subscription_unavailable"


def test_explicit_apikey_without_key_returns_409() -> None:
    with pytest.raises(ApiError) as excinfo:
        ai_service.resolve_provider("apikey", None)
    assert excinfo.value.status_code == 409
    assert excinfo.value.error_code == "no_api_key"


def test_subscription_unavailable_in_web_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(config.DEPLOY_MODE_ENV, "web")
    assert subscription_provider.is_available() is False


def test_env_reports_subscription(client: TestClient) -> None:
    body = client.get("/api/env").json()
    assert body["mode"] == "desktop"
    assert set(body["subscription"]) == {"available", "cli_path", "reason"}
    # reason 은 ARCHITECTURE 5항의 고정 코드값 중 하나여야 한다.
    assert body["subscription"]["reason"] in {
        "ok",
        "cli_missing",
        "not_logged_in",
        "sdk_missing",
        "web_mode",
        "disabled",
    }
    assert body["api_key_set"] is False
    assert [model["id"] for model in body["models"]] == [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
    ]
    assert body["usd_krw"] > 0


def test_api_key_save_and_delete(client: TestClient) -> None:
    assert client.post("/api/settings/apikey", json={"key": "sk-ant-abc123"}).json() == {
        "ok": True
    }
    assert client.get("/api/env").json()["api_key_set"] is True
    assert client.delete("/api/settings/apikey").json() == {"ok": True}
    assert client.get("/api/env").json()["api_key_set"] is False


# ------------------------------------------------------------ 이미지 지원
class NoImageProvider(StubProvider):
    supports_images = False


async def test_provider_without_image_support_raises() -> None:
    provider: Provider = NoImageProvider()
    with pytest.raises(ProviderError) as excinfo:
        async for _ in provider.solve_problem(
            no=1,
            mode="image",
            text="",
            image_b64="AAAA",
            model="claude-opus-5",
            effort="low",
            max_tokens=100,
        ):
            pass
    assert excinfo.value.error_code == "unsupported"


async def test_solve_requires_crop_for_image_mode() -> None:
    provider: Provider = StubProvider()
    with pytest.raises(ProviderError) as excinfo:
        async for _ in provider.solve_problem(
            no=3,
            mode="image",
            text="",
            image_b64=None,
            model="claude-opus-5",
            effort="low",
            max_tokens=100,
        ):
            pass
    assert excinfo.value.error_code == "crop_missing"


def test_subscription_prompt_message_carries_image_and_history() -> None:
    turns = [
        Turn(role="user", parts=(TextPart(text="첫 질문"),)),
        Turn(role="assistant", parts=(TextPart(text="첫 답변"),)),
        Turn(
            role="user",
            parts=(ImagePart(b64="QUJD"), TextPart(text="이 문제 알려주세요")),
        ),
    ]
    message = _prompt_message(turns)
    content = message["message"]["content"]
    assert message["type"] == "user"
    assert content[0]["type"] == "image"
    assert content[0]["source"]["data"] == "QUJD"
    assert "첫 질문" in content[-1]["text"]
    assert "이 문제 알려주세요" in content[-1]["text"]


def test_subscription_provider_supports_images() -> None:
    # 실측으로 확인된 사실이므로 계약으로 고정한다.
    assert SubscriptionProvider.supports_images is True


# ---------------------------------------------------------------- SSE
def test_solve_stream_events(client: TestClient, stub_provider: StubProvider) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/solve",
        json={"problem_numbers": [1, 2], "provider": "auto", "effort": "low"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    events = parse_sse(response.text)
    names = [name for name, _ in events]
    assert names[0] == "start"
    assert names[-1] == "end"
    assert events[0][1] == {"total": 2}
    assert ("problem", {"no": 1, "status": "running"}) in events

    done = [data for name, data in events if name == "done"]
    assert [item["no"] for item in done] == [1, 2]
    assert done[0]["solution"] == "풀이 완료"
    assert done[0]["usage"] is None
    assert done[0]["cost"] is None
    assert done[0]["truncated"] is False

    end_data = events[-1][1]
    assert end_data == {"total_usage": None, "total_cost": None}

    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["no"] for item in saved] == [1, 2]
    assert saved[0]["solution"] == "풀이 완료"

    detail = client.get(f"/api/files/{node_id}").json()
    assert detail["problems"][0]["has_solution"] is True


def test_solve_all_problems_when_numbers_null(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/solve",
        json={"problem_numbers": None, "provider": "auto"},
    )
    events = parse_sse(response.text)
    assert events[0][1] == {"total": 22}
    assert len(stub_provider.calls) == 22


def test_solve_reports_usage_and_cost_totals(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = StubProvider(
        usage={"input_tokens": 100, "output_tokens": 50},
        cost={"total_usd": 0.001},
    )
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/solve",
        json={"problem_numbers": [1, 2], "provider": "auto"},
    )
    events = parse_sse(response.text)
    end_data = events[-1][1]
    assert end_data["total_usage"]["input_tokens"] == 200
    assert end_data["total_usage"]["output_tokens"] == 100
    assert end_data["total_cost"]["total_usd"] == pytest.approx(0.002)
    assert end_data["total_cost"]["total_krw"] > 0


def test_solve_provider_error_becomes_error_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = StubProvider(fail=ProviderError("boom", "호출이 실패했습니다.", "힌트"))
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/solve", json={"problem_numbers": [1]}
    )
    events = dict(parse_sse(response.text))
    assert events["error"]["error_code"] == "boom"
    assert events["error"]["message"] == "호출이 실패했습니다."
    assert client.get(f"/api/files/{node_id}/solutions").json()["solutions"] == []


def test_solve_unknown_problem_number_400(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/solve", json={"problem_numbers": [99]}
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "problem_not_found"


def test_solve_unknown_model_400(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/solve", json={"model": "gpt-9", "problem_numbers": [1]}
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "unknown_model"


def test_solve_without_provider_returns_409(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(subscription_provider, "is_available", lambda: False)
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(f"/api/files/{node_id}/solve", json={"problem_numbers": [1]})
    assert response.status_code == 409
    body = response.json()
    assert body["error_code"] == "no_provider"
    assert body["hint"] is not None


def test_chat_stream_and_history(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/chat",
        json={"message": "3번 문제 알려주세요", "problem_no": 3},
    )
    assert response.status_code == 200
    events = parse_sse(response.text)
    assert [name for name, _ in events] == ["delta", "delta", "done"]
    assert events[-1][1]["content"] == "풀이 완료"

    # 문항 컨텍스트로 크롭 이미지가 붙었는지 확인
    parts = stub_provider.calls[0]["turns"][-1].parts
    assert any(isinstance(part, ImagePart) for part in parts)

    # problem_no=3 으로 보냈으므로 3번 스레드에 저장된다(전역 스레드는 비어 있다).
    thread = client.get(f"/api/files/{node_id}/chat", params={"problem_no": 3}).json()
    history = thread["messages"]
    assert [item["role"] for item in history] == ["user", "assistant"]
    assert history[0]["content"] == "3번 문제 알려주세요"
    assert all(item["problem_no"] == 3 for item in history)
    assert thread["truncated_before"] == 0
    assert client.get(f"/api/files/{node_id}/chat").json()["messages"] == []

    deleted = client.delete(f"/api/files/{node_id}/chat", params={"problem_no": 3})
    assert deleted.json() == {"ok": True}
    assert (
        client.get(f"/api/files/{node_id}/chat", params={"problem_no": 3}).json()[
            "messages"
        ]
        == []
    )


def test_chat_without_problem_uses_file_summary(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    client.post(f"/api/files/{node_id}/chat", json={"message": "이 시험지 어때요?"})
    parts = stub_provider.calls[0]["turns"][-1].parts
    texts = [part.text for part in parts if isinstance(part, TextPart)]
    assert any("전체 22문항" in text for text in texts)
    assert not any(isinstance(part, ImagePart) for part in parts)


def test_chat_with_problem_uses_solve_prompt(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """문항이 첨부된 파일 채팅은 풀이 스킬(SOLVE_SYSTEM_PROMPT)을 쓴다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    client.post(
        f"/api/files/{node_id}/chat",
        json={"message": "3번 풀어주세요", "problem_no": 3},
    )
    assert stub_provider.calls[0]["system"] == prompts.SOLVE_SYSTEM_PROMPT


def test_chat_without_problem_uses_chat_prompt(
    client: TestClient, stub_provider: StubProvider
) -> None:
    """문항이 없는 일반 파일 대화는 기존대로 채팅 프롬프트를 쓴다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    client.post(f"/api/files/{node_id}/chat", json={"message": "이 시험지 어때요?"})
    assert stub_provider.calls[0]["system"] == prompts.CHAT_SYSTEM_PROMPT


def test_chat_history_is_carried_over(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    client.post(f"/api/files/{node_id}/chat", json={"message": "첫 질문"})
    client.post(f"/api/files/{node_id}/chat", json={"message": "두 번째 질문"})
    turns = stub_provider.calls[1]["turns"]
    assert len(turns) == 3  # 이전 user + assistant + 새 user
    assert turns[0].role == "user"
    assert turns[1].role == "assistant"


def test_chat_unknown_problem_400(
    client: TestClient, stub_provider: StubProvider
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/files/{node_id}/chat", json={"message": "질문", "problem_no": 99}
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "problem_not_found"


async def test_solve_stream_over_asgi_transport(
    stub_provider: StubProvider,
) -> None:
    """httpx.AsyncClient + ASGITransport 로도 SSE 가 흐르는지 확인한다."""
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as async_client:
        with TestClient(main.app) as sync_client:
            node_id = upload_test_pdf(sync_client)["node"]["id"]
        chunks: list[str] = []
        async with async_client.stream(
            "POST",
            f"/api/files/{node_id}/solve",
            json={"problem_numbers": [1]},
        ) as response:
            assert response.status_code == 200
            async for chunk in response.aiter_text():
                chunks.append(chunk)
    events = parse_sse("".join(chunks))
    assert [name for name, _ in events] == [
        "start",
        "problem",
        "delta",
        "delta",
        "done",
        "end",
    ]
