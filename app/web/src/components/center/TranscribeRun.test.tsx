/**
 * [풀이] 탭의 문항 텍스트화 실행·진행·중단.
 *
 * 진행 표시는 변형에서 확립한 규칙을 그대로 따른다 — 진행 여부의 단일 소스는
 * 저장된 자리(`transcripts[key].status`)이고 새 집계 상태를 만들지 않는다.
 * 그래서 "아래 패널이 판독 중이면 위에도 반드시 보인다" 가 성립한다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SolutionsTab } from '@/components/center/SolutionsTab';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_PROBLEM_COUNT } from '@/lib/mock/data';
import { transcriptCacheKey } from '@/lib/transcript';
import { useWorkspace, __internal, type TranscriptEntry } from '@/store/workspace';
import type { Job } from '@/types/api';

const initial = useWorkspace.getState();

beforeEach(() => {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openFile() {
  const user = userEvent.setup();
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
  // selectFile 이 저장 풀이·변형·판독본을 뒤이어 비동기로 채운다. 그 뒤에 시작한다.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return user;
}

/** 판독본 자리를 심는다(진행·배지 판정의 단일 소스). */
function seed(byNo: Record<number, Partial<TranscriptEntry>>) {
  useWorkspace.setState((state) => {
    const transcripts = { ...state.transcripts };
    for (const [no, patch] of Object.entries(byNo)) {
      const number = Number(no);
      transcripts[transcriptCacheKey(MOCK_FILE_ID, number)] = {
        ...__internal.emptyTranscript(number),
        ...patch,
      };
    }
    return { transcripts };
  });
}

/** 진행 중인 판독 작업 1건을 스토어에 심는다(서버 큐에서 도는 상태 재현). */
function seedJob(overrides: Partial<Job> = {}) {
  const job: Job = {
    id: 'job-transcribe-1',
    kind: 'transcribe',
    node_id: MOCK_FILE_ID,
    node_name: '풍문고 시험지',
    status: 'running',
    total: 22,
    done_count: 4,
    current_no: 5,
    error: null,
    created_at: '2026-08-14T09:00:00+09:00',
    updated_at: '2026-08-14T09:00:00+09:00',
    ...overrides,
  };
  useWorkspace.setState({ jobs: [job] });
  return job;
}

describe('문항 텍스트화 실행', () => {
  it('[문항 텍스트화] 는 시험지 전체를 대상으로 건다', async () => {
    const user = await openFile();
    const spy = vi.spyOn(api, 'createJob');
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: /문항 텍스트화/ }));

    await waitFor(() =>
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        kind: 'transcribe',
        node_id: MOCK_FILE_ID,
        problem_numbers: null,
        force: false,
      }),
    );
  }, 30_000);

  it('담기·변형 모드와 충돌하지 않는다(체크박스를 새로 만들지 않는다)', async () => {
    const user = await openFile();
    render(<SolutionsTab />);

    // 텍스트화는 문항 선택 모드가 아니라 전체 실행이다 — 체크박스가 생기지 않는다.
    await user.click(screen.getByRole('button', { name: /문항 텍스트화/ }));
    expect(screen.queryByLabelText('1번 변형 선택')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('1번 오답노트 선택')).not.toBeInTheDocument();
  }, 30_000);

  it('진행 상황을 판독본 수로 보여준다', async () => {
    await openFile();
    seed({ 1: { text: '전문', status: 'done', source: 'pua' } });
    render(<SolutionsTab />);

    // 카운트는 저장된 판독본에서 센다(파일 상세의 has_transcript 를 따로 보지 않는다).
    const counter = screen.getByTitle(/텍스트로 내보낼 수 있는 문항 수/);
    expect(counter.textContent?.replace(/\s+/g, ' ')).toContain(`텍스트화 1 / ${MOCK_PROBLEM_COUNT}`);
  }, 30_000);

  it('전부 판독됐으면 버튼을 막고 이유를 알려준다', async () => {
    await openFile();
    const problems = useWorkspace.getState().fileDetail?.problems ?? [];
    seed(
      Object.fromEntries(
        problems.map((problem) => [problem.no, { text: '전문', status: 'done' as const }]),
      ),
    );
    render(<SolutionsTab />);

    const button = screen.getByRole('button', { name: /문항 텍스트화/ });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title') ?? '').toContain('이미');
  }, 30_000);
});

describe('판독 진행 표시와 중단', () => {
  it('판독 작업이 돌면 상단에 진행과 [판독 중단] 이 보인다', async () => {
    const user = await openFile();
    const spy = vi.spyOn(api, 'cancelJob');
    seedJob();
    seed({ 5: { status: 'running' }, 6: { status: 'running' } });
    render(<SolutionsTab />);

    expect(await screen.findByText('판독 중… 4/22 (현재 5번)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '판독 중단' }));
    expect(spy).toHaveBeenCalledWith('job-transcribe-1');
  }, 30_000);

  it('중단을 요청한 뒤에는 "중단하는 중…" 으로 바뀐다', async () => {
    await openFile();
    seedJob();
    seed({ 5: { status: 'running' } });
    useWorkspace.setState({ cancelingJobIds: ['job-transcribe-1'] });
    render(<SolutionsTab />);

    expect(await screen.findByRole('button', { name: '중단하는 중…' })).toBeDisabled();
  }, 30_000);

  it('문항별 개별 실행만 돌 때도(작업 목록이 아직 비어도) 진행이 보인다', async () => {
    await openFile();
    seed({ 3: { status: 'running' } });
    render(<SolutionsTab />);

    expect(await screen.findByText('판독 중… 0/1')).toBeInTheDocument();
    // 중단할 작업을 못 찾았으면 버튼을 내지 않는다(누를 대상이 없다).
    expect(screen.queryByRole('button', { name: '판독 중단' })).not.toBeInTheDocument();
  }, 30_000);

  it('진행 중인 판독이 없으면 상단에 아무 표시도 없다', async () => {
    await openFile();
    render(<SolutionsTab />);

    expect(screen.queryByText(/판독 중…/)).not.toBeInTheDocument();
  }, 30_000);
});

describe('문항 행과 대조 패널', () => {
  it('문항 행에 판독 상태가 배지로 보인다', async () => {
    await openFile();
    seed({
      1: { text: '전문', status: 'done', source: 'pua' },
      2: { text: '', status: 'done', note: '불가 - 도형' },
      3: { status: 'running' },
    });
    render(<SolutionsTab />);

    expect(screen.getByText('디코딩')).toBeInTheDocument();
    expect(screen.getByText('판독 불가')).toBeInTheDocument();
    expect(screen.getByText('판독 중')).toBeInTheDocument();
  }, 30_000);

  it('문항을 펼치면 대조 패널이 열린다', async () => {
    const user = await openFile();
    seed({ 1: { text: '복원된 전문입니다', status: 'done', source: 'ai' } });
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '1번 문제 풀이 펼치기' }));

    expect(screen.getByText('원본 ↔ 판독본 대조')).toBeInTheDocument();
    expect(screen.getByText('복원된 전문입니다')).toBeInTheDocument();
  }, 30_000);
});
