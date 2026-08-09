'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui/Feedback';
import { useWorkspace } from '@/store/workspace';
import type { ExportFormat, ExportInclude, ExportTarget } from '@/types/api';

interface ExportButtonProps {
  /** 무엇을 내보낼지. */
  target: ExportTarget;
  /** 시험지 노드 id(변형도 시험지 기준) 또는 오답노트 노드 id. */
  id: string;
  /** 저장 파일명 기본값 계산용(노드 이름). */
  name: string;
  className?: string;
}

interface MenuItem {
  format: ExportFormat;
  include: ExportInclude;
  label: string;
}

const ITEMS: readonly MenuItem[] = [
  { format: 'docx', include: 'problems', label: '문제만 · DOCX' },
  { format: 'hwpx', include: 'problems', label: '문제만 · HWPX' },
  { format: 'docx', include: 'full', label: '문제+해설 · DOCX' },
  { format: 'hwpx', include: 'full', label: '문제+해설 · HWPX' },
];

const TARGET_LABEL: Record<ExportTarget, string> = {
  exam: '문제',
  variants: '변형문제',
  note: '오답노트',
};

/** 서버가 파일명을 안 주면 쓸 이름(`.pdf` 는 벗긴다). */
function fallbackName(
  name: string,
  target: ExportTarget,
  format: ExportFormat,
  include: ExportInclude,
): string {
  const base = name.trim() === '' ? '문서' : name.trim();
  const stem = base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base;
  const kind = TARGET_LABEL[target];
  const suffix = include === 'full' ? `${kind}와해설` : kind;
  return `${stem}_${suffix}.${format}`;
}

/**
 * 내보내기 드롭다운(대상 × 형식 × 구성).
 *
 * 버튼 4개를 늘어놓지 않고 하나로 모은다. HWPX 는 한글에서 바로 열리고,
 * DOCX 는 한글·워드 모두에서 열린다.
 */
export function ExportButton({ target, id, name, className }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const showToast = useWorkspace((state) => state.showToast);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 바깥을 누르거나 Esc 로 닫는다.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = async (item: MenuItem) => {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    let objectUrl: string | null = null;
    try {
      const { blob, filename } = await api.exportDocument(target, id, item.format, item.include);
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename ?? fallbackName(name, target, item.format, item.include);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      showToast({
        kind: 'error',
        message: `${TARGET_LABEL[target]} 파일을 내보내지 못했습니다.`,
        hint: error instanceof Error ? error.message : null,
      });
    } finally {
      if (objectUrl != null) URL.revokeObjectURL(objectUrl);
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${TARGET_LABEL[target]} 내보내기 (DOCX / HWPX)`}
        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        {busy ? (
          <Spinner className="h-3 w-3" />
        ) : (
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M8 2v8m0 0 3-3m-3 3L5 7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" strokeLinecap="round" />
          </svg>
        )}
        {busy ? '내보내는 중…' : `${TARGET_LABEL[target]} 내보내기`}
        <span aria-hidden className="text-[9px]">
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded border border-slate-200 bg-white py-1 shadow-lg"
        >
          {ITEMS.map((item) => (
            <button
              key={`${item.format}-${item.include}`}
              type="button"
              role="menuitem"
              onClick={() => void run(item)}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
