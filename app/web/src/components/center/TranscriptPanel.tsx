'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { MathText } from '@/components/MathText';
import { ProblemCrop } from '@/components/center/ProblemCrop';
import { CopyButton } from '@/components/ui/CopyButton';
import { InlineBadge, Spinner } from '@/components/ui/Feedback';
import { toPlainText } from '@/lib/to-plain-text';
import {
  transcriptCacheKey,
  transcriptSourceLabel,
  transcriptSourceTone,
} from '@/lib/transcript';
import { useWorkspace, type TranscriptEntry } from '@/store/workspace';

interface TranscriptPanelProps {
  /** 시험지 file_id. */
  fileId: string;
  /** 시험지 문항 번호. */
  no: number;
  /** 외부 사유로 실행을 막을 때(선택). */
  disabled?: boolean;
  className?: string;
}

/**
 * 크롭 ↔ 판독본 대조 + 편집.
 *
 * ## 왜 나란히 놓는가
 *
 * 복원한 텍스트를 그대로 시험지로 내보내는 것이 이 기능의 목적이고, 잘못 복원한
 * 문항을 내보내는 것은 이미지로 내보내는 것보다 나쁘다. 판독 승인을 강제하지
 * 않는 대신(설계 §5) **사용자가 눈으로 대조하는 것**이 유일한 안전장치다.
 * 그래서 원본 크롭과 복원 텍스트가 한 화면에 같이 있어야 한다.
 *
 * 넓은 화면은 좌(원본)·우(판독본) 2열, 좁은 화면은 위·아래로 쌓는다
 * (`md:grid-cols-2`). 수식은 `MathText` 로 렌더해 KaTeX 로 보인다.
 */
export function TranscriptPanel({ fileId, no, disabled = false, className }: TranscriptPanelProps) {
  const entry = useWorkspace((state) => state.transcripts[transcriptCacheKey(fileId, no)]);
  const startTranscribe = useWorkspace((state) => state.startTranscribe);
  const saveTranscript = useWorkspace((state) => state.saveTranscript);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const status = entry?.status ?? 'idle';
  const running = status === 'running';
  const text = entry?.text ?? '';
  const note = entry?.note ?? null;
  const saving = entry?.saving ?? false;
  /** 비운 채로 저장하면 판독본이 지워진다 — 라벨과 문구로 미리 알린다. */
  const clearing = draft.trim() === '';

  const openEditor = () => {
    setDraft(text);
    setEditing(true);
  };

  const save = async () => {
    const ok = await saveTranscript(fileId, no, draft);
    // 실패하면 편집 모드를 닫지 않는다. 고친 내용을 잃지 않고 다시 시도할 수 있다.
    if (ok) setEditing(false);
  };

  return (
    <div className={clsx('mt-3 rounded border border-slate-200 bg-slate-50/70 p-2.5', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[12px] font-semibold text-slate-700">원본 ↔ 판독본 대조</span>
        <TranscriptBadges entry={entry} />
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {text && !editing ? (
            <>
              <CopyButton
                text={text}
                label="복사(AI 대화용)"
                title="마크다운·LaTeX 원문 그대로 복사 (다른 AI 에 붙여넣을 때)"
              />
              <CopyButton
                text={toPlainText(text)}
                label="복사(한글·워드용)"
                title="한글·워드에 붙여넣을 수 있는 텍스트로 복사"
              />
            </>
          ) : null}
          {!editing ? (
            <button
              type="button"
              onClick={openEditor}
              disabled={running || saving}
              title={
                running
                  ? '판독이 끝난 뒤에 고칠 수 있습니다'
                  : '복원 텍스트를 고칩니다. 저장하면 출처가 "직접 수정" 이 됩니다'
              }
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              편집
            </button>
          ) : null}
          {status === 'idle' && !editing ? (
            <button
              type="button"
              onClick={() => void startTranscribe([no])}
              disabled={disabled}
              title="이 문항만 텍스트로 옮깁니다. PDF 에서 바로 읽는 것이 1차라 대부분 AI 호출이 없습니다"
              className="rounded border border-teal-600 bg-teal-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              이 문항 텍스트화
            </button>
          ) : null}
          {status !== 'idle' ? (
            <button
              type="button"
              // 편집 중에는 막는다. 재실행이 방금 고친 내용을 덮어쓸 수 있다
              // (서버도 `manual` 을 보호하지만 force 는 그 보호를 넘는다).
              onClick={() => void startTranscribe([no], { force: true })}
              disabled={disabled || editing || running || saving}
              title={
                editing
                  ? '편집 중에는 다시 판독할 수 없습니다. 저장하거나 취소한 뒤에 눌러 주세요'
                  : '이 문항을 다시 판독합니다(직접 고친 내용도 덮어씁니다)'
              }
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              다시 판독
            </button>
          ) : null}
        </div>
      </div>

      {/* 좁은 화면은 위(원본)·아래(판독본), 넓은 화면은 좌·우 2열. */}
      <div className="grid gap-2.5 md:grid-cols-2">
        <figure className="m-0">
          <figcaption className="mb-1 text-[11px] font-medium text-slate-500">
            원본 (PDF 크롭)
          </figcaption>
          <ProblemCrop fileId={fileId} no={no} className="max-h-[420px] w-full" />
        </figure>
        <div className="min-w-0">
          <p className="mb-1 text-[11px] font-medium text-slate-500">
            {editing ? '판독본 (편집 중)' : '판독본 (복원 텍스트)'}
          </p>
          <div className="rounded border border-slate-200 bg-white p-2.5">
            {editing ? (
              <TranscriptEditor
                draft={draft}
                clearing={clearing}
                saving={saving}
                onChange={setDraft}
                onSave={() => void save()}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <TranscriptBody entry={entry} />
            )}
          </div>
        </div>
      </div>

      {!editing && note != null && text === '' ? (
        <p className="mt-2 text-[11px] text-amber-700">
          이 문항은 판독하지 못했습니다. 내보낼 때는 원본 크롭 이미지로 내보냅니다.
        </p>
      ) : null}
    </div>
  );
}

/** 출처·이유 배지. 출처마다 신뢰도가 달라 색으로도 구분한다. */
function TranscriptBadges({ entry }: { entry: TranscriptEntry | undefined }) {
  const status = entry?.status ?? 'idle';
  const text = entry?.text ?? '';
  const label = transcriptSourceLabel(entry?.source);
  const note = entry?.note ?? null;

  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-teal-700">
        <Spinner className="h-3 w-3" />
        {/* 1차 디코딩은 AI 호출이 0회고 2차는 사용량을 쓴다 — 구분해 알린다. */}
        {entry?.route === 'ai' ? 'AI 판독 중…' : '디코딩 중…'}
      </span>
    );
  }

  return (
    <>
      {label != null && text !== '' ? (
        <InlineBadge tone={transcriptSourceTone(entry?.source)}>{label}</InlineBadge>
      ) : null}
      {/* 판독하지 못한 문항은 이유 자체를 배지로 보여준다. */}
      {note != null ? <InlineBadge tone="amber">{note}</InlineBadge> : null}
      {text === '' && note == null && status !== 'error' ? <InlineBadge>미판독</InlineBadge> : null}
      {status === 'error' ? <InlineBadge tone="rose">{entry?.error ?? '실패'}</InlineBadge> : null}
    </>
  );
}

function TranscriptBody({ entry }: { entry: TranscriptEntry | undefined }) {
  const status = entry?.status ?? 'idle';
  const body = status === 'running' ? (entry?.streamingText ?? '') : (entry?.text ?? '');

  if (body !== '') {
    return (
      <MathText
        className={clsx(
          'text-[13px] leading-relaxed text-slate-800',
          status === 'running' && 'streaming-caret',
        )}
      >
        {body}
      </MathText>
    );
  }
  if (status === 'running') {
    return <p className="text-[12px] text-slate-500">PDF 에서 문항을 읽고 있습니다…</p>;
  }
  if (status === 'idle') {
    return (
      <p className="text-[12px] text-slate-400">
        아직 이 문항을 텍스트로 옮기지 않았습니다.
      </p>
    );
  }
  return (
    <p className="text-[12px] text-slate-500">
      복원한 텍스트가 없습니다. 위 이유를 확인하세요.
    </p>
  );
}

function TranscriptEditor({
  draft,
  clearing,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: string;
  clearing: boolean;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        aria-label="판독본 편집"
        spellCheck={false}
        rows={12}
        className="w-full resize-y rounded border border-slate-300 p-2 font-mono text-[12px] leading-relaxed text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          title={
            clearing
              ? '비어 있는 채로 저장하면 이 문항의 판독본이 지워집니다'
              : '고친 내용을 저장합니다. 출처가 "직접 수정" 이 됩니다'
          }
          className={clsx(
            'rounded border px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-60',
            clearing
              ? 'border-rose-600 bg-rose-600 hover:bg-rose-700'
              : 'border-blue-600 bg-blue-600 hover:bg-blue-700',
          )}
        >
          {saving ? '저장 중…' : clearing ? '지우고 저장' : '저장'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        >
          취소
        </button>
        {clearing ? (
          // 되돌리는 경로이긴 하지만, 모르고 눌러 지우는 일은 없어야 한다.
          <span className="text-[11px] text-rose-700">
            비어 있습니다 — 이대로 저장하면 이 문항의 판독본이 지워집니다(다음 텍스트화가
            다시 판독합니다).
          </span>
        ) : (
          <span className="text-[11px] text-slate-400">
            수식은 원본 규칙(\( \) · \[ \])을 그대로 쓰세요. 저장하면 출처가 &quot;직접
            수정&quot; 이 됩니다.
          </span>
        )}
      </div>
    </div>
  );
}
