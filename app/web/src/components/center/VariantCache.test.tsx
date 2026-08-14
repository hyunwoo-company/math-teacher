/**
 * 저장된 변형은 AI 를 다시 부르지 않고 그대로 보여준다.
 *
 * 회귀 배경: 서버에 (문항, 유형) 스킵 규칙이 생기면서, 캐시가 비어 있는 화면
 * (오답노트는 `selectNote` 가 변형을 안 받아 온다)에서 패널을 열면 스토어가
 * 생성을 걸고 서버가 400 `already_generated` 로 거절했다. 사용자는 에러만 보고
 * 이미 만들어 둔 변형은 볼 수 없었다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteView } from '@/components/center/NoteView';
import { VariantPanel } from '@/components/center/VariantPanel';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_NOTE_ID } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';

const initial = useWorkspace.getState();

beforeEach(() => {
  __internal.resetJobSubscriptions();
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

const KEY = __internal.variantKey(MOCK_FILE_ID, 1);

/** 변형 하나를 실제로 만들어 서버(목)에 저장시킨다. */
async function generateAndStore(no: number): Promise<void> {
  await useWorkspace.getState().generateVariant(MOCK_FILE_ID, no, 'number');
  await waitFor(
    () =>
      expect(
        useWorkspace.getState().variants[__internal.variantKey(MOCK_FILE_ID, no)]?.number
          ?.status,
      ).toBe('done'),
    { timeout: 20_000 },
  );
}

/** 새로고침 흉내: 스토어만 초기화하고 서버(목) 데이터는 남긴다. */
function reload(): void {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
}

describe('저장된 변형 캐시', () => {
  it('새로고침 뒤 패널을 열면 AI 호출 없이 저장된 변형이 보인다', async () => {
    const user = userEvent.setup();
    await generateAndStore(1);
    const saved = useWorkspace.getState().variants[KEY]?.number?.text ?? '';
    expect(saved).toContain('## 문제');

    reload();
    const createJob = vi.spyOn(api, 'createJob');
    render(<VariantPanel fileId={MOCK_FILE_ID} no={1} />);
    await user.click(screen.getByRole('button', { name: /변형 문제 만들기/ }));

    await waitFor(() =>
      expect(useWorkspace.getState().variants[KEY]?.number?.status).toBe('done'),
    );
    expect(createJob).not.toHaveBeenCalled();
    expect(useWorkspace.getState().variants[KEY]?.number?.text).toBe(saved);
  }, 40_000);

  it('오답노트에서도 저장된 변형이 그대로 뜬다(생성 호출 없음)', async () => {
    const user = userEvent.setup();
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree('note');
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [1]);
    await generateAndStore(1);

    // 새로고침 뒤 노트를 다시 여는 상황(스토어 캐시가 비어 있다).
    reload();
    await useWorkspace.getState().loadTree('note');
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);

    render(<NoteView />);
    expect(await screen.findByText('1번')).toBeInTheDocument();

    const createJob = vi.spyOn(api, 'createJob');
    await user.click(await screen.findByRole('button', { name: /변형 문제 만들기/ }));

    // 저장본이 그대로 렌더된다(재생성 없음, 에러 없음).
    await waitFor(() =>
      expect(useWorkspace.getState().variants[KEY]?.number?.status).toBe('done'),
    );
    expect(createJob).not.toHaveBeenCalled();
    expect(screen.queryByText(/이미 모두 만들어져 있습니다/)).not.toBeInTheDocument();
  }, 40_000);

  it('조회 뒤에 다른 창이 먼저 만들었으면(400) 저장본을 받아 보여준다', async () => {
    await generateAndStore(1);
    const saved = useWorkspace.getState().variants[KEY]?.number?.text ?? '';

    reload();
    // 조회 시점에는 없었는데 생성 요청 사이에 다른 창이 만든 상황을 만든다.
    vi.spyOn(api, 'getVariants').mockResolvedValueOnce({ variants: [] });

    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');

    // 에러로 끝나지 않고 저장본이 채워진다.
    await waitFor(() =>
      expect(useWorkspace.getState().variants[KEY]?.number?.status).toBe('done'),
    );
    expect(useWorkspace.getState().variants[KEY]?.number?.text).toBe(saved);
  }, 40_000);

  it('저장본이 없는 유형은 그대로 생성한다(조회가 생성을 막지 않는다)', async () => {
    const user = userEvent.setup();
    await generateAndStore(1);

    reload();
    const createJob = vi.spyOn(api, 'createJob');
    render(<VariantPanel fileId={MOCK_FILE_ID} no={1} />);
    await user.click(screen.getByRole('button', { name: /변형 문제 만들기/ }));
    // 저장본이 있는 '숫자' 탭은 조회로 끝난다.
    await waitFor(() =>
      expect(useWorkspace.getState().variants[KEY]?.number?.status).toBe('done'),
    );
    expect(createJob).not.toHaveBeenCalled();

    // 저장본이 없는 '조건' 탭으로 옮기면 그때는 생성한다.
    await user.click(screen.getByRole('tab', { name: '조건 변형' }));
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    await waitFor(
      () => expect(useWorkspace.getState().variants[KEY]?.condition?.status).toBe('done'),
      { timeout: 20_000 },
    );
  }, 40_000);
});
