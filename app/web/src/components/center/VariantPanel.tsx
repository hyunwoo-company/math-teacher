'use client';

import clsx from 'clsx';
import { MathText } from '@/components/MathText';
import { CopyButton } from '@/components/ui/CopyButton';
import { InlineBadge, Spinner } from '@/components/ui/Feedback';
import { VARIANT_MODE_LABEL, VARIANT_MODES } from '@/lib/variant';
import { useWorkspace, type VariantEntry } from '@/store/workspace';

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
 * "변형 문제 만들기" 컨트롤 + 생성 결과.
 * 시험지 [풀이] 탭과 오답노트가 같은 문항(file_id + problem_no)을 참조하므로
 * 이 컴포넌트를 공유한다. 결과는 스토어의 `variants[`${fileId}::${no}`]` 에 쌓인다.
 */
export function VariantPanel({ fileId, no, disabled = false, className }: VariantPanelProps) {
  const key = `${fileId}::${no}`;
  const entries = useWorkspace((state) => state.variants[key]);
  const generateVariant = useWorkspace((state) => state.generateVariant);

  // 이 문항에서 이미 생성이 진행 중이면 중복 실행을 막는다(연타 방지). 완료 후 다시 만들 수 있다.
  const anyRunning = entries?.some((entry) => entry.status === 'running') ?? false;

  return (
    <div className={clsx('mt-3 rounded border border-slate-200 bg-slate-50/70 p-2.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-slate-700">변형 문제 만들기</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {VARIANT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => void generateVariant(fileId, no, mode)}
              disabled={disabled || anyRunning}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[12px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {VARIANT_MODE_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>

      {entries && entries.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {entries.map((entry) => (
            <VariantCard key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[11px] text-slate-400">
          같은 유형의 새 문제를 만들어 아래에 표시합니다. 여러 번 만들 수 있습니다.
        </p>
      )}
    </div>
  );
}

function VariantCard({ entry }: { entry: VariantEntry }) {
  const streaming = entry.status === 'running';
  const body = streaming ? entry.streamingText : entry.text;

  return (
    <li className="rounded border border-slate-200 bg-white p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <InlineBadge tone="blue">{VARIANT_MODE_LABEL[entry.mode]}</InlineBadge>
        {entry.status === 'running' ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <Spinner className="h-3 w-3" /> 생성 중…
          </span>
        ) : null}
        {/* 복사는 렌더된 텍스트가 아니라 마크다운 원문(entry.text)을 넣는다. */}
        {entry.status === 'done' && entry.text ? (
          <CopyButton text={entry.text} label="복사" className="ml-auto" />
        ) : null}
      </div>

      {entry.status === 'error' ? (
        <p className="text-[12px] text-rose-700">
          {entry.error ?? '변형 문제 생성에 실패했습니다.'}
        </p>
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
    </li>
  );
}
