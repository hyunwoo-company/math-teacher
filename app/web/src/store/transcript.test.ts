/**
 * 문항 텍스트화(판독본): 스토어 + 목 API 통합 테스트.
 *
 * 목 클라이언트가 실제 SSE 바이트를 만들어 실제 파서를 통과시키므로,
 * "1차 디코딩 → 실패분만 AI → transcripts 상태 반영" 경로 전체를 검증한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_PROBLEM_COUNT } from '@/lib/mock/data';
import { countRunningTranscripts, transcriptCacheKey } from '@/lib/transcript';
import { useWorkspace, __internal } from '@/store/workspace';

const initial = useWorkspace.getState();

function reset() {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
}

function entryOf(no: number) {
  return useWorkspace.getState().transcripts[transcriptCacheKey(MOCK_FILE_ID, no)];
}

async function until(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('작업이 시간 안에 끝나지 않았습니다.');
}

/** 그 시험지의 판독 작업이 전부 끝날 때까지. */
function idle(): boolean {
  return !useWorkspace
    .getState()
    .jobs.some(
      (job) =>
        job.kind === 'transcribe' && (job.status === 'running' || job.status === 'queued'),
    );
}

/**
 * 시험지를 실제로 열어 둔다.
 *
 * `startTranscribe(null)`(전체) 은 열린 시험지의 문항 목록으로 대상을 정하므로,
 * `selectedFileId` 만 심으면 자리를 하나도 만들지 못한다 — 화면에서는 언제나
 * 파일이 열려 있는 상태이니 테스트도 같은 상태에서 확인한다.
 */
async function openFile(): Promise<void> {
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
  await until(() => (useWorkspace.getState().fileDetail?.problems.length ?? 0) > 0);
}

beforeEach(async () => {
  reset();
  await openFile();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('판독 실행', () => {
  it('전체 실행은 problem_numbers=null 로 건다', async () => {
    const spy = vi.spyOn(api, 'createJob');
    await useWorkspace.getState().startTranscribe(null);

    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      kind: 'transcribe',
      node_id: MOCK_FILE_ID,
      problem_numbers: null,
      force: false,
    });
  });

  it('요청 전에 진행 자리를 먼저 만든다(진행 표시의 단일 소스)', async () => {
    await useWorkspace.getState().startTranscribe([1, 2]);
    expect(countRunningTranscripts(useWorkspace.getState().transcripts, MOCK_FILE_ID)).toBe(2);
  }, 30_000);

  it('디코딩으로 끝난 문항은 출처가 pua 이고 델타가 없다', async () => {
    await useWorkspace.getState().startTranscribe([1]);
    await until(() => entryOf(1)?.status === 'done');

    const entry = entryOf(1);
    expect(entry?.source).toBe('pua');
    expect(entry?.text).toContain('\\(');
    expect(entry?.streamingText).toBe('');
    // 1차는 AI 호출이 0회다 — 사용량이 붙지 않는다.
    expect(entry?.usage).toBeNull();
    expect(useWorkspace.getState().totals.subscriptionCalls).toBe(0);
  }, 30_000);

  it('디코딩이 실패한 문항만 AI 로 가고 출처가 ai 가 된다', async () => {
    // 목은 5의 배수를 디코딩 실패로 둔다(실측 비율과 같게).
    await useWorkspace.getState().startTranscribe([5]);
    await until(() => entryOf(5)?.status === 'done');

    expect(entryOf(5)?.source).toBe('ai');
    expect(entryOf(5)?.text).not.toBe('');
  }, 30_000);

  it('판독 불가 문항은 전문 없이 이유만 남는다', async () => {
    await useWorkspace.getState().startTranscribe([10]);
    await until(() => entryOf(10)?.status === 'done');

    expect(entryOf(10)?.text).toBe('');
    expect(entryOf(10)?.source).toBeNull();
    expect(entryOf(10)?.note).toBeTruthy();
  }, 30_000);

  it('전체 실행이 끝나면 판독본과 이유가 문항별로 쌓인다', async () => {
    const decodedCount = () =>
      Object.values(useWorkspace.getState().transcripts).filter((entry) => entry.source === 'pua')
        .length;

    await useWorkspace.getState().startTranscribe(null);
    await until(idle, 60_000);
    // 작업이 끝난 뒤 서버 저장본으로 한 번 맞춘다(`watchJob` 의 finally). 구독을
    // 붙이기 전에 지나간 앞부분 이벤트도 그 조회로 메워진다.
    await until(() => decodedCount() === 18, 60_000);
    expect(countRunningTranscripts(useWorkspace.getState().transcripts, MOCK_FILE_ID)).toBe(0);
  }, 90_000);

  it('이미 다 판독했으면 거절 사유와 힌트를 그대로 알린다', async () => {
    await useWorkspace.getState().startTranscribe([1]);
    await until(() => entryOf(1)?.status === 'done');
    await until(idle);

    await useWorkspace.getState().startTranscribe([1]);
    const toast = useWorkspace.getState().toast;
    expect(toast?.kind).not.toBe('success');
    expect(toast?.message).toContain('이미 모두');
    // 빠져나올 방법(다시 판독)을 알려주는 힌트를 버리지 않는다.
    expect(toast?.hint).toBeTruthy();
    // 거절당한 문항의 판독본을 잃지 않는다.
    expect(entryOf(1)?.text).not.toBe('');
    expect(entryOf(1)?.status).toBe('done');
  }, 45_000);

  it('force 면 이미 판독한 문항도 다시 판독한다', async () => {
    await useWorkspace.getState().startTranscribe([1]);
    await until(() => entryOf(1)?.status === 'done');
    await until(idle);

    const spy = vi.spyOn(api, 'createJob');
    await useWorkspace.getState().startTranscribe([1], { force: true });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ force: true });
    await until(() => entryOf(1)?.status === 'done');
  }, 45_000);

  it('중단하면 시작 못 한 문항이 "판독 중" 으로 남지 않는다', async () => {
    await useWorkspace.getState().startTranscribe(null);
    const jobId = useWorkspace.getState().jobs.find((job) => job.kind === 'transcribe')?.id;
    expect(jobId).toBeTruthy();
    // 전체 문항 자리를 미리 잡아 둔다(진행 표시의 단일 소스).
    expect(countRunningTranscripts(useWorkspace.getState().transcripts, MOCK_FILE_ID)).toBe(
      MOCK_PROBLEM_COUNT,
    );
    expect(useWorkspace.getState().fileDetail?.problems).toHaveLength(MOCK_PROBLEM_COUNT);

    await useWorkspace.getState().cancelJob(jobId as string);
    await until(idle, 60_000);
    // 구독이 끝나면 남은 자리를 정리한다(영원한 스피너 금지).
    await until(
      () => countRunningTranscripts(useWorkspace.getState().transcripts, MOCK_FILE_ID) === 0,
      60_000,
    );
  }, 90_000);

  it('시험지를 열면 저장된 판독본을 채운다', async () => {
    await api.saveTranscript(MOCK_FILE_ID, 4, '저장돼 있던 전문');
    // 다른 창에서 저장된 판독본을 이 창이 열 때 받아 오는지. 같은 파일을 다시
    // 고르려면 선택 상태를 우회해야 한다(`selectFile` 이 같은 id 면 no-op).
    useWorkspace.setState({ selectedFileId: null, openKind: 'none', transcripts: {} });
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    await until(() => entryOf(4)?.text === '저장돼 있던 전문');

    expect(entryOf(4)?.source).toBe('manual');
    expect(entryOf(4)?.status).toBe('done');
  }, 30_000);
});

describe('판독본 편집', () => {
  it('저장하면 출처가 직접 수정으로 바뀐다', async () => {
    await useWorkspace.getState().startTranscribe([1]);
    await until(() => entryOf(1)?.status === 'done');
    expect(entryOf(1)?.source).toBe('pua');

    const ok = await useWorkspace.getState().saveTranscript(MOCK_FILE_ID, 1, '내가 고친 전문');
    expect(ok).toBe(true);
    expect(entryOf(1)?.text).toBe('내가 고친 전문');
    expect(entryOf(1)?.source).toBe('manual');
    expect(entryOf(1)?.note).toBeNull();
  }, 45_000);

  it('빈 값으로 저장하면 판독본이 지워진다', async () => {
    await useWorkspace.getState().startTranscribe([1]);
    await until(() => entryOf(1)?.status === 'done');

    await useWorkspace.getState().saveTranscript(MOCK_FILE_ID, 1, '   ');
    expect(entryOf(1)?.text).toBe('');
    expect(entryOf(1)?.source).toBeNull();
    expect(entryOf(1)?.status).toBe('idle');
  }, 45_000);

  it('저장이 실패하면 토스트로 알리고 값을 바꾸지 않는다', async () => {
    await useWorkspace.getState().startTranscribe([1]);
    await until(() => entryOf(1)?.status === 'done');
    const before = entryOf(1)?.text;

    const ok = await useWorkspace.getState().saveTranscript(MOCK_FILE_ID, 1, 'x'.repeat(20_001));
    expect(ok).toBe(false);
    expect(useWorkspace.getState().toast?.kind).toBe('error');
    expect(entryOf(1)?.text).toBe(before);
  }, 45_000);
});
