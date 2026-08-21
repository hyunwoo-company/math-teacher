/**
 * 좌측 트리 "우클릭 → 이동…" 배선 확인 (목 모드).
 *
 * 규칙 자체(자손 금지·섹션 고정·제자리 금지)는 순수 함수 테스트(`move-targets.test.ts`)가
 * 지킨다. 여기서는 그 둘을 잇는 배선만 본다: 메뉴에서 창이 열리는지, 고른 폴더가
 * 스토어의 `moveNodes` 로 그대로 넘어가는지.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/components/Workspace';
import { resetMockState } from '@/lib/mock/client';
import { useWorkspace } from '@/store/workspace';

vi.mock('@/components/center/PdfViewer', () => ({
  PdfViewer: ({ fileUrl }: { fileUrl: string }) => (
    <div data-testid="pdf-viewer-stub">PDF 뷰어 대역: {fileUrl}</div>
  ),
}));

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

/**
 * 폴더 기본값은 "접힘" 이라 하위 노드를 우클릭하려면 루트를 먼저 펴야 한다.
 * 행을 클릭해 펴면 선택 상태까지 바뀌어 이동 대상이 흐려지므로 스토어를 직접 세운다.
 */
function expandRootFolders() {
  const { nodes, setExpanded } = useWorkspace.getState();
  for (const node of nodes) {
    if (node.type === 'folder' && node.parent_id === null) setExpanded(node.id, true);
  }
}

async function openWorkspace() {
  const user = userEvent.setup();
  render(<Workspace />);
  await screen.findByText('2026-1학기', {}, { timeout: 5000 });
  await act(async () => {
    expandRootFolders();
  });
  return user;
}

describe('좌측 트리 우클릭 이동', () => {
  it('우클릭 메뉴의 [이동…] 이 대상 선택 창을 연다', async () => {
    const user = await openWorkspace();

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /공통수학1/ }));
    await user.click(await screen.findByRole('menuitem', { name: '이동…' }));

    const dialog = await screen.findByRole('dialog', { name: '이동' });
    expect(within(dialog).getByText(/어디로 옮길까요\?/)).toBeInTheDocument();
    // 최상위는 언제나 고를 수 있고, 자기 자신과 지금 있는 자리는 고를 수 없다.
    expect(within(dialog).getByRole('radio', { name: '(최상위)' })).toBeEnabled();
    expect(within(dialog).getByRole('radio', { name: /공통수학1/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /2026-1학기.*현재 위치/ })).toBeDisabled();
    // 아무것도 고르기 전에는 [이동] 을 누를 수 없다.
    expect(within(dialog).getByRole('button', { name: '이동' })).toBeDisabled();
  });

  it('여러 개를 고른 뒤 폴더를 고르고 [이동] 하면 그 폴더로 함께 옮긴다', async () => {
    const moveNodes = vi.fn(async () => {});
    useWorkspace.setState({ moveNodes });
    const user = await openWorkspace();

    // Ctrl 클릭으로 2개 선택(삭제·드래그와 같은 규칙).
    await user.click(screen.getByRole('treeitem', { name: /공통수학1/ }));
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('treeitem', { name: /미적분/ }));
    await user.keyboard('{/Control}');
    expect(await screen.findByText(/2개 선택됨/)).toBeInTheDocument();

    // 선택 안의 행을 우클릭하면 선택 전체가 대상이다.
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /미적분/ }));
    await user.click(await screen.findByRole('menuitem', { name: '이동… (2개)' }));

    const dialog = await screen.findByRole('dialog', { name: '이동' });
    expect(within(dialog).getByText(/2개 항목을 어디로 옮길까요\?/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('radio', { name: '모의고사' }));
    await user.click(within(dialog).getByRole('button', { name: '이동' }));

    expect(moveNodes).toHaveBeenCalledTimes(1);
    expect(moveNodes).toHaveBeenCalledWith(
      ['folder-common1', 'folder-calculus'],
      'folder-mock-exam',
    );
    // 옮기고 나면 창은 닫힌다.
    expect(screen.queryByRole('dialog', { name: '이동' })).toBeNull();
  });
});
