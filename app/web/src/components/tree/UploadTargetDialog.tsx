'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { moveTargets } from '@/lib/move-targets';
import { UPLOAD_NOTICE } from '@/lib/upload-notice';
import { DialogButton, Modal } from '@/components/ui/Dialog';
import type { Section, TreeNode } from '@/types/api';

interface UploadTargetDialogProps {
  /** 지금 섹션의 전체 노드(플랫). 대상 목록은 여기서 뽑는다. */
  nodes: readonly TreeNode[];
  section: Section;
  /** 올릴 파일들. 이름만 보여 준다. */
  files: readonly File[];
  /** 처음 골라 둘 폴더(버튼·우클릭이 추론해 둔 대상). `null` 이면 최상위. */
  defaultFolderId: string | null;
  onCancel: () => void;
  /** 고른 폴더로 올린다. `null` 이면 최상위. */
  onConfirm: (folderId: string | null) => void;
}

/** 라디오 value 는 문자열이어야 한다. 최상위(`null`)를 실제 id 와 겹치지 않게 표시한다. */
const ROOT_VALUE = ' root';

/**
 * 파일을 올리기 직전에 **어느 폴더로 넣을지 확인받는 창**.
 *
 * 하단 버튼과 우클릭 메뉴는 지금까지 추론한 대상으로 곧장 올렸다. 대상이 하단에
 * 글자로 떠 있긴 했지만 파일 선택 창에 가려 못 보고 엉뚱한 폴더로 들어가는 일이
 * 있었다(요청: "파일 업로드 시에 위치 어디에 업로드 할건지 물어봐주기").
 *
 * 추론 결과를 버리지는 않는다. 그 폴더를 **미리 골라 둔 채로** 열기 때문에, 맞으면
 * Enter 한 번이고 아니면 그 자리에서 바꾼다.
 *
 * 대상 목록은 이동 창과 같은 `moveTargets` 를 쓴다. `movingIds` 를 비워 넘기면
 * 자기 자신·자손·제자리 같은 이동 전용 제약이 모두 풀려서, 최상위와 모든 폴더가
 * 그대로 후보가 된다. 업로드는 어디로든 넣을 수 있으므로 이것이 맞다.
 *
 * 드래그&드롭은 이 창을 거치지 않는다. 놓은 자리가 곧 사용자의 지시라 되물으면
 * 방해만 된다.
 */
export function UploadTargetDialog({
  nodes,
  section,
  files,
  defaultFolderId,
  onCancel,
  onConfirm,
}: UploadTargetDialogProps) {
  const targets = useMemo(
    () => moveTargets({ nodes, movingIds: [], section }),
    [nodes, section],
  );

  // 추론한 대상이 목록에 없으면(그 사이 지워졌거나 폴더가 아니면) 최상위로 떨어뜨린다.
  const initial = targets.some((target) => target.id === defaultFolderId)
    ? defaultFolderId
    : null;
  const [picked, setPicked] = useState<string | null>(initial);
  const listRef = useRef<HTMLDivElement>(null);

  // 열리면 골라 둔 줄에 포커스를 준다(= 포커스가 창 안에서 시작하고, 바로 Enter 를 칠 수 있다).
  useEffect(() => {
    const checked = listRef.current?.querySelector<HTMLInputElement>('input:checked');
    (checked ?? listRef.current?.querySelector<HTMLInputElement>('input'))?.focus();
  }, []);

  const what =
    files.length === 1 && files[0] != null ? `"${files[0].name}" 을(를)` : `${files.length}개 파일을`;

  return (
    <Modal
      open
      title="업로드 위치"
      onClose={onCancel}
      width="w-[440px]"
      footer={
        <>
          <DialogButton onClick={onCancel}>취소</DialogButton>
          <DialogButton tone="primary" onClick={() => onConfirm(picked)}>
            업로드
          </DialogButton>
        </>
      }
    >
      <p className="mb-2 text-[13px] text-slate-700">{what} 어디에 올릴까요?</p>
      <div
        ref={listRef}
        role="radiogroup"
        aria-label="업로드할 위치"
        className="max-h-64 overflow-y-auto rounded border border-slate-200 bg-white py-1"
        onKeyDown={(event) => {
          // 목록에서 바로 Enter 로 확정한다. (라디오는 기본 동작이 없다)
          if (event.key !== 'Enter') return;
          event.preventDefault();
          onConfirm(picked);
        }}
      >
        {targets.map((target) => {
          const value = target.id ?? ROOT_VALUE;
          const checked = picked === target.id;
          return (
            <label
              key={value}
              style={{ paddingLeft: 8 + target.depth * 14 }}
              className={clsx(
                'flex cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-[13px] text-slate-700 hover:bg-slate-100',
                checked && 'bg-blue-50 text-blue-900',
              )}
            >
              <input
                type="radio"
                name="upload-target"
                value={value}
                checked={checked}
                onChange={() => setPicked(target.id)}
                className="h-3.5 w-3.5 shrink-0 accent-blue-600"
              />
              {target.id == null ? null : (
                <span aria-hidden className="shrink-0 text-[13px]">
                  📁
                </span>
              )}
              <span className="truncate">{target.name}</span>
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-amber-700">{UPLOAD_NOTICE}</p>
    </Modal>
  );
}
