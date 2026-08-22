"""테스트 공통 픽스처. AI 호출은 전부 스텁으로 대체한다."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator, Sequence
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import ai_service
import config
import main
import ocr
import storage
from providers import agy as agy_provider
from providers.base import DeltaEvent, DoneEvent, Effort, Provider, ProviderEvent, Turn

#: `main._autoqueue_ocr` 의 원본. 아래 autouse 픽스처가 이것을 끄기 **전에**
#: 붙잡아 둔다. OCR 자동 등록을 실제로 검증하는 테스트는 `ocr_autoqueue` 픽스처로
#: 되살린다(test_ocr.py).
_REAL_AUTOQUEUE_OCR = main._autoqueue_ocr

TEST_PDF = (
    Path(__file__).resolve().parents[3] / "[2026-1-1-M][공수1][풍문고].pdf"
)


class StubProvider(Provider):
    """실제 AI 호출 없이 델타 2개 + done 을 흘리는 스텁."""

    name = "stub"
    supports_images = True

    def __init__(
        self,
        *,
        usage: dict[str, Any] | None = None,
        cost: dict[str, Any] | None = None,
        fail: Exception | None = None,
    ) -> None:
        self.usage = usage
        self.cost = cost
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    async def stream(
        self,
        *,
        system: str,
        turns: Sequence[Turn],
        model: str,
        effort: Effort,
        max_tokens: int,
    ) -> AsyncIterator[ProviderEvent]:
        self.calls.append(
            {
                "system": system,
                "turns": list(turns),
                "model": model,
                "effort": effort,
                "max_tokens": max_tokens,
            }
        )
        if self.fail is not None:
            raise self.fail
        yield DeltaEvent(type="delta", text="풀이 ")
        yield DeltaEvent(type="delta", text="완료")
        yield DoneEvent(
            type="done",
            text="풀이 완료",
            usage=self.usage,
            cost=self.cost,
            truncated=False,
            stop_reason="end_turn",
        )


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """데이터 디렉터리를 테스트별 임시 폴더로 격리한다.

    agy 는 실행파일이 개발 PC 에 실제로 있어 테스트가 기기 상태에 좌우되므로,
    기본적으로 "미설치" 로 고정한다. agy 동작 테스트는 test_agy.py 에서 명시적으로
    `find_agy` 를 덮어써 활성화한다.

    스캔본 OCR 도 같은 이유로 기본 차단이다. 이유가 둘이다.
      1. 실제 엔진은 onnx 모델 16MB 를 올리고 1.6초/쪽이 걸린다 — 스캔본을 올리는
         테스트가 전부 느려지고 기기 상태에 좌우된다.
      2. 자동 등록된 작업이 **백그라운드에서** 파일 메타(`extract_error`,
         `problem_count`)를 덮어쓴다. TestClient 는 동기라 그 시점이 요청 사이에
         끼어들어 기존 테스트가 간헐 실패한다.
    그래서 리더는 "아무것도 읽지 못하는" 것으로, 자동 등록은 no-op 으로 고정한다.
    OCR 경로 테스트는 `ocr_autoqueue` 픽스처와 자체 가짜 리더를 쓴다.
    """
    monkeypatch.delenv(config.API_KEY_ENV, raising=False)
    monkeypatch.delenv(config.DEPLOY_MODE_ENV, raising=False)
    monkeypatch.setattr(agy_provider, "find_agy", lambda: None)
    monkeypatch.setattr(ocr, "default_page_reader", lambda: (lambda _page: []))

    async def _no_autoqueue(node_id: str, extract_error: str | None) -> None:
        return None

    monkeypatch.setattr(main, "_autoqueue_ocr", _no_autoqueue)
    original = config.data_dir()
    config.use_data_dir(tmp_path / "data")
    storage.init_db()
    yield
    config.use_data_dir(original)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(main.app) as test_client:
        yield test_client


def enable_ocr_autoqueue(monkeypatch: pytest.MonkeyPatch) -> None:
    """업로드·재추출 시 OCR 작업 자동 등록을 되살린다(기본은 autouse 가 끈다).

    "업로드까지는 끈 채로 하고 그 다음부터 켜고 싶다" 는 테스트가 있어 픽스처가
    아니라 함수로도 열어 둔다.
    """
    monkeypatch.setattr(main, "_autoqueue_ocr", _REAL_AUTOQUEUE_OCR)


@pytest.fixture
def ocr_autoqueue(monkeypatch: pytest.MonkeyPatch) -> None:
    """테스트 시작부터 OCR 자동 등록을 켠다."""
    enable_ocr_autoqueue(monkeypatch)


@pytest.fixture
def stub_provider(monkeypatch: pytest.MonkeyPatch) -> StubProvider:
    """`resolve_provider` 가 항상 스텁을 돌려주게 한다."""
    provider = StubProvider()
    monkeypatch.setattr(
        ai_service, "resolve_provider", lambda requested, api_key: provider
    )
    return provider


def make_folder(
    client: TestClient,
    name: str,
    parent_id: str | None = None,
    section: str = "exam",
) -> str:
    response = client.post(
        "/api/folders",
        json={"name": name, "parent_id": parent_id, "section": section},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["node"]["id"])


def make_note(client: TestClient, name: str, parent_id: str | None = None) -> str:
    response = client.post("/api/notes", json={"name": name, "parent_id": parent_id})
    assert response.status_code == 201, response.text
    return str(response.json()["node"]["id"])


def upload_test_pdf(client: TestClient, parent_id: str | None = None) -> dict[str, Any]:
    assert TEST_PDF.is_file(), f"테스트 PDF 가 없습니다: {TEST_PDF}"
    data = {"parent_id": parent_id} if parent_id else {}
    with TEST_PDF.open("rb") as handle:
        response = client.post(
            "/api/files",
            files={"file": (TEST_PDF.name, handle, "application/pdf")},
            data=data,
        )
    assert response.status_code == 201, response.text
    payload: dict[str, Any] = response.json()
    return payload


def parse_sse(body: str) -> list[tuple[str, dict[str, Any]]]:
    """SSE 본문을 (event, data) 목록으로 파싱한다."""
    import json

    events: list[tuple[str, dict[str, Any]]] = []
    for block in body.strip().split("\n\n"):
        name = ""
        data = "{}"
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[len("event: ") :]
            elif line.startswith("data: "):
                data = line[len("data: ") :]
        if name:
            events.append((name, json.loads(data)))
    return events


def create_job(client: TestClient, **payload: Any) -> dict[str, Any]:
    """작업을 만들고 응답 본문을 돌려준다."""
    response = client.post("/api/jobs", json=payload)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def wait_job(
    client: TestClient, job_id: str, *, timeout: float = 30.0
) -> dict[str, Any]:
    """작업이 끝날 때까지 기다렸다가 최종 상태를 돌려준다.

    TestClient 는 동기라 워커가 도는 사이 폴링으로 기다린다. 실서비스 프론트는
    `GET /api/jobs/{id}/events` 를 구독한다.
    """
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        payload = client.get("/api/jobs").json()
        for item in payload["active"] + payload["recent"]:
            if item["id"] != job_id:
                continue
            if item["status"] in ("done", "error", "canceled", "interrupted"):
                return dict(item)
        time.sleep(0.05)
    raise AssertionError(f"작업이 시간 안에 끝나지 않았습니다: {job_id}")
