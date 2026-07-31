'use client';

import dynamic from 'next/dynamic';
import { LoadingState } from '@/components/ui/Feedback';

/**
 * pdf.js 는 DOM/Canvas 에 의존하므로 서버 프리렌더에서 제외한다.
 * (정적 export 에서도 빌드 시 HTML 을 만들기 때문에 필요하다.)
 */
export const PdfViewer = dynamic(() => import('@/components/center/PdfViewerInner'), {
  ssr: false,
  loading: () => <LoadingState label="PDF 뷰어를 준비하는 중입니다…" />,
});
