'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { Spinner } from '@/components/ui/Feedback';
import { authorizeBinaryUrl } from '@/lib/download-token';
import { useWorkspace } from '@/store/workspace';

interface DownloadPdfButtonProps {
  /** 원본 PDF URL. 인증은 이 컴포넌트가 클릭 시점에 단기 토큰으로 건다(아래 주석). */
  url: string;
  /** 저장 파일명(노드 이름). 없으면 exam.pdf. */
  fileName: string;
  className?: string;
}

/**
 * 업로드한 원본 PDF 다운로드 버튼.
 *
 * 정적 export(SSR 없음) + 백엔드가 다른 오리진일 수 있어 `<a download>` 의 파일명이
 * 무시될 수 있다. 그래서 fetch → blob → objectURL 방식으로 받아 파일명을 강제한다.
 * 인증은 클릭 시점에 `authorizeBinaryUrl()` 로 단기 토큰(`?token=`)을 받아 건다.
 * 왜 클릭 시점인가: 화면을 열어 두고 한참 뒤에 누르는 일이 흔한데, 렌더 때 박아 둔
 * 토큰은 그사이 만료될 수 있다. 비동기 경로라 그때그때 받아 붙이면 그만이다.
 * (비밀번호를 URL 에 싣던 예전 `?access=` 방식은 기록에 평문으로 남아 걷어냈다.)
 */
export function DownloadPdfButton({ url, fileName, className }: DownloadPdfButtonProps) {
  const [busy, setBusy] = useState(false);
  const showToast = useWorkspace((state) => state.showToast);

  const safeName = fileName.trim() === '' ? 'exam.pdf' : fileName;

  const onDownload = async () => {
    if (busy) return;
    setBusy(true);
    let objectUrl: string | null = null;
    try {
      const response = await fetch(await authorizeBinaryUrl(url), { cache: 'no-store' });
      if (!response.ok) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      showToast({
        kind: 'error',
        message: 'PDF 를 내려받지 못했습니다.',
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
      onClick={() => void onDownload()}
      disabled={busy}
      title="원본 PDF 다운로드"
      className={clsx(
        'inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50',
        className,
      )}
    >
      {busy ? (
        <Spinner className="h-3 w-3" />
      ) : (
        <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 2v8m0 0L5 7m3 3l3-3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2.5 11.5v1A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {busy ? '내려받는 중…' : 'PDF 다운로드'}
    </button>
  );
}
