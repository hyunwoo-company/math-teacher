'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui/Feedback';
import { useWorkspace } from '@/store/workspace';
import type { ExportBody, ExportFormat, ExportInclude, ExportTarget } from '@/types/api';

interface ExportButtonProps {
  /** 무엇을 내보낼지. */
  target: ExportTarget;
  /** 시험지 노드 id(변형도 시험지 기준) 또는 오답노트 노드 id. */
  id: string;
  /** 저장 파일명 기본값 계산용(노드 이름). */
  name: string;
  /**
   * 판독본이 하나라도 있는지(체크박스를 켤 수 있는지).
   *
   * `undefined` 는 **모른다**는 뜻이고 그때는 막지 않는다. 오답노트가 그렇다 —
   * `GET /api/notes/{id}` 의 항목에는 판독본 스냅샷 여부가 실리지 않는다. 서버는
   * 판독본이 없는 항목을 조용히 이미지로 폴백하므로, 모를 때 켜 두는 편이 안전하다
   * (반대로 막으면 판독본이 있어도 못 쓴다).
   */
  transcriptReady?: boolean;
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

/** 마지막으로 쓴 출처를 기억해 두는 localStorage 키. */
const SOURCE_STORAGE_KEY = 'export.source';
/** 마지막으로 고른 본문 구성(image/text)을 기억해 두는 키(출처와 같은 규칙). */
const BODY_STORAGE_KEY = 'export.body';
/** 출처 입력 상한(백엔드 `source` 쿼리와 같은 값). */
const SOURCE_MAX_LENGTH = 100;

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
export function ExportButton({
  target,
  id,
  name,
  transcriptReady,
  className,
}: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const [asText, setAsText] = useState(false);
  const showToast = useWorkspace((state) => state.showToast);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 기억해 둔 출처·본문 구성을 채운다. `useState` 초기값으로 읽으면 정적
  // 내보내기의 서버 렌더에서 localStorage 가 없어 깨지므로 마운트 후에 읽는다.
  useEffect(() => {
    setSource(window.localStorage.getItem(SOURCE_STORAGE_KEY) ?? '');
    setAsText(window.localStorage.getItem(BODY_STORAGE_KEY) === 'text');
  }, []);

  /**
   * 변형 문서에는 크롭 이미지가 없고 본문이 이미 텍스트다 — 백엔드도 `body` 를
   * 받기만 하고 쓰지 않는다. 아무 일도 하지 않는 선택지를 내지 않는다.
   */
  const supportsText = target !== 'variants';
  /** 판독본이 하나도 없으면 켤 수 없다(있는지 모르면 막지 않는다). */
  const textEnabled = supportsText && transcriptReady !== false;
  /** 기억해 둔 선택이 'text' 여도 켤 수 없는 상황이면 조용히 image 로 낸다. */
  const body: ExportBody = textEnabled && asText ? 'text' : 'image';

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
    const trimmed = source.trim();
    let objectUrl: string | null = null;
    try {
      const { blob, filename } = await api.exportDocument(
        target,
        id,
        item.format,
        item.include,
        trimmed === '' ? undefined : trimmed,
        body,
      );
      // 성공한 값만 기억한다(실패한 오타를 다음번에 되살리지 않는다).
      window.localStorage.setItem(SOURCE_STORAGE_KEY, trimmed);
      // 본문 구성도 같은 규칙으로 기억한다. 다만 이 대상에서 쓸 수 없는 선택은
      // 기록하지 않는다(변형 내보내기가 시험지 쪽 기억을 지우면 안 된다).
      if (supportsText) window.localStorage.setItem(BODY_STORAGE_KEY, body);
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
          className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded border border-slate-200 bg-white py-1 shadow-lg"
        >
          {/* 출처는 문서 맨 끝에 한 줄로 들어간다. 비워 두면 넣지 않는다. */}
          <label className="block px-3 pb-1.5 pt-1 text-[11px] text-slate-500">
            출처
            <input
              type="text"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-label="출처"
              placeholder="예: HY EDU"
              maxLength={SOURCE_MAX_LENGTH}
              className="mt-0.5 block w-full rounded border border-slate-300 px-1.5 py-1 text-[12px] text-slate-700 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </label>
          {/*
            문항을 크롭 이미지 대신 판독본 텍스트로 조판한다. 기본은 꺼짐 —
            켜지 않으면 지금까지와 완전히 같은 문서가 나온다. 판독본이 없는
            문항은 서버가 조용히 이미지로 폴백한다.
          */}
          {supportsText ? (
            <div className="px-3 pb-1.5 pt-1">
              <label
                className={clsx(
                  'flex items-center gap-1.5 text-[11px]',
                  textEnabled ? 'text-slate-600' : 'cursor-not-allowed text-slate-400',
                )}
                title={
                  textEnabled
                    ? '판독본이 있는 문항은 텍스트로 조판합니다(없는 문항은 이미지로 나갑니다)'
                    : '먼저 문항 텍스트화를 실행하세요'
                }
              >
                <input
                  type="checkbox"
                  checked={textEnabled && asText}
                  disabled={!textEnabled}
                  onChange={(event) => setAsText(event.target.checked)}
                  aria-label="문항을 텍스트로"
                  className="h-3.5 w-3.5"
                />
                문항을 텍스트로
              </label>
              {!textEnabled ? (
                <p className="mt-0.5 text-[10px] text-slate-400">
                  먼저 문항 텍스트화를 실행하세요.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="my-1 border-t border-slate-100" />
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
