import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import type { AiFeature, AiStatus } from './contract';

export class AiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Friendly text for the common failure modes (budget, disabled, not configured). */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiError) {
    if (e.status === 402 || e.code === 'budget_exceeded') return 'The AI budget for this month has been used up. Ask a workspace admin to raise it.';
    if (e.status === 403) return e.message || 'Atrium AI is turned off for your account.';
    if (e.status === 404) return 'Atrium AI is not available on this server yet.';
    if (e.status === 503) return e.message || 'The AI provider is not configured. Ask an admin to add it in Settings → AI.';
    return e.message;
  }
  if ((e as any)?.name === 'AbortError') return 'Stopped.';
  return (e as Error)?.message || 'Something went wrong.';
}

export type SseHandler = (event: string, data: any) => void;

/**
 * POST a JSON body and read a text/event-stream response. Resolves when the stream ends.
 * Errors (HTTP or `event: error`) reject with AiError. Pass an AbortSignal to stop.
 */
export async function streamSSE(path: string, body: unknown, onEvent: SseHandler, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    let code: string | undefined;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
      code = j.code;
    } catch {}
    throw new AiError(res.status, msg, code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let failed: AiError | null = null;
  const dispatch = (raw: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let parsed: any = data.join('\n');
    try {
      parsed = JSON.parse(parsed);
    } catch {}
    if (event === 'error') failed = new AiError(parsed?.status ?? 500, parsed?.message ?? parsed?.error ?? String(parsed), parsed?.code);
    else onEvent(event, parsed);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      dispatch(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) dispatch(buf);
  if (failed) throw failed;
}

export function useAiStatus() {
  return useQuery({
    queryKey: ['ai-status'],
    queryFn: () =>
      get<any>('/ai/status')
        .then((d): AiStatus => ({
          ...d,
          features: d.features ?? {},
          // server sends orgUsedUsd / orgLimitUsd
          budget: {
            usedUsd: d.budget?.usedUsd ?? d.budget?.orgUsedUsd ?? 0,
            limitUsd: d.budget?.limitUsd ?? d.budget?.orgLimitUsd ?? null,
            userUsedUsd: d.budget?.userUsedUsd ?? 0,
            userLimitUsd: d.budget?.userLimitUsd ?? null,
          },
        }))
        .catch((): AiStatus | null => null),
    staleTime: 60_000,
    retry: false,
  });
}

/** True when the given AI feature can be used right now. */
export function useAiFeature(feature: AiFeature) {
  const { data } = useAiStatus();
  return !!data?.enabled && !!data.features?.[feature];
}
