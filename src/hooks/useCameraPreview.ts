import { useEffect, useRef, useState } from "react";

interface UseCameraPreviewOptions {
  intervalMs?: number;
  onError?: (error: Error) => void;
  requestInit?: RequestInit;
}

const DEFAULT_INTERVAL = 750;

export function useCameraPreview(
  previewEndpoint: string | null | undefined,
  enabled: boolean,
  { intervalMs = DEFAULT_INTERVAL, onError, requestInit }: UseCameraPreviewOptions = {}
) {
  const [src, setSrc] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const activeObjectUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let disposed = false;

    const cleanupObjectUrl = () => {
      if (activeObjectUrlRef.current) {
        URL.revokeObjectURL(activeObjectUrlRef.current);
        activeObjectUrlRef.current = null;
      }
    };

    const scheduleNext = () => {
      if (!disposed && enabled && previewEndpoint) {
        timeoutRef.current = window.setTimeout(fetchPreview, intervalMs);
      }
    };

    const fetchPreview = async () => {
      if (!previewEndpoint || disposed) {
        return;
      }

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const response = await fetch(previewEndpoint, {
          method: "POST",
          cache: "no-store",
          ...requestInit,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();
        if (disposed) {
          return;
        }

        const nextUrl = URL.createObjectURL(blob);
        cleanupObjectUrl();
        activeObjectUrlRef.current = nextUrl;
        setSrc(nextUrl);
      } catch (error) {
        if (disposed) {
          return;
        }
        cleanupObjectUrl();
        setSrc(null);
        if (onError) {
          const normalized = error instanceof Error ? error : new Error("Camera preview failed");
          onError(normalized);
        }
        return;
      } finally {
        scheduleNext();
      }
    };

    if (enabled && previewEndpoint) {
      fetchPreview();
    } else {
      cleanupObjectUrl();
      setSrc(null);
    }

    return () => {
      disposed = true;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      cleanupObjectUrl();
      setSrc(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestInit expected to be memoized by caller
  }, [enabled, previewEndpoint, intervalMs, onError]);

  return src;
}

