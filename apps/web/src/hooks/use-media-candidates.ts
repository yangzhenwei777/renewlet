import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaCandidate, MediaCandidateGroup, MediaCandidateKind } from "@/lib/api/schemas/media";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { mediaCandidateService } from "@/services/media-candidate-service";

interface UseMediaCandidatesOptions {
  kind: MediaCandidateKind;
  autoQuery?: string | undefined;
  website?: string | undefined;
  limit?: number | undefined;
  closeResetDelayMs?: number | undefined;
}

export interface UseMediaCandidatesResult {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  setQuery: (next: string) => void;
  isSearching: boolean;
  hasSearched: boolean;
  error: string | null;
  candidates: MediaCandidateGroup;
  search: () => void;
  removeCandidate: (url: string) => void;
  cancel: () => void;
  reset: () => void;
  close: () => void;
}

function emptyCandidateGroup(): MediaCandidateGroup {
  return { best: null, builtIn: [], appStore: [], favicon: [] };
}

function filterBlocked(group: MediaCandidateGroup, blocked: ReadonlySet<string>): MediaCandidateGroup {
  // 远端图片失败屏蔽后要同步重算 best；否则 App Store/favicons 坏图会继续被保存按钮当作首选。
  const builtIn = group.builtIn.filter((candidate) => !blocked.has(candidate.url));
  const appStore = group.appStore.filter((candidate) => !blocked.has(candidate.url));
  const favicon = group.favicon.filter((candidate) => !blocked.has(candidate.url));
  const best = builtIn[0] ?? appStore[0] ?? favicon[0] ?? null;
  return { best, builtIn, appStore, favicon };
}

/**
 * 管理媒体候选搜索弹层的异步状态。
 *
 * 图片加载失败、手动关闭和连续搜索都会改变候选集合；requestId + AbortController 共同防止旧请求
 * 把过期候选写回当前弹层。
 */
export function useMediaCandidates(options: UseMediaCandidatesOptions): UseMediaCandidatesResult {
  const { kind, autoQuery, website, limit = 32, closeResetDelayMs = 0 } = options;
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<MediaCandidateGroup>(() => emptyCandidateGroup());

  // Logo 搜索会被弹层打开、快速输入、关闭动画和图片 onError 同时影响；requestId 是 abort 之外的旧响应闸门。
  const queryRef = useRef("");
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const closeResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoQueryInitializedRef = useRef(false);
  const blockedUrlsRef = useRef<Set<string>>(new Set());

  const setQuery = useCallback((next: string) => {
    queryRef.current = next;
    setQueryState(next);
  }, []);

  const clearCloseResetTimer = useCallback(() => {
    if (closeResetTimerRef.current === null) return;
    clearTimeout(closeResetTimerRef.current);
    closeResetTimerRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    requestIdRef.current += 1;
    // 本轮被用户手动屏蔽的失败图片只影响当前搜索生命周期；关闭/取消后下一轮应重新给候选机会。
    blockedUrlsRef.current = new Set();
  }, []);

  const resetVisibleSearchState = useCallback(() => {
    setQuery("");
    setIsSearching(false);
    setHasSearched(false);
    setError(null);
    setCandidates(emptyCandidateGroup());
  }, [setQuery]);

  const reset = useCallback(() => {
    cancel();
    resetVisibleSearchState();
  }, [cancel, resetVisibleSearchState]);

  const searchWithQuery = useCallback((nextQuery: string) => {
    const q = nextQuery.trim();
    if (!q) {
      abortRef.current?.abort();
      abortRef.current = null;
      requestIdRef.current += 1;
      resetVisibleSearchState();
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const currentRequestId = requestIdRef.current + 1;
    requestIdRef.current = currentRequestId;

    setIsSearching(true);
    setHasSearched(true);
    setError(null);
    setCandidates(emptyCandidateGroup());

    void (async () => {
      try {
        const response = await mediaCandidateService.resolve({
          kind,
          mode: "search",
          items: [{ id: "search", name: q, ...(website?.trim() ? { website: website.trim() } : {}) }],
          limit,
        }, controller.signal);
        if (controller.signal.aborted) return;
        // abort 只能拦 fetch；requestId 负责拦住“请求已返回但用户已发起下一轮搜索”的旧结果。
        if (requestIdRef.current !== currentRequestId) return;

        const item = response.items[0];
        setCandidates(item ? filterBlocked(item.candidates, blockedUrlsRef.current) : emptyCandidateGroup());
      } catch (err) {
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== currentRequestId) return;
        console.debug("media candidate search failed:", err);
        setCandidates(emptyCandidateGroup());
        setError(translate(getApiLocale(), "media.searchFailed"));
      } finally {
        if (!controller.signal.aborted && requestIdRef.current === currentRequestId) {
          setIsSearching(false);
        }
      }
    })();
  }, [kind, limit, resetVisibleSearchState, website]);

  useEffect(() => {
    if (!open) return;
    if (autoQueryInitializedRef.current) return;

    autoQueryInitializedRef.current = true;
    if (!autoQuery?.trim()) return;

    setQuery(autoQuery);
    searchWithQuery(autoQuery);
  }, [autoQuery, open, searchWithQuery, setQuery]);

  useEffect(() => {
    return () => {
      cancel();
      clearCloseResetTimer();
      autoQueryInitializedRef.current = false;
    };
  }, [cancel, clearCloseResetTimer]);

  const onOpenChange = useCallback((nextOpen: boolean) => {
    clearCloseResetTimer();
    setOpen(nextOpen);
    if (nextOpen) {
      resetVisibleSearchState();
      autoQueryInitializedRef.current = false;
      return;
    }

    cancel();
    if (closeResetDelayMs > 0) {
      closeResetTimerRef.current = setTimeout(() => {
        closeResetTimerRef.current = null;
        resetVisibleSearchState();
      }, closeResetDelayMs);
      return;
    }
    resetVisibleSearchState();
  }, [cancel, clearCloseResetTimer, closeResetDelayMs, resetVisibleSearchState]);

  const search = useCallback(() => {
    searchWithQuery(queryRef.current);
  }, [searchWithQuery]);

  const removeCandidate = useCallback((url: string) => {
    blockedUrlsRef.current.add(url);
    setCandidates((current) => filterBlocked(current, blockedUrlsRef.current));
  }, []);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return {
    open,
    onOpenChange,
    query,
    setQuery,
    isSearching,
    hasSearched,
    error,
    candidates,
    search,
    removeCandidate,
    cancel,
    reset,
    close,
  };
}
