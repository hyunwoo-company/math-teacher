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
import fitz
from fastapi import status
from fastapi.concurrency import run_in_threadpool

import config
import markdown_sections
import pricing
import prompts
import pua_decode
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

# 풀이·변형 진행 이벤트: (이벤트명, 데이터). SSE 직렬화는 소비하는 쪽에서 한다.
#
# 예전에는 이 함수들이 SSE 문자열을 그대로 흘렸고 HTTP 응답이 곧 작업이었다.
# 그래서 브라우저가 연결을 끊으면 작업도 멈췄다. 이제 작업 큐(`jobs.py`)가
# 이 이벤트를 소비하며 진행 상태를 추적하고, 구독자가 없어도 끝까지 돈다.
Event = tuple[str, dict[str, Any]]

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
async def solve_events(
    *,
    node_id: str,
    provider: Provider,
    mode: Mode,
    targets: Sequence[dict[str, Any]],
    model: str,
    effort: Effort,
) -> AsyncIterator[Event]:
    """문항들을 순차로 풀며 SSE 문자열을 흘린다.

    캐시 히트를 노리려면 순차 호출이어야 한다(첫 호출이 캐시를 쓰고 이후가 읽는다).
    """
    total_usage: dict[str, int] = dict.fromkeys(_USAGE_KEYS, 0)
    total_usd = 0.0
    has_usage = False
    has_cost = False

    try:
        yield ("start", {"total": len(targets)})

        for problem in targets:
            no = int(problem["no"])
            yield ("problem", {"no": no, "status": "running"})
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
                        yield ("delta", {"no": no, "text": chunk["text"]})
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
                    yield (
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
                yield (
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
                yield (
                    "error",
                    {
                        "no": no,
                        "error_code": "internal_error",
                        "message": "풀이 중 서버 오류가 발생했습니다.",
                        "hint": f"{type(exc).__name__}: {exc}",
                    },
                )

        yield (
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
def _save_variant(
    *,
    node_id: str,
    no: int,
    kind: str,
    text: str,
    usage: dict[str, Any] | None,
    cost: dict[str, Any] | None,
) -> None:
    """변형 결과를 저장한다 (블로킹). 같은 (시험지, 문항, 종류)는 덮어쓴다."""
    with storage.transaction() as conn:
        storage.upsert_variant(
            conn,
            node_id=node_id,
            no=no,
            mode=kind,
            text=text,
            usage=usage,
            cost=cost,
        )


async def variant_events(
    *,
    node_id: str,
    provider: Provider,
    mode: Mode,
    problem: dict[str, Any],
    kind: str,
    model: str,
    effort: Effort,
) -> AsyncIterator[Event]:
    """소스 문항을 바탕으로 동일 유형·유사 난이도의 변형 문제를 SSE 로 흘린다.

    풀이(`solve_events`)와 같은 문항 단위 이벤트 계약(delta / done / error)을
    쓴다. `kind` 는 변형 종류(`number`/`condition`/`number_condition`)로,
    프롬프트에 그대로 반영되고 저장 키의 일부가 된다.

    `done` 시점에 `variants` 테이블에 저장한다(같은 키는 덮어쓴다). 새로고침해도
    남고, 이미 만든 변형을 다시 생성해 쿼터를 낭비하지 않게 하기 위해서다.
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
                    yield ("delta", {"no": no, "text": chunk["text"]})
                    continue
                await run_in_threadpool(
                    _save_variant,
                    node_id=node_id,
                    no=no,
                    kind=kind,
                    text=chunk["text"],
                    usage=chunk["usage"],
                    cost=chunk["cost"],
                )
                yield (
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
            yield (
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
            yield (
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


def load_chat_context(node_id: str, message: str, problem_no: int | None) -> ChatContext:
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
        total_history = storage.count_chat_messages(conn, node_id, problem_no=problem_no)
        history = storage.list_chat_messages(
            conn,
            node_id,
            problem_no=problem_no,
            limit=config.CHAT_HISTORY_LIMIT,
        )
        problem = (
            None if problem_no is None else storage.get_problem(conn, node_id, problem_no)
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
            _file_summary_part(node_name=str(node["name"]), mode=mode, problems=problems)
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
        logger.info("SSE 연결이 끊겼습니다 (conversation, id=%s)", conversation_id)
        raise


# ------------------------------------------------------------------- jobs
def plan_solve_job(
    node_id: str, numbers: Sequence[int] | None, *, force: bool
) -> tuple[Mode, list[dict[str, Any]], str]:
    """풀이 작업 대상을 정한다 (블로킹).

    이미 풀린 문항을 건너뛰는 규칙을 **서버에서** 적용한다. 예전에는 프론트가
    걸렀는데, 그러면 잡을 만든 창이 아닌 다른 창에서는 규칙이 적용되지 않았다.

    Args:
        node_id: 시험지 노드 id.
        numbers: 대상 문항. None 이면 전체.
        force: True 면 이미 풀린 문항도 다시 푼다.

    Returns:
        (모드, 대상 문항들, 표시용 시험지 이름).

    Raises:
        ApiError: 파일/문항이 없을 때. 남는 대상이 없으면 400 `already_solved`.
    """
    mode, targets = load_solve_targets(node_id, numbers)
    with storage.transaction() as conn:
        node = service.require_file_node(conn, node_id)
        solved = set() if force else storage.solved_numbers(conn, node_id)
    remaining = [item for item in targets if int(item["no"]) not in solved]
    if not remaining:
        raise bad_request(
            "already_solved",
            "요청한 문항은 이미 모두 풀려 있습니다.",
            '다시 풀려면 "다시 풀기" 를 눌러 주세요.',
        )
    return mode, remaining, str(node["name"])


class VariantTarget(NamedTuple):
    """만들 변형 하나 = (소스 문항, 변형 종류).

    문항마다 이미 만들어 둔 종류가 다를 수 있어(예: 1번은 숫자만 있고 2번은
    없음) 단순한 문항x종류 곱으로는 대상을 표현할 수 없다. 그래서 실제로
    만들 조합만 납작한 목록으로 들고 다닌다.
    """

    problem: dict[str, Any]
    kind: str


def _load_variant_sources(
    node_id: str, numbers: Sequence[int]
) -> tuple[Mode, list[dict[str, Any]], str]:
    """변형 소스 문항들을 한 번에 읽어온다 (블로킹).

    Args:
        node_id: 시험지 노드 id.
        numbers: 소스 문항 번호들(중복은 첫 등장 순서로 정리한다).

    Returns:
        (모드, 소스 문항들, 표시용 시험지 이름).

    Raises:
        ApiError: 파일이 없거나(404) 없는 문항 번호가 섞였을 때(404).
    """
    with storage.transaction() as conn:
        node = service.require_file_node(conn, node_id)
        meta = storage.get_file(conn, node_id)
        problems = {
            int(problem["no"]): problem
            for problem in storage.list_problems(conn, node_id)
        }

    mode: Mode = "image" if (meta or {}).get("mode") == "image" else "text"
    wanted = list(dict.fromkeys(int(no) for no in numbers))
    missing = [no for no in wanted if no not in problems]
    if missing:
        listed = ", ".join(str(no) for no in missing)
        raise not_found(
            f"{listed}번 문항이 없습니다.",
            "문제 목록을 새로고침해 번호를 확인하세요.",
        )
    return mode, [problems[no] for no in wanted], str(node["name"])


def plan_variant_batch(
    node_id: str,
    numbers: Sequence[int],
    kinds: Sequence[str],
    *,
    force: bool,
) -> tuple[Mode, list[VariantTarget], str]:
    """변형 일괄 작업 대상을 정한다 (블로킹).

    이미 만들어 둔 (문항, 종류)를 건너뛰는 규칙을 **서버에서** 적용한다.
    풀이(`plan_solve_job`)와 같은 규칙이다 — 잡을 만든 창이 아니어도 통한다.

    Args:
        node_id: 시험지 노드 id.
        numbers: 대상 문항 번호들.
        kinds: 만들 변형 종류들.
        force: True 면 이미 만든 조합도 다시 만든다.

    Returns:
        (모드, 만들 조합들(문항 → 종류 순), 표시용 시험지 이름).

    Raises:
        ApiError: 파일/문항이 없을 때(404). 남는 조합이 없으면
            400 `already_generated`.
    """
    mode, problems, node_name = _load_variant_sources(node_id, numbers)
    wanted_kinds = list(dict.fromkeys(kinds))
    with storage.transaction() as conn:
        made = set() if force else storage.variant_keys(conn, node_id)
    targets = [
        VariantTarget(problem, kind)
        for problem in problems
        for kind in wanted_kinds
        if (int(problem["no"]), kind) not in made
    ]
    if not targets:
        raise bad_request(
            "already_generated",
            "요청한 변형은 이미 모두 만들어져 있습니다.",
            '다시 만들려면 "다시 생성" 을 눌러 주세요.',
        )
    return mode, targets, node_name


async def variant_batch_events(
    *,
    node_id: str,
    provider: Provider,
    mode: Mode,
    targets: Sequence[VariantTarget],
    model: str,
    effort: Effort,
) -> AsyncIterator[Event]:
    """여러 (문항, 변형 종류) 조합을 순차로 만들며 이벤트를 흘린다.

    작업 하나가 여러 문항 x 여러 변형(숫자/조건/숫자+조건)을 담을 수 있게 감싼
    것이다. `done` / `error` 데이터에 어떤 종류인지 알 수 있도록 `mode` 키를
    더한다(문항 번호는 각 이벤트의 `no` 가 이미 갖고 있다).

    Args:
        node_id: 시험지 노드 id.
        provider: 사용할 프로바이더.
        mode: 문항 표현 방식(`image` / `text`).
        targets: 만들 조합들. 앞에서부터 순차로 처리한다.
        model: 모델 id.
        effort: 추론 강도.

    Yields:
        `start` → (조합마다 delta/done/error) → `end` 이벤트.
    """
    yield ("start", {"total": len(targets)})
    for problem, kind in targets:
        async for name, data in variant_events(
            node_id=node_id,
            provider=provider,
            mode=mode,
            problem=problem,
            kind=kind,
            model=model,
            effort=effort,
        ):
            if name == "end":
                continue  # 마지막에 한 번만 낸다
            yield (name, {**data, "mode": kind})
    yield ("end", {"total_usage": None, "total_cost": None})


# -------------------------------------------------------------- transcribe
# 문항 텍스트화. **순서가 이 기능의 전부다**(설계 §3-1/3-2).
#   1차: PDF 텍스트 레이어 디코딩(`pua_decode`). AI 호출 0회, 결정적, 원본 글리프.
#   2차: 1차가 `ok=False` 인 문항만 AI 비전에 크롭 PNG 를 보낸다.
# 디코딩으로 끝난 문항에 AI 를 부르면 이 단계의 존재 이유가 사라진다.


def plan_transcribe_job(
    node_id: str, numbers: Sequence[int] | None, *, force: bool
) -> tuple[list[dict[str, Any]], str]:
    """텍스트화 작업 대상을 정한다 (블로킹).

    이미 판독본이 있는 문항을 건너뛰는 규칙을 **서버에서** 적용한다
    (`plan_solve_job` / `plan_variant_batch` 와 같은 규칙).

    Args:
        node_id: 시험지 노드 id.
        numbers: 대상 문항. None 이면 전체.
        force: True 면 이미 판독본이 있는 문항도 다시 판독한다.

    Returns:
        (대상 문항들, 표시용 시험지 이름).

    Raises:
        ApiError: 파일/문항이 없을 때. 남는 대상이 없으면
            400 `already_transcribed`.
    """
    _, targets = load_solve_targets(node_id, numbers)
    with storage.transaction() as conn:
        node = service.require_file_node(conn, node_id)
        done = set() if force else storage.transcribed_numbers(conn, node_id)
    remaining = [item for item in targets if int(item["no"]) not in done]
    if not remaining:
        raise bad_request(
            "already_transcribed",
            "요청한 문항은 이미 모두 텍스트로 옮겨져 있습니다.",
            '다시 판독하려면 "다시 판독" 을 눌러 주세요.',
        )
    return remaining, str(node["name"])


def _decode_targets(
    node_id: str, targets: Sequence[dict[str, Any]]
) -> dict[int, pua_decode.DecodeResult]:
    """대상 문항을 PDF 텍스트 레이어에서 디코딩한다 (블로킹, AI 호출 0회).

    PDF 를 **한 번만 열고 한 스레드 안에서** 전부 처리한다. PyMuPDF 객체는
    스레드를 옮겨 다니면 안 되고, 문항마다 다시 여는 것도 낭비다.

    원본 PDF 가 사라졌거나 디코더가 예상치 못하게 실패해도 예외를 올리지 않는다.
    그 문항은 결과에 없고, 호출부가 2차 경로(AI 비전)로 보낸다.

    Args:
        node_id: 시험지 노드 id.
        targets: 대상 문항들(`page` 는 1-기준, `bbox` 는 네 값).

    Returns:
        문항 번호 -> 디코딩 결과. 디코딩을 시도조차 못 한 문항은 빠진다.
    """
    try:
        path = service.raw_pdf_path(node_id)
    except ApiError as exc:
        logger.warning(
            "원본 PDF 가 없어 1차 디코딩을 건너뜁니다 (node_id=%s): %s",
            node_id,
            exc.message,
        )
        return {}

    results: dict[int, pua_decode.DecodeResult] = {}
    doc = fitz.open(str(path))
    try:
        for problem in targets:
            no = int(problem["no"])
            index = int(problem["page"]) - 1
            if not 0 <= index < doc.page_count:
                logger.warning("문항 페이지가 PDF 범위를 벗어났습니다 (no=%s)", no)
                continue
            try:
                results[no] = pua_decode.decode_region(doc[index], problem["bbox"])
            except Exception:
                logger.exception("1차 디코딩 중 예상치 못한 오류 (no=%s)", no)
    finally:
        doc.close()
    return results


class Transcription(NamedTuple):
    """AI 판독 응답을 읽은 결과.

    Attributes:
        transcript: 채택한 전문. `불가` 판정이거나 형식이 어긋나면 None.
        note: 채택하지 않은 이유(채택했으면 None).
    """

    transcript: str | None
    note: str | None


def parse_transcription(text: str) -> Transcription:
    """AI 판독 응답(`## 판정` / `## 문제`)을 읽는다.

    **`가능` 판정이 명시적으로 있을 때만 채택한다.** 형식이 어긋난 응답을
    관대하게 받아들이면 풀이나 해설이 시험지 본문으로 흘러 들어간다 —
    이미지로 폴백하는 쪽이 언제나 안전하다.

    Args:
        text: 모델 응답 원문.

    Returns:
        채택한 전문, 또는 채택하지 않은 이유.
    """
    sections = markdown_sections.split_sections(text)
    verdict = (sections.get(prompts.TRANSCRIBE_VERDICT_TITLE) or "").strip()
    if not verdict:
        return Transcription(None, "AI 응답에서 판정을 읽지 못했습니다.")
    if not verdict.startswith(prompts.TRANSCRIBE_VERDICT_OK):
        # `불가 - 좌표평면 그래프...` 를 한 줄로 접어 이유로 남긴다.
        return Transcription(None, " ".join(verdict.split()))
    body = (sections.get(prompts.TRANSCRIBE_PROBLEM_TITLE) or "").strip()
    if not body:
        return Transcription(None, "판정은 가능인데 옮긴 본문이 비어 있습니다.")
    return Transcription(body, None)


def _save_transcript(
    *,
    node_id: str,
    no: int,
    transcript: str | None,
    source: str | None,
    note: str | None,
    overwrite_manual: bool,
) -> bool:
    """판독본을 저장한다 (블로킹). 사용자가 고친 것은 기본적으로 지킨다."""
    with storage.transaction() as conn:
        return storage.set_transcript(
            conn,
            node_id=node_id,
            no=no,
            transcript=transcript,
            source=source,
            note=note,
            overwrite_manual=overwrite_manual,
        )


async def transcribe_events(
    *,
    node_id: str,
    provider: Provider,
    targets: Sequence[dict[str, Any]],
    model: str,
    effort: Effort,
    force: bool = False,
) -> AsyncIterator[Event]:
    """문항을 텍스트로 옮기며 이벤트를 흘린다 (1차 디코딩 → 실패분만 AI).

    이벤트 계약은 풀이(`solve_events`)와 같다: `start` → 문항마다
    `problem`/(`delta`)/`done`|`error` → `end`. 여기에 **비용을 드러내는 값**을
    더한다.

    * `problem.route`: 이 문항이 `pua`(디코딩) 인지 `ai` 인지. 미리 알 수 있다.
    * `done.source`: 실제로 저장한 출처(`pua` / `ai`, 불가면 None).
    * `done.decoded_count` / `done.ai_count`: 그 시점까지의 누적.
    * `end.decoded_count` / `end.ai_count` / `end.unavailable_count`: 최종 집계.

    Args:
        node_id: 시험지 노드 id.
        provider: 2차 경로에 쓸 프로바이더(1차만으로 끝나면 호출되지 않는다).
        targets: 대상 문항들. 앞에서부터 순차로 처리한다.
        model: 모델 id.
        effort: 추론 강도.
        force: True 면 사용자가 고친 판독본(`manual`)도 덮어쓴다.

    Yields:
        진행 이벤트들.
    """
    total_usage: dict[str, int] = dict.fromkeys(_USAGE_KEYS, 0)
    total_usd = 0.0
    has_usage = False
    has_cost = False
    decoded_count = 0
    ai_count = 0
    unavailable_count = 0

    try:
        yield ("start", {"total": len(targets)})

        # 1차: AI 호출 없이 전부 디코딩해 두고, 실패한 것만 아래에서 AI 로 보낸다.
        decoded = await run_in_threadpool(_decode_targets, node_id, targets)

        for problem in targets:
            no = int(problem["no"])
            result = decoded.get(no)
            # 1차를 채택하는 조건: 디코더가 스스로 신뢰한다(`ok`)고 하고 내용이 있다.
            latex = result.latex if result is not None and result.ok else None
            yield (
                "problem",
                {
                    "no": no,
                    "status": "running",
                    "route": storage.TRANSCRIPT_PUA if latex else storage.TRANSCRIPT_AI,
                },
            )

            if latex:
                await run_in_threadpool(
                    _save_transcript,
                    node_id=node_id,
                    no=no,
                    transcript=latex,
                    source=storage.TRANSCRIPT_PUA,
                    note=None,
                    overwrite_manual=force,
                )
                decoded_count += 1
                yield (
                    "done",
                    {
                        "no": no,
                        "source": storage.TRANSCRIPT_PUA,
                        "transcript": latex,
                        "note": None,
                        "decoded_count": decoded_count,
                        "ai_count": ai_count,
                        "usage": None,
                        "cost": None,
                        "truncated": False,
                    },
                )
                continue

            # 2차: 디코딩이 못 한 문항만 AI 비전으로.
            decode_reason = (
                result.reason
                if result is not None and result.reason
                else "PDF 텍스트 레이어에서 문항을 읽지 못했다"
            )
            image_b64 = await run_in_threadpool(_read_crop_b64, problem)
            if not image_b64:
                yield (
                    "error",
                    {
                        "no": no,
                        "error_code": "crop_missing",
                        "message": (
                            f"{no}번 문항의 크롭 이미지가 없어 판독할 수 없습니다."
                        ),
                        "hint": "파일을 다시 업로드해 추출을 재실행하세요.",
                    },
                )
                continue

            ai_count += 1
            try:
                async for chunk in provider.solve_problem(
                    no=no,
                    mode="image",
                    text="",
                    image_b64=image_b64,
                    model=model,
                    effort=effort,
                    max_tokens=config.DEFAULT_MAX_TOKENS,
                    system=prompts.TRANSCRIBE_SYSTEM_PROMPT,
                    instruction=prompts.transcribe_user_text(no),
                ):
                    if chunk["type"] == "delta":
                        yield ("delta", {"no": no, "text": chunk["text"]})
                        continue

                    reading = parse_transcription(chunk["text"])
                    if reading.transcript is None:
                        unavailable_count += 1
                    await run_in_threadpool(
                        _save_transcript,
                        node_id=node_id,
                        no=no,
                        transcript=reading.transcript,
                        source=(
                            storage.TRANSCRIPT_AI
                            if reading.transcript is not None
                            else None
                        ),
                        note=reading.note,
                        overwrite_manual=force,
                    )
                    usage = chunk["usage"]
                    cost = chunk["cost"]
                    has_usage = _accumulate(total_usage, usage) or has_usage
                    if cost is not None:
                        has_cost = True
                        total_usd += float(cost.get("total_usd", 0.0) or 0.0)
                    yield (
                        "done",
                        {
                            "no": no,
                            "source": (
                                storage.TRANSCRIPT_AI
                                if reading.transcript is not None
                                else None
                            ),
                            "transcript": reading.transcript,
                            "note": reading.note,
                            "decode_reason": decode_reason,
                            "decoded_count": decoded_count,
                            "ai_count": ai_count,
                            "usage": usage,
                            "cost": cost,
                            "truncated": chunk["truncated"],
                        },
                    )
            except ProviderError as exc:
                logger.warning("문항 판독 실패 (no=%s): %s", no, exc.message)
                yield (
                    "error",
                    {
                        "no": no,
                        "error_code": exc.error_code,
                        "message": exc.message,
                        "hint": exc.hint,
                    },
                )
            except Exception as exc:
                logger.exception("문항 판독 중 예상치 못한 오류 (no=%s)", no)
                yield (
                    "error",
                    {
                        "no": no,
                        "error_code": "internal_error",
                        "message": "문항 판독 중 서버 오류가 발생했습니다.",
                        "hint": f"{type(exc).__name__}: {exc}",
                    },
                )

        yield (
            "end",
            {
                "total_usage": dict(total_usage) if has_usage else None,
                "total_cost": _total_cost(total_usd) if has_cost else None,
                "decoded_count": decoded_count,
                "ai_count": ai_count,
                "unavailable_count": unavailable_count,
            },
        )
    except (anyio.get_cancelled_exc_class(), GeneratorExit):
        logger.info("SSE 연결이 끊겼습니다 (transcribe, node_id=%s)", node_id)
        raise
