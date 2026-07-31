/**
 * agy provider 모델 선택 UI (계약 3-C). agy 백엔드가 아직 실서버에 없으므로 목으로 확인.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/components/Workspace';
import { resetMockState } from '@/lib/mock/client';
import { useWorkspace } from '@/store/workspace';

vi.mock('@/components/center/PdfViewer', () => ({
  PdfViewer: () => <div data-testid="pdf-viewer-stub" />,
}));

const initial = useWorkspace.getState();
const prevMode = process.env.NEXT_PUBLIC_MOCK_MODE;

beforeAll(() => {
  process.env.NEXT_PUBLIC_MOCK_MODE = 'agy';
});
afterAll(() => {
  process.env.NEXT_PUBLIC_MOCK_MODE = prevMode;
});
beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

async function open() {
  const user = userEvent.setup();
  render(<Workspace />);
  await screen.findByText('2026-1학기', {}, { timeout: 5000 });
  return user;
}

describe('agy provider 모델 선택 (목: agy 시나리오)', () => {
  it('기본 공급자가 agy 이고 Gemini 3 Flash 가 기본 모델이다', async () => {
    await open();
    const providerSelect = screen.getByLabelText('공급자 선택') as HTMLSelectElement;
    expect(providerSelect.value).toBe('agy');
    // agy 옵션 라벨
    expect(within(providerSelect).getByRole('option', { name: /Antigravity/ })).toBeInTheDocument();

    const modelSelect = screen.getByLabelText('모델 선택') as HTMLSelectElement;
    expect(modelSelect.value).toBe('gemini-3-flash');
    expect(within(modelSelect).getByRole('option', { name: /Gemini 3 Flash/ })).toBeInTheDocument();
    expect(within(modelSelect).getByRole('option', { name: /Gemini 3.1 Pro/ })).toBeInTheDocument();
    // Claude 모델은 agy 목록에 없다.
    expect(within(modelSelect).queryByRole('option', { name: /Claude Opus/ })).toBeNull();

    // agy 는 무과금(쿼터)으로 표기.
    expect(screen.getByText('무과금(쿼터)')).toBeInTheDocument();
  });

  it('구독으로 바꾸면 Claude 모델로 전환되고 과금 안내는 없다', async () => {
    const user = await open();
    await user.selectOptions(screen.getByLabelText('공급자 선택'), 'subscription');

    const modelSelect = screen.getByLabelText('모델 선택') as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value.startsWith('claude')).toBe(true));
    expect(within(modelSelect).getByRole('option', { name: /Claude Opus/ })).toBeInTheDocument();
    // 과금 안내(note)는 종량(apikey)에서만.
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('API 키로 바꾸면 과금 안내가 뜬다', async () => {
    const user = await open();
    await user.selectOptions(screen.getByLabelText('공급자 선택'), 'apikey');
    expect(await screen.findByRole('note')).toBeInTheDocument();
  });
});

describe('agy-only: Claude CLI 없음 (목: agy-only)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_MOCK_MODE = 'agy-only';
  });
  afterAll(() => {
    process.env.NEXT_PUBLIC_MOCK_MODE = 'agy';
  });

  it('구독 옵션은 비활성(사용 불가)으로 표시된다', async () => {
    await open();
    const providerSelect = screen.getByLabelText('공급자 선택') as HTMLSelectElement;
    expect(providerSelect.value).toBe('agy');
    const subOption = within(providerSelect).getByRole('option', {
      name: /구독.*사용 불가/,
    }) as HTMLOptionElement;
    expect(subOption.disabled).toBe(true);
  });
});
