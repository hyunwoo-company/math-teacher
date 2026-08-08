/**
 * "변형 문제 만들기" 탭 UI 통합 테스트(목 모드).
 *
 * 풀이 탭(SolutionsTab)과 오답노트(NoteView) 양쪽에서
 * 탭(mode) 전환 -> mode 별 1회 생성/캐시 -> 복사/다시 생성까지 실제 렌더로 확인한다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SolutionsTab } from '@/components/center/SolutionsTab';
import { NoteView } from '@/components/center/NoteView';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_NOTE_ID } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';
import type { NoteItem, TreeNode, VariantMode } from '@/types/api';

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
  // 클립보드 접근이 없는 jsdom 에서 CopyButton 이 조용히 실패하도록 스텁을 둔다.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function modeDone(no: number, mode: VariantMode): boolean {
  const key = __internal.variantKey(MOCK_FILE_ID, no);
  return useWorkspace.getState().variants[key]?.[mode]?.status === 'done';
}

describe('풀이 탭의 변형 문제 만들기', () => {
  async function openProblemOne() {
    const user = userEvent.setup();
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    render(<SolutionsTab />);
    await user.click(await screen.findByRole('button', { name: '1번 문제 풀이 펼치기' }));
    // 변형 패널은 접힘이 기본. 명시적으로 열어야 탭이 나오고 첫 탭이 생성된다.
    await user.click(await screen.findByRole('button', { name: '변형 문제 만들기' }));
    return user;
  }

  it('탭 바 3개가 보이고, 패널이 열리면 첫 탭(숫자)만 자동 생성된다', async () => {
    const spy = vi.spyOn(api, 'generateVariant');
    await openProblemOne();

    expect(screen.getByText('변형 문제 만들기')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '숫자 변형' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '조건 변형' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '숫자·조건 변형' })).toBeInTheDocument();

    // 첫 탭(숫자)만 자동 생성된다.
    await waitFor(() => expect(modeDone(1, 'number')).toBe(true), { timeout: 20_000 });
    const numberCalls = spy.mock.calls.filter((call) => call[2] === 'number');
    expect(numberCalls).toHaveLength(1);
    expect(spy.mock.calls.some((call) => call[2] === 'condition')).toBe(false);
    expect(spy.mock.calls.some((call) => call[2] === 'number_condition')).toBe(false);
  }, 30_000);

  it('처음 여는 탭만 생성하고, 이미 생성된 탭 전환은 재생성하지 않는다(캐시)', async () => {
    const spy = vi.spyOn(api, 'generateVariant');
    const user = await openProblemOne();

    await waitFor(() => expect(modeDone(1, 'number')).toBe(true), { timeout: 20_000 });

    // 조건 탭으로 전환하면 그때 처음 생성된다(lazy).
    await user.click(screen.getByRole('tab', { name: '조건 변형' }));
    await waitFor(() => expect(modeDone(1, 'condition')).toBe(true), { timeout: 20_000 });
    expect(spy.mock.calls.filter((call) => call[2] === 'condition')).toHaveLength(1);

    // 다시 숫자 탭으로 돌아가도 재생성하지 않고 캐시를 보여준다.
    await user.click(screen.getByRole('tab', { name: '숫자 변형' }));
    await user.click(screen.getByRole('tab', { name: '조건 변형' }));
    expect(spy.mock.calls.filter((call) => call[2] === 'number')).toHaveLength(1);
    expect(spy.mock.calls.filter((call) => call[2] === 'condition')).toHaveLength(1);
  }, 45_000);

  it('활성 탭 결과에 복사 2종과 "다시 생성"이 있고, 다시 생성은 재호출한다', async () => {
    const spy = vi.spyOn(api, 'generateVariant');
    const user = await openProblemOne();

    await waitFor(() => expect(modeDone(1, 'number')).toBe(true), { timeout: 20_000 });

    // 계약 마크다운의 '정답' 헤딩이 렌더되고, KaTeX 수식이 실제로 렌더됐다.
    expect(screen.getByText('정답')).toBeInTheDocument();
    expect(document.querySelector('.katex')).not.toBeNull();

    expect(screen.getByRole('button', { name: '복사' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '복사(한글·워드용)' })).toBeInTheDocument();

    const before = spy.mock.calls.filter((call) => call[2] === 'number').length;
    await user.click(screen.getByRole('button', { name: '다시 생성' }));
    await waitFor(
      () => expect(spy.mock.calls.filter((call) => call[2] === 'number')).toHaveLength(before + 1),
      { timeout: 20_000 },
    );
    await waitFor(() => expect(modeDone(1, 'number')).toBe(true), { timeout: 20_000 });
  }, 45_000);
});

describe('오답노트의 변형 문제 만들기', () => {
  it('탭 방식으로 mode 별 변형을 생성하고 복사할 수 있다', async () => {
    const user = userEvent.setup();
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree('note');
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [3]);

    render(<NoteView />);
    expect(await screen.findByText('3번')).toBeInTheDocument();

    // 변형 패널을 명시적으로 연다(접힘이 기본).
    await user.click(await screen.findByRole('button', { name: '변형 문제 만들기' }));
    // 패널이 열리면 첫 탭(숫자)이 자동 생성된다.
    await waitFor(() => expect(modeDone(3, 'number')).toBe(true), { timeout: 20_000 });

    // 조건 탭으로 전환하면 그 mode 가 생성된다.
    await user.click(screen.getByRole('tab', { name: '조건 변형' }));
    await waitFor(() => expect(modeDone(3, 'condition')).toBe(true), { timeout: 20_000 });

    expect(screen.getByText('정답')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '복사' })).toBeInTheDocument();
  }, 45_000);

  it('변형 문제 만들기/닫기 토글 — 닫아도 캐시가 남아 다시 열면 재생성 없이 즉시 표시한다', async () => {
    const user = userEvent.setup();
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree('note');
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [4]);

    render(<NoteView />);
    const openButton = await screen.findByRole('button', { name: '변형 문제 만들기' });
    expect(openButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(openButton);
    // 열리면 첫 탭(숫자)이 자동 생성되어 캐시된다.
    await waitFor(() => expect(modeDone(4, 'number')).toBe(true), { timeout: 20_000 });

    // 열림 상태: 라벨/aria 가 바뀐다.
    const closeButton = screen.getByRole('button', { name: '변형 닫기' });
    expect(closeButton).toHaveAttribute('aria-expanded', 'true');

    // 닫으면 탭이 사라진다.
    const spy = vi.spyOn(api, 'generateVariant');
    await user.click(closeButton);
    expect(screen.queryByRole('tab', { name: '숫자 변형' })).toBeNull();

    // 다시 열어도 캐시라 재생성 호출이 없다.
    await user.click(screen.getByRole('button', { name: '변형 문제 만들기' }));
    expect(await screen.findByRole('tab', { name: '숫자 변형' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spy.mock.calls.some((call) => call[2] === 'number')).toBe(false);
  }, 45_000);

  it('원본이 삭제된 항목에는 변형 컨트롤을 숨긴다', () => {
    const node: TreeNode = {
      id: MOCK_NOTE_ID,
      type: 'file',
      name: '중간고사 오답',
      parent_id: null,
      section: 'note',
      created_at: new Date().toISOString(),
      file: null,
    };
    const orphan: NoteItem = {
      id: 'item-orphan',
      source_node_id: null,
      source_name: '삭제된 시험지',
      problem_no: 5,
      crop_url: '',
      memo: null,
      created_at: new Date().toISOString(),
      source_available: false,
    };
    useWorkspace.setState({
      openKind: 'note',
      selectedNoteId: MOCK_NOTE_ID,
      noteStatus: 'ready',
      noteDetail: { node, items: [orphan] },
    });

    render(<NoteView />);
    expect(screen.getByText('5번')).toBeInTheDocument();
    expect(screen.getByText('원본 삭제됨')).toBeInTheDocument();
    expect(screen.queryByText('변형 문제 만들기')).toBeNull();
  });
});
