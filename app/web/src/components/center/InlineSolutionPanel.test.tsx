/**
 * 오답노트 인라인 "풀이 보기" 통합 테스트(목 모드).
 *
 * - 저장 풀이가 이미 있으면: 열 때 solve 재호출 없이 즉시 표시(캐시 우선).
 * - 저장 풀이가 없으면: "풀이 만들기" 로만 1회 solve 하고 캐시.
 * - 문제 이미지(크롭 썸네일)가 노트 항목에 보인다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteView } from '@/components/center/NoteView';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_NOTE_ID } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function problemDone(fileId: string, no: number): boolean {
  return useWorkspace.getState().problemSolutions[`${fileId}::${no}`]?.status === 'done';
}

async function openNoteWith(problemNo: number) {
  await useWorkspace.getState().loadEnv();
  await useWorkspace.getState().loadTree('note');
  await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
  await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [problemNo]);
}

describe('오답노트 인라인 풀이', () => {
  it('저장된 풀이가 있으면 열 때 solve 재호출 없이 즉시 표시한다', async () => {
    const user = userEvent.setup();
    await openNoteWith(1);
    // 저장 풀이를 미리 심는다(재풀이 금지 대상).
    await api.saveSolutionContent(MOCK_FILE_ID, 1, '이것은 저장된 풀이 본문입니다.');

    render(<NoteView />);
    expect(await screen.findByText('1번')).toBeInTheDocument();

    const solveSpy = vi.spyOn(api, 'createJob');
    await user.click(await screen.findByRole('button', { name: '풀이 보기' }));

    // 저장 풀이가 그대로 렌더된다(재풀이 없음).
    expect(await screen.findByText('이것은 저장된 풀이 본문입니다.')).toBeInTheDocument();
    expect(solveSpy).not.toHaveBeenCalled();
    expect(problemDone(MOCK_FILE_ID, 1)).toBe(true);

    // 복사 2종이 있다(AI 대화용=원문, 한글·워드용=평문).
    expect(screen.getByRole('button', { name: '복사(AI 대화용)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '복사(한글·워드용)' })).toBeInTheDocument();
  }, 30_000);

  it('저장된 풀이가 없으면 "풀이 만들기" 로 1회만 solve 한다', async () => {
    const user = userEvent.setup();
    await openNoteWith(2);

    render(<NoteView />);
    expect(await screen.findByText('2번')).toBeInTheDocument();

    const solveSpy = vi.spyOn(api, 'createJob');
    await user.click(await screen.findByRole('button', { name: '풀이 보기' }));

    // 조회 후 저장분이 없으니 자동 풀이 없이 "풀이 만들기" 버튼만 보인다.
    const makeButton = await screen.findByRole('button', { name: '풀이 만들기' });
    expect(solveSpy).not.toHaveBeenCalled();

    await user.click(makeButton);
    await waitFor(() => expect(problemDone(MOCK_FILE_ID, 2)).toBe(true), { timeout: 20_000 });
    expect(solveSpy).toHaveBeenCalledTimes(1);

    // KaTeX 수식이 실제로 렌더됐다.
    expect(document.querySelector('.katex')).not.toBeNull();
  }, 30_000);

  it('풀이 보기/닫기 토글 — 닫아도 캐시가 남아 다시 열면 재호출 없이 즉시 표시한다', async () => {
    const user = userEvent.setup();
    await openNoteWith(1);
    await api.saveSolutionContent(MOCK_FILE_ID, 1, '이것은 저장된 풀이 본문입니다.');

    render(<NoteView />);
    const openButton = await screen.findByRole('button', { name: '풀이 보기' });
    expect(openButton).toHaveAttribute('aria-expanded', 'false');

    const solveSpy = vi.spyOn(api, 'createJob');
    await user.click(openButton);
    expect(await screen.findByText('이것은 저장된 풀이 본문입니다.')).toBeInTheDocument();

    // 열림 상태: 라벨/aria 가 바뀐다.
    const closeButton = screen.getByRole('button', { name: '풀이 닫기' });
    expect(closeButton).toHaveAttribute('aria-expanded', 'true');

    // 닫으면 본문이 사라진다.
    await user.click(closeButton);
    expect(screen.queryByText('이것은 저장된 풀이 본문입니다.')).toBeNull();

    // 다시 열면 재풀이 없이 캐시를 즉시 보여준다.
    await user.click(screen.getByRole('button', { name: '풀이 보기' }));
    expect(await screen.findByText('이것은 저장된 풀이 본문입니다.')).toBeInTheDocument();
    expect(solveSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('노트 항목에 문제 크롭 이미지가 카드 폭에 맞춰 크게 보인다', async () => {
    await openNoteWith(3);
    render(<NoteView />);
    const image = await screen.findByAltText(/3번$/);
    expect(image).toBeInTheDocument();
    expect(image.tagName).toBe('IMG');
    // 작은 고정 썸네일(w-24)이 아니라 카드 폭(w-full)에 맞춰 크게 표시한다.
    expect(image.className).toContain('w-full');
  }, 30_000);

  it('이미지를 클릭하면 라이트박스로 확대되고 닫기/Esc 로 닫힌다', async () => {
    const user = userEvent.setup();
    await openNoteWith(3);
    render(<NoteView />);

    // 클릭하면 전체화면 오버레이(dialog)로 확대된다.
    await user.click(await screen.findByAltText(/3번$/));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // 라이트박스가 열리면 확대 이미지까지 포함해 같은 문항 이미지가 2개다.
    expect(screen.getAllByAltText(/3번$/)).toHaveLength(2);

    // 닫기 버튼으로 닫는다.
    await user.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 다시 열고 Esc 로 닫는다.
    await user.click(await screen.findByAltText(/3번$/));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }, 30_000);
});
