"use client";

import { useState } from "react";
import {
  type BeneficiaryFamily,
  MAX_NAME_LENGTH,
  findBeneficiary,
  forFamily,
  labelOf,
  looksLikeAddress,
  shortAddress,
} from "../../lib/beneficiaries";
import { cn } from "../ui/cn";
import { Input } from "../ui/field";
import type { BeneficiaryBook } from "./use-beneficiaries";

/** How many recent recipients show as one-tap chips before the rest go behind "All". */
const CHIPS = 4;

/**
 * Recipients this browser has sent to before, under the address field.
 *
 * A tap only fills the field. The address then goes through the same checks as one typed in (shape,
 * the chain's unsafe recipients, the Solana token-account lookup), so a saved row can never skip
 * them. The current address can be saved with a name; sending to an address saves it unnamed, and
 * naming it later is one tap here.
 */
export function BeneficiaryPicker({
  book,
  family,
  address,
  disabled,
  onPick,
}: {
  book: BeneficiaryBook;
  family: BeneficiaryFamily;
  /** What is in the field now. */
  address: string;
  disabled: boolean;
  onPick: (address: string) => void;
}) {
  const rows = forFamily(book.list, family);
  const typed = address.trim();
  const current = looksLikeAddress(family, typed)
    ? findBeneficiary(book.list, family, typed)
    : undefined;
  const canSave = looksLikeAddress(family, typed) && !current?.name;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [managing, setManaging] = useState(false);

  if (rows.length === 0 && !canSave) return null;

  const shown = managing ? rows : rows.slice(0, CHIPS);
  const link = "underline underline-offset-4 transition-colors hover:text-bone disabled:opacity-40";

  return (
    <div className="mt-3 px-1 text-[0.8125rem] text-bone/45">
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="text-eyebrow font-medium uppercase text-bone/35">Saved</span>
          {shown.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(b.address)}
              title={b.address}
              aria-pressed={current?.id === b.id}
              className={cn(
                "max-w-[11rem] truncate rounded-tray px-3 py-1.5 ring-1 ring-inset transition-[background-color,box-shadow,transform] duration-300 ease-haptic",
                "active:scale-[0.98] disabled:opacity-40",
                current?.id === b.id
                  ? "bg-bone/[0.09] text-bone ring-bone/25"
                  : "bg-bone/[0.03] text-bone/70 ring-bone/[0.08] hover:bg-bone/[0.06] hover:text-bone hover:ring-bone/20",
                b.name ? "" : "font-mono text-xs",
              )}
            >
              {labelOf(b)}
            </button>
          ))}
          {rows.length > CHIPS || managing ? (
            <button
              type="button"
              onClick={() => setManaging((m) => !m)}
              aria-expanded={managing}
              className={link}
            >
              {managing ? "Done" : `All ${rows.length}`}
            </button>
          ) : (
            <button type="button" onClick={() => setManaging(true)} className={link}>
              Edit
            </button>
          )}
        </div>
      )}

      {managing && (
        <ul className="mt-3 divide-y divide-bone/[0.06] rounded-tray ring-1 ring-inset ring-bone/[0.07]">
          {rows.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label={`Name for ${shortAddress(b.address)}`}
                  value={b.name}
                  maxLength={MAX_NAME_LENGTH}
                  placeholder="Add a name"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => book.rename(b.id, e.target.value)}
                  className="h-9 px-3 text-sm"
                />
                <p className="mt-1.5 truncate font-mono text-[0.6875rem] text-bone/35">
                  {b.address}
                </p>
              </div>
              <button
                type="button"
                onClick={() => book.remove(b.id)}
                aria-label={`Remove ${labelOf(b)}`}
                className="shrink-0 text-bone/45 underline underline-offset-4 transition-colors hover:text-alarm"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {canSave && (
        <div className={cn(rows.length > 0 && "mt-3")}>
          {naming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                book.remember(family, typed, name);
                setNaming(false);
                setName("");
              }}
            >
              <Input
                aria-label="Name for this recipient"
                autoFocus
                value={name}
                maxLength={MAX_NAME_LENGTH}
                placeholder="Name, e.g. Ada's Base wallet"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                className="h-10 flex-1 px-3 text-sm"
              />
              <button
                type="submit"
                disabled={name.trim() === ""}
                className="rounded-tray bg-bone px-4 py-2.5 text-sm font-medium text-obsidian transition-[background-color,transform] duration-300 ease-haptic hover:bg-white active:scale-[0.98] disabled:bg-bone/15 disabled:text-bone/40"
              >
                Save
              </button>
              <button type="button" onClick={() => setNaming(false)} className={link}>
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setNaming(true)}
              className={link}
            >
              {current ? "Name this recipient" : "Save this recipient"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
