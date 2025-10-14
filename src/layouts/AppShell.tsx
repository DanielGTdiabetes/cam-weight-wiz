import { PropsWithChildren, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/TopBar";
import { GlucoseHeaderBadge } from "@/components/GlucoseHeaderBadge";

interface AppShellProps {
  showTopBar: boolean;
  topBar?: ReactNode;
  topBarProps?: Parameters<typeof TopBar>[0];
  notifications?: ReactNode;
  contentClassName?: string;
}

export const AppShell = ({
  showTopBar,
  topBar,
  topBarProps,
  notifications,
  children,
  contentClassName,
}: PropsWithChildren<AppShellProps>) => {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="sticky top-0 z-50 flex flex-col">
        {showTopBar && (topBar ?? (topBarProps ? <TopBar {...topBarProps} /> : null))}
        <GlucoseHeaderBadge />
        {showTopBar && notifications}
      </div>
      <main className={cn("flex-1 overflow-y-auto", contentClassName)}>{children}</main>
    </div>
  );
};
