import type React from "react";
import { cn } from "./cn";
import { Alert, Check, Info } from "./icons";

type Tone = "info" | "signal" | "alarm";

const TONES: Record<Tone, { shell: string; icon: string; title: string }> = {
  info: { shell: "ring-bone/10 bg-bone/[0.035]", icon: "text-bone/50", title: "text-bone/85" },
  signal: { shell: "ring-signal/20 bg-signal/[0.05]", icon: "text-signal", title: "text-signal" },
  alarm: { shell: "ring-alarm/25 bg-alarm/[0.06]", icon: "text-alarm", title: "text-alarm" },
};

const ICONS: Record<Tone, (props: { className?: string }) => React.ReactElement> = {
  info: Info,
  signal: Check,
  alarm: Alert,
};

/**
 * An inline message with a status. Used for the submitted receipt, word about the recipient
 * or Circle's state, and every failure — one component, so a thrown error can never render as bare red text
 * hanging off the bottom of the plate.
 *
 * Failures carry `role="alert"`; the other tones do not, because announcing a static
 * explainer every time it renders is noise, not accessibility.
 */
export function Notice({
  tone = "info",
  title,
  children,
  className,
  live,
}: {
  tone?: Tone;
  title: string;
  children?: React.ReactNode;
  className?: string;
  live?: "polite" | "assertive";
}) {
  const styles = TONES[tone];
  const Icon = ICONS[tone];
  const role = tone === "alarm" ? "alert" : live ? "status" : undefined;
  const ariaLive = live ?? (tone === "alarm" ? "assertive" : undefined);
  return (
    <div
      role={role}
      aria-live={ariaLive}
      className={cn("rounded-tray px-4 py-4 ring-1 ring-inset", styles.shell, className)}
    >
      <div className="flex items-center gap-2.5">
        <Icon className={cn("h-4 w-4 shrink-0", styles.icon)} />
        <h3 className={cn("text-sm font-medium tracking-[-0.01em]", styles.title)}>{title}</h3>
      </div>
      {children && (
        <div className="mt-2 pl-[1.625rem] text-[0.8125rem] leading-relaxed text-bone/50">
          {children}
        </div>
      )}
    </div>
  );
}
