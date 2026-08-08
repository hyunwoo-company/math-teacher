/**
 * 전역 대화 목록: "+ 새 대화" · 목록 표시/전환/이름변경/삭제 · 활성 강조.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationList } from '@/components/ai/ConversationList';
import { resetMockState } from '@/lib/mock/client';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

/** 목 API 로 대화 2개를 실제로 만든다(updated_at 순: 둘째, 첫째). */
async function seedTwoConversations() {
  await useWorkspace.getState().sendChat('첫 대화 질문');
  useWorkspace.getState().newConversation();
  await useWorkspace.getState().sendChat('둘째 대화 질문');
  await useWorkspace.getState().loadConversations();
}

describe('ConversationList', () => {
  it('"+ 새 대화" 버튼과 목록을 보여주고 활성 대화를 강조한다', async () => {
    await seedTwoConversations();
    const activeId = useWorkspace.getState().activeConversationId;
    render(<ConversationList />);

    expect(screen.getByRole('button', { name: '+ 새 대화' })).toBeInTheDocument();
    // 자동 제목(첫 사용자 메시지)로 두 대화가 목록에 뜬다.
    expect(screen.getByText('첫 대화 질문')).toBeInTheDocument();
    const secondSwitch = screen.getByText('둘째 대화 질문');
    // 활성(둘째) 전환 버튼은 aria-pressed=true.
    expect(secondSwitch).toHaveAttribute('aria-pressed', 'true');
    expect(activeId).not.toBeNull();
  }, 30_000);

  it('"+ 새 대화"를 누르면 활성 대화를 비운다', async () => {
    await seedTwoConversations();
    render(<ConversationList />);
    fireEvent.click(screen.getByRole('button', { name: '+ 새 대화' }));
    expect(useWorkspace.getState().activeConversationId).toBeNull();
    expect(useWorkspace.getState().messages).toHaveLength(0);
  }, 30_000);

  it('목록의 다른 대화를 클릭하면 그 대화로 전환한다', async () => {
    await seedTwoConversations();
    render(<ConversationList />);
    fireEvent.click(screen.getByText('첫 대화 질문'));
    await waitFor(() =>
      expect(useWorkspace.getState().messages.some((m) => m.content === '첫 대화 질문')).toBe(true),
    );
  }, 30_000);

  it('× 를 누르면 대화를 삭제한다', async () => {
    await seedTwoConversations();
    render(<ConversationList />);
    fireEvent.click(screen.getByRole('button', { name: '둘째 대화 질문 삭제' }));
    await waitFor(() =>
      expect(
        useWorkspace.getState().conversations.some((c) => c.title === '둘째 대화 질문'),
      ).toBe(false),
    );
  }, 30_000);

  it('선택된 대화가 없으면 안내 문구를 보여준다', () => {
    render(<ConversationList />);
    expect(screen.getByText(/새 대화를 시작하세요/)).toBeInTheDocument();
  });
});
