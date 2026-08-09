"""풀이·변형 작업 큐 (프로세스 단위 인메모리 러너).

왜 필요한가
----------
예전에는 `POST /api/files/{id}/solve` 의 **HTTP 응답 자체가 작업**이었다.
async generator 를 StreamingResponse 로 그대로 흘렸으므로 브라우저가 연결을
끊으면 작업도 멈췄다. 그래서 다른 시험지로 옮기거나 탭을 닫으면 풀이가 취소됐다.

여기서는 작업의 수명을 HTTP 연결에서 떼어낸다. `submit()` 은 큐에 넣고 즉시
돌아오고, 워커가 뒤에서 돌린다. **구독자가 한 명도 없어도 끝까지 진행한다.**

설계 요점
--------
* **전역 순차 큐.** 동시 실행하지 않는다. (1) agy·구독 쿼터를 아끼고,
  (2) 순차 호출이 프롬프트 캐시 히트를 만들며, (3) agy 는 자식 프로세스를 띄워
  동시에 여러 개면 노드가 버겁다.
* **단일 프로세스 전제.** uvicorn 워커를 늘리면 큐가 프로세스마다 생겨 깨진다.
  워커는 1개로 운영한다(README 참고).
* 결과는 `solutions` / `variants` 테이블에 문항이 끝날 때마다 저장된다.
  `jobs` 테이블은 진행 상태만 갖는다.
* 재접속을 위해 **현재 문항의 누적 텍스트**만 메모리에 든다. 끝난 문항의 본문은
  DB 에 있으므로 보관하지 않는다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Final

import ai_service
import storage
from ai_service import Event

logger: Final[logging.Logger] = logging.getLogger("math_teacher.core.jobs")

# 구독자 큐가 이만큼 밀리면 가장 오래된 이벤트를 버린다. 느린 구독자 하나가
# 워커를 멈춰 세우면 안 된다(작업 진행이 구독자에 의존하면 안 된다).
_SUBSCRIBER_MAXSIZE: Final[int] = 1000

JOB_KIND_SOLVE: Final[str] = "solve"
JOB_KIND_VARIANT: Final[str] = "variant"

STATUS_QUEUED: Final[str] = "queued"
STATUS_RUNNING: Final[str] = "running"
STATUS_DONE: Final[str] = "done"
STATUS_ERROR: Final[str] = "error"
STATUS_CANCELED: Final[str] = "canceled"


@dataclass
class LiveJob:
    """실행 중 작업의 휘발 상태."""

    job_id: str
    total: int
    done_count: int = 0
    current_no: int | None = None
    #: 현재 문항의 누적 델타. 문항이 끝나면 비운다(끝난 본문은 DB 에 있다).
    partial_text: str = ""
    status: str = STATUS_QUEUED
    cancel: asyncio.Event = field(default_factory=asyncio.Event)

    def snapshot(self) -> dict[str, Any]:
        """늦게 붙은 구독자에게 먼저 보낼 현재 상태."""
        return {
            "status": self.status,
            "total": self.total,
            "done_count": self.done_count,
            "current_no": self.current_no,
            "partial_text": self.partial_text,
        }


class JobRunner:
    """작업 큐 + 단일 워커 + 이벤트 발행."""

    def __init__(self) -> None:
        """빈 큐로 시작한다. 실제 워커는 `start()` 에서 띄운다."""
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None
        self._live: dict[str, LiveJob] = {}
        self._subscribers: dict[str, set[asyncio.Queue[Event | None]]] = {}
        #: job_id -> 실제 이벤트를 만드는 코루틴 팩토리.
        self._factories: dict[str, Callable[[], AsyncIterator[Event]]] = {}

    # ------------------------------------------------------------ 수명주기
    def start(self) -> None:
        """워커를 띄운다(이미 떠 있으면 no-op).

        `asyncio.Queue` 는 처음 대기할 때의 이벤트 루프에 묶인다. 이 러너는 모듈
        전역 싱글턴이라 앱을 여러 번 띄우면(테스트가 그렇다) 죽은 루프에 묶인
        큐를 그대로 쓰게 되어 작업이 영원히 시작되지 않는다. 그래서 시작할 때
        큐와 휘발 상태를 새로 만든다.
        """
        if self._worker is not None and not self._worker.done():
            return
        self._queue = asyncio.Queue()
        self._live.clear()
        self._subscribers.clear()
        self._factories.clear()
        self._worker = asyncio.create_task(self._run_forever(), name="job-worker")

    async def stop(self) -> None:
        """워커를 멈추고 구독자를 정리한다."""
        if self._worker is None:
            return
        self._worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._worker
        self._worker = None
        for queues in self._subscribers.values():
            for queue in queues:
                queue.put_nowait(None)
        self._subscribers.clear()

    # ---------------------------------------------------------------- 등록
    def submit(
        self,
        *,
        job_id: str,
        total: int,
        factory: Callable[[], AsyncIterator[Event]],
    ) -> None:
        """작업을 큐에 넣는다. 즉시 돌아온다.

        Args:
            job_id: `jobs` 테이블에 이미 넣어 둔 작업 id.
            total: 진행 단위 수(문항 수).
            factory: 호출하면 이벤트를 흘리는 async iterator 를 주는 팩토리.
                워커가 실제로 실행할 때 호출한다(그래야 큐에서 기다리는 동안
                provider 연결을 잡고 있지 않는다).
        """
        self._live[job_id] = LiveJob(job_id=job_id, total=total)
        self._factories[job_id] = factory
        self._queue.put_nowait(job_id)

    def cancel(self, job_id: str) -> bool:
        """작업을 취소한다. 대기 중이면 큐에서 빠지고, 실행 중이면 곧 멈춘다.

        Returns:
            취소 신호를 보냈으면 True. 이미 끝났거나 모르는 작업이면 False.
        """
        live = self._live.get(job_id)
        if live is None:
            return False
        live.cancel.set()
        return True

    def live(self, job_id: str) -> LiveJob | None:
        """실행 중/최근 작업의 휘발 상태."""
        return self._live.get(job_id)

    @property
    def queued_count(self) -> int:
        """큐에서 대기 중인 작업 수."""
        return self._queue.qsize()

    # -------------------------------------------------------------- 구독
    async def subscribe(self, job_id: str) -> AsyncIterator[Event]:
        """작업 이벤트를 구독한다. 붙는 즉시 `snapshot` 을 한 번 받는다.

        구독을 끊어도 작업은 계속된다. 이것이 이 모듈의 존재 이유다.
        """
        live = self._live.get(job_id)
        if live is None:
            # 이미 끝나 메모리에서 사라진 작업. DB 상태로 한 번 알려주고 끝낸다.
            record = await asyncio.to_thread(_load_job, job_id)
            if record is not None:
                yield (
                    "snapshot",
                    {
                        "status": record["status"],
                        "total": record["total"],
                        "done_count": record["done_count"],
                        "current_no": record["current_no"],
                        "partial_text": "",
                    },
                )
                yield ("end", {"status": record["status"]})
            return

        queue: asyncio.Queue[Event | None] = asyncio.Queue(maxsize=_SUBSCRIBER_MAXSIZE)
        self._subscribers.setdefault(job_id, set()).add(queue)
        try:
            yield ("snapshot", live.snapshot())
            # 구독 전에 이미 끝난 작업이면 snapshot 뒤 바로 닫는다.
            if live.status in (STATUS_DONE, STATUS_ERROR, STATUS_CANCELED):
                yield ("end", {"status": live.status})
                return
            while True:
                event = await queue.get()
                if event is None:
                    return
                yield event
                if event[0] == "end":
                    return
        finally:
            subscribers = self._subscribers.get(job_id)
            if subscribers is not None:
                subscribers.discard(queue)
                if not subscribers:
                    self._subscribers.pop(job_id, None)

    def _publish(self, job_id: str, event: Event) -> None:
        """구독자 전원에게 이벤트를 넣는다. 느린 구독자 때문에 막히지 않는다."""
        for queue in self._subscribers.get(job_id, set()):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()  # 가장 오래된 것을 버린다
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    # -------------------------------------------------------------- 워커
    async def _run_forever(self) -> None:
        """큐에서 하나씩 꺼내 순차 실행한다."""
        while True:
            job_id = await self._queue.get()
            try:
                await self._run_one(job_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("작업 실행 중 예상치 못한 오류 (job_id=%s)", job_id)
            finally:
                self._queue.task_done()

    async def _run_one(self, job_id: str) -> None:
        live = self._live.get(job_id)
        factory = self._factories.pop(job_id, None)
        if live is None or factory is None:
            return

        # 큐에서 기다리는 사이 취소된 작업.
        if live.cancel.is_set():
            live.status = STATUS_CANCELED
            await asyncio.to_thread(_mark, job_id, status=STATUS_CANCELED)
            self._publish(job_id, ("end", {"status": STATUS_CANCELED}))
            return

        live.status = STATUS_RUNNING
        await asyncio.to_thread(_mark, job_id, status=STATUS_RUNNING)

        final_status = STATUS_DONE
        error_message: str | None = None
        try:
            async for name, data in factory():
                if live.cancel.is_set():
                    final_status = STATUS_CANCELED
                    break
                self._apply(live, name, data)
                if name == "end":
                    # end 는 아래에서 최종 상태와 함께 한 번만 내보낸다.
                    self._publish(job_id, (name, {**data, "status": STATUS_DONE}))
                    await asyncio.to_thread(
                        _mark,
                        job_id,
                        status=STATUS_DONE,
                        done_count=live.done_count,
                        current_no=None,
                    )
                    live.status = STATUS_DONE
                    return
                self._publish(job_id, (name, data))
        except asyncio.CancelledError:
            live.status = STATUS_CANCELED
            await asyncio.to_thread(_mark, job_id, status=STATUS_CANCELED)
            self._publish(job_id, ("end", {"status": STATUS_CANCELED}))
            raise
        except Exception as exc:
            logger.exception("작업 실패 (job_id=%s)", job_id)
            final_status = STATUS_ERROR
            error_message = f"{type(exc).__name__}: {exc}"

        live.status = final_status
        live.current_no = None
        await asyncio.to_thread(
            _mark,
            job_id,
            status=final_status,
            done_count=live.done_count,
            current_no=None,
            error=error_message,
        )
        self._publish(
            job_id,
            ("end", {"status": final_status, "message": error_message}),
        )

    def _apply(self, live: LiveJob, name: str, data: dict[str, Any]) -> None:
        """이벤트를 휘발 상태에 반영한다(진행률·부분 텍스트)."""
        if name == "start":
            live.total = int(data.get("total", live.total))
        elif name == "problem":
            live.current_no = int(data["no"])
            live.partial_text = ""
        elif name == "delta":
            live.partial_text += str(data.get("text", ""))
        elif name in ("done", "error"):
            live.done_count += 1
            live.partial_text = ""


def _mark(job_id: str, **fields: Any) -> None:
    """작업 상태를 DB 에 반영한다(블로킹 — `to_thread` 로 부른다)."""
    with storage.transaction() as conn:
        storage.update_job(conn, job_id, **fields)


def _load_job(job_id: str) -> dict[str, Any] | None:
    with storage.transaction() as conn:
        return storage.get_job(conn, job_id)


#: 프로세스 전역 러너. `main.lifespan` 이 start/stop 한다.
runner: Final[JobRunner] = JobRunner()


def solve_factory(**kwargs: Any) -> Callable[[], AsyncIterator[Event]]:
    """풀이 이벤트 팩토리(워커가 실행 시점에 호출한다)."""

    def make() -> AsyncIterator[Event]:
        return ai_service.solve_events(**kwargs)

    return make


def variant_batch_factory(**kwargs: Any) -> Callable[[], AsyncIterator[Event]]:
    """변형 이벤트 팩토리(한 문항의 여러 변형 종류를 순차 실행)."""

    def make() -> AsyncIterator[Event]:
        return ai_service.variant_batch_events(**kwargs)

    return make
