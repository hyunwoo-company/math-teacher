/**
 * 프롬프트 영역 안내 UI 테스트.
 * "Claude Code(CLI)" 와 "Claude 데스크톱 앱" 혼동 방지가 핵심 검증 대상이다.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SubscriptionNotice } from '@/components/ai/SubscriptionNotice';
import { resetMockState } from '@/lib/mock/client';
import { useWorkspace } from '@/store/workspace';
import type { EnvResponse } from '@/types/api';

const models: EnvResponse['models'] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
];

function env(subscription: EnvResponse['subscription'], mode: EnvResponse['mode'] = 'desktop'): EnvResponse {
  return { mode, subscription, api_key_set: false, models, usd_krw: 1400 };
}

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

describe('SubscriptionNotice', () => {
  it('구독이 가능하면 아무것도 렌더하지 않는다', () => {
    const { container } = render(
      <SubscriptionNotice
        env={env({ available: true, cli_path: 'C:/claude.exe', reason: 'ok' })}
        modelId="claude-opus-5"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('미설치: Claude Code 설치 안내와 데스크톱 앱 구분을 보여준다', async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: null, reason: 'cli_missing' })}
        modelId="claude-opus-5"
      />,
    );

    const note = screen.getByRole('note', { name: 'AI 사용 준비 안내' });
    expect(within(note).getByText(/Claude Code 를 설치하면 추가 요금 없이/)).toBeInTheDocument();

    // 설명은 접혀 있으므로 펼쳐서 확인한다.
    await user.click(within(note).getByRole('button', { name: '자세히' }));
    expect(note.textContent).toContain('터미널에서 쓰는 CLI');
    expect(note.textContent).toContain('Claude 데스크톱 앱(채팅 GUI)과는 다른 프로그램');
    // 엉뚱한 안내를 하지 않는다.
    expect(note.textContent).not.toMatch(/데스크톱 앱을 설치/);
  });

  it('문서 링크는 code.claude.com/docs 하나만 쓴다', () => {
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: null, reason: 'cli_missing' })}
        modelId="claude-opus-5"
      />,
    );
    const link = screen.getByRole('link', { name: 'Claude Code 문서 열기' });
    expect(link).toHaveAttribute('href', 'https://code.claude.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('[다시 확인] 을 누르면 env 를 다시 읽는다(재시작 없이 감지)', async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: null, reason: 'cli_missing' })}
        modelId="claude-opus-5"
      />,
    );

    expect(useWorkspace.getState().envStatus).toBe('idle');
    await user.click(screen.getByRole('button', { name: '다시 확인' }));
    await waitFor(() => expect(useWorkspace.getState().envStatus).toBe('ready'), { timeout: 5000 });
    // 목 기본 시나리오는 구독 가능 -> 재확인으로 상태가 바뀌는 흐름이 성립한다.
    expect(useWorkspace.getState().env?.subscription.available).toBe(true);
  }, 15_000);

  it('웹 모드에서는 [다시 확인] 이 없다(구조적 제약이라 무의미)', () => {
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: null, reason: 'web_mode' }, 'web')}
        modelId="claude-opus-5"
      />,
    );
    expect(screen.queryByRole('button', { name: '다시 확인' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/웹 버전에서는 구독을 쓸 수 없습니다/)).toBeInTheDocument();
  });

  it('대안 경로(API 키)와 과금 사실·예상 금액을 함께 제시한다', () => {
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: null, reason: 'cli_missing' })}
        modelId="claude-opus-5"
      />,
    );
    expect(screen.getByText('지금 바로 쓰려면 API 키를 입력하세요')).toBeInTheDocument();
    const note = screen.getByRole('note', { name: 'AI 사용 준비 안내' });
    expect(note.textContent).toMatch(/사용량만큼 요금이 청구됩니다/);
    expect(note.textContent).toMatch(/문항당 약\s*₩51/);
    expect(note.textContent).toContain('실측 기반 추정');
  });

  it('API 키를 저장하면 스토어에 반영된다', async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: null, reason: 'cli_missing' })}
        modelId="claude-opus-5"
      />,
    );

    const save = screen.getByRole('button', { name: '저장' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Anthropic API 키'), 'sk-ant-xyz');
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(useWorkspace.getState().hasLocalApiKey).toBe(true), {
      timeout: 5000,
    });
  }, 15_000);

  it('로그인 필요 상태는 설치는 됐다고 말한다', () => {
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: 'C:/claude.exe', reason: 'not_logged_in' })}
        modelId="claude-opus-5"
      />,
    );
    expect(screen.getByText(/Claude Code 로그인이 필요합니다/)).toBeInTheDocument();
  });

  it('reason 이 없는 구버전 백엔드에서도 안내가 나온다', () => {
    render(
      <SubscriptionNotice
        env={env({ available: false, cli_path: 'C:/claude.exe' })}
        modelId="claude-opus-5"
      />,
    );
    // cli_path 가 있으니 로그인 문제로 추론한다.
    expect(screen.getByText(/로그인이 필요합니다/)).toBeInTheDocument();
  });
});
