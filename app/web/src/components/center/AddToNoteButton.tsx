'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/api-error';
import { Modal, DialogButton, PromptDialog } from '@/components/ui/Dialog';
import { LoadingState } from '@/components/ui/Feedback';
import { buildTree, type TreeItem } from '@/lib/tree';
import { useWorkspace } from '@/store/workspace';
import type { TreeNode } from '@/types/api';

interface AddToNoteButtonProps {
  /** 담을 문항이 속한 시험지 노드 id. */
  sourceNodeId: string;
  problemNumbers: number[];
  compact?: boolean;
  /** 담기에 성공한 뒤 호출(문항 선택 해제 등). */
  onDone?: () => void;
  /**
   * 선택 모드에서 쓰는 확정 버튼. 라벨을 "N개 노트 선택" 으로 바꾸고,
   * 고른 문항이 없으면 비활성으로 둔다.
   */
  autoOpen?: boolean;
}

/**
 * "오답노트에 담기" 버튼 + 노트 선택 다이얼로그.
 *
 * 문항도 노트도 여러 개를 고를 수 있다. 노트 목록은 열 때마다
 * `GET /api/tree?section=note` 로 새로 받는다(최신 반영).
 */
export function AddToNoteButton({
  sourceNodeId,
  problemNumbers,
  compact,
  onDone,
  autoOpen = false,
}: AddToNoteButtonProps) {
  const addProblemsToNotes = useWorkspace((state) => state.addProblemsToNotes);
  const createNote = useWorkspace((state) => state.createNote);
  const showToast = useWorkspace((state) => state.showToast);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [noteNodes, setNoteNodes] = useState<TreeNode[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setNoteNodes(null);
    setPicked(new Set());
    void (async () => {
      try {
        const { nodes } = await api.getTree('note');
        if (!cancelled) setNoteNodes(nodes);
      } catch (error) {
        if (!cancelled) {
          showToast({ kind: 'error', message: toUserMessage(error) });
          setOpen(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, showToast]);

  const noteFiles = (noteNodes ?? []).filter((node) => node.type === 'file');
  const roots = noteNodes ? buildTree(noteNodes) : [];

  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    const ok = await addProblemsToNotes([...picked], sourceNodeId, problemNumbers);
    setBusy(false);
    setOpen(false);
    if (ok) onDone?.();
  };

  const label = autoOpen
    ? problemNumbers.length > 0
      ? `${problemNumbers.length}개 담기`
      : '담을 문제를 고르세요'
    : problemNumbers.length > 1
      ? `${problemNumbers.length}개 담기`
      : '오답노트에 담기';
  const confirmLabel = picked.size > 1 ? `${picked.size}개 노트에 담기` : '담기';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={problemNumbers.length === 0}
        className={clsx(
          'rounded border font-medium disabled:opacity-40',
          compact
            ? 'border-rose-300 bg-white px-2 py-0.5 text-[11px] text-rose-700 hover:bg-rose-50'
            : 'border-rose-300 bg-white px-2.5 py-1 text-[12px] text-rose-700 hover:bg-rose-50',
        )}
      >
        {label}
      </button>

      <Modal
        open={open}
        title={`오답노트에 담기 (${problemNumbers.join(', ')}번)`}
        onClose={() => setOpen(false)}
        footer={
          <>
            <DialogButton onClick={() => setCreating(true)}>새 오답노트</DialogButton>
            <DialogButton onClick={() => setOpen(false)}>닫기</DialogButton>
            <DialogButton
              onClick={() => void submit()}
              disabled={picked.size === 0 || busy}
              tone="primary"
            >
              {busy ? '담는 중…' : confirmLabel}
            </DialogButton>
          </>
        }
      >
        {loading ? (
          <LoadingState label="오답노트 목록을 불러오는 중입니다…" />
        ) : noteFiles.length === 0 ? (
          <p className="text-[13px] text-slate-600">
            아직 오답노트가 없습니다. 아래 [새 오답노트] 로 만들어 담아 주세요.
          </p>
        ) : (
          <div className="max-h-[320px] overflow-auto">
            <p className="mb-1 text-[12px] text-slate-500">
              담을 오답노트를 선택하세요. (여러 개 가능)
            </p>
            <ul>
              {roots.map((item) => (
                <NotePickRow
                  key={item.node.id}
                  item={item}
                  picked={picked}
                  onToggle={toggle}
                />
              ))}
            </ul>
          </div>
        )}
      </Modal>

      <PromptDialog
        open={creating}
        title="새 오답노트"
        label="오답노트 이름 (예: 이현우 중간고사 오답)"
        confirmLabel="만들고 담기"
        onCancel={() => setCreating(false)}
        onSubmit={(value) => {
          setCreating(false);
          setOpen(false);
          void (async () => {
            const ok = await createNote(value, null);
            if (!ok) return;
            // 방금 만든 노트를 찾아 담는다.
            try {
              const { nodes } = await api.getTree('note');
              const made = [...nodes]
                .reverse()
                .find((node) => node.type === 'file' && node.name === value);
              if (made) {
                const added = await addProblemsToNotes(
                  [made.id],
                  sourceNodeId,
                  problemNumbers,
                );
                if (added) onDone?.();
              }
            } catch (error) {
              showToast({ kind: 'error', message: toUserMessage(error) });
            }
          })();
        }}
      />
    </>
  );
}

function NotePickRow({
  item,
  picked,
  onToggle,
}: {
  item: TreeItem;
  picked: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { node } = item;
  const isFolder = node.type === 'folder';
  const checked = picked.has(node.id);
  return (
    <li>
      <div style={{ paddingLeft: 4 + item.depth * 14 }}>
        {isFolder ? (
          <div className="flex items-center gap-1 py-1 text-[13px] text-slate-500">
            <span aria-hidden>📁</span>
            <span className="truncate">{node.name}</span>
          </div>
        ) : (
          <label className="flex w-full cursor-pointer items-center gap-1.5 rounded py-1 pr-2 text-[13px] text-slate-700 hover:bg-blue-50">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(node.id)}
              className="h-3.5 w-3.5 shrink-0 accent-rose-600"
            />
            <span aria-hidden>📕</span>
            <span className="truncate">{node.name}</span>
          </label>
        )}
      </div>
      {item.children.length > 0 ? (
        <ul>
          {item.children.map((child) => (
            <NotePickRow
              key={child.node.id}
              item={child}
              picked={picked}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
