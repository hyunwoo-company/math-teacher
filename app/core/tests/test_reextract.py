"""재추출(`POST /api/files/{id}/reextract`) 테스트 (AI 호출 없음).

extractor 를 고친 뒤 기존 업로드분에 반영하려면 예전에는 파일을 지우고 다시
올려야 했다. 이 라우트가 그 왕복을 없앤다.
"""

from __future__ import annotations

from conftest import upload_test_pdf
from fastapi.testclient import TestClient

import config


def test_reextract_keeps_same_problems(client: TestClient) -> None:
    """같은 원본을 다시 추출하면 문항이 그대로 나온다."""
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.post(f"/api/files/{node_id}/reextract")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["extract_error"] is None
    assert [problem["no"] for problem in body["problems"]] == list(range(1, 23))
    assert body["node"]["file"]["problem_count"] == 22
    assert body["deleted_solutions"] == 0


def test_reextract_deletes_existing_solutions(client: TestClient) -> None:
    """재추출은 기존 풀이를 지우고 건수를 알려준다.

    문항 번호·영역이 달라질 수 있어 예전 풀이가 다른 문제에 붙는 것을 막는다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]
    saved = client.post(
        f"/api/files/{node_id}/problems/1/solution",
        json={"content": "## 정답\n1번 답"},
    )
    assert saved.status_code == 200, saved.text
    assert client.get(f"/api/files/{node_id}/solutions").json()["solutions"]

    body = client.post(f"/api/files/{node_id}/reextract").json()
    assert body["deleted_solutions"] == 1
    assert client.get(f"/api/files/{node_id}/solutions").json()["solutions"] == []
    # 문항 자체는 다시 채워져 있어야 한다.
    assert len(body["problems"]) == 22
    assert all(problem["has_solution"] is False for problem in body["problems"])


def test_reextract_leaves_note_items_intact(client: TestClient) -> None:
    """오답노트 항목은 스냅샷을 갖고 있으므로 재추출에도 남는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    note_id = client.post("/api/notes", json={"name": "이현우 오답"}).json()["node"]["id"]
    added = client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": node_id, "problem_numbers": [3, 5]},
    )
    assert added.status_code == 201, added.text

    client.post(f"/api/files/{node_id}/reextract")

    items = client.get(f"/api/notes/{note_id}").json()["items"]
    assert [item["problem_no"] for item in items] == [3, 5]
    assert all(item["source_available"] for item in items)
    # 스냅샷 이미지도 여전히 내려받을 수 있어야 한다.
    crop = client.get(f"/api/notes/{note_id}/items/{items[0]['id']}/crop")
    assert crop.status_code == 200
    assert crop.content.startswith(b"\x89PNG")


def test_reextract_clears_stale_crops(client: TestClient) -> None:
    """예전 크롭이 남아 새 결과와 섞이지 않는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    crop_dir = config.crops_dir() / node_id
    stale = crop_dir / "q99.png"
    stale.write_bytes(b"\x89PNG stale")

    client.post(f"/api/files/{node_id}/reextract")

    assert not stale.exists()
    assert (crop_dir / "q01.png").is_file()


def test_reextract_missing_raw_returns_400(client: TestClient) -> None:
    """원본 PDF 가 사라졌으면 400 과 한국어 안내."""
    node_id = upload_test_pdf(client)["node"]["id"]
    (config.files_dir() / f"{node_id}.pdf").unlink()

    response = client.post(f"/api/files/{node_id}/reextract")
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "raw_missing"
    assert "원본" in body["message"]
    assert body["hint"] is not None


def test_reextract_unknown_node_404(client: TestClient) -> None:
    response = client.post("/api/files/does-not-exist/reextract")
    assert response.status_code == 404


def test_reextract_rejects_folder(client: TestClient) -> None:
    """폴더 노드에는 재추출을 걸 수 없다."""
    folder_id = client.post("/api/folders", json={"name": "2학기"}).json()["node"]["id"]
    response = client.post(f"/api/files/{folder_id}/reextract")
    assert response.status_code in (400, 404)
