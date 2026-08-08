'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui/Feedback';
import { useWorkspace } from '@/store/workspace';

interface DownloadDocxButtonProps {
  /** 시험지 파일 노드 id. */
  fileId: string;
  /** 저장 파일명 기본값 계산용(노드 이름). */
  fileName: string;
  className?: string;
}

/** 서버 파일명이 없을 때 쓸 `<시험지명>_문제.docx` (노드 이름의 `.pdf` 는 벗긴다). */
function docxFallbackName(fileName: string): string {
  const base = fileName.trim() === '' ? '시험지' : fileName.trim();
  const stem = base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base;
  return `${stem}_문제.docx`;
}

/**
 * '문제만' 담은 시험지 DOCX 내보내기 버튼.
 *
 * 크롭 이미지만 담고 풀이/변형/정답은 넣지 않는다. DownloadPdfButton 과 같은
 * 방식(fetch→blob→objectURL→a[download])으로 받으며, 인증(`?access=`/헤더)은
 * 클라이언트가 처리한다. 파일명은 서버 Content-Disposition 을 우선한다.
 */
export function DownloadDocxButton({ fileId, fileName, className }: DownloadDocxButtonProps) {
  const [busy, setBusy] = useState(false);
  const showToast = useWorkspace((state) => state.showToast);

  const onExport = async () => {
    if (busy) return;
    setBusy(true);
    let objectUrl: string | null = null;
    try {
      const { blob, filename } = await api.exportProblemsDocx(fileId);
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename ?? docxFallbackName(fileName);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      showToast({
        kind: 'error',
        message: '문제 DOCX 를 내보내지 못했습니다.',
        hint: error instanceof Error ? error.message : null,
      });
    } finally {
      if (objectUrl != null) URL.revokeObjectURL(objectUrl);
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onExport()}
      disabled={busy}
      title="문제만 담은 DOCX 내보내기 (풀이 제외)"
      className={clsx(
        'inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50',
        className,
      )}
    >
      {busy ? (
        <Spinner className="h-3 w-3" />
      ) : (
        <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 1.5h5L12.5 5v9.5a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5z" strokeLinejoin="round" />
          <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
        </svg>
      )}
      {busy ? '내보내는 중…' : '문제 내보내기(DOCX)'}
    </button>
  );
}
