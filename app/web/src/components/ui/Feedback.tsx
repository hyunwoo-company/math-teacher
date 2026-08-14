'use client';

import clsx from 'clsx';
import type { ReactNode } from 'react';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="불러오는 중"
      className={clsx(
        'inline-block animate-spin rounded-full border-2 border-slate-300 border-t-slate-600',
        className ?? 'h-4 w-4',
      )}
    />
  );
}

export function LoadingState({ label = '불러오는 중입니다…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-8 text-slate-500">
      <Spinner className="h-5 w-5" />
      <p className="text-[13px]">{label}</p>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** 빈 상태를 흰 화면으로 두지 않는다. 항상 무엇을 하면 되는지 알려준다. */
export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-2 p-8 text-center text-slate-500',
        className,
      )}
    >
      {icon ? <div className="text-2xl opacity-70">{icon}</div> : null}
      <p className="text-[13px] font-medium text-slate-600">{title}</p>
      {description ? (
        <p className="max-w-[42ch] text-xs leading-relaxed text-slate-500">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  hint?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ message, hint, onRetry, retryLabel = '다시 시도' }: ErrorStateProps) {
  return (
    <div className="m-3 rounded border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800">
      <p className="font-medium">{message}</p>
      {hint ? <p className="mt-1 text-xs text-rose-700">{hint}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function InlineBadge({
  children,
  tone = 'slate',
}: {
  children: ReactNode;
  tone?: 'slate' | 'blue' | 'green' | 'amber' | 'rose' | 'violet';
}) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    // 변형 관련 표시는 담기(rose)와 구분되게 violet 으로 맞춘다.
    violet: 'bg-violet-50 text-violet-700 border-violet-200',
  };
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
