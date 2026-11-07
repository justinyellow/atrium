import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any; raw?: boolean } = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: opts.body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = res.statusText;
    let body: any;
    try {
      body = await res.json();
      msg = body.error ?? msg;
    } catch {}
    throw new ApiError(res.status, msg, body);
  }
  if (opts.raw) return res as any;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: any) => api<T>(p, { method: 'POST', body: body ?? {} });
export const patch = <T = any>(p: string, body: any) => api<T>(p, { method: 'PATCH', body });
export const put = <T = any>(p: string, body?: any) => api<T>(p, { method: 'PUT', body: body ?? {} });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

export async function uploadFile(file: File): Promise<{ id: string; url: string; name: string; size: number; mime: string }> {
  const fd = new FormData();
  fd.append('file', file);
  return api('/files', { method: 'POST', body: fd });
}
