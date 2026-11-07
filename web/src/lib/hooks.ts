import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { get, queryClient } from './api';
import type { Me, Tree, User, Page, Database, QueryResult } from './types';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/me'), retry: false });
export const useTree = () => useQuery({ queryKey: ['tree'], queryFn: () => get<Tree>('/tree') });
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => get<User[]>('/users'), staleTime: 60_000 });
export const usePage = (id: string | undefined) =>
  useQuery({ queryKey: ['page', id], queryFn: () => get<Page>(`/pages/${id}`), enabled: !!id });
export const useDatabase = (id: string | undefined) =>
  useQuery({ queryKey: ['db', id], queryFn: () => get<Database>(`/databases/${id}`), enabled: !!id });
export const useUnread = () =>
  useQuery({ queryKey: ['unread'], queryFn: () => get<{ count: number }>('/notifications/unread') });

export function useUserMap() {
  const { data } = useUsers();
  const map = new Map<string, User>();
  for (const u of data ?? []) map.set(u.id, u);
  return map;
}

export type { QueryResult };

/** Subscribes to the server event bus and invalidates matching queries. */
export function useLiveEvents(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let ping: ReturnType<typeof setInterval>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/v1/events`);
      ws.onopen = () => {
        retry = 1000;
        ping = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25_000);
      };
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data);
        switch (ev.type) {
          case 'tree':
            queryClient.invalidateQueries({ queryKey: ['tree'] });
            break;
          case 'page':
            queryClient.invalidateQueries({ queryKey: ['page', ev.id] });
            break;
          case 'db':
            queryClient.invalidateQueries({ queryKey: ['db', ev.id] });
            queryClient.invalidateQueries({ queryKey: ['dbq', ev.id] });
            break;
          case 'comments':
            queryClient.invalidateQueries({ queryKey: ['comments', ev.pageId] });
            break;
          case 'notifications':
            queryClient.invalidateQueries({ queryKey: ['unread'] });
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
            break;
          case 'members':
            queryClient.invalidateQueries({ queryKey: ['users'] });
            queryClient.invalidateQueries({ queryKey: ['me'] });
            break;
        }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 15_000)));
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [enabled]);
}
