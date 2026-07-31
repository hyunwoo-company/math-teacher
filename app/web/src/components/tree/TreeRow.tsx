'use client';

import clsx from 'clsx';
import type { DragEvent, MouseEvent } from 'react';
import type { TreeItem } from '@/lib/tree';

export interface TreeRowCallbacks {
  onToggle: (id: string) => void;
  onSelectFile: (id: string) => void;
  /** 폴더/파일 아무 행이나 만졌을 때. 업로드 대상 계산에 쓴다. */
  onFocusNode: (id: string) => void;
  onContextMenu: (event: MouseEvent, item: TreeItem) => void;
  onDropNode: (draggedId: string, targetFolderId: string | null) => void;
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
  dragOverId: string | null;
  setDragOverId: (id: string | null) => void;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
}

const NODE_MIME = 'application/x-math-teacher-node';

/** 트리 한 행 + 하위 행들(재귀). 중첩 깊이 제한 없음. */
export function TreeRow(props: TreeRowProps) {
  const {
    item,
    expanded,
    selectedFileId,
    dragOverId,
    setDragOverId,
    draggingId,
    setDraggingId,
    onToggle,
    onSelectFile,
    onFocusNode,
    onContextMenu,
    onDropNode,
    onDropFiles,
  } = props;

  const { node } = item;
  const isFolder = node.type === 'folder';
  const isOpen = isFolder && expanded[node.id] === true;
  const isSelected = !isFolder && selectedFileId === node.id;
  // 파일 행도 드롭 대상이 된다(그 파일이 든 폴더로 업로드). 그래서 폴더 조건을 빼야 한다.
  const isDropTarget = dragOverId === node.id;

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(NODE_MIME, node.id);
    event.dataTransfer.setData('text/plain', node.name);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingId(node.id);
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
    if (draggingId === node.id) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDragOverId(node.id);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files ?? []);
    const draggedId = event.dataTransfer.getData(NODE_MIME);
    // 노드 이동은 폴더 위에서만 의미가 있다. 파일 업로드는 어느 행이든 받는다.
    if (files.length === 0 && !isFolder) return;

    event.preventDefault();
    event.stopPropagation();
    setDragOverId(null);
    setDraggingId(null);

    if (files.length > 0) {
      onDropFiles(files, node.id);
      return;
    }
    if (draggedId && isFolder) onDropNode(draggedId, node.id);
  };

  return (
    <li role="none">
      <div
        role="treeitem"
        aria-expanded={isFolder ? isOpen : undefined}
        aria-selected={isSelected}
        aria-level={item.depth + 1}
        tabIndex={0}
        draggable
        title={node.name}
        onDragStart={handleDragStart}
        onDragEnd={() => {
          setDraggingId(null);
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
        onClick={() => {
          onFocusNode(node.id);
          if (isFolder) onToggle(node.id);
          else onSelectFile(node.id);
        }}
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
          isSelected ? 'bg-blue-50 text-blue-900' : 'text-slate-700 hover:bg-slate-100',
          isDropTarget && 'ring-2 ring-blue-400 ring-inset',
          draggingId === node.id && 'opacity-50',
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
        <span className="truncate">{node.name}</span>
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
