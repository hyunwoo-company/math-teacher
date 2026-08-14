'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import clsx from 'clsx';
import { useWorkspace } from '@/store/workspace';
import { buildTree, countDescendants, type TreeItem } from '@/lib/tree';
import { resolveDropTarget, resolveUploadTarget } from '@/lib/upload-target';
import { UPLOAD_NOTICE } from '@/lib/upload-notice';
import { ContextMenu, type ContextMenuItem } from '@/components/tree/ContextMenu';
import { NODE_MIME, TreeRow, type DragState } from '@/components/tree/TreeRow';
import {
  dragPayloadIds,
  exceedsMarqueeThreshold,
  marqueeSelection,
  nextSelection,
  normalizeRect,
  parseDragIds,
  shouldStartMarquee,
  toContainerPoint,
  visibleNodeIds,
  type Point,
  type Rect,
  type RowBox,
} from '@/components/tree/selection';
import { ConfirmDialog, PromptDialog } from '@/components/ui/Dialog';
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/ui/Feedback';

/** 고무줄 한 번의 상태. 렌더에 쓰지 않고 ref 로만 들고 있어 mousemove 마다 다시 그리지 않는다. */
interface MarqueeSession {
  /** 누른 지점(컨테이너 내용 좌표). */
  start: Point;
  /** 시작 시점 선택. 사각형을 줄였을 때 되돌릴 기준이다. */
  base: ReadonlySet<string>;
  /** 시작 시점 행 위치들. 끌고 있는 동안 트리는 바뀌지 않으므로 한 번만 읽는다. */
  rows: RowBox[];
  /** Ctrl/Cmd 를 누른 채 시작했는지(기존 선택에 더한다). */
  additive: boolean;
  /** 임계값을 넘겨 실제 고무줄이 됐는지. 안 넘겼으면 그냥 클릭이다. */
  moved: boolean;
}

/** 이 위에서 누른 mousedown 은 고무줄이 아니라 컨트롤 조작이다. */
const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"]';

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
  const moveNodes = useWorkspace((state) => state.moveNodes);
  const deleteNode = useWorkspace((state) => state.deleteNode);
  const uploadFiles = useWorkspace((state) => state.uploadFiles);
  const focusNode = useWorkspace((state) => state.focusNode);

  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  // 다중 선택(이동용). 열려 있는 파일(selectedFileId)과는 다른 개념이다.
  const [pickedIds, setPickedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  // 고무줄: 스크롤 컨테이너 + 진행 중 세션 + 화면에 그릴 사각형.
  const scrollRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<MarqueeSession | null>(null);
  const [marqueeOn, setMarqueeOn] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);

  const isNote = section === 'note';
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  const highlightedId = isNote ? selectedNoteId : selectedFileId;
  // 범위 선택은 "화면에 보이는 순서" 기준이다(접힌 폴더의 자식은 제외).
  const visibleIds = useMemo(() => visibleNodeIds(roots, expanded), [roots, expanded]);
  // 삭제·이동으로 사라진 id 가 선택에 남으면 개수 표시가 어긋난다. 렌더 중 걸러 낸다.
  const selectedIds = useMemo(() => {
    const alive = new Set(nodes.map((node) => node.id));
    const kept = new Set<string>();
    for (const id of pickedIds) if (alive.has(id)) kept.add(id);
    return kept;
  }, [nodes, pickedIds]);

  const clearSelection = () => {
    setPickedIds(new Set());
    setAnchorId(null);
  };

  const handleRowClick = (event: MouseEvent, item: TreeItem) => {
    const modifiers = { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey };
    const result = nextSelection({
      current: selectedIds,
      anchorId,
      clickedId: item.node.id,
      modifiers,
      visibleIds,
    });
    setPickedIds(result.selected);
    setAnchorId(result.anchorId);

    // 수정키를 쓴 클릭은 "고르는" 동작이다. 파일을 열거나 폴더를 접었다 펴지 않는다.
    if (modifiers.toggle || modifiers.range) return;
    focusNode(item.node.id);
    if (item.node.type === 'folder') toggleExpanded(item.node.id);
    else void openNode(item.node.id);
  };

  /**
   * 빈 공간에서 누르면 고무줄을 준비한다.
   * 행 위에서 누른 것은 건드리지 않는다 — 그건 기존 HTML5 드래그 이동이다.
   */
  const handleTreeMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) return;
    const target = event.target instanceof Element ? event.target : null;
    const onRow = target?.closest('[data-node-id]') != null;
    const onInteractive = target?.closest(INTERACTIVE_SELECTOR) != null;
    if (!shouldStartMarquee({ button: event.button, onRow, onInteractive })) return;

    const additive = event.ctrlKey || event.metaKey;
    marqueeRef.current = {
      start: toContainerPoint(
        { x: event.clientX, y: event.clientY },
        containerOrigin(container),
      ),
      base: additive ? new Set(selectedIds) : new Set(),
      rows: readRowBoxes(container),
      additive,
      moved: false,
    };
    setMarqueeOn(true);
    // 빈 공간을 끌 때 안내 문구가 텍스트 선택으로 파랗게 잡히는 것을 막는다.
    event.preventDefault();
  };

  // 고무줄은 window 에서 듣는다. 커서가 패널을 벗어나거나 밖에서 손을 떼도 확정된다.
  useEffect(() => {
    if (!marqueeOn) return;

    const finish = () => {
      marqueeRef.current = null;
      setMarqueeOn(false);
      setMarqueeRect(null);
    };

    const handleMove = (event: globalThis.MouseEvent) => {
      const session = marqueeRef.current;
      const container = scrollRef.current;
      if (!session || !container) {
        finish();
        return;
      }
      const point = toContainerPoint(
        { x: event.clientX, y: event.clientY },
        containerOrigin(container),
      );
      // 몇 px 안 움직였으면 아직 클릭이다. 선택을 건드리지 않는다.
      if (!session.moved && !exceedsMarqueeThreshold(session.start, point)) return;
      session.moved = true;

      const rect = normalizeRect(session.start, point);
      const result = marqueeSelection({
        base: session.base,
        rows: session.rows,
        rect,
        additive: session.additive,
      });
      setMarqueeRect(rect);
      setPickedIds(result.selected);
      // 아무 행도 안 잡았으면 기존 기준점을 그대로 둔다(Shift 클릭이 죽지 않게).
      setAnchorId((previous) => result.anchorId ?? previous);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', finish);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', finish);
    };
  }, [marqueeOn]);

  const beginDrag = (nodeId: string): string[] => {
    const ids = dragPayloadIds(selectedIds, nodeId, visibleIds);
    // 선택 밖의 행을 끌면 그 행 하나만 옮긴다. 그러면 화면 표시도 거기에 맞춰야
    // "파랗게 칠해진 3개" 를 끄는 줄 알았는데 1개만 움직이는 착시가 안 생긴다.
    if (!selectedIds.has(nodeId)) {
      setPickedIds(new Set([nodeId]));
      setAnchorId(nodeId);
    }
    return ids;
  };

  const dropNodes = (draggedIds: string[], targetFolderId: string | null) => {
    if (draggedIds.length === 0) return;
    void moveNodes(draggedIds, targetFolderId);
  };

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
        {/* 섹션이 바뀌면 트리가 통째로 바뀌므로 선택을 버린다. */}
        <SectionTab
          active={section === 'exam'}
          onClick={() => {
            clearSelection();
            void setSection('exam');
          }}
        >
          시험지
        </SectionTab>
        <SectionTab
          active={section === 'note'}
          onClick={() => {
            clearSelection();
            void setSection('note');
          }}
        >
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

      {selectedIds.size > 1 ? (
        <div className="flex items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-3 py-1.5 text-[11px] text-blue-800">
          <span>{selectedIds.size}개 선택됨 · 폴더로 끌어다 놓으면 함께 이동합니다</span>
          <button
            type="button"
            onClick={clearSelection}
            className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-blue-100"
          >
            선택 해제
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        // relative: 고무줄 사각형을 이 컨테이너의 내용 좌표계에 붙인다(스크롤과 함께 움직인다).
        className={
          'relative min-h-0 flex-1 overflow-auto px-1 py-1 ' +
          (rootDragOver ? 'bg-blue-50/60 ring-2 ring-blue-300 ring-inset' : '')
        }
        onMouseDown={handleTreeMouseDown}
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
          setDrag(null);
          const draggedIds = parseDragIds(event.dataTransfer.getData(NODE_MIME));
          if (draggedIds.length > 0) {
            dropNodes(draggedIds, null);
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
                selectedIds={selectedIds}
                dragOverId={dragOverId}
                setDragOverId={setDragOverId}
                drag={drag}
                setDrag={setDrag}
                onToggle={toggleExpanded}
                onSelectFile={(id) => void openNode(id)}
                onFocusNode={focusNode}
                onRowClick={handleRowClick}
                onContextMenu={openRowMenu}
                getDragIds={beginDrag}
                onDropNode={dropNodes}
                onDropFiles={dropFilesOnNode}
              />
            ))}
          </ul>
        )}

        {marqueeRect ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 rounded-sm border border-blue-400 bg-blue-400/20"
            style={{
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.right - marqueeRect.left,
              height: marqueeRect.bottom - marqueeRect.top,
            }}
          />
        ) : null}
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

/** 스크롤 컨테이너의 화면 원점 + 현재 스크롤량. 좌표 변환의 기준. */
function containerOrigin(container: HTMLElement): {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
} {
  const box = container.getBoundingClientRect();
  return {
    left: box.left,
    top: box.top,
    scrollLeft: container.scrollLeft,
    scrollTop: container.scrollTop,
  };
}

/**
 * 지금 그려진 행들의 위치를 컨테이너 내용 좌표로 읽는다.
 * 고무줄 시작 때 한 번만 부른다(끌고 있는 동안 트리는 바뀌지 않는다).
 */
function readRowBoxes(container: HTMLElement): RowBox[] {
  const origin = containerOrigin(container);
  const boxes: RowBox[] = [];
  for (const element of container.querySelectorAll('[data-node-id]')) {
    const id = element.getAttribute('data-node-id');
    if (id == null || id === '') continue;
    const box = element.getBoundingClientRect();
    const topLeft = toContainerPoint({ x: box.left, y: box.top }, origin);
    boxes.push({
      id,
      rect: {
        left: topLeft.x,
        top: topLeft.y,
        right: topLeft.x + box.width,
        bottom: topLeft.y + box.height,
      },
    });
  }
  return boxes;
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
