"""판독본 우선 풀이와 방향 전환 폴백 (`ai_service.solve_events`).

판독본이 **이미** 있으면 크롭 이미지가 아니라 그 텍스트로 먼저 푼다(판독을 새로
돌리지 않는다 = 추가 판독 비용 0). 이미지 풀이가 예외 없이 엉터리 풀이를 내놓는
사례(omega)가 있어 실패 폴백만으로는 걸러지지 않기 때문이고, 이미지 토큰도 함께
아낀다.

**파일 `mode` 는 게이트가 아니다.** 무엇으로 풀지는 `solve_input.pick_solve_input`
이 그 문항의 텍스트가 실제로 쓸 만한지로 정한다(단위 테스트는
`tests/test_solve_input.py`). 여기서는 그 선택이 이벤트 계약·호출 횟수·크롭 읽기와
어떻게 맞물리는지를 본다.

판독본이 **그림을 가리키면** 글자만 보내서는 조건이 빠지므로 예전처럼 이미지로
푼다. 어느 방향이든 1차가 실패하면 반대 방향으로 한 번만 다시 푼다.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from conftest import StubProvider, create_job, upload_test_pdf, wait_job
from fastapi.testclient import TestClient

import ai_service
import config
import pricing
import storage
from providers.base import (
    DeltaEvent,
    DoneEvent,
    ImagePart,
    Mode,
    ProviderError,
    ProviderEvent,
)

TRANSCRIPT = r"다음 식의 값을 구하시오. \(x^{2}+1\) [3점]"
# 그림을 가리키는 판독본. 판독본은 글자·수식만 복원하므로 이 문항은 크롭이 필요하다.
FIGURE_TRANSCRIPT = r"다음 그림과 같이 놓인 삼각형의 넓이를 구하시오. \(a>0\) [4점]"


def _yield_done(text: str) -> list[ProviderEvent]:
    return [
        DeltaEvent(type="delta", text=text),
        DoneEvent(
            type="done",
            text=text,
            usage=None,
            cost=None,
            truncated=False,
            stop_reason="end_turn",
        ),
    ]


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
        for event in _yield_done("텍스트로 푼 풀이"):
            yield event


class TextFailingProvider(StubProvider):
    """텍스트만 오면 실패하고 이미지가 실리면 성공하는 스텁(판독본 → 이미지 폴백)."""

    async def stream(self, **kwargs: Any) -> AsyncIterator[ProviderEvent]:
        self.calls.append(kwargs)
        parts = [part for turn in kwargs["turns"] for part in turn.parts]
        if not any(isinstance(part, ImagePart) for part in parts):
            raise ProviderError("empty_response", "텍스트로는 풀지 못했습니다", None)
        for event in _yield_done("이미지로 푼 풀이"):
            yield event


def _spy_crop_reads(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """크롭 PNG 를 읽은 문항 번호를 기록한다.

    "이미지를 아예 읽지 않는다" 를 못박는 장치다 — 이미지 토큰·비전 처리 시간을
    아끼는 것이 판독본 우선 풀이의 목적 절반이다.
    """
    reads: list[int] = []
    original = ai_service._read_crop_b64

    def _spy(problem: dict[str, Any]) -> str | None:
        reads.append(int(problem["no"]))
        return original(problem)

    monkeypatch.setattr(ai_service, "_read_crop_b64", _spy)
    return reads


def _use(monkeypatch: pytest.MonkeyPatch, provider: StubProvider) -> None:
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )


def _set_problem_text(node_id: str, no: int, text: str) -> None:
    """`problems.text` 를 직접 갈아 끼운다 (omega 상황 재현용).

    omega 는 텍스트 레이어에 문항 번호만 남은 PDF 라 `problems.text` 가 `"1."`
    뿐이었다. 테스트 PDF 로 그 상태를 만들 방법이 없어 저장된 값을 바꾼다.
    """
    with storage.transaction() as conn:
        conn.execute(
            "UPDATE problems SET text = ? WHERE node_id = ? AND no = ?",
            (text, node_id, no),
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
    """이미지로 실패해도 판독본이 있으면 텍스트로 다시 풀어 저장한다.

    판독본이 **그림을 가리켜** 이미지로 시작하는 경로다(그림 참조가 없으면 애초에
    텍스트로 먼저 푼다 — 아래 `test_transcript_is_used_first_...`).
    """
    provider = ImageFailingProvider()
    _use(monkeypatch, provider)
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, FIGURE_TRANSCRIPT)

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
    assert FIGURE_TRANSCRIPT in "".join(
        getattr(part, "text", "") for part in last_parts
    )


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
    # 1번만 두 번(판독본+이미지), 2·3번은 한 번씩.
    assert len(provider.calls) == 4


# ------------------------------------------------ 판독본 우선 (ERR-4 / omega)
def test_transcript_is_used_first_without_reading_crop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """그림 참조가 없는 판독본이 있으면 **크롭을 읽지도 않고** 텍스트로 푼다.

    이미지 풀이가 예외 없이 엉터리 풀이를 내놓던 사례(omega)의 재발 방지이자,
    이미지 토큰·비전 처리 시간 절약이다. 그래서 호출 횟수만 보지 않고
    `_read_crop_b64` 가 아예 불리지 않는 것까지 못박는다.
    """
    provider = ImageFailingProvider()
    _use(monkeypatch, provider)
    reads = _spy_crop_reads(monkeypatch)
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, TRANSCRIPT)

    job_id = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])[
        "job"
    ]["id"]
    final = wait_job(client, job_id)

    assert final["status"] == "done"
    assert reads == []  # 크롭 PNG 를 열지 않았다
    assert len(provider.calls) == 1  # 이미지 시도 없이 한 번에 끝났다
    parts = [part for turn in provider.calls[0]["turns"] for part in turn.parts]
    assert not any(isinstance(part, ImagePart) for part in parts)
    assert TRANSCRIPT in "".join(getattr(part, "text", "") for part in parts)

    saved = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["solution"] for item in saved] == ["텍스트로 푼 풀이"]


def test_figure_transcript_still_solves_with_image(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """판독본이 그림을 가리키면 예전처럼 크롭 이미지로 푼다.

    판독본은 글자·수식만 복원한다. `다음 그림과 같이` 가 있는 문항을 텍스트만으로
    보내면 조건이 빠진 문제를 푸는 셈이 된다.
    """
    provider = StubProvider()
    _use(monkeypatch, provider)
    reads = _spy_crop_reads(monkeypatch)
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, FIGURE_TRANSCRIPT)

    job_id = create_job(client, kind="solve", node_id=node_id, problem_numbers=[1])[
        "job"
    ]["id"]
    final = wait_job(client, job_id)

    assert final["status"] == "done"
    assert reads == [1]
    assert len(provider.calls) == 1
    parts = [part for turn in provider.calls[0]["turns"] for part in turn.parts]
    assert any(isinstance(part, ImagePart) for part in parts)


async def _run_solve(
    *,
    node_id: str,
    provider: StubProvider,
    mode: Mode | None = None,
    numbers: list[int],
) -> list[tuple[str, dict[str, Any]]]:
    """`solve_events` 를 직접 돌려 이벤트를 모은다(이벤트 횟수 검증용)."""
    file_mode, targets = ai_service.load_solve_targets(node_id, numbers)
    return [
        event
        async for event in ai_service.solve_events(
            node_id=node_id,
            provider=provider,
            mode=mode or file_mode,
            targets=targets,
            model=pricing.DEFAULT_MODEL,
            effort="medium",
        )
    ]


async def test_transcript_failure_retries_with_image_once(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """판독본으로 실패하면 이미지로 한 번만 다시 풀고, `done` 은 정확히 한 번이다."""
    provider = TextFailingProvider()
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, TRANSCRIPT)

    events = await _run_solve(node_id=node_id, provider=provider, numbers=[1])
    names = [name for name, _ in events]

    assert names.count("done") == 1  # 진행 단위는 문항 하나
    assert names.count("error") == 0
    # 재시도에 들어갈 때 `problem` 을 한 번 더 내서 부분 출력을 지운다.
    assert names.count("problem") == 2
    assert len(provider.calls) == 2  # 텍스트 1 + 이미지 1, 왕복은 없다
    first = [part for turn in provider.calls[0]["turns"] for part in turn.parts]
    last = [part for turn in provider.calls[-1]["turns"] for part in turn.parts]
    assert not any(isinstance(part, ImagePart) for part in first)
    assert any(isinstance(part, ImagePart) for part in last)


async def test_text_mode_file_prefers_its_own_text(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`problems.text` 가 쓸 만한 text 모드 파일은 동작이 바뀌지 않는다.

    원문이 정상이면 판독본으로 갈아치우지 않는다(원문이 AI 복원본보다 정확하다).
    크롭도 읽지 않는다.
    """
    provider = ImageFailingProvider()
    reads = _spy_crop_reads(monkeypatch)
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, TRANSCRIPT)

    events = await _run_solve(
        node_id=node_id, provider=provider, mode="text", numbers=[1]
    )
    names = [name for name, _ in events]

    assert names.count("done") == 1
    assert names.count("problem") == 1  # 재시도 없음
    assert reads == []
    assert len(provider.calls) == 1
    parts = [part for turn in provider.calls[0]["turns"] for part in turn.parts]
    prompt = "".join(getattr(part, "text", "") for part in parts)
    assert not any(isinstance(part, ImagePart) for part in parts)
    assert TRANSCRIPT not in prompt  # text 모드는 `problems.text` 를 쓴다


async def test_image_mode_without_transcript_uses_crop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """판독본이 없으면 예전 그대로 크롭 이미지로 푼다(재시도 없음)."""
    provider = StubProvider()
    reads = _spy_crop_reads(monkeypatch)
    node_id = upload_test_pdf(client)["node"]["id"]

    events = await _run_solve(node_id=node_id, provider=provider, numbers=[1])
    names = [name for name, _ in events]

    assert names.count("done") == 1
    assert names.count("problem") == 1
    assert reads == [1]
    assert len(provider.calls) == 1
    parts = [part for turn in provider.calls[0]["turns"] for part in turn.parts]
    assert any(isinstance(part, ImagePart) for part in parts)


async def test_text_mode_with_number_only_text_uses_transcript(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**omega 회귀 테스트 (이벤트 레벨).**

    `mode` 는 `text` 인데 `problems.text` 가 `"1."` 뿐인 문항. 예전에는
    `mode == "image"` 게이트 때문에 온전한 판독본을 무시하고 `"1."` 을 AI 에 보내
    "그럴듯한 엉터리" 풀이를 저장했다. 이제 판독본으로 푼다.
    """
    provider = ImageFailingProvider()
    reads = _spy_crop_reads(monkeypatch)
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_problem_text(node_id, 1, "1.")
    _set_transcript(node_id, 1, TRANSCRIPT)

    events = await _run_solve(
        node_id=node_id, provider=provider, mode="text", numbers=[1]
    )
    names = [name for name, _ in events]

    assert names.count("done") == 1
    assert names.count("problem") == 1  # 재시도 없이 한 번에 풀렸다
    assert reads == []  # 크롭 PNG 를 열지 않았다
    assert len(provider.calls) == 1
    parts = [part for turn in provider.calls[0]["turns"] for part in turn.parts]
    prompt = "".join(getattr(part, "text", "") for part in parts)
    assert not any(isinstance(part, ImagePart) for part in parts)
    assert TRANSCRIPT in prompt
    assert "1." not in prompt.replace(TRANSCRIPT, "")  # 번호뿐인 원문은 안 갔다


async def test_text_mode_file_also_falls_back_to_image(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """방향 전환 폴백은 **text 모드 파일에서도** 돈다.

    예전 폴백은 `mode == "image"` 조건에 묶여 있어 text 모드 파일은 텍스트로
    실패하면 그대로 끝났다. 크롭이 있으면 한 번은 이미지로 시도해야 한다.
    """
    provider = TextFailingProvider()
    node_id = upload_test_pdf(client)["node"]["id"]

    events = await _run_solve(
        node_id=node_id, provider=provider, mode="text", numbers=[1]
    )
    names = [name for name, _ in events]

    assert names.count("done") == 1
    assert names.count("error") == 0
    assert names.count("problem") == 2  # 재시도 신호가 한 번 더
    assert len(provider.calls) == 2  # 텍스트 1 + 이미지 1
    last = [part for turn in provider.calls[-1]["turns"] for part in turn.parts]
    assert any(isinstance(part, ImagePart) for part in last)


async def test_nothing_to_send_fails_loudly(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """쓸 만한 텍스트도 크롭도 없으면 **AI 를 부르지 않고** 명확히 실패한다.

    쓰레기(`"1."`)를 보내 그럴듯한 엉터리 풀이를 저장하는 것이 omega 사고의
    원인이었다. 부르지 않았으므로 쿼터도 쓰지 않는다.
    """
    provider = StubProvider()
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_problem_text(node_id, 1, "1.")
    with storage.transaction() as conn:
        problem = storage.get_problem(conn, node_id, 1)
    assert problem is not None
    (config.data_dir() / str(problem["crop_path"])).unlink()

    events = await _run_solve(
        node_id=node_id, provider=provider, mode="text", numbers=[1]
    )
    errors = [data for name, data in events if name == "error"]

    assert provider.calls == []  # AI 를 아예 부르지 않았다
    assert len(errors) == 1
    assert errors[0]["error_code"] == "no_solve_input"
    assert [name for name, _ in events].count("done") == 0
    assert client.get(f"/api/files/{node_id}/solutions").json()["solutions"] == []
