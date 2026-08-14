/**
 * 문항 텍스트화(판독본) API 계약 — 목 클라이언트가 실서버와 같은 말을 하는지.
 *
 * 목이 실서버 규칙(이미 판독한 문항 건너뛰기 / 빈 문자열이면 삭제 / 상한)을 모르면
 * 화면 테스트가 거짓 신호를 준다. 변형 작업에서 실제로 그 일을 겪었다.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_PROBLEM_COUNT } from '@/lib/mock/data';

/** jsdom 의 Blob 에는 `text()` 가 없어 FileReader 로 읽는다. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('blob 읽기 실패'));
    reader.readAsText(blob);
  });
}

/** 작업이 끝날 때까지 기다린다(목 워커는 구독 없이도 대본을 소비한다). */
async function settleJobs(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { active } = await api.listJobs();
    if (active.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('목 작업이 끝나지 않았습니다.');
}

beforeEach(() => {
  resetMockState();
});

describe('transcribe 작업', () => {
  it('kind=transcribe 로 전체 문항을 걸 수 있다', async () => {
    const created = await api.createJob({
      kind: 'transcribe',
      node_id: MOCK_FILE_ID,
      problem_numbers: null,
    });
    expect(created.job.kind).toBe('transcribe');
    expect(created.job.total).toBe(MOCK_PROBLEM_COUNT);
  });

  it('디코딩이 1차라 AI 연결과 무관하게 대부분 문항이 저장된다', async () => {
    await api.createJob({ kind: 'transcribe', node_id: MOCK_FILE_ID, problem_numbers: null });
    await settleJobs();

    const { transcripts } = await api.getTranscripts(MOCK_FILE_ID);
    const decoded = transcripts.filter((item) => item.transcript_source === 'pua');
    // 실측(풍문고 22문항 중 18개 디코딩)과 같은 비율을 목도 재현한다.
    expect(decoded).toHaveLength(18);
    expect(transcripts.every((item) => item.transcript != null || item.transcript_note != null)).toBe(
      true,
    );
  });

  it('판독하지 못한 문항은 전문 없이 이유만 남는다', async () => {
    await api.createJob({ kind: 'transcribe', node_id: MOCK_FILE_ID, problem_numbers: null });
    await settleJobs();

    const { transcripts } = await api.getTranscripts(MOCK_FILE_ID);
    const unavailable = transcripts.filter((item) => item.transcript == null);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const item of unavailable) {
      expect(item.transcript_note).toBeTruthy();
      expect(item.transcript_source).toBeNull();
    }
  });

  it('이미 판독한 문항은 건너뛴다', async () => {
    await api.createJob({ kind: 'transcribe', node_id: MOCK_FILE_ID, problem_numbers: [1, 2] });
    await settleJobs();

    const second = await api.createJob({
      kind: 'transcribe',
      node_id: MOCK_FILE_ID,
      problem_numbers: [1, 2, 3],
    });
    // 1·2 는 이미 판독본이 있으므로 3 만 남는다.
    expect(second.job.total).toBe(1);
  });

  it('남는 대상이 없으면 400 already_transcribed 로 거절한다', async () => {
    await api.createJob({ kind: 'transcribe', node_id: MOCK_FILE_ID, problem_numbers: [1] });
    await settleJobs();

    await expect(
      api.createJob({ kind: 'transcribe', node_id: MOCK_FILE_ID, problem_numbers: [1] }),
    ).rejects.toMatchObject({ code: 'already_transcribed', status: 400 });
  });

  it('force 면 이미 판독한 문항도 다시 판독한다', async () => {
    await api.createJob({ kind: 'transcribe', node_id: MOCK_FILE_ID, problem_numbers: [1] });
    await settleJobs();

    const again = await api.createJob({
      kind: 'transcribe',
      node_id: MOCK_FILE_ID,
      problem_numbers: [1],
      force: true,
    });
    expect(again.job.total).toBe(1);
  });
});

describe('판독본 편집 저장', () => {
  it('저장하면 출처가 manual 이 된다', async () => {
    const saved = await api.saveTranscript(MOCK_FILE_ID, 3, '내가 고친 전문');
    expect(saved).toMatchObject({
      no: 3,
      transcript: '내가 고친 전문',
      transcript_source: 'manual',
      transcript_note: null,
    });

    const { transcripts } = await api.getTranscripts(MOCK_FILE_ID);
    expect(transcripts.find((item) => item.no === 3)?.transcript_source).toBe('manual');
  });

  it('빈 문자열이면 판독본을 지운다(출처·이유도 함께 비운다)', async () => {
    await api.saveTranscript(MOCK_FILE_ID, 3, '내가 고친 전문');
    const cleared = await api.saveTranscript(MOCK_FILE_ID, 3, '   ');
    expect(cleared).toMatchObject({
      no: 3,
      transcript: null,
      transcript_source: null,
      transcript_note: null,
    });

    // 지운 문항은 조회 목록에서도 빠지고, 다음 재실행이 다시 판독한다.
    const { transcripts } = await api.getTranscripts(MOCK_FILE_ID);
    expect(transcripts.some((item) => item.no === 3)).toBe(false);
    const created = await api.createJob({
      kind: 'transcribe',
      node_id: MOCK_FILE_ID,
      problem_numbers: [3],
    });
    expect(created.job.total).toBe(1);
  });

  it('상한(20,000자)을 넘기면 400 으로 거절한다', async () => {
    await expect(api.saveTranscript(MOCK_FILE_ID, 1, 'x'.repeat(20_001))).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('manual 판독본은 force 없는 재실행이 덮지 않는다', async () => {
    await api.saveTranscript(MOCK_FILE_ID, 1, '사람이 고친 전문');
    await expect(
      api.createJob({ kind: 'transcribe', node_id: MOCK_FILE_ID, problem_numbers: [1] }),
    ).rejects.toMatchObject({ code: 'already_transcribed' });

    const { transcripts } = await api.getTranscripts(MOCK_FILE_ID);
    expect(transcripts.find((item) => item.no === 1)?.transcript).toBe('사람이 고친 전문');
  });
});

describe('내보내기 body', () => {
  it('기본은 image 다', async () => {
    const { blob } = await api.exportDocument('exam', MOCK_FILE_ID, 'docx', 'problems');
    expect(await readBlob(blob)).toContain('body=image');
  });

  it('body=text 를 넘기면 그대로 실려 간다', async () => {
    const { blob } = await api.exportDocument(
      'exam',
      MOCK_FILE_ID,
      'hwpx',
      'problems',
      undefined,
      'text',
    );
    expect(await readBlob(blob)).toContain('body=text');
  });
});
