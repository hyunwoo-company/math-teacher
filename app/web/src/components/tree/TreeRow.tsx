'use client';

import clsx from 'clsx';
import type { DragEvent, MouseEvent } from 'react';
import { splitHighlight, type TreeItem } from '@/lib/tree';
import { parseDragIds } from '@/components/tree/selection';

/** 끌고 있는 노드들. `fromId` 는 끌기를 시작한 행(배지를 그 행에 붙인다). */
export interface DragState {
  ids: string[];
  fromId: string;
}

export interface TreeRowCallbacks {
  onToggle: (id: string) => void;
  onSelectFile: (id: string) => void;
  /** 폴더/파일 아무 행이나 만졌을 때. 업로드 대상 계산에 쓴다. */
  onFocusNode: (id: string) => void;
  /**
   * 행 클릭. 수정키(Ctrl/Cmd·Shift)를 봐야 하므로 이벤트째 넘긴다.
   * 선택 갱신과 열기/펼치기 판단은 전부 패널이 한다.
   */
  onRowClick: (event: MouseEvent, item: TreeItem) => void;
  onContextMenu: (event: MouseEvent, item: TreeItem) => void;
  /** 이 행에서 끌기 시작할 때 실을 노드 id 들(선택 전체 또는 이 행 하나). */
  getDragIds: (nodeId: string) => string[];
  onDropNode: (draggedIds: string[], targetFolderId: string | null) => void;
  /**
   * OS 에서 끌어온 파일을 이 행 "위에" 떨궜을 때.
   * 대상 폴더 결정은 패널이 `resolveDropTarget()` 으로 한다(파일 위 = 그 파일의 부모).
   */
  onDropFiles: (files: File[], dropNodeId: string) => void;
}

interface TreeRowProps extends TreeRowCallbacks {
  item: TreeItem;
  expanded: Record<string, boolean>;
  selectedFileId: string | null;
  /** 다중 선택된 노드들(열려 있는 파일과는 별개다). */
  selectedIds: ReadonlySet<string>;
  dragOverId: string | null;
  setDragOverId: (id: string | null) => void;
  drag: DragState | null;
  setDrag: (drag: DragState | null) => void;
  /** 이름 검색어. 일치한 부분만 강조한다. 비면 강조하지 않는다. */
  query?: string;
}

const NODE_MIME = 'application/x-math-teacher-node';

/** 트리 한 행 + 하위 행들(재귀). 중첩 깊이 제한 없음. */
export function TreeRow(props: TreeRowProps) {
  const {
    item,
    expanded,
    selectedFileId,
    selectedIds,
    dragOverId,
    setDragOverId,
    drag,
    setDrag,
    query = '',
    onToggle,
    onSelectFile,
    onFocusNode,
    onRowClick,
    onContextMenu,
    getDragIds,
    onDropNode,
    onDropFiles,
  } = props;

  const { node } = item;
  const isFolder = node.type === 'folder';
  const isOpen = isFolder && expanded[node.id] === true;
  const isOpened = !isFolder && selectedFileId === node.id;
  const isPicked = selectedIds.has(node.id);
  // 파일 행도 드롭 대상이 된다(그 파일이 든 폴더로 업로드). 그래서 폴더 조건을 빼야 한다.
  const isDropTarget = dragOverId === node.id;
  const isDragging = drag?.ids.includes(node.id) === true;
  // 배지는 끌기를 시작한 행에만, 2개 이상일 때만 띄운다.
  const dragBadge = drag && drag.fromId === node.id && drag.ids.length > 1 ? drag.ids.length : null;

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    const ids = getDragIds(node.id);
    // 값 형식은 JSON 배열이다. 옛 형식(단일 문자열)은 받는 쪽에서 함께 처리한다.
    event.dataTransfer.setData(NODE_MIME, JSON.stringify(ids));
    event.dataTransfer.setData('text/plain', ids.length > 1 ? `${ids.length}개 항목` : node.name);
    event.dataTransfer.effectAllowed = 'move';
    setDrag({ ids, fromId: node.id });
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    const hasNode = event.dataTransfer.types.includes(NODE_MIME);
    const hasFiles = event.dataTransfer.types.includes('Files');
    // 노드 이동은 폴더에만, OS 파일 업로드는 폴더/파일 아무 행에나 받는다.
    if (hasFiles) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setDragOverId(node.id);
      return;
    }
    if (!hasNode || !isFolder) return;
    // 끌고 있는 것들 위에는 떨굴 수 없다(자기 자신 안으로 이동).
    if (isDragging) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDragOverId(node.id);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files ?? []);
    const draggedIds = parseDragIds(event.dataTransfer.getData(NODE_MIME));
    // 우리가 아는 것이 아무것도 없는 드롭은 그냥 흘려보낸다.
    if (files.length === 0 && draggedIds.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    setDragOverId(null);
    setDrag(null);

    // 파일 업로드는 어느 행이든 받는다(파일 위에 놓으면 그 파일이 든 폴더로).
    if (files.length > 0) {
      onDropFiles(files, node.id);
      return;
    }
    /*
     * 노드 이동은 **폴더 행 위에서만** 뜻이 있다. 파일 행이나 끌고 있는 자기
     * 자신 위에 놓은 것은 "아무 데도 안 놓은 것" 으로 본다 — 여기서 막지 않고
     * 컨테이너까지 올려보내면 그쪽이 "빈 곳에 놓았다" 로 받아 최상위로 옮겨
     * 버린다(5px 만 헛끌어도 파일이 최상위로 튀어나갔다).
     */
    if (isFolder && !isDragging) onDropNode(draggedIds, node.id);
  };

  return (
    <li role="none">
      <div
        role="treeitem"
        aria-expanded={isFolder ? isOpen : undefined}
        aria-selected={isOpened || isPicked}
        aria-level={item.depth + 1}
        // 고무줄 선택이 이 속성으로 행 위치를 읽고, "행 위에서 시작한 mousedown" 을 가려낸다.
        data-node-id={node.id}
        tabIndex={0}
        draggable
        title={dragBadge ? `${node.name} 외 ${dragBadge - 1}개` : node.name}
        onDragStart={handleDragStart}
        onDragEnd={() => {
          setDrag(null);
          setDragOverId(null);
        }}
        onDragOver={handleDragOver}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (dragOverId === node.id) setDragOverId(null);
        }}
        onDrop={handleDrop}
        onContextMenu={(event) => onContextMenu(event, item)}
        onFocus={() => onFocusNode(node.id)}
        onClick={(event) => onRowClick(event, item)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onFocusNode(node.id);
            if (isFolder) onToggle(node.id);
            else onSelectFile(node.id);
          }
          if (isFolder && event.key === 'ArrowRight' && !isOpen) onToggle(node.id);
          if (isFolder && event.key === 'ArrowLeft' && isOpen) onToggle(node.id);
        }}
        style={{ paddingLeft: 6 + item.depth * 14 }}
        className={clsx(
          'flex cursor-pointer items-center gap-1 rounded py-[3px] pr-2 text-[13px] outline-none select-none',
          isPicked
            ? 'bg-blue-100 text-blue-900'
            : isOpened
              ? 'bg-blue-50 text-blue-900'
              : 'text-slate-700 hover:bg-slate-100',
          isDropTarget && 'ring-2 ring-blue-400 ring-inset',
          isDragging && 'opacity-50',
          'focus-visible:ring-2 focus-visible:ring-blue-300',
        )}
      >
        {isFolder ? (
          <span
            aria-hidden
            className={clsx(
              'inline-block w-3 shrink-0 text-center text-[10px] text-slate-400 transition-transform',
              isOpen && 'rotate-90',
            )}
          >
            ▶
          </span>
        ) : (
          <span aria-hidden className="inline-block w-3 shrink-0" />
        )}
        <span aria-hidden className="shrink-0 text-[13px]">
          {isFolder ? (isOpen ? '📂' : '📁') : '📄'}
        </span>
        <span className="truncate">
          {splitHighlight(node.name, query).map((part, index) =>
            part.hit ? (
              // 조각은 순수 문자열이다. HTML 을 만들지 않으므로 주입 위험이 없다.
              <mark
                key={`${index}-${part.text}`}
                className="rounded-[2px] bg-amber-200 px-0 text-inherit"
              >
                {part.text}
              </mark>
            ) : (
              <span key={`${index}-${part.text}`}>{part.text}</span>
            ),
          )}
        </span>
        {dragBadge ? (
          <span className="ml-1 shrink-0 rounded-full bg-blue-600 px-1.5 py-[1px] text-[10px] font-semibold text-white">
            {dragBadge}개 이동
          </span>
        ) : null}
        {node.type === 'file' && node.file ? (
          <span className="ml-auto shrink-0 pl-1 text-[11px] text-slate-400">
            {node.file.problem_count}문항
          </span>
        ) : null}
      </div>

      {isFolder && isOpen ? (
        item.children.length > 0 ? (
          <ul role="group">
            {item.children.map((child) => (
              <TreeRow key={child.node.id} {...props} item={child} />
            ))}
          </ul>
        ) : (
          <p
            className="py-[3px] text-[12px] text-slate-400"
            style={{ paddingLeft: 6 + (item.depth + 1) * 14 + 16 }}
          >
            비어 있음
          </p>
        )
      ) : null}
    </li>
  );
}

export { NODE_MIME };
