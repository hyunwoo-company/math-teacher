'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { VariantPanel } from '@/components/center/VariantPanel';
import { ExportButton } from '@/components/center/ExportButton';
import { InlineSolutionPanel } from '@/components/center/InlineSolutionPanel';
import { EmptyState, ErrorState, InlineBadge, LoadingState } from '@/components/ui/Feedback';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useBinaryUrl } from '@/hooks/useBinaryUrl';
import { formatDate } from '@/lib/format';
import { nodePath } from '@/lib/tree';
import { useWorkspace } from '@/store/workspace';
import type { NoteItem } from '@/types/api';

/** 중앙 오답노트 보기: 시험지명·문항·크롭 썸네일·[원본 바로가기]. */
export function NoteView() {
  const noteDetail = useWorkspace((state) => state.noteDetail);
  const noteStatus = useWorkspace((state) => state.noteStatus);
  const noteError = useWorkspace((state) => state.noteError);
  const selectedNoteId = useWorkspace((state) => state.selectedNoteId);
  const nodes = useWorkspace((state) => state.nodes);
  const refreshNote = useWorkspace((state) => state.refreshNote);
  const deleteNoteItem = useWorkspace((state) => state.deleteNoteItem);

  const [pendingDelete, setPendingDelete] = useState<NoteItem | null>(null);

  if (noteStatus === 'loading') {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-white">
        <LoadingState label="오답노트를 불러오는 중입니다…" />
      </section>
    );
  }

  if (noteStatus === 'error' || !noteDetail) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-white">
        <div className="w-[420px]">
          <ErrorState
            message={noteError ?? '오답노트를 불러오지 못했습니다.'}
            onRetry={() => void refreshNote()}
          />
        </div>
      </section>
    );
  }

  const { node, items } = noteDetail;
  const path = selectedNoteId ? nodePath(nodes, selectedNoteId) : [node.name];

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-[15px]">
            📕
          </span>
          <h1 className="truncate text-[14px] font-semibold text-slate-800" title={node.name}>
            {node.name}
          </h1>
          <InlineBadge tone="rose">오답노트</InlineBadge>
          <InlineBadge>{items.length}문항</InlineBadge>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ExportButton target="note" id={selectedNoteId ?? node.id} name={node.name} />
            <span className="text-[11px] text-slate-400">
              만든 날짜 {formatDate(node.created_at)}
            </span>
          </div>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-slate-400">{path.join(' / ')}</p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {items.length === 0 ? (
          <EmptyState
            title="아직 담긴 오답이 없습니다"
            description="시험지를 열고 문제를 선택한 뒤 [오답노트에 담기] 를 누르거나, 채팅에 '5번 6번 이 노트에 추가해줘' 처럼 말해 담을 수 있습니다."
            icon="📝"
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {items.map((item) => (
              <NoteItemCard
                key={item.id}
                item={item}
                noteId={selectedNoteId ?? node.id}
                onOpenSource={item.source_available ? () => openSource(item) : undefined}
                onDelete={() => setPendingDelete(item)}
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        title="오답노트에서 빼기"
        confirmLabel="빼기"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void deleteNoteItem(target.id);
        }}
        message={
          <p>
            <span className="font-semibold">
              {pendingDelete?.source_name} {pendingDelete?.problem_no}번
            </span>{' '}
            항목을 이 오답노트에서 뺄까요? (원본 시험지는 그대로 있습니다.)
          </p>
        }
      />
    </section>
  );
}

function openSource(item: NoteItem): void {
  if (item.source_node_id == null) return;
  void useWorkspace.getState().setSection('exam');
  void useWorkspace.getState().selectFile(item.source_node_id);
  // 원본을 열면 그 문항으로 포커스한다.
  window.setTimeout(() => {
    useWorkspace.getState().focusProblem(item.problem_no);
  }, 300);
}

function NoteItemCard({
  item,
  noteId,
  onOpenSource,
  onDelete,
}: {
  item: NoteItem;
  noteId: string;
  onOpenSource?: () => void;
  onDelete: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  // 배포 인증 환경에서는 단기 토큰이 붙어야 크롭이 열린다. 아직이면 null 이 온다.
  const cropUrl = useBinaryUrl(api.noteCropUrl(noteId, item.id));

  // 라이트박스는 Esc 로도 닫는다(배경/닫기 버튼과 동일).
  useEffect(() => {
    if (!zoomed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomed(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomed]);

  return (
    <li className="flex flex-col gap-2 rounded border border-slate-200 bg-white p-3">
      {/* 상단: 출처 · 문제번호 + 액션(원본 바로가기 · 빼기). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="min-w-0 truncate text-[12px] text-slate-500"
          title={item.source_name}
        >
          {item.source_name}
        </span>
        <span aria-hidden className="text-slate-300">
          ·
        </span>
        <span className="text-[13px] font-semibold text-slate-800">{item.problem_no}번</span>
        {item.source_available ? null : <InlineBadge tone="amber">원본 삭제됨</InlineBadge>}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenSource}
            disabled={!onOpenSource}
            title={onOpenSource ? '원본 시험지의 이 문항으로 이동' : '원본 시험지가 삭제되었습니다'}
            className={clsx(
              'rounded border px-2 py-0.5 text-[11px]',
              onOpenSource
                ? 'border-blue-300 bg-white text-blue-700 hover:bg-blue-50'
                : 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400',
            )}
          >
            원본 바로가기
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
          >
            빼기
          </button>
        </div>
      </div>

      {/* 문제 크롭 이미지(클릭 시 확대). 파싱 텍스트는 원본 수식폰트가 깨져 미리보기에서 제외. */}
      {imgFailed || cropUrl == null ? (
        <div className="flex h-28 w-full items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-[11px] text-slate-400">
          {imgFailed ? '미리보기 없음' : '불러오는 중…'}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          title="클릭하면 문제를 크게 봅니다"
          className="block w-full cursor-zoom-in overflow-hidden rounded border border-slate-200 bg-white p-0"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cropUrl}
            alt={`${item.source_name} ${item.problem_no}번`}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="block h-auto w-full max-h-64 rounded object-contain"
          />
        </button>
      )}

      {zoomed && !imgFailed && cropUrl != null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${item.source_name} ${item.problem_no}번 문제 이미지`}
          className="fixed inset-0 z-50 flex flex-col items-center gap-2 bg-slate-900/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setZoomed(false);
          }}
        >
          {/* 닫기는 이미지 위가 아니라 상단 바(어두운 여백)에 두어 문제를 가리지 않는다. */}
          <div className="flex w-full shrink-0 justify-end">
            <button
              type="button"
              onClick={() => setZoomed(false)}
              aria-label="닫기"
              className="rounded border border-white/50 bg-white/90 px-3 py-1 text-[12px] font-medium text-slate-700 hover:bg-white"
            >
              닫기
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cropUrl}
            alt={`${item.source_name} ${item.problem_no}번`}
            onMouseDown={(event) => event.stopPropagation()}
            className="min-h-0 w-auto max-w-full flex-1 rounded bg-white object-contain shadow-xl"
          />
        </div>
      ) : null}

      {item.memo ? <p className="line-clamp-2 text-[12px] text-slate-600">{item.memo}</p> : null}

      {/* 원본 시험지가 살아 있는 항목만 그 문항(file_id + problem_no)으로 풀이/변형한다. */}
      {item.source_available && item.source_node_id ? (
        <>
          <InlineSolutionPanel
            fileId={item.source_node_id}
            no={item.problem_no}
            className="mt-0"
          />
          <VariantPanel fileId={item.source_node_id} no={item.problem_no} className="mt-0" />
        </>
      ) : null}
    </li>
  );
}
