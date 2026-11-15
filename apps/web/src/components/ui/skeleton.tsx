import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-xl bg-slate-200", className)} />;
}

export function PageSkeleton() {
  return (
    <div role="status" aria-label="Cargando" className="space-y-3">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}
