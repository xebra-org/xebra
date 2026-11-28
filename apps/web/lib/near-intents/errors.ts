/**
 * A problem with what the person entered (or a check Xebra could not finish), whose message is a
 * sentence written for them. The API routes show it as is; any other error is hidden behind a
 * fixed sentence, since its message may carry internals.
 */
export class PlanInputError extends Error {
  constructor(
    message: string,
    /** 400 for a bad input; 503 when a check could not be finished and a retry may pass. */
    readonly status: 400 | 503 = 400,
  ) {
    super(message);
    this.name = "PlanInputError";
  }
}
