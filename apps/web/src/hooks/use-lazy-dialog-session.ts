import { useLayoutEffect, useRef, useState } from "react";

export interface LazyDialogResource<T> {
  load: () => Promise<T>;
  peek: () => T | null;
}

export function createLazyDialogResource<T>(loader: () => Promise<T>): LazyDialogResource<T> {
  let resolved: T | null = null;
  let pending: Promise<T> | null = null;

  return {
    load() {
      if (resolved !== null) return Promise.resolve(resolved);
      pending ??= loader().then(
        (value) => {
          resolved = value;
          return value;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    peek() {
      return resolved;
    },
  };
}

interface LazyDialogLoadState<T> {
  value: T | null;
  error: unknown | null;
}

interface LazyDialogSession<T> extends LazyDialogLoadState<T> {
  sessionKey: number;
}

export function useLazyDialogSession<T>(open: boolean, resource: LazyDialogResource<T>): LazyDialogSession<T> {
  const sessionIdRef = useRef(0);
  const wasOpenRef = useRef(open);
  const [sessionKey, setSessionKey] = useState(0);
  const [session, setSession] = useState<LazyDialogLoadState<T>>(() => ({
    value: resource.peek(),
    error: null,
  }));
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) setSessionKey((current) => current + 1);
    wasOpenRef.current = open;
  }, [open]);
  useLayoutEffect(() => {
    const sessionId = ++sessionIdRef.current;
    const invalidateSession = () => {
      if (sessionIdRef.current === sessionId) sessionIdRef.current += 1;
    };
    if (!open) return invalidateSession;

    const cached = resource.peek();
    if (cached !== null) {
      setSession({ value: cached, error: null });
      return invalidateSession;
    }

    setSession({ value: null, error: null });
    void resource.load().then(
      (value) => {
        // 当前 open session 是模块结果的唯一所有者；关闭后的迟到结果只进入模块缓存，不能改写退出动画中的内容树。
        if (sessionIdRef.current !== sessionId) return;
        setSession({ value, error: null });
      },
      (error: unknown) => {
        if (sessionIdRef.current !== sessionId) return;
        setSession({ value: null, error });
      },
    );
    return invalidateSession;
  }, [open, resource]);

  return { ...session, sessionKey };
}
