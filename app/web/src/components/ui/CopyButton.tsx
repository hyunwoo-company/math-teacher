'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

interface CopyButtonProps {
  /** 클립보드에 넣을 텍스트(풀이는 마크다운 원문을 넘긴다). */
  text: string;
  /** 기본 라벨. 아이콘만 쓰려면 빈 문자열. */
  label?: string;
  className?: string;
  /** 접근성 라벨(라벨이 비어 있을 때 필요). */
  title?: string;
}

/**
 * 작은 복사 버튼. 클릭하면 `text` 를 클립보드에 넣고 2초간 "복사됨" 피드백을 보여준다.
 * 기존 slate 톤에 맞춘 인라인 SVG 아이콘을 쓴다(새 아이콘 의존성 없음).
 */
export function CopyButton({ text, label = '복사', className, title }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 클립보드 접근 실패(권한/비보안 컨텍스트). 조용히 무시하되 피드백은 띄우지 않는다.
      return;
    }
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      // 라벨 텍스트가 있으면 그것이 접근성 이름이 된다(aria-label 로 덮지 않는다).
      // 아이콘만 쓰는 경우에만 title 또는 기본값으로 접근성 이름을 준다.
      aria-label={label === '' ? (title ?? '복사') : undefined}
      title={title ?? '풀이 원문 복사'}
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors',
        copied
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
        className,
      )}
    >
      {copied ? (
        <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5v5.5A1.5 1.5 0 0 0 3.5 10.5h2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {copied ? '복사됨' : label}
    </button>
  );
}
