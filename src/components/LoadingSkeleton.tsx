import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

export const WeightDisplaySkeleton = () => (
  <Card className="relative mb-6 flex-1 overflow-hidden">
    <div className="flex h-full flex-col items-center justify-center p-8 space-y-6">
      <Skeleton className="h-24 w-24 rounded-full" />
      <Skeleton className="h-32 w-64" />
      <Skeleton className="h-12 w-32 rounded-full" />
      <Skeleton className="h-12 w-48 rounded-full" />
    </div>
  </Card>
);

export const HistorySkeleton = () => (
  <div className="space-y-3">
    {[1, 2, 3, 4, 5].map((i) => (
      <Skeleton key={i} className="h-24 w-full rounded-lg" />
    ))}
  </div>
);

export const SettingsCardSkeleton = () => (
  <Card className="p-6">
    <Skeleton className="h-8 w-48 mb-6" />
    <div className="space-y-6">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-12 w-full" />
        </div>
      ))}
    </div>
  </Card>
);
