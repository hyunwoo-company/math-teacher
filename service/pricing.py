"""모델 단가 테이블과 실측 usage 기반 비용 계산.

단가 출처 주의
---------------
아래 단가는 **2026-06 기준**으로 하드코딩한 값이다.
Anthropic 단가는 예고 없이 바뀔 수 있으므로 실제 정산에 쓰기 전에
반드시 https://platform.claude.com/docs/en/pricing 에서 최신 값을 확인할 것.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final, TypedDict


class ModelRates(TypedDict):
    """1M 토큰당 USD 단가."""

    input: float
    output: float


# 2026-06 기준, platform.claude.com/docs/en/pricing 확인 필요 (USD per 1M tokens)
MODEL_RATES: Final[dict[str, ModelRates]] = {
    "claude-opus-5": {"input": 5.00, "output": 25.00},
    "claude-sonnet-5": {"input": 3.00, "output": 15.00},
    "claude-haiku-4-5": {"input": 1.00, "output": 5.00},
}

DEFAULT_MODEL: Final[str] = "claude-opus-5"

# 프롬프트 캐시 배수: write(5분 TTL)는 input의 1.25배, read는 input의 0.10배.
CACHE_WRITE_MULTIPLIER: Final[float] = 1.25
CACHE_READ_MULTIPLIER: Final[float] = 0.10

# 환율은 상수다(실시간 조회 아님). 표시용 근사값이며 정산 근거로 쓰면 안 된다.
USD_KRW: Final[float] = 1400.0

_USAGE_KEYS: Final[tuple[str, ...]] = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


class UnknownModelError(ValueError):
    """단가 테이블에 없는 모델."""

    def __init__(self, model: str) -> None:
        self.model = model
        super().__init__(
            f"단가 테이블에 없는 모델입니다: {model!r}. "
            f"사용 가능: {', '.join(sorted(MODEL_RATES))}"
        )


def resolve_model(model: str) -> str:
    """`claude-opus-5-20260601` 같은 날짜 붙은 ID를 단가 테이블 키로 정규화한다.

    Args:
        model: 모델 ID.

    Returns:
        `MODEL_RATES` 의 키.

    Raises:
        UnknownModelError: 매칭되는 키가 없을 때.
    """
    if model in MODEL_RATES:
        return model
    candidates = [key for key in MODEL_RATES if model.startswith(key)]
    if candidates:
        return max(candidates, key=len)
    raise UnknownModelError(model)


def rates_for(model: str) -> dict[str, float]:
    """모델의 4종 단가(USD per 1M tokens)를 돌려준다."""
    base = MODEL_RATES[resolve_model(model)]
    return {
        "input": base["input"],
        "output": base["output"],
        "cache_write": round(base["input"] * CACHE_WRITE_MULTIPLIER, 6),
        "cache_read": round(base["input"] * CACHE_READ_MULTIPLIER, 6),
    }


def normalize_usage(usage: Mapping[str, object] | None) -> dict[str, int]:
    """SDK usage 객체(dict 변환본)에서 과금 대상 4개 필드만 정수로 뽑는다.

    누락되거나 None 인 필드는 0 으로 채운다. 값을 추정하지 않는다.
    """
    result: dict[str, int] = {}
    source: Mapping[str, object] = usage or {}
    for key in _USAGE_KEYS:
        raw = source.get(key)
        result[key] = int(raw) if isinstance(raw, (int, float)) else 0
    return result


def calc_cost(model: str, usage: Mapping[str, object] | None) -> dict[str, object]:
    """실측 usage 로 비용을 계산한다.

    Args:
        model: 모델 ID (`claude-opus-5` 등, 날짜 suffix 허용).
        usage: `response.usage` 를 dict 로 변환한 값.

    Returns:
        토큰 수 / 단가 / 항목별 USD breakdown / 합계 USD·KRW.

    Raises:
        UnknownModelError: 단가 테이블에 없는 모델일 때.
    """
    resolved = resolve_model(model)
    rates = rates_for(resolved)
    tokens = normalize_usage(usage)

    counts = {
        "input": tokens["input_tokens"],
        "output": tokens["output_tokens"],
        "cache_write": tokens["cache_creation_input_tokens"],
        "cache_read": tokens["cache_read_input_tokens"],
    }
    breakdown_usd = {key: counts[key] / 1_000_000 * rates[key] for key in counts}
    total_usd = sum(breakdown_usd.values())

    return {
        "model": model,
        "resolved_model": resolved,
        "tokens": {**counts, "total": sum(counts.values())},
        "rates_usd_per_mtok": rates,
        "breakdown_usd": {key: round(value, 8) for key, value in breakdown_usd.items()},
        "breakdown_krw": {
            key: round(value * USD_KRW, 4) for key, value in breakdown_usd.items()
        },
        "total_usd": round(total_usd, 8),
        "total_krw": round(total_usd * USD_KRW, 4),
        "usd_krw": USD_KRW,
    }


def zero_cost(model: str = DEFAULT_MODEL) -> dict[str, object]:
    """AI 호출이 없었음을 명시하는 0원 비용 객체."""
    return calc_cost(model, {})
