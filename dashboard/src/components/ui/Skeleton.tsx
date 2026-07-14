/** Shimmer placeholders for loading states. */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={["apx-skel-card", className].filter(Boolean).join(" ")} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className={`apx-skel line${i === lines - 1 ? " sm" : ""}`} />
      ))}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <span className={["apx-skel block", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}

/** A grid of card-shaped skeletons, for metric rows. */
export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="apx-grid apx-grid-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className="apx-skel block" />
      ))}
    </div>
  );
}
