"""트리 CRUD / 순환 참조 / 재귀 삭제 테스트."""

from __future__ import annotations

from conftest import make_folder
from fastapi.testclient import TestClient


def test_empty_tree(client: TestClient) -> None:
    response = client.get("/api/tree")
    assert response.status_code == 200
    assert response.json() == {"nodes": []}


def test_nested_folders(client: TestClient) -> None:
    root = make_folder(client, "2026-1학기")
    child = make_folder(client, "공통수학1", root)
    grandchild = make_folder(client, "중간고사", child)

    nodes = {node["id"]: node for node in client.get("/api/tree").json()["nodes"]}
    assert nodes[root]["parent_id"] is None
    assert nodes[child]["parent_id"] == root
    assert nodes[grandchild]["parent_id"] == child
    assert nodes[root]["type"] == "folder"
    assert nodes[root]["file"] is None


def test_folders_sorted_before_files_and_by_name(client: TestClient) -> None:
    make_folder(client, "하")
    make_folder(client, "가")
    make_folder(client, "나")
    names = [node["name"] for node in client.get("/api/tree").json()["nodes"]]
    assert names == ["가", "나", "하"]


def test_duplicate_names_allowed(client: TestClient) -> None:
    parent = make_folder(client, "부모")
    first = make_folder(client, "같은이름", parent)
    second = make_folder(client, "같은이름", parent)
    assert first != second


def test_rename(client: TestClient) -> None:
    node_id = make_folder(client, "옛이름")
    response = client.patch(f"/api/nodes/{node_id}", json={"name": "새이름"})
    assert response.status_code == 200
    assert response.json()["node"]["name"] == "새이름"


def test_blank_name_rejected(client: TestClient) -> None:
    response = client.post("/api/folders", json={"name": "   ", "parent_id": None})
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "invalid_name"
    assert "이름" in body["message"]


def test_move_to_other_parent_and_root(client: TestClient) -> None:
    first = make_folder(client, "A")
    second = make_folder(client, "B")
    moved = client.patch(f"/api/nodes/{second}", json={"parent_id": first})
    assert moved.status_code == 200
    assert moved.json()["node"]["parent_id"] == first

    back = client.patch(f"/api/nodes/{second}", json={"parent_id": None})
    assert back.status_code == 200
    assert back.json()["node"]["parent_id"] is None


def test_rename_only_keeps_parent(client: TestClient) -> None:
    parent = make_folder(client, "부모")
    child = make_folder(client, "자식", parent)
    response = client.patch(f"/api/nodes/{child}", json={"name": "자식2"})
    assert response.status_code == 200
    assert response.json()["node"]["parent_id"] == parent


def test_move_into_self_rejected(client: TestClient) -> None:
    node_id = make_folder(client, "자기")
    response = client.patch(f"/api/nodes/{node_id}", json={"parent_id": node_id})
    assert response.status_code == 400
    assert response.json()["error_code"] == "cycle_detected"


def test_move_into_descendant_rejected(client: TestClient) -> None:
    root = make_folder(client, "root")
    child = make_folder(client, "child", root)
    grandchild = make_folder(client, "grandchild", child)

    response = client.patch(f"/api/nodes/{root}", json={"parent_id": grandchild})
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "cycle_detected"
    assert "하위 폴더" in body["message"]


def test_unknown_parent_rejected(client: TestClient) -> None:
    response = client.post("/api/folders", json={"name": "x", "parent_id": "없는아이디"})
    assert response.status_code == 400
    assert response.json()["error_code"] == "parent_not_found"


def test_patch_unknown_node_404(client: TestClient) -> None:
    response = client.patch("/api/nodes/unknown", json={"name": "x"})
    assert response.status_code == 404
    assert response.json()["error_code"] == "not_found"


def test_recursive_delete(client: TestClient) -> None:
    root = make_folder(client, "root")
    child = make_folder(client, "child", root)
    make_folder(client, "grandchild", child)
    keep = make_folder(client, "keep")

    response = client.delete(f"/api/nodes/{root}")
    assert response.status_code == 200
    assert response.json() == {"ok": True}

    remaining = [node["id"] for node in client.get("/api/tree").json()["nodes"]]
    assert remaining == [keep]


def test_delete_unknown_node_404(client: TestClient) -> None:
    response = client.delete("/api/nodes/unknown")
    assert response.status_code == 404
