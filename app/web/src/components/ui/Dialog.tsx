'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: string;
}

/** Tab 으로 갈 수 있는 것들. 포커스가 모달 밖으로 새지 않게 되돌릴 때 쓴다. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 최소 기능 모달. Esc 로 닫고, 배경 클릭으로 닫는다.
 * (라이브러리를 새로 들이지 않기 위해 직접 구현)
 *
 * 포커스는 모달 안에 가둔다. 앞뒤에 보이지 않는 감시자(tabIndex=0)를 두어,
 * 거기로 Tab 이 빠져나오면 반대쪽 끝으로 돌려보낸다. 브라우저의 기본 Tab 순서를
 * 가로채지 않으므로 라디오 그룹처럼 특수한 이동 규칙도 그대로 지켜진다.
 */
export function Modal({ open, title, children, footer, onClose, width = 'w-[420px]' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const focusEdge = (edge: 'first' | 'last') => {
    const targets = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!targets || targets.length === 0) return;
    const target = edge === 'first' ? targets[0] : targets[targets.length - 1];
    target?.focus();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <span tabIndex={0} aria-hidden onFocus={() => focusEdge('last')} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx('rounded-lg border border-slate-200 bg-white shadow-xl', width)}
      >
        <header className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        </header>
        <div className="px-4 py-3 text-[13px] text-slate-700">{children}</div>
        {footer ? (
          <footer className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
      <span tabIndex={0} aria-hidden onFocus={() => focusEdge('first')} />
    </div>
  );
}

export function DialogButton({
  children,
  onClick,
  tone = 'neutral',
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'neutral' | 'primary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const tones: Record<string, string> = {
    neutral: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    primary: 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
    danger: 'border-rose-600 bg-rose-600 text-white hover:bg-rose-700',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'rounded border px-3 py-1.5 text-[13px] font-medium disabled:opacity-50',
        tones[tone],
      )}
    >
      {children}
    </button>
  );
}

interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

/** 이름 입력용 다이얼로그 (새 폴더 / 이름 변경). */
export function PromptDialog({
  open,
  title,
  label,
  initialValue = '',
  confirmLabel = '확인',
  onCancel,
  onSubmit,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      // 렌더 후 포커스 + 전체 선택
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [open, initialValue]);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed === '') return;
    onSubmit(trimmed);
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <DialogButton onClick={onCancel}>취소</DialogButton>
          <DialogButton tone="primary" onClick={submit} disabled={value.trim() === ''}>
            {confirmLabel}
          </DialogButton>
        </>
      }
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
      </label>
    </Modal>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '삭제',
  tone = 'danger',
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <DialogButton onClick={onCancel}>취소</DialogButton>
          <DialogButton tone={tone} onClick={onConfirm}>
            {confirmLabel}
          </DialogButton>
        </>
      }
    >
      {message}
    </Modal>
  );
}
