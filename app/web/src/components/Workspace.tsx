'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AccessGate } from '@/components/AccessGate';
import { JobBanner } from '@/components/JobBanner';
import { AiPanel } from '@/components/ai/AiPanel';
import { CenterPanel } from '@/components/center/CenterPanel';
import { FileTreePanel } from '@/components/tree/FileTreePanel';
import { Onboarding } from '@/components/Onboarding';
import { ErrorState, LoadingState } from '@/components/ui/Feedback';
import { needsAccessGate } from '@/lib/access-gate';
import { API_BASE, IS_MOCK } from '@/lib/config';
import { LEFT_MAX, LEFT_MIN, RIGHT_MAX, RIGHT_MIN, useWorkspace } from '@/store/workspace';

/**
 * 앱 루트(클라이언트 경계).
 *
 * 정적 export + Tauri 를 전제로 하므로 초기 데이터는 서버가 아니라 여기서 받아온다.
 * 서버 컴포넌트는 `app/layout.tsx` / `app/page.tsx` 의 정적 셸만 담당한다.
 */
export function Workspace() {
  const env = useWorkspace((state) => state.env);
  const envStatus = useWorkspace((state) => state.envStatus);
  const envError = useWorkspace((state) => state.envError);
  const onboardingSkipped = useWorkspace((state) => state.onboardingSkipped);
  const hasLocalApiKey = useWorkspace((state) => state.hasLocalApiKey);
  const providerConfig = useWorkspace((state) => state.providerConfig);
  const accessOk = useWorkspace((state) => state.accessOk);
  const rightWidth = useWorkspace((state) => state.rightWidth);
  const leftWidth = useWorkspace((state) => state.leftWidth);
  const leftCollapsed = useWorkspace((state) => state.leftCollapsed);
  const rightCollapsed = useWorkspace((state) => state.rightCollapsed);
  const toast = useWorkspace((state) => state.toast);

  const hydratePrefs = useWorkspace((state) => state.hydratePrefs);
  const loadEnv = useWorkspace((state) => state.loadEnv);
  const loadTree = useWorkspace((state) => state.loadTree);
  const loadJobs = useWorkspace((state) => state.loadJobs);
  const loadUsageSummary = useWorkspace((state) => state.loadUsageSummary);
  const bootstrapConversations = useWorkspace((state) => state.bootstrapConversations);
  const logout = useWorkspace((state) => state.logout);
  const setRightWidth = useWorkspace((state) => state.setRightWidth);
  const setLeftWidth = useWorkspace((state) => state.setLeftWidth);
  const toggleLeftCollapsed = useWorkspace((state) => state.toggleLeftCollapsed);
  const toggleRightCollapsed = useWorkspace((state) => state.toggleRightCollapsed);
  const dismissToast = useWorkspace((state) => state.dismissToast);

  // 어느 쪽 구분선을 끌고 있는지. null = 드래그 중 아님.
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // React StrictMode 이중 실행 방지.
    if (startedRef.current) return;
    startedRef.current = true;
    hydratePrefs();
    // env 를 먼저 확인한 뒤, 접근이 확보됐을 때만 트리를 불러온다.
    // (비번 게이트가 필요한 배포본에서 로그인 전에 401 이 나지 않게 한다. 로그인 성공 시
    //  store.login 이 트리를 불러온다.)
    void (async () => {
      await loadEnv();
      if (useWorkspace.getState().accessOk) {
        void loadTree();
        // 전역 대화 목록을 불러오고 마지막으로 보던 대화를 복원한다(실패는 조용히 무시).
        void bootstrapConversations();
        // agy 쿼터 사용량 요약을 초기 진입에 한 번 불러온다(실패는 조용히 무시).
        void loadUsageSummary();
        // 진행 중인 작업을 되살린다. 새로고침해도 배너와 타이핑이 이어진다.
        void loadJobs();
      }
    })();
  }, [hydratePrefs, loadEnv, loadTree, loadJobs, loadUsageSummary, bootstrapConversations]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, 6000);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      // 좌측은 화면 왼쪽 기준(clientX), 우측은 오른쪽 기준(innerWidth - clientX).
      if (resizing === 'left') setLeftWidth(event.clientX);
      else if (resizing === 'right') setRightWidth(window.innerWidth - event.clientX);
    },
    [resizing, setLeftWidth, setRightWidth],
  );

  useEffect(() => {
    if (!resizing) return;
    const stop = () => setResizing(null);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing, onPointerMove]);

  if (envStatus === 'idle' || envStatus === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-slate-100">
        <LoadingState label="작업 환경을 확인하는 중입니다…" />
      </main>
    );
  }

  if (envStatus === 'error' || !env) {
    return (
      <main className="flex h-full items-center justify-center bg-slate-100 p-6">
        <div className="w-full max-w-[520px]">
          <ErrorState
            message={envError ?? '작업 환경을 확인하지 못했습니다.'}
            hint={`백엔드 주소: ${API_BASE} · 로컬 서버가 실행 중인지 확인하세요.`}
            onRetry={() => {
              void loadEnv();
              void loadTree();
            }}
          />
        </div>
      </main>
    );
  }

  // 접속 비밀번호 게이트: 비번 요구 환경(env.auth_required)에서 접근 전이면 로그인 화면.
  // auth_required 가 false(로컬 개발)면 이 조건은 항상 거짓이라 기존 흐름 그대로다.
  if (needsAccessGate(env, accessOk)) {
    return (
      <main className="h-full">
        <AccessGate />
      </main>
    );
  }

  // agy 등 다른 provider 가 하나라도 쓸 수 있으면 온보딩이 필요 없다(계약 3-C).
  const agyAvailable =
    providerConfig?.options.some((option) => option.id === 'agy' && option.available) ?? false;
  // 웹 모드는 서버가 키를 저장하지 않으므로(계약 3-2) 브라우저 보관 여부도 함께 본다.
  const needsOnboarding =
    !onboardingSkipped &&
    !env.subscription.available &&
    !env.api_key_set &&
    !hasLocalApiKey &&
    !agyAvailable;

  if (needsOnboarding) {
    return (
      <main className="h-full">
        <Onboarding env={env} />
      </main>
    );
  }

  return (
    <main className="flex h-full flex-col">
      {IS_MOCK ? (
        <div className="flex items-center gap-2 bg-amber-100 px-3 py-1 text-[11px] text-amber-900">
          <span className="font-semibold">목 모드</span>
          <span>백엔드 없이 화면 흐름만 확인하는 중입니다. 데이터는 저장되지 않습니다.</span>
        </div>
      ) : null}
      {/* 풀이·변형은 서버에서 도는 작업이라 어느 화면에 있든 진행 상황을 알려준다. */}
      <JobBanner />

      {/*
        접속 비밀번호 게이트가 켜진 배포본에서만 상단 바에 로그아웃을 둔다.
        이전에는 우하단 고정 버튼이 본문을 가렸다 → 콘텐츠를 덮지 않는 상단 헤더 우측으로 옮긴다.
      */}
      {env.auth_required ? (
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 py-1.5">
          <span className="text-[12px] font-semibold text-slate-600">수학 문제풀이</span>
          <button
            type="button"
            onClick={logout}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-800"
          >
            로그아웃
          </button>
        </header>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {leftCollapsed ? (
          <ReopenRail
            side="left"
            label="왼쪽 메뉴 펼치기"
            onExpand={toggleLeftCollapsed}
          />
        ) : (
          <>
            <div style={{ width: leftWidth }} className="min-w-0 shrink-0">
              <FileTreePanel onCollapse={toggleLeftCollapsed} />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="왼쪽 메뉴 너비 조절"
              aria-valuenow={leftWidth}
              aria-valuemin={LEFT_MIN}
              aria-valuemax={LEFT_MAX}
              tabIndex={0}
              onPointerDown={(event) => {
                event.preventDefault();
                setResizing('left');
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setLeftWidth(leftWidth - 16);
                if (event.key === 'ArrowRight') setLeftWidth(leftWidth + 16);
              }}
              className={clsx(
                'w-1 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-blue-400',
                resizing === 'left' && 'bg-blue-500',
              )}
            />
          </>
        )}

        <CenterPanel />

        {rightCollapsed ? (
          <ReopenRail
            side="right"
            label="프롬프트 패널 펼치기"
            onExpand={toggleRightCollapsed}
          />
        ) : (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="AI 패널 너비 조절"
              aria-valuenow={rightWidth}
              aria-valuemin={RIGHT_MIN}
              aria-valuemax={RIGHT_MAX}
              tabIndex={0}
              onPointerDown={(event) => {
                event.preventDefault();
                setResizing('right');
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setRightWidth(rightWidth + 16);
                if (event.key === 'ArrowRight') setRightWidth(rightWidth - 16);
              }}
              className={clsx(
                'w-1 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-blue-400',
                resizing === 'right' && 'bg-blue-500',
              )}
            />

            <div style={{ width: rightWidth }} className="shrink-0 border-l border-slate-200">
              <AiPanel onCollapse={toggleRightCollapsed} />
            </div>
          </>
        )}
      </div>

      {toast ? (
        <div
          role="status"
          className={clsx(
            'fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-[13px] shadow-lg',
            toast.kind === 'error'
              ? 'border-rose-300 bg-rose-50 text-rose-800'
              : toast.kind === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                : 'border-slate-300 bg-white text-slate-700',
          )}
        >
          <div className="flex items-start gap-3">
            <div>
              <p>{toast.message}</p>
              {toast.hint ? <p className="mt-0.5 text-[11px] opacity-80">{toast.hint}</p> : null}
            </div>
            <button
              type="button"
              onClick={dismissToast}
              className="text-[11px] opacity-60 hover:opacity-100"
            >
              닫기
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

/**
 * 패널이 접혔을 때 가장자리에 남는 얇은 재열기 바.
 * 좌측(◂→▸)/우측(◂) 방향 화살표로 다시 펼친다.
 */
function ReopenRail({
  side,
  label,
  onExpand,
}: {
  side: 'left' | 'right';
  label: string;
  onExpand: () => void;
}) {
  return (
    <div
      className={clsx(
        'flex w-7 shrink-0 flex-col items-center bg-slate-50 py-2',
        side === 'left' ? 'border-r border-slate-200' : 'border-l border-slate-200',
      )}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={false}
        aria-label={label}
        title={label}
        className="rounded px-1 py-1 text-[13px] leading-none text-slate-500 hover:bg-slate-200 hover:text-slate-800"
      >
        {side === 'left' ? '▸' : '◂'}
      </button>
    </div>
  );
}
