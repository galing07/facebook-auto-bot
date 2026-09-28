import { cn } from "@/lib/cn";
import type { PostStatus } from "@/lib/types";

const STATUS_STYLES: Record<PostStatus, string> = {
  draft: "bg-surface-2 text-muted-foreground",
  scheduled: "bg-warning/15 text-warning",
  posted: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
};

const STATUS_LABEL: Record<PostStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  posted: "Posted",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: PostStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
        STATUS_STYLES[status]
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABEL[status]}
    </span>
  );
}

type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "danger";

const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: "bg-surface-2 text-foreground",
  secondary: "bg-surface-2 text-muted-foreground",
  outline: "border border-border bg-transparent text-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border px-2.5 py-1 text-xs font-medium",
        BADGE_VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
}
