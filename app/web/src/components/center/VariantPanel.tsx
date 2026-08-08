'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { MathText } from '@/components/MathText';
import { CopyButton } from '@/components/ui/CopyButton';
import { toPlainText } from '@/lib/to-plain-text';
import { Spinner } from '@/components/ui/Feedback';
import { VARIANT_MODE_LABEL, VARIANT_MODES } from '@/lib/variant';
import { useWorkspace, type VariantEntry } from '@/store/workspace';
import type { VariantMode } from '@/types/api';

interface VariantPanelProps {
  /** 원본 시험지 file_id. */
  fileId: string;
  /** 원본 시험지 문항 번호. */
  no: number;
  /** 외부 사유로 생성을 막을 때(선택). */
  disabled?: boolean;
  className?: string;
}

/**
 * "변형 문제 만들기" 탭 컨테이너 + mode 별 생성 결과.
 * 시험지 [풀이] 탭과 오답노트가 같은 문항(file_id + problem_no)을 참조하므로
 * 이 컴포넌트를 공유한다. 결과는 스토어 `variants[`${fileId}::${no}`][mode]` 에 캐시된다.
 *
 * 캐시 UX:
 * - 탭(mode)마다 1회만 생성하고 캐시한다.
 * - 패널이 열리면 첫 탭(숫자)을 자동 생성한다.
 * - 처음 여는 탭은 전환 시 생성(lazy), 이미 생성된 탭은 즉시 캐시를 보여준다.
 * - 각 탭의 "다시 생성"으로만 재호출한다(그 외 자동 재생성 없음).
 * - 헤더를 다시 누르면 접힌다(토글). 접어도 캐시는 스토어에 남아, 다시 열면 재호출 없이 즉시 표시된다.
 */
export function VariantPanel({ fileId, no, disabled = false, className }: VariantPanelProps) {
  // 접힘이 기본. "변형 문제 만들기" 를 눌러야 탭이 열리고 생성이 시작된다.
  // (문항을 펼칠 때마다 자동 생성되어 agy 사용량을 낭비하지 않도록 명시적 트리거로 게이팅한다.)
  const [open, setOpen] = useState(false);

  return (
    <div className={clsx('mt-3 rounded border border-slate-200 bg-slate-50/70 p-2.5', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        <span aria-hidden>✨</span> {open ? '변형 닫기' : '변형 문제 만들기'}
      </button>
      {open ? (
        <div className="mt-2.5">
          <VariantTabs fileId={fileId} no={no} disabled={disabled} />
        </div>
      ) : null}
    </div>
  );
}

function VariantTabs({ fileId, no, disabled }: { fileId: string; no: number; disabled: boolean }) {
  const key = `${fileId}::${no}`;
  const byMode = useWorkspace((state) => state.variants[key]);
  const generateVariant = useWorkspace((state) => state.generateVariant);
  const [activeMode, setActiveMode] = useState<VariantMode>(VARIANT_MODES[0]);

  const activeEntry = byMode?.[activeMode];

  // 활성 탭을 처음 열 때(캐시 없음/이전 실패) 생성한다. 이 컴포넌트는 사용자가
  // "변형 문제 만들기" 를 누른 뒤에만 마운트되므로, 마운트 시 첫 탭(숫자)이 자동
  // 생성된다. done/streaming 이면 스토어가 no-op 한다.
  useEffect(() => {
    if (disabled) return;
    void generateVariant(fileId, no, activeMode);
  }, [disabled, fileId, no, activeMode, generateVariant]);

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-slate-700">변형 문제 만들기</span>
        <p className="text-[11px] text-slate-400">탭을 눌러 유형별 변형 문제를 확인하세요.</p>
      </div>

      <div role="tablist" aria-label="변형 유형" className="flex flex-wrap items-center gap-1">
        {VARIANT_MODES.map((mode) => {
          const selected = mode === activeMode;
          const status = byMode?.[mode]?.status;
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveMode(mode)}
              disabled={disabled}
              className={clsx(
                'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[12px] font-medium disabled:opacity-50',
                selected
                  ? 'border-slate-400 bg-white text-slate-900 shadow-sm'
                  : 'border-slate-200 bg-slate-100 text-slate-500 hover:bg-slate-50 hover:text-slate-700',
              )}
            >
              {VARIANT_MODE_LABEL[mode]}
              {status === 'streaming' ? (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="mt-2">
        <VariantCard
          entry={activeEntry}
          onRegenerate={() => void generateVariant(fileId, no, activeMode, { force: true })}
        />
      </div>
    </>
  );
}

function VariantCard({
  entry,
  onRegenerate,
}: {
  entry: VariantEntry | undefined;
  onRegenerate: () => void;
}) {
  const status = entry?.status ?? 'idle';
  const streaming = status === 'streaming';
  const body = streaming ? entry?.streamingText : entry?.text;

  return (
    <div className="rounded border border-slate-200 bg-white p-2.5">
      <div className="mb-1.5 flex min-h-[20px] items-center gap-2">
        {streaming ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <Spinner className="h-3 w-3" /> 생성 중…
          </span>
        ) : null}
        {/* 복사는 렌더된 텍스트가 아니라 마크다운 원문(entry.text)을 넣는다. */}
        {status === 'done' && entry?.text ? (
          <div className="ml-auto flex items-center gap-1.5">
            <CopyButton text={entry.text} label="복사" />
            <CopyButton
              text={toPlainText(entry.text)}
              label="복사(한글·워드용)"
              title="한글·워드용 텍스트로 복사"
            />
            <button
              type="button"
              onClick={onRegenerate}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
            >
              다시 생성
            </button>
          </div>
        ) : null}
      </div>

      {status === 'error' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[12px] text-rose-700">
            {entry?.error ?? '변형 문제 생성에 실패했습니다.'}
          </p>
          <button
            type="button"
            onClick={onRegenerate}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
          >
            다시 생성
          </button>
        </div>
      ) : body ? (
        <MathText
          className={clsx(
            'text-[13px] leading-relaxed text-slate-800',
            streaming && 'streaming-caret',
          )}
        >
          {body}
        </MathText>
      ) : (
        <p className="text-[12px] text-slate-400">생성을 준비하고 있습니다…</p>
      )}
    </div>
  );
}
