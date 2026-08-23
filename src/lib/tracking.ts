// Thin typed wrapper around window.nileTrack, set up by the inline tracking
// loader in BaseLayout.astro. Keeps the `any` cast in one place. Every call is
// a no-op if no tracking IDs are configured or the visitor opted out — the
// loader installs no-op stubs before it checks consent, so callers never need
// to guard. See /cookies for what each tag does with this.

/**
 * A completed waitlist signup — the conversion Google Ads bids toward.
 *
 * Passing `email` enables enhanced conversions: gtag hashes it with SHA-256
 * in the browser, so the raw address is never transmitted. Without it Google
 * can only match signups it can still tie to a cookie, which on a lead form
 * loses most of them. Omit it and everything still works, just less
 * accurately.
 */
export function trackWaitlistSignup(segment: string, email?: string): void {
  (window as any).nileTrack?.signup(segment, email);
}

/**
 * A softer intent signal — a CTA click, a download-page click. NOT a
 * conversion: these never reach the Google Ads conversion action. They feed
 * GA4 so remarketing audiences have something to build on, and so per-page
 * interest is readable long before signup volume is.
 */
export function trackEvent(
  name: string,
  params?: Record<string, unknown>,
): void {
  (window as any).nileTrack?.event(name, params);
}
