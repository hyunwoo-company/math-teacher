/**
 * 판독본(문항 텍스트화) 판정 순수 함수.
 *
 * 변형에서 확립한 규칙을 따른다 — 진행 여부의 단일 소스는 **저장된 값**이고,
 * "무엇이 진행 중인가 / 몇 개가 남았나" 판정은 여기 모아 단위 테스트로 덮는다.
 */

import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_SOURCE_LABEL,
  allTranscribed,
  countRunningTranscripts,
  hasAnyTranscript,
  hasTranscript,
  isTranscriptRunning,
  transcribedCount,
  transcriptCacheKey,
  transcriptProgressOf,
  transcriptSourceLabel,
  transcriptSourceOf,
  transcriptSourceTone,
  untranscribedNumbers,
  type TranscriptJobLike,
  type TranscriptLike,
  type TranscriptStatusMap,
} from '@/lib/transcript';

const FILE = 'file-1';

function entry(patch: Partial<TranscriptLike> = {}): TranscriptLike {
  return { text: '', status: 'idle', ...patch };
}

function map(byNo: Record<number, TranscriptLike>, fileId = FILE): TranscriptStatusMap {
  const result: Record<string, TranscriptLike> = {};
  for (const [no, value] of Object.entries(byNo)) {
    result[transcriptCacheKey(fileId, Number(no))] = value;
  }
  return result;
}

const PROBLEMS = [{ no: 1 }, { no: 2 }, { no: 3 }];

describe('transcriptCacheKey', () => {
  it('변형 캐시와 같은 형식이라 문항 단위로 겹치지 않는다', () => {
    expect(transcriptCacheKey('file-1', 7)).toBe('file-1::7');
  });
});

describe('출처 좁히기와 라벨', () => {
  it('계약에 있는 세 값만 받는다', () => {
    expect(transcriptSourceOf('pua')).toBe('pua');
    expect(transcriptSourceOf('ai')).toBe('ai');
    expect(transcriptSourceOf('manual')).toBe('manual');
  });

  it('모르는 값·null 은 null 로 떨어뜨린다(백엔드가 값을 늘려도 안 깨진다)', () => {
    expect(transcriptSourceOf('ocr')).toBeNull();
    expect(transcriptSourceOf(null)).toBeNull();
    expect(transcriptSourceOf(undefined)).toBeNull();
  });

  it('신뢰도가 다르므로 라벨이 구분된다', () => {
    expect(TRANSCRIPT_SOURCE_LABEL.pua).toBe('디코딩');
    expect(TRANSCRIPT_SOURCE_LABEL.ai).toBe('AI 판독');
    expect(TRANSCRIPT_SOURCE_LABEL.manual).toBe('직접 수정');
    expect(transcriptSourceLabel('pua')).toBe('디코딩');
    expect(transcriptSourceLabel('ocr')).toBeNull();
  });

  it('색도 출처마다 다르다 — 디코딩만 초록(가장 신뢰도 높다)', () => {
    expect(transcriptSourceTone('pua')).toBe('green');
    expect(transcriptSourceTone('ai')).not.toBe('green');
    expect(transcriptSourceTone('manual')).not.toBe('green');
    expect(transcriptSourceTone('ai')).not.toBe(transcriptSourceTone('manual'));
  });
});

describe('판독본이 있는지', () => {
  it('전문이 있어야 판독본이 있는 것이다', () => {
    const transcripts = map({ 1: entry({ text: '전문', status: 'done' }) });
    expect(hasTranscript(transcripts, FILE, 1)).toBe(true);
    expect(hasTranscript(transcripts, FILE, 2)).toBe(false);
  });

  it('이유만 남은 문항(판독 불가)은 판독본이 없는 것으로 센다', () => {
    // 서버 `plan_transcribe_job` 도 빈 판독본을 세지 않아 다시 판독 대상이다.
    const transcripts = map({ 1: entry({ text: '', status: 'done' }) });
    expect(hasTranscript(transcripts, FILE, 1)).toBe(false);
  });

  it('다른 시험지의 같은 번호를 오인하지 않는다', () => {
    const transcripts = map({ 1: entry({ text: '전문', status: 'done' }) }, 'file-other');
    expect(hasTranscript(transcripts, FILE, 1)).toBe(false);
  });
});

describe('몇 개가 남았나', () => {
  const transcripts = map({
    1: entry({ text: '전문', status: 'done' }),
    2: entry({ text: '', status: 'done' }),
  });

  it('판독한 문항 수를 센다', () => {
    expect(transcribedCount(transcripts, FILE, PROBLEMS)).toBe(1);
  });

  it('아직 판독본이 없는 문항 번호를 돌려준다(재실행 대상과 같은 규칙)', () => {
    expect(untranscribedNumbers(transcripts, FILE, PROBLEMS)).toEqual([2, 3]);
  });

  it('전부 판독했으면 남는 게 없다', () => {
    const all = map({
      1: entry({ text: 'a', status: 'done' }),
      2: entry({ text: 'b', status: 'done' }),
      3: entry({ text: 'c', status: 'done' }),
    });
    expect(untranscribedNumbers(all, FILE, PROBLEMS)).toEqual([]);
    expect(allTranscribed(all, FILE, PROBLEMS)).toBe(true);
    expect(allTranscribed(transcripts, FILE, PROBLEMS)).toBe(false);
  });

  it('문항이 없으면 "전부 판독" 이라고 하지 않는다(막을 근거가 없다)', () => {
    expect(allTranscribed({}, FILE, [])).toBe(false);
    expect(hasAnyTranscript({}, FILE, [])).toBe(false);
  });

  it('하나라도 판독본이 있으면 텍스트 내보내기를 켤 수 있다', () => {
    expect(hasAnyTranscript(transcripts, FILE, PROBLEMS)).toBe(true);
    expect(hasAnyTranscript(map({ 2: entry({ status: 'done' }) }), FILE, PROBLEMS)).toBe(false);
  });
});

describe('무엇이 진행 중인가', () => {
  it('저장된 자리의 status 가 판정의 단일 소스다', () => {
    const transcripts = map({ 3: entry({ status: 'running' }) });
    expect(isTranscriptRunning(transcripts, FILE, 3)).toBe(true);
    expect(isTranscriptRunning(transcripts, FILE, 4)).toBe(false);
    expect(countRunningTranscripts(transcripts, FILE)).toBe(1);
  });

  it('다른 시험지의 진행은 세지 않는다', () => {
    const transcripts = {
      ...map({ 1: entry({ status: 'running' }) }),
      ...map({ 1: entry({ status: 'running' }), 2: entry({ status: 'running' }) }, 'file-other'),
    };
    expect(countRunningTranscripts(transcripts, FILE)).toBe(1);
    expect(countRunningTranscripts(transcripts, 'file-other')).toBe(2);
  });
});

function job(patch: Partial<TranscriptJobLike> = {}): TranscriptJobLike {
  return {
    id: 'job-1',
    kind: 'transcribe',
    node_id: FILE,
    status: 'running',
    total: 22,
    done_count: 4,
    current_no: 5,
    ...patch,
  };
}

describe('transcriptProgressOf', () => {
  it('진행 중이 아니면 null 이다', () => {
    expect(transcriptProgressOf({ transcripts: {}, fileId: FILE, jobs: [] })).toBeNull();
  });

  it('작업이 돌면 진행과 중단 대상을 알려준다', () => {
    expect(
      transcriptProgressOf({ transcripts: {}, fileId: FILE, jobs: [job()] }),
    ).toEqual({ doneCount: 4, total: 22, currentNo: 5, jobId: 'job-1' });
  });

  it('작업 목록이 아직 안 들어와도 판독 중 자리가 있으면 표시한다', () => {
    // 아래 패널이 "판독 중…" 이면 위에도 반드시 보인다(같은 자리를 본다).
    const progress = transcriptProgressOf({
      transcripts: map({ 1: entry({ status: 'running' }) }),
      fileId: FILE,
      jobs: [],
    });
    expect(progress).toEqual({ doneCount: 0, total: 1, currentNo: null, jobId: null });
  });

  it('작업이 알려 준 total 보다 진행 중 자리가 많으면 큰 쪽을 쓴다', () => {
    const progress = transcriptProgressOf({
      transcripts: map({ 1: entry({ status: 'running' }), 2: entry({ status: 'running' }) }),
      fileId: FILE,
      jobs: [job({ total: 1, done_count: 1, current_no: null })],
    });
    // 100% 를 넘는 표시(2/1)가 되지 않는다.
    expect(progress).toEqual({ doneCount: 1, total: 3, currentNo: null, jobId: 'job-1' });
  });

  it('큐에 걸린(queued) 작업도 진행으로 본다', () => {
    expect(
      transcriptProgressOf({
        transcripts: {},
        fileId: FILE,
        jobs: [job({ status: 'queued', done_count: 0, current_no: null })],
      }),
    ).toMatchObject({ doneCount: 0, jobId: 'job-1' });
  });

  it('끝난 작업이나 다른 종류·다른 시험지의 작업은 보지 않는다', () => {
    for (const patch of [
      { status: 'done' as const },
      { kind: 'solve' as const },
      { node_id: 'file-other' },
    ]) {
      expect(
        transcriptProgressOf({ transcripts: {}, fileId: FILE, jobs: [job(patch)] }),
      ).toBeNull();
    }
  });
});
