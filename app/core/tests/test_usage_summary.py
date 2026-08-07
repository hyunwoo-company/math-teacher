"""토큰 사용량 집계 엔드포인트 테스트 (`GET /api/usage/summary`)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

import storage


def _iso(delta: timedelta) -> str:
    """지금(KST) 에서 `delta` 만큼 떨어진 시각의 ISO 문자열(`now_iso` 포맷)."""
    return (datetime.now(storage.KST) + delta).isoformat(timespec="seconds")


def _insert_solution(
    node_id: str, no: int, usage: dict[str, Any] | None, created_at: str
) -> None:
    with storage.transaction() as conn:
        conn.execute(
            "INSERT INTO solutions"
            " (node_id, no, solution, usage_json, cost_json, truncated, created_at)"
            " VALUES (?, ?, ?, ?, ?, 0, ?)",
            (
                node_id,
                no,
                "풀이",
                None if usage is None else json.dumps(usage),
                None,
                created_at,
            ),
        )


def _insert_chat(
    node_id: str, usage: dict[str, Any] | None, created_at: str
) -> None:
    with storage.transaction() as conn:
        conn.execute(
            "INSERT INTO chat_messages"
            " (node_id, problem_no, role, content, usage_json, cost_json, created_at)"
            " VALUES (?, NULL, 'assistant', ?, ?, ?, ?)",
            (
                node_id,
                "답변",
                None if usage is None else json.dumps(usage),
                None,
                created_at,
            ),
        )


def test_empty_db_returns_all_zeros(client: TestClient) -> None:
    body = client.get("/api/usage/summary").json()
    assert body == {
        "windows": {
            "last_24h": {"tokens": 0, "calls": 0},
            "last_7_days": {"tokens": 0, "calls": 0},
            "total": {"tokens": 0, "calls": 0},
        }
    }


def test_aggregates_across_windows_and_tables(client: TestClient) -> None:
    recent = _iso(timedelta(hours=-1))  # 24h/7d/total
    within_7d = _iso(timedelta(days=-2))  # 7d/total
    old = _iso(timedelta(days=-10))  # total only

    # solutions: total_tokens 우선, 그리고 필드 합(agy 형).
    _insert_solution("f1", 1, {"total_tokens": 100}, recent)
    _insert_solution(
        "f1",
        2,
        {
            "input_tokens": 10,
            "output_tokens": 20,
            "thinking_tokens": 5,
            "cache_read_tokens": 0,
        },
        within_7d,
    )
    # usage 없는 행은 제외된다.
    _insert_solution("f1", 3, None, recent)

    # chat: Anthropic 형(총합 필드 없음) + total_tokens 형.
    _insert_chat(
        "f1",
        {
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_creation_input_tokens": 10,
            "cache_read_input_tokens": 5,
        },
        old,
    )
    _insert_chat("f1", None, recent)  # 제외
    _insert_chat("f1", {"total_tokens": 7}, _iso(timedelta(minutes=-30)))

    windows = client.get("/api/usage/summary").json()["windows"]

    # 24h: solution#1(100) + chat total_tokens(7)
    assert windows["last_24h"] == {"tokens": 107, "calls": 2}
    # 7d: 위 + solution#2(35)
    assert windows["last_7_days"] == {"tokens": 142, "calls": 3}
    # total: 위 + old chat(165)
    assert windows["total"] == {"tokens": 307, "calls": 4}


def test_null_usage_rows_are_excluded(client: TestClient) -> None:
    recent = _iso(timedelta(hours=-1))
    _insert_solution("f2", 1, None, recent)
    _insert_chat("f2", None, recent)

    windows = client.get("/api/usage/summary").json()["windows"]
    assert windows["total"] == {"tokens": 0, "calls": 0}
    assert windows["last_24h"] == {"tokens": 0, "calls": 0}
    assert windows["last_7_days"] == {"tokens": 0, "calls": 0}
