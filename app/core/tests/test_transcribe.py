"""문항 텍스트화(`kind="transcribe"`) 테스트.

이 단계의 핵심 가치는 하나다: **PDF 텍스트 레이어로 읽어낸 문항에는 AI 를 부르지
않는다.** 그래서 아래 테스트 중 가장 중요한 것은
`test_decoded_problems_never_call_ai` 다 — 스텁 프로바이더가 단 한 번도 불리지
않아야 한다.

실제 시험지(풍문고, `conftest.TEST_PDF`)로 검증한다. 이 시험지는 22문항 중 17개가
1차 디코딩으로 끝나고 5개(그림 포함: 10·11·12·15·19)가 AI 로 넘어간다.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from conftest import StubProvider, create_job, upload_test_pdf, wait_job
from fastapi import status
from fastapi.testclient import TestClient

import ai_service
import prompts
import storage
from errors import ApiError
from providers.base import DeltaEvent, DoneEvent, ProviderEvent

# 1차 디코딩만으로 끝나는 문항(AI 호출 0회)과, 그림이 있어 AI 로 넘어가는 문항.
DECODED = [1, 2]
FIGURE = 11


class TranscribeProvider(StubProvider):
    """`## 판정 / ## 문제` 형식으로 답하는 스텁.

    기본 스텁(`StubProvider`)은 "풀이 완료" 를 흘려서 판독 형식이 아니다.
    """

    def __init__(
        self,
        *,
        verdict: str = "가능",
        body: str | None = "다음 식의 값을 구하시오. \\(x^{2}+1\\) [3점]",
    ) -> None:
        super().__init__()
        self.verdict = verdict
        self.body = body

    async def stream(self, **kwargs: Any) -> AsyncIterator[ProviderEvent]:
        self.calls.append(kwargs)
        text = f"## 판정\n{self.verdict}\n"
        if self.body is not None:
            text += f"\n## 문제\n{self.body}\n"
        yield DeltaEvent(type="delta", text=text)
        yield DoneEvent(
            type="done",
            text=text,
            usage=None,
            cost=None,
            truncated=False,
            stop_reason="end_turn",
        )


@pytest.fixture
def transcribe_provider(monkeypatch: pytest.MonkeyPatch) -> TranscribeProvider:
    provider = TranscribeProvider()
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )
    return provider


def _use(monkeypatch: pytest.MonkeyPatch, provider: TranscribeProvider) -> None:
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )


def _problems(node_id: str) -> dict[int, dict[str, Any]]:
    with storage.transaction() as conn:
        return {row["no"]: row for row in storage.list_problems(conn, node_id)}


# ── 응답 파서 ────────────────────────────────────────────────────────


def test_parse_transcription_accepts_possible_verdict() -> None:
    reading = ai_service.parse_transcription(
        "## 판정\n가능\n\n## 문제\n다음 값을 구하시오. \\(x+1\\)\n"
    )
    assert reading.transcript == "다음 값을 구하시오. \\(x+1\\)"
    assert reading.note is None


def test_parse_transcription_rejects_impossible_verdict() -> None:
    reading = ai_service.parse_transcription(
        "## 판정\n불가 - 좌표평면 그래프가 있어 텍스트로 옮길 수 없습니다\n"
    )
    assert reading.transcript is None
    assert reading.note is not None
    assert "좌표평면" in reading.note


def test_parse_transcription_rejects_missing_verdict() -> None:
    """판정 섹션이 없으면 채택하지 않는다(애매하면 이미지로 폴백)."""
    reading = ai_service.parse_transcription("그냥 문제를 옮긴 텍스트입니다.")
    assert reading.transcript is None
    assert reading.note == "AI 응답에서 판정을 읽지 못했습니다."


def test_parse_transcription_rejects_empty_body() -> None:
    reading = ai_service.parse_transcription("## 판정\n가능\n\n## 문제\n\n")
    assert reading.transcript is None
    assert reading.note is not None
    assert "본문이 비어" in reading.note


# ── 저장 규칙 ────────────────────────────────────────────────────────


def test_manual_transcript_survives_without_force(client: TestClient) -> None:
    """사용자가 고친 판독본은 `force` 없이는 덮이지 않는다.

    작업 대상은 큐에 넣을 때 정해지고 실행은 나중이라, 그 사이 사용자가 고친
    내용을 조용히 덮어쓸 수 있다. 저장 시점에 한 번 더 막는다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]
    with storage.transaction() as conn:
        storage.set_transcript(
            conn,
            node_id=node_id,
            no=1,
            transcript="사람이 고친 전문",
            source=storage.TRANSCRIPT_MANUAL,
            note=None,
        )
    with storage.transaction() as conn:
        assert (
            storage.set_transcript(
                conn,
                node_id=node_id,
                no=1,
                transcript="기계가 쓴 전문",
                source=storage.TRANSCRIPT_PUA,
                note=None,
            )
            is False
        )
    assert _problems(node_id)[1]["transcript"] == "사람이 고친 전문"

    # force(= overwrite_manual) 면 덮는다.
    with storage.transaction() as conn:
        assert (
            storage.set_transcript(
                conn,
                node_id=node_id,
                no=1,
                transcript="기계가 쓴 전문",
                source=storage.TRANSCRIPT_PUA,
                note=None,
                overwrite_manual=True,
            )
            is True
        )
    assert _problems(node_id)[1]["transcript"] == "기계가 쓴 전문"


def test_reextract_clears_transcripts(client: TestClient) -> None:
    """재추출은 판독본을 남기지 않는다(번호가 바뀌면 엉뚱한 문항에 붙는다)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    with storage.transaction() as conn:
        storage.set_transcript(
            conn,
            node_id=node_id,
            no=1,
            transcript="옛 판독본",
            source=storage.TRANSCRIPT_AI,
            note=None,
        )
    assert storage_transcribed(node_id) == {1}

    assert client.post(f"/api/files/{node_id}/reextract").status_code == 200
    assert storage_transcribed(node_id) == set()
    assert _problems(node_id)[1]["transcript_source"] is None


def storage_transcribed(node_id: str) -> set[int]:
    with storage.transaction() as conn:
        return storage.transcribed_numbers(conn, node_id)


# ── 작업: 1차 디코딩 ────────────────────────────────────────────────


def test_decoded_problems_never_call_ai(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """**이 단계의 핵심.** 디코딩으로 끝난 문항에는 AI 를 부르지 않는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=DECODED
    )
    assert body["job"]["kind"] == "transcribe"
    assert body["job"]["total"] == len(DECODED)

    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert final["done_count"] == len(DECODED)

    # AI 스텁이 한 번도 불리지 않았다.
    assert transcribe_provider.calls == []

    rows = _problems(node_id)
    for no in DECODED:
        assert rows[no]["transcript_source"] == storage.TRANSCRIPT_PUA
        assert rows[no]["transcript"]
        assert rows[no]["transcript_note"] is None
    # 디코딩본은 원본 글리프 그대로다(수식이 LaTeX 로 들어 있다).
    assert "\\(" in rows[DECODED[0]]["transcript"]


def test_figure_problem_falls_back_to_ai(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """그림이 있어 1차가 실패한 문항만 AI 비전으로 넘어간다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    job_id = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[FIGURE]
    )["job"]["id"]
    final = wait_job(client, job_id)
    assert final["status"] == "done"

    assert len(transcribe_provider.calls) == 1
    call = transcribe_provider.calls[0]
    # 풀이 프롬프트가 아니라 텍스트화 프롬프트로 부른다.
    assert call["system"] == prompts.TRANSCRIBE_SYSTEM_PROMPT
    assert call["system"] != prompts.SOLVE_SYSTEM_PROMPT
    # 크롭 PNG 를 붙여 보낸다.
    parts = call["turns"][0].parts
    assert any(getattr(part, "b64", None) for part in parts)

    row = _problems(node_id)[FIGURE]
    assert row["transcript_source"] == storage.TRANSCRIPT_AI
    assert row["transcript"] == "다음 식의 값을 구하시오. \\(x^{2}+1\\) [3점]"
    assert row["transcript_note"] is None


def test_impossible_verdict_keeps_the_existing_transcript(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`불가` 판정이 **이미 확보한 전문을 지우지 않는다.**

    AI 판정은 비결정적이다. 같은 이미지에서 어제는 `가능`, 오늘은 `불가` 가 나올 수
    있고 그 변동으로 데이터를 잃으면 안 된다. 이유(note)만 갱신한다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]

    _use(monkeypatch, TranscribeProvider())
    first = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[FIGURE]
    )
    wait_job(client, first["job"]["id"])
    saved = _problems(node_id)[FIGURE]["transcript"]
    assert saved

    # 같은 문항을 force 로 다시 판독했는데 이번에는 `불가` 라고 답한다.
    _use(
        monkeypatch,
        TranscribeProvider(verdict="불가 - 도형이 있어 옮길 수 없습니다", body=None),
    )
    again = create_job(
        client,
        kind="transcribe",
        node_id=node_id,
        problem_numbers=[FIGURE],
        force=True,
    )
    assert wait_job(client, again["job"]["id"])["status"] == "done"

    row = _problems(node_id)[FIGURE]
    assert row["transcript"] == saved  # 전문은 보존된다
    assert row["transcript_source"] == storage.TRANSCRIPT_AI
    assert "도형" in (row["transcript_note"] or "")  # 이유만 갱신된다


def test_ai_impossible_verdict_stores_reason_only(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """전문이 없던 문항이 `불가` 면 전문은 계속 없고 이유만 남는다."""
    provider = TranscribeProvider(
        verdict="불가 - 도형이 있어 옮길 수 없습니다", body=None
    )
    _use(monkeypatch, provider)

    node_id = upload_test_pdf(client)["node"]["id"]
    job_id = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[FIGURE]
    )["job"]["id"]
    assert wait_job(client, job_id)["status"] == "done"

    row = _problems(node_id)[FIGURE]
    assert row["transcript"] is None
    assert row["transcript_source"] is None
    assert "도형" in (row["transcript_note"] or "")
    # 다시 실행하면 또 시도한다(불가는 '이미 판독됨' 이 아니다).
    assert storage_transcribed(node_id) == set()


# ── AI 연결이 없을 때 ───────────────────────────────────────────────


def _no_provider(requested: str, api_key: str | None) -> Any:
    raise ApiError(
        status.HTTP_409_CONFLICT,
        "no_provider",
        "사용할 수 있는 AI 연결이 없습니다.",
        "Claude Code 에 로그인하거나 API 키를 등록하세요.",
    )


def test_works_without_any_ai_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**AI 연결이 없어도** 디코딩 가능한 문항은 저장되고 작업은 `done` 이다.

    이 기능의 요점이 "AI 호출 0회로 텍스트를 얻는다" 이므로, AI 가 없다고 작업을
    시작조차 못 하게 하면 설계 목적이 깎인다.
    """
    monkeypatch.setattr(ai_service, "resolve_provider", _no_provider)
    node_id = upload_test_pdf(client)["node"]["id"]

    # 등록 자체가 409 로 막히지 않아야 한다(create_job 이 201 을 단정한다).
    body = create_job(
        client,
        kind="transcribe",
        node_id=node_id,
        problem_numbers=[DECODED[0], FIGURE],
    )
    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert final["done_count"] == 2

    rows = _problems(node_id)
    # 디코딩 문항은 정상 저장된다.
    assert rows[DECODED[0]]["transcript_source"] == storage.TRANSCRIPT_PUA
    assert rows[DECODED[0]]["transcript"]
    # AI 가 필요한 문항만 이유가 남는다.
    assert rows[FIGURE]["transcript"] is None
    assert "AI 연결" in (rows[FIGURE]["transcript_note"] or "")


def test_solve_still_requires_a_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """풀이는 그대로다 — AI 가 없으면 할 수 있는 일이 없으므로 409 로 막는다."""
    monkeypatch.setattr(ai_service, "resolve_provider", _no_provider)
    node_id = upload_test_pdf(client)["node"]["id"]
    for kind, extra in (("solve", {}), ("variant", {"no": 1, "modes": ["number"]})):
        response = client.post(
            "/api/jobs", json={"kind": kind, "node_id": node_id, **extra}
        )
        assert response.status_code == 409, response.text
        assert response.json()["error_code"] == "no_provider"


# ── 작업: 건너뛰기·force ────────────────────────────────────────────


def test_already_transcribed_returns_400(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """판독본이 있는 문항만 요청하면 400 `already_transcribed`."""
    node_id = upload_test_pdf(client)["node"]["id"]
    job_id = create_job(client, kind="transcribe", node_id=node_id, problem_numbers=[1])[
        "job"
    ]["id"]
    wait_job(client, job_id)

    response = client.post(
        "/api/jobs",
        json={"kind": "transcribe", "node_id": node_id, "problem_numbers": [1]},
    )
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "already_transcribed"
    assert "이미" in body["message"]


def test_force_retranscribes(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """`force` 면 이미 판독한 문항도 다시 판독한다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(client, kind="transcribe", node_id=node_id, problem_numbers=[1])
    wait_job(client, first["job"]["id"])

    again = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[1], force=True
    )
    assert again["existing"] is False
    assert wait_job(client, again["job"]["id"])["status"] == "done"


def test_transcribe_skips_already_done_and_keeps_the_rest(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """이미 판독한 문항은 대상에서 빠지고 남은 문항만 돈다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(client, kind="transcribe", node_id=node_id, problem_numbers=[1])
    wait_job(client, first["job"]["id"])

    second = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[1, 2]
    )
    assert second["job"]["total"] == 1  # 1번은 빠졌다
    wait_job(client, second["job"]["id"])
    assert storage_transcribed(node_id) == {1, 2}


def test_transcribe_job_is_separate_from_solve_job(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """같은 문항이라도 풀이 작업과 텍스트화 작업은 별개다(kind 가 다르다)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    solve = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])
    transcribe = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[1]
    )
    assert transcribe["existing"] is False
    assert transcribe["job"]["id"] != solve["job"]["id"]
    wait_job(client, solve["job"]["id"])
    wait_job(client, transcribe["job"]["id"])


def test_duplicate_transcribe_job_returns_existing(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """대상이 겹치는 텍스트화 작업을 또 넣으면 기존 작업을 돌려준다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    first = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[1, 2]
    )
    second = create_job(
        client, kind="transcribe", node_id=node_id, problem_numbers=[2, 3]
    )
    assert second["existing"] is True
    assert second["job"]["id"] == first["job"]["id"]


def test_whole_exam_mostly_decodes_without_ai(
    client: TestClient, transcribe_provider: TranscribeProvider
) -> None:
    """실제 시험지 전체(22문항)를 판독하면 AI 호출은 그림 문항 몇 개뿐이다.

    구체적인 개수는 디코더가 좋아지면 달라진다(그건 좋은 변화다). 그래서 여기서는
    **AI 호출이 대상 수보다 훨씬 적다**는 것과, AI 로 넘어간 문항이 곧 저장된
    `ai` 출처와 정확히 같다는 것만 못박는다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]
    job = create_job(client, kind="transcribe", node_id=node_id, problem_numbers=None)
    total = job["job"]["total"]
    assert total >= 20  # 풍문고 시험지는 22문항이다

    final = wait_job(client, job["job"]["id"], timeout=120.0)
    assert final["status"] == "done"
    assert final["done_count"] == total

    rows = _problems(node_id)
    pua = {no for no, row in rows.items() if row["transcript_source"] == "pua"}
    ai = {no for no, row in rows.items() if row["transcript_source"] == "ai"}
    assert pua & ai == set()
    assert len(pua) + len(ai) == total  # 전부 텍스트가 됐다(스텁은 늘 '가능')
    # AI 호출 수 == ai 출처 문항 수. 디코딩본에는 한 번도 부르지 않았다.
    assert len(transcribe_provider.calls) == len(ai)
    assert len(ai) * 2 < len(pua)  # 대다수가 무료 경로로 끝난다


# ── 진행 이벤트: 비용이 보이는가 ────────────────────────────────────


async def test_events_separate_decoded_from_ai_calls(client: TestClient) -> None:
    """진행 이벤트가 디코딩 문항과 AI 문항을 구분해 알려준다.

    작업 큐를 거치지 않고 이벤트 발생기를 직접 소비한다 — 큐를 통하면 이벤트를
    구독하기 전에 작업이 끝나 버려 검증이 불안정하다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]
    provider = TranscribeProvider()
    targets, node_name = ai_service.plan_transcribe_job(
        node_id, [DECODED[0], FIGURE], force=False
    )
    assert node_name
    assert [int(item["no"]) for item in targets] == [DECODED[0], FIGURE]

    events = [
        (name, data)
        async for name, data in ai_service.transcribe_events(
            node_id=node_id,
            provider_resolver=lambda: provider,
            targets=targets,
            model="claude-sonnet-5",
            effort="low",
        )
    ]
    by_name: dict[str, list[dict[str, Any]]] = {}
    for name, data in events:
        by_name.setdefault(name, []).append(data)

    assert by_name["start"][0]["total"] == 2
    # `problem` 이벤트가 어느 경로로 갈지 미리 알려준다.
    assert [item["route"] for item in by_name["problem"]] == ["pua", "ai"]
    # `done` 은 실제 출처를 담는다.
    assert [item["source"] for item in by_name["done"]] == ["pua", "ai"]
    # 마지막 집계로 AI 호출 수가 드러난다.
    end = by_name["end"][0]
    assert end["decoded_count"] == 1
    assert end["ai_count"] == 1
    assert end["unavailable_count"] == 0
    # 실제로 AI 는 한 번만 불렸다(2문항 중 1문항).
    assert len(provider.calls) == 1
