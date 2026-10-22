"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Beneficiary,
  type BeneficiaryFamily,
  STORAGE_KEY,
  readBeneficiaries,
  remember,
  remove,
  rename,
  writeBeneficiaries,
} from "../../lib/beneficiaries";

/**
 * The saved recipients of this browser (`lib/beneficiaries.ts`).
 *
 * Empty on the server and on the first client render, then filled from storage, so the markup the
 * server sent is the markup the client first builds. Another tab's changes arrive through the
 * `storage` event. Each change is written straight back; a browser that refuses the write keeps the
 * list for this visit only.
 */
export function useBeneficiaries() {
  const [list, setList] = useState<Beneficiary[]>([]);
  // The latest list, so two changes in the same tick build on each other instead of the render.
  const latest = useRef<Beneficiary[]>([]);

  const set = useCallback((next: Beneficiary[]) => {
    latest.current = next;
    setList(next);
  }, []);

  useEffect(() => {
    set(readBeneficiaries());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) set(readBeneficiaries());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [set]);

  const apply = useCallback(
    (change: (current: Beneficiary[]) => Beneficiary[]) => {
      const next = change(latest.current);
      set(next);
      writeBeneficiaries(next);
    },
    [set],
  );

  return {
    list,
    /** Note a recipient that was just used (a transfer to them was signed), or save one by name. */
    remember: useCallback(
      (family: BeneficiaryFamily, address: string, name?: string) =>
        apply((cur) =>
          remember(cur, {
            family,
            address,
            now: Date.now(),
            ...(name === undefined ? {} : { name }),
          }),
        ),
      [apply],
    ),
    rename: useCallback(
      (id: string, name: string) => apply((cur) => rename(cur, id, name)),
      [apply],
    ),
    remove: useCallback((id: string) => apply((cur) => remove(cur, id)), [apply]),
  };
}

export type BeneficiaryBook = ReturnType<typeof useBeneficiaries>;
