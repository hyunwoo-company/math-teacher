'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react';
import clsx from 'clsx';
import { useWorkspace } from '@/store/workspace';
import {
  buildTree,
  countDescendants,
  filterTreeItems,
  matchNodeIds,
  type TreeItem,
} from '@/lib/tree';
import { autoScrollSpeed } from '@/lib/tree-autoscroll';
import {
  armClickGuard,
  isBlankClick,
  isDragCancelKey,
  shouldSuppressClick,
  NO_CLICK_GUARD,
  type ClickGuard,
} from '@/lib/tree-drag';
import { resolveDropTarget, resolveUploadTarget } from '@/lib/upload-target';
import { UPLOAD_NOTICE } from '@/lib/upload-notice';
import { ContextMenu, type ContextMenuItem } from '@/components/tree/ContextMenu';
import { MoveDialog } from '@/components/tree/MoveDialog';
import { NODE_MIME, TreeRow, type DragState } from '@/components/tree/TreeRow';
import { UploadTargetDialog } from '@/components/tree/UploadTargetDialog';
import {
  deleteSummary,
  dragPayloadIds,
  exceedsMarqueeThreshold,
  marqueeSelection,
  nextFocusId,
  nextSelection,
  normalizeRect,
  parseDragIds,
  selectAll,
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
  // 이동은 우클릭한 하나일 수도, 선택 전체일 수도 있다(드래그와 같은 규칙).
  | { kind: 'move'; ids: string[] }
  // 삭제는 항목 하나(컨텍스트 메뉴)일 수도, 선택 전체(드래그 삭제)일 수도 있다.
  | { kind: 'delete'; ids: string[] }
  // 파일을 고른 뒤 어느 폴더로 넣을지 확인받는 단계. `defaultFolderId` 는 추론해 둔 대상.
  | { kind: 'uploadTarget'; files: File[]; defaultFolderId: string | null };

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
  const collapseAll = useWorkspace((state) => state.collapseAll);
  const openNode = useWorkspace((state) => state.openNode);
  const createFolder = useWorkspace((state) => state.createFolder);
  const createNote = useWorkspace((state) => state.createNote);
  const renameNode = useWorkspace((state) => state.renameNode);
  const moveNodes = useWorkspace((state) => state.moveNodes);
  const deleteNode = useWorkspace((state) => state.deleteNode);
  const deleteNodes = useWorkspace((state) => state.deleteNodes);
  const uploadFiles = useWorkspace((state) => state.uploadFiles);
  const focusNode = useWorkspace((state) => state.focusNode);

  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [drag, setDragState] = useState<DragState | null>(null);
  // 끌기 직후 따라오는 click 을 한 번 무시하기 위한 표식. 렌더에 쓰지 않으므로 ref.
  const clickGuardRef = useRef<ClickGuard>(NO_CLICK_GUARD);
  // 드래그 삭제 영역 위에 올라와 있는지. 영역 자체는 드래그 중에만 그린다.
  const [trashOver, setTrashOver] = useState(false);
  // 다중 선택(이동용). 열려 있는 파일(selectedFileId)과는 다른 개념이다.
  const [pickedIds, setPickedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // 이름 검색어. 이름만 본다(문항 내용 검색이 아니다). 섹션을 바꾸면 비운다.
  const [query, setQuery] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  // 고무줄: 스크롤 컨테이너 + 진행 중 세션 + 화면에 그릴 사각형.
  const scrollRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<MarqueeSession | null>(null);
  const [marqueeOn, setMarqueeOn] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);

  const isNote = section === 'note';
  const allRoots = useMemo(() => buildTree(nodes), [nodes]);
  // null = 검색어 없음(전체 표시). 빈 Set = 일치 없음.
  const matchedIds = useMemo(() => matchNodeIds(nodes, query), [nodes, query]);
  const roots = useMemo(() => filterTreeItems(allRoots, matchedIds), [allRoots, matchedIds]);
  const searching = matchedIds != null;
  /**
   * 검색 중에는 결과가 보이도록 남은 폴더를 전부 펼쳐 그린다.
   * 스토어의 `expanded` 는 건드리지 않으므로, 검색어를 지우면 이전 펼침 상태가 그대로 돌아온다.
   */
  const effectiveExpanded = useMemo(() => {
    if (matchedIds == null) return expanded;
    const opened: Record<string, boolean> = { ...expanded };
    for (const id of matchedIds) opened[id] = true;
    return opened;
  }, [expanded, matchedIds]);
  /**
   * [모든 폴더 닫기] 를 켤지. 접기는 스토어의 `expanded` 만 건드리므로 판정도 그 값으로 한다
   * (검색 때문에 임시로 펼쳐진 폴더는 이 버튼으로 닫히지 않는다 = 눌러도 소용없으니 제외).
   * `toggleExpanded` 가 false 를 남길 수 있어 키 개수가 아니라 값이 true 인 것만 센다.
   */
  const hasExpanded = useMemo(() => Object.values(expanded).some(Boolean), [expanded]);
  const highlightedId = isNote ? selectedNoteId : selectedFileId;
  // 범위 선택은 "화면에 보이는 순서" 기준이다(접힌 폴더의 자식은 제외).
  const visibleIds = useMemo(
    () => visibleNodeIds(roots, effectiveExpanded),
    [roots, effectiveExpanded],
  );
  // 삭제·이동으로 사라진 id 가 선택에 남으면 개수 표시가 어긋난다. 렌더 중 걸러 낸다.
  const selectedIds = useMemo(() => {
    const alive = new Set(nodes.map((node) => node.id));
    const kept = new Set<string>();
    for (const id of pickedIds) if (alive.has(id)) kept.add(id);
    return kept;
  }, [nodes, pickedIds]);

  // setState 는 항상 같은 함수라 의존성이 없다. 이벤트 리스너에서 그대로 쓸 수 있게 고정한다.
  const clearSelection = useCallback(() => {
    setPickedIds(new Set());
    setAnchorId(null);
  }, []);

  /** 끌기 흔적을 전부 지운다(끝났거나 취소됐을 때). 선택은 건드리지 않는다. */
  const cancelDrag = useCallback(() => {
    setDragState(null);
    setDragOverId(null);
    setRootDragOver(false);
    setTrashOver(false);
  }, []);

  /**
   * 행이 알려 오는 끌기 시작/끝. 그때마다 시각을 찍어 둔다.
   *
   * 끌기가 끝난 직후에 click 이 따라오는 브라우저가 있다. 그대로 두면 옮기려고
   * 끌었을 뿐인데 파일이 열린다. {@link shouldSuppressClick} 이 그 한 번을 막는다.
   */
  const setDrag = (next: DragState | null) => {
    clickGuardRef.current = armClickGuard(Date.now());
    setDragState(next);
  };

  // 섹션이 바뀌면 트리가 통째로 바뀐다. 이전 섹션의 검색어를 끌고 가지 않는다.
  const switchSection = (next: typeof section) => {
    clearSelection();
    setQuery('');
    void setSection(next);
  };

  const handleRowClick = (event: MouseEvent, item: TreeItem) => {
    // 방금 끝난 끌기의 잔상 click 이면 아무 일도 일어나서는 안 된다
    // (옮기려고 끌었을 뿐인데 파일이 열리는 것을 막는다).
    if (shouldSuppressClick(clickGuardRef.current, Date.now())) {
      clickGuardRef.current = NO_CLICK_GUARD;
      return;
    }
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
   * 행에 실제 DOM 포커스를 준다.
   *
   * 스토어의 `focusedNodeId` 는 행의 `onFocus` 가 따라서 갱신하므로 여기서 따로
   * 부르지 않는다. `focus()` 가 화면 밖 행을 스크롤해 들여오는 것도 브라우저 몫이다.
   */
  const focusRow = useCallback((id: string) => {
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(id)}"]`,
    );
    row?.focus();
  }, []);

  /**
   * 트리 안에서의 키보드 조작.
   *
   * 행에서 올라오는 이벤트를 컨테이너 한 곳에서 받는다. 행마다 달면 포커스가
   * 빈 곳에 있을 때 Ctrl+A 가 먹지 않는다.
   *
   * ←→(폴더 접기·펼치기)와 Enter/Space(열기)는 행이 이미 처리한다. 여기서는
   * 행을 가로지르는 조작만 맡는다.
   */
  const handleTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 대화상자가 떠 있는 동안의 키는 그쪽 것이다.
    if (dialog.kind !== 'none') return;
    // 검색창에서 누른 키는 글자 입력이다(Ctrl+A 는 텍스트 전체 선택이어야 한다).
    if (event.target instanceof Element && event.target.closest('input, textarea') != null) return;

    // 한글 입력 상태에서는 `key` 가 'ㅁ' 으로 온다. 물리 키(`code`)도 함께 본다.
    const isSelectAll =
      (event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A' || event.code === 'KeyA');
    if (isSelectAll) {
      event.preventDefault();
      const result = selectAll(visibleIds);
      setPickedIds(result.selected);
      setAnchorId(result.anchorId);
      return;
    }

    if (event.key === 'Delete') {
      // 고른 것이 있으면 그것들을, 없으면 포커스가 있는 행 하나를 지운다.
      // 확인 창이 개수를 세어 보여주므로 여기서 바로 지우지는 않는다.
      const ids =
        selectedIds.size > 0
          ? visibleIds.filter((id) => selectedIds.has(id))
          : focusedNodeId != null
            ? [focusedNodeId]
            : [];
      if (ids.length === 0) return;
      event.preventDefault();
      setDialog({ kind: 'delete', ids });
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    // 방향키의 기본 동작은 컨테이너 스크롤이다. 행 이동으로 바꾼다.
    event.preventDefault();
    const target = nextFocusId(visibleIds, focusedNodeId, event.key === 'ArrowDown' ? 1 : -1);
    if (target == null) return;
    focusRow(target);

    if (!event.shiftKey) return;
    // 기준점이 없으면 지금 있던 자리를 기준으로 삼는다(Shift+클릭과 같은 규칙).
    const result = nextSelection({
      current: selectedIds,
      anchorId: anchorId ?? focusedNodeId ?? target,
      clickedId: target,
      modifiers: { toggle: false, range: true },
      visibleIds,
    });
    setPickedIds(result.selected);
    setAnchorId(result.anchorId);
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
      const session = marqueeRef.current;
      marqueeRef.current = null;
      setMarqueeOn(false);
      setMarqueeRect(null);
      // 빈 공간을 끌지 않고 그냥 눌렀다 뗀 것 = "선택 해제".
      // 끌기 흔적이 남아 있다면 그것도 여기서 확실히 지운다.
      if (!isBlankClick(session)) return;
      clearSelection();
      cancelDrag();
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
  }, [marqueeOn, cancelDrag, clearSelection]);

  /**
   * 끌기 상태의 마지막 안전장치.
   *
   * `dragend` 는 브라우저가 잘 주지만, 창 밖에서 끝난 끌기나 다른 창으로
   * 포커스가 넘어간 경우까지 믿을 수는 없다. 상태가 남으면 삭제 영역이 계속
   * 떠 있고 행이 반투명한 채로 굳는다. 여기서 통째로 지운다.
   *
   * Esc 는 선택까지 함께 푼다(끌던 것을 "없던 일로" 하는 동작).
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 검색어 지우기·대화상자 닫기가 이미 처리한 Esc 는 건드리지 않는다.
      if (!isDragCancelKey(event)) return;
      cancelDrag();
      clearSelection();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', cancelDrag);
    // 행·컨테이너의 onDrop 이 먼저 돌고 나서 여기로 올라온다(마지막 청소).
    window.addEventListener('dragend', cancelDrag);
    window.addEventListener('drop', cancelDrag);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('dragend', cancelDrag);
      window.removeEventListener('drop', cancelDrag);
    };
  }, [cancelDrag, clearSelection]);

  /**
   * 드래그 중 가장자리 자동 스크롤.
   *
   * 브라우저는 자체 스크롤 컨테이너를 대신 굴려 주지 않는다. 그래서 화면 밖의
   * 폴더로는 항목을 끌고 갈 수가 없었다.
   *
   * 리스너를 컨테이너 DOM 에 직접 단다. 행(`TreeRow`)의 `onDragOver` 가
   * `stopPropagation()` 을 하기 때문에 React 합성 이벤트로는 컨테이너까지
   * 올라오지 않는데, 네이티브 버블은 컨테이너를 먼저 지나가므로 여기서는 잡힌다.
   */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    // 렌더에 쓰지 않는 값이라 state 로 두지 않는다(프레임마다 다시 그릴 이유가 없다).
    let frame: number | null = null;
    let speed = 0;

    const stop = () => {
      speed = 0;
      if (frame != null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    const step = () => {
      frame = null;
      if (speed === 0) return;
      const before = container.scrollTop;
      const limit = Math.max(0, container.scrollHeight - container.clientHeight);
      const next = Math.min(limit, Math.max(0, before + speed));
      // 이미 끝까지 갔으면 아무것도 하지 않는다(다시 움직이면 dragover 가 깨운다).
      if (next === before) {
        stop();
        return;
      }
      container.scrollTop = next;
      frame = requestAnimationFrame(step);
    };

    const handleDragOver = (event: globalThis.DragEvent) => {
      const box = container.getBoundingClientRect();
      speed = autoScrollSpeed({ pointerY: event.clientY, top: box.top, bottom: box.bottom });
      if (speed === 0) {
        stop();
        return;
      }
      if (frame == null) frame = requestAnimationFrame(step);
    };

    const handleDragLeave = (event: globalThis.DragEvent) => {
      const box = container.getBoundingClientRect();
      // 자식 행으로 넘어갈 때도 dragleave 가 뜬다. 진짜로 컨테이너를 벗어났을 때만 멈춘다
      // (아니면 스크롤이 매 행마다 끊긴다).
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) stop();
    };

    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('dragleave', handleDragLeave);
    // 놓거나 취소하면 무조건 멈춘다. 창 밖에서 끝난 드래그까지 잡으려고 window 에서도 듣는다.
    window.addEventListener('drop', stop);
    window.addEventListener('dragend', stop);
    return () => {
      stop();
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', stop);
      window.removeEventListener('dragend', stop);
    };
  }, []);

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
    // 드래그가 힘든 깊은 트리를 위한 대안. 무엇을 옮길지는 끌기와 똑같이 정한다 —
    // 우클릭한 행이 선택 안에 있으면 선택 전체, 아니면 그 행 하나(`dragPayloadIds`).
    const moveIds = dragPayloadIds(selectedIds, node.id, visibleIds);
    items.push({
      label: moveIds.length > 1 ? `이동… (${moveIds.length}개)` : '이동…',
      onSelect: () => setDialog({ kind: 'move', ids: moveIds }),
    });
    items.push({
      label: '삭제',
      tone: 'danger',
      onSelect: () => setDialog({ kind: 'delete', ids: [node.id] }),
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

  // 항목 하나를 지울 때는 지금까지의 문구를 그대로 쓰고, 여러 개일 때만 요약으로 바꾼다.
  const deleteIds = dialog.kind === 'delete' ? dialog.ids : [];
  const singleDeleteId = deleteIds.length === 1 ? deleteIds[0] : null;
  const deleteTarget =
    singleDeleteId != null ? nodes.find((node) => node.id === singleDeleteId) : null;
  const deleteCounts =
    singleDeleteId != null && deleteTarget?.type === 'folder'
      ? countDescendants(nodes, singleDeleteId)
      : null;
  const multiDelete = deleteIds.length > 1 ? deleteSummary(nodes, deleteIds) : null;

  return (
    // relative: 드래그 삭제 영역을 하단에 겹쳐 띄운다(레이아웃이 밀리지 않게).
    <aside className="relative flex h-full w-full min-w-0 flex-col border-r border-slate-200 bg-white">
      {/* 섹션 전환 탭 */}
      <div role="tablist" aria-label="좌측 섹션" className="flex border-b border-slate-200">
        {/* 섹션이 바뀌면 트리가 통째로 바뀌므로 선택과 검색어를 버린다. */}
        <SectionTab active={section === 'exam'} onClick={() => switchSection('exam')}>
          시험지
        </SectionTab>
        <SectionTab active={section === 'note'} onClick={() => switchSection('note')}>
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
          {/* 트리 안의 폴더를 전부 접는다. 아래 [◂] (패널 자체 접기) 와는 다른 기능이다. */}
          <button
            type="button"
            onClick={collapseAll}
            disabled={!hasExpanded}
            aria-label="모든 폴더 닫기"
            title="모든 폴더 닫기"
            className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {/* 보이는 글자가 접근성 이름(`모든 폴더 닫기`)의 부분 문자열이어야 한다
                (WCAG 2.5.3). 음성으로 "폴더 닫기" 라고 말했을 때 이 버튼이 잡힌다. */}
            폴더 닫기
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

      {/* 이름 검색. 폴더·시험지·오답노트 이름만 본다. */}
      <div className="border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <input
            type="search"
            value={query}
            aria-label={isNote ? '오답노트 이름 검색' : '시험지 이름 검색'}
            placeholder="이름으로 찾기"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Esc 로 지운다. 브라우저 기본 동작(type=search 초기화)과 겹쳐도 결과는 같다.
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery('');
              }
            }}
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-[12px] text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          {query === '' ? null : (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="검색어 지우기"
              title="검색어 지우기 (Esc)"
              className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {pendingOp ? (
        <p className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
          {pendingOp}
        </p>
      ) : null}

      {selectedIds.size > 1 ? (
        <div className="flex items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-3 py-1.5 text-[11px] text-blue-800">
          <span>
            {selectedIds.size}개 선택됨 · 폴더로 끌어다 놓으면 함께 이동, 아래 삭제 영역에 놓으면
            함께 삭제됩니다
          </span>
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
        onKeyDown={handleTreeKeyDown}
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
        ) : searching && roots.length === 0 ? (
          <EmptyState
            title="검색 결과가 없습니다"
            description="이름의 일부만 입력해도 찾습니다. 문항 내용은 검색하지 않습니다."
            icon="🔍"
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
          <>
            <ul role="tree" aria-label={isNote ? '오답노트 폴더 트리' : '시험지 폴더 트리'}>
              {roots.map((item) => (
                <TreeRow
                  key={item.node.id}
                  item={item}
                  expanded={effectiveExpanded}
                  query={query}
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
            {/*
              목록 아래 여백(96px). 마지막 행 바로 밑이 곧 끝이면 최상위로 빼낼 자리도,
              드래그를 놓을 여유도 없다. dragover·drop 을 따로 처리하지 않고 그대로
              컨테이너로 올려보낸다 = 최상위로 이동(`onDrop` 의 `dropNodes(ids, null)`).
              빈 공간이므로 여기서 고무줄 선택이 시작되는 것도 그대로 둔다.
            */}
            <div data-testid="tree-tail-space" className="h-24 w-full" />
          </>
        )}

        {marqueeRect ? (
          <div
            aria-hidden
            data-testid="tree-marquee"
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
          // 같은 파일을 연달아 고를 수 있게 즉시 비운다(취소해도 다음 선택이 먹는다).
          event.target.value = '';
          if (files.length === 0) return;
          // 바로 올리지 않고 어느 폴더로 넣을지 확인받는다. 추론한 대상은 기본값으로 넘긴다.
          setDialog({ kind: 'uploadTarget', files, defaultFolderId: uploadTargetRef.current });
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

      {dialog.kind === 'move' ? (
        <MoveDialog
          nodes={nodes}
          movingIds={dialog.ids}
          section={section}
          onCancel={() => setDialog({ kind: 'none' })}
          onMove={(parentId) => {
            const ids = dialog.kind === 'move' ? dialog.ids : [];
            setDialog({ kind: 'none' });
            // 실패는 `moveNodes` 가 토스트로 알린다. 여기서 또 띄우지 않는다.
            // 선택은 유지한다(드래그 이동과 같다 — 옮긴 것들이 그대로 선택되어 있다).
            void moveNodes(ids, parentId);
          }}
        />
      ) : null}

      {dialog.kind === 'uploadTarget' ? (
        <UploadTargetDialog
          nodes={nodes}
          section={section}
          files={dialog.files}
          defaultFolderId={dialog.defaultFolderId}
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={(folderId) => {
            const files = dialog.files;
            setDialog({ kind: 'none' });
            // 성공·실패 모두 `uploadFiles` 가 토스트로 알린다.
            void uploadFiles(files, folderId);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={dialog.kind === 'delete'}
        title="삭제 확인"
        confirmLabel="삭제"
        onCancel={() => setDialog({ kind: 'none' })}
        onConfirm={() => {
          if (dialog.kind !== 'delete') return;
          const ids = dialog.ids;
          setDialog({ kind: 'none' });
          clearSelection();
          if (ids.length === 1 && ids[0] != null) void deleteNode(ids[0]);
          else void deleteNodes(ids);
        }}
        message={
          multiDelete ? (
            <div className="space-y-2">
              <p>
                고른 <span className="font-semibold">{deleteIds.length}개</span> 항목을 삭제할까요?
              </p>
              <ul className="max-h-32 overflow-auto rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[12px] text-slate-600">
                {multiDelete.names.map((name, index) => (
                  <li key={`${name}-${index}`} className="truncate">
                    · {name}
                  </li>
                ))}
              </ul>
              {multiDelete.total > deleteIds.length ? (
                <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-800">
                  폴더 안의 하위 폴더 {multiDelete.descendantFolders}개와{' '}
                  {isNote ? '노트' : '파일'} {multiDelete.descendantFiles}개까지{' '}
                  <span className="font-semibold">모두 {multiDelete.total}개가 함께 삭제</span>
                  됩니다.
                  {isNote ? '' : ' 문제 크롭과 저장된 풀이도 같이 지워집니다.'}
                </p>
              ) : null}
              {multiDelete.files > 0 ? (
                <p className="text-[12px] text-slate-500">
                  {isNote
                    ? '고른 오답노트의 항목이 모두 지워집니다. (원본 시험지는 지워지지 않습니다.)'
                    : '고른 시험지의 문제 크롭과 저장된 풀이·대화 기록도 함께 지워집니다.'}
                </p>
              ) : null}
              <p className="text-[12px] text-slate-500">이 작업은 되돌릴 수 없습니다.</p>
            </div>
          ) : (
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
          )
        }
      />

      {/* 드래그 삭제: 끌고 있는 동안에만 나타난다. 평소에 상시 노출하면 오조작 위험이 크다. */}
      {drag ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-2">
          <div
            aria-hidden
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(NODE_MIME)) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              setTrashOver(true);
            }}
            onDragLeave={(event) => {
              event.stopPropagation();
              setTrashOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              // getData 가 비는 브라우저가 있어 끌고 있던 목록을 예비로 쓴다.
              const dropped = parseDragIds(event.dataTransfer.getData(NODE_MIME));
              const doomed = dropped.length > 0 ? dropped : drag.ids;
              setTrashOver(false);
              setDragOverId(null);
              setDrag(null);
              // 삭제는 되돌릴 수 없다. 반드시 확인 창을 거친다.
              if (doomed.length > 0) setDialog({ kind: 'delete', ids: doomed });
            }}
            className={clsx(
              'pointer-events-auto flex h-14 items-center justify-center gap-2 rounded-md border-2 border-dashed text-[12px] font-medium shadow-sm transition-colors',
              trashOver
                ? 'border-rose-500 bg-rose-100 text-rose-800'
                : 'border-rose-300 bg-white/95 text-rose-600',
            )}
          >
            <span aria-hidden className="text-[16px]">
              🗑
            </span>
            <span>
              여기에 놓으면 삭제
              {drag.ids.length > 1 ? ` (${drag.ids.length}개)` : ''}
            </span>
          </div>
        </div>
      ) : null}
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
