"""'문제만' DOCX 내보내기 엔드포인트 테스트.

- 정상: 200 + 유효한 docx(zip 시그니처 PK) + 문항 수만큼 이미지.
- 문항 0개: 400.
- 인증: 비번 설정 시 헤더 없으면 401, `?access=`/헤더면 통과.
"""

from __future__ import annotations

import io
import zipfile

import pytest
from conftest import upload_test_pdf
from fastapi.testclient import TestClient

import config

DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


def test_export_docx_contains_all_problem_images(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.get(f"/api/files/{node_id}/export.docx")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(DOCX_MEDIA_TYPE)
    # docx 는 zip 컨테이너 → 시그니처 PK.
    assert response.content[:2] == b"PK"

    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment; filename*=UTF-8''")
    assert disposition.endswith("_%EB%AC%B8%EC%A0%9C.docx")  # "_문제.docx"

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        media = [n for n in archive.namelist() if n.startswith("word/media/")]
    # 문항 22개 = 이미지 22개.
    assert len(media) == 22


def test_export_docx_no_problems_400(client: TestClient) -> None:
    response = client.post(
        "/api/files",
        files={"file": ("깨진파일.pdf", b"%PDF-1.7\nnot a pdf", "application/pdf")},
    )
    node_id = response.json()["node"]["id"]

    result = client.get(f"/api/files/{node_id}/export.docx")
    assert result.status_code == 400
    assert result.json()["error_code"] == "no_problems"


def test_export_docx_unknown_file_404(client: TestClient) -> None:
    result = client.get("/api/files/does-not-exist/export.docx")
    assert result.status_code == 404


def test_export_docx_requires_access_password(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    # 업로드 후 비밀번호를 켠다(미들웨어는 요청 시점에 env 를 읽는다).
    password = "unit-test-pw-export"
    monkeypatch.setenv(config.ACCESS_PASSWORD_ENV, password)

    path = f"/api/files/{node_id}/export.docx"
    assert client.get(path).status_code == 401
    assert client.get(f"{path}?access={password}").status_code == 200
    assert (
        client.get(path, headers={"X-Access-Password": password}).status_code == 200
    )
