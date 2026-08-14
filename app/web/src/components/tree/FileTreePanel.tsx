'use client';

import { useMemo, useRef, useState, type MouseEvent } from 'react';
import clsx from 'clsx';
import { useWorkspace } from '@/store/workspace';
import { buildTree, countDescendants, type TreeItem } from '@/lib/tree';
import { resolveDropTarget, resolveUploadTarget } from '@/lib/upload-target';
import { UPLOAD_NOTICE } from '@/lib/upload-notice';
import { ContextMenu, type ContextMenuItem } from '@/components/tree/ContextMenu';
import { NODE_MIME, TreeRow } from '@/components/tree/TreeRow';
import { ConfirmDialog, PromptDialog } from '@/components/ui/Dialog';
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/ui/Feedback';

type DialogState =
  | { kind: 'none' }
  | { kind: 'newFolder'; parentId: string | null }
  | { kind: 'newNote'; parentId: string | null }
  | { kind: 'rename'; id: string; current: string }
  | { kind: 'delete'; id: string };

/** 좌측 패널: [시험지]/[오답노트] 2섹션 트리. 너비는 부모가 정하고 이 패널은 채운다. */
export function FileTreePanel({ onCollapse }: { onCollapse?: () => void }) {
  const section = useWorkspace((state) => state.section);
  const nodes = useWorkspace((state) => state.nodes);
  const treeStatus = useWorkspace((state) => state.treeStatus);
  const treeError = useWorkspace((state) => state.treeError);
  const expanded = useWorkspace((state) => state.expanded);
  const selectedFileId = useWorkspace((state) => state.selectedFileId);
  const selectedNoteId = useWorkspace((state) => state.selectedNoteId);
  const focusedNodeId = useWorkspace((state) => state.focusedNodeId);
  const pendingOp = useWorkspace((state) => state.pendingOp);

  const setSection = useWorkspace((state) => state.setSection);
  const loadTree = useWorkspace((state) => state.loadTree);
  const toggleExpanded = useWorkspace((state) => state.toggleExpanded);
  const openNode = useWorkspace((state) => state.openNode);
  const createFolder = useWorkspace((state) => state.createFolder);
  const createNote = useWorkspace((state) => state.createNote);
  const renameNode = useWorkspace((state) => state.renameNode);
  const moveNode = useWorkspace((state) => state.moveNode);
  const deleteNode = useWorkspace((state) => state.deleteNode);
  const uploadFiles = useWorkspace((state) => state.uploadFiles);
  const focusNode = useWorkspace((state) => state.focusNode);

  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);

  const isNote = section === 'note';
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  const highlightedId = isNote ? selectedNoteId : selectedFileId;

  // 하단 버튼이 어디로 만들지/올리는지. 누르기 전에 라벨로 보여 준다.
  const uploadTarget = useMemo(
    () => resolveUploadTarget(nodes, focusedNodeId, isNote ? selectedNoteId : selectedFileId),
    [nodes, focusedNodeId, isNote, selectedNoteId, selectedFileId],
  );

  const dropFilesOnNode = (files: File[], dropNodeId: string) => {
    // 오답노트 섹션은 PDF 업로드 대상이 아니다.
    if (isNote) return;
    const target = resolveDropTarget(nodes, dropNodeId);
    void uploadFiles(files, target.folderId);
  };

  const openRowMenu = (event: MouseEvent, item: TreeItem) => {
    event.preventDefault();
    event.stopPropagation();
    const { node } = item;
    const items: ContextMenuItem[] = [];
    if (node.type === 'folder') {
      items.push({
        label: '새 폴더',
        onSelect: () => setDialog({ kind: 'newFolder', parentId: node.id }),
      });
      if (isNote) {
        items.push({
          label: '새 오답노트',
          onSelect: () => setDialog({ kind: 'newNote', parentId: node.id }),
        });
      } else {
        items.push({
          label: '파일 업로드',
          onSelect: () => {
            uploadTargetRef.current = node.id;
            fileInputRef.current?.click();
          },
        });
      }
    }
    items.push({
      label: '이름 변경',
      onSelect: () => setDialog({ kind: 'rename', id: node.id, current: node.name }),
    });
    items.push({
      label: '삭제',
      tone: 'danger',
      onSelect: () => setDialog({ kind: 'delete', id: node.id }),
    });
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openRootMenu = (event: MouseEvent) => {
    event.preventDefault();
    const items: ContextMenuItem[] = [
      {
        label: '새 폴더 (최상위)',
        onSelect: () => setDialog({ kind: 'newFolder', parentId: null }),
      },
    ];
    if (isNote) {
      items.push({
        label: '새 오답노트 (최상위)',
        onSelect: () => setDialog({ kind: 'newNote', parentId: null }),
      });
    } else {
      items.push({
        label: '파일 업로드 (최상위)',
        onSelect: () => {
          uploadTargetRef.current = null;
          fileInputRef.current?.click();
        },
      });
    }
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const deleteTarget = dialog.kind === 'delete' ? nodes.find((node) => node.id === dialog.id) : null;
  const deleteCounts =
    dialog.kind === 'delete' && deleteTarget?.type === 'folder'
      ? countDescendants(nodes, dialog.id)
      : null;

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-slate-200 bg-white">
      {/* 섹션 전환 탭 */}
      <div role="tablist" aria-label="좌측 섹션" className="flex border-b border-slate-200">
        <SectionTab active={section === 'exam'} onClick={() => void setSection('exam')}>
          시험지
        </SectionTab>
        <SectionTab active={section === 'note'} onClick={() => void setSection('note')}>
          오답노트
        </SectionTab>
      </div>

      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="text-[13px] font-semibold text-slate-700">
          {isNote ? '오답노트' : '시험지 보관함'}
        </h2>
        <div className="flex items-center gap-2">
          {pendingOp ? <Spinner className="h-3.5 w-3.5" /> : null}
          <button
            type="button"
            onClick={() => void loadTree()}
            title="목록 새로 고침"
            className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100"
          >
            새로 고침
          </button>
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              aria-expanded
              aria-label="왼쪽 메뉴 접기"
              title="왼쪽 메뉴 접기"
              className="rounded px-1.5 py-0.5 text-[13px] leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              ◂
            </button>
          ) : null}
        </div>
      </header>

      {pendingOp ? (
        <p className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
          {pendingOp}
        </p>
      ) : null}

      <div
        className={
          'min-h-0 flex-1 overflow-auto px-1 py-1 ' +
          (rootDragOver ? 'bg-blue-50/60 ring-2 ring-blue-300 ring-inset' : '')
        }
        onContextMenu={openRootMenu}
        onDragOver={(event) => {
          const hasNode = event.dataTransfer.types.includes(NODE_MIME);
          const hasFiles = event.dataTransfer.types.includes('Files');
          if (!hasNode && !hasFiles) return;
          if (hasFiles && isNote) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = hasFiles && !hasNode ? 'copy' : 'move';
          setRootDragOver(true);
        }}
        onDragLeave={() => setRootDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setRootDragOver(false);
          setDragOverId(null);
          setDraggingId(null);
          const draggedId = event.dataTransfer.getData(NODE_MIME);
          if (draggedId) {
            void moveNode(draggedId, null);
            return;
          }
          if (isNote) return;
          const files = Array.from(event.dataTransfer.files ?? []);
          if (files.length > 0) void uploadFiles(files, null);
        }}
      >
        {treeStatus === 'loading' && nodes.length === 0 ? (
          <LoadingState label={isNote ? '오답노트를 불러오는 중입니다…' : '보관함을 불러오는 중입니다…'} />
        ) : treeStatus === 'error' ? (
          <ErrorState
            message={treeError ?? '목록을 불러오지 못했습니다.'}
            onRetry={() => void loadTree()}
          />
        ) : roots.length === 0 ? (
          isNote ? (
            <EmptyState
              title="아직 오답노트가 없습니다"
              description="아래 [+ 폴더] 로 학생 폴더를 만들고 [+ 노트] 로 오답노트를 만들어 보세요. 채팅에서 '5번 이현우 오답노트에 추가해줘' 처럼 말해도 담깁니다."
              icon="📕"
            />
          ) : (
            <EmptyState
              title="아직 보관함이 비어 있습니다"
              description={`아래 [+ 폴더] 로 학기·과목 폴더를 만들고, [+ 파일 업로드] 로 시험지 PDF를 넣어 보세요. 파일을 이 영역에 끌어다 놓아도 됩니다. ${UPLOAD_NOTICE}`}
              icon="📁"
            />
          )
        ) : (
          <ul role="tree" aria-label={isNote ? '오답노트 폴더 트리' : '시험지 폴더 트리'}>
            {roots.map((item) => (
              <TreeRow
                key={item.node.id}
                item={item}
                expanded={expanded}
                selectedFileId={highlightedId}
                dragOverId={dragOverId}
                setDragOverId={setDragOverId}
                draggingId={draggingId}
                setDraggingId={setDraggingId}
                onToggle={toggleExpanded}
                onSelectFile={(id) => void openNode(id)}
                onFocusNode={focusNode}
                onContextMenu={openRowMenu}
                onDropNode={(draggedId, targetId) => void moveNode(draggedId, targetId)}
                onDropFiles={dropFilesOnNode}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="border-t border-slate-200 p-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDialog({ kind: 'newFolder', parentId: uploadTarget.folderId })}
            title={`${uploadTarget.label} 안에 새 폴더를 만듭니다`}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
          >
            + 폴더
          </button>
          {isNote ? (
            <button
              type="button"
              onClick={() => setDialog({ kind: 'newNote', parentId: uploadTarget.folderId })}
              title={`${uploadTarget.label} 안에 오답노트를 만듭니다`}
              className="flex-[1.4] rounded border border-slate-300 bg-white px-2 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
            >
              + 노트
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                uploadTargetRef.current = uploadTarget.folderId;
                fileInputRef.current?.click();
              }}
              title={`${uploadTarget.label} 에 PDF를 올립니다`}
              className="flex-[1.4] rounded border border-slate-300 bg-white px-2 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
            >
              + 파일 업로드
            </button>
          )}
        </div>
        <p className="mt-1 truncate text-[11px] text-slate-500" title={uploadTarget.label}>
          {isNote ? '만들 위치' : '업로드 위치'}{' '}
          <span className="font-medium text-slate-700">→ {uploadTarget.label}</span>
          {uploadTarget.folderId == null ? (
            <span className="text-slate-400"> (폴더를 클릭하면 그 안에 만듭니다)</span>
          ) : null}
        </p>
        {isNote ? null : <p className="mt-1 text-[11px] text-amber-700">{UPLOAD_NOTICE}</p>}
      </footer>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) void uploadFiles(files, uploadTargetRef.current);
        }}
      />

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}

      <PromptDialog
        open={dialog.kind === 'newFolder'}
        title="새 폴더"
        label="폴더 이름"
        initialValue=""
        confirmLabel="만들기"
        onCancel={() => setDialog({ kind: 'none' })}
        onSubmit={(value) => {
          const parentId = dialog.kind === 'newFolder' ? dialog.parentId : null;
          setDialog({ kind: 'none' });
          void createFolder(value, parentId);
        }}
      />

      <PromptDialog
        open={dialog.kind === 'newNote'}
        title="새 오답노트"
        label="오답노트 이름 (예: 중간고사 오답)"
        initialValue=""
        confirmLabel="만들기"
        onCancel={() => setDialog({ kind: 'none' })}
        onSubmit={(value) => {
          const parentId = dialog.kind === 'newNote' ? dialog.parentId : null;
          setDialog({ kind: 'none' });
          void createNote(value, parentId);
        }}
      />

      <PromptDialog
        open={dialog.kind === 'rename'}
        title="이름 변경"
        label="새 이름"
        initialValue={dialog.kind === 'rename' ? dialog.current : ''}
        confirmLabel="변경"
        onCancel={() => setDialog({ kind: 'none' })}
        onSubmit={(value) => {
          if (dialog.kind !== 'rename') return;
          const id = dialog.id;
          setDialog({ kind: 'none' });
          void renameNode(id, value);
        }}
      />

      <ConfirmDialog
        open={dialog.kind === 'delete'}
        title="삭제 확인"
        confirmLabel="삭제"
        onCancel={() => setDialog({ kind: 'none' })}
        onConfirm={() => {
          if (dialog.kind !== 'delete') return;
          const id = dialog.id;
          setDialog({ kind: 'none' });
          void deleteNode(id);
        }}
        message={
          <div className="space-y-2">
            <p>
              <span className="font-semibold">{deleteTarget?.name ?? '항목'}</span>
              {deleteTarget?.type === 'folder'
                ? ' 폴더를 삭제할까요?'
                : isNote
                  ? ' 오답노트를 삭제할까요?'
                  : ' 파일을 삭제할까요?'}
            </p>
            {deleteTarget?.type === 'folder' ? (
              <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-800">
                폴더 안의 하위 폴더 {deleteCounts?.folders ?? 0}개와{' '}
                {isNote ? '노트' : '파일'} {deleteCounts?.files ?? 0}개가{' '}
                <span className="font-semibold">모두 함께 삭제</span>됩니다.
                {isNote ? '' : ' 문제 크롭과 저장된 풀이도 같이 지워집니다.'}
              </p>
            ) : isNote ? (
              <p className="text-[12px] text-slate-500">
                이 오답노트의 항목이 모두 지워집니다. (원본 시험지는 지워지지 않습니다.)
              </p>
            ) : (
              <p className="text-[12px] text-slate-500">
                이 파일의 문제 크롭과 저장된 풀이·대화 기록도 함께 지워집니다. 이 시험지를 담은
                오답노트 항목은 &quot;원본 삭제됨&quot; 으로 남습니다.
              </p>
            )}
            <p className="text-[12px] text-slate-500">이 작업은 되돌릴 수 없습니다.</p>
          </div>
        }
      />
    </aside>
  );
}

function SectionTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        'flex-1 border-b-2 py-2 text-[13px] font-medium',
        active
          ? 'border-blue-600 text-blue-700'
          : 'border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700',
      )}
    >
      {children}
    </button>
  );
}
