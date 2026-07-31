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
}

/**
 * "오답노트에 담기" 버튼 + 노트 선택 다이얼로그.
 * 노트 목록은 열 때마다 `GET /api/tree?section=note` 로 새로 받는다(최신 반영).
 */
export function AddToNoteButton({ sourceNodeId, problemNumbers, compact }: AddToNoteButtonProps) {
  const addProblemsToNote = useWorkspace((state) => state.addProblemsToNote);
  const createNote = useWorkspace((state) => state.createNote);
  const showToast = useWorkspace((state) => state.showToast);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [noteNodes, setNoteNodes] = useState<TreeNode[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setNoteNodes(null);
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

  const pick = async (noteId: string) => {
    setOpen(false);
    await addProblemsToNote(noteId, sourceNodeId, problemNumbers);
  };

  const label = problemNumbers.length === 1 ? '오답노트에 담기' : `${problemNumbers.length}개 담기`;

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
            <p className="mb-1 text-[12px] text-slate-500">담을 오답노트를 선택하세요.</p>
            <ul>
              {roots.map((item) => (
                <NotePickRow key={item.node.id} item={item} onPick={(id) => void pick(id)} />
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
              const made = [...nodes].reverse().find((node) => node.type === 'file' && node.name === value);
              if (made) await addProblemsToNote(made.id, sourceNodeId, problemNumbers);
            } catch (error) {
              showToast({ kind: 'error', message: toUserMessage(error) });
            }
          })();
        }}
      />
    </>
  );
}

function NotePickRow({ item, onPick }: { item: TreeItem; onPick: (id: string) => void }) {
  const { node } = item;
  const isFolder = node.type === 'folder';
  return (
    <li>
      <div style={{ paddingLeft: 4 + item.depth * 14 }}>
        {isFolder ? (
          <div className="flex items-center gap-1 py-1 text-[13px] text-slate-500">
            <span aria-hidden>📁</span>
            <span className="truncate">{node.name}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onPick(node.id)}
            className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-[13px] text-slate-700 hover:bg-blue-50"
          >
            <span aria-hidden>📕</span>
            <span className="truncate">{node.name}</span>
          </button>
        )}
      </div>
      {item.children.length > 0 ? (
        <ul>
          {item.children.map((child) => (
            <NotePickRow key={child.node.id} item={child} onPick={onPick} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
