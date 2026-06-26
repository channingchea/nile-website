// ⏳ OPEN DECISION: waitlist destination (Supabase table vs. Klaviyo).
// This is the single swap point. The form component never changes — only
// the body of submitWaitlist below. Until decided, it no-ops + logs.

export type WaitlistSegment = "host" | "viewer" | "advertiser";

export interface WaitlistEntry {
  email: string;
  segment?: WaitlistSegment;
}

export async function submitWaitlist(entry: WaitlistEntry): Promise<void> {
  // --- PLACEHOLDER ---
  // Supabase option: POST to a `waitlist-signup` edge function.
  // Klaviyo option:  POST to Klaviyo's client subscribe endpoint.
  // Replace this block once the destination is locked.
  if (import.meta.env.DEV) {
    console.info("[waitlist placeholder]", entry);
  }
  await new Promise((r) => setTimeout(r, 400)); // simulate latency
}
