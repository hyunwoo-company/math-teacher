/**
 * 변형 "진행 중" 판정 테스트.
 *
 * 실사용 버그: 문항 패널은 "생성 중…" 인데 상단 [변형 만들기] 는 평상 상태로
 * 눌렸다. 두 화면이 같은 사실을 서로 다르게 말하지 않도록, 판정을 이 순수 함수
 * 하나로 모으고 규칙을 여기서 잠근다.
 *
 * 진행 여부의 단일 소스는 `variants[key][mode].status === 'streaming'` 이다
 * (개별 생성과 일괄 생성이 **둘 다** 이 자리를 먼저 만든다).
 */

import { describe, expect, it } from 'vitest';
import {
  VARIANT_MODES,
  allPicksRunning,
  countRunningVariants,
  doneVariantModeCount,
  hasRunningVariant,
  isPickRunning,
  runningPickCount,
  variantCacheKey,
  variantDoneProblemCount,
  variantProgressOf,
  type VariantJobLike,
  type VariantStatusLike,
  type VariantStatusMap,
} from '@/lib/variant';
import type { VariantMode } from '@/types/api';

const FILE = 'file-a';
const OTHER = 'file-b';

function entry(status: VariantStatusLike['status']): VariantStatusLike {
  return { status };
}

/** `variants` 캐시를 (문항, 유형, 상태) 목록으로 만든다. */
function cache(
  ...rows: readonly [fileId: string, no: number, mode: VariantMode, status: VariantStatusLike['status']][]
): VariantStatusMap {
  const map: Record<string, Partial<Record<VariantMode, VariantStatusLike>>> = {};
  for (const [fileId, no, mode, status] of rows) {
    const key = variantCacheKey(fileId, no);
    map[key] = { ...map[key], [mode]: entry(status) };
  }
  return map;
}

function job(overrides: Partial<VariantJobLike> = {}): VariantJobLike {
  return {
    id: 'job-1',
    kind: 'variant',
    node_id: FILE,
    status: 'running',
    total: 3,
    done_count: 1,
    current_no: 5,
    ...overrides,
  };
}

describe('variantCacheKey', () => {
  it('스토어와 같은 키 형식을 쓴다', () => {
    expect(variantCacheKey('file-a', 12)).toBe('file-a::12');
  });
});

describe('isPickRunning', () => {
  it('그 유형이 생성 중이면 true', () => {
    const variants = cache([FILE, 1, 'number', 'streaming']);
    expect(isPickRunning(variants, FILE, 1, 'number')).toBe(true);
  });

  it('done·error·idle 은 진행 중이 아니다', () => {
    const variants = cache(
      [FILE, 1, 'number', 'done'],
      [FILE, 2, 'number', 'error'],
      [FILE, 3, 'number', 'idle'],
    );
    expect(isPickRunning(variants, FILE, 1, 'number')).toBe(false);
    expect(isPickRunning(variants, FILE, 2, 'number')).toBe(false);
    expect(isPickRunning(variants, FILE, 3, 'number')).toBe(false);
    // 캐시에 아무것도 없는 문항도 당연히 아니다.
    expect(isPickRunning(variants, FILE, 9, 'number')).toBe(false);
  });

  it('다른 유형이 생성 중인 것은 이 유형과 무관하다', () => {
    const variants = cache([FILE, 1, 'number', 'streaming']);
    expect(isPickRunning(variants, FILE, 1, 'condition')).toBe(false);
  });

  it('같은 문항 번호라도 다른 시험지면 무관하다', () => {
    const variants = cache([OTHER, 1, 'number', 'streaming']);
    expect(isPickRunning(variants, FILE, 1, 'number')).toBe(false);
  });

  it("'전체' 는 3종 모두 생성 중일 때만 진행 중이다", () => {
    const partial = cache(
      [FILE, 1, 'number', 'streaming'],
      [FILE, 1, 'condition', 'streaming'],
    );
    expect(isPickRunning(partial, FILE, 1, 'all')).toBe(false);

    const full = cache(
      [FILE, 1, 'number', 'streaming'],
      [FILE, 1, 'condition', 'streaming'],
      [FILE, 1, 'number_condition', 'streaming'],
    );
    expect(isPickRunning(full, FILE, 1, 'all')).toBe(true);
  });
});

describe('runningPickCount / allPicksRunning', () => {
  const variants = cache(
    [FILE, 3, 'number', 'streaming'],
    [FILE, 5, 'number', 'streaming'],
    [FILE, 7, 'number', 'done'],
  );

  it('고른 문항 중 그 유형이 생성 중인 개수를 센다', () => {
    expect(runningPickCount(variants, FILE, [1, 3, 5, 7, 9], 'number')).toBe(2);
  });

  it('일부만 진행 중이면 전부 진행 중이 아니다(나머지는 걸 수 있어야 한다)', () => {
    expect(allPicksRunning(variants, FILE, [1, 3, 5, 7, 9], 'number')).toBe(false);
  });

  it('고른 문항 전부가 진행 중이면 true', () => {
    expect(allPicksRunning(variants, FILE, [3, 5], 'number')).toBe(true);
  });

  it('선택이 없으면 막을 근거가 없다', () => {
    expect(runningPickCount(variants, FILE, [], 'number')).toBe(0);
    expect(allPicksRunning(variants, FILE, [], 'number')).toBe(false);
  });
});

describe('hasRunningVariant', () => {
  it('유형 하나라도 생성 중이면 true', () => {
    const variants = cache([FILE, 4, 'number_condition', 'streaming']);
    expect(hasRunningVariant(variants, FILE, 4)).toBe(true);
  });

  it('모두 끝났으면 false', () => {
    const variants = cache([FILE, 4, 'number', 'done'], [FILE, 4, 'condition', 'error']);
    expect(hasRunningVariant(variants, FILE, 4)).toBe(false);
  });
});

describe('countRunningVariants', () => {
  it('그 시험지의 생성 중 (문항, 유형) 조합만 센다', () => {
    const variants = cache(
      [FILE, 1, 'number', 'streaming'],
      [FILE, 1, 'condition', 'streaming'],
      [FILE, 2, 'number', 'done'],
      [OTHER, 1, 'number', 'streaming'],
    );
    expect(countRunningVariants(variants, FILE)).toBe(2);
    expect(countRunningVariants(variants, OTHER)).toBe(1);
  });

  it('앞부분만 같은 다른 시험지 id 를 끌어오지 않는다', () => {
    const variants = cache(['file-a-copy', 1, 'number', 'streaming']);
    expect(countRunningVariants(variants, 'file-a')).toBe(0);
  });
});

describe('variantProgressOf', () => {
  it('진행 중인 변형이 없으면 null(표시하지 않는다)', () => {
    expect(variantProgressOf({ variants: {}, fileId: FILE, jobs: [] })).toBeNull();
  });

  it('작업의 진행 수치와 중단 대상 id 를 낸다', () => {
    const variants = cache(
      [FILE, 5, 'number', 'streaming'],
      [FILE, 6, 'number', 'streaming'],
    );
    expect(variantProgressOf({ variants, fileId: FILE, jobs: [job()] })).toEqual({
      doneCount: 1,
      total: 3,
      currentNo: 5,
      jobId: 'job-1',
    });
  });

  it('풀이 작업이나 다른 시험지의 작업은 세지 않는다', () => {
    const jobs = [job({ id: 'solve', kind: 'solve' }), job({ id: 'other', node_id: OTHER })];
    expect(variantProgressOf({ variants: {}, fileId: FILE, jobs })).toBeNull();
  });

  it('작업 목록이 아직 없어도 생성 중 자리가 있으면 표시한다', () => {
    // 문항별 개별 생성 직후: 자리는 있는데 jobs 조회가 아직 안 돌아온 순간.
    const variants = cache([FILE, 5, 'number', 'streaming']);
    expect(variantProgressOf({ variants, fileId: FILE, jobs: [] })).toEqual({
      doneCount: 0,
      total: 1,
      // 작업을 못 찾았으면 중단할 대상이 없다.
      jobId: null,
      currentNo: null,
    });
  });

  it('작업 total 이 실제 생성 중 자리보다 작으면 자리 수를 따른다', () => {
    // 같은 시험지에 개별 생성이 겹쳐 돌면 total(1) 보다 자리가 많다.
    const variants = cache(
      [FILE, 5, 'number', 'streaming'],
      [FILE, 6, 'number', 'streaming'],
      [FILE, 7, 'number', 'streaming'],
    );
    const progress = variantProgressOf({
      variants,
      fileId: FILE,
      jobs: [job({ total: 1, done_count: 0, current_no: null })],
    });
    expect(progress).toMatchObject({ doneCount: 0, total: 3 });
  });

  it('큐에 걸린 작업(queued)도 진행 중으로 본다', () => {
    const progress = variantProgressOf({
      variants: {},
      fileId: FILE,
      jobs: [job({ status: 'queued', done_count: 0, current_no: null })],
    });
    expect(progress).toMatchObject({ doneCount: 0, total: 3, jobId: 'job-1' });
  });

  it('끝난 작업은 표시하지 않는다', () => {
    const progress = variantProgressOf({
      variants: {},
      fileId: FILE,
      jobs: [job({ status: 'done' })],
    });
    expect(progress).toBeNull();
  });
});

/* ── "완료" 판정 ────────────────────────────────────────────────────
 *
 * 진행 중과 같은 자리(`variants[key][mode].status`)만 본다. 완료 수를 따로
 * 집계해 두면 같은 사실의 사본이 생겨, 위아래가 서로 다른 말을 하는 문제가
 * 형태만 바꿔 다시 난다.
 */

describe('doneVariantModeCount', () => {
  it('그 문항에서 만들어진 유형 수를 센다', () => {
    const variants = cache([FILE, 4, 'number', 'done'], [FILE, 4, 'condition', 'done']);
    expect(doneVariantModeCount(variants, FILE, 4)).toBe(2);
  });

  it('생성 중·실패·없음은 완료로 세지 않는다', () => {
    const variants = cache(
      [FILE, 4, 'number', 'done'],
      [FILE, 4, 'condition', 'streaming'],
      [FILE, 4, 'number_condition', 'error'],
    );
    expect(doneVariantModeCount(variants, FILE, 4)).toBe(1);
  });

  it('3종을 다 만들면 유형 수만큼 나온다', () => {
    const variants = cache(
      [FILE, 4, 'number', 'done'],
      [FILE, 4, 'condition', 'done'],
      [FILE, 4, 'number_condition', 'done'],
    );
    expect(doneVariantModeCount(variants, FILE, 4)).toBe(VARIANT_MODES.length);
  });

  it('다른 시험지·다른 문항의 완료는 섞이지 않는다', () => {
    const variants = cache([OTHER, 4, 'number', 'done'], [FILE, 5, 'number', 'done']);
    expect(doneVariantModeCount(variants, FILE, 4)).toBe(0);
  });

  it('캐시가 비어 있으면 0', () => {
    expect(doneVariantModeCount(cache(), FILE, 4)).toBe(0);
  });
});

describe('variantDoneProblemCount', () => {
  it('유형 하나라도 만들어진 문항 수를 센다(문항 단위)', () => {
    const variants = cache(
      [FILE, 1, 'number', 'done'],
      [FILE, 2, 'number', 'done'],
      [FILE, 2, 'condition', 'done'],
      [FILE, 3, 'number', 'streaming'],
    );
    // 1번·2번은 완료, 3번은 생성 중이라 아직 아니다.
    expect(variantDoneProblemCount(variants, FILE, [1, 2, 3])).toBe(2);
  });

  it('목록에 없는 문항은 세지 않는다', () => {
    const variants = cache([FILE, 9, 'number', 'done']);
    expect(variantDoneProblemCount(variants, FILE, [1, 2])).toBe(0);
  });

  it('문항 목록이 비면 0', () => {
    const variants = cache([FILE, 1, 'number', 'done']);
    expect(variantDoneProblemCount(variants, FILE, [])).toBe(0);
  });
});
