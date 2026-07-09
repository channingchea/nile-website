// Browser Supabase client for the advertiser portal (ads.joinnile.com).
// PUBLIC_* vars are exposed to the client bundle by Astro. The anon key is
// public-safe (RLS + the create-ad-payment function enforce access); never put
// the service-role key here.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ =
  import.meta.env.PUBLIC_SUPABASE_URL ?? "https://jelmkkvyrliywcdkzhuu.supabase.co";
const ANON = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? "";

export const CREATE_AD_PAYMENT_URL =
  import.meta.env.PUBLIC_CREATE_AD_PAYMENT_URL ??
  "https://jelmkkvyrliywcdkzhuu.functions.supabase.co/create-ad-payment";

export const REVIEW_AD_CAMPAIGN_URL =
  import.meta.env.PUBLIC_REVIEW_AD_CAMPAIGN_URL ??
  "https://jelmkkvyrliywcdkzhuu.functions.supabase.co/review-ad-campaign";

export const MODERATE_REPORT_URL =
  import.meta.env.PUBLIC_MODERATE_REPORT_URL ??
  "https://jelmkkvyrliywcdkzhuu.functions.supabase.co/moderate-report";

let _client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (_client) return _client;
  _client = createClient(URL_, ANON);
  return _client;
}
