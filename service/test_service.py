"""서비스 전반 테스트.

실행:
    python -m pytest test_service.py -v

AI 실제 호출은 하지 않는다. `solver` 는 공식 SDK 를 그대로 쓰되
로컬 스텁 HTTP 서버를 `base_url` 로 물려서 **SDK 가 실제로 만들어 보내는
요청 본문**을 검사한다(모킹으로 흉내내는 것보다 강한 검증).
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, ClassVar

import anthropic
import pytest
from httpx import ASGITransport, AsyncClient

import extractor
import main
import pricing
import solver

PDF_PATH = Path(__file__).resolve().parent.parent / "[2026-1-1-M][공수1][풍문고].pdf"
EXPECTED_PROBLEM_COUNT = 22


# ---------------------------------------------------------------- pricing
def test_cache_rates_are_derived_from_input_rate() -> None:
    rates = pricing.rates_for("claude-opus-5")
    assert rates["input"] == 5.00
    assert rates["output"] == 25.00
    assert rates["cache_write"] == 5.00 * 1.25
    assert rates["cache_read"] == 5.00 * 0.10


def test_calc_cost_uses_measured_usage() -> None:
    cost = pricing.calc_cost(
        "claude-opus-5",
        {
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
            "cache_creation_input_tokens": 1_000_000,
            "cache_read_input_tokens": 1_000_000,
        },
    )
    assert cost["breakdown_usd"] == {
        "input": 5.0,
        "output": 25.0,
        "cache_write": 6.25,
        "cache_read": 0.5,
    }
    assert cost["total_usd"] == pytest.approx(36.75)
    assert cost["total_krw"] == pytest.approx(36.75 * pricing.USD_KRW)


def test_resolve_model_accepts_dated_ids_and_rejects_unknown() -> None:
    assert pricing.resolve_model("claude-sonnet-5-20260514") == "claude-sonnet-5"
    with pytest.raises(pricing.UnknownModelError):
        pricing.resolve_model("gpt-9")


def test_zero_cost_is_actually_zero() -> None:
    cost = pricing.zero_cost()
    assert cost["total_usd"] == 0.0
    assert cost["total_krw"] == 0.0


def test_normalize_usage_fills_missing_fields_with_zero() -> None:
    assert pricing.normalize_usage({"input_tokens": 7}) == {
        "input_tokens": 7,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }


# -------------------------------------------------------------- extractor
def test_pua_ratio_ignores_whitespace() -> None:
    assert extractor.pua_ratio("") == 0.0
    assert extractor.pua_ratio("abcd") == 0.0
    assert extractor.pua_ratio("") == 1.0
    assert extractor.pua_ratio("ab") == 0.5
    assert extractor.pua_ratio("  a  ") == 0.5


def test_longest_increasing_drops_out_of_order_anchors() -> None:
    # 본문 속 "1." 오탐
    assert extractor._longest_increasing([1, 2, 3, 1, 4, 5]) == [0, 1, 2, 4, 5]
    # 큰 값 오탐(3 다음 9)이 있어도 이후 정상 앵커를 살린다
    assert extractor._longest_increasing([1, 2, 3, 9, 4, 5, 6]) == [0, 1, 2, 4, 5, 6]
    assert extractor._longest_increasing([]) == []


@pytest.mark.skipif(not PDF_PATH.is_file(), reason="샘플 PDF 없음")
def test_extract_real_pdf_yields_22_problems_in_image_mode() -> None:
    result = extractor.extract_problems(PDF_PATH)

    assert len(result.problems) == EXPECTED_PROBLEM_COUNT
    assert [p.no for p in result.problems] == list(range(1, EXPECTED_PROBLEM_COUNT + 1))
    assert result.page_count == 7
    # 수식이 PUA 로 깨져 있으므로 image 모드여야 한다
    assert result.pua_ratio >= result.pua_threshold
    assert result.mode == "image"

    for problem in result.problems:
        assert problem.image_b64, f"{problem.no}번 크롭 이미지 없음"
        assert problem.image_w > 0 and problem.image_h > 0
        x0, y0, x1, y1 = problem.bbox
        assert x1 > x0 and y1 > y0
        # 여백 트림이 동작해야 한다: 칼럼 전체 높이(약 693pt)를 쓰는 문제는 없다
        assert (y1 - y0) < 690, f"{problem.no}번 트림 실패"


@pytest.mark.skipif(not PDF_PATH.is_file(), reason="샘플 PDF 없음")
def test_extract_no_images_is_fast_path() -> None:
    result = extractor.extract_problems(PDF_PATH, render_images=False)
    assert len(result.problems) == EXPECTED_PROBLEM_COUNT
    assert all(p.image_b64 is None for p in result.problems)


# ----------------------------------------------------------------- solver
class _StubHandler(BaseHTTPRequestHandler):
    """Anthropic /v1/messages 를 흉내내는 스텁."""

    captured: ClassVar[list[dict[str, Any]]] = []
    response_payload: ClassVar[dict[str, Any]] = {}

    def do_POST(self) -> None:  # BaseHTTPRequestHandler 규약상 대문자 메서드명
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).captured.append({"path": self.path, "body": body})
        payload = json.dumps(type(self).response_payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: Any) -> None:  # 테스트 출력 오염 방지
        return


def _message_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": "msg_stub",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5",
        "content": [
            {"type": "thinking", "thinking": "생각 중", "signature": "sig"},
            {"type": "text", "text": "## 문제 확인\n정답: ③"},
        ],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": 25,
            "output_tokens": 310,
            "cache_creation_input_tokens": 1783,
            "cache_read_input_tokens": 0,
        },
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def stub_api() -> Any:
    """스텁 서버를 띄우고 (client, captured, set_response) 를 돌려준다."""
    _StubHandler.captured = []
    _StubHandler.response_payload = _message_payload()
    server = HTTPServer(("127.0.0.1", 0), _StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    client = anthropic.Anthropic(
        api_key="sk-ant-test-key",
        base_url=f"http://{host}:{port}",
        max_retries=0,
    )
    try:
        yield client, _StubHandler
    finally:
        server.shutdown()
        server.server_close()


_IMAGE_PROBLEM: dict[str, Any] = {
    "no": 3,
    "page": 1,
    "text": "3. 깨진  텍스트",
    # 1x1 투명 PNG
    "image_b64": (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
}


def test_request_omits_sampling_params_and_uses_adaptive_thinking(
    stub_api: Any,
) -> None:
    client, handler = stub_api
    outcome = solver.solve_problem(
        _IMAGE_PROBLEM, client=client, mode="image", model="claude-opus-5"
    )
    assert outcome.ok, outcome.error

    body = handler.captured[0]["body"]
    # Opus 5 / Sonnet 5 에서 400 을 유발하는 파라미터가 절대 없어야 한다
    for forbidden in ("temperature", "top_p", "top_k"):
        assert forbidden not in body, f"{forbidden} 를 보내면 400 이다"
    assert body["thinking"] == {"type": "adaptive"}
    assert "budget_tokens" not in body["thinking"]
    assert body["output_config"] == {"effort": "medium"}
    assert body["max_tokens"] == solver.DEFAULT_MAX_TOKENS
    assert body["model"] == "claude-opus-5"


def test_system_prompt_is_cache_controlled_and_long_enough(stub_api: Any) -> None:
    client, handler = stub_api
    solver.solve_problem(_IMAGE_PROBLEM, client=client, mode="image")

    system = handler.captured[0]["body"]["system"]
    assert isinstance(system, list) and len(system) == 1
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    # 캐시는 최소 토큰 수를 넘는 프리픽스에만 걸린다. 한국어 기준 넉넉히 확보.
    assert len(system[0]["text"]) > 2000


def test_image_mode_sends_base64_png_block(stub_api: Any) -> None:
    client, handler = stub_api
    solver.solve_problem(_IMAGE_PROBLEM, client=client, mode="image")

    content = handler.captured[0]["body"]["messages"][0]["content"]
    assert content[0]["type"] == "image"
    assert content[0]["source"]["type"] == "base64"
    assert content[0]["source"]["media_type"] == "image/png"
    assert content[0]["source"]["data"] == _IMAGE_PROBLEM["image_b64"]
    assert content[1]["type"] == "text"
    assert "3번" in content[1]["text"]


def test_text_mode_sends_only_text(stub_api: Any) -> None:
    client, handler = stub_api
    solver.solve_problem({"no": 1, "text": "1. 2+2 는?"}, client=client, mode="text")
    content = handler.captured[0]["body"]["messages"][0]["content"]
    assert len(content) == 1
    assert content[0]["type"] == "text"
    assert "2+2 는?" in content[0]["text"]


def test_usage_is_preserved_verbatim_and_costed(stub_api: Any) -> None:
    client, _ = stub_api
    outcome = solver.solve_problem(_IMAGE_PROBLEM, client=client, mode="image")

    assert outcome.usage["input_tokens"] == 25
    assert outcome.usage["output_tokens"] == 310
    assert outcome.usage["cache_creation_input_tokens"] == 1783
    assert outcome.usage["cache_read_input_tokens"] == 0
    # thinking 블록은 풀이 텍스트에 섞이지 않는다
    assert outcome.solution == "## 문제 확인\n정답: ③"

    expected = (25 * 5.0 + 310 * 25.0 + 1783 * 6.25) / 1_000_000
    assert outcome.cost["total_usd"] == pytest.approx(expected)


def test_cache_read_usage_is_reported(stub_api: Any) -> None:
    client, handler = stub_api
    handler.response_payload = _message_payload(
        usage={
            "input_tokens": 25,
            "output_tokens": 200,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 1783,
        }
    )
    outcome = solver.solve_problem(_IMAGE_PROBLEM, client=client, mode="image")
    assert outcome.cost["tokens"]["cache_read"] == 1783
    assert outcome.cost["breakdown_usd"]["cache_read"] == pytest.approx(
        1783 * 0.5 / 1_000_000
    )


def test_refusal_is_handled_before_reading_content(stub_api: Any) -> None:
    client, handler = stub_api
    handler.response_payload = _message_payload(stop_reason="refusal", content=[])
    outcome = solver.solve_problem(_IMAGE_PROBLEM, client=client, mode="image")

    assert outcome.refusal is True
    assert outcome.ok is False
    assert outcome.solution == ""
    assert "거부" in (outcome.error or "")
    # 거부여도 usage 는 실측 그대로 남는다
    assert outcome.usage["output_tokens"] == 310


def test_max_tokens_stop_reason_marks_truncated(stub_api: Any) -> None:
    client, handler = stub_api
    handler.response_payload = _message_payload(stop_reason="max_tokens")
    outcome = solver.solve_problem(_IMAGE_PROBLEM, client=client, mode="image")

    assert outcome.truncated is True
    assert outcome.stop_reason == "max_tokens"
    assert "잘렸습니다" in (outcome.error or "")


def test_api_error_is_wrapped_not_raised(stub_api: Any) -> None:
    _unused_client, _ = stub_api
    bad = anthropic.Anthropic(
        api_key="sk-ant-test-key",
        base_url="http://127.0.0.1:1",  # 연결 불가 포트
        max_retries=0,
    )
    outcome = solver.solve_problem(_IMAGE_PROBLEM, client=bad, mode="image")
    assert outcome.ok is False
    assert outcome.error
    assert outcome.cost["total_usd"] == 0.0


def test_image_mode_without_image_fails_gracefully(stub_api: Any) -> None:
    client, _ = stub_api
    outcome = solver.solve_problem(
        {"no": 5, "text": "x", "image_b64": None}, client=client, mode="image"
    )
    assert outcome.ok is False
    assert "크롭 이미지가 없습니다" in (outcome.error or "")


def test_build_client_without_key_raises_config_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert solver.has_api_key() is False
    with pytest.raises(solver.SolverConfigError) as exc:
        solver.build_client()
    assert "ANTHROPIC_API_KEY" in str(exc.value)


# -------------------------------------------------------------------- API
@pytest.fixture
async def api() -> Any:
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest.fixture(autouse=True)
def _clear_jobs() -> Any:
    main.JOBS.clear()
    yield
    main.JOBS.clear()


@pytest.mark.asyncio
async def test_index_returns_html(api: AsyncClient) -> None:
    res = await api.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "<!DOCTYPE html>" in res.text


@pytest.mark.asyncio
async def test_health(api: AsyncClient) -> None:
    res = await api.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_extract_rejects_non_pdf(api: AsyncClient) -> None:
    res = await api.post(
        "/api/extract", files={"file": ("a.txt", b"hello", "text/plain")}
    )
    assert res.status_code == 400
    assert res.json()["detail"]["error_code"] == "not_a_pdf"


@pytest.mark.asyncio
async def test_extract_rejects_empty_file(api: AsyncClient) -> None:
    res = await api.post(
        "/api/extract", files={"file": ("a.pdf", b"", "application/pdf")}
    )
    assert res.status_code == 400
    assert res.json()["detail"]["error_code"] == "empty_file"


@pytest.mark.asyncio
@pytest.mark.skipif(not PDF_PATH.is_file(), reason="샘플 PDF 없음")
async def test_extract_endpoint_costs_nothing(api: AsyncClient) -> None:
    res = await api.post(
        "/api/extract",
        files={"file": (PDF_PATH.name, PDF_PATH.read_bytes(), "application/pdf")},
    )
    assert res.status_code == 200
    data = res.json()

    assert data["problem_count"] == EXPECTED_PROBLEM_COUNT
    assert data["problem_numbers"] == list(range(1, EXPECTED_PROBLEM_COUNT + 1))
    assert data["mode"] == "image"
    assert data["pua_ratio"] >= data["pua_threshold"]
    # 추출 단계는 AI 호출 0회, 비용 0원
    assert data["ai_calls"] == 0
    assert data["cost"]["total_usd"] == 0.0
    assert data["cost"]["total_krw"] == 0.0
    assert all(p["image_b64"] for p in data["problems"])


@pytest.mark.asyncio
@pytest.mark.skipif(not PDF_PATH.is_file(), reason="샘플 PDF 없음")
async def test_solve_without_api_key_returns_friendly_400(
    api: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    extract = await api.post(
        "/api/extract",
        files={"file": (PDF_PATH.name, PDF_PATH.read_bytes(), "application/pdf")},
    )
    job_id = extract.json()["job_id"]

    res = await api.post(
        "/api/solve", json={"job_id": job_id, "problem_numbers": [1, 2]}
    )
    # 500 이 아니라 400 + 친절한 안내여야 한다
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert detail["error_code"] == "missing_api_key"
    assert "ANTHROPIC_API_KEY" in detail["message"]
    assert detail["hint"]


@pytest.mark.asyncio
async def test_solve_unknown_job_returns_404(api: AsyncClient) -> None:
    res = await api.post("/api/solve", json={"job_id": "nope", "problem_numbers": [1]})
    assert res.status_code == 404
    assert res.json()["detail"]["error_code"] == "job_not_found"


@pytest.mark.asyncio
@pytest.mark.skipif(not PDF_PATH.is_file(), reason="샘플 PDF 없음")
async def test_solve_validates_model_and_numbers_before_api_key(
    api: AsyncClient,
) -> None:
    extract = await api.post(
        "/api/extract",
        files={"file": (PDF_PATH.name, PDF_PATH.read_bytes(), "application/pdf")},
    )
    job_id = extract.json()["job_id"]

    bad_model = await api.post(
        "/api/solve",
        json={"job_id": job_id, "problem_numbers": [1], "model": "gpt-9"},
    )
    assert bad_model.status_code == 400
    assert bad_model.json()["detail"]["error_code"] == "unknown_model"

    bad_no = await api.post(
        "/api/solve", json={"job_id": job_id, "problem_numbers": [99]}
    )
    assert bad_no.status_code == 400
    assert bad_no.json()["detail"]["error_code"] == "problem_not_found"


@pytest.mark.asyncio
async def test_solve_rejects_empty_problem_numbers(api: AsyncClient) -> None:
    res = await api.post("/api/solve", json={"job_id": "x", "problem_numbers": []})
    assert res.status_code == 422


# ------------------------------------------------------------------ 합계
def test_build_totals_projects_full_paper_cost() -> None:
    outcomes = [
        solver.SolveOutcome(
            no=n,
            ok=True,
            mode="image",
            model="claude-opus-5",
            effort="medium",
            cost=pricing.calc_cost(
                "claude-opus-5",
                {
                    "input_tokens": 100,
                    "output_tokens": 1000,
                    "cache_creation_input_tokens": 1800 if n == 1 else 0,
                    "cache_read_input_tokens": 0 if n == 1 else 1800,
                },
            ),
        )
        for n in (1, 2)
    ]
    totals = main._build_totals(outcomes, total_problem_count=22)

    assert totals.solved_count == 2
    assert totals.ok_count == 2
    assert totals.cache_write_tokens == 1800
    assert totals.cache_read_tokens == 1800
    assert totals.total_usd == pytest.approx(sum(o.cost["total_usd"] for o in outcomes))
    assert totals.projected_all_usd == pytest.approx(totals.total_usd / 2 * 22)
    assert totals.total_krw == pytest.approx(totals.total_usd * pricing.USD_KRW)


def test_build_totals_handles_all_failures() -> None:
    outcomes = [
        solver.SolveOutcome(
            no=1,
            ok=False,
            mode="image",
            model="claude-opus-5",
            effort="medium",
            error="boom",
            cost=pricing.calc_cost("claude-opus-5", {}),
        )
    ]
    totals = main._build_totals(outcomes, total_problem_count=22)
    assert totals.total_usd == 0.0
    assert totals.projected_all_usd == 0.0
