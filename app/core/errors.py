"""에러 형식 통일: 모든 에러 응답은 `{error_code, message, hint}` (message 는 한국어)."""

from __future__ import annotations

import logging
from typing import Final

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger: Final[logging.Logger] = logging.getLogger("math_teacher.core")


class ApiError(Exception):
    """HTTP 상태코드와 한국어 메시지를 갖는 도메인 에러."""

    def __init__(
        self,
        status_code: int,
        error_code: str,
        message: str,
        hint: str | None = None,
    ) -> None:
        """에러를 만든다. `message` 는 사용자에게 보여줄 한국어 문장이다."""
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.message = message
        self.hint = hint

    def body(self) -> dict[str, str | None]:
        """응답 본문 `{error_code, message, hint}`."""
        return {
            "error_code": self.error_code,
            "message": self.message,
            "hint": self.hint,
        }


def not_found(message: str, hint: str | None = None) -> ApiError:
    """404 에러를 만든다."""
    return ApiError(status.HTTP_404_NOT_FOUND, "not_found", message, hint)


def bad_request(error_code: str, message: str, hint: str | None = None) -> ApiError:
    """400 에러를 만든다."""
    return ApiError(status.HTTP_400_BAD_REQUEST, error_code, message, hint)


def _json(error: ApiError) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content=error.body())


def register_error_handlers(app: FastAPI) -> None:
    """500 을 그대로 흘리지 않도록 모든 예외를 한국어 형식으로 감싼다."""

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _json(exc)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        _: Request, exc: RequestValidationError
    ) -> JSONResponse:
        fields = ", ".join(
            ".".join(str(part) for part in err.get("loc", ())[1:]) or "(본문)"
            for err in exc.errors()
        )
        return _json(
            ApiError(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "invalid_request",
                f"요청 형식이 올바르지 않습니다. 확인이 필요한 항목: {fields}",
                "API 계약(ARCHITECTURE.md 5항)의 요청 본문 형식을 확인하세요.",
            )
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail
        messages = {
            status.HTTP_404_NOT_FOUND: "요청한 경로 또는 자원을 찾을 수 없습니다.",
            status.HTTP_405_METHOD_NOT_ALLOWED: "허용되지 않은 요청 방식입니다.",
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE: "요청 본문이 너무 큽니다.",
        }
        return _json(
            ApiError(
                exc.status_code,
                "http_error",
                messages.get(exc.status_code, f"요청을 처리할 수 없습니다. ({detail})"),
            )
        )

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("처리되지 않은 예외: %s %s", request.method, request.url.path)
        return _json(
            ApiError(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "internal_error",
                "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도하세요.",
                f"서버 로그를 확인하세요. ({type(exc).__name__})",
            )
        )
