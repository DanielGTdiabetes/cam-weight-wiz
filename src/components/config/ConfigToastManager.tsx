import { useEffect, useRef } from "react";

import { useConfigStore, selectToasts } from "@/stores/configStore";
import { toast } from "@/hooks/use-toast";

const typeClassMap: Record<string, string | undefined> = {
  success: "border-green-500 bg-green-50 text-green-900 dark:border-green-500/80 dark:bg-green-900/40 dark:text-green-50",
  warning: "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-500/80 dark:bg-amber-900/40 dark:text-amber-50",
  error: undefined,
  info: "border-slate-400 bg-slate-50 text-slate-900 dark:border-slate-500/70 dark:bg-slate-900/40 dark:text-slate-50",
};

const typeVariantMap: Record<string, "default" | "destructive"> = {
  success: "default",
  warning: "default",
  error: "destructive",
  info: "default",
};

export const ConfigToastManager = () => {
  const toasts = useConfigStore(selectToasts);
  const removeToast = useConfigStore((state) => state.removeToast);
  const displayedRef = useRef(new Set<string>());

  useEffect(() => {
    toasts.forEach((item) => {
      if (displayedRef.current.has(item.id)) {
        return;
      }
      displayedRef.current.add(item.id);
      toast({
        title: item.title,
        description: item.description,
        variant: typeVariantMap[item.type] ?? "default",
        className: typeClassMap[item.type],
        duration: item.duration ?? (item.type === "error" ? 6000 : 3500),
      });
      removeToast(item.id);
    });
  }, [toasts, removeToast]);

  return null;
};
