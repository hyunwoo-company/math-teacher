"""판독본 읽기·편집 API.

- 파일 상세(`GET /api/files/{id}`)에는 **배지용 요약만** 실린다
  (`has_transcript` / `transcript_source` / `transcript_note`). 전문은 무겁다.
- 전문은 `GET /api/files/{id}/transcripts` 로 받는다(풀이의 `/solutions` 와 같은 형태).
- 편집은 `PATCH /api/files/{id}/problems/{no}/transcript` 이고 저장하면
  `transcript_source='manual'` 이다. 빈 문자열은 되돌리기(삭제)다.
- 3단계 규칙 확인: `manual` 은 `force` 없는 재실행이 덮지 않고, 재추출은 판독본을 지운다.
"""

from __future__ import annotations

from conftest import upload_test_pdf
from fastapi.testclient import TestClient

import config
import storage

TRANSCRIPT = r"두 다항식 \(A=3x^{2}-xy\) 에 대하여 \(\frac{1}{2}A\) 를 구하시오. [3점]"


def _set_transcript(
    node_id: str,
    no: int,
    text: str = TRANSCRIPT,
    source: str = storage.TRANSCRIPT_PUA,
) -> None:
    """판독본을 직접 저장한다(작업 큐·AI 를 거치지 않는다)."""
    with storage.transaction() as conn:
        assert storage.set_transcript(
            conn,
            node_id=node_id,
            no=no,
            transcript=text,
            source=source,
            note=None,
            overwrite_manual=True,
        )


# ─────────────────────────── 조회 ────────────────────────────────────────────


def test_file_detail_carries_transcript_badges(client: TestClient) -> None:
    """파일 상세에는 배지용 요약만 실린다(전문은 전용 라우트)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    with storage.transaction() as conn:
        storage.set_transcript_note(
            conn, node_id=node_id, no=2, note="불가 - 좌표평면 그래프"
        )

    problems = client.get(f"/api/files/{node_id}").json()["problems"]
    by_no = {problem["no"]: problem for problem in problems}
    assert by_no[1]["has_transcript"] is True
    assert by_no[1]["transcript_source"] == storage.TRANSCRIPT_PUA
    assert by_no[1]["transcript_note"] is None
    # 전문은 싣지 않는다 — 응답이 문항 수 x 최대 2만 자로 불어나는 것을 막는다.
    assert "transcript" not in by_no[1]
    assert by_no[2]["has_transcript"] is False
    assert by_no[2]["transcript_note"] == "불가 - 좌표평면 그래프"
    assert by_no[3]["has_transcript"] is False
    assert by_no[3]["transcript_source"] is None


def test_transcripts_route_returns_only_judged_problems(client: TestClient) -> None:
    """판독본/이유가 있는 문항만 번호 순으로 돌려준다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 2)
    with storage.transaction() as conn:
        storage.set_transcript_note(conn, node_id=node_id, no=1, note="불가 - 도형")

    payload = client.get(f"/api/files/{node_id}/transcripts").json()
    assert payload["transcripts"] == [
        {
            "no": 1,
            "transcript": None,
            "transcript_source": None,
            "transcript_note": "불가 - 도형",
        },
        {
            "no": 2,
            "transcript": TRANSCRIPT,
            "transcript_source": storage.TRANSCRIPT_PUA,
            "transcript_note": None,
        },
    ]


def test_transcripts_route_is_empty_before_transcribing(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    assert client.get(f"/api/files/{node_id}/transcripts").json() == {"transcripts": []}


def test_transcripts_route_404_for_unknown_file(client: TestClient) -> None:
    assert client.get("/api/files/nope/transcripts").status_code == 404


# ─────────────────────────── 편집 ────────────────────────────────────────────


def test_patch_transcript_marks_manual(client: TestClient) -> None:
    """저장하면 출처가 `manual` 이 되고 앞뒤 공백은 정리된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)

    response = client.patch(
        f"/api/files/{node_id}/problems/1/transcript",
        json={"text": "  사람이 고친 전문  "},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "no": 1,
        "transcript": "사람이 고친 전문",
        "transcript_source": storage.TRANSCRIPT_MANUAL,
        "transcript_note": None,
    }
    assert client.get(f"/api/files/{node_id}/transcripts").json()["transcripts"] == [
        {
            "no": 1,
            "transcript": "사람이 고친 전문",
            "transcript_source": storage.TRANSCRIPT_MANUAL,
            "transcript_note": None,
        }
    ]


def test_patch_transcript_with_empty_text_clears_it(client: TestClient) -> None:
    """빈 문자열은 되돌리기다 — 판독본·출처·이유가 모두 비고 재실행 대상이 된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    with storage.transaction() as conn:
        storage.set_transcript_note(
            conn, node_id=node_id, no=1, note="예전 이유", overwrite_manual=True
        )

    response = client.patch(
        f"/api/files/{node_id}/problems/1/transcript", json={"text": "   "}
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "no": 1,
        "transcript": None,
        "transcript_source": None,
        "transcript_note": None,
    }
    with storage.transaction() as conn:
        assert storage.transcribed_numbers(conn, node_id) == set()


def test_patch_transcript_accepts_the_length_limit(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.patch(
        f"/api/files/{node_id}/problems/1/transcript",
        json={"text": "가" * config.MAX_TRANSCRIPT_LENGTH},
    )
    assert response.status_code == 200, response.text


def test_patch_transcript_rejects_too_long_text(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.patch(
        f"/api/files/{node_id}/problems/1/transcript",
        json={"text": "가" * (config.MAX_TRANSCRIPT_LENGTH + 1)},
    )
    assert response.status_code == 422


def test_patch_transcript_404_for_unknown_problem(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.patch(
        f"/api/files/{node_id}/problems/999/transcript", json={"text": "본문"}
    )
    assert response.status_code == 404
    assert response.json()["message"] == "999번 문항이 없습니다."


def test_patch_transcript_404_for_unknown_file(client: TestClient) -> None:
    response = client.patch(
        "/api/files/nope/problems/1/transcript", json={"text": "본문"}
    )
    assert response.status_code == 404


# ─────────────────────── 3단계 규칙 확인(회귀 방지) ───────────────────────────


def test_manual_transcript_is_not_overwritten_without_force(client: TestClient) -> None:
    """`force` 없는 저장은 사용자가 고친 판독본을 덮지 않는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    assert (
        client.patch(
            f"/api/files/{node_id}/problems/1/transcript", json={"text": "사람 전문"}
        ).status_code
        == 200
    )

    with storage.transaction() as conn:
        assert (
            storage.set_transcript(
                conn,
                node_id=node_id,
                no=1,
                transcript="기계 전문",
                source=storage.TRANSCRIPT_PUA,
                note=None,
            )
            is False
        )
        problem = storage.get_problem(conn, node_id, 1)
    assert problem is not None
    assert problem["transcript"] == "사람 전문"
    assert problem["transcript_source"] == storage.TRANSCRIPT_MANUAL


def test_reextract_clears_transcripts(client: TestClient) -> None:
    """재추출은 판독본도 지운다(문항 번호가 달라질 수 있다)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)

    assert client.post(f"/api/files/{node_id}/reextract").status_code == 200
    with storage.transaction() as conn:
        assert storage.transcribed_numbers(conn, node_id) == set()
    assert client.get(f"/api/files/{node_id}/transcripts").json()["transcripts"] == []
