"use client";

import type React from "react";
import { createContext, useContext } from "react";
import { cn } from "./cn";

// ---------------------------------------------------------------------------
// Field → Input context
//
// Lets `Input` automatically pick up `aria-invalid` and `aria-describedby`
// from an enclosing `Field` without manual wiring at each call site.
// When `Input` is rendered outside a `Field` (e.g. beneficiary-picker) the
// context is `null` and the input behaves exactly as before.
// ---------------------------------------------------------------------------

interface FieldContextValue {
  /** ID of the currently-rendered error element, if any. */
  errorId: string | undefined;
  /** ID of the currently-rendered hint element, if any. */
  hintId: string | undefined;
  /** Whether the field is in an invalid state. */
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * A labelled control.
 *
 * The label, the control and whatever the control has to say about itself are one unit, so
 * they are one component: every field on the bridge screen wires `htmlFor`, `aria-invalid`
 * and `aria-describedby` identically, and doing that by hand at each call site is how one of
 * them eventually ships without the description attached.
 *
 * A field shows a hint *or* an error, never both — stacking them makes the user read the
 * advice they already failed to follow before reaching the thing that is actually wrong.
 */
export function Field({
  id,
  label,
  hint,
  error,
  trailing,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | null | undefined;
  /** Small right-aligned content on the label line — a unit, a balance, a quick action. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const hasError = Boolean(error);
  const hasHint = !hasError && Boolean(hint);

  const errorId = hasError ? `${id}-error` : undefined;
  const hintId = hasHint ? `${id}-hint` : undefined;

  return (
    <FieldContext.Provider value={{ errorId, hintId, invalid: hasError }}>
      <div className={className}>
        <div className="mb-2.5 flex items-baseline justify-between gap-4">
          <label htmlFor={id} className="text-eyebrow font-medium uppercase text-bone/40">
            {label}
          </label>
          {trailing}
        </div>
        {children}
        {hasError ? (
          <p
            id={errorId}
            role="alert"
            className="mt-2.5 flex items-start gap-1.5 text-[0.8125rem] text-alarm"
          >
            {error}
          </p>
        ) : (
          hint && (
            <p id={hintId} className="mt-2.5 text-xs leading-relaxed text-bone/35">
              {hint}
            </p>
          )
        )}
      </div>
    </FieldContext.Provider>
  );
}

/**
 * The input well. Recessed rather than raised: an editable surface should look like
 * something you can put a value *into*, which means an inner shadow at the top edge and a
 * fill darker than the plate it sits on — the inverse of the lighting on a button.
 *
 * When rendered inside a `Field`, the input automatically inherits `aria-invalid` and
 * `aria-describedby` from the field context.  Explicit props always win, so call sites
 * that already pass their own ARIA attributes (EVM, Stellar) continue to work unchanged.
 */
export function Input({
  invalid,
  className,
  "aria-invalid": ariaInvalidProp,
  "aria-describedby": ariaDescribedByProp,
  ...rest
}: { invalid?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  const ctx = useContext(FieldContext);

  // --- aria-invalid ---
  // Explicit prop > `invalid` visual prop > context.
  const resolvedInvalid =
    ariaInvalidProp !== undefined
      ? ariaInvalidProp
      : invalid !== undefined
        ? invalid || undefined // `false` → `undefined` so the attribute is omitted
        : ctx?.invalid || undefined;

  // --- aria-describedby ---
  // Merge context IDs with any caller-supplied value, deduplicating.
  const contextIds = [ctx?.errorId, ctx?.hintId].filter(Boolean) as string[];
  const callerIds = ariaDescribedByProp ? ariaDescribedByProp.split(/\s+/).filter(Boolean) : [];
  const mergedIds = [...new Set([...contextIds, ...callerIds])];
  const resolvedDescribedBy = mergedIds.length > 0 ? mergedIds.join(" ") : undefined;

  return (
    <input
      aria-invalid={resolvedInvalid}
      aria-describedby={resolvedDescribedBy}
      className={cn(
        "w-full rounded-tray bg-obsidian-sunken/80 px-4 text-bone",
        "shadow-[inset_0_1px_3px_0_hsl(228_40%_2%/0.9)]",
        "ring-1 ring-inset transition-[box-shadow,background-color] duration-400 ease-haptic",
        "placeholder:text-bone/25",
        invalid
          ? "ring-alarm/40 hover:ring-alarm/55"
          : "ring-bone/[0.07] hover:ring-bone/[0.16] focus:ring-bone/25",
        className,
      )}
      {...rest}
    />
  );
}
