/**
 * Tauri 래핑을 전제로 한 설정.
 *
 * - `output: 'export'` : 서버 런타임 없이 정적 에셋만 만든다. Tauri 는 이 결과물(`out/`)을
 *   그대로 로드한다. 따라서 Server Actions / Route Handler / 동적 라우트 SSR 은 쓰지 않는다.
 * - `images.unoptimized` : 정적 export 에서는 next/image 최적화 서버가 없다.
 * - 백엔드 주소는 런타임이 아니라 빌드 시점 환경변수(`NEXT_PUBLIC_API_BASE`)로 주입한다.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  // 정적 export 시 `/` -> `out/index.html` 로 떨어지게 한다(파일 프로토콜 호환).
  trailingSlash: true,
  eslint: {
    // 린트는 `npm run lint` 로 별도 실행한다(빌드 파이프라인 분리).
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
