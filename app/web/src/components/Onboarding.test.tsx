/**
 * 모드 분기 확인. `GET /api/env` 결과만으로 UI 가 갈리는지 본다(하드코딩 금지).
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Onboarding } from '@/components/Onboarding';
import { resetMockState } from '@/lib/mock/client';
import { useWorkspace } from '@/store/workspace';
import type { EnvResponse } from '@/types/api';

const models: EnvResponse['models'] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
];

const webEnv: EnvResponse = {
  mode: 'web',
  subscription: { available: false, cli_path: null },
  api_key_set: false,
  models,
  usd_krw: 1400,
};

const desktopNoKeyEnv: EnvResponse = {
  mode: 'desktop',
  subscription: { available: false, cli_path: null },
  api_key_set: false,
  models,
  usd_krw: 1400,
};

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
});

describe('Onboarding', () => {
  it('웹 모드에서는 구독을 숨기고 구독 불가 사유를 설명한다', () => {
    render(<Onboarding env={webEnv} />);

    expect(screen.getByText('웹에서는 구독 모드를 쓸 수 없습니다')).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code 구독 사용/)).toBeNull();
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeInTheDocument();
    expect(screen.getByText(/키를 서버에 저장하지 않고/)).toBeInTheDocument();
    expect(screen.getByText('현재 모드: 웹')).toBeInTheDocument();
  });

  it('데스크톱인데 Claude Code 를 못 찾으면 설치 안내와 다시 확인을 준다', () => {
    render(<Onboarding env={desktopNoKeyEnv} />);

    expect(screen.getByText(/Claude Code 구독 사용/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 확인' })).toBeInTheDocument();
    expect(screen.getByText(/평문으로 저장됩니다/)).toBeInTheDocument();
    expect(screen.getByText('현재 모드: 데스크톱')).toBeInTheDocument();
  });

  it('키를 입력하면 저장 버튼이 활성화되고 저장 후 api_key_set 이 반영된다', async () => {
    const user = userEvent.setup();
    render(<Onboarding env={webEnv} />);

    const save = screen.getByRole('button', { name: '저장' });
    expect(save).toBeDisabled();

    await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-1234');
    expect(save).toBeEnabled();

    await user.click(save);
    // 목 백엔드가 api_key_set: true 로 바뀌고 env 를 다시 읽는다.
    // (토스트 자체는 Workspace 가 렌더하므로 여기서는 스토어 상태로 확인한다.)
    await waitFor(() => expect(useWorkspace.getState().env?.api_key_set).toBe(true), {
      timeout: 5000,
    });
    expect(useWorkspace.getState().toast?.message).toBe('API 키를 저장했습니다.');
    // 웹 모드는 서버가 키를 저장하지 않아 env.api_key_set 이 false 로 남을 수 있다.
    // 그때도 온보딩이 다시 뜨지 않도록 로컬 보관 여부를 따로 들고 있어야 한다.
    expect(useWorkspace.getState().hasLocalApiKey).toBe(true);
  }, 15_000);

  it('"일단 둘러보기" 로 온보딩을 건너뛸 수 있다', async () => {
    const user = userEvent.setup();
    render(<Onboarding env={webEnv} />);

    await user.click(screen.getByRole('button', { name: /일단 둘러보기/ }));
    expect(useWorkspace.getState().onboardingSkipped).toBe(true);
  });
});
