'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { MathText } from '@/components/MathText';
import { ApiCostNotice } from '@/components/ai/ApiCostNotice';
import { SubscriptionNotice } from '@/components/ai/SubscriptionNotice';
import { ConversationList } from '@/components/ai/ConversationList';
import { UsageFooter } from '@/components/ai/UsageFooter';
import { UsageStatusBar } from '@/components/ai/UsageStatusBar';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, InlineBadge, LoadingState, Spinner } from '@/components/ui/Feedback';
import { toPlainText } from '@/lib/to-plain-text';
import { costAmounts, effortLabel, formatInt, formatKrw, formatUsd, totalTokens } from '@/lib/format';
import { detectProblemNo } from '@/lib/mention';
import { modelsForProvider } from '@/lib/provider-config';
import { subscriptionGuidance } from '@/lib/subscription-status';
import { useWorkspace } from '@/store/workspace';
import { EFFORT_OPTIONS, type Effort, type ProviderChoice } from '@/types/api';

/** 시험지 선택 직후 보여줄 사용 예시(계약 6). 클릭하면 입력창에 채워진다. */
const EXAMPLE_CHIPS = [
  '6번 문제 풀이해줘',
  '5번 이현우 오답노트에 추가해줘',
  '3번이랑 5번 비교해서 설명해줘',
];

/** 우측 패널: 전체 문제풀이 + 채팅. */
export function AiPanel({ onCollapse }: { onCollapse?: () => void }) {
  const env = useWorkspace((state) => state.env);
  const selectedFileId = useWorkspace((state) => state.selectedFileId);
  const fileDetail = useWorkspace((state) => state.fileDetail);
  const messages = useWorkspace((state) => state.messages);
  const chatStatus = useWorkspace((state) => state.chatStatus);
  const chatSending = useWorkspace((state) => state.chatSending);
  const solve = useWorkspace((state) => state.solve);
  const solutions = useWorkspace((state) => state.solutions);
  const selectedProblemNo = useWorkspace((state) => state.selectedProblemNo);
  const model = useWorkspace((state) => state.model);
  const effort = useWorkspace((state) => state.effort);
  const provider = useWorkspace((state) => state.provider);
  const providerConfig = useWorkspace((state) => state.providerConfig);
  const hasLocalApiKey = useWorkspace((state) => state.hasLocalApiKey);
  const usdKrw = useWorkspace((state) => state.env?.usd_krw ?? 1400);
  const chatTruncatedBefore = useWorkspace((state) => state.chatTruncatedBefore);
  const notePrompt = useWorkspace((state) => state.notePrompt);

  const setModel = useWorkspace((state) => state.setModel);
  const setEffort = useWorkspace((state) => state.setEffort);
  const setProvider = useWorkspace((state) => state.setProvider);
  const startSolve = useWorkspace((state) => state.startSolve);
  const cancelJob = useWorkspace((state) => state.cancelJob);
  const jobs = useWorkspace((state) => state.jobs);
  const sendChat = useWorkspace((state) => state.sendChat);
  const abortChat = useWorkspace((state) => state.abortChat);
  const newConversation = useWorkspace((state) => state.newConversation);
  const saveSolutionFromMessage = useWorkspace((state) => state.saveSolutionFromMessage);
  const confirmNotePrompt = useWorkspace((state) => state.confirmNotePrompt);
  const cancelNotePrompt = useWorkspace((state) => state.cancelNotePrompt);

  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // 스트리밍 중 자동 스크롤. 사용자가 위로 올려 읽는 중이면 방해하지 않는다.
  useEffect(() => {
    const element = listRef.current;
    if (!element || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  const subscriptionAvailable = env?.subscription.available === true;
  const unsolved = fileDetail
    ? fileDetail.problems.filter((problem) => solutions[problem.no]?.status !== 'done').length
    : 0;

  // 계약 3-C: provider/모델은 env 의 providers 구조(또는 폴백)에서 계산한다. 하드코딩 금지.
  const providerOptions = providerConfig?.options ?? [];
  const currentOption = providerOptions.find((option) => option.id === provider) ?? null;
  const models = useMemo(() => {
    if (providerConfig) {
      const list = modelsForProvider(providerConfig, provider);
      if (list.length > 0) return list;
    }
    // 폴백: env.models(Claude) 또는 현재 모델만.
    return (
      env?.models.map((model) => ({ id: model.id, label: model.label })) ?? [
        { id: model, label: model },
      ]
    );
  }, [providerConfig, provider, env, model]);

  /** agy 는 쿼터 기반 무과금. 종량 과금은 apikey 뿐. */
  const willBeBilled = currentOption
    ? currentOption.billing === 'usage'
    : provider === 'apikey' || (provider === 'auto' && !subscriptionAvailable);

  /**
   * AI 를 호출할 수단이 아예 없는 상태(어떤 provider 도 못 씀 + API 키 없음).
   */
  const hasApiKey = env?.api_key_set === true || hasLocalApiKey;
  const anyProviderAvailable = providerConfig
    ? providerOptions.some((option) => option.available) || hasApiKey
    : subscriptionAvailable || hasApiKey;
  const canCallAi = anyProviderAvailable;
  const guidance = env && !canCallAi && !subscriptionAvailable ? subscriptionGuidance(env) : null;

  // 문항을 고르지 않았을 때, 입력 중인 문장에서 문항 번호를 미리 찾아 알려 준다.
  const detectedProblemNo = useMemo(() => {
    if (selectedProblemNo != null || draft.trim() === '') return null;
    return detectProblemNo(draft, fileDetail?.problems.map((problem) => problem.no) ?? []);
  }, [draft, selectedProblemNo, fileDetail]);

  const providerBadge = currentOption
    ? currentOption.billing === 'quota'
      ? '무과금(쿼터)'
      : currentOption.billing === 'usage'
        ? 'API 키'
        : '구독'
    : subscriptionAvailable
      ? '구독'
      : 'API 키';

  const submit = () => {
    if (draft.trim() === '' || chatSending) return;
    void sendChat(draft);
    setDraft('');
  };

  return (
    <aside className="flex h-full min-w-0 flex-col bg-white">
      <header className="space-y-2 border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              aria-expanded
              aria-label="프롬프트 패널 접기"
              title="프롬프트 패널 접기"
              className="shrink-0 rounded px-1.5 py-1 text-[13px] leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              ▸
            </button>
          ) : null}
          {solve.running ? (
            <button
              type="button"
              onClick={() => {
                // 이 시험지의 진행 중 풀이 작업을 취소한다(서버 큐에서 뺀다).
                const running = jobs.find(
                  (job) =>
                    job.node_id === selectedFileId &&
                    job.kind === 'solve' &&
                    (job.status === 'running' || job.status === 'queued'),
                );
                if (running) void cancelJob(running.id);
              }}
              className="flex-1 rounded border border-rose-600 bg-rose-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-rose-700"
            >
              풀이 중단
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startSolve(null)}
              disabled={!selectedFileId || (fileDetail?.problems.length ?? 0) === 0 || !canCallAi}
              className="flex-1 rounded border border-blue-600 bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
              title={
                !canCallAi
                  ? 'Claude Code 로그인 또는 API 키 입력이 필요합니다'
                  : selectedFileId
                    ? '이 시험지의 모든 문제를 순서대로 풉니다'
                    : '먼저 파일을 선택하세요'
              }
            >
              전체 문제풀이
              {fileDetail ? ` (${fileDetail.problems.length}문항)` : ''}
            </button>
          )}
        </div>

        {solve.running || solve.doneCount > 0 || solve.error ? (
          <SolveProgressBar
            running={solve.running}
            doneCount={solve.doneCount}
            total={solve.total}
            currentNo={solve.currentNo}
            aborted={solve.aborted}
            error={solve.error}
          />
        ) : unsolved > 0 && selectedFileId ? (
          <p className="text-[11px] text-slate-500">미풀이 {unsolved}문항</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          {/* 공급자 선택: providers 구조 기반. 사용 불가 옵션은 비활성으로 남긴다. */}
          {providerOptions.length > 0 ? (
            <select
              aria-label="공급자 선택"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderChoice)}
              className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[12px] text-slate-700"
            >
              {providerOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>
                  {option.label}
                  {option.available ? '' : ' (사용 불가)'}
                </option>
              ))}
            </select>
          ) : null}

          {/* 모델 선택: 현재 provider 에 종속. */}
          <select
            aria-label="모델 선택"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-1.5 py-1 text-[12px] text-slate-700"
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>

          <select
            aria-label="추론 강도(effort) 선택"
            value={effort}
            onChange={(event) => setEffort(event.target.value as Effort)}
            className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[12px] text-slate-700"
            title="effort: 높을수록 더 오래 생각합니다"
          >
            {EFFORT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {effortLabel(option)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span>현재 공급자</span>
          <InlineBadge tone={providerBadge === '무과금(쿼터)' ? 'green' : providerBadge === '구독' ? 'green' : 'blue'}>
            {providerBadge}
          </InlineBadge>
          {providerConfig && !subscriptionAvailable && !providerOptions.some((o) => o.id === 'agy' && o.available) ? (
            <span className="text-slate-400">
              {env?.mode === 'web' ? '웹에서는 구독을 쓸 수 없습니다' : 'Claude Code 를 찾지 못했습니다'}
            </span>
          ) : null}
        </div>

        {/*
          키가 아예 없는 상태에서 "API 키 모드" 라고 하면 오해를 준다(호출 자체가 불가).
          그 경우는 프롬프트 영역의 SubscriptionNotice 가 과금 안내까지 함께 처리한다.
        */}
        {willBeBilled && canCallAi ? (
          <ApiCostNotice
            models={env?.models ?? []}
            modelId={model}
            usdKrw={usdKrw}
            problemCount={fileDetail?.problems.length ?? 0}
            subscriptionAvailable={subscriptionAvailable}
          />
        ) : null}
      </header>

      {/* 전역 대화 목록/전환/이름변경/삭제 (ChatGPT식). */}
      <ConversationList />

      <div
        ref={listRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto px-3 py-2"
      >
        {chatStatus === 'loading' && messages.length === 0 ? (
          <LoadingState label="대화 기록을 불러오는 중입니다…" />
        ) : messages.length === 0 ? (
          <div className="flex flex-col gap-3 py-4">
            <EmptyState
              title="새 대화를 시작하세요"
              description="무엇이든 물어보세요. 문제 번호를 클릭하면 그 문항을 함께 보낼 수 있습니다."
              icon="💬"
            />
            {/* 사용 예시 칩 (클릭하면 입력됨) */}
            <div className="flex flex-col items-stretch gap-1.5 px-2">
              {EXAMPLE_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={!canCallAi && !chip.includes('오답노트')}
                  onClick={() => setDraft(chip)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-left text-[12px] text-slate-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {/* 이력이 잘려 보내졌음을 알린다. */}
            {chatTruncatedBefore > 0 ? (
              <li className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                이전 대화 {chatTruncatedBefore}개가 생략된 채로 전달되었습니다. 맥락이 흐려질 수
                있으니
                <button
                  type="button"
                  onClick={newConversation}
                  className="ml-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
                >
                  새 대화
                </button>
                를 시작하는 게 좋습니다.
              </li>
            ) : null}
            {messages.map((message) => {
              if (message.role === 'system') {
                return (
                  <li key={message.id}>
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
                      <span className="mr-1 font-medium text-slate-500">안내</span>
                      {message.content}
                    </div>
                  </li>
                );
              }
              const { usd, krw } = costAmounts(message.cost, usdKrw);
              const tokens = totalTokens(message.usage);
              return (
                <li key={message.id}>
                  <div
                    className={clsx(
                      'rounded-lg px-3 py-2 text-[13px] leading-relaxed',
                      message.role === 'user'
                        ? 'ml-6 bg-blue-600 text-white'
                        : 'mr-2 border border-slate-200 bg-slate-50 text-slate-800',
                    )}
                  >
                    <div className="mb-1 flex items-center gap-2 text-[11px] opacity-80">
                      <span>{message.role === 'user' ? '나' : 'AI'}</span>
                      {message.problemNo != null ? <span>· {message.problemNo}번</span> : null}
                      {message.streaming ? <Spinner className="h-3 w-3" /> : null}
                    </div>
                    {message.role === 'user' ? (
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    ) : message.content ? (
                      <MathText className={clsx(message.streaming && 'streaming-caret')}>
                        {message.content}
                      </MathText>
                    ) : message.error ? null : (
                      <p className="text-slate-400">응답을 기다리는 중…</p>
                    )}
                    {message.error ? (
                      <p className="mt-1 rounded border border-rose-200 bg-white px-2 py-1 text-[12px] text-rose-700">
                        {message.error}
                      </p>
                    ) : null}
                  </div>
                  {message.role === 'assistant' && !message.streaming ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2 pl-1">
                      <p className="text-[10px] text-slate-400">
                        {/* cost 로만 과금 판단. 구독/agy 는 usage 만 오고 cost 는 null. */}
                        {message.cost
                          ? `토큰 ${formatInt(tokens)} · ${formatUsd(usd)} / ${formatKrw(krw)}`
                          : message.usage
                            ? `토큰 ${formatInt(tokens)} · 요금 청구 없음`
                            : '요금 청구 없음'}
                      </p>
                      {/* 문항 컨텍스트가 걸린 답변은 그 문항 풀이로 저장할 수 있다. */}
                      {message.fileId != null && message.problemNo != null && message.content ? (
                        message.savedAsSolution ? (
                          <span className="text-[10px] font-medium text-emerald-600">
                            ✓ {message.problemNo}번 풀이로 저장됨
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void saveSolutionFromMessage(message.id)}
                            disabled={message.savingSolution}
                            className="rounded border border-emerald-500 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                          >
                            {message.savingSolution
                              ? '저장 중…'
                              : `${message.problemNo}번 풀이로 저장`}
                          </button>
                        )
                      ) : null}
                      {/* 두 버튼 다 용도가 이름에 있다: AI 대화용=마크다운 원문, 한글·워드용=유니코드 평문. */}
                      {message.content ? (
                        <div className="ml-auto flex items-center gap-1.5">
                          <CopyButton
                            text={message.content}
                            label="복사(AI 대화용)"
                            title="마크다운·LaTeX 원문 그대로 복사 (다른 AI 에 붙여넣을 때)"
                          />
                          <CopyButton
                            text={toPlainText(message.content)}
                            label="복사(한글·워드용)"
                            title="한글·워드에 붙여넣을 수 있는 텍스트로 복사"
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-slate-200 p-2">
        {/* AI 호출 수단이 없으면 여기서 무엇을 하면 되는지 알린다(온보딩을 건너뛴 뒤에도). */}
        {env && !canCallAi ? <SubscriptionNotice env={env} modelId={model} /> : null}

        {detectedProblemNo != null ? (
          <p className="mb-1 text-[11px] text-blue-700">
            {detectedProblemNo}번 문항을 함께 보냅니다
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            rows={2}
            disabled={!canCallAi}
            placeholder={
              !canCallAi
                ? (guidance?.inputPlaceholder ?? 'AI 사용 설정이 필요합니다')
                : '질문을 입력하세요. Enter 전송, Shift+Enter 줄바꿈'
            }
            className="max-h-40 min-h-[46px] flex-1 resize-y rounded border border-slate-300 px-2 py-1.5 text-[13px] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"
          />
          {chatSending ? (
            <button
              type="button"
              onClick={abortChat}
              className="h-[46px] rounded border border-rose-600 bg-rose-600 px-3 text-[13px] font-medium text-white hover:bg-rose-700"
            >
              중단
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim() === '' || !canCallAi}
              className="h-[46px] rounded border border-blue-600 bg-blue-600 px-3 text-[13px] font-medium text-white hover:bg-blue-700 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
            >
              전송
            </button>
          )}
        </div>
      </div>

      <UsageStatusBar />
      <UsageFooter />

      {/* 계약 6-A: 학생 오답노트가 없을 때 임의 생성하지 않고 물어본다. */}
      <ConfirmDialog
        open={notePrompt != null}
        title="오답노트 만들기"
        confirmLabel="만들고 담기"
        tone="primary"
        onCancel={cancelNotePrompt}
        onConfirm={() => void confirmNotePrompt()}
        message={
          notePrompt ? (
            <p>
              <span className="font-semibold">{notePrompt.noteName}</span> 오답노트가 없습니다.
              새로 만들고 {notePrompt.problemNumbers.join(', ')}번을 담을까요?
            </p>
          ) : (
            ''
          )
        }
      />
    </aside>
  );
}

function SolveProgressBar({
  running,
  doneCount,
  total,
  currentNo,
  aborted,
  error,
}: {
  running: boolean;
  doneCount: number;
  total: number;
  currentNo: number | null;
  aborted: boolean;
  error: string | null;
}) {
  const percent = total > 0 ? Math.min(100, Math.round((doneCount / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-slate-600">
        <span>
          {running
            ? `풀이 중 ${doneCount}/${total}`
            : aborted
              ? `중단됨 (${doneCount}/${total})`
              : `완료 ${doneCount}/${total}`}
          {running && currentNo != null ? ` · ${currentNo}번` : ''}
        </span>
        <span className="tabular-nums text-slate-400">{percent}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200">
        <div
          className={clsx('h-full transition-[width]', aborted ? 'bg-slate-400' : 'bg-blue-600')}
          style={{ width: `${percent}%` }}
        />
      </div>
      {error ? <p className="text-[11px] text-rose-600">{error}</p> : null}
    </div>
  );
}
