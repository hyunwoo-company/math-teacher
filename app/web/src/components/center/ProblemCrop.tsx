'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';

interface ProblemCropProps {
  fileId: string;
  no: number;
  className?: string;
}

/**
 * 문제 크롭 썸네일.
 *
 * next/image 를 쓰지 않는 이유: 정적 export 라 이미지 최적화 서버가 없고,
 * 소스가 백엔드 절대 URL(또는 목 모드의 data URI)이라 최적화 대상이 아니다.
 */
export function ProblemCrop({ fileId, no, className }: ProblemCropProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={clsx(
          'flex items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-[10px] text-slate-400',
          className,
        )}
      >
        미리보기 없음
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={api.cropUrl(fileId, no)}
      alt={`${no}번 문제 이미지`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={clsx('rounded border border-slate-200 bg-white object-contain', className)}
    />
  );
}
