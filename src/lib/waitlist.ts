// Waitlist destination: Klaviyo via client-side subscribe API.
// Public key is safe to expose in the browser — it's not a secret.
// Set PUBLIC_KLAVIYO_KEY in .env (Astro exposes PUBLIC_* to client bundles).
// Set PUBLIC_KLAVIYO_LIST_ID to the Klaviyo list ID for waitlist signups.

export type WaitlistSegment = "host" | "viewer" | "advertiser";

export interface WaitlistEntry {
  email: string;
  segment?: WaitlistSegment;
}

export async function submitWaitlist(entry: WaitlistEntry): Promise<void> {
  const companyId = import.meta.env.PUBLIC_KLAVIYO_KEY;
  const listId = import.meta.env.PUBLIC_KLAVIYO_LIST_ID;

  if (!companyId) {
    if (import.meta.env.DEV) {
      console.info("[waitlist] No PUBLIC_KLAVIYO_KEY set — skipping (dev mode)", entry);
    }
    await new Promise((r) => setTimeout(r, 300));
    return;
  }

  const body: Record<string, unknown> = {
    data: {
      type: "subscription",
      attributes: {
        profile: {
          data: {
            type: "profile",
            attributes: {
              email: entry.email,
              properties: {
                waitlist_segment: entry.segment ?? "unknown",
              },
            },
          },
        },
        ...(listId ? { list: { data: { type: "list", id: listId } } } : {}),
      },
    },
  };

  const res = await fetch(
    `https://a.klaviyo.com/client/subscriptions/?company_id=${companyId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        revision: "2023-12-15",
      },
      body: JSON.stringify(body),
    },
  );

  // 202 = accepted (async processing); anything else is an error
  if (!res.ok && res.status !== 202) {
    throw new Error(`Klaviyo error: ${res.status}`);
  }
}
