'use client';

import clsx from 'clsx';
import { Spinner } from '@/components/ui/Feedback';
import { useWorkspace } from '@/store/workspace';
import type { Job } from '@/types/api';

/**
 * 상단 전역 작업 배너.
 *
 * 풀이·변형은 서버 큐에서 돌기 때문에 다른 시험지를 보거나 브라우저를 닫아도
 * 계속된다. 그래서 "어느 시험지의 몇 번을 하는 중인지" 를 화면 어디에 있든
 * 알 수 있어야 한다. 진행 중 작업이 없으면 배너 자체가 없다.
 */
export function JobBanner() {
  const jobs = useWorkspace((state) => state.jobs);
  const cancelJob = useWorkspace((state) => state.cancelJob);
  const openNode = useWorkspace((state) => state.openNode);
  const setSection = useWorkspace((state) => state.setSection);

  const active = jobs.filter(
    (job) => job.status === 'running' || job.status === 'queued',
  );
  const interrupted = jobs.filter((job) => job.status === 'interrupted');

  if (active.length === 0 && interrupted.length === 0) return null;

  const current = active[0];
  const waiting = active.slice(1);

  const open = (job: Job) => {
    void setSection('exam');
    void openNode(job.node_id);
  };

  return (
    <div className="border-b border-blue-200 bg-blue-50/80 px-3 py-1.5">
      {current ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Spinner className="h-3 w-3 shrink-0 text-blue-700" />
          <span className="min-w-0 truncate text-[12px] text-blue-900" title={current.node_name}>
            <span className="font-medium">{current.node_name}</span>
            <span className="mx-1 text-blue-400">·</span>
            {describe(current)}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => open(current)}
              className="rounded border border-blue-300 bg-white px-2 py-0.5 text-[11px] text-blue-700 hover:bg-blue-100"
            >
              보기
            </button>
            <button
              type="button"
              onClick={() => void cancelJob(current.id)}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
            >
              취소
            </button>
          </div>
        </div>
      ) : null}

      {waiting.length > 0 ? (
        <p className="mt-0.5 truncate text-[11px] text-blue-700/80">
          대기 {waiting.length}건: {waiting.map((job) => `${job.node_name} ${label(job)}`).join(', ')}
        </p>
      ) : null}

      {interrupted.length > 0 ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] text-amber-800">
            중단됨 — 서버가 재시작되었습니다 ({interrupted.length}건). 다시 실행하면 이미
            끝난 문항은 건너뜁니다.
          </span>
          <button
            type="button"
            onClick={() => open(interrupted[0]!)}
            className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-50"
          >
            열어서 이어 하기
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** `3/22번 풀이 중` 처럼 지금 무엇을 하는지. */
function describe(job: Job): string {
  const kind = label(job);
  if (job.status === 'queued') return `${kind} 대기 중`;
  const at = job.current_no != null ? `${job.current_no}번 ` : '';
  return `${at}${kind} 중 (${job.done_count}/${job.total})`;
}

function label(job: Job): string {
  return job.kind === 'solve' ? '풀이' : '변형';
}

/** 배너가 붙는 자리(테스트에서 존재 확인용). */
export const JOB_BANNER_TEST_ID = 'job-banner';

export function JobBannerRegion({ className }: { className?: string }) {
  return (
    <div data-testid={JOB_BANNER_TEST_ID} className={clsx('shrink-0', className)}>
      <JobBanner />
    </div>
  );
}
