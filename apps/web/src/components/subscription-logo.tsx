import { useEffect, useState, type CSSProperties } from "react";
import { AuthorizedImage } from "@/components/authorized-image";
import { cn } from "@/lib/utils";

const DEFAULT_FALLBACK_COLOR = "hsl(var(--primary))";

type SubscriptionLogoStyle = CSSProperties & {
  "--subscription-logo-fallback": string;
};

interface SubscriptionLogoProps {
  name: string;
  logo?: string | null | undefined;
  fallbackColor?: string | undefined;
  size?: "xs" | "sm" | "md" | undefined;
  className?: string | undefined;
}

const sizeClassNames = {
  xs: {
    tile: "h-6 w-6 rounded-md border text-[10px]",
    image: "p-0.5",
  },
  sm: {
    tile: "h-10 w-10 rounded-lg border text-sm",
    image: "p-1",
  },
  md: {
    tile: "h-12 w-12 rounded-lg border text-lg",
    image: "p-1",
  },
} satisfies Record<NonNullable<SubscriptionLogoProps["size"]>, { tile: string; image: string }>;

export function SubscriptionLogo({
  name,
  logo,
  fallbackColor = DEFAULT_FALLBACK_COLOR,
  size = "md",
  className,
}: SubscriptionLogoProps) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const classes = sizeClassNames[size];

  useEffect(() => {
    // 真实订阅 Logo 可能在私有资产、外链和导入暂存预览之间切换；错误态必须跟随 URL 隔离。
    setLogoLoadFailed(false);
  }, [logo]);

  const style: SubscriptionLogoStyle = {
    "--subscription-logo-fallback": fallbackColor,
  };

  return (
    <span
      className={cn(
        "subscription-logo-tile flex shrink-0 items-center justify-center overflow-hidden font-bold",
        classes.tile,
        className,
      )}
      style={style}
    >
      {logo && !logoLoadFailed ? (
        <AuthorizedImage
          src={logo}
          alt={name}
          className={cn("subscription-logo-image h-full w-full object-contain", classes.image)}
          onError={() => setLogoLoadFailed(true)}
        />
      ) : (
        <span className="subscription-logo-fallback">{name.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}
