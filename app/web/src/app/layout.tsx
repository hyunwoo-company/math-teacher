import type { Metadata, Viewport } from 'next';
// KaTeX CSS/폰트는 번들에 포함시킨다(CDN 금지 — 오프라인 데스크톱 대비).
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: '수학 문제풀이 워크스페이스',
  description: '시험지 PDF를 폴더로 정리하고 AI로 풀이를 생성하는 작업 공간',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}
