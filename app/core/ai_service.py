"""풀이/채팅 SSE 스트리밍 서비스.

이벤트 이름과 data 스키마는 ARCHITECTURE.md 5항 계약을 그대로 따른다.
    /solve : start / problem / delta / done / error / end
    /chat  : delta / done / error
"""

from __future__ import annotations

import base64
import logging
from collections.abc import AsyncIterator, Sequence
from typing import Any, Final, NamedTuple

import anyio
from fastapi import status
from fastapi.concurrency import run_in_threadpool

import config
import pricing
import prompts
import service
import sse
import storage
from errors import ApiError, bad_request, not_found
from providers import agy as agy_provider
from providers import apikey as apikey_provider
from providers import subscription as subscription_provider
from providers.base import (
    Effort,
    ImagePart,
    Mode,
    Provider,
    ProviderError,
    TextPart,
    Turn,
)

logger: Final[logging.Logger] = logging.getLogger("math_teacher.core.ai")

_USAGE_KEYS: Final[tuple[str, ...]] = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


# ------------------------------------------------------------- 선택/검증
def resolve_provider(requested: str, api_key: str | None) -> Provider:
    """`auto | subscription | apikey | agy` 를 실제 프로바이더로 해석한다.

    `auto` 우선순위는 `agy > subscription > apikey` 다(무과금·빠른 순).

    Raises:
        ApiError: 쓸 수 있는 프로바이더가 없을 때 (409).
    """
    agy_only = config.agy_only()
    subscription_ok = (not agy_only) and subscription_provider.is_available()
    agy_ok = agy_provider.is_available()

    # 배포판(agy 전용): API 키·구독 요청을 명시적으로 차단한다(과금 사고 방지).
    if agy_only and requested in ("apikey", "subscription"):
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "provider_disabled",
            "이 서비스에서는 agy(무과금)만 사용할 수 있습니다.",
            None,
        )

    if requested == "agy":
        if not agy_ok:
            raise ApiError(
                status.HTTP_409_CONFLICT,
                "agy_unavailable",
                "Antigravity CLI(agy) 를 찾을 수 없습니다.",
                "agy 를 설치하고 PATH 에 등록했는지 확인하세요.",
            )
        return agy_provider.AgyProvider()

    if requested == "subscription":
        if not subscription_ok:
            raise ApiError(
                status.HTTP_409_CONFLICT,
                "subscription_unavailable",
                "구독 모드를 쓸 수 없습니다. Claude Code 설치·로그인 상태를 확인하세요.",
                "웹 배포에서는 구독 모드를 쓸 수 없습니다. API 키 모드를 사용하세요.",
            )
        return subscription_provider.SubscriptionProvider()

    if requested == "apikey":
        if not api_key:
            raise ApiError(
                status.HTTP_409_CONFLICT,
                "no_api_key",
                "Anthropic API 키가 설정되어 있지 않습니다.",
                "설정에서 API 키를 저장하거나 요청 헤더 X-Api-Key 로 전달하세요.",
            )
        return apikey_provider.ApiKeyProvider(api_key)

    # auto: agy > subscription > apikey
    if agy_ok:
        return agy_provider.AgyProvider()
    if subscription_ok:
        return subscription_provider.SubscriptionProvider()
    if api_key and not agy_only:
        return apikey_provider.ApiKeyProvider(api_key)
    raise ApiError(
        status.HTTP_409_CONFLICT,
        "no_provider",
        "사용할 수 있는 AI 연결이 없습니다.",
        "Claude Code 에 로그인하거나(구독 모드), 설정에서 Anthropic API 키를 등록하세요.",
    )


def resolve_model(model: str | None, provider: str = "auto") -> str:
    """모델 ID 를 프로바이더에 맞춰 검증한다.

    agy 프로바이더면 agy 화이트리스트로, 그 외(구독/API 키)면 Claude 단가 테이블로
    검증한다. 각 프로바이더의 기본 모델은 별도다.

    Raises:
        ApiError: 해당 프로바이더가 지원하지 않는 모델일 때 (400).
    """
    if provider == "agy":
        candidate = (model or agy_provider.DEFAULT_MODEL).strip()
        if candidate not in agy_provider.AGY_MODELS:
            raise bad_request(
                "unknown_model",
                f"agy 에서 지원하지 않는 모델입니다: {candidate}",
                f"사용 가능: {', '.join(agy_provider.AGY_MODELS)}",
            )
        return candidate

    candidate = (model or pricing.DEFAULT_MODEL).strip()
    try:
        pricing.resolve_model(candidate)
    except pricing.UnknownModelError as exc:
        raise bad_request(
            "unknown_model",
            f"지원하지 않는 모델입니다: {candidate}",
            f"사용 가능: {', '.join(sorted(pricing.MODEL_RATES))}",
        ) from exc
    return candidate


def load_solve_targets(
    node_id: str, numbers: Sequence[int] | None
) -> tuple[Mode, list[dict[str, Any]]]:
    """풀이 대상 문항을 읽어온다 (블로킹).

    Raises:
        ApiError: 파일이 없거나 문항 번호가 잘못됐을 때.
    """
    with storage.transaction() as conn:
        service.require_file_node(conn, node_id)
        meta = storage.get_file(conn, node_id)
        problems = storage.list_problems(conn, node_id)

    mode: Mode = "image" if (meta or {}).get("mode") == "image" else "text"
    by_no = {problem["no"]: problem for problem in problems}

    if not by_no:
        raise bad_request(
            "no_problems",
            "이 파일에는 추출된 문항이 없습니다.",
            "PDF 를 다시 업로드하거나 문항 번호가 있는 시험지인지 확인하세요.",
        )

    if numbers is None:
        targets = [by_no[no] for no in sorted(by_no)]
    else:
        wanted = sorted(dict.fromkeys(int(no) for no in numbers))
        missing = [no for no in wanted if no not in by_no]
        if missing:
            raise bad_request(
                "problem_not_found",
                f"이 파일에 없는 문항 번호입니다: {missing}",
                f"사용 가능한 번호: {sorted(by_no)}",
            )
        targets = [by_no[no] for no in wanted]
    return mode, targets


def load_variant_target(node_id: str, no: int) -> tuple[Mode, dict[str, Any]]:
    """변형 소스 문항 1건을 읽어온다 (블로킹).

    풀이(`load_solve_targets`)와 달리 경로 파라미터 `{no}` 를 쓰는 엔드포인트라
    없는 문항은 404 로 알린다(크롭·풀이 저장 엔드포인트와 동일한 규칙).

    Raises:
        ApiError: 파일이 없을 때(404) 또는 문항 번호가 없을 때(404).
    """
    with storage.transaction() as conn:
        service.require_file_node(conn, node_id)
        meta = storage.get_file(conn, node_id)
        problem = storage.get_problem(conn, node_id, no)
    if problem is None:
        raise not_found(
            f"{no}번 문항이 없습니다.",
            "문제 목록을 새로고침해 번호를 확인하세요.",
        )
    mode: Mode = "image" if (meta or {}).get("mode") == "image" else "text"
    return mode, problem


def _read_crop_b64(problem: dict[str, Any]) -> str | None:
    """크롭 PNG 를 base64 로 읽는다 (블로킹). 없으면 None."""
    path = config.data_dir() / str(problem["crop_path"])
    if not path.is_file():
        return None
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _accumulate(total: dict[str, int], usage: dict[str, Any] | None) -> bool:
    """실측 usage 를 합산한다. 합산했으면 True."""
    if not usage:
        return False
    counted = pricing.normalize_usage(usage)
    for key in _USAGE_KEYS:
        total[key] += counted[key]
    return True


# ------------------------------------------------------------------ solve
async def solve_stream(
    *,
    node_id: str,
    provider: Provider,
    mode: Mode,
    targets: Sequence[dict[str, Any]],
    model: str,
    effort: Effort,
) -> AsyncIterator[str]:
    """문항들을 순차로 풀며 SSE 문자열을 흘린다.

    캐시 히트를 노리려면 순차 호출이어야 한다(첫 호출이 캐시를 쓰고 이후가 읽는다).
    """
    total_usage: dict[str, int] = dict.fromkeys(_USAGE_KEYS, 0)
    total_usd = 0.0
    has_usage = False
    has_cost = False

    try:
        yield sse.event("start", {"total": len(targets)})

        for problem in targets:
            no = int(problem["no"])
            yield sse.event("problem", {"no": no, "status": "running"})
            try:
                image_b64 = (
                    await run_in_threadpool(_read_crop_b64, problem)
                    if mode == "image"
                    else None
                )
                async for chunk in provider.solve_problem(
                    no=no,
                    mode=mode,
                    text=str(problem.get("text") or ""),
                    image_b64=image_b64,
                    model=model,
                    effort=effort,
                    max_tokens=config.DEFAULT_MAX_TOKENS,
                ):
                    if chunk["type"] == "delta":
                        yield sse.event("delta", {"no": no, "text": chunk["text"]})
                        continue

                    usage = chunk["usage"]
                    cost = chunk["cost"]
                    await run_in_threadpool(
                        _save_solution,
                        node_id=node_id,
                        no=no,
                        solution=chunk["text"],
                        usage=usage,
                        cost=cost,
                        truncated=chunk["truncated"],
                    )
                    has_usage = _accumulate(total_usage, usage) or has_usage
                    if cost is not None:
                        has_cost = True
                        total_usd += float(cost.get("total_usd", 0.0) or 0.0)
                    yield sse.event(
                        "done",
                        {
                            "no": no,
                            "solution": chunk["text"],
                            "usage": usage,
                            "cost": cost,
                            "truncated": chunk["truncated"],
                        },
                    )
            except ProviderError as exc:
                logger.warning("풀이 실패 (no=%s): %s", no, exc.message)
                yield sse.event(
                    "error",
                    {
                        "no": no,
                        "error_code": exc.error_code,
                        "message": exc.message,
                        "hint": exc.hint,
                    },
                )
            except Exception as exc:
                logger.exception("풀이 중 예상치 못한 오류 (no=%s)", no)
                yield sse.event(
                    "error",
                    {
                        "no": no,
                        "error_code": "internal_error",
                        "message": "풀이 중 서버 오류가 발생했습니다.",
                        "hint": f"{type(exc).__name__}: {exc}",
                    },
                )

        yield sse.event(
            "end",
            {
                "total_usage": dict(total_usage) if has_usage else None,
                "total_cost": _total_cost(total_usd) if has_cost else None,
            },
        )
    except (anyio.get_cancelled_exc_class(), GeneratorExit):
        # 클라이언트가 끊은 경우. 서버는 조용히 정리하고 끝낸다.
        logger.info("SSE 연결이 끊겼습니다 (solve, node_id=%s)", node_id)
        raise


def _total_cost(total_usd: float) -> dict[str, Any]:
    return {
        "total_usd": round(total_usd, 8),
        "total_krw": round(total_usd * pricing.USD_KRW, 4),
        "usd_krw": pricing.USD_KRW,
    }


def _save_solution(
    *,
    node_id: str,
    no: int,
    solution: str,
    usage: dict[str, Any] | None,
    cost: dict[str, Any] | None,
    truncated: bool,
) -> None:
    with storage.transaction() as conn:
        storage.upsert_solution(
            conn,
            node_id=node_id,
            no=no,
            solution=solution,
            usage=usage,
            cost=cost,
            truncated=truncated,
        )


# ---------------------------------------------------------------- variant
async def variant_stream(
    *,
    node_id: str,
    provider: Provider,
    mode: Mode,
    problem: dict[str, Any],
    kind: str,
    model: str,
    effort: Effort,
) -> AsyncIterator[str]:
    """소스 문항을 바탕으로 동일 유형·유사 난이도의 변형 문제를 SSE 로 흘린다.

    풀이(`solve_stream`)와 같은 문항 단위 이벤트 계약(delta / done / error)을
    쓰되, v1 은 **생성·스트리밍만** 하고 결과를 저장하지 않는다. `kind` 는 변형
    종류(`number`/`condition`/`number_condition`)로, 프롬프트에 그대로 반영된다.
    """
    no = int(problem["no"])
    text = str(problem.get("text") or "")
    try:
        try:
            image_b64 = (
                await run_in_threadpool(_read_crop_b64, problem)
                if mode == "image"
                else None
            )
            async for chunk in provider.solve_problem(
                no=no,
                mode=mode,
                text=text,
                image_b64=image_b64,
                model=model,
                effort=effort,
                max_tokens=config.DEFAULT_MAX_TOKENS,
                system=prompts.VARIANT_SYSTEM_PROMPT,
                instruction=prompts.variant_user_text(
                    no, mode=mode, text=text, kind=kind
                ),
            ):
                if chunk["type"] == "delta":
                    yield sse.event("delta", {"no": no, "text": chunk["text"]})
                    continue
                yield sse.event(
                    "done",
                    {
                        "no": no,
                        "solution": chunk["text"],
                        "usage": chunk["usage"],
                        "cost": chunk["cost"],
                        "truncated": chunk["truncated"],
                    },
                )
        except ProviderError as exc:
            logger.warning("변형 생성 실패 (no=%s): %s", no, exc.message)
            yield sse.event(
                "error",
                {
                    "no": no,
                    "error_code": exc.error_code,
                    "message": exc.message,
                    "hint": exc.hint,
                },
            )
        except Exception as exc:
            logger.exception("변형 생성 중 예상치 못한 오류 (no=%s)", no)
            yield sse.event(
                "error",
                {
                    "no": no,
                    "error_code": "internal_error",
                    "message": "변형 문제 생성 중 서버 오류가 발생했습니다.",
                    "hint": f"{type(exc).__name__}: {exc}",
                },
            )
    except (anyio.get_cancelled_exc_class(), GeneratorExit):
        logger.info("SSE 연결이 끊겼습니다 (variant, node_id=%s)", node_id)
        raise


# ------------------------------------------------------------------- chat
class ChatContext(NamedTuple):
    """채팅 호출에 필요한 턴과 **잘려나간 이력 수**.

    `truncated_before` 는 컨텍스트에 넣지 못해 버린 앞쪽 메시지 수다.
    요약(compaction)이 아니라 **truncation** 이므로 그 정보는 복구되지 않는다.
    사용자에게 알려야 하므로 SSE done 이벤트로 흘려보낸다.
    """

    turns: list[Turn]
    truncated_before: int


def _problem_context_parts(
    *,
    node_name: str,
    mode: str,
    problem: dict[str, Any],
    solution: dict[str, Any] | None,
) -> list[TextPart | ImagePart]:
    """특정 문항을 컨텍스트로 거는 블록(크롭 이미지 + 설명 텍스트)."""
    parts: list[TextPart | ImagePart] = []
    image_b64 = _read_crop_b64(problem)
    if image_b64:
        parts.append(ImagePart(b64=image_b64))
    context_lines = [
        f"# 컨텍스트: '{node_name}' 시험지의 {problem['no']}번 문항",
        f"- 페이지: {problem['page']}쪽",
    ]
    if image_b64:
        context_lines.append("- 위 이미지가 해당 문항의 크롭입니다.")
    if mode == "text" and str(problem.get("text") or "").strip():
        context_lines.append(f"- 추출된 문항 텍스트:\n{problem['text']}")
    if solution and solution["solution"]:
        context_lines.append(f"- 이미 작성된 풀이:\n{solution['solution']}")
    else:
        context_lines.append("- 아직 이 문항의 풀이는 작성되지 않았습니다.")
    parts.append(TextPart(text="\n".join(context_lines)))
    return parts


def _file_summary_part(
    *, node_name: str, mode: str, problems: Sequence[dict[str, Any]]
) -> TextPart:
    """시험지 전체를 컨텍스트로 거는 요약 블록."""
    numbers = [problem_row["no"] for problem_row in problems]
    summary = (
        f"# 컨텍스트: '{node_name}' 시험지\n"
        f"- 전체 {len(numbers)}문항"
        + (f" (번호 {numbers[0]}~{numbers[-1]})" if numbers else "")
        + f"\n- 추출 모드: {mode}\n"
        "- 특정 문항에 대한 질문이면 학생에게 문항 번호를 물어보세요."
    )
    return TextPart(text=summary)


def load_chat_context(
    node_id: str, message: str, problem_no: int | None
) -> ChatContext:
    """채팅 턴을 만든다 (블로킹).

    `problem_no` 가 있으면 그 문항의 크롭 이미지 + 기존 풀이를 붙이고,
    없으면 파일 전체 문제 목록 요약을 붙인다. 이력은 **같은 스레드**
    (`(node_id, problem_no)`)의 것만 이어붙인다.

    Raises:
        ApiError: 파일/문항이 없을 때.
    """
    with storage.transaction() as conn:
        node = service.require_file_node(conn, node_id)
        meta = storage.get_file(conn, node_id)
        problems = storage.list_problems(conn, node_id)
        total_history = storage.count_chat_messages(
            conn, node_id, problem_no=problem_no
        )
        history = storage.list_chat_messages(
            conn,
            node_id,
            problem_no=problem_no,
            limit=config.CHAT_HISTORY_LIMIT,
        )
        problem = (
            None
            if problem_no is None
            else storage.get_problem(conn, node_id, problem_no)
        )
        solution = (
            None
            if problem_no is None
            else storage.get_solution(conn, node_id, problem_no)
        )

    if problem_no is not None and problem is None:
        raise bad_request(
            "problem_not_found",
            f"{problem_no}번 문항이 없습니다.",
            f"사용 가능한 번호: {[p['no'] for p in problems]}",
        )

    turns: list[Turn] = [
        Turn(
            role="user" if item["role"] == "user" else "assistant",
            parts=(TextPart(text=str(item["content"])),),
        )
        for item in history
    ]

    parts: list[TextPart | ImagePart] = []
    mode = (meta or {}).get("mode", "text")

    if problem is not None:
        parts.extend(
            _problem_context_parts(
                node_name=str(node["name"]),
                mode=mode,
                problem=problem,
                solution=solution,
            )
        )
    else:
        parts.append(
            _file_summary_part(
                node_name=str(node["name"]), mode=mode, problems=problems
            )
        )

    parts.append(TextPart(text=f"# 학생 질문\n{message}"))
    turns.append(Turn(role="user", parts=tuple(parts)))
    # truncation: 최근 CHAT_HISTORY_LIMIT 개만 보내고 그 앞은 **버린다**(요약하지 않는다).
    return ChatContext(
        turns=turns,
        truncated_before=max(0, total_history - len(history)),
    )


def save_chat_message(
    *,
    node_id: str,
    role: str,
    content: str,
    problem_no: int | None = None,
    usage: dict[str, Any] | None = None,
    cost: dict[str, Any] | None = None,
) -> None:
    """채팅 메시지를 저장한다 (블로킹). `problem_no` 로 스레드를 가른다."""
    with storage.transaction() as conn:
        storage.add_chat_message(
            conn,
            node_id=node_id,
            problem_no=problem_no,
            role=role,
            content=content,
            usage=usage,
            cost=cost,
        )


async def chat_stream(
    *,
    node_id: str,
    provider: Provider,
    turns: Sequence[Turn],
    message: str,
    model: str,
    effort: Effort,
    problem_no: int | None = None,
    truncated_before: int = 0,
) -> AsyncIterator[str]:
    """채팅 응답을 SSE 로 흘린다. 사용자/AI 메시지는 스레드별로 보관한다.

    `truncated_before > 0` 이면 이력 앞부분이 **잘려나갔다**(요약이 아니다).
    그 사실을 done 이벤트의 `history_truncated` / `truncated_before` 로 알린다.
    """
    # 특정 문항이 첨부된 채팅(문항 컨텍스트 O)이면 풀이 스킬을 적용한다.
    # 문항 없는 시험지 전역 대화는 기존대로 채팅용 프롬프트(system 미지정)를 쓴다.
    system = prompts.SOLVE_SYSTEM_PROMPT if problem_no is not None else None
    try:
        await run_in_threadpool(
            save_chat_message,
            node_id=node_id,
            problem_no=problem_no,
            role="user",
            content=message,
        )
        try:
            async for chunk in provider.chat(
                turns=turns,
                model=model,
                effort=effort,
                max_tokens=config.DEFAULT_MAX_TOKENS,
                system=system,
            ):
                if chunk["type"] == "delta":
                    yield sse.event("delta", {"text": chunk["text"]})
                    continue
                await run_in_threadpool(
                    save_chat_message,
                    node_id=node_id,
                    problem_no=problem_no,
                    role="assistant",
                    content=chunk["text"],
                    usage=chunk["usage"],
                    cost=chunk["cost"],
                )
                yield sse.event(
                    "done",
                    {
                        "content": chunk["text"],
                        "problem_no": problem_no,
                        "usage": chunk["usage"],
                        "cost": chunk["cost"],
                        "truncated": chunk["truncated"],
                        # 이력 truncation 신호(모델 출력 잘림 `truncated` 와 다르다).
                        "history_truncated": truncated_before > 0,
                        "truncated_before": truncated_before,
                    },
                )
        except ProviderError as exc:
            logger.warning("채팅 실패: %s", exc.message)
            yield sse.event(
                "error",
                {
                    "error_code": exc.error_code,
                    "message": exc.message,
                    "hint": exc.hint,
                },
            )
        except Exception as exc:
            logger.exception("채팅 중 예상치 못한 오류")
            yield sse.event(
                "error",
                {
                    "error_code": "internal_error",
                    "message": "채팅 중 서버 오류가 발생했습니다.",
                    "hint": f"{type(exc).__name__}: {exc}",
                },
            )
    except (anyio.get_cancelled_exc_class(), GeneratorExit):
        logger.info("SSE 연결이 끊겼습니다 (chat, node_id=%s)", node_id)
        raise


# ------------------------------------------------------- 전역(자유) 대화
def load_conversation_context(
    conversation_id: str,
    message: str,
    *,
    file_id: str | None,
    problem_no: int | None,
) -> ChatContext:
    """전역 대화 턴을 만든다 (블로킹).

    `chat_messages`(시험지 채팅)와 달리 이력은 `conversation_messages` 에서 읽는다.
    `file_id` 가 있으면 그 시험지를(추가로 `problem_no` 가 있으면 그 문항을) 첨부
    컨텍스트로 붙인다. 없으면 파일 무관 자유 대화다.

    Raises:
        ApiError: 대화가 없거나(404), 첨부한 파일/문항이 잘못됐을 때.
    """
    with storage.transaction() as conn:
        if storage.get_conversation(conn, conversation_id) is None:
            raise not_found(
                f"대화를 찾을 수 없습니다. (id={conversation_id})",
                "새로고침 후 다시 시도하세요. 이미 삭제된 대화일 수 있습니다.",
            )
        total_history = storage.count_conversation_messages(conn, conversation_id)
        history = storage.list_conversation_messages(
            conn, conversation_id, limit=config.CHAT_HISTORY_LIMIT
        )
        node: dict[str, Any] | None = None
        meta: dict[str, Any] | None = None
        problems: list[dict[str, Any]] = []
        problem: dict[str, Any] | None = None
        solution: dict[str, Any] | None = None
        if file_id is not None:
            node = service.require_file_node(conn, file_id)
            meta = storage.get_file(conn, file_id)
            problems = storage.list_problems(conn, file_id)
            if problem_no is not None:
                problem = storage.get_problem(conn, file_id, problem_no)
                solution = storage.get_solution(conn, file_id, problem_no)

    if file_id is not None and problem_no is not None and problem is None:
        raise bad_request(
            "problem_not_found",
            f"{problem_no}번 문항이 없습니다.",
            f"사용 가능한 번호: {[p['no'] for p in problems]}",
        )

    turns: list[Turn] = [
        Turn(
            role="user" if item["role"] == "user" else "assistant",
            parts=(TextPart(text=str(item["content"])),),
        )
        for item in history
    ]

    parts: list[TextPart | ImagePart] = []
    if node is not None:
        mode = (meta or {}).get("mode", "text")
        if problem is not None:
            parts.extend(
                _problem_context_parts(
                    node_name=str(node["name"]),
                    mode=mode,
                    problem=problem,
                    solution=solution,
                )
            )
        else:
            parts.append(
                _file_summary_part(
                    node_name=str(node["name"]), mode=mode, problems=problems
                )
            )

    parts.append(TextPart(text=f"# 학생 질문\n{message}"))
    turns.append(Turn(role="user", parts=tuple(parts)))
    return ChatContext(
        turns=turns,
        truncated_before=max(0, total_history - len(history)),
    )


async def conversation_chat_stream(
    *,
    conversation_id: str,
    provider: Provider,
    turns: Sequence[Turn],
    message: str,
    model: str,
    effort: Effort,
    file_id: str | None = None,
    problem_no: int | None = None,
    truncated_before: int = 0,
) -> AsyncIterator[str]:
    """전역 대화 응답을 SSE 로 흘린다. 메시지는 `conversation_messages` 에 보관한다.

    사용자 메시지를 먼저 저장하며(첫 메시지면 자동 제목 설정), 완료 시 assistant
    메시지를 usage/cost 와 함께 저장하고 대화의 `updated_at` 을 갱신한다. SSE 이벤트
    형식은 시험지 채팅(`chat_stream`)과 동일하다.
    """
    # 파일의 특정 문항이 첨부된 대화(문항 컨텍스트 O)면 풀이 스킬을 적용한다.
    # (load_conversation_context 는 file_id 와 problem_no 가 모두 있을 때만 문항
    #  블록을 붙인다.) 그 외 자유 대화는 기존대로 채팅용 프롬프트를 쓴다.
    system = (
        prompts.SOLVE_SYSTEM_PROMPT
        if file_id is not None and problem_no is not None
        else None
    )
    try:
        await run_in_threadpool(
            service.save_conversation_user_message,
            conversation_id=conversation_id,
            message=message,
            file_id=file_id,
            problem_no=problem_no,
        )
        try:
            async for chunk in provider.chat(
                turns=turns,
                model=model,
                effort=effort,
                max_tokens=config.DEFAULT_MAX_TOKENS,
                system=system,
            ):
                if chunk["type"] == "delta":
                    yield sse.event("delta", {"text": chunk["text"]})
                    continue
                await run_in_threadpool(
                    service.save_conversation_assistant_message,
                    conversation_id=conversation_id,
                    content=chunk["text"],
                    file_id=file_id,
                    problem_no=problem_no,
                    usage=chunk["usage"],
                    cost=chunk["cost"],
                )
                yield sse.event(
                    "done",
                    {
                        "content": chunk["text"],
                        "file_id": file_id,
                        "problem_no": problem_no,
                        "usage": chunk["usage"],
                        "cost": chunk["cost"],
                        "truncated": chunk["truncated"],
                        "history_truncated": truncated_before > 0,
                        "truncated_before": truncated_before,
                    },
                )
        except ProviderError as exc:
            logger.warning("대화 실패: %s", exc.message)
            yield sse.event(
                "error",
                {
                    "error_code": exc.error_code,
                    "message": exc.message,
                    "hint": exc.hint,
                },
            )
        except Exception as exc:
            logger.exception("대화 중 예상치 못한 오류")
            yield sse.event(
                "error",
                {
                    "error_code": "internal_error",
                    "message": "대화 중 서버 오류가 발생했습니다.",
                    "hint": f"{type(exc).__name__}: {exc}",
                },
            )
    except (anyio.get_cancelled_exc_class(), GeneratorExit):
        logger.info(
            "SSE 연결이 끊겼습니다 (conversation, id=%s)", conversation_id
        )
        raise
