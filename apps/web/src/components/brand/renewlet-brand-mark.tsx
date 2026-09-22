import type { ReactNode } from "react";

import { RenewletLogo } from "@/components/icons/renewlet-logo";
import Link from "@/components/router-link";
import { cn } from "@/lib/utils";

export type RenewletBrandMarkSize = "sm" | "md" | "lg";

const brandMarkFrameClasses: Record<RenewletBrandMarkSize, string> = {
  sm: "h-10 w-10 rounded-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_30px_-20px_rgba(0,0,0,0.8)]",
  md: "h-12 w-12 rounded-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_16px_32px_-22px_rgba(0,0,0,0.8)]",
  lg: "h-14 w-14 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_36px_-22px_rgba(0,0,0,0.82)]",
};

const brandMarkLogoClasses: Record<RenewletBrandMarkSize, string> = {
  sm: "h-5 w-5",
  md: "h-6 w-6",
  lg: "h-7 w-7",
};

type RenewletBrandMarkProps = {
  size?: RenewletBrandMarkSize | undefined;
  href?: string | undefined;
  ariaLabel?: string | undefined;
  interactive?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
  "aria-label"?: string | undefined;
  "data-testid"?: string | undefined;
};

export function RenewletBrandMark({
  size = "md",
  href,
  ariaLabel = "Renewlet",
  interactive = Boolean(href),
  className,
  "aria-label": nonInteractiveLabel,
  ...props
}: RenewletBrandMarkProps) {
  const markClassName = cn(
    "inline-flex shrink-0 items-center justify-center bg-brand-mark text-brand-mark-foreground ring-1 ring-white/10",
    interactive &&
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    brandMarkFrameClasses[size],
    className,
  );
  const logo = <RenewletLogo className={brandMarkLogoClasses[size]} />;

  if (href) {
    return (
      <Link href={href} aria-label={ariaLabel} className={markClassName} {...props}>
        {logo}
      </Link>
    );
  }

  return (
    <span
      aria-hidden={nonInteractiveLabel ? undefined : true}
      aria-label={nonInteractiveLabel}
      className={markClassName}
      {...props}
    >
      {logo}
    </span>
  );
}

type RenewletBrandLockupProps = {
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  markSize?: RenewletBrandMarkSize | undefined;
  className?: string | undefined;
  markClassName?: string | undefined;
  textClassName?: string | undefined;
  titleClassName?: string | undefined;
  subtitleClassName?: string | undefined;
};

export function RenewletBrandLockup({
  title,
  subtitle,
  markSize = "md",
  className,
  markClassName,
  textClassName,
  titleClassName,
  subtitleClassName,
}: RenewletBrandLockupProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <RenewletBrandMark size={markSize} className={markClassName} />
      <div className={cn("min-w-0", textClassName)}>
        <h1 className={cn("truncate font-bold text-foreground", titleClassName)}>{title}</h1>
        {subtitle ? (
          <p className={cn("truncate text-xs text-muted-foreground", subtitleClassName)}>{subtitle}</p>
        ) : null}
      </div>
    </div>
  );
}
