import { useEffect, useRef, useState } from "react";

export const MAX_CONFIG_RETRIES = 5;

export interface SourceConfigLoaderOptions<T> {
  url: string;
  remembered: { tx: string } | null;
  parse: (json: unknown) => T | null;
  onSelect?: (() => void) | undefined;
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

export interface SourceConfigLoaderState<T> {
  config: T | null;
  error: boolean;
  remembered: { tx: string } | null;
  attempts: number;
}

export class SourceConfigLoader<T> {
  private live = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private delay: number;
  private maxRetries: number;
  private maxDelayMs: number;
  private fetchFn: typeof fetch;

  public state: SourceConfigLoaderState<T>;
  private listeners = new Set<() => void>();

  constructor(private options: SourceConfigLoaderOptions<T>) {
    this.delay = options.initialDelayMs ?? 1000;
    this.maxRetries = options.maxRetries ?? MAX_CONFIG_RETRIES;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.fetchFn = options.fetchFn ?? (typeof fetch !== "undefined" ? fetch : (undefined as never));

    this.state = {
      config: null,
      error: false,
      remembered: options.remembered,
      attempts: 0,
    };
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public start() {
    this.live = true;
    void this.load();
  }

  public stop() {
    this.live = false;
    if (this.timer) clearTimeout(this.timer);
  }

  public async load() {
    if (!this.live) return;
    try {
      const r = await this.fetchFn(this.options.url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (!this.live) return;
      const parsed = this.options.parse(json);
      if (parsed) {
        this.state = {
          ...this.state,
          config: parsed,
          error: false,
        };
        this.notify();
        this.options.onSelect?.();
      } else {
        this.state = {
          ...this.state,
          config: null,
          error: false,
        };
        this.notify();
      }
    } catch {
      if (!this.live) return;
      this.attempts += 1;
      this.state = {
        ...this.state,
        attempts: this.attempts,
        error: this.options.remembered !== null,
      };
      if (this.options.remembered) {
        this.options.onSelect?.();
      }
      this.notify();

      if (this.attempts < this.maxRetries) {
        this.timer = setTimeout(() => void this.load(), this.delay);
        this.delay = Math.min(this.delay * 2, this.maxDelayMs);
      }
    }
  }
}

export function useSourceConfig<T>({
  url,
  remembered,
  parse,
  onSelect,
  maxRetries,
  initialDelayMs,
  maxDelayMs,
  fetchFn,
}: SourceConfigLoaderOptions<T>): SourceConfigLoaderState<T> {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const [state, setState] = useState<SourceConfigLoaderState<T>>({
    config: null,
    error: false,
    remembered,
    attempts: 0,
  });

  useEffect(() => {
    const loader = new SourceConfigLoader({
      url,
      remembered,
      parse,
      maxRetries,
      initialDelayMs,
      maxDelayMs,
      fetchFn,
      onSelect: () => onSelectRef.current?.(),
    });
    const unsubscribe = loader.subscribe(() => {
      setState(loader.state);
    });
    loader.start();
    return () => {
      unsubscribe();
      loader.stop();
    };
  }, [url, remembered, parse, maxRetries, initialDelayMs, maxDelayMs, fetchFn]);

  return state;
}
