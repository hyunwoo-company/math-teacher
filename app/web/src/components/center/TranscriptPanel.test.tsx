/**
 * 크롭 ↔ 판독 텍스트 대조 패널.
 *
 * 이 기능의 안전장치는 사용자가 **눈으로 대조하는 것**이다. 그래서 크롭 이미지와
 * 복원 텍스트가 한 화면에 같이 있어야 하고, 출처(신뢰도)가 구분돼 보여야 한다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptPanel } from '@/components/center/TranscriptPanel';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { transcriptCacheKey } from '@/lib/transcript';
import { useWorkspace, __internal, type TranscriptEntry } from '@/store/workspace';

const initial = useWorkspace.getState();

beforeEach(() => {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  useWorkspace.setState({ selectedFileId: MOCK_FILE_ID });
  resetMockState();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 그 문항의 판독본 자리를 심는다(진행·배지 판정의 단일 소스). */
function seed(no: number, patch: Partial<TranscriptEntry>): void {
  useWorkspace.setState((state) => ({
    transcripts: {
      ...state.transcripts,
      [transcriptCacheKey(MOCK_FILE_ID, no)]: {
        ...__internal.emptyTranscript(no),
        ...patch,
      },
    },
  }));
}

function entryOf(no: number) {
  return useWorkspace.getState().transcripts[transcriptCacheKey(MOCK_FILE_ID, no)];
}

function renderPanel(no = 3) {
  return render(<TranscriptPanel fileId={MOCK_FILE_ID} no={no} />);
}

describe('대조 화면', () => {
  it('크롭 이미지와 복원 텍스트를 함께 보여준다', () => {
    seed(3, { text: '이차함수 \\(f(x) = x^2\\) 의 값을 구하시오.', status: 'done', source: 'pua' });
    renderPanel();

    // 왼쪽(좁은 화면에서는 위)은 원본 크롭, 오른쪽은 복원 텍스트다.
    expect(screen.getByAltText('3번 문제 이미지')).toBeInTheDocument();
    expect(screen.getByText(/이차함수/)).toBeInTheDocument();
  });

  it('수식은 KaTeX 로 렌더한다(원문을 그대로 흘리지 않는다)', () => {
    seed(3, { text: '\\(x^2 + 1\\)', status: 'done', source: 'pua' });
    const { container } = renderPanel();

    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it.each([
    ['pua', '디코딩'],
    ['ai', 'AI 판독'],
    ['manual', '직접 수정'],
  ] as const)('출처 %s 는 "%s" 배지로 구분한다', (source, label) => {
    seed(3, { text: '전문', status: 'done', source });
    renderPanel();

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('판독본이 없으면 이유를 배지로 알린다', () => {
    seed(3, { text: '', status: 'done', note: '불가 - 좌표평면 그래프 포함' });
    renderPanel();

    expect(screen.getByText('불가 - 좌표평면 그래프 포함')).toBeInTheDocument();
    // 이미지로 나간다는 사실을 알려준다(내보내기 결과를 예측할 수 있어야 한다).
    expect(screen.getByText(/이미지로 내보냅니다/)).toBeInTheDocument();
  });

  it('아직 판독하지 않았으면 이 문항만 실행할 수 있다', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'createJob');
    renderPanel();

    expect(screen.getByText('미판독')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이 문항 텍스트화' }));

    await waitFor(() =>
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        kind: 'transcribe',
        node_id: MOCK_FILE_ID,
        problem_numbers: [3],
        force: false,
      }),
    );
  });

  it('판독 중이면 경로를 밝히고 부분 텍스트를 이어 보여준다', () => {
    seed(3, { status: 'running', route: 'ai', streamingText: '흐르는 중' });
    renderPanel();

    // 1차 디코딩(무료)과 2차 AI(사용량 소모)는 비용이 다르므로 구분해 알린다.
    expect(screen.getByText('AI 판독 중…')).toBeInTheDocument();
    expect(screen.getByText('흐르는 중')).toBeInTheDocument();
  });

  it('다시 판독은 force 로 건다', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'createJob');
    seed(3, { text: '전문', status: 'done', source: 'pua' });
    renderPanel();

    await user.click(screen.getByRole('button', { name: '다시 판독' }));
    await waitFor(() =>
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ problem_numbers: [3], force: true }),
    );
  });
});

describe('판독본 편집', () => {
  it('편집하고 저장하면 배지가 "직접 수정" 으로 바뀐다', async () => {
    const user = userEvent.setup();
    seed(3, { text: '원래 전문', status: 'done', source: 'pua' });
    renderPanel();
    expect(screen.getByText('디코딩')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '편집' }));
    const textarea = screen.getByLabelText('판독본 편집');
    expect(textarea).toHaveValue('원래 전문');
    await user.clear(textarea);
    await user.type(textarea, '내가 고친 전문');
    await user.click(screen.getByRole('button', { name: '저장' }));

    expect(await screen.findByText('직접 수정')).toBeInTheDocument();
    expect(entryOf(3)?.text).toBe('내가 고친 전문');
    // 저장하면 편집 모드가 닫힌다.
    expect(screen.queryByLabelText('판독본 편집')).not.toBeInTheDocument();
  }, 20_000);

  it('취소하면 고친 내용을 버리고 저장하지 않는다', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'saveTranscript');
    seed(3, { text: '원래 전문', status: 'done', source: 'pua' });
    renderPanel();

    await user.click(screen.getByRole('button', { name: '편집' }));
    await user.type(screen.getByLabelText('판독본 편집'), '덧붙임');
    await user.click(screen.getByRole('button', { name: '취소' }));

    expect(spy).not.toHaveBeenCalled();
    expect(entryOf(3)?.text).toBe('원래 전문');
    expect(screen.getByText('디코딩')).toBeInTheDocument();
  }, 20_000);

  it('비우고 저장하면 지워진다는 것을 미리 알린다', async () => {
    const user = userEvent.setup();
    seed(3, { text: '원래 전문', status: 'done', source: 'pua' });
    renderPanel();

    await user.click(screen.getByRole('button', { name: '편집' }));
    await user.clear(screen.getByLabelText('판독본 편집'));

    // 문구와 버튼 이름 둘 다로 알린다 — "저장" 을 눌러 지워지는 사고를 막는다.
    expect(screen.getByText(/판독본이 지워집니다/)).toBeInTheDocument();
    const clearButton = screen.getByRole('button', { name: '지우고 저장' });

    await user.click(clearButton);
    await waitFor(() => expect(entryOf(3)?.text).toBe(''));
    expect(await screen.findByText('미판독')).toBeInTheDocument();
  }, 20_000);

  it('저장이 실패하면 토스트로 알리고 편집 내용을 지키지 않고 버리지 않는다', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'saveTranscript').mockRejectedValue(new Error('판독본이 너무 깁니다.'));
    seed(3, { text: '원래 전문', status: 'done', source: 'pua' });
    renderPanel();

    await user.click(screen.getByRole('button', { name: '편집' }));
    await user.type(screen.getByLabelText('판독본 편집'), '덧붙임');
    await user.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(useWorkspace.getState().toast?.kind).toBe('error'));
    // 편집 모드가 열린 채로 남아 고친 내용을 다시 시도할 수 있다.
    expect(screen.getByLabelText('판독본 편집')).toHaveValue('원래 전문덧붙임');
  }, 20_000);

  it('편집 중에는 그 문항을 다시 판독할 수 없다(덮어쓰기 사고 방지)', async () => {
    const user = userEvent.setup();
    seed(3, { text: '원래 전문', status: 'done', source: 'pua' });
    renderPanel();

    await user.click(screen.getByRole('button', { name: '편집' }));
    const rerun = screen.getByRole('button', { name: '다시 판독' });
    expect(rerun).toBeDisabled();
    expect(rerun.getAttribute('title') ?? '').toContain('편집');
  }, 20_000);

  it('판독 중인 문항은 편집할 수 없다', () => {
    seed(3, { text: '이전 전문', status: 'running', route: 'pua' });
    renderPanel();

    expect(screen.getByRole('button', { name: '편집' })).toBeDisabled();
  });
});
