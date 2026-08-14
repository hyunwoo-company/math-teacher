/**
 * 드래그 삭제 배선 확인 (목 모드).
 *
 * 규칙 자체는 순수 함수(`deleteSummary`)와 스토어(`deleteNodes`) 테스트가 지킨다.
 * 여기서는 그 둘을 잇는 배선만 본다: 삭제 영역이 **드래그 중에만** 나타나는지,
 * 떨궜을 때 확인 창이 개수를 밝히는지, 확인해야 실제로 지워지는지.
 *
 * HTML5 DnD 는 jsdom 이 dataTransfer 를 만들어 주지 않으므로 대역을 넣어 준다.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** jsdom 에는 DataTransfer 가 없다. setData/getData/types 만 갖춘 최소 대역. */
function fakeDataTransfer() {
  const store = new Map<string, string>();
  return {
    types: [] as string[],
    files: [] as File[],
    effectAllowed: '',
    dropEffect: '',
    setData(type: string, value: string) {
      store.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type: string) {
      return store.get(type) ?? '';
    },
  };
}

async function openWorkspace() {
  const user = userEvent.setup();
  render(<Workspace />);
  await screen.findByText('2026-1학기', {}, { timeout: 5000 });
  return user;
}

describe('좌측 트리 드래그 삭제', () => {
  it('평소에는 삭제 영역이 없고, 끌기 시작해야 나타난다', async () => {
    await openWorkspace();
    expect(screen.queryByText(/여기에 놓으면 삭제/)).toBeNull();

    const row = screen.getByRole('treeitem', { name: /모의고사/ });
    fireEvent.dragStart(row, { dataTransfer: fakeDataTransfer() });

    expect(await screen.findByText(/여기에 놓으면 삭제/)).toBeInTheDocument();

    // 끌기가 끝나면 다시 사라진다.
    fireEvent.dragEnd(row, { dataTransfer: fakeDataTransfer() });
    await waitFor(() => expect(screen.queryByText(/여기에 놓으면 삭제/)).toBeNull());
  });

  it('여러 개를 끌어다 놓으면 몇 개가 지워지는지 밝히고, 확인해야 지운다', async () => {
    const user = await openWorkspace();

    // Ctrl 클릭으로 루트 폴더 2개를 고른다.
    await user.click(screen.getByRole('treeitem', { name: /2026-1학기/ }));
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('treeitem', { name: /모의고사/ }));
    await user.keyboard('{/Control}');
    expect(await screen.findByText(/2개 선택됨/)).toBeInTheDocument();

    const dataTransfer = fakeDataTransfer();
    const row = screen.getByRole('treeitem', { name: /모의고사/ });
    fireEvent.dragStart(row, { dataTransfer });

    const zone = await screen.findByText(/여기에 놓으면 삭제/);
    expect(zone).toHaveTextContent('(2개)');
    fireEvent.drop(zone, { dataTransfer });

    const dialog = await screen.findByRole('dialog', { name: '삭제 확인' });
    expect(within(dialog).getByText(/2개/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2026-1학기/)).toBeInTheDocument();
    expect(within(dialog).getByText(/모의고사/)).toBeInTheDocument();
    // 하위까지 합쳐 실제로 사라지는 총 개수를 밝힌다(폴더 2 + 하위 폴더 3 + 파일 1).
    expect(within(dialog).getByText(/모두 6개가 함께 삭제/)).toBeInTheDocument();
    expect(within(dialog).getByText('이 작업은 되돌릴 수 없습니다.')).toBeInTheDocument();

    // 취소하면 아무것도 지워지지 않는다.
    await user.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.getByRole('treeitem', { name: /2026-1학기/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /모의고사/ })).toBeInTheDocument();

    // 다시 끌어다 놓고 확인하면 둘 다 사라진다.
    fireEvent.dragStart(screen.getByRole('treeitem', { name: /모의고사/ }), { dataTransfer });
    fireEvent.drop(await screen.findByText(/여기에 놓으면 삭제/), { dataTransfer });
    const confirmDialog = await screen.findByRole('dialog', { name: '삭제 확인' });
    await user.click(within(confirmDialog).getByRole('button', { name: '삭제' }));

    await waitFor(
      () => {
        expect(screen.queryByRole('treeitem', { name: /2026-1학기/ })).toBeNull();
        expect(screen.queryByRole('treeitem', { name: /모의고사/ })).toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it('선택 밖의 한 개만 끌면 그 하나만 확인 창에 오른다', async () => {
    const user = await openWorkspace();
    await user.click(screen.getByRole('treeitem', { name: /2026-1학기/ }));

    const dataTransfer = fakeDataTransfer();
    const row = screen.getByRole('treeitem', { name: /모의고사/ });
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.drop(await screen.findByText(/여기에 놓으면 삭제/), { dataTransfer });

    const dialog = await screen.findByRole('dialog', { name: '삭제 확인' });
    // 항목 하나면 기존 문구를 그대로 쓴다.
    expect(within(dialog).getByText(/폴더를 삭제할까요\?/)).toBeInTheDocument();
    expect(within(dialog).getByText(/모의고사/)).toBeInTheDocument();
  });
});
