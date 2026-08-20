'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useBinaryUrl } from '@/hooks/useBinaryUrl';

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
  // 배포 인증 환경에서는 단기 토큰이 붙기 전까지 URL 이 비어 온다. 토큰 없이 걸면
  // 401 이 나 '미리보기 없음' 으로 굳으므로, 준비될 때까지 자리만 잡아 둔다.
  const src = useBinaryUrl(api.cropUrl(fileId, no));

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

  if (src == null) {
    return (
      <div
        aria-hidden
        className={clsx('animate-pulse rounded border border-slate-200 bg-slate-100', className)}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`${no}번 문제 이미지`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={clsx('rounded border border-slate-200 bg-white object-contain', className)}
    />
  );
}
