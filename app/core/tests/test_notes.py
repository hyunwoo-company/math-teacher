"""오답노트 섹션 테스트 (ARCHITECTURE 6-A). AI 호출 없음."""

from __future__ import annotations

from typing import Any

from conftest import make_folder, make_note, upload_test_pdf
from fastapi.testclient import TestClient

import config


def _add_items(
    client: TestClient,
    note_id: str,
    source_id: str,
    numbers: list[int],
    memo: str | None = None,
) -> dict[str, Any]:
    response = client.post(
        f"/api/notes/{note_id}/items",
        json={
            "source_node_id": source_id,
            "problem_numbers": numbers,
            "memo": memo,
        },
    )
    assert response.status_code == 201, response.text
    payload: dict[str, Any] = response.json()
    return payload


# ---------------------------------------------------------------- 섹션 트리
def test_tree_default_section_is_exam(client: TestClient) -> None:
    exam_folder = make_folder(client, "시험지폴더")
    note_folder = make_folder(client, "이현우", section="note")

    default_ids = [node["id"] for node in client.get("/api/tree").json()["nodes"]]
    assert default_ids == [exam_folder]

    exam_ids = [
        node["id"]
        for node in client.get("/api/tree", params={"section": "exam"}).json()["nodes"]
    ]
    assert exam_ids == [exam_folder]

    note_nodes = client.get("/api/tree", params={"section": "note"}).json()["nodes"]
    assert [node["id"] for node in note_nodes] == [note_folder]
    assert note_nodes[0]["section"] == "note"


def test_unknown_section_rejected(client: TestClient) -> None:
    assert client.get("/api/tree", params={"section": "wrong"}).status_code == 422


def test_note_folder_nesting(client: TestClient) -> None:
    student = make_folder(client, "이현우", section="note")
    unit = make_folder(client, "이차방정식", student, section="note")
    note_id = make_note(client, "중간고사 오답", unit)

    nodes = {
        node["id"]: node
        for node in client.get("/api/tree", params={"section": "note"}).json()["nodes"]
    }
    assert nodes[unit]["parent_id"] == student
    assert nodes[note_id]["parent_id"] == unit
    assert nodes[note_id]["type"] == "file"
    assert nodes[note_id]["section"] == "note"
    assert nodes[note_id]["file"] is None


def test_folder_section_must_match_parent(client: TestClient) -> None:
    exam_folder = make_folder(client, "시험지폴더")
    response = client.post(
        "/api/folders",
        json={"name": "잘못된노트", "parent_id": exam_folder, "section": "note"},
    )
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "section_mismatch"
    assert "오답노트" in body["message"]


def test_note_cannot_be_created_under_exam_folder(client: TestClient) -> None:
    exam_folder = make_folder(client, "시험지폴더")
    response = client.post(
        "/api/notes", json={"name": "노트", "parent_id": exam_folder}
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "section_mismatch"


def test_cross_section_move_rejected(client: TestClient) -> None:
    exam_folder = make_folder(client, "시험지폴더")
    note_folder = make_folder(client, "오답폴더", section="note")
    note_id = make_note(client, "노트", note_folder)

    moved = client.patch(f"/api/nodes/{note_id}", json={"parent_id": exam_folder})
    assert moved.status_code == 400
    assert moved.json()["error_code"] == "section_mismatch"

    back = client.patch(f"/api/nodes/{exam_folder}", json={"parent_id": note_folder})
    assert back.status_code == 400
    assert back.json()["error_code"] == "section_mismatch"


def test_same_section_move_allowed(client: TestClient) -> None:
    first = make_folder(client, "A", section="note")
    second = make_folder(client, "B", section="note")
    note_id = make_note(client, "노트", first)
    moved = client.patch(f"/api/nodes/{note_id}", json={"parent_id": second})
    assert moved.status_code == 200
    assert moved.json()["node"]["parent_id"] == second
    assert moved.json()["node"]["section"] == "note"


# ------------------------------------------------------------------- 항목
def test_add_items_is_idempotent(client: TestClient) -> None:
    note_id = make_note(client, "이현우 중간고사 오답")
    source_id = upload_test_pdf(client)["node"]["id"]

    first = _add_items(client, note_id, source_id, [5, 6], memo="계산 실수")
    assert first == {"added": [5, 6], "skipped": []}

    second = _add_items(client, note_id, source_id, [5, 6])
    assert second == {"added": [], "skipped": [5, 6]}

    third = _add_items(client, note_id, source_id, [6, 7])
    assert third == {"added": [7], "skipped": [6]}

    items = client.get(f"/api/notes/{note_id}").json()["items"]
    assert [item["problem_no"] for item in items] == [5, 6, 7]
    assert items[0]["memo"] == "계산 실수"
    assert items[2]["memo"] is None


def test_note_detail_exposes_crop_snapshot(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    payload = upload_test_pdf(client)
    source_id = payload["node"]["id"]
    source_name = payload["node"]["name"]
    _add_items(client, note_id, source_id, [5])

    detail = client.get(f"/api/notes/{note_id}").json()
    assert detail["node"]["id"] == note_id
    item = detail["items"][0]
    assert item["source_node_id"] == source_id
    assert item["source_name"] == source_name
    assert item["source_available"] is True
    assert item["crop_url"] == f"/api/notes/{note_id}/items/{item['id']}/crop"

    crop = client.get(item["crop_url"])
    assert crop.status_code == 200
    assert crop.headers["content-type"] == "image/png"
    assert crop.content.startswith(b"\x89PNG")

    # 스냅샷은 원본 크롭과 별도 파일이어야 한다(원본이 지워져도 남도록).
    snapshot = config.note_crops_dir() / f"{item['id']}.png"
    assert snapshot.is_file()
    assert snapshot.read_bytes() == (
        config.crops_dir() / source_id / "q05.png"
    ).read_bytes()


def test_source_delete_preserves_note_items(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    source_id = upload_test_pdf(client)["node"]["id"]
    _add_items(client, note_id, source_id, [5, 6])
    item = client.get(f"/api/notes/{note_id}").json()["items"][0]
    crop_url = item["crop_url"]

    assert client.delete(f"/api/nodes/{source_id}").status_code == 200

    detail = client.get(f"/api/notes/{note_id}").json()
    assert [i["problem_no"] for i in detail["items"]] == [5, 6]
    assert all(i["source_node_id"] is None for i in detail["items"])
    assert all(i["source_available"] is False for i in detail["items"])
    # 이름 스냅샷은 남는다.
    assert all(i["source_name"].endswith(".pdf") for i in detail["items"])
    # 크롭 스냅샷도 계속 서빙된다.
    crop = client.get(crop_url)
    assert crop.status_code == 200
    assert crop.content.startswith(b"\x89PNG")
    assert detail["items"][0]["crop_url"] == crop_url


def test_exam_folder_delete_preserves_note_items(client: TestClient) -> None:
    folder = make_folder(client, "시험지")
    note_id = make_note(client, "노트")
    source_id = upload_test_pdf(client, folder)["node"]["id"]
    _add_items(client, note_id, source_id, [1])

    assert client.delete(f"/api/nodes/{folder}").status_code == 200
    items = client.get(f"/api/notes/{note_id}").json()["items"]
    assert len(items) == 1
    assert items[0]["source_available"] is False
    assert client.get(items[0]["crop_url"]).status_code == 200


def test_note_delete_removes_items_and_snapshots(client: TestClient) -> None:
    note_folder = make_folder(client, "이현우", section="note")
    note_id = make_note(client, "노트", note_folder)
    source_id = upload_test_pdf(client)["node"]["id"]
    _add_items(client, note_id, source_id, [1, 2])
    items = client.get(f"/api/notes/{note_id}").json()["items"]
    snapshots = [config.note_crops_dir() / f"{item['id']}.png" for item in items]
    assert all(path.is_file() for path in snapshots)

    # 노트 폴더를 지우면 그 안의 노트 항목과 스냅샷은 지워진다.
    assert client.delete(f"/api/nodes/{note_folder}").status_code == 200
    assert not any(path.exists() for path in snapshots)
    assert client.get(f"/api/notes/{note_id}").status_code == 404
    # 원본 시험지는 그대로다.
    assert client.get(f"/api/files/{source_id}").status_code == 200


def test_delete_single_item(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    source_id = upload_test_pdf(client)["node"]["id"]
    _add_items(client, note_id, source_id, [1, 2])
    items = client.get(f"/api/notes/{note_id}").json()["items"]
    target = items[0]

    assert client.delete(f"/api/notes/{note_id}/items/{target['id']}").json() == {
        "ok": True
    }
    remaining = client.get(f"/api/notes/{note_id}").json()["items"]
    assert [item["problem_no"] for item in remaining] == [2]
    assert not (config.note_crops_dir() / f"{target['id']}.png").exists()
    assert client.get(target["crop_url"]).status_code == 404
    # 삭제 후 다시 담을 수 있다(멱등 제약이 남지 않는다).
    assert _add_items(client, note_id, source_id, [1]) == {"added": [1], "skipped": []}


def test_delete_item_from_other_note_404(client: TestClient) -> None:
    first = make_note(client, "노트1")
    second = make_note(client, "노트2")
    source_id = upload_test_pdf(client)["node"]["id"]
    _add_items(client, first, source_id, [1])
    item_id = client.get(f"/api/notes/{first}").json()["items"][0]["id"]

    assert client.delete(f"/api/notes/{second}/items/{item_id}").status_code == 404
    assert len(client.get(f"/api/notes/{first}").json()["items"]) == 1


def test_add_unknown_problem_number_400(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    source_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": source_id, "problem_numbers": [1, 99]},
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "problem_not_found"
    assert client.get(f"/api/notes/{note_id}").json()["items"] == []


def test_note_endpoints_reject_exam_file(client: TestClient) -> None:
    source_id = upload_test_pdf(client)["node"]["id"]
    response = client.get(f"/api/notes/{source_id}")
    assert response.status_code == 400
    assert response.json()["error_code"] == "not_a_note"


def test_file_endpoints_reject_note_node(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    response = client.get(f"/api/files/{note_id}")
    assert response.status_code == 400
    assert response.json()["error_code"] == "not_a_file"


def test_add_items_with_note_as_source_400(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    other = make_note(client, "다른노트")
    response = client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": other, "problem_numbers": [1]},
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "not_a_file"


def test_unknown_note_404(client: TestClient) -> None:
    assert client.get("/api/notes/없는아이디").status_code == 404


def test_empty_problem_numbers_rejected(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    source_id = upload_test_pdf(client)["node"]["id"]
    response = client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": source_id, "problem_numbers": []},
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "invalid_request"


def test_two_sources_same_problem_number_coexist(client: TestClient) -> None:
    note_id = make_note(client, "노트")
    first = upload_test_pdf(client)["node"]["id"]
    second = upload_test_pdf(client)["node"]["id"]
    _add_items(client, note_id, first, [5])
    _add_items(client, note_id, second, [5])
    items = client.get(f"/api/notes/{note_id}").json()["items"]
    assert len(items) == 2
    assert {item["source_node_id"] for item in items} == {first, second}
