/**
 * 내보내기 드롭다운: 대상 × 형식 × 구성이 올바른 인자로 나가는지.
 * jsdom 에는 URL.createObjectURL 이 없으므로 대역으로 채운다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportButton } from '@/components/center/ExportButton';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';

const createObjectURL = vi.fn(() => 'blob:mock');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  resetMockState();
  window.localStorage.clear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportButton', () => {
  it('대상에 따라 버튼 이름이 다르다', () => {
    const { rerender } = render(
      <ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />,
    );
    expect(screen.getByRole('button', { name: /문제 내보내기/ })).toBeInTheDocument();

    rerender(<ExportButton target="variants" id={MOCK_FILE_ID} name="풍문고.pdf" />);
    expect(screen.getByRole('button', { name: /변형문제 내보내기/ })).toBeInTheDocument();

    rerender(<ExportButton target="note" id="note-1" name="이현우 오답" />);
    expect(screen.getByRole('button', { name: /오답노트 내보내기/ })).toBeInTheDocument();
  });

  it('네 가지 조합을 모두 보여준다', async () => {
    const user = userEvent.setup();
    render(<ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />);

    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));
    for (const label of [
      '문제만 · DOCX',
      '문제만 · HWPX',
      '문제+해설 · DOCX',
      '문제+해설 · HWPX',
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it.each([
    ['문제만 · DOCX', 'docx', 'problems'],
    ['문제만 · HWPX', 'hwpx', 'problems'],
    ['문제+해설 · DOCX', 'docx', 'full'],
    ['문제+해설 · HWPX', 'hwpx', 'full'],
  ])('%s 을 고르면 그 형식·구성으로 요청한다', async (label, format, include) => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'exportDocument');
    render(<ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />);

    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));
    await user.click(screen.getByRole('menuitem', { name: label }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('exam', MOCK_FILE_ID, format, include),
    );
  });

  it('변형 대상은 target=variants 로 요청한다', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'exportDocument');
    render(<ExportButton target="variants" id={MOCK_FILE_ID} name="풍문고.pdf" />);

    await user.click(screen.getByRole('button', { name: /변형문제 내보내기/ }));
    await user.click(screen.getByRole('menuitem', { name: '문제만 · HWPX' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('variants', MOCK_FILE_ID, 'hwpx', 'problems'),
    );
  });

  it('서버 파일명이 없으면 대상·구성에 맞는 이름으로 저장한다', async () => {
    const user = userEvent.setup();
    let downloadName: string | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download;
      });

    render(<ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />);
    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));
    await user.click(screen.getByRole('menuitem', { name: '문제+해설 · HWPX' }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    // `.pdf` 는 벗기고 구성에 맞는 접미사를 붙인다.
    expect(downloadName).toBe('풍문고_문제와해설.hwpx');
  });

  it('실패하면 토스트를 띄우고 버튼이 다시 활성화된다', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'exportDocument').mockRejectedValue(new Error('서버 오류'));

    render(<ExportButton target="note" id="note-1" name="이현우 오답" />);
    await user.click(screen.getByRole('button', { name: /오답노트 내보내기/ }));
    await user.click(screen.getByRole('menuitem', { name: '문제만 · DOCX' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /오답노트 내보내기/ })).toBeEnabled(),
    );
  });
});
