<script setup lang="ts">
/*
  Self-serve advertiser portal (A-4 Part 2) — single Vue island served at
  ads.joinnile.com. One component with internal view state so the whole auth-
  gated flow is a client-side SPA on top of the static Astro site:

    auth   → email+password sign up / sign in (separate from the app's social login)
    setup  → brand name, contact email, optional Nile-profile link
    dash   → list campaigns + reporting (get_advertiser_performance RPC).
             CSV export (client-side Blob, no schema change) for both the
             campaign table and the daily chart; tapping a campaign name
             filters the chart to it via get_advertiser_daily's p_campaign_id
             (migration 0052) — hardening plan Part 3.
    build  → new campaign: image upload (manual 4:3 crop) → ad-creatives,
             creative form, topics, budget/duration → create-ad-payment
             (standalone) → Stripe Checkout. Also doubles as the EDIT form for
             campaigns still in pending_review (migration 0038 allows client
             UPDATE on ad_creatives/ad_targeting only in that status); edits
             save directly — budget/duration stay locked since the Stripe
             authorization already exists.
  This portal is advertiser-only. The seven staff queues that used to live here
  as isAdmin-gated view states — review, spot-check, reported content, appeals,
  bug reports, featured, admins — moved to joinnile.com/admin (AdminPortal.vue).
  What's left of `isAdmin` here is one link in the header, and a temporary
  redirect for the old ?view= bookmarks.

  After payment a standalone campaign lands in pending_review until an admin
  approves it (webhook flips pending_payment → pending_review).
*/
import { ref, onMounted, onUnmounted, computed } from "vue";
import { supabase, CREATE_AD_PAYMENT_URL, REVIEW_AD_CAMPAIGN_URL } from "../lib/supabase";

const HEADLINE_MAX = 60;
const BODY_MAX = 150;
const MAX_BYTES = 5 * 1024 * 1024;
const BUDGETS = [
  { cents: 1000, label: "$10" },
  { cents: 2500, label: "$25" },
  { cents: 5000, label: "$50" },
];
const DURATIONS = [
  { days: 3, label: "3 days" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
];

type Account = { id: string; name: string; contact_email: string; profile_id: string | null };
type Topic = { id: string; name: string };
type Row = {
  campaign_id: string; name: string; headline: string | null; status: string;
  budget_cents: number; spent_cents: number; impressions: number; clicks: number;
  // 0125. reach is distinct viewers, so frequency = impressions / reach tells
  // you whether a big impression count was breadth or repetition. The three
  // derived figures are null (not 0) until there is something to divide by —
  // "no clicks yet" and "$0.00 per click" are very different claims.
  reach: number; frequency: number | null;
  ecpm_cents: number | null; ecpc_cents: number | null;
  review_note: string | null; created_at: string;
  placement: string | null; event_title: string | null; event_scheduled_at: string | null;
  // Offer fields (sponsorships only). host_note is the host's own comment on a
  // decline — deliberately separate from review_note, which is Nile's policy
  // reviewer talking. Never show one under the other's label.
  host_note: string | null; offer_expires_at: string | null; last_decline_code: string | null;
  payment_recovery_url: string | null;
  // 0137. Sponsor logo shown on screen during the show (host's choice) — a
  // free bonus, never billed, and excluded from impressions/clicks/reach.
  in_show_impressions: number;
};
// Sponsorable event (get_sponsorable_events). Pricing is per-event now: the
// host's floor, the platform ceiling, and how many offers this advertiser has
// already spent on the event.
type SponsEvent = {
  event_id: string; title: string; cover_image_url: string | null;
  scheduled_at: string; host_username: string | null; host_name: string | null;
  host_avatar_url: string | null; is_ticketed: boolean;
  min_offer_cents: number; max_offer_cents: number;
  offer_cap: number; my_offer_count: number;
};
type PriceSuggestion = {
  suggested_cents: number; low_cents: number; high_cents: number; basis: string;
};
type DailyPoint = { day: string; impressions: number; clicks: number; reach: number };
// get_advertiser_placement_summary (0125). A campaign has exactly one
// placement, so this is a breakdown across campaigns — the answer to "which
// surface is actually working for us".
type PlacementRow = {
  placement: string; campaigns: number; impressions: number; clicks: number;
  reach: number; spent_cents: number; ecpm_cents: number | null;
};

const PAGE = 15; // keyset page size (mirrors the app's Paged<T> convention)

const sb = supabase();

const view = ref<"loading" | "auth" | "setup" | "dash" | "build" | "receipts">("loading");
// Old bookmarks into the staff queues, which now live at joinnile.com/admin.
// Temporary shim — drop it, and the ?view= branch in boot(), once the links
// have aged out.
const ADMIN_VIEW_REDIRECTS: Record<string, string> = {
  review: "/admin/review",
  spotcheck: "/admin/spot-check",
  reports: "/admin/reports",
  appeals: "/admin/appeals",
  feedback: "/admin/bug-reports",
  featured: "/admin/featured",
  admins: "/admin/admins",
};
const msg = ref("");
const busy = ref(false);
const account = ref<Account | null>(null);
// Only decides whether the header shows a link across to /admin. Every staff
// power moved with the queues; nothing on this page is gated on it any more.
const isAdmin = ref(false);

// auth
const mode = ref<"signin" | "signup">("signin");
const email = ref("");
const password = ref("");

// setup
const brandName = ref("");
const contactEmail = ref("");
const profileUsername = ref("");

// dashboard
const rows = ref<Row[]>([]);
const dashCursor = ref<string | null>(null);
const dashHasMore = ref(false);
const loadingMore = ref(false);
const daily = ref<DailyPoint[]>([]);
const dailyCampaignId = ref<string | null>(null); // null = all campaigns
const placements = ref<PlacementRow[]>([]);
const exportingCampaigns = ref(false);

// builder (create + edit-while-in-review)
const topics = ref<Topic[]>([]);
const selectedTopics = ref<Set<string>>(new Set());
const file = ref<File | null>(null);
const previewUrl = ref("");
const headline = ref("");
const body = ref("");
const clickUrl = ref("");
const budgetCents = ref(2500);
const durationDays = ref(7);
const editingId = ref<string | null>(null); // pending_review campaign being edited
const existingImageUrl = ref(""); // current creative image when editing

// Product being built (0079): a feed image ad, a Currents video ad, or an
// event sponsorship (Pre-Show lobby). Sponsorships pick their own creative
// format (image or video) via adKind; feed/currents imply it.
const product = ref<"feed" | "currents" | "sponsor">("feed");
function setProduct(p: "feed" | "currents" | "sponsor") {
  product.value = p;
  if (p === "feed") adKind.value = "image";
  else if (p === "currents") adKind.value = "video";
  else if (!sponsEvents.value.length) { loadSponsConfig(); loadSponsEvents(); }
}

// Event sponsorship picker state (get_sponsorable_events).
const sponsEvents = ref<SponsEvent[]>([]);
const sponsSearch = ref("");
const sponsLoading = ref(false);
const selectedEvent = ref<SponsEvent | null>(null);
let sponsSearchTimer: ReturnType<typeof setTimeout> | undefined;
async function loadSponsEvents() {
  sponsLoading.value = true;
  const { data, error } = await sb.rpc("get_sponsorable_events", {
    search: sponsSearch.value.trim() || null,
    page_limit: 20,
  });
  if (error) msg.value = error.message;
  sponsEvents.value = (data as SponsEvent[]) ?? [];
  sponsLoading.value = false;
}
function onSponsSearch() {
  clearTimeout(sponsSearchTimer);
  sponsSearchTimer = setTimeout(loadSponsEvents, 300);
}

// ── offer amount (Phase 5) ──────────────────────────────────────────────────
// The advertiser names the price now. Two config values shape the copy under
// the field: the host's revenue share, and the CPM the suggestion was built
// from — without the latter we can't state a CPM without inventing one.
const sponsConfig = ref<{ hostShare: number; targetCpmCents: number } | null>(null);
const offerDollars = ref("");
const suggestion = ref<PriceSuggestion | null>(null);
const suggestLoading = ref(false);

async function loadSponsConfig() {
  if (sponsConfig.value) return;
  const { data } = await sb.from("app_config")
    .select("sponsorship_host_share, sponsorship_target_cpm_cents").eq("id", 1).maybeSingle();
  const c = data as { sponsorship_host_share: number; sponsorship_target_cpm_cents: number } | null;
  if (c) sponsConfig.value = { hostShare: c.sponsorship_host_share, targetCpmCents: c.sponsorship_target_cpm_cents };
}

// Picking an event is what triggers the price suggestion — one RPC per pick,
// and the field is pre-filled from it so the common case is a single tap.
async function selectEvent(ev: SponsEvent) {
  if (selectedEvent.value?.event_id === ev.event_id) {
    selectedEvent.value = null;
    suggestion.value = null;
    return;
  }
  selectedEvent.value = ev;
  suggestion.value = null;
  offerDollars.value = dollarsFor(ev.min_offer_cents);
  suggestLoading.value = true;
  const { data } = await sb.rpc("suggest_sponsorship_price", { p_event_id: ev.event_id });
  const s = ((data as PriceSuggestion[] | null) ?? [])[0] ?? null;
  // Guard against a slow response landing after the advertiser moved on.
  if (selectedEvent.value?.event_id !== ev.event_id) return;
  suggestion.value = s;
  if (s) offerDollars.value = dollarsFor(s.suggested_cents);
  suggestLoading.value = false;
}

const dollarsFor = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
const offerCents = computed(() => {
  const n = Number(offerDollars.value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
});
const offerError = computed(() => {
  const ev = selectedEvent.value;
  if (!ev) return "";
  const c = offerCents.value;
  if (!offerDollars.value.trim() || !Number.isFinite(c) || c <= 0) return "Enter an amount.";
  if (c < ev.min_offer_cents) return `This host's minimum is ${moneyShort(ev.min_offer_cents)}.`;
  if (c > ev.max_offer_cents) return `Offers are capped at ${moneyShort(ev.max_offer_cents)}.`;
  return "";
});
const hostShareCents = computed(() => {
  const cfg = sponsConfig.value, c = offerCents.value;
  if (!cfg || !Number.isFinite(c) || c <= 0) return null;
  return Math.round(c * cfg.hostShare);
});
const hostSharePct = computed(() =>
  sponsConfig.value ? Math.round(sponsConfig.value.hostShare * 100) : 0);
// The suggestion is target CPM × estimated reach, so the reach it implies can
// be divided back out to price any amount as a CPM. That inversion only holds
// while the suggestion sits strictly inside the floor/cap — once it's clamped
// the arithmetic no longer describes an audience, so we say nothing instead.
const offerCpmCents = computed(() => {
  const s = suggestion.value, ev = selectedEvent.value, cfg = sponsConfig.value, c = offerCents.value;
  if (!s || !ev || !cfg || !s.suggested_cents) return null;
  if (s.suggested_cents <= ev.min_offer_cents || s.suggested_cents >= ev.max_offer_cents) return null;
  if (!Number.isFinite(c) || c <= 0) return null;
  return Math.round((c * cfg.targetCpmCents) / s.suggested_cents);
});
// `basis` arrives ready to read ("4 past events" / "estimated from follower
// count"), so it goes on screen untouched — only the connector varies.
const basisPhrase = computed(() => {
  const b = suggestion.value?.basis ?? "";
  return b.startsWith("estimated") ? b : `based on ${b}`;
});
// Offers die 48h before showtime, so that's the date the advertiser can hold
// us to for an answer.
const offerExpiresAt = computed(() =>
  selectedEvent.value
    ? new Date(new Date(selectedEvent.value.scheduled_at).getTime() - 48 * 3600_000)
    : null);

// Currents video ads (0068): a campaign whose creative is a ≤60s vertical video
// served between Currents in the app. Same checkout/review; separate bucket.
const adKind = ref<"image" | "video">("image");
const videoFile = ref<File | null>(null);
const videoPreviewUrl = ref("");
const videoDurationMs = ref(0);
const existingVideoUrl = ref(""); // current creative video when editing
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const VIDEO_MAX_MS = 60_000;

// Optional square sponsor logo (0137, sponsorships only): the host can put it
// on screen during the show. Stored as a bucket-relative path in ad-creatives.
const logoFile = ref<File | null>(null);
const logoPreviewUrl = ref("");
const logoPath = ref<string | null>(null); // existing logo when editing
const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const logoSrc = computed(() =>
  logoPreviewUrl.value ||
  (logoPath.value ? sb.storage.from("ad-creatives").getPublicUrl(logoPath.value).data.publicUrl : ""));
function onLogoFile(e: Event) {
  msg.value = "";
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = ""; // allow re-picking the same file
  if (!f) return;
  if (!LOGO_TYPES[f.type]) { msg.value = "Logo must be a PNG, JPG or WebP."; return; }
  if (f.size > 1024 * 1024) { msg.value = "Logo must be under 1MB."; return; }
  const url = URL.createObjectURL(f);
  const probe = new Image();
  probe.onload = () => {
    const { naturalWidth: w, naturalHeight: h } = probe;
    if (Math.min(w, h) < 200) { URL.revokeObjectURL(url); msg.value = "Logo must be at least 200×200 px."; return; }
    if (Math.abs(w - h) / Math.max(w, h) > 0.02) {
      URL.revokeObjectURL(url);
      msg.value = `Logo must be square — this one is ${w}×${h} px.`;
      return;
    }
    removeLogo();
    logoFile.value = f;
    logoPreviewUrl.value = url;
  };
  probe.onerror = () => { URL.revokeObjectURL(url); msg.value = "Couldn't read that logo. Try another file."; };
  probe.src = url;
}
function removeLogo() {
  if (logoPreviewUrl.value) URL.revokeObjectURL(logoPreviewUrl.value);
  logoPreviewUrl.value = "";
  logoFile.value = null;
  logoPath.value = null;
}
// Same account-folder convention as the creative; the DB CHECK + trigger
// require `${account_id}/<name>.<png|jpg|jpeg|webp>`.
async function uploadLogo(): Promise<string> {
  const f = logoFile.value!;
  const path = `${account.value!.id}/logo-${crypto.randomUUID()}.${LOGO_TYPES[f.type]}`;
  const { error } = await sb.storage
    .from("ad-creatives")
    .upload(path, f, { contentType: f.type, upsert: false });
  if (error) throw error;
  return path;
}

// cropper — pan/zoom the picked image inside a fixed 4:3 frame, export 1200×900
const cropSrc = ref("");
const cropZoom = ref(1);
const cropPos = ref({ x: 0, y: 0 });
const cropFrame = ref<HTMLElement | null>(null);
const cropImgEl = ref<HTMLImageElement | null>(null);
const nat = ref({ w: 0, h: 0 });
const frameW = ref(0);
let drag: { x: number; y: number; px: number; py: number } | null = null;
let cropName = "creative.jpg";

const cropScale = computed(() =>
  frameW.value && nat.value.w
    ? Math.max(frameW.value / nat.value.w, (frameW.value * 0.75) / nat.value.h) * cropZoom.value
    : 1,
);
const cropStyle = computed(() => ({
  width: `${nat.value.w * cropScale.value}px`,
  transform: `translate(${cropPos.value.x}px, ${cropPos.value.y}px)`,
}));

function clampPos(x: number, y: number) {
  const s = cropScale.value, w = frameW.value, h = w * 0.75;
  return {
    x: Math.min(0, Math.max(w - nat.value.w * s, x)),
    y: Math.min(0, Math.max(h - nat.value.h * s, y)),
  };
}
function onCropImgLoad() {
  const img = cropImgEl.value!;
  nat.value = { w: img.naturalWidth, h: img.naturalHeight };
  frameW.value = cropFrame.value!.clientWidth;
  cropZoom.value = 1;
  cropPos.value = clampPos(
    (frameW.value - nat.value.w * cropScale.value) / 2,
    (frameW.value * 0.75 - nat.value.h * cropScale.value) / 2,
  );
}
function onZoom(e: Event) {
  // Re-clamp while keeping the frame centre fixed.
  const w = frameW.value, h = w * 0.75, sOld = cropScale.value;
  const cx = (w / 2 - cropPos.value.x) / sOld;
  const cy = (h / 2 - cropPos.value.y) / sOld;
  cropZoom.value = Number((e.target as HTMLInputElement).value);
  const s = cropScale.value;
  cropPos.value = clampPos(w / 2 - cx * s, h / 2 - cy * s);
}
function cropDown(e: PointerEvent) {
  drag = { x: e.clientX, y: e.clientY, px: cropPos.value.x, py: cropPos.value.y };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function cropMove(e: PointerEvent) {
  if (drag) cropPos.value = clampPos(drag.px + e.clientX - drag.x, drag.py + e.clientY - drag.y);
}
function cropUp() { drag = null; }
function cancelCrop() {
  URL.revokeObjectURL(cropSrc.value);
  cropSrc.value = "";
}
async function applyCrop() {
  const s = cropScale.value;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 900;
  canvas.getContext("2d")!.drawImage(
    cropImgEl.value!,
    -cropPos.value.x / s, -cropPos.value.y / s, frameW.value / s, (frameW.value * 0.75) / s,
    0, 0, 1200, 900,
  );
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) { msg.value = "Couldn't crop that image. Try another file."; return; }
  file.value = new File([blob], cropName, { type: "image/jpeg" });
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = URL.createObjectURL(file.value);
  cancelCrop();
}

// Stripe Checkout return (review finding #11): show a success banner and
// poll the campaign row until the webhook flips it out of pending_payment,
// so the dashboard doesn't show a stale "Awaiting payment" status.
const returnBanner = ref(false);
// Lobby checkout saves a card instead of taking payment, so the banner can't
// talk about money until the poll tells us which product came back.
const returnIsOffer = ref<boolean | null>(null);
let returnCampaignId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const returnBannerText = computed(() =>
  returnIsOffer.value === null
    ? "Thanks — we're confirming your submission."
    : returnIsOffer.value
      ? "Offer sent. Nile checks the creative against our policies, then the host decides. You're not charged unless they accept."
      : "Payment received. Your ad is now in review. You'll see it as Active here once approved.");

onMounted(boot);
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

async function boot() {
  const params = new URLSearchParams(window.location.search);
  // Staff bookmark: hand it straight to the admin portal, which runs its own
  // sign-in and access checks. replace() so Back doesn't bounce them here.
  const moved = ADMIN_VIEW_REDIRECTS[params.get("view") ?? ""];
  if (moved) { window.location.replace(moved); return; }
  if (params.get("campaign_id") && params.get("session_id")) {
    returnCampaignId = params.get("campaign_id");
    returnBanner.value = true;
    // Clean the params so a reload doesn't re-trigger the banner.
    window.history.replaceState({}, "", window.location.pathname);
  }
  const { data } = await sb.auth.getSession();
  if (!data.session) { view.value = "auth"; return; }
  await afterAuth();
}

function startCheckoutPoll() {
  if (!returnCampaignId || pollTimer) return;
  const id = returnCampaignId;
  let tries = 0;
  const tick = async () => {
    tries += 1;
    const { data } = await sb
      .from("ad_campaigns").select("status, placement").eq("id", id).maybeSingle();
    const row = data as { status?: string; placement?: string } | null;
    const status = row?.status;
    if (row) returnIsOffer.value = row.placement === "lobby";
    const settled = !!status && status !== "pending_payment";
    if (settled || tries >= 15) { // ~30s max
      clearInterval(pollTimer!);
      pollTimer = null;
      returnCampaignId = null;
      if (settled) await openDashboard(); // re-pull rows with the new status
    }
  };
  pollTimer = setInterval(tick, 2000);
  tick(); // the banner's wording depends on this, so don't wait 2s for it
}

async function afterAuth() {
  // Own-row RLS on `admins` means this returns a row only for admins. All it
  // buys here is the "Nile admin →" link in the header.
  const { data: adminRow } = await sb.from("admins").select("user_id").maybeSingle();
  isAdmin.value = !!adminRow;

  const acc = await loadAccount();
  if (!acc) {
    contactEmail.value = (await sb.auth.getUser()).data.user?.email ?? "";
    view.value = "setup";
    return;
  }
  await openDashboard();
}

async function loadAccount(): Promise<Account | null> {
  const { data } = await sb
    .from("advertiser_accounts")
    .select("id, name, contact_email, profile_id")
    .maybeSingle();
  account.value = (data as Account) ?? null;
  return account.value;
}

// ── auth ──────────────────────────────────────────────────────────────────
function toggleMode() {
  mode.value = mode.value === "signin" ? "signup" : "signin";
  msg.value = "";
}
async function submitAuth() {
  msg.value = "";
  busy.value = true;
  try {
    const creds = { email: email.value, password: password.value };
    const { error } =
      mode.value === "signin"
        ? await sb.auth.signInWithPassword(creds)
        : await sb.auth.signUp(creds);
    if (error) throw error;
    const { data } = await sb.auth.getSession();
    if (!data.session) {
      msg.value = "Check your email to confirm your account, then sign in.";
      mode.value = "signin";
      return;
    }
    view.value = "loading";
    await afterAuth();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    busy.value = false;
  }
}

// ── setup ─────────────────────────────────────────────────────────────────
async function submitAccount() {
  msg.value = "";
  busy.value = true;
  try {
    let profileId: string | null = null;
    const uname = profileUsername.value.trim().replace(/^@/, "");
    if (uname) {
      const { data } = await sb.from("profiles").select("id").eq("username", uname).maybeSingle();
      if (!data) throw new Error(`No Nile profile @${uname}. Leave blank to skip.`);
      profileId = data.id;
    }
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb
      .from("advertiser_accounts")
      .insert({
        auth_user_id: user!.id,
        name: brandName.value.trim(),
        contact_email: contactEmail.value.trim(),
        profile_id: profileId,
      })
      .select("id, name, contact_email, profile_id")
      .single();
    if (error) throw error;
    account.value = data as Account;
    await openDashboard();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    busy.value = false;
  }
}

// ── dashboard ───────────────────────────────────────────────────────────────
async function openDashboard() {
  msg.value = "";
  view.value = "loading";
  dailyCampaignId.value = null;
  const acct = account.value!.id;
  const [{ data, error }, { data: dly }, { data: plc }] = await Promise.all([
    sb.rpc("get_advertiser_performance", { p_account_id: acct, p_limit: PAGE }),
    sb.rpc("get_advertiser_daily", { p_account_id: acct }),
    sb.rpc("get_advertiser_placement_summary", { p_account_id: acct }),
  ]);
  placements.value = (plc as PlacementRow[]) ?? [];
  if (error) msg.value = error.message;
  const page = (data as Row[]) ?? [];
  rows.value = page;
  dashCursor.value = page.length ? page[page.length - 1].created_at : null;
  dashHasMore.value = page.length === PAGE;
  daily.value = (dly as DailyPoint[]) ?? [];
  view.value = "dash";
  startCheckoutPoll();
}
// Per-campaign daily filter (Part 3): tapping a campaign row re-fetches the
// chart scoped to it via the new p_campaign_id param (migration 0052);
// passing null resets to "all campaigns".
async function filterDaily(campaignId: string | null) {
  msg.value = "";
  dailyCampaignId.value = campaignId;
  const { data, error } = await sb.rpc("get_advertiser_daily", {
    p_account_id: account.value!.id,
    ...(campaignId ? { p_campaign_id: campaignId } : {}),
  });
  if (error) { msg.value = error.message; return; }
  daily.value = (data as DailyPoint[]) ?? [];
}
const dailyLabel = computed(() => {
  if (!dailyCampaignId.value) return "";
  const r = rows.value.find((x) => x.campaign_id === dailyCampaignId.value);
  return r ? (r.headline || r.name) : "this campaign";
});
async function loadMoreDash() {
  if (loadingMore.value || !dashHasMore.value) return;
  loadingMore.value = true;
  const { data, error } = await sb.rpc("get_advertiser_performance", {
    p_account_id: account.value!.id, p_limit: PAGE, p_before: dashCursor.value,
  });
  if (error) msg.value = error.message;
  const page = (data as Row[]) ?? [];
  rows.value = [...rows.value, ...page];
  dashCursor.value = page.length ? page[page.length - 1].created_at : dashCursor.value;
  dashHasMore.value = page.length === PAGE;
  loadingMore.value = false;
}

// Daily impressions/clicks chart (inline SVG, no chart dependency).
const CHART_W = 640, CHART_H = 120, CHART_PAD = 4;
const chart = computed(() => {
  const pts = daily.value;
  if (pts.length < 2) return null;
  const max = Math.max(1, ...pts.map((p) => Math.max(p.impressions, p.clicks)));
  const x = (i: number) =>
    CHART_PAD + (i / (pts.length - 1)) * (CHART_W - 2 * CHART_PAD);
  const y = (v: number) =>
    CHART_H - CHART_PAD - (v / max) * (CHART_H - 2 * CHART_PAD);
  const line = (key: "impressions" | "clicks") =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  return {
    impr: line("impressions"), clk: line("clicks"), max,
    first: pts[0].day, last: pts[pts.length - 1].day,
    totalImpr: pts.reduce((s, p) => s + p.impressions, 0),
    totalClk: pts.reduce((s, p) => s + p.clicks, 0),
  };
});
const shortDate = (s: string) =>
  new Date(s + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });

// ── CSV export (Part 3) — client-side only, no schema change ────────────────
function downloadCsv(filename: string, table: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = table.map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
// Pages get_advertiser_performance to exhaustion (capped ~500 rows — nobody is
// near this) rather than exporting just the currently-loaded window.
async function exportCampaignsCsv() {
  msg.value = "";
  exportingCampaigns.value = true;
  try {
    const CAP = 500, FETCH = 100;
    const acct = account.value!.id;
    let all: Row[] = [];
    let cursor: string | null = null;
    while (all.length < CAP) {
      const { data, error } = await sb.rpc("get_advertiser_performance", {
        p_account_id: acct, p_limit: FETCH, p_before: cursor,
      });
      if (error) throw error;
      const page = (data as Row[]) ?? [];
      all = all.concat(page);
      if (page.length < FETCH) break; // exhausted
      cursor = page[page.length - 1].created_at;
    }
    all = all.slice(0, CAP);
    const header = [
      "Campaign", "Status", "Budget", "Spent", "Impressions", "In-show logo impressions", "Reach",
      "Frequency", "Clicks", "CTR", "eCPM", "eCPC", "Created",
    ];
    const body = all.map((r) => [
      r.headline || r.name, sponsorStatusLabel(r), money(r.budget_cents), money(r.spent_cents),
      r.impressions, r.placement === "lobby" ? (r.in_show_impressions ?? 0) : "", r.reach, freq(r), r.clicks, ctr(r),
      dashIfNull(r.ecpm_cents), dashIfNull(r.ecpc_cents),
      new Date(r.created_at).toLocaleDateString(),
    ]);
    downloadCsv(`nile-ads-campaigns.csv`, [header, ...body]);
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    exportingCampaigns.value = false;
  }
}
// Exports whatever the chart is currently showing (all campaigns, or the
// filtered one from filterDaily) — no extra fetch needed.
function exportDailyCsv() {
  if (!daily.value.length) return;
  const header = ["Date", "Impressions", "Reach", "Clicks"];
  const body = daily.value.map((p) => [p.day, p.impressions, p.reach, p.clicks]);
  downloadCsv(dailyCampaignId.value ? "nile-ads-daily-campaign.csv" : "nile-ads-daily.csv", [header, ...body]);
}
// Withdraw (hard-delete) an in-review or rejected ad. Server-side: the
// review-ad-campaign fn cancels the card hold (in-review only), then deletes
// the campaign + creative image.
const deletingId = ref("");
const stoppingId = ref("");
async function deleteCampaign(r: Row) {
  // A lobby offer never took money — the card is only saved — so promising a
  // released hold would be wrong there.
  const holdNote = r.status !== "pending_review" ? ""
    : r.placement === "lobby" ? " Your card won't be charged."
    : " The card hold will be released.";
  if (!confirm(`Delete “${r.headline || r.name}”?${holdNote} This can't be undone.`)) return;
  msg.value = "";
  deletingId.value = r.campaign_id;
  try {
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(REVIEW_AD_CAMPAIGN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sess.session?.access_token}`,
      },
      body: JSON.stringify({ campaign_id: r.campaign_id, action: "withdraw" }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Delete failed");
    await openDashboard();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    deletingId.value = "";
  }
}
// Stop a campaign that is already running. Withdraw only ever covered ads that
// never went live and pause/resume are admin-only, so until now a brand that
// needed its ad down had to email us and wait. The undelivered budget comes
// back automatically — spend follows delivered days, so there is a real number
// to return rather than a negotiation.
async function stopCampaign(r: Row) {
  const undelivered = Math.max((r.budget_cents ?? 0) - (r.spent_cents ?? 0), 0);
  const refundNote = undelivered > 0
    ? ` ${money(undelivered)} of undelivered budget will be refunded to your card.`
    : " This campaign has already delivered its full budget, so there's nothing to refund.";
  if (!confirm(`Stop “${r.headline || r.name}” now?${refundNote} This can't be undone.`)) return;
  msg.value = "";
  stoppingId.value = r.campaign_id;
  try {
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(REVIEW_AD_CAMPAIGN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sess.session?.access_token}`,
      },
      body: JSON.stringify({ campaign_id: r.campaign_id, action: "stop" }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Couldn't stop this campaign");
    msg.value = out.refunded_cents > 0
      ? `Campaign stopped. ${money(out.refunded_cents)} is on its way back to your card.`
      : "Campaign stopped.";
    await openDashboard();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    stoppingId.value = "";
  }
}

// ── receipts (review #25) ───────────────────────────────────────────────────
// There was no billing history anywhere in this portal: no invoice, no record
// of a refund, no way for a brand to answer "what did we actually spend".
type Receipt = {
  campaign_id: string; name: string; placement: string | null; status: string;
  event_title: string | null; charged_at: string;
  budget_cents: number; spent_cents: number;
  refunded_cents: number; net_cents: number;
  stopped_at: string | null; payment_intent: string | null;
  starts_at: string; ends_at: string;
};
const receipts = ref<Receipt[]>([]);
const receiptsLoading = ref(false);

async function openReceipts() {
  view.value = "receipts";
  receiptsLoading.value = true;
  try {
    const { data, error } = await sb.rpc("get_advertiser_receipts", {
      p_account_id: account.value!.id,
    });
    if (error) throw error;
    receipts.value = (data ?? []) as Receipt[];
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    receiptsLoading.value = false;
  }
}

function receiptsCsv() {
  const head = "Campaign,Placement,Status,Charged,Budget,Delivered,Refunded,Net,Payment\n";
  const rows = receipts.value.map((x) => [
    `"${(x.name ?? "").replace(/"/g, '""')}"`,
    x.placement ?? "feed",
    x.stopped_at ? "stopped" : x.status,
    fmtDate(x.charged_at),
    (x.budget_cents / 100).toFixed(2),
    (x.spent_cents / 100).toFixed(2),
    (x.refunded_cents / 100).toFixed(2),
    (x.net_cents / 100).toFixed(2),
    x.payment_intent ?? "",
  ].join(","));
  const blob = new Blob([head + rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "nile-ad-receipts.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function signOut() {
  await sb.auth.signOut();
  account.value = null;
  view.value = "auth";
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
// Whole dollars where they're whole — pricing copy reads better as "$45" than
// "$45.00", and every offer amount the advertiser types is a round number.
const moneyShort = (c: number) => (c % 100 === 0 ? `$${c / 100}` : money(c));
const ctr = (r: Row) => (r.impressions ? ((r.clicks / r.impressions) * 100).toFixed(1) : "0.0") + "%";
// An em dash, not "$0.00" — a campaign with no clicks has no cost per click,
// and printing zero reads as "free clicks" on the one screen where an
// advertiser is deciding whether to spend again.
const dashIfNull = (c: number | null) => (c == null ? "—" : money(c));
const freq = (r: { frequency: number | null }) => (r.frequency == null ? "—" : `${r.frequency}×`);
const PLACEMENT_LABELS: Record<string, string> = {
  feed: "In feed", currents: "Currents", lobby: "Event sponsorship",
};
const placementLabel = (p: string) => PLACEMENT_LABELS[p] ?? p;
// Sponsorship statuses describe an offer, not a purchase: nothing here should
// imply money moved before the host accepted.
function statusLabel(s: string, placement?: string | null) {
  if (placement === "lobby" && s === "pending_review") return "Awaiting review";
  return ({
    pending_payment: "Awaiting payment",
    pending_review: "In review",
    pending_host: "Awaiting host",
    payment_pending: "Payment pending",
    active: "Active",
    paused: "Paused",
    rejected: "Rejected",
    declined: "Declined",
    expired: "Expired",
    completed: "Completed",
  } as Record<string, string>)[s] ?? s;
}
// An accepted offer is "Accepted" to the advertiser whether it's still to run
// (active) or already ran (completed) — "Active"/"Completed" is ad-flight
// language that doesn't map onto a one-night sponsorship.
function sponsorStatusLabel(r: Row) {
  if (r.placement !== "lobby") return statusLabel(r.status);
  if (r.status === "active" || r.status === "completed") return "Accepted";
  return statusLabel(r.status, r.placement);
}
function statusClass(s: string) {
  if (s === "active") return "ok";
  if (s === "rejected" || s === "declined") return "err";
  if (s === "pending_review" || s === "pending_payment" || s === "pending_host" || s === "payment_pending") return "warn";
  return "muted";
}

// ── sponsorship offers on the dashboard ─────────────────────────────────────
// How long the host has left before the offer expires on its own. Deliberately
// coarse: an exact ticking clock implies a precision the sweep job doesn't have.
function offerCountdown(iso: string | null) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "Expiring now";
  const hours = Math.round(ms / 3600_000);
  if (hours < 1) return "Expires within the hour";
  if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Expires ${fmtDateTime(iso)}`;
}
// Re-offering means starting a fresh campaign against the same event: the
// picker is the only place that knows the remaining offer allowance, so route
// through it rather than trusting a count the dashboard doesn't have.
async function makeAnotherOffer(r: Row) {
  msg.value = "";
  const { data } = await sb.from("ad_campaigns")
    .select("event_id").eq("id", r.campaign_id).maybeSingle();
  const eventId = (data as { event_id?: string } | null)?.event_id;
  await openBuilder();
  product.value = "sponsor";
  sponsSearch.value = r.event_title ?? "";
  await Promise.all([loadSponsConfig(), loadSponsEvents()]);
  const ev = sponsEvents.value.find((e) => e.event_id === eventId);
  if (!ev) {
    msg.value = "That event is no longer open to sponsorship.";
    return;
  }
  if (ev.my_offer_count >= ev.offer_cap) {
    msg.value = `You've used all ${ev.offer_cap} of your offers for ${ev.title}.`;
    return;
  }
  await selectEvent(ev);
}

// ── shared date formatting ──────────────────────────────────────────────────
const fmtDate = (s: string) => new Date(s).toLocaleDateString();
const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ── builder ─────────────────────────────────────────────────────────────────
function resetBuilder() {
  editingId.value = null;
  existingImageUrl.value = "";
  file.value = null;
  previewUrl.value = "";
  headline.value = "";
  body.value = "";
  clickUrl.value = "";
  selectedTopics.value = new Set();
  budgetCents.value = 2500;
  durationDays.value = 7;
  cropSrc.value = "";
  adKind.value = "image";
  product.value = "feed";
  selectedEvent.value = null;
  sponsSearch.value = "";
  offerDollars.value = "";
  suggestion.value = null;
  videoFile.value = null;
  if (videoPreviewUrl.value) URL.revokeObjectURL(videoPreviewUrl.value);
  videoPreviewUrl.value = "";
  videoDurationMs.value = 0;
  existingVideoUrl.value = "";
  removeLogo();
}
async function loadTopics() {
  const { data } = await sb.from("topics").select("id, name").eq("is_active", true).order("sort_order");
  topics.value = (data as Topic[]) ?? [];
}
async function openBuilder() {
  msg.value = "";
  view.value = "loading";
  resetBuilder();
  await loadTopics();
  view.value = "build";
}
// Edit a campaign that's still pending_review: prefill the builder from the
// existing creative + targeting; saving updates those rows in place.
async function openEdit(r: Row) {
  msg.value = "";
  view.value = "loading";
  resetBuilder();
  // Single nested select instead of separate creative + targeting fetches.
  const [, { data: camp }] = await Promise.all([
    loadTopics(),
    sb.from("ad_campaigns")
      .select("ad_creatives(image_url, headline, body, click_url, kind, video_path, logo_path), ad_targeting(topic_ids)")
      .eq("id", r.campaign_id).maybeSingle(),
  ]);
  const cr = (camp as any)?.ad_creatives?.[0];
  const tg = (camp as any)?.ad_targeting?.[0];
  if (!cr) { msg.value = "Couldn't load this ad."; view.value = "dash"; return; }
  headline.value = cr.headline ?? "";
  body.value = cr.body ?? "";
  clickUrl.value = cr.click_url ?? "";
  existingImageUrl.value = cr.image_url ?? "";
  adKind.value = cr.kind === "video" ? "video" : "image";
  product.value = r.placement === "lobby" ? "sponsor" : (cr.kind === "video" ? "currents" : "feed");
  existingVideoUrl.value = cr.video_path
    ? sb.storage.from("ad-videos").getPublicUrl(cr.video_path).data.publicUrl
    : "";
  logoPath.value = cr.logo_path ?? null;
  selectedTopics.value = new Set((tg?.topic_ids as string[]) ?? []);
  editingId.value = r.campaign_id;
  view.value = "build";
}
function toggleTopic(id: string) {
  const s = new Set(selectedTopics.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selectedTopics.value = s;
}
function onFile(e: Event) {
  msg.value = "";
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = ""; // allow re-picking the same file
  if (!f) return;
  if (f.size > MAX_BYTES) { msg.value = "Image must be under 5MB."; return; }
  cropName = f.name.replace(/\.[^.]+$/, "") + ".jpg";
  cropSrc.value = URL.createObjectURL(f);
}
// Upload under the account folder so the bucket RLS insert policy
// (path segment = owned account id) passes.
async function uploadCreative(): Promise<string> {
  const path = `${account.value!.id}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage
    .from("ad-creatives")
    .upload(path, file.value!, { contentType: file.value!.type, upsert: false });
  if (error) throw error;
  return sb.storage.from("ad-creatives").getPublicUrl(path).data.publicUrl;
}

// ── Currents video creative (0068) ────────────────────────────────────────────

function onVideoFile(e: Event) {
  msg.value = "";
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = ""; // allow re-picking the same file
  if (!f) return;
  if (f.size > MAX_VIDEO_BYTES) { msg.value = "Video must be under 100MB."; return; }
  if (!["video/mp4", "video/quicktime"].includes(f.type)) {
    msg.value = "Use an MP4 or MOV video."; return;
  }
  // Probe duration client-side (the fn re-validates server-side).
  const url = URL.createObjectURL(f);
  const probe = document.createElement("video");
  probe.preload = "metadata";
  probe.onloadedmetadata = () => {
    const ms = Math.round(probe.duration * 1000);
    if (!ms || ms > VIDEO_MAX_MS + 500) {
      URL.revokeObjectURL(url);
      msg.value = "Video must be 60 seconds or shorter.";
      return;
    }
    videoDurationMs.value = Math.min(ms, VIDEO_MAX_MS);
    videoFile.value = f;
    if (videoPreviewUrl.value) URL.revokeObjectURL(videoPreviewUrl.value);
    videoPreviewUrl.value = url;
  };
  probe.onerror = () => {
    URL.revokeObjectURL(url);
    msg.value = "Couldn't read that video. Use MP4 or MOV.";
  };
  probe.src = url;
}

// First-frame poster for the in-app placeholder while the ad video buffers.
function captureVideoThumb(src: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.src = src;
    v.onloadeddata = () => { v.currentTime = 0.1; };
    v.onseeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext("2d")!.drawImage(v, 0, 0);
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
    };
    v.onerror = () => resolve(null);
  });
}

// Upload video (+ best-effort poster) to ad-videos under the account folder,
// mirroring the ad-creatives RLS convention.
async function uploadAdVideo(): Promise<{ videoUrl: string; thumbUrl: string | null }> {
  const f = videoFile.value!;
  const ext = f.type === "video/quicktime" ? "mov" : "mp4";
  const base = `${account.value!.id}/${crypto.randomUUID()}`;
  const { error } = await sb.storage
    .from("ad-videos")
    .upload(`${base}.${ext}`, f, { contentType: f.type, upsert: false });
  if (error) throw error;
  const videoUrl = sb.storage.from("ad-videos").getPublicUrl(`${base}.${ext}`).data.publicUrl;
  let thumbUrl: string | null = null;
  try {
    const blob = await captureVideoThumb(videoPreviewUrl.value);
    if (blob) {
      const { error: tErr } = await sb.storage
        .from("ad-videos")
        .upload(`${base}.jpg`, blob, { contentType: "image/jpeg", upsert: false });
      if (!tErr) thumbUrl = sb.storage.from("ad-videos").getPublicUrl(`${base}.jpg`).data.publicUrl;
    }
  } catch { /* poster is cosmetic — never block checkout on it */ }
  return { videoUrl, thumbUrl };
}
async function submitCampaign() {
  msg.value = "";
  const isVideo = adKind.value === "video";
  const isSponsor = product.value === "sponsor";
  if (isSponsor && !editingId.value && !selectedEvent.value) { msg.value = "Pick an event to sponsor."; return; }
  if (isSponsor && !editingId.value && offerError.value) { msg.value = offerError.value; return; }
  if (!isVideo && cropSrc.value) { msg.value = "Finish cropping the image first."; return; }
  if (!isVideo && !file.value && !editingId.value) { msg.value = "Add a creative image."; return; }
  if (isVideo && !videoFile.value && !editingId.value) { msg.value = "Add a creative video."; return; }
  if (!isVideo && !body.value.trim()) { msg.value = "Add a body text."; return; }
  try { const u = new URL(clickUrl.value); if (u.protocol !== "https:") throw 0; }
  catch { msg.value = "Click URL must start with https://"; return; }

  busy.value = true;
  try {
    // EDIT: update creative + targeting in place (RLS allows this only while
    // the campaign is pending_review). No payment change — budget is locked.
    // Video campaigns edit text/targeting only; replacing the video means
    // withdrawing and resubmitting (keeps the review artifact immutable).
    if (editingId.value) {
      const update: Record<string, string | null> = {
        headline: headline.value.trim(),
        body: isVideo ? (body.value.trim() || null) : body.value.trim(),
        click_url: clickUrl.value.trim(),
      };
      if (!isVideo) {
        update.image_url = file.value ? await uploadCreative() : existingImageUrl.value;
      }
      if (isSponsor) update.logo_path = logoFile.value ? await uploadLogo() : logoPath.value;
      const { error: crErr } = await sb.from("ad_creatives")
        .update(update)
        .eq("campaign_id", editingId.value);
      if (crErr) throw crErr;
      if (!isSponsor) { // sponsorships target one event, not topics
        const { error: tgErr } = await sb.from("ad_targeting")
          .upsert({ campaign_id: editingId.value, topic_ids: [...selectedTopics.value] });
        if (tgErr) throw tgErr;
      }
      busy.value = false;
      await openDashboard();
      return;
    }

    // CREATE:
    // 1) Upload the creative asset (image → ad-creatives, video → ad-videos).
    // Sponsorship: placement "lobby" + the chosen event + the offer amount.
    // The floor, cap, 72h lead time and offer cap are all re-checked server
    // side — this validation is only here to save a round trip.
    const payload: Record<string, unknown> = isSponsor
      ? {
          advertiser_account_id: account.value!.id,
          placement: "lobby",
          event_id: selectedEvent.value!.event_id,
          amount_cents: offerCents.value,
          headline: headline.value.trim(),
          body: body.value.trim(),
          click_url: clickUrl.value.trim(),
        }
      : {
          advertiser_account_id: account.value!.id,
          headline: headline.value.trim(),
          body: body.value.trim(),
          click_url: clickUrl.value.trim(),
          topic_ids: [...selectedTopics.value],
          budget_cents: budgetCents.value,
          duration_days: durationDays.value,
        };
    if (isVideo) {
      const { videoUrl, thumbUrl } = await uploadAdVideo();
      payload.creative_kind = "video";
      payload.video_url = videoUrl;
      payload.thumb_url = thumbUrl;
      payload.duration_ms = videoDurationMs.value;
    } else {
      payload.image_url = await uploadCreative();
    }
    if (isSponsor && logoFile.value) payload.logo_path = await uploadLogo();

    // 2) Function (service role) creates campaign+creative+targeting, returns Checkout URL.
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(CREATE_AD_PAYMENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sess.session?.access_token}`,
      },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok || !out.checkout_url) throw new Error(out.error || "Payment setup failed");
    window.location.href = out.checkout_url;
  } catch (e: any) {
    msg.value = String(e?.message || e);
    busy.value = false;
  }
}

// ── portal nav ──────────────────────────────────────────────────────────────
// One source of truth for the tab strip, rendered once above the view cards so
// every page shows the same set. Advertiser-only now — the staff tabs moved to
// /admin, which the header link points at.
type Tab = { key: string; label: string; count?: number; go: () => void };

const portalTabs = computed<Tab[]>(() =>
  account.value
    ? [
        { key: "dash", label: "My dashboard", go: openDashboard },
        { key: "receipts", label: "Billing", go: openReceipts },
      ]
    : []);

// `setup` is in the list so a staff member with no brand account yet still gets
// the strip, and with it the only link across to /admin.
const TABBED_VIEWS = ["dash", "build", "receipts", "setup"];
const showTabs = computed(() =>
  TABBED_VIEWS.includes(view.value) && (portalTabs.value.length > 0 || isAdmin.value));
// The builder is a sub-page of the dashboard, so it keeps that tab lit.
const activeTab = computed(() => (view.value === "build" ? "dash" : view.value));
</script>

<template>
  <div class="ap">
    <div v-if="msg" class="ap-msg ap-err">
      <span>{{ msg }}</span>
      <button v-if="view === 'dash'" type="button" class="ap-retry" @click="openDashboard">Retry</button>
    </div>
    <div v-if="returnBanner" class="ap-msg ap-ok">{{ returnBannerText }}</div>

    <!-- Folder tabs: one strip for the whole portal, same links on every page -->
    <nav v-if="showTabs" class="ap-tabs" :class="{ 'ap-tabs--narrow': view === 'build' || view === 'setup' }" aria-label="Portal sections">
      <button
        v-for="t in portalTabs" :key="t.key" type="button" class="ap-tab"
        :class="{ 'is-active': activeTab === t.key }"
        :aria-current="activeTab === t.key ? 'page' : undefined"
        @click="t.go()"
      >
        {{ t.label }}<span v-if="t.count" class="ap-tab-count">{{ t.count }}</span>
      </button>
      <span class="ap-tabs-gap"></span>
      <!-- The only entry point into the staff portal; /admin is noindex and
           linked from nowhere else. -->
      <a v-if="isAdmin" class="ap-tab ap-tab--quiet" href="/admin">Admin →</a>
      <button type="button" class="ap-tab ap-tab--quiet" @click="signOut">Sign out</button>
    </nav>

    <div v-if="view === 'loading'" class="ap-center">Loading…</div>

    <!-- AUTH -->
    <form v-else-if="view === 'auth'" class="ap-card" autocomplete="on" @submit.prevent="submitAuth">
      <h2 class="ap-h">{{ mode === 'signin' ? 'Sign in' : 'Create an advertiser login' }}</h2>
      <input class="ap-input" v-model="email" type="email" placeholder="Email" required />
      <input class="ap-input" v-model="password" type="password" placeholder="Password" required minlength="8" />
      <button class="nile-btn nile-btn--primary ap-full" type="submit" :disabled="busy">
        {{ busy ? '…' : (mode === 'signin' ? 'Sign in' : 'Sign up') }}
      </button>
      <p class="ap-note">
        {{ mode === 'signin' ? 'New advertiser?' : 'Already have a login?' }}
        <button type="button" class="ap-link" @click="toggleMode">
          {{ mode === 'signin' ? 'Create one' : 'Sign in' }}
        </button>
      </p>
    </form>

    <!-- SETUP -->
    <form v-else-if="view === 'setup'" class="ap-card" @submit.prevent="submitAccount">
      <h2 class="ap-h">Set up your brand</h2>
      <label class="ap-label">Brand name</label>
      <input class="ap-input" v-model="brandName" placeholder="Acme Coffee Co." required />
      <label class="ap-label">Contact email</label>
      <input class="ap-input" v-model="contactEmail" type="email" placeholder="ads@acme.com" required />
      <label class="ap-label">Nile profile link (optional)</label>
      <input class="ap-input" v-model="profileUsername" placeholder="@yourbrand (leave blank to skip)" />
      <button class="nile-btn nile-btn--primary ap-full" type="submit" :disabled="busy">
        {{ busy ? 'Saving…' : 'Create account' }}
      </button>
      <p class="ap-note">You can link or claim a Nile profile later.</p>
    </form>

    <!-- DASHBOARD -->
    <div v-else-if="view === 'dash'" class="ap-card ap-wide">
      <div class="ap-top">
        <div>
          <h2 class="ap-h" style="margin:0">{{ account?.name || 'Your campaigns' }}</h2>
          <p class="ap-sub">{{ account?.contact_email }}</p>
        </div>
      </div>

      <div class="ap-new-row">
        <button class="nile-btn nile-btn--primary ap-new" @click="openBuilder">+ New campaign</button>
        <button class="ap-link" :disabled="exportingCampaigns || rows.length === 0" @click="exportCampaignsCsv">
          {{ exportingCampaigns ? 'Exporting…' : 'Export CSV' }}
        </button>
      </div>

      <!-- Activity over time (impressions vs clicks) -->
      <figure v-if="chart" class="ap-chart">
        <figcaption class="ap-chart-cap">
          <span class="ap-chart-legend"><i class="dot impr"></i>Impressions
            <b>{{ chart.totalImpr }}</b></span>
          <span class="ap-chart-legend"><i class="dot clk"></i>Clicks
            <b>{{ chart.totalClk }}</b></span>
          <span v-if="dailyCampaignId" class="ap-chart-filter">
            Showing: {{ dailyLabel }} · <button type="button" class="ap-link" @click="filterDaily(null)">All campaigns</button>
          </span>
          <button type="button" class="ap-link ap-chart-export" @click="exportDailyCsv">Export CSV</button>
        </figcaption>
        <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="ap-chart-svg" preserveAspectRatio="none" role="img"
             aria-label="Daily impressions and clicks">
          <path :d="chart.impr" class="ln impr" />
          <path :d="chart.clk" class="ln clk" />
        </svg>
        <figcaption class="ap-chart-axis">
          <span>{{ shortDate(chart.first) }}</span><span>{{ shortDate(chart.last) }}</span>
        </figcaption>
      </figure>

      <!-- Where the money went. A campaign carries one placement, so this is a
           breakdown across campaigns — the "which surface is working" view a
           renewal decision actually turns on. Hidden until there's more than
           one placement to compare, when the table would just repeat the
           campaign list. -->
      <section v-if="placements.length > 1" class="ap-placements">
        <h3>By placement <span class="ap-note-inline">last 30 days</span></h3>
        <table class="ap-tbl ap-tbl--cards">
          <thead>
            <tr><th>Placement</th><th>Campaigns</th><th>Impr.</th><th>Reach</th><th>Clicks</th><th>eCPM</th><th>Spent</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in placements" :key="p.placement">
              <td class="name" data-label="Placement">{{ placementLabel(p.placement) }}</td>
              <td data-label="Campaigns">{{ p.campaigns }}</td>
              <td data-label="Impr.">{{ p.impressions }}</td>
              <td data-label="Reach">{{ p.reach }}</td>
              <td data-label="Clicks">{{ p.clicks }}</td>
              <td data-label="eCPM">{{ dashIfNull(p.ecpm_cents) }}</td>
              <td data-label="Spent">{{ money(p.spent_cents) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p v-if="rows.length === 0" class="ap-center">
        No campaigns yet. Create your first to start reaching Nile audiences.
      </p>
      <template v-else>
        <table class="ap-tbl ap-tbl--cards">
          <thead>
            <tr>
              <th>Campaign</th><th>Status</th><th>Impr.</th>
              <th title="Distinct people reached, and how many times the average one saw it">Reach</th>
              <th>Clicks</th><th>CTR</th>
              <th title="Cost per thousand impressions, and cost per click">eCPM</th>
              <th>Spent</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.campaign_id" :class="{ 'ap-row-selected': dailyCampaignId === r.campaign_id }">
              <td
                class="name ap-clickable" data-label="Campaign" title="Filter the chart above to this campaign"
                @click="filterDaily(r.campaign_id)"
              >
                {{ r.headline || r.name }}
                <div v-if="r.placement === 'lobby'" class="ap-note-inline">
                  Sponsorship · {{ r.event_title || 'Event removed' }}{{ r.event_scheduled_at ? ' · ' + fmtDateTime(r.event_scheduled_at) : '' }}
                </div>
                <div v-if="r.status === 'rejected' && r.review_note" class="ap-note-inline">
                  Reviewer: {{ r.review_note }}
                </div>
                <!-- The host's comment is theirs, not Nile's — label it that
                     way so a decline never reads as a policy rejection. -->
                <div v-if="r.status === 'declined' && r.host_note" class="ap-note-inline">
                  Host's comment: “{{ r.host_note }}”
                </div>
                <div v-if="r.status === 'pending_host' && r.offer_expires_at" class="ap-note-inline">
                  With the host now · {{ offerCountdown(r.offer_expires_at) }}
                </div>
                <!-- The recovery session is written after the decline, so a row
                     can sit here for a moment with no URL yet. -->
                <div v-if="r.status === 'payment_pending'" class="ap-note-inline">
                  The host accepted, but your card needs confirming. You have
                  6 hours from the declined charge before the offer expires.
                  <template v-if="!r.payment_recovery_url">
                    Check your email for the confirmation link.
                  </template>
                </div>
                <a
                  v-if="r.status === 'payment_pending' && r.payment_recovery_url"
                  class="nile-btn nile-btn--primary ap-recover"
                  :href="r.payment_recovery_url" target="_blank" rel="noopener noreferrer"
                  @click.stop
                >Complete payment</a>
                <div v-if="r.status === 'expired'" class="ap-note-inline">
                  The host didn't respond before the offer expired. You weren't charged.
                </div>
              </td>
              <td data-label="Status"><span class="ap-badge" :class="statusClass(r.status)">{{ sponsorStatusLabel(r) }}</span></td>
              <td data-label="Impr.">
                {{ r.impressions }}
                <div
                  v-if="r.placement === 'lobby' && r.in_show_impressions > 0" class="ap-note-inline"
                  title="Your logo on screen during the show — a free bonus, never billed"
                >+{{ r.in_show_impressions }} in-show logo</div>
              </td>
              <td data-label="Reach">
                {{ r.reach }}
                <div class="ap-note-inline">{{ freq(r) }} each</div>
              </td>
              <td data-label="Clicks">{{ r.clicks }}</td>
              <td data-label="CTR">{{ ctr(r) }}</td>
              <td data-label="eCPM">
                {{ dashIfNull(r.ecpm_cents) }}
                <div class="ap-note-inline">{{ dashIfNull(r.ecpc_cents) }} / click</div>
              </td>
              <td data-label="Spent">{{ money(r.spent_cents) }} / {{ money(r.budget_cents) }}</td>
              <td class="ap-rowactions">
                <button
                  v-if="r.placement === 'lobby' && (r.status === 'declined' || r.status === 'expired')"
                  class="ap-link" @click="makeAnotherOffer(r)"
                >Make another offer</button>
                <button v-if="r.status === 'pending_review'" class="ap-link" @click="openEdit(r)">Edit</button>
                <button
                  v-if="r.status === 'pending_review' || r.status === 'rejected'"
                  class="ap-link ap-danger" :disabled="deletingId === r.campaign_id"
                  @click="deleteCampaign(r)"
                >{{ deletingId === r.campaign_id ? 'Deleting…' : 'Delete' }}</button>
                <!-- Live campaigns: the brand's own kill switch. Undelivered
                     budget comes back to the card automatically. -->
                <button
                  v-if="r.status === 'active' || r.status === 'paused'"
                  class="ap-link ap-danger" :disabled="stoppingId === r.campaign_id"
                  @click="stopCampaign(r)"
                >{{ stoppingId === r.campaign_id ? 'Stopping…' : 'Stop' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <button v-if="dashHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreDash">
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </template>
    </div>

    <!-- BILLING / RECEIPTS -->
    <div v-else-if="view === 'receipts'" class="ap-card">
      <div class="ap-top">
        <h2 class="ap-h" style="margin:0">Billing</h2>
        <button v-if="receipts.length" type="button" class="ap-link" @click="receiptsCsv">Export CSV</button>
      </div>
      <p class="ap-sub">
        Every campaign that took payment. “Delivered” is what the campaign has
        actually earned against its budget; anything left over when a campaign
        is stopped or pulled is refunded to the card that paid.
      </p>

      <div v-if="receiptsLoading" class="ap-center">Loading…</div>
      <p v-else-if="!receipts.length" class="ap-sub">Nothing has been charged yet.</p>
      <table v-else class="ap-tbl ap-tbl--cards">
        <thead>
          <tr>
            <th>Campaign</th><th>Charged</th><th>Budget</th>
            <th>Delivered</th><th>Refunded</th><th>Net</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="x in receipts" :key="x.campaign_id">
            <td class="name" data-label="Campaign">
              {{ x.name }}
              <span class="ap-badge" :class="statusClass(x.status)">
                {{ x.stopped_at ? 'Stopped' : statusLabel(x.status, x.placement) }}
              </span>
              <div v-if="x.event_title" class="ap-note-inline">{{ x.event_title }}</div>
            </td>
            <td data-label="Charged">{{ fmtDate(x.charged_at) }}</td>
            <td data-label="Budget">{{ money(x.budget_cents) }}</td>
            <td data-label="Delivered">{{ money(x.spent_cents) }}</td>
            <td data-label="Refunded">{{ x.refunded_cents ? money(x.refunded_cents) : '—' }}</td>
            <td data-label="Net">{{ money(x.net_cents) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- BUILDER -->
    <form v-else-if="view === 'build'" class="ap-card" @submit.prevent="submitCampaign">
      <div class="ap-top">
        <h2 class="ap-h" style="margin:0">{{ editingId ? 'Edit campaign' : 'New campaign' }}</h2>
        <button type="button" class="ap-link" @click="openDashboard">Cancel</button>
      </div>

      <template v-if="!editingId">
        <label class="ap-label">What are you buying?</label>
        <div class="ap-grid">
          <button type="button" class="ap-opt" :aria-selected="product === 'feed'" @click="setProduct('feed')">
            Feed ad · image card
          </button>
          <button type="button" class="ap-opt" :aria-selected="product === 'currents'" @click="setProduct('currents')">
            Currents ad · video (≤60s)
          </button>
          <button type="button" class="ap-opt" :aria-selected="product === 'sponsor'" @click="setProduct('sponsor')">
            Sponsor an event · Pre-Show
          </button>
        </div>
      </template>

      <!-- SPONSORSHIP: event picker + creative format (0079) -->
      <template v-if="product === 'sponsor' && !editingId">
        <label class="ap-label">Event to sponsor</label>
        <input
          class="ap-input" v-model="sponsSearch" type="search"
          placeholder="Search events or hosts…" @input="onSponsSearch"
        />
        <p v-if="sponsLoading" class="ap-center">Loading events…</p>
        <p v-else-if="sponsEvents.length === 0" class="ap-note" style="text-align:left">
          No sponsorable events right now. Events appear here when a host opens
          them to sponsorship, at least 72 hours before showtime.
        </p>
        <div v-else class="ap-spons-list">
          <button
            v-for="ev in sponsEvents" :key="ev.event_id" type="button" class="ap-spons-row"
            :aria-selected="selectedEvent?.event_id === ev.event_id"
            :disabled="ev.my_offer_count >= ev.offer_cap"
            @click="selectEvent(ev)"
          >
            <img v-if="ev.cover_image_url" :src="ev.cover_image_url" class="ap-spons-cover" alt="" />
            <div v-else class="ap-spons-cover ap-spons-cover--empty"></div>
            <span class="ap-spons-info">
              <b>{{ ev.title }}</b>
              <small>{{ ev.host_name || ev.host_username }} · {{ fmtDateTime(ev.scheduled_at) }}</small>
              <small>{{ ev.is_ticketed ? 'Ticketed event' : 'Free event' }} · Sponsorship from {{ moneyShort(ev.min_offer_cents) }}</small>
              <!-- Three offers per event, so the count is worth showing before
                   they spend one, not just when it runs out. -->
              <small v-if="ev.my_offer_count">
                You've made {{ ev.my_offer_count }} of {{ ev.offer_cap }} offers{{
                  ev.my_offer_count >= ev.offer_cap ? " — that's the limit for this event" : '' }}
              </small>
            </span>
          </button>
        </div>

        <!-- Amount step: the advertiser names the price, we show our working -->
        <template v-if="selectedEvent">
          <label class="ap-label" for="ap-offer">Your offer</label>
          <div class="ap-offer-field">
            <span class="ap-offer-prefix">$</span>
            <input
              id="ap-offer" class="ap-input" v-model="offerDollars"
              type="text" inputmode="decimal" placeholder="45"
            />
          </div>
          <p v-if="suggestLoading" class="ap-offer-line">Working out a suggested amount…</p>
          <template v-else-if="suggestion">
            <p class="ap-offer-line">
              Suggested {{ moneyShort(suggestion.suggested_cents) }} — {{ basisPhrase }}.
              <button type="button" class="ap-link" @click="offerDollars = dollarsFor(suggestion.suggested_cents)">Use it</button>
            </p>
            <p v-if="offerCpmCents" class="ap-offer-line">
              ≈{{ moneyShort(offerCpmCents) }} CPM at this host's typical audience
            </p>
            <p class="ap-offer-line">
              Offers on events like this usually land between
              {{ moneyShort(suggestion.low_cents) }} and {{ moneyShort(suggestion.high_cents) }} — you can offer anything from
              {{ moneyShort(selectedEvent.min_offer_cents) }} to {{ moneyShort(selectedEvent.max_offer_cents) }}.
            </p>
          </template>
          <p v-if="offerError" class="ap-offer-err">{{ offerError }}</p>
          <p v-else-if="hostShareCents" class="ap-offer-line">
            Host receives {{ money(hostShareCents) }} ({{ hostSharePct }}%)
          </p>
        </template>

        <label class="ap-label">Creative format</label>
        <div class="ap-grid">
          <button type="button" class="ap-opt" :aria-selected="adKind === 'image'" @click="adKind = 'image'">
            Image (4:3)
          </button>
          <button type="button" class="ap-opt" :aria-selected="adKind === 'video'" @click="adKind = 'video'">
            Video (≤60s)
          </button>
        </div>
      </template>

      <template v-if="adKind === 'image'">
        <label class="ap-label">
          Creative image (shown 4:3 in feed, max 5MB{{ editingId ? ', leave as-is to keep current' : '' }})
        </label>
        <input class="ap-input" type="file" accept="image/*" @change="onFile" />

        <!-- 4:3 cropper: drag to position, slide to zoom -->
        <div v-if="cropSrc" class="ap-crop">
          <div
            ref="cropFrame" class="ap-crop-frame"
            @pointerdown="cropDown" @pointermove="cropMove"
            @pointerup="cropUp" @pointercancel="cropUp"
          >
            <img ref="cropImgEl" :src="cropSrc" :style="cropStyle" draggable="false" alt="" @load="onCropImgLoad" />
          </div>
          <input class="ap-crop-zoom" type="range" min="1" max="3" step="0.01" :value="cropZoom" aria-label="Zoom" @input="onZoom" />
          <div class="ap-rbtns">
            <button type="button" class="nile-btn nile-btn--primary" @click="applyCrop">Apply crop</button>
            <button type="button" class="ap-link" @click="cancelCrop">Cancel</button>
          </div>
        </div>
        <img v-else-if="previewUrl || existingImageUrl" :src="previewUrl || existingImageUrl" class="ap-preview" alt="" />
      </template>

      <template v-else>
        <label class="ap-label">
          Creative video (vertical, up to 60 seconds, MP4 or MOV, max 100MB{{ editingId ? " — the video can't be changed while in review" : '' }})
        </label>
        <input v-if="!editingId" class="ap-input" type="file" accept="video/mp4,video/quicktime" @change="onVideoFile" />
        <video
          v-if="videoPreviewUrl || existingVideoUrl"
          :src="videoPreviewUrl || existingVideoUrl"
          class="ap-preview" controls muted playsinline
        ></video>
        <p v-if="videoDurationMs" class="ap-note" style="text-align:left">
          {{ (videoDurationMs / 1000).toFixed(1) }}s —
          {{ product === 'sponsor'
            ? 'loops muted in the Pre-Show lobby; viewers can tap to unmute.'
            : 'plays with sound between Currents; viewers can swipe past anytime.' }}
        </p>
      </template>

      <template v-if="product === 'sponsor'">
        <label class="ap-label">Sponsor logo (optional — square PNG, JPG or WebP, at least 200×200 px, max 1MB)</label>
        <input class="ap-input" type="file" accept="image/png,image/jpeg,image/webp" @change="onLogoFile" />
        <div v-if="logoSrc" class="ap-logo">
          <img :src="logoSrc" class="ap-logo-preview" alt="Sponsor logo" />
          <button type="button" class="ap-link ap-danger" @click="removeLogo">Remove</button>
        </div>
        <p class="ap-note" style="text-align:left">
          Shown on screen during the show if the host chooses — a free bonus on top
          of the Pre-Show lobby. Without a logo we show “Sponsored by {{ account?.name }}”.
        </p>
      </template>

      <label class="ap-label">Headline ({{ headline.length }}/{{ HEADLINE_MAX }})</label>
      <input class="ap-input" v-model="headline" :maxlength="HEADLINE_MAX" placeholder="Fresh roast, delivered weekly" required />

      <label class="ap-label">Body ({{ body.length }}/{{ BODY_MAX }}{{ adKind === 'video' ? ', optional' : '' }})</label>
      <textarea class="ap-input ap-textarea" v-model="body" :maxlength="BODY_MAX" placeholder="Small-batch coffee shipped to your door. First bag 20% off." :required="adKind === 'image'"></textarea>

      <label class="ap-label">Click-through URL (https)</label>
      <input class="ap-input" v-model="clickUrl" type="url" placeholder="https://acme.com/offer" required />

      <!-- Topics/budget/duration are ad-only: a sponsorship targets one event
           at a fixed, server-priced rate. -->
      <template v-if="product !== 'sponsor'">
        <label class="ap-label">Target topics (optional: none = show to everyone)</label>
        <div v-if="topics.length" class="ap-chips">
          <button
            v-for="t in topics" :key="t.id" type="button" class="ap-chip"
            :aria-selected="selectedTopics.has(t.id)" @click="toggleTopic(t.id)"
          >{{ t.name }}</button>
        </div>
        <p v-else class="ap-note" style="text-align:left">No topics available. Your ad will show to everyone.</p>
      </template>

      <template v-if="!editingId && product !== 'sponsor'">
        <label class="ap-label">Budget</label>
        <div class="ap-grid">
          <button v-for="b in BUDGETS" :key="b.cents" type="button" class="ap-opt"
                  :aria-selected="budgetCents === b.cents" @click="budgetCents = b.cents">{{ b.label }}</button>
        </div>

        <label class="ap-label">Duration</label>
        <div class="ap-grid">
          <button v-for="d in DURATIONS" :key="d.days" type="button" class="ap-opt"
                  :aria-selected="durationDays === d.days" @click="durationDays = d.days">{{ d.label }}</button>
        </div>
      </template>

      <button class="nile-btn nile-btn--primary ap-full" type="submit" :disabled="busy">
        {{ busy ? (editingId ? 'Saving…' : product === 'sponsor' ? 'Sending…' : 'Setting up…')
           : editingId ? 'Save changes'
           : product === 'sponsor' ? 'Send offer'
           : 'Continue to payment' }}
      </button>
      <p class="ap-note" v-if="editingId && product === 'sponsor'">
        Your offer stays in review after saving. The amount can't change here —
        withdraw this offer and send a new one to change it.
      </p>
      <p class="ap-note" v-else-if="editingId">
        Your ad stays in review after saving. Budget and duration can't change
        because your card is already authorized.
      </p>
      <p class="ap-note" v-else-if="product === 'sponsor'">
        Nothing is charged until the host accepts. Stripe saves your card, Nile
        checks the creative against our ad policies, then the host decides.<template v-if="offerExpiresAt">
        You'll hear back by {{ fmtDateTime(offerExpiresAt.toISOString()) }} — after that the offer expires on its own.</template>
      </p>
      <p class="ap-note" v-else>
        You'll pay securely via Stripe. Your card is only authorized now. It's
        charged when your ad is approved, and the hold is released if it isn't.
      </p>
    </form>
  </div>
</template>

