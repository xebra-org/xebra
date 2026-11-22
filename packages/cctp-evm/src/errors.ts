/**
 * Why an encoder refused its arguments, as a stable code a caller can branch on.
 *
 *   - `invalid_amount` — the amount, fee or wrapper fee is zero, negative or inconsistent;
 *   - `invalid_recipient` — the recipient, owner, token account or hook is not usable;
 *   - `invalid_request` — some other argument is not something Circle accepts.
 */
export type CctpEvmErrorCode = "invalid_amount" | "invalid_recipient" | "invalid_request";

/**
 * An encoder in this package refused its argument.
 *
 * Same shape as `XebraError` in `@xebra/sdk`, but declared here: the SDK bundles this package
 * (`noExternal`), so importing the SDK back would make the two packages circular. A caller can
 * still branch on `code`.
 */
export class CctpEvmError extends Error {
  readonly code: CctpEvmErrorCode;
  readonly retryable: boolean;

  constructor(code: CctpEvmErrorCode, message: string) {
    super(message);
    this.name = "CctpEvmError";
    this.code = code;
    this.retryable = false;
  }
}
