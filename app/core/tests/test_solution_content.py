"""`POST /api/files/{id}/problems/{no}/solution` (내용으로 풀이 저장)."""

from __future__ import annotations

from conftest import upload_test_pdf
from fastapi.testclient import TestClient


def test_save_content_appears_in_solutions(client: TestClient) -> None:
    """저장한 내용이 `GET /solutions` 와 문항의 `has_solution` 에 반영된다."""
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.post(
        f"/api/files/{node_id}/problems/1/solution",
        json={"content": "대화에서 정리한 풀이", "source": "chat"},
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["no"] == 1
    assert saved["solution"] == "대화에서 정리한 풀이"
    assert saved["cost"] is None  # agy 사용이라 비용 없음.
    assert saved["usage"] is None
    assert saved["truncated"] is False
    assert saved["created_at"]

    solutions = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["no"] for item in solutions] == [1]
    assert solutions[0]["solution"] == "대화에서 정리한 풀이"

    detail = client.get(f"/api/files/{node_id}").json()
    by_no = {problem["no"]: problem for problem in detail["problems"]}
    assert by_no[1]["has_solution"] is True


def test_save_content_with_usage(client: TestClient) -> None:
    """`usage` 를 주면 그대로 저장된다."""
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.post(
        f"/api/files/{node_id}/problems/2/solution",
        json={"content": "풀이", "usage": {"input_tokens": 10, "output_tokens": 20}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["usage"] == {"input_tokens": 10, "output_tokens": 20}


def test_resave_overwrites_existing(client: TestClient) -> None:
    """같은 문항에 다시 저장하면 덮어쓴다(중복 생성 안 됨)."""
    node_id = upload_test_pdf(client)["node"]["id"]

    first = client.post(
        f"/api/files/{node_id}/problems/1/solution",
        json={"content": "첫 번째 풀이"},
    )
    assert first.status_code == 200, first.text

    second = client.post(
        f"/api/files/{node_id}/problems/1/solution",
        json={"content": "덮어쓴 풀이"},
    )
    assert second.status_code == 200, second.text

    solutions = client.get(f"/api/files/{node_id}/solutions").json()["solutions"]
    assert [item["no"] for item in solutions] == [1]
    assert solutions[0]["solution"] == "덮어쓴 풀이"


def test_unknown_problem_number_404(client: TestClient) -> None:
    """추출되지 않은 문항 번호는 거부한다."""
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.post(
        f"/api/files/{node_id}/problems/999/solution",
        json={"content": "풀이"},
    )
    assert response.status_code == 404
    assert response.json()["error_code"] == "not_found"


def test_missing_file_404(client: TestClient) -> None:
    """없는 파일에 저장하면 404."""
    response = client.post(
        "/api/files/nonexistent/problems/1/solution",
        json={"content": "풀이"},
    )
    assert response.status_code == 404


def test_empty_content_rejected(client: TestClient) -> None:
    """빈 내용은 검증에서 거부한다(422)."""
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.post(
        f"/api/files/{node_id}/problems/1/solution",
        json={"content": ""},
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "invalid_request"
