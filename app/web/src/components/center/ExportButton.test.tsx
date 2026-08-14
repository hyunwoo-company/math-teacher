/**
 * 내보내기 드롭다운: 대상 × 형식 × 구성이 올바른 인자로 나가는지.
 * jsdom 에는 URL.createObjectURL 이 없으므로 대역으로 채운다.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

/**
 * 방금 시작한 내보내기가 끝까지 돌 때까지 기다린다.
 *
 * `run()` 은 목 클라이언트의 지연(160ms) 뒤에야 blob 을 만들고 `<a download>` 를
 * 클릭한 다음 objectURL 을 되돌린다. 요청 인자만 확인하고 테스트를 끝내면 그
 * 뒷부분이 **다음 테스트 도중에** 실행돼, 다음 테스트가 깔아 둔 스파이
 * (`HTMLAnchorElement.prototype.click`)를 앞 테스트의 값으로 먼저 때린다.
 * 파일명 테스트가 실행 순서에 따라 `풍문고_변형문제.hwpx` 를 보고 실패한 원인이
 * 이것이다. 그래서 각 테스트는 자기가 시작한 내보내기를 반드시 회수한다.
 *
 * `revokeObjectURL` 은 `finally` 에서 마지막으로 불리므로 완료 신호로 쓴다.
 */
async function settleExport(): Promise<void> {
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalled());
}

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
      expect(spy).toHaveBeenCalledWith('exam', MOCK_FILE_ID, format, include, undefined),
    );
    await settleExport();
  });

  it('변형 대상은 target=variants 로 요청한다', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'exportDocument');
    render(<ExportButton target="variants" id={MOCK_FILE_ID} name="풍문고.pdf" />);

    await user.click(screen.getByRole('button', { name: /변형문제 내보내기/ }));
    await user.click(screen.getByRole('menuitem', { name: '문제만 · HWPX' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('variants', MOCK_FILE_ID, 'hwpx', 'problems', undefined),
    );
    await settleExport();
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

    // 다운로드가 끝난 뒤에 읽는다. `clickSpy` 호출만 기다리면 앞 테스트에서 새어
    // 나온 내보내기의 클릭에도 통과해 버린다.
    await settleExport();
    expect(clickSpy).toHaveBeenCalled();
    // `.pdf` 는 벗기고 구성에 맞는 접미사를 붙인다.
    expect(downloadName).toBe('풍문고_문제와해설.hwpx');
  });

  it('출처를 입력하면 내보내기 요청에 실려 간다', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'exportDocument');
    render(<ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />);

    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));
    await user.type(screen.getByLabelText('출처'), 'HY EDU');
    // 입력하는 동안 드롭다운이 닫히면 안 된다.
    expect(screen.getByRole('menuitem', { name: '문제만 · DOCX' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '문제만 · DOCX' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('exam', MOCK_FILE_ID, 'docx', 'problems', 'HY EDU'),
    );
    await settleExport();
  });

  it('출처가 비어 있으면 인자를 보내지 않는다', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'exportDocument');
    render(<ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />);

    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));
    await user.type(screen.getByLabelText('출처'), '   ');
    await user.click(screen.getByRole('menuitem', { name: '문제만 · DOCX' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('exam', MOCK_FILE_ID, 'docx', 'problems', undefined),
    );
    await settleExport();
  });

  it('마지막 출처를 기억해 다음 내보내기에 채워 둔다', async () => {
    const user = userEvent.setup();
    render(<ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />);

    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));
    await user.type(screen.getByLabelText('출처'), 'HY EDU');
    await user.click(screen.getByRole('menuitem', { name: '문제만 · DOCX' }));
    await settleExport();
    expect(window.localStorage.getItem('export.source')).toBe('HY EDU');

    // 다시 열면(=새로 마운트해도) 저장된 값이 입력란에 들어 있다.
    cleanup();
    render(<ExportButton target="exam" id={MOCK_FILE_ID} name="풍문고.pdf" />);
    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));
    await waitFor(() => expect(screen.getByLabelText('출처')).toHaveValue('HY EDU'));
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
