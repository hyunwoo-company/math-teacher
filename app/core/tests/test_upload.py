"""업로드/추출/크롭 테스트 (AI 호출 없음)."""

from __future__ import annotations

from conftest import make_folder, upload_test_pdf
from fastapi.testclient import TestClient

import config


def test_upload_extracts_22_problems(client: TestClient) -> None:
    payload = upload_test_pdf(client)
    node = payload["node"]
    assert payload["extract_error"] is None
    assert node["type"] == "file"
    assert node["file"]["problem_count"] == 22
    assert node["file"]["mode"] == "image"
    assert node["file"]["pages"] == 7
    assert 0.38 <= node["file"]["pua_ratio"] <= 0.40


def test_file_detail_and_crop(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]

    detail = client.get(f"/api/files/{node_id}")
    assert detail.status_code == 200
    problems = detail.json()["problems"]
    assert [problem["no"] for problem in problems] == list(range(1, 23))
    assert all(problem["has_solution"] is False for problem in problems)
    assert problems[0]["image_w"] > 0 and problems[0]["image_h"] > 0

    crop = client.get(f"/api/files/{node_id}/problems/1/crop")
    assert crop.status_code == 200
    assert crop.headers["content-type"] == "image/png"
    assert crop.content.startswith(b"\x89PNG")

    raw = client.get(f"/api/files/{node_id}/raw")
    assert raw.status_code == 200
    assert raw.headers["content-type"] == "application/pdf"
    assert raw.content.startswith(b"%PDF")


def test_crop_unknown_number_404(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.get(f"/api/files/{node_id}/problems/99/crop")
    assert response.status_code == 404
    assert "99번" in response.json()["message"]


def test_non_pdf_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/files",
        files={"file": ("메모.txt", b"hello world", "text/plain")},
    )
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "not_a_pdf"
    assert "PDF" in body["message"]
    assert body["hint"] is not None


def test_empty_file_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/files",
        files={"file": ("빈파일.pdf", b"", "application/pdf")},
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "empty_file"


def test_upload_under_folder_and_recursive_delete_removes_assets(
    client: TestClient,
) -> None:
    folder = make_folder(client, "시험지")
    node_id = upload_test_pdf(client, folder)["node"]["id"]

    pdf_path = config.files_dir() / f"{node_id}.pdf"
    crop_dir = config.crops_dir() / node_id
    assert pdf_path.is_file()
    assert len(list(crop_dir.glob("*.png"))) == 22

    assert client.delete(f"/api/nodes/{folder}").status_code == 200
    assert client.get("/api/tree").json() == {"nodes": []}
    assert not pdf_path.exists()
    assert not crop_dir.exists()
    assert client.get(f"/api/files/{node_id}").status_code == 404


def test_file_cannot_be_parent(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.post("/api/folders", json={"name": "안됨", "parent_id": node_id})
    assert response.status_code == 400
    assert response.json()["error_code"] == "parent_not_folder"


def test_broken_pdf_registers_file_with_zero_problems(client: TestClient) -> None:
    response = client.post(
        "/api/files",
        files={
            "file": ("깨진파일.pdf", b"%PDF-1.7\nnot a pdf", "application/pdf")
        },
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["node"]["file"]["problem_count"] == 0
    assert payload["extract_error"] is not None
