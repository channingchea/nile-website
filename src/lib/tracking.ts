// Thin typed wrapper around window.nileTrack, set up by the inline tracking
// loader in BaseLayout.astro. Keeps the `any` cast in one place. A no-op if
// no tracking IDs are configured or the visitor opted out (see /cookies).
export function trackWaitlistSignup(segment: string): void {
  (window as any).nileTrack?.signup(segment);
}
