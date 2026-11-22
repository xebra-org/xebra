/**
 * Base error thrown across `@xebra/sdk`: carries a stable machine-readable `code`,
 * whether retrying the operation can help (`retryable`), and the original `cause`.
 */
export class XebraError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, opts?: { retryable?: boolean; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "XebraError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
  }
}
