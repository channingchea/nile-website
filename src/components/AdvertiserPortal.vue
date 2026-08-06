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
    admin  → review queue (Part 3): users in the `admins` table (migration 0032)
             see pending_review campaigns with creative preview and
             approve / reject (+ pause/resume on active/paused). Actions call
             the review-ad-campaign fn, which captures / cancels the Stripe
             authorization (checkout is authorize-only for standalone ads).
    reports → reported-content queue (Reported-Content Review Page, Phase 3):
             admins see everything with an open/reviewing report, grouped by
             target, via get_report_queue. Per-type actions (remove/restore
             content, suspend/unsuspend a user, pause/reject an ad, or just
             dismiss the report) call the moderate-report fn.
    admins → admin management (migration 0055): admins add/remove other admins
             by email via the manage-admins fn (the `admins` table stays
             client-unwritable). Guardrails server-side: no self-removal, no
             removing the last admin; every change lands in
             admin_management_audit and shows under "Recent activity".

  After payment a standalone campaign lands in pending_review until an admin
  approves it (webhook flips pending_payment → pending_review).
*/
import { ref, onMounted, onUnmounted, computed } from "vue";
import { supabase, CREATE_AD_PAYMENT_URL, REVIEW_AD_CAMPAIGN_URL, MODERATE_REPORT_URL, MANAGE_ADMINS_URL, MANAGE_FEATURED_URL } from "../lib/supabase";

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
  review_note: string | null; created_at: string;
  placement: string | null; event_title: string | null; event_scheduled_at: string | null;
};
// Sponsorable event (0079 get_sponsorable_events) for the "Sponsor an event" picker.
type SponsEvent = {
  event_id: string; title: string; cover_image_url: string | null;
  scheduled_at: string; host_username: string | null; host_name: string | null;
  host_avatar_url: string | null; is_ticketed: boolean; price_cents: number;
};
type DailyPoint = { day: string; impressions: number; clicks: number };

const PAGE = 15; // keyset page size (mirrors the app's Paged<T> convention)

const sb = supabase();

const view = ref<"loading" | "auth" | "setup" | "dash" | "build" | "admin" | "reports" | "admins" | "featured" | "feedback" | "denied">("loading");
// Set by ?view=review / ?view=reports / ?view=admins / ?view=feedback so an
// admin with a brand account lands on the relevant queue rather than their
// dashboard; non-admins hit the denied guard in openAdmin()/openReports()/
// openAdmins()/openFeedback().
let wantReview = false;
let wantReports = false;
let wantAdmins = false;
let wantFeatured = false;
let wantFeedback = false;
const msg = ref("");
const busy = ref(false);
const account = ref<Account | null>(null);
const isAdmin = ref(false);
const reportCount = ref(0); // open+reviewing report count, shown next to the nav link

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
  else if (!sponsEvents.value.length) loadSponsEvents();
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

// Currents video ads (0068): a campaign whose creative is a ≤60s vertical video
// served between Currents in the app. Same checkout/review; separate bucket.
const adKind = ref<"image" | "video">("image");
const videoFile = ref<File | null>(null);
const videoPreviewUrl = ref("");
const videoDurationMs = ref(0);
const existingVideoUrl = ref(""); // current creative video when editing
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const VIDEO_MAX_MS = 60_000;

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
let returnCampaignId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  boot();
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  window.removeEventListener("keydown", onKey);
});

async function boot() {
  const params = new URLSearchParams(window.location.search);
  wantReview = params.get("view") === "review"; // bookmarkable queue link
  wantReports = params.get("view") === "reports"; // bookmarkable reported-content link
  wantAdmins = params.get("view") === "admins"; // bookmarkable admin-management link
  wantFeatured = params.get("view") === "featured"; // bookmarkable featured-curation link
  wantFeedback = params.get("view") === "feedback"; // bookmarkable bug-report link
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
  pollTimer = setInterval(async () => {
    tries += 1;
    const { data } = await sb
      .from("ad_campaigns").select("status").eq("id", id).maybeSingle();
    const status = (data as { status?: string } | null)?.status;
    const settled = !!status && status !== "pending_payment";
    if (settled || tries >= 15) { // ~30s max
      clearInterval(pollTimer!);
      pollTimer = null;
      returnCampaignId = null;
      if (settled) await openDashboard(); // re-pull rows with the new status
    }
  }, 2000);
}

async function afterAuth() {
  // Own-row RLS on `admins` means this returns a row only for admins.
  const { data: adminRow } = await sb.from("admins").select("user_id").maybeSingle();
  isAdmin.value = !!adminRow;
  if (isAdmin.value) {
    await loadReportCount();
    await loadFeedbackCount();
  }

  // ?view=review / ?view=reports bookmarks: send anyone who asked for a queue
  // through the matching guard (admins see it; non-admins get the denied view).
  if (wantReview) { await openAdmin(); return; }
  if (wantReports) { await openReports(); return; }
  if (wantAdmins) { await openAdmins(); return; }
  if (wantFeatured) { await openFeatured(); return; }
  if (wantFeedback) { await openFeedback(); return; }

  const acc = await loadAccount();
  if (!acc) {
    if (isAdmin.value) { await openAdmin(); return; } // admins need no brand account
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
  const [{ data, error }, { data: dly }] = await Promise.all([
    sb.rpc("get_advertiser_performance", { p_account_id: acct, p_limit: PAGE }),
    sb.rpc("get_advertiser_daily", { p_account_id: acct }),
  ]);
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
    const header = ["Campaign", "Status", "Budget", "Spent", "Impressions", "Clicks", "CTR", "Created"];
    const body = all.map((r) => [
      r.headline || r.name, statusLabel(r.status), money(r.budget_cents), money(r.spent_cents),
      r.impressions, r.clicks, ctr(r), new Date(r.created_at).toLocaleDateString(),
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
  const header = ["Date", "Impressions", "Clicks"];
  const body = daily.value.map((p) => [p.day, p.impressions, p.clicks]);
  downloadCsv(dailyCampaignId.value ? "nile-ads-daily-campaign.csv" : "nile-ads-daily.csv", [header, ...body]);
}
// Withdraw (hard-delete) an in-review or rejected ad. Server-side: the
// review-ad-campaign fn cancels the card hold (in-review only), then deletes
// the campaign + creative image.
const deletingId = ref("");
async function deleteCampaign(r: Row) {
  const holdNote = r.status === "pending_review" ? " The card hold will be released." : "";
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
async function signOut() {
  await sb.auth.signOut();
  account.value = null;
  view.value = "auth";
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const ctr = (r: Row) => (r.impressions ? ((r.clicks / r.impressions) * 100).toFixed(1) : "0.0") + "%";
function statusLabel(s: string) {
  return ({
    pending_payment: "Awaiting payment",
    pending_review: "In review",
    active: "Active",
    paused: "Paused",
    rejected: "Rejected",
    completed: "Completed",
  } as Record<string, string>)[s] ?? s;
}
function statusClass(s: string) {
  if (s === "active") return "ok";
  if (s === "rejected") return "err";
  if (s === "pending_review" || s === "pending_payment") return "warn";
  return "muted";
}

// ── admin review queue (Part 3) ─────────────────────────────────────────────
type AdminRow = {
  id: string; name: string; status: string; budget_cents: number;
  starts_at: string; ends_at: string; created_at: string;
  placement: string | null;
  ad_creatives: {
    image_url: string | null; headline: string; body: string | null;
    click_url: string; kind: "image" | "video" | null;
    video_path: string | null; duration_ms: number | null;
  }[];
  ad_targeting: { topic_ids: string[] | null }[];
  advertiser_accounts: { name: string; contact_email: string } | null;
  events: { title: string; scheduled_at: string | null } | null;
};

// Public playback URL for a video creative (ad-videos bucket, 0068).
const adVideoUrl = (cr: AdminRow["ad_creatives"][0] | undefined) =>
  cr?.video_path
    ? sb.storage.from("ad-videos").getPublicUrl(cr.video_path).data.publicUrl
    : "";
const queue = ref<AdminRow[]>([]);
const adminCursor = ref<string | null>(null);
const adminHasMore = ref(false);
const topicNames = ref<Record<string, string>>({});
const actingOn = ref("");

const ADMIN_SELECT =
  "id, name, status, budget_cents, starts_at, ends_at, created_at, placement, ad_creatives(image_url, headline, body, click_url, kind, video_path, duration_ms), ad_targeting(topic_ids), advertiser_accounts(name, contact_email), events(title, scheduled_at)";
function fetchAdmin(cursor: string | null, limit: number) {
  let q = sb.from("ad_campaigns").select(ADMIN_SELECT)
    .in("status", ["pending_review", "active", "paused"])
    .order("created_at", { ascending: true }).limit(limit);
  if (cursor) q = q.gt("created_at", cursor);
  return q;
}

// Read-only detail modal (any admin row); reject happens here with an
// optional reason that's stored on the campaign and shown to the advertiser.
const detail = ref<AdminRow | null>(null);
const rejectMode = ref(false);
const rejectNote = ref("");
function openDetail(r: AdminRow, reject = false) {
  detail.value = r;
  rejectMode.value = reject;
  rejectNote.value = "";
}
function closeDetail() {
  detail.value = null;
  rejectMode.value = false;
  rejectNote.value = "";
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeDetail();
}
const fmtDate = (s: string) => new Date(s).toLocaleDateString();

async function openAdmin() {
  // Defense-in-depth: RLS + the review fn already gate the queue, but never
  // even load it for a non-admin — show a clear denied message instead of an
  // empty queue.
  if (!isAdmin.value) { view.value = "denied"; return; }
  msg.value = "";
  wantReview = false;
  view.value = "loading";
  const [{ data, error }, { data: tps }] = await Promise.all([
    fetchAdmin(null, PAGE),
    sb.from("topics").select("id, name"),
  ]);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  queue.value = page;
  adminCursor.value = page.length ? page[page.length - 1].created_at : null;
  adminHasMore.value = page.length === PAGE;
  topicNames.value = Object.fromEntries(((tps as Topic[]) ?? []).map((t) => [t.id, t.name]));
  view.value = "admin";
}
// Non-admin leaving the denied view: clear the review intent and route them to
// their own account (dashboard, or setup if they have no brand yet).
async function leaveDenied() {
  wantReview = false;
  wantReports = false;
  wantAdmins = false;
  view.value = "loading";
  const acc = await loadAccount();
  if (acc) { await openDashboard(); return; }
  contactEmail.value = (await sb.auth.getUser()).data.user?.email ?? "";
  view.value = "setup";
}
async function loadMoreAdmin() {
  if (loadingMore.value || !adminHasMore.value) return;
  loadingMore.value = true;
  const { data, error } = await fetchAdmin(adminCursor.value, PAGE);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  queue.value = [...queue.value, ...page];
  adminCursor.value = page.length ? page[page.length - 1].created_at : adminCursor.value;
  adminHasMore.value = page.length === PAGE;
  loadingMore.value = false;
}
// Re-pull the currently loaded window in place after an admin action, so a row
// approved on "page 2" doesn't collapse the list back to page 1.
async function reloadAdmin() {
  const limit = Math.max(PAGE, queue.value.length);
  const { data, error } = await fetchAdmin(null, limit);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  queue.value = page;
  adminCursor.value = page.length ? page[page.length - 1].created_at : null;
  adminHasMore.value = page.length === limit;
}

// Sponsorships (lobby placement) sort first, soonest event first — their
// review window closes when the event starts, so they're the time-sensitive
// ones. Everything else keeps the created_at order from the fetch.
const pendingRows = computed(() =>
  queue.value
    .filter((r) => r.status === "pending_review")
    .sort((a, b) => {
      const aLobby = a.placement === "lobby", bLobby = b.placement === "lobby";
      if (aLobby !== bLobby) return aLobby ? -1 : 1;
      if (aLobby && bLobby) {
        return new Date(a.events?.scheduled_at ?? 0).getTime() -
               new Date(b.events?.scheduled_at ?? 0).getTime();
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }));
const liveRows = computed(() => queue.value.filter((r) => r.status !== "pending_review"));

function topicsFor(r: AdminRow) {
  const ids = r.ad_targeting?.[0]?.topic_ids ?? [];
  if (!ids.length) return "Everyone (broad)";
  return ids.map((id) => topicNames.value[id] ?? "?").join(", ");
}

async function act(r: AdminRow, action: "approve" | "reject" | "pause" | "resume", note?: string) {
  msg.value = "";
  actingOn.value = r.id + action;
  try {
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(REVIEW_AD_CAMPAIGN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sess.session?.access_token}`,
      },
      body: JSON.stringify({
        campaign_id: r.id,
        action,
        ...(note?.trim() ? { note: note.trim() } : {}),
      }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Action failed");
    closeDetail();
    await reloadAdmin();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOn.value = "";
  }
}

// ── reported content (Phase 3) ──────────────────────────────────────────────
type ReportRow = {
  target_type: "user" | "post" | "event" | "comment" | "ad";
  target_id: string;
  report_count: number;
  reasons: string[];
  notes: string[];
  statuses: string[];
  newest_report_at: string;
  is_removed: boolean;
  is_suspended: boolean;
  // deno/postgres jsonb — shape depends on target_type, see reportPreview().
  preview: Record<string, any>;
};
const TYPE_LABELS: Record<ReportRow["target_type"], string> =
  { user: "User", post: "Post", event: "Event", comment: "Comment", ad: "Ad" };

const reportsQueue = ref<ReportRow[]>([]);
const reportsCursor = ref<string | null>(null);
const reportsHasMore = ref(false);
const actingOnReport = ref("");

// Cheap head-count for the nav link badge — only ever queried for admins (RLS
// on `reports` is admin-only select anyway, so this is defense-in-depth).
async function loadReportCount() {
  if (!isAdmin.value) return;
  const { count } = await sb.from("reports").select("id", { count: "exact", head: true })
    .in("status", ["open", "reviewing"]);
  reportCount.value = count ?? 0;
}

async function openReports() {
  if (!isAdmin.value) { view.value = "denied"; return; } // same denied guard as openAdmin
  msg.value = "";
  wantReports = false;
  view.value = "loading";
  const { data, error } = await sb.rpc("get_report_queue", { p_limit: PAGE });
  if (error) msg.value = error.message;
  const page = (data as ReportRow[]) ?? [];
  reportsQueue.value = page;
  reportsCursor.value = page.length ? page[page.length - 1].newest_report_at : null;
  reportsHasMore.value = page.length === PAGE;
  await loadReportCount();
  view.value = "reports";
}
async function loadMoreReports() {
  if (loadingMore.value || !reportsHasMore.value) return;
  loadingMore.value = true;
  const { data, error } = await sb.rpc("get_report_queue", { p_limit: PAGE, p_before: reportsCursor.value });
  if (error) msg.value = error.message;
  const page = (data as ReportRow[]) ?? [];
  reportsQueue.value = [...reportsQueue.value, ...page];
  reportsCursor.value = page.length ? page[page.length - 1].newest_report_at : reportsCursor.value;
  reportsHasMore.value = page.length === PAGE;
  loadingMore.value = false;
}
// Re-pull the currently loaded window in place after an action (mirrors
// reloadAdmin) — an actioned target usually drops out of the queue entirely
// (its reports are no longer open/reviewing), so this also shrinks the list.
async function reloadReports() {
  const limit = Math.max(PAGE, reportsQueue.value.length);
  const { data, error } = await sb.rpc("get_report_queue", { p_limit: limit });
  if (error) msg.value = error.message;
  const page = (data as ReportRow[]) ?? [];
  reportsQueue.value = page;
  reportsCursor.value = page.length ? page[page.length - 1].newest_report_at : null;
  reportsHasMore.value = page.length === limit;
}

const reasonLabel = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Normalizes get_report_queue's per-type jsonb preview into one shape the
// template can render without a 5-way branch. `exists: false` means the
// owner already deleted the target themselves (post/comment/event/user) or
// the campaign was withdrawn (ad) — the card falls back to resolve/dismiss.
function reportPreview(r: ReportRow) {
  const p = r.preview ?? {};
  if (!p.exists) return { exists: false, image: "", title: "", subtitle: "" };
  switch (r.target_type) {
    case "post":
      return { exists: true, image: p.image_url || p.image_urls?.[0] || "", title: p.content || "(no text)", subtitle: `@${p.author_username ?? "unknown"}` };
    case "comment":
      return { exists: true, image: "", title: p.body ?? "", subtitle: `@${p.author_username ?? "unknown"}` };
    case "event":
      return { exists: true, image: p.cover_image_url || "", title: p.title || "(untitled event)", subtitle: `Hosted by @${p.host_username ?? "unknown"} · ${p.status}` };
    case "ad":
      return { exists: true, image: p.image_url || "", title: p.headline || p.campaign_name || "(ad)", subtitle: `${p.advertiser_name ?? "Host boost"} · ${statusLabel(p.campaign_status)}` };
    default: // user
      return { exists: true, image: p.avatar_url || "", title: p.display_name || `@${p.username}`, subtitle: p.bio || "" };
  }
}

// Common path for resolve/dismiss/remove/restore/suspend/unsuspend — all just
// { target_type, target_id, action }. confirmMsg gates a native confirm() for
// the destructive ones (remove_content, suspend_user).
async function moderate(
  row: ReportRow,
  action: "resolve" | "dismiss" | "remove_content" | "restore_content" | "suspend_user" | "unsuspend_user",
  confirmMsg?: string,
) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  msg.value = "";
  actingOnReport.value = row.target_type + row.target_id + action;
  try {
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(MODERATE_REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token}` },
      body: JSON.stringify({ target_type: row.target_type, target_id: row.target_id, action }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Action failed");
    await reloadReports();
    await loadReportCount();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOnReport.value = "";
  }
}
// Ad reports carry no content action in moderate-report — pause/reject go
// through the existing review-ad-campaign fn, then the report itself is
// closed out with a best-effort resolve so it doesn't linger in the queue.
async function actOnAd(row: ReportRow, action: "pause" | "resume" | "reject", confirmMsg?: string) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  msg.value = "";
  actingOnReport.value = row.target_type + row.target_id + action;
  try {
    const { data: sess } = await sb.auth.getSession();
    const token = sess.session?.access_token;
    const res = await fetch(REVIEW_AD_CAMPAIGN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ campaign_id: row.target_id, action }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Action failed");
    await fetch(MODERATE_REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_type: "ad", target_id: row.target_id, action: "resolve" }),
    }).catch(() => {});
    await reloadReports();
    await loadReportCount();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOnReport.value = "";
  }
}

// ── bug & feature reports (migration 0077) ──────────────────────────────────
// Straight table reads/writes rather than an edge fn: `feedback_reports` RLS
// already gates select/update on is_admin(), and nothing here needs the
// service role the way moderate-report does.
type FeedbackRow = {
  id: string;
  reporter_id: string | null;
  kind: "bug" | "feature";
  title: string;
  body: string;
  status: "new" | "triaged" | "in_progress" | "resolved" | "wont_fix";
  admin_note: string | null;
  diagnostics: Record<string, any>;
  error_log: { at: string; message: string; stack?: string }[];
  image_paths: string[];
  source: "settings" | "shake";
  created_at: string;
  resolved_at: string | null;
};

const FEEDBACK_STATUSES = ["new", "triaged", "in_progress", "resolved", "wont_fix"] as const;
const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  new: "New", triaged: "Triaged", in_progress: "In progress",
  resolved: "Resolved", wont_fix: "Won't fix",
};

const feedbackQueue = ref<FeedbackRow[]>([]);
const feedbackCursor = ref<string | null>(null);
const feedbackHasMore = ref(false);
const feedbackCount = ref(0); // untriaged (new) count for the nav badge
const feedbackKind = ref<"all" | "bug" | "feature">("all");
const feedbackStatus = ref<"open" | "all" | typeof FEEDBACK_STATUSES[number]>("open");
const actingOnFeedback = ref("");
const expandedFeedback = ref<string | null>(null);
// Per-row unsaved edits, keyed by report id, so switching rows doesn't lose them.
const feedbackDrafts = ref<Record<string, { status: string; note: string }>>({});
// Signed URLs are short-lived (private bucket), so they're fetched per expand.
const feedbackImages = ref<Record<string, string[]>>({});

async function loadFeedbackCount() {
  if (!isAdmin.value) return;
  const { count } = await sb.from("feedback_reports")
    .select("id", { count: "exact", head: true }).eq("status", "new");
  feedbackCount.value = count ?? 0;
}

// One query builder for the queue + "load more", so the filters can't drift
// between the two paths.
function feedbackQuery(before: string | null, limit: number) {
  let q = sb.from("feedback_reports").select("*");
  if (feedbackKind.value !== "all") q = q.eq("kind", feedbackKind.value);
  if (feedbackStatus.value === "open") {
    q = q.in("status", ["new", "triaged", "in_progress"]);
  } else if (feedbackStatus.value !== "all") {
    q = q.eq("status", feedbackStatus.value);
  }
  if (before) q = q.lt("created_at", before);
  return q.order("created_at", { ascending: false }).limit(limit);
}

async function openFeedback() {
  if (!isAdmin.value) { view.value = "denied"; return; } // same denied guard as openAdmin
  msg.value = "";
  wantFeedback = false;
  view.value = "loading";
  await refreshFeedback();
  await loadFeedbackCount();
  view.value = "feedback";
}

async function refreshFeedback() {
  const { data, error } = await feedbackQuery(null, PAGE);
  if (error) msg.value = error.message;
  const page = (data as FeedbackRow[]) ?? [];
  feedbackQueue.value = page;
  feedbackCursor.value = page.length ? page[page.length - 1].created_at : null;
  feedbackHasMore.value = page.length === PAGE;
}

async function loadMoreFeedback() {
  if (loadingMore.value || !feedbackHasMore.value) return;
  loadingMore.value = true;
  const { data, error } = await feedbackQuery(feedbackCursor.value, PAGE);
  if (error) msg.value = error.message;
  const page = (data as FeedbackRow[]) ?? [];
  feedbackQueue.value = [...feedbackQueue.value, ...page];
  feedbackCursor.value = page.length ? page[page.length - 1].created_at : feedbackCursor.value;
  feedbackHasMore.value = page.length === PAGE;
  loadingMore.value = false;
}

async function toggleFeedback(r: FeedbackRow) {
  if (expandedFeedback.value === r.id) { expandedFeedback.value = null; return; }
  expandedFeedback.value = r.id;
  feedbackDrafts.value[r.id] ??= { status: r.status, note: r.admin_note ?? "" };
  if (r.image_paths.length && !feedbackImages.value[r.id]) {
    const { data } = await sb.storage.from("feedback")
      .createSignedUrls(r.image_paths, 600);
    feedbackImages.value[r.id] =
      (data ?? []).map((d: any) => d.signedUrl).filter(Boolean);
  }
}

// Saving a status of resolved/wont_fix fires the DB trigger that notifies the
// reporter in-app — so the note is what they read. Write both in one update.
async function saveFeedback(r: FeedbackRow) {
  const draft = feedbackDrafts.value[r.id];
  if (!draft) return;
  msg.value = "";
  actingOnFeedback.value = r.id;
  try {
    const { error } = await sb.from("feedback_reports")
      .update({ status: draft.status, admin_note: draft.note.trim() || null })
      .eq("id", r.id);
    if (error) throw new Error(error.message);
    await refreshFeedback();
    await loadFeedbackCount();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOnFeedback.value = "";
  }
}

// ── admin management (manage-admins fn, migration 0055) ─────────────────────
type AdminEntry = { user_id: string; email: string; created_at: string };
type AdminAuditEntry = {
  actor_email: string; action: "added" | "removed";
  target_email: string | null; created_at: string;
};
const adminsList = ref<AdminEntry[]>([]);
const adminsAudit = ref<AdminAuditEntry[]>([]);
const myUserId = ref("");
const newAdminEmail = ref("");
const adminsBusy = ref(""); // "add" while adding, or the user_id being removed
const adminsNotice = ref(""); // inline success message

async function callManageAdmins(body: Record<string, unknown>) {
  const { data: sess } = await sb.auth.getSession();
  const res = await fetch(MANAGE_ADMINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token}` },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || "Action failed");
  return out;
}

async function reloadAdmins() {
  const out = await callManageAdmins({ action: "list" });
  adminsList.value = out.admins ?? [];
  adminsAudit.value = out.audit ?? [];
}

async function openAdmins() {
  if (!isAdmin.value) { view.value = "denied"; return; } // same denied guard as openAdmin
  msg.value = "";
  adminsNotice.value = "";
  wantAdmins = false;
  view.value = "loading";
  try {
    myUserId.value = (await sb.auth.getUser()).data.user?.id ?? "";
    await reloadAdmins();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  }
  view.value = "admins";
}

async function addAdmin() {
  msg.value = "";
  adminsNotice.value = "";
  adminsBusy.value = "add";
  try {
    const out = await callManageAdmins({ action: "add", email: newAdminEmail.value });
    adminsNotice.value = `${out.added?.email ?? newAdminEmail.value.trim()} is now an admin.`;
    newAdminEmail.value = "";
    await reloadAdmins();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    adminsBusy.value = "";
  }
}

async function removeAdmin(a: AdminEntry) {
  if (!confirm(`Remove ${a.email} as an admin? They lose access to the admin views immediately.`)) return;
  msg.value = "";
  adminsNotice.value = "";
  adminsBusy.value = a.user_id;
  try {
    await callManageAdmins({ action: "remove", user_id: a.user_id });
    adminsNotice.value = `${a.email} is no longer an admin.`;
    await reloadAdmins();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    adminsBusy.value = "";
  }
}

const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ── featured curation (migration 0063 + manage-featured fn) ───────────────────
type FeaturedEvent = {
  target_id: string; position: number; title: string;
  status: string | null; host_username: string | null; missing: boolean;
};
type FeaturedCreator = {
  target_id: string; position: number; username: string;
  display_name: string; follower_count: number; missing: boolean;
};
type EventHit = { target_id: string; title: string; status: string; host_username: string | null };
type CreatorHit = { target_id: string; username: string; display_name: string; follower_count: number };

const featuredEvents = ref<FeaturedEvent[]>([]);
const featuredCreators = ref<FeaturedCreator[]>([]);
const featuredNotice = ref(""); // inline success message
const featuredBusy = ref(""); // a target_id, or "reorder", while a write is in flight
const eventQuery = ref("");
const creatorQuery = ref("");
const eventHits = ref<EventHit[]>([]);
const creatorHits = ref<CreatorHit[]>([]);
const searchingEvents = ref(false);
const searchingCreators = ref(false);

// Already-featured ids, so search results can show "Featured" instead of "Add".
const featuredEventIds = computed(() => new Set(featuredEvents.value.map((e) => e.target_id)));
const featuredCreatorIds = computed(() => new Set(featuredCreators.value.map((c) => c.target_id)));

async function callManageFeatured(body: Record<string, unknown>) {
  const { data: sess } = await sb.auth.getSession();
  const res = await fetch(MANAGE_FEATURED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token}` },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || "Action failed");
  return out;
}

async function reloadFeatured() {
  const out = await callManageFeatured({ action: "list" });
  featuredEvents.value = out.events ?? [];
  featuredCreators.value = out.creators ?? [];
}

async function openFeatured() {
  if (!isAdmin.value) { view.value = "denied"; return; } // same denied guard as openAdmins
  msg.value = "";
  featuredNotice.value = "";
  wantFeatured = false;
  view.value = "loading";
  try {
    await reloadFeatured();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  }
  view.value = "featured";
}

async function addFeatured(kind: "event" | "creator", targetId: string, label: string) {
  msg.value = "";
  featuredNotice.value = "";
  featuredBusy.value = targetId;
  try {
    await callManageFeatured({ action: "add", kind, target_id: targetId });
    featuredNotice.value = `Featured ${label}.`;
    if (kind === "event") { eventQuery.value = ""; eventHits.value = []; }
    else { creatorQuery.value = ""; creatorHits.value = []; }
    await reloadFeatured();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    featuredBusy.value = "";
  }
}

async function removeFeatured(kind: "event" | "creator", targetId: string, label: string) {
  if (!confirm(`Remove "${label}" from Featured?`)) return;
  msg.value = "";
  featuredNotice.value = "";
  featuredBusy.value = targetId;
  try {
    await callManageFeatured({ action: "remove", kind, target_id: targetId });
    featuredNotice.value = `Removed "${label}" from Featured.`;
    await reloadFeatured();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    featuredBusy.value = "";
  }
}

// Swap an entry with its neighbour and persist the whole section's new order.
async function moveFeatured(kind: "event" | "creator", index: number, dir: -1 | 1) {
  const list = kind === "event" ? featuredEvents.value : featuredCreators.value;
  const j = index + dir;
  if (j < 0 || j >= list.length) return;
  const ids = list.map((r) => r.target_id);
  [ids[index], ids[j]] = [ids[j], ids[index]];
  msg.value = "";
  featuredNotice.value = "";
  featuredBusy.value = "reorder";
  try {
    await callManageFeatured({ action: "reorder", kind, target_ids: ids });
    await reloadFeatured();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    featuredBusy.value = "";
  }
}

async function searchFeatured(kind: "event" | "creator") {
  const q = (kind === "event" ? eventQuery.value : creatorQuery.value).trim();
  msg.value = "";
  if (kind === "event") searchingEvents.value = true;
  else searchingCreators.value = true;
  try {
    const out = await callManageFeatured({ action: "search", kind, query: q });
    if (kind === "event") eventHits.value = out.results ?? [];
    else creatorHits.value = out.results ?? [];
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    if (kind === "event") searchingEvents.value = false;
    else searchingCreators.value = false;
  }
}

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
  videoFile.value = null;
  if (videoPreviewUrl.value) URL.revokeObjectURL(videoPreviewUrl.value);
  videoPreviewUrl.value = "";
  videoDurationMs.value = 0;
  existingVideoUrl.value = "";
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
      .select("ad_creatives(image_url, headline, body, click_url, kind, video_path), ad_targeting(topic_ids)")
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
    // Sponsorship (0079): placement "lobby" + the chosen event; price is
    // server-derived from app_config, so no budget/duration/topics are sent.
    const payload: Record<string, unknown> = isSponsor
      ? {
          advertiser_account_id: account.value!.id,
          placement: "lobby",
          event_id: selectedEvent.value!.event_id,
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
// every page shows the same set. Admin tabs are gated on isAdmin (the views
// themselves keep their own `denied` guards — this only hides the entry point).
type Tab = { key: string; label: string; count?: number; go: () => void };

const portalTabs = computed<Tab[]>(() => {
  const t: Tab[] = [];
  if (account.value) t.push({ key: "dash", label: "My dashboard", go: openDashboard });
  if (isAdmin.value) {
    t.push({ key: "admin", label: "Review queue", go: openAdmin });
    t.push({ key: "reports", label: "Reported content", count: reportCount.value, go: openReports });
    t.push({ key: "feedback", label: "Bug reports", count: feedbackCount.value, go: openFeedback });
    t.push({ key: "featured", label: "Featured", go: openFeatured });
    t.push({ key: "admins", label: "Admins", go: openAdmins });
  }
  return t;
});

const TABBED_VIEWS = ["dash", "build", "admin", "reports", "feedback", "admins", "featured"];
const showTabs = computed(() => TABBED_VIEWS.includes(view.value) && portalTabs.value.length > 0);
// The builder is a sub-page of the dashboard, so it keeps that tab lit.
const activeTab = computed(() => (view.value === "build" ? "dash" : view.value));
</script>

<template>
  <div class="ap">
    <div v-if="msg" class="ap-msg ap-err">
      <span>{{ msg }}</span>
      <button v-if="view === 'dash'" type="button" class="ap-retry" @click="openDashboard">Retry</button>
      <button v-else-if="view === 'admin'" type="button" class="ap-retry" @click="openAdmin">Retry</button>
      <button v-else-if="view === 'admins'" type="button" class="ap-retry" @click="openAdmins">Retry</button>
      <button v-else-if="view === 'feedback'" type="button" class="ap-retry" @click="openFeedback">Retry</button>
    </div>
    <div v-if="returnBanner" class="ap-msg ap-ok">
      Payment received. Your ad is now in review. You'll see it as Active here once approved.
    </div>

    <!-- Folder tabs: one strip for the whole portal, same links on every page -->
    <nav v-if="showTabs" class="ap-tabs" :class="{ 'ap-tabs--narrow': view === 'build' }" aria-label="Portal sections">
      <button
        v-for="t in portalTabs" :key="t.key" type="button" class="ap-tab"
        :class="{ 'is-active': activeTab === t.key }"
        :aria-current="activeTab === t.key ? 'page' : undefined"
        @click="t.go()"
      >
        {{ t.label }}<span v-if="t.count" class="ap-tab-count">{{ t.count }}</span>
      </button>
      <span class="ap-tabs-gap"></span>
      <button type="button" class="ap-tab ap-tab--quiet" @click="signOut">Sign out</button>
    </nav>

    <div v-if="view === 'loading'" class="ap-center">Loading…</div>

    <!-- DENIED (non-admin reached the review queue) -->
    <div v-else-if="view === 'denied'" class="ap-card">
      <h2 class="ap-h">Not available</h2>
      <p class="ap-sub">This area is for Nile staff.</p>
      <button class="nile-btn nile-btn--primary ap-full" @click="leaveDenied">Go to your account</button>
    </div>

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

      <p v-if="rows.length === 0" class="ap-center">
        No campaigns yet. Create your first to start reaching Nile audiences.
      </p>
      <template v-else>
        <table class="ap-tbl ap-tbl--cards">
          <thead>
            <tr><th>Campaign</th><th>Status</th><th>Impr.</th><th>Clicks</th><th>CTR</th><th>Spent</th><th></th></tr>
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
              </td>
              <td data-label="Status"><span class="ap-badge" :class="statusClass(r.status)">{{ statusLabel(r.status) }}</span></td>
              <td data-label="Impr.">{{ r.impressions }}</td>
              <td data-label="Clicks">{{ r.clicks }}</td>
              <td data-label="CTR">{{ ctr(r) }}</td>
              <td data-label="Spent">{{ money(r.spent_cents) }} / {{ money(r.budget_cents) }}</td>
              <td class="ap-rowactions">
                <button v-if="r.status === 'pending_review'" class="ap-link" @click="openEdit(r)">Edit</button>
                <button
                  v-if="r.status === 'pending_review' || r.status === 'rejected'"
                  class="ap-link ap-danger" :disabled="deletingId === r.campaign_id"
                  @click="deleteCampaign(r)"
                >{{ deletingId === r.campaign_id ? 'Deleting…' : 'Delete' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <button v-if="dashHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreDash">
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </template>
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
          them to sponsorship, at least 24 hours before showtime.
        </p>
        <div v-else class="ap-spons-list">
          <button
            v-for="ev in sponsEvents" :key="ev.event_id" type="button" class="ap-spons-row"
            :aria-selected="selectedEvent?.event_id === ev.event_id"
            @click="selectedEvent = selectedEvent?.event_id === ev.event_id ? null : ev"
          >
            <img v-if="ev.cover_image_url" :src="ev.cover_image_url" class="ap-spons-cover" alt="" />
            <div v-else class="ap-spons-cover ap-spons-cover--empty"></div>
            <span class="ap-spons-info">
              <b>{{ ev.title }}</b>
              <small>{{ ev.host_name || ev.host_username }} · {{ fmtDateTime(ev.scheduled_at) }}</small>
              <small>{{ ev.is_ticketed ? 'Ticketed event' : 'Free event' }} · {{ money(ev.price_cents) }}</small>
            </span>
          </button>
        </div>

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
        {{ busy ? (editingId ? 'Saving…' : 'Setting up…')
           : editingId ? 'Save changes'
           : (product === 'sponsor' && selectedEvent) ? `Continue to payment — ${money(selectedEvent.price_cents)}`
           : 'Continue to payment' }}
      </button>
      <p class="ap-note" v-if="editingId">
        Your ad stays in review after saving. Budget and duration can't change
        because your card is already authorized.
      </p>
      <p class="ap-note" v-else-if="product === 'sponsor'">
        You'll pay securely via Stripe. Your card is only authorized now — it's
        charged when your sponsorship is approved, and you're automatically
        refunded if the event is cancelled or never happens.
      </p>
      <p class="ap-note" v-else>
        You'll pay securely via Stripe. Your card is only authorized now. It's
        charged when your ad is approved, and the hold is released if it isn't.
      </p>
    </form>

    <!-- ADMIN REVIEW QUEUE -->
    <div v-else-if="view === 'admin'" class="ap-card ap-wide">
      <div class="ap-top">
        <div>
          <h2 class="ap-h" style="margin:0">Review queue</h2>
          <p class="ap-sub">{{ pendingRows.length }} awaiting review</p>
        </div>
      </div>

      <p v-if="pendingRows.length === 0" class="ap-center">Nothing awaiting review.</p>
      <div v-for="r in pendingRows" :key="r.id" class="ap-review">
        <!-- Video creatives (Currents ads) get an inline player so admins watch
             the full spot before approving; images keep the plain preview. -->
        <video
          v-if="r.ad_creatives?.[0]?.kind === 'video'"
          :src="adVideoUrl(r.ad_creatives[0])"
          class="ap-preview" controls muted playsinline preload="metadata"
        ></video>
        <img v-else-if="r.ad_creatives?.[0]" :src="r.ad_creatives[0].image_url ?? ''" class="ap-preview ap-clickable" alt="" @click="openDetail(r)" />
        <h3 class="ap-rh ap-clickable" @click="openDetail(r)">{{ r.ad_creatives?.[0]?.headline ?? r.name }}</h3>
        <p class="ap-rb">{{ r.ad_creatives?.[0]?.body }}</p>
        <p class="ap-rmeta">
          <!-- Sponsorships are time-sensitive: the review window closes at showtime. -->
          <span v-if="r.placement === 'lobby'" class="ap-badge warn">
            Sponsorship · {{ r.events?.title }}{{ r.events?.scheduled_at ? ' · ' + fmtDateTime(r.events.scheduled_at) : '' }}
          </span>
          <span v-if="r.placement === 'lobby'"> · </span>
          <span v-if="r.placement !== 'lobby' && r.ad_creatives?.[0]?.kind === 'video'">Currents video ad{{ r.ad_creatives[0].duration_ms ? ` · ${Math.round(r.ad_creatives[0].duration_ms! / 1000)}s` : '' }}</span>
          <span v-if="r.placement !== 'lobby' && r.ad_creatives?.[0]?.kind === 'video'"> · </span>
          <span>{{ r.advertiser_accounts?.name }} ({{ r.advertiser_accounts?.contact_email }})</span> ·
          <span>{{ money(r.budget_cents) }}</span> ·
          <span v-if="r.placement !== 'lobby'">Topics: {{ topicsFor(r) }}</span>
          <span v-if="r.placement !== 'lobby'"> · </span>
          <a v-if="r.ad_creatives?.[0]" :href="r.ad_creatives[0].click_url" target="_blank" rel="noopener noreferrer">{{ r.ad_creatives[0].click_url }}</a>
        </p>
        <div class="ap-rbtns">
          <button class="nile-btn nile-btn--primary" :disabled="actingOn === r.id + 'approve'" @click="act(r, 'approve')">
            {{ actingOn === r.id + 'approve' ? 'Approving…' : 'Approve & charge' }}
          </button>
          <button class="ap-reject" @click="openDetail(r, true)">Reject…</button>
          <button type="button" class="ap-link" @click="openDetail(r)">View details</button>
        </div>
      </div>

      <template v-if="liveRows.length">
        <h3 class="ap-rh" style="margin-top: var(--nile-s-8)">Active & paused</h3>
        <table class="ap-tbl ap-tbl--cards">
          <thead><tr><th>Campaign</th><th>Advertiser</th><th>Status</th><th>Budget</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in liveRows" :key="r.id">
              <td class="name" data-label="Campaign">{{ r.ad_creatives?.[0]?.headline ?? r.name }}</td>
              <td data-label="Advertiser">{{ r.advertiser_accounts?.name ?? 'Host boost' }}</td>
              <td data-label="Status"><span class="ap-badge" :class="statusClass(r.status)">{{ statusLabel(r.status) }}</span></td>
              <td data-label="Budget">{{ money(r.budget_cents) }}</td>
              <td class="ap-rowactions">
                <button class="ap-link" @click="openDetail(r)">View</button>
                <button class="ap-link" :disabled="!!actingOn" @click="act(r, r.status === 'active' ? 'pause' : 'resume')">
                  {{ r.status === 'active' ? 'Pause' : 'Resume' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <button v-if="adminHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreAdmin">
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>

    <!-- REPORTED CONTENT QUEUE -->
    <div v-else-if="view === 'reports'" class="ap-card ap-wide">
      <div class="ap-top">
        <div>
          <h2 class="ap-h" style="margin:0">Reported content</h2>
          <p class="ap-sub">{{ reportCount }} open report{{ reportCount === 1 ? '' : 's' }}</p>
        </div>
      </div>

      <p v-if="reportsQueue.length === 0" class="ap-center">Nothing reported right now.</p>

      <div v-for="r in reportsQueue" :key="r.target_type + r.target_id" class="ap-review">
        <div class="ap-report-head">
          <span class="ap-badge muted">{{ TYPE_LABELS[r.target_type] }}</span>
          <span v-if="r.is_removed" class="ap-badge err">Removed</span>
          <span v-if="r.is_suspended" class="ap-badge err">Suspended</span>
          <span class="ap-rmeta">{{ fmtDate(r.newest_report_at) }}</span>
        </div>

        <template v-if="!reportPreview(r).exists">
          <p class="ap-rb">Content no longer exists. The owner already deleted it.</p>
        </template>
        <template v-else>
          <img v-if="reportPreview(r).image" :src="reportPreview(r).image" class="ap-preview" alt="" />
          <h3 class="ap-rh">{{ reportPreview(r).title }}</h3>
          <p v-if="reportPreview(r).subtitle" class="ap-rb">{{ reportPreview(r).subtitle }}</p>
        </template>

        <p class="ap-rmeta">
          {{ r.report_count }} report{{ r.report_count === 1 ? '' : 's' }} · {{ r.reasons.map(reasonLabel).join(', ') }}
        </p>
        <p v-for="(n, i) in r.notes" :key="i" class="ap-note-inline">“{{ n }}”</p>

        <div class="ap-rbtns">
          <template v-if="reportPreview(r).exists && ['post', 'comment', 'event'].includes(r.target_type)">
            <button
              v-if="!r.is_removed" class="ap-reject" :disabled="!!actingOnReport"
              @click="moderate(r, 'remove_content', 'Remove this content? It will be hidden app-wide right away.')"
            >{{ actingOnReport === r.target_type + r.target_id + 'remove_content' ? 'Removing…' : 'Remove content' }}</button>
            <button
              v-else class="ap-link" :disabled="!!actingOnReport"
              @click="moderate(r, 'restore_content')"
            >{{ actingOnReport === r.target_type + r.target_id + 'restore_content' ? 'Restoring…' : 'Restore' }}</button>
          </template>

          <template v-if="reportPreview(r).exists && r.target_type === 'user'">
            <button
              v-if="!r.is_suspended" class="ap-reject" :disabled="!!actingOnReport"
              @click="moderate(r, 'suspend_user', 'Suspend this user? They will be signed out and unable to sign back in.')"
            >{{ actingOnReport === r.target_type + r.target_id + 'suspend_user' ? 'Suspending…' : 'Suspend user' }}</button>
            <button
              v-else class="ap-link" :disabled="!!actingOnReport"
              @click="moderate(r, 'unsuspend_user')"
            >{{ actingOnReport === r.target_type + r.target_id + 'unsuspend_user' ? 'Unsuspending…' : 'Unsuspend' }}</button>
          </template>

          <template v-if="reportPreview(r).exists && r.target_type === 'ad'">
            <button
              v-if="r.preview.campaign_status === 'active'" class="ap-link" :disabled="!!actingOnReport"
              @click="actOnAd(r, 'pause')"
            >{{ actingOnReport === r.target_type + r.target_id + 'pause' ? 'Pausing…' : 'Pause' }}</button>
            <button
              v-else-if="r.preview.campaign_status === 'paused'" class="ap-link" :disabled="!!actingOnReport"
              @click="actOnAd(r, 'resume')"
            >{{ actingOnReport === r.target_type + r.target_id + 'resume' ? 'Resuming…' : 'Resume' }}</button>
            <button
              v-if="r.preview.campaign_status === 'pending_review'" class="ap-reject" :disabled="!!actingOnReport"
              @click="actOnAd(r, 'reject', 'Reject this ad?')"
            >{{ actingOnReport === r.target_type + r.target_id + 'reject' ? 'Rejecting…' : 'Reject' }}</button>
          </template>

          <button
            v-if="!reportPreview(r).exists" class="ap-link" :disabled="!!actingOnReport"
            @click="moderate(r, 'resolve')"
          >{{ actingOnReport === r.target_type + r.target_id + 'resolve' ? 'Resolving…' : 'Resolve' }}</button>
          <button
            class="ap-link" :disabled="!!actingOnReport"
            @click="moderate(r, 'dismiss')"
          >{{ actingOnReport === r.target_type + r.target_id + 'dismiss' ? 'Dismissing…' : 'Dismiss' }}</button>
        </div>
      </div>

      <button v-if="reportsHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreReports">
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>

    <!-- BUG & FEATURE REPORTS -->
    <div v-else-if="view === 'feedback'" class="ap-card ap-wide">
      <div class="ap-top">
        <div>
          <h2 class="ap-h" style="margin:0">Bug reports &amp; ideas</h2>
          <p class="ap-sub">{{ feedbackCount }} new · sent from the app's Settings, or by shaking the phone in a beta build</p>
        </div>
      </div>

      <div class="ap-fb-filters">
        <select v-model="feedbackKind" @change="refreshFeedback">
          <option value="all">All kinds</option>
          <option value="bug">Bugs</option>
          <option value="feature">Ideas</option>
        </select>
        <select v-model="feedbackStatus" @change="refreshFeedback">
          <option value="open">Open</option>
          <option value="all">All statuses</option>
          <option v-for="s in FEEDBACK_STATUSES" :key="s" :value="s">{{ FEEDBACK_STATUS_LABELS[s] }}</option>
        </select>
      </div>

      <p v-if="feedbackQueue.length === 0" class="ap-center">Nothing here right now.</p>

      <div v-for="r in feedbackQueue" :key="r.id" class="ap-review">
        <div class="ap-report-head">
          <span class="ap-badge muted">{{ r.kind === 'bug' ? 'Bug' : 'Idea' }}</span>
          <span class="ap-badge" :class="r.status === 'new' ? 'err' : 'muted'">{{ FEEDBACK_STATUS_LABELS[r.status] }}</span>
          <span v-if="r.source === 'shake'" class="ap-badge muted">Shake</span>
          <span class="ap-rmeta">{{ fmtDate(r.created_at) }}</span>
        </div>

        <h3 class="ap-rh">{{ r.title }}</h3>
        <p class="ap-rb" style="white-space: pre-wrap">{{ r.body }}</p>

        <p class="ap-rmeta">
          {{ r.diagnostics.device || 'unknown device' }} ·
          {{ r.diagnostics.platform }} {{ r.diagnostics.os_version || '' }} ·
          v{{ r.diagnostics.app_version }} ({{ r.diagnostics.build_number }})
          <template v-if="r.image_paths.length"> · {{ r.image_paths.length }} screenshot{{ r.image_paths.length === 1 ? '' : 's' }}</template>
          <template v-if="r.error_log.length"> · {{ r.error_log.length }} error{{ r.error_log.length === 1 ? '' : 's' }}</template>
        </p>

        <div class="ap-rbtns">
          <button class="ap-link" @click="toggleFeedback(r)">
            {{ expandedFeedback === r.id ? 'Hide details' : 'Open' }}
          </button>
        </div>

        <div v-if="expandedFeedback === r.id" class="ap-fb-detail">
          <div v-if="feedbackImages[r.id]?.length" class="ap-fb-shots">
            <a v-for="(u, i) in feedbackImages[r.id]" :key="i" :href="u" target="_blank" rel="noopener">
              <img :src="u" class="ap-preview" alt="Screenshot from the report" />
            </a>
          </div>

          <h4 class="ap-fb-h">Diagnostics</h4>
          <table class="ap-tbl">
            <tbody>
              <tr v-for="(v, k) in r.diagnostics" :key="k">
                <td class="name">{{ k }}</td>
                <td>{{ v }}</td>
              </tr>
            </tbody>
          </table>

          <template v-if="r.error_log.length">
            <h4 class="ap-fb-h">Recent errors</h4>
            <pre v-for="(e, i) in r.error_log" :key="i" class="ap-fb-err">{{ e.at }}
{{ e.message }}{{ e.stack ? '\n' + e.stack : '' }}</pre>
          </template>

          <h4 class="ap-fb-h">Triage</h4>
          <div class="ap-fb-triage">
            <select v-model="feedbackDrafts[r.id].status">
              <option v-for="s in FEEDBACK_STATUSES" :key="s" :value="s">{{ FEEDBACK_STATUS_LABELS[s] }}</option>
            </select>
            <textarea
              v-model="feedbackDrafts[r.id].note"
              rows="3"
              placeholder="Note back to the reporter — they see this in the app when you resolve it."
            ></textarea>
            <button
              class="nile-btn nile-btn--primary"
              :disabled="!!actingOnFeedback"
              @click="saveFeedback(r)"
            >{{ actingOnFeedback === r.id ? 'Saving…' : 'Save' }}</button>
          </div>
          <p class="ap-rmeta">
            Setting this to Resolved or Won't fix notifies the reporter in the app, once.
          </p>
        </div>
      </div>

      <button v-if="feedbackHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreFeedback">
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>

    <!-- ADMIN MANAGEMENT -->
    <div v-else-if="view === 'admins'" class="ap-card ap-wide">
      <div class="ap-top">
        <div>
          <h2 class="ap-h" style="margin:0">Admins</h2>
          <p class="ap-sub">
            {{ adminsList.length }} admin{{ adminsList.length === 1 ? '' : 's' }}:
            everyone here can review ads, moderate reports, and manage this list
          </p>
        </div>
      </div>

      <div v-if="adminsNotice" class="ap-msg ap-ok">{{ adminsNotice }}</div>

      <form class="ap-addrow" @submit.prevent="addAdmin">
        <input
          class="ap-input" v-model="newAdminEmail" type="email" required
          placeholder="name@example.com (must already have a Nile account)"
        />
        <button class="nile-btn nile-btn--primary" type="submit" :disabled="!!adminsBusy">
          {{ adminsBusy === 'add' ? 'Adding…' : 'Add admin' }}
        </button>
      </form>

      <table class="ap-tbl ap-tbl--cards">
        <thead><tr><th>Email</th><th>Added</th><th></th></tr></thead>
        <tbody>
          <tr v-for="a in adminsList" :key="a.user_id">
            <td class="name" data-label="Email">
              {{ a.email }} <span v-if="a.user_id === myUserId" class="ap-badge ok">You</span>
            </td>
            <td data-label="Added">{{ fmtDate(a.created_at) }}</td>
            <td class="ap-rowactions">
              <button
                v-if="a.user_id !== myUserId"
                class="ap-link ap-danger" :disabled="!!adminsBusy || adminsList.length <= 1"
                @click="removeAdmin(a)"
              >{{ adminsBusy === a.user_id ? 'Removing…' : 'Remove' }}</button>
              <span v-else class="ap-rmeta" style="margin:0">Ask another admin to remove you</span>
            </td>
          </tr>
        </tbody>
      </table>

      <template v-if="adminsAudit.length">
        <h3 class="ap-rh" style="margin-top: var(--nile-s-8)">Recent activity</h3>
        <p v-for="(e, i) in adminsAudit" :key="i" class="ap-audit">
          <b>{{ e.actor_email }}</b> {{ e.action }} <b>{{ e.target_email ?? 'unknown' }}</b>
          <span class="ap-audit-when">{{ fmtDateTime(e.created_at) }}</span>
        </p>
      </template>
    </div>

    <!-- FEATURED CURATION -->
    <div v-else-if="view === 'featured'" class="ap-card ap-wide">
      <div class="ap-top">
        <div>
          <h2 class="ap-h" style="margin:0">Featured</h2>
          <p class="ap-sub">
            Curate the “Picked by the Nile team” rails in the app’s Discover and
            onboarding. Order is top-to-bottom.
          </p>
        </div>
      </div>

      <div v-if="featuredNotice" class="ap-msg ap-ok">{{ featuredNotice }}</div>

      <!-- Featured events -->
      <h3 class="ap-rh" style="margin-top: var(--nile-s-6)">Featured events</h3>
      <p v-if="!featuredEvents.length" class="ap-sub">Nothing featured yet — search below to add one.</p>
      <table v-else class="ap-tbl ap-tbl--cards">
        <thead><tr><th>Event</th><th>Host</th><th>Status</th><th>Order</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(e, i) in featuredEvents" :key="e.target_id">
            <td class="name" data-label="Event">
              {{ e.title }} <span v-if="e.missing" class="ap-badge">deleted</span>
            </td>
            <td data-label="Host">{{ e.host_username ? '@' + e.host_username : '—' }}</td>
            <td data-label="Status">{{ e.status ?? '—' }}</td>
            <td data-label="Order" class="ap-rowactions">
              <button class="ap-link" :disabled="i === 0 || !!featuredBusy" @click="moveFeatured('event', i, -1)">↑</button>
              <button class="ap-link" :disabled="i === featuredEvents.length - 1 || !!featuredBusy" @click="moveFeatured('event', i, 1)">↓</button>
            </td>
            <td class="ap-rowactions">
              <button
                class="ap-link ap-danger" :disabled="!!featuredBusy"
                @click="removeFeatured('event', e.target_id, e.title)"
              >{{ featuredBusy === e.target_id ? 'Removing…' : 'Remove' }}</button>
            </td>
          </tr>
        </tbody>
      </table>

      <form class="ap-addrow" @submit.prevent="searchFeatured('event')">
        <input class="ap-input" v-model="eventQuery" type="text" placeholder="Search events by title…" />
        <button class="nile-btn nile-btn--primary" type="submit" :disabled="searchingEvents">
          {{ searchingEvents ? 'Searching…' : 'Search' }}
        </button>
      </form>
      <table v-if="eventHits.length" class="ap-tbl ap-tbl--cards">
        <tbody>
          <tr v-for="h in eventHits" :key="h.target_id">
            <td class="name" data-label="Event">{{ h.title }}</td>
            <td data-label="Host">{{ h.host_username ? '@' + h.host_username : '—' }}</td>
            <td data-label="Status">{{ h.status }}</td>
            <td class="ap-rowactions">
              <span v-if="featuredEventIds.has(h.target_id)" class="ap-badge ok">Featured</span>
              <button
                v-else class="ap-link" :disabled="!!featuredBusy"
                @click="addFeatured('event', h.target_id, h.title)"
              >{{ featuredBusy === h.target_id ? 'Adding…' : 'Add to featured' }}</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Featured creators -->
      <h3 class="ap-rh" style="margin-top: var(--nile-s-8)">Featured creators</h3>
      <p v-if="!featuredCreators.length" class="ap-sub">Nothing featured yet — search below to add one.</p>
      <table v-else class="ap-tbl ap-tbl--cards">
        <thead><tr><th>Creator</th><th>Followers</th><th>Order</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in featuredCreators" :key="c.target_id">
            <td class="name" data-label="Creator">
              {{ c.display_name }} <span class="ap-rmeta">@{{ c.username }}</span>
              <span v-if="c.missing" class="ap-badge">deleted</span>
            </td>
            <td data-label="Followers">{{ c.follower_count }}</td>
            <td data-label="Order" class="ap-rowactions">
              <button class="ap-link" :disabled="i === 0 || !!featuredBusy" @click="moveFeatured('creator', i, -1)">↑</button>
              <button class="ap-link" :disabled="i === featuredCreators.length - 1 || !!featuredBusy" @click="moveFeatured('creator', i, 1)">↓</button>
            </td>
            <td class="ap-rowactions">
              <button
                class="ap-link ap-danger" :disabled="!!featuredBusy"
                @click="removeFeatured('creator', c.target_id, c.username)"
              >{{ featuredBusy === c.target_id ? 'Removing…' : 'Remove' }}</button>
            </td>
          </tr>
        </tbody>
      </table>

      <form class="ap-addrow" @submit.prevent="searchFeatured('creator')">
        <input class="ap-input" v-model="creatorQuery" type="text" placeholder="Search creators by name or @username…" />
        <button class="nile-btn nile-btn--primary" type="submit" :disabled="searchingCreators">
          {{ searchingCreators ? 'Searching…' : 'Search' }}
        </button>
      </form>
      <table v-if="creatorHits.length" class="ap-tbl ap-tbl--cards">
        <tbody>
          <tr v-for="h in creatorHits" :key="h.target_id">
            <td class="name" data-label="Creator">{{ h.display_name }} <span class="ap-rmeta">@{{ h.username }}</span></td>
            <td data-label="Followers">{{ h.follower_count }}</td>
            <td class="ap-rowactions">
              <span v-if="featuredCreatorIds.has(h.target_id)" class="ap-badge ok">Featured</span>
              <button
                v-else class="ap-link" :disabled="!!featuredBusy"
                @click="addFeatured('creator', h.target_id, h.username)"
              >{{ featuredBusy === h.target_id ? 'Adding…' : 'Add to featured' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ADMIN DETAIL MODAL (read-only; approve/reject/pause/resume in-place) -->
    <div v-if="detail" class="ap-overlay" @click.self="closeDetail">
      <div class="ap-modal" role="dialog" aria-modal="true">
        <div class="ap-top">
          <h3 class="ap-rh" style="margin:0">{{ detail.ad_creatives?.[0]?.headline ?? detail.name }}</h3>
          <button type="button" class="ap-x" aria-label="Close" @click="closeDetail">×</button>
        </div>
        <video
          v-if="detail.ad_creatives?.[0]?.kind === 'video'"
          :src="adVideoUrl(detail.ad_creatives[0])"
          class="ap-preview" controls muted playsinline preload="metadata"
        ></video>
        <img v-else-if="detail.ad_creatives?.[0]" :src="detail.ad_creatives[0].image_url ?? ''" class="ap-preview" alt="" />
        <p v-if="detail.ad_creatives?.[0]?.body" class="ap-rb">{{ detail.ad_creatives[0].body }}</p>
        <dl class="ap-dl">
          <div><dt>Advertiser</dt><dd>{{ detail.advertiser_accounts?.name ?? 'Host boost' }}<template v-if="detail.advertiser_accounts"> ({{ detail.advertiser_accounts.contact_email }})</template></dd></div>
          <div><dt>Status</dt><dd><span class="ap-badge" :class="statusClass(detail.status)">{{ statusLabel(detail.status) }}</span></dd></div>
          <div><dt>{{ detail.placement === 'lobby' ? 'Price' : 'Budget' }}</dt><dd>{{ money(detail.budget_cents) }}</dd></div>
          <div v-if="detail.placement === 'lobby'"><dt>Event</dt><dd>{{ detail.events?.title }}{{ detail.events?.scheduled_at ? ' · ' + fmtDateTime(detail.events.scheduled_at) : '' }}</dd></div>
          <div v-else><dt>Flight</dt><dd>{{ fmtDate(detail.starts_at) }} – {{ fmtDate(detail.ends_at) }}</dd></div>
          <div v-if="detail.placement !== 'lobby'"><dt>Topics</dt><dd>{{ topicsFor(detail) }}</dd></div>
          <div v-if="detail.ad_creatives?.[0]"><dt>Click URL</dt><dd><a :href="detail.ad_creatives[0].click_url" target="_blank" rel="noopener noreferrer">{{ detail.ad_creatives[0].click_url }}</a></dd></div>
          <div><dt>Submitted</dt><dd>{{ fmtDate(detail.created_at) }}</dd></div>
        </dl>

        <template v-if="detail.status === 'pending_review'">
          <div v-if="!rejectMode" class="ap-rbtns">
            <button class="nile-btn nile-btn--primary" :disabled="actingOn === detail.id + 'approve'" @click="act(detail, 'approve')">
              {{ actingOn === detail.id + 'approve' ? 'Approving…' : 'Approve & charge' }}
            </button>
            <button class="ap-reject" @click="rejectMode = true">Reject…</button>
          </div>
          <template v-else>
            <label class="ap-label">Reason (optional, shared with the advertiser)</label>
            <textarea
              class="ap-input ap-textarea" v-model="rejectNote" maxlength="300"
              placeholder="e.g. Image quality is too low, or the landing page doesn't match the ad."
            ></textarea>
            <div class="ap-rbtns">
              <button class="ap-reject" :disabled="actingOn === detail.id + 'reject'" @click="act(detail, 'reject', rejectNote)">
                {{ actingOn === detail.id + 'reject' ? 'Rejecting…' : 'Confirm reject' }}
              </button>
              <button type="button" class="ap-link" @click="rejectMode = false">Back</button>
            </div>
          </template>
        </template>
        <div v-else class="ap-rbtns">
          <button class="nile-btn nile-btn--primary" :disabled="!!actingOn" @click="act(detail, detail.status === 'active' ? 'pause' : 'resume')">
            {{ detail.status === 'active' ? 'Pause' : 'Resume' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Wrapper is wide enough for the dashboard/admin tables; narrow forms (auth,
   setup, builder) stay capped + centered via .ap-card below. */
.ap { max-width: 880px; margin: 0 auto; font-family: var(--nile-font-body); color: var(--nile-txt-primary); }
.ap-card { background: var(--nile-bg-surface); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-lg); padding: var(--nile-s-8);
  max-width: 520px; margin-left: auto; margin-right: auto; }
.ap-wide { max-width: 880px; }
.ap-h { font-family: var(--nile-font-display); font-size: 24px; margin: 0 0 var(--nile-s-5); letter-spacing: -0.01em; }
.ap-sub { color: var(--nile-txt-secondary); font-size: 14px; margin: 4px 0 0; }
.ap-label { display: block; font-size: 12px; color: var(--nile-txt-secondary);
  text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 var(--nile-s-2); }
.ap-input {
  width: 100%; background: var(--nile-bg-raised); border: 1px solid var(--nile-border);
  color: var(--nile-txt-primary); border-radius: var(--nile-r-md); padding: 13px;
  font-size: 15px; margin-bottom: var(--nile-s-3); font-family: inherit;
}
.ap-textarea { resize: vertical; min-height: 84px; }
.ap-full { width: 100%; margin-top: var(--nile-s-2); }
.ap-new { display: inline-block; width: auto; margin-bottom: var(--nile-s-6); }
.ap-new-row { display: flex; align-items: center; gap: var(--nile-s-5); margin-bottom: var(--nile-s-6); }
.ap-new-row .ap-new { margin-bottom: 0; }
.ap-link { background: none; border: none; color: var(--nile-txt-secondary);
  cursor: pointer; font-size: 14px; text-decoration: underline; padding: 0; font-family: inherit; }
.ap-note { color: var(--nile-txt-tertiary); font-size: 12px; text-align: center;
  margin-top: var(--nile-s-4); line-height: 1.5; }
.ap-msg { padding: 13px 15px; border-radius: var(--nile-r-md); font-size: 14px; margin-bottom: var(--nile-s-4); }
.ap-err { background: rgba(239, 68, 68, 0.12); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
.ap-ok { background: rgba(200, 255, 0, 0.1); color: var(--nile-volt); border: 1px solid rgba(200, 255, 0, 0.3); }
.ap-center { text-align: center; color: var(--nile-txt-secondary); padding: 48px 0; }
.ap-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--nile-s-6); }

.ap-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: var(--nile-s-6); }
.ap-opt {
  background: var(--nile-bg-raised); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-md); padding: 15px 8px; text-align: center; cursor: pointer;
  font-size: 16px; font-weight: 600; color: var(--nile-txt-primary); font-family: inherit;
  transition: border-color .15s, background .15s;
}
.ap-opt[aria-selected='true'] { border-color: var(--nile-volt); background: rgba(200, 255, 0, 0.08); }

/* Sponsorship event picker (0079) */
.ap-spons-list {
  display: flex; flex-direction: column; gap: 8px; margin-bottom: var(--nile-s-6);
  max-height: 340px; overflow-y: auto;
}
.ap-spons-row {
  display: flex; align-items: center; gap: 12px; text-align: left; width: 100%;
  background: var(--nile-bg-raised); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-md); padding: 10px; cursor: pointer;
  color: var(--nile-txt-primary); font-family: inherit;
  transition: border-color .15s, background .15s;
}
.ap-spons-row[aria-selected='true'] { border-color: var(--nile-volt); background: rgba(200, 255, 0, 0.08); }
.ap-spons-cover {
  width: 72px; aspect-ratio: 4 / 3; object-fit: cover; flex: none;
  border-radius: var(--nile-r-sm, 8px); background: var(--nile-bg-surface);
}
.ap-spons-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ap-spons-info b { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-spons-info small { color: var(--nile-txt-secondary); font-size: 13px; }

.ap-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: var(--nile-s-6); }
.ap-chip {
  background: var(--nile-bg-raised); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-pill); padding: 8px 14px; font-size: 14px; cursor: pointer;
  color: var(--nile-txt-primary); font-family: inherit; transition: border-color .15s, background .15s;
}
.ap-chip[aria-selected='true'] { border-color: var(--nile-volt); background: rgba(200, 255, 0, 0.08); }

.ap-crop { margin-bottom: var(--nile-s-4); }
.ap-crop-frame {
  width: 100%; aspect-ratio: 4 / 3; position: relative; overflow: hidden;
  border-radius: var(--nile-r-md); border: 1px solid var(--nile-volt);
  background: var(--nile-bg-raised); cursor: grab; touch-action: none;
}
.ap-crop-frame:active { cursor: grabbing; }
.ap-crop-frame img { position: absolute; top: 0; left: 0; max-width: none;
  user-select: none; pointer-events: none; }
.ap-crop-zoom { width: 100%; margin: var(--nile-s-3) 0; accent-color: var(--nile-volt); }

.ap-preview { width: 100%; aspect-ratio: 4 / 3; object-fit: cover;
  border-radius: var(--nile-r-md); border: 1px solid var(--nile-border);
  margin-bottom: var(--nile-s-4); background: var(--nile-bg-raised); }

.ap-tbl { width: 100%; border-collapse: collapse; font-size: 14px; }
.ap-tbl th { text-align: left; color: var(--nile-txt-tertiary); font-weight: 600; font-size: 12px;
  text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid var(--nile-border); }
.ap-tbl td { padding: 14px 10px; border-bottom: 1px solid var(--nile-border);
  color: var(--nile-txt-secondary); white-space: nowrap; }
/* Name column is the flexible one — let it wrap instead of the numeric cells. */
.ap-tbl td.name { color: var(--nile-txt-primary); font-weight: 600;
  white-space: normal; overflow-wrap: anywhere; }
.ap-badge { padding: 4px 10px; border-radius: var(--nile-r-pill); font-size: 12px; font-weight: 600; white-space: nowrap; }
.ap-badge.ok { background: rgba(200, 255, 0, 0.12); color: var(--nile-volt); }
.ap-badge.warn { background: rgba(245, 158, 11, 0.14); color: var(--nile-warning); }
.ap-badge.err { background: rgba(239, 68, 68, 0.12); color: #fca5a5; }
.ap-badge.muted { background: var(--nile-bg-raised); color: var(--nile-txt-secondary); }

/* Folder tabs — one strip above the cards; the active tab merges into the card
   below it by matching its background and masking the shared 1px border. */
.ap-tabs {
  display: flex; align-items: flex-end; gap: 2px; max-width: 880px;
  margin: 0 auto -1px; padding: 0 var(--nile-s-4);
  border-bottom: 1px solid var(--nile-border); position: relative; z-index: 1;
  overflow-x: auto; scrollbar-width: none;
}
.ap-tabs::-webkit-scrollbar { display: none; }
.ap-tabs--narrow { max-width: 520px; }
.ap-tabs-gap { flex: 1 1 auto; min-width: var(--nile-s-4); }
.ap-tab {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  background: transparent; border: 1px solid transparent; border-bottom: none;
  border-radius: var(--nile-r-md) var(--nile-r-md) 0 0;
  padding: 10px 16px; margin-bottom: -1px;
  font-family: inherit; font-size: 14px; font-weight: 600;
  color: var(--nile-txt-tertiary); cursor: pointer;
  transition: color .15s, background .15s;
}
.ap-tab:hover { color: var(--nile-txt-primary); background: var(--nile-bg-raised); }
.ap-tab.is-active {
  background: var(--nile-bg-surface); border-color: var(--nile-border);
  color: var(--nile-txt-primary); box-shadow: 0 1px 0 0 var(--nile-bg-surface);
}
.ap-tab--quiet { font-weight: 500; }
.ap-tab-count {
  background: rgba(200, 255, 0, 0.14); color: var(--nile-volt);
  border-radius: var(--nile-r-pill); padding: 1px 7px; font-size: 11px; font-weight: 700;
}
/* Cards under the strip square off their top corners so it reads as one surface. */
.ap-tabs + .ap-card { border-top-left-radius: 0; border-top-right-radius: 0; }
.ap-review { border: 1px solid var(--nile-border); border-radius: var(--nile-r-md);
  padding: var(--nile-s-5); margin-bottom: var(--nile-s-5); }
.ap-report-head { display: flex; align-items: center; gap: var(--nile-s-3); margin-bottom: var(--nile-s-3); }
.ap-rh { font-family: var(--nile-font-display); font-size: 18px; margin: 0 0 var(--nile-s-2); }
.ap-rb { color: var(--nile-txt-secondary); font-size: 14px; margin: 0 0 var(--nile-s-3); }
.ap-rmeta { color: var(--nile-txt-tertiary); font-size: 12px; margin: 0 0 var(--nile-s-4);
  line-height: 1.6; overflow-wrap: anywhere; }
.ap-rmeta a { color: var(--nile-txt-secondary); }
.ap-rbtns { display: flex; gap: var(--nile-s-3); }
.ap-reject { background: rgba(239, 68, 68, 0.12); color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--nile-r-md);
  padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }

/* Admin management: add-by-email row + activity log */
.ap-addrow { display: flex; gap: var(--nile-s-3); align-items: stretch; margin-bottom: var(--nile-s-6); }
.ap-addrow .ap-input { margin-bottom: 0; flex: 1; }
.ap-addrow .nile-btn { flex: none; white-space: nowrap; }
.ap-audit { color: var(--nile-txt-secondary); font-size: 13px; margin: 0 0 var(--nile-s-2); line-height: 1.5; }
.ap-audit b { color: var(--nile-txt-primary); font-weight: 600; }
.ap-audit-when { color: var(--nile-txt-tertiary); font-size: 12px; margin-left: 8px; }

.ap-clickable { cursor: pointer; }
.ap-danger { color: #fca5a5; }
.ap-rowactions { white-space: nowrap; }
.ap-rowactions .ap-link + .ap-link { margin-left: 12px; }
.ap-note-inline { color: var(--nile-txt-tertiary); font-size: 12px; font-weight: 400;
  margin-top: 4px; line-height: 1.4; max-width: 340px; }

/* Bug reports & ideas */
.ap-fb-filters { display: flex; gap: var(--nile-s-3); margin-bottom: var(--nile-s-5); flex-wrap: wrap; }
.ap-fb-detail { border-top: 1px solid var(--nile-border); margin-top: var(--nile-s-4);
  padding-top: var(--nile-s-4); }
.ap-fb-h { font-size: 13px; text-transform: uppercase; letter-spacing: 1.2px;
  color: var(--nile-txt-tertiary); margin: var(--nile-s-4) 0 var(--nile-s-2); }
.ap-fb-shots { display: flex; gap: var(--nile-s-3); flex-wrap: wrap; }
.ap-fb-shots img { width: 140px; aspect-ratio: 9 / 16; object-fit: cover; }
.ap-fb-err { background: var(--nile-bg-page); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-sm); padding: var(--nile-s-3); font-size: 11px;
  line-height: 1.45; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  color: var(--nile-txt-secondary); margin: 0 0 var(--nile-s-2); max-height: 220px; }
.ap-fb-triage { display: grid; gap: var(--nile-s-3); max-width: 520px; }
.ap-fb-triage textarea { width: 100%; resize: vertical; }

.ap-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  padding: var(--nile-s-4); z-index: 50; }
.ap-modal { background: var(--nile-bg-surface); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-lg); padding: var(--nile-s-6); width: 100%;
  max-width: 520px; max-height: 90vh; overflow-y: auto; }
.ap-x { background: none; border: none; color: var(--nile-txt-secondary);
  font-size: 24px; line-height: 1; cursor: pointer; padding: 0 4px; font-family: inherit; }
.ap-dl { display: grid; gap: 8px; margin: 0 0 var(--nile-s-5); font-size: 14px; }
.ap-dl div { display: flex; gap: 10px; }
.ap-dl dt { flex: none; width: 92px; color: var(--nile-txt-tertiary); font-size: 12px;
  text-transform: uppercase; letter-spacing: 0.04em; padding-top: 2px; }
.ap-dl dd { margin: 0; color: var(--nile-txt-secondary); overflow-wrap: anywhere; }
.ap-dl a { color: var(--nile-txt-secondary); }

/* Retry affordance inside the error banner */
.ap-msg.ap-err { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ap-retry { flex: none; background: none; border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5; border-radius: var(--nile-r-sm); padding: 4px 12px; font-size: 13px;
  cursor: pointer; font-family: inherit; }

/* Load more */
.ap-loadmore { display: block; width: 100%; margin-top: var(--nile-s-4);
  background: var(--nile-bg-raised); border: 1px solid var(--nile-border);
  color: var(--nile-txt-primary); border-radius: var(--nile-r-md); padding: 12px;
  font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
.ap-loadmore:disabled { opacity: 0.6; cursor: default; }

/* Activity chart */
.ap-chart { margin: 0 0 var(--nile-s-6); }
.ap-chart-cap { display: flex; flex-wrap: wrap; align-items: center; gap: var(--nile-s-5); margin: 0 0 var(--nile-s-2); font-size: 12px; color: var(--nile-txt-secondary); }
.ap-chart-legend { display: inline-flex; align-items: center; gap: 6px; }
.ap-chart-legend b { color: var(--nile-txt-primary); }
.ap-chart-legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.ap-chart-filter { color: var(--nile-txt-tertiary); }
.ap-chart-export { margin-left: auto; }
.ap-row-selected td { background: rgba(200, 255, 0, 0.05); }
.dot.impr { background: var(--nile-volt); }
.dot.clk { background: var(--nile-coral); }
.ap-chart-svg { width: 100%; height: 120px; display: block; }
.ap-chart-svg .ln { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
.ap-chart-svg .ln.impr { stroke: var(--nile-volt); }
.ap-chart-svg .ln.clk { stroke: var(--nile-coral); }
.ap-chart-axis { display: flex; justify-content: space-between; margin-top: 4px;
  font-size: 11px; color: var(--nile-txt-tertiary); }

/* ── Responsive: tablets & below (≤760px) ────────────────────────────────────
   The 7-column tables get cramped well before phone widths, so collapse them
   to stacked cards here (keeps the numeric cells from bleeding). */
@media (max-width: 760px) {
  .ap-tbl--cards, .ap-tbl--cards thead, .ap-tbl--cards tbody,
  .ap-tbl--cards tr, .ap-tbl--cards td { display: block; width: 100%; }
  .ap-tbl--cards thead { position: absolute; left: -9999px; }
  .ap-tbl--cards tr { border: 1px solid var(--nile-border);
    border-radius: var(--nile-r-md); padding: var(--nile-s-3) var(--nile-s-4);
    margin-bottom: var(--nile-s-3); }
  .ap-tbl--cards td { border: none; padding: 6px 0;
    display: flex; justify-content: space-between; gap: 12px; text-align: right;
    white-space: normal; }
  .ap-tbl--cards td[data-label]::before { content: attr(data-label);
    color: var(--nile-txt-tertiary); font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.04em; text-align: left; flex: none; }
  .ap-tbl--cards td.name { justify-content: flex-start; text-align: left; font-size: 15px; }
  .ap-tbl--cards td.name::before { display: none; }
  .ap-tbl--cards td.ap-rowactions { justify-content: flex-end; }
  .ap-rowactions .ap-link + .ap-link { margin-left: 16px; }
}

/* ── Responsive: phones (≤480px) ─────────────────────────────────────────── */
@media (max-width: 480px) {
  .ap-card { padding: var(--nile-s-5); }
  .ap-h { font-size: 21px; }
  .ap-top { flex-wrap: wrap; gap: var(--nile-s-3); }
  /* Tabs stay one horizontally-scrollable row rather than wrapping. */
  .ap-tabs { padding: 0 var(--nile-s-2); }
  .ap-tab { padding: 9px 12px; font-size: 13px; }
  .ap-tabs-gap { min-width: 0; }
  .ap-new { width: 100%; text-align: center; }
  .ap-grid { gap: 8px; }
  .ap-opt { padding: 13px 6px; font-size: 15px; }
  .ap-modal { padding: var(--nile-s-5); }
  .ap-dl div { flex-direction: column; gap: 2px; }
  .ap-dl dt { width: auto; }
  .ap-rbtns { flex-wrap: wrap; }
  .ap-rbtns .nile-btn, .ap-reject { flex: 1 1 auto; text-align: center; }
  .ap-note-inline { max-width: none; }
  .ap-addrow { flex-direction: column; }
  .ap-addrow .nile-btn { width: 100%; }
}
</style>
