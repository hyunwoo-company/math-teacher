'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/Feedback';
import { authorizeBinaryUrl, stripDownloadToken } from '@/lib/download-token';
import { normalizeViewportRect, toPdfSpaceRect } from '@/lib/pdf-geometry';
import type { Problem } from '@/types/api';

/** pdf.js 워커/폰트 데이터는 CDN 이 아니라 로컬 public/ 에서 로드한다(오프라인 대비). */
const WORKER_SRC = '/pdfjs/pdf.worker.min.mjs';
const CMAP_URL = '/pdfjs/cmaps/';
const STANDARD_FONTS_URL = '/pdfjs/standard_fonts/';

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** 참조 동일성을 유지해 불필요한 재렌더를 막는다. */
const EMPTY_PROBLEMS: Problem[] = [];

interface PdfViewerInnerProps {
  fileUrl: string;
  problems: Problem[];
  selectedProblemNo: number | null;
  focusRequest: { no: number; page: number; token: number } | null;
  onSelectProblem: (no: number) => void;
}

export default function PdfViewerInner({
  fileUrl,
  problems,
  selectedProblemNo,
  focusRequest,
  onSelectProblem,
}: PdfViewerInnerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.1);
  const [baseWidth, setBaseWidth] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 인증 토큰은 문서를 열 때 이 컴포넌트가 직접 받는다. 부모가 넘긴 URL 에 캐시된
  // 토큰이 이미 붙어 있을 수 있는데, 그 토큰이 갱신될 때마다 prop 이 바뀌면 읽던
  // 문서가 통째로 다시 로드된다. 그래서 토큰을 뗀 URL 을 기준으로 삼는다.
  const documentUrl = stripDownloadToken(fileUrl);

  // 페이지별 문제 목록을 메모해 둔다. 매 렌더마다 새 배열을 넘기면
  // 자식의 렌더 이펙트가 계속 재실행되어 캔버스가 깜빡이고 렌더가 충돌한다.
  const problemsByPage = useMemo(() => {
    const map = new Map<number, Problem[]>();
    for (const problem of problems) {
      const list = map.get(problem.page);
      if (list) list.push(problem);
      else map.set(problem.page, [problem]);
    }
    return map;
  }, [problems]);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;

    setStatus('loading');
    setError(null);
    setDoc(null);

    // pdf.js 는 브라우저 전용이라 정적 프리렌더에 들어가지 않게 동적 import 한다.
    void (async () => {
      try {
        // legacy 빌드를 쓴다. 최신 빌드(`pdfjs-dist`)는 Map.prototype.getOrInsertComputed 등
        // 최신 엔진 전용 API 를 호출해서, 조금만 오래된 WebView(=Tauri 배포 대상)에서
        // "getOrInsertComputed is not a function" 으로 렌더가 통째로 실패한다.
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;
        // pdf.js 도 브라우저가 직접 GET 하므로 헤더를 못 붙인다 → 단기 토큰을 URL 에 싣는다.
        // 문서를 여는 이 시점에 받아 두면 열려 있는 동안 다시 발급할 일이 없다.
        // (범위 요청이 토큰 수명(15분)을 넘겨 나가면 그 페이지 로드는 실패할 수 있다.
        //  뒤에서 URL 을 갈아끼우면 문서가 통째로 다시 로드되어 읽던 자리를 잃으므로
        //  자동 갱신은 하지 않는다 — 실패하면 사용자가 다시 열면 된다.)
        const authorizedUrl = await authorizeBinaryUrl(documentUrl);
        if (cancelled) return;
        const task = pdfjs.getDocument({
          url: authorizedUrl,
          cMapUrl: CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: STANDARD_FONTS_URL,
        });
        const document_ = await task.promise;
        if (cancelled) {
          void document_.destroy();
          return;
        }
        loaded = document_;
        const first = await document_.getPage(1);
        if (cancelled) return;
        setBaseWidth(first.getViewport({ scale: 1 }).width);
        setDoc(document_);
        setStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [documentUrl]);

  // 문제 클릭 -> 해당 페이지로 스크롤
  useEffect(() => {
    if (!focusRequest || status !== 'ready') return;
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-page="${focusRequest.page}"]`);
    if (!container || !target) return;
    container.scrollTo({ top: target.offsetTop - 12, behavior: 'smooth' });
  }, [focusRequest, status]);

  const fitWidth = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !baseWidth) return;
    const available = container.clientWidth - 48;
    setScale(Math.max(0.25, Math.min(4, available / baseWidth)));
  }, [baseWidth]);

  const zoomBy = (direction: 1 | -1) => {
    setScale((current) => {
      if (direction === 1) {
        const next = ZOOM_STEPS.find((step) => step > current + 0.001);
        return next ?? Math.min(4, current + 0.25);
      }
      const candidates = ZOOM_STEPS.filter((step) => step < current - 0.001);
      const next = candidates[candidates.length - 1];
      return next ?? Math.max(0.25, current - 0.25);
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
        <button
          type="button"
          onClick={() => zoomBy(-1)}
          title="축소"
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100"
        >
          −
        </button>
        <span className="w-14 text-center text-[12px] tabular-nums text-slate-600">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(1)}
          title="확대"
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100"
        >
          +
        </button>
        <button
          type="button"
          onClick={fitWidth}
          className="ml-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100"
        >
          너비 맞춤
        </button>
        <span className="ml-auto text-[12px] text-slate-500">
          {doc ? `${doc.numPages}쪽` : '—'}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-slate-200/70 p-3">
        {status === 'loading' ? (
          <LoadingState label="PDF를 여는 중입니다…" />
        ) : status === 'error' ? (
          <ErrorState
            message="PDF를 열지 못했습니다."
            hint={error ?? undefined}
            onRetry={() => setScale((value) => value)}
          />
        ) : doc ? (
          <div className="flex flex-col items-center gap-3">
            {Array.from({ length: doc.numPages }, (_, index) => index + 1).map((pageNumber) => (
              <PdfPage
                key={pageNumber}
                doc={doc}
                pageNumber={pageNumber}
                scale={scale}
                problems={problemsByPage.get(pageNumber) ?? EMPTY_PROBLEMS}
                selectedProblemNo={selectedProblemNo}
                onSelectProblem={onSelectProblem}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="표시할 내용이 없습니다" />
        )}
      </div>
    </div>
  );
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  problems: Problem[];
  selectedProblemNo: number | null;
  onSelectProblem: (no: number) => void;
}

interface Box {
  no: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

function PdfPage({
  doc,
  pageNumber,
  scale,
  problems,
  selectedProblemNo,
  onSelectProblem,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [renderError, setRenderError] = useState<string | null>(null);

  /**
   * 같은 canvas 에 두 개의 render() 가 겹치면 pdf.js 가 예외를 던진다.
   * (StrictMode 이중 실행, 확대/축소 연타에서 실제로 발생한다.)
   * 이전 렌더가 취소되어 완전히 끝난 뒤에 다음 렌더를 시작하도록 직렬화한다.
   */
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;

    const run = async () => {
      if (cancelled) return;
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;

        const viewport = page.getViewport({ scale });
        const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setSize({ width: viewport.width, height: viewport.height });

        task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        await task.promise;
        if (!cancelled) setRenderError(null);
      } catch (error) {
        // 렌더 취소는 정상 흐름이다.
        const name = error instanceof Error ? error.name : '';
        if (cancelled || name === 'RenderingCancelledException') return;
        setRenderError(error instanceof Error ? error.message : String(error));
      }
    };

    chainRef.current = chainRef.current.then(run, run);

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale]);

  // 하이라이트 좌표는 캔버스 렌더와 분리한다(문제 목록이 바뀌어도 다시 그리지 않게).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      // MediaBox = [x0, y0, x1, y1] (PDF 단위). 회전이 있으면 viewport.height 는
      // 폭/높이가 뒤바뀌므로 쓰지 않고 MediaBox 로 높이를 구한다.
      const [, mediaY0 = 0, , mediaY1 = 0] = page.view;

      setBoxes(
        problems.map((problem) => {
          // bbox 는 PyMuPDF(좌상단 원점) 값이므로 PDF 표준(좌하단 원점)으로 뒤집어
          // 넘겨야 한다. 회전 변환은 convertToViewportRectangle 이 처리한다.
          const pdfRect = toPdfSpaceRect(problem.bbox, { y0: mediaY0, y1: mediaY1 });
          const box = normalizeViewportRect(viewport.convertToViewportRectangle(pdfRect));
          return { no: problem.no, ...box };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale, problems]);

  return (
    <div
      data-page={pageNumber}
      className="relative bg-white shadow-sm ring-1 ring-slate-300"
      style={size ? { width: size.width, height: size.height } : undefined}
    >
      <canvas ref={canvasRef} className="block" />
      {renderError ? (
        <p className="absolute inset-x-2 top-2 text-center text-[12px] break-all text-rose-600">
          {pageNumber}쪽을 그리지 못했습니다. ({renderError})
        </p>
      ) : null}

      {boxes.map((box) => (
        <button
          key={box.no}
          type="button"
          title={`${box.no}번 문제 · 클릭하면 오른쪽 AI 패널에 이 문제가 걸립니다`}
          onClick={() => onSelectProblem(box.no)}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          className={clsx(
            'absolute rounded-sm border transition-colors',
            selectedProblemNo === box.no
              ? 'border-blue-500 bg-blue-400/15'
              : 'border-transparent hover:border-blue-300 hover:bg-blue-300/10',
          )}
        >
          <span className="sr-only">{box.no}번 문제 선택</span>
        </button>
      ))}

      <span className="absolute right-1 bottom-1 rounded bg-slate-900/50 px-1.5 py-0.5 text-[10px] text-white">
        {pageNumber}
      </span>
    </div>
  );
}
