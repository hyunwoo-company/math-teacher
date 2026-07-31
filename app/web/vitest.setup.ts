import '@testing-library/jest-dom/vitest';

// 테스트는 항상 목 클라이언트를 쓴다(`lib/config.ts` 가 모듈 로드 시점에 읽는다).
process.env.NEXT_PUBLIC_MOCK = '1';
process.env.NEXT_PUBLIC_MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_MODE ?? 'desktop';

// jsdom 에는 없지만 컴포넌트가 쓰는 API 들을 최소한으로 채운다.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    writable: true,
  });
}
