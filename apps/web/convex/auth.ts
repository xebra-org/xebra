/**
 * The shared secret between the web app and these functions.
 *
 * `apiKeys` and `rateLimit` are public because the Next.js server reaches them over HTTP. Unguarded,
 * anyone could mint themselves a key or spend another integrator's minute. The secret is
 * `XEBRA_API_SECRET`, set on this deployment and in the web app's server environment; it never
 * reaches a browser.
 */

export function requireSecret(secret: string): void {
  const expected = process.env.XEBRA_API_SECRET;
  // Refuse when unset rather than accepting everything: a missing variable must not open the door.
  if (!expected || !constantTimeEqual(secret, expected)) throw new Error("not authorised");
}

/**
 * Compares byte by byte without stopping at the first difference. The length is not hidden — the
 * secret's length is fixed at deployment and is not the secret.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
