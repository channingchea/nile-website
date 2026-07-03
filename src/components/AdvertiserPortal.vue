<script setup lang="ts">
/*
  Self-serve advertiser portal (A-4 Part 2) — single Vue island served at
  ads.joinnile.com. One component with internal view state so the whole auth-
  gated flow is a client-side SPA on top of the static Astro site:

    auth   → email+password sign up / sign in (separate from the app's social login)
    setup  → brand name, contact email, optional Nile-profile link
    dash   → list campaigns + reporting (get_advertiser_performance RPC)
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
  review_note: string | null; created_at: string;
};
type DailyPoint = { day: string; impressions: number; clicks: number };

const PAGE = 15; // keyset page size (mirrors the app's Paged<T> convention)

const sb = supabase();

const view = ref<"loading" | "auth" | "setup" | "dash" | "build" | "admin">("loading");
const msg = ref("");
const busy = ref(false);
const account = ref<Account | null>(null);
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
  if (!blob) { msg.value = "Couldn't crop that image — try another file."; return; }
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
  ad_creatives: { image_url: string; headline: string; body: string; click_url: string }[];
  ad_targeting: { topic_ids: string[] | null }[];
  advertiser_accounts: { name: string; contact_email: string } | null;
};
const queue = ref<AdminRow[]>([]);
const adminCursor = ref<string | null>(null);
const adminHasMore = ref(false);
const topicNames = ref<Record<string, string>>({});
const actingOn = ref("");

const ADMIN_SELECT =
  "id, name, status, budget_cents, starts_at, ends_at, created_at, ad_creatives(image_url, headline, body, click_url), ad_targeting(topic_ids), advertiser_accounts(name, contact_email)";
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
  msg.value = "";
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

const pendingRows = computed(() => queue.value.filter((r) => r.status === "pending_review"));
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
      .select("ad_creatives(image_url, headline, body, click_url), ad_targeting(topic_ids)")
      .eq("id", r.campaign_id).maybeSingle(),
  ]);
  const cr = (camp as any)?.ad_creatives?.[0];
  const tg = (camp as any)?.ad_targeting?.[0];
  if (!cr) { msg.value = "Couldn't load this ad."; view.value = "dash"; return; }
  headline.value = cr.headline ?? "";
  body.value = cr.body ?? "";
  clickUrl.value = cr.click_url ?? "";
  existingImageUrl.value = cr.image_url ?? "";
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
async function submitCampaign() {
  msg.value = "";
  if (cropSrc.value) { msg.value = "Finish cropping the image first."; return; }
  if (!file.value && !editingId.value) { msg.value = "Add a creative image."; return; }
  try { const u = new URL(clickUrl.value); if (u.protocol !== "https:") throw 0; }
  catch { msg.value = "Click URL must start with https://"; return; }

  busy.value = true;
  try {
    // EDIT: update creative + targeting in place (RLS allows this only while
    // the campaign is pending_review). No payment change — budget is locked.
    if (editingId.value) {
      const imageUrl = file.value ? await uploadCreative() : existingImageUrl.value;
      const { error: crErr } = await sb.from("ad_creatives")
        .update({
          image_url: imageUrl,
          headline: headline.value.trim(),
          body: body.value.trim(),
          click_url: clickUrl.value.trim(),
        })
        .eq("campaign_id", editingId.value);
      if (crErr) throw crErr;
      const { error: tgErr } = await sb.from("ad_targeting")
        .upsert({ campaign_id: editingId.value, topic_ids: [...selectedTopics.value] });
      if (tgErr) throw tgErr;
      busy.value = false;
      await openDashboard();
      return;
    }

    // CREATE:
    // 1) Upload the creative image.
    const publicUrl = await uploadCreative();

    // 2) Function (service role) creates campaign+creative+targeting, returns Checkout URL.
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(CREATE_AD_PAYMENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sess.session?.access_token}`,
      },
      body: JSON.stringify({
        advertiser_account_id: account.value!.id,
        image_url: publicUrl,
        headline: headline.value.trim(),
        body: body.value.trim(),
        click_url: clickUrl.value.trim(),
        topic_ids: [...selectedTopics.value],
        budget_cents: budgetCents.value,
        duration_days: durationDays.value,
      }),
    });
    const out = await res.json();
    if (!res.ok || !out.checkout_url) throw new Error(out.error || "Payment setup failed");
    window.location.href = out.checkout_url;
  } catch (e: any) {
    msg.value = String(e?.message || e);
    busy.value = false;
  }
}
</script>

<template>
  <div class="ap">
    <div v-if="msg" class="ap-msg ap-err">
      <span>{{ msg }}</span>
      <button v-if="view === 'dash'" type="button" class="ap-retry" @click="openDashboard">Retry</button>
      <button v-else-if="view === 'admin'" type="button" class="ap-retry" @click="openAdmin">Retry</button>
    </div>
    <div v-if="returnBanner" class="ap-msg ap-ok">
      Payment received — your ad is now in review. You'll see it as Active here once approved.
    </div>

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
      <input class="ap-input" v-model="profileUsername" placeholder="@yourbrand — leave blank to skip" />
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
        <div class="ap-actions">
          <button v-if="isAdmin" class="ap-link" @click="openAdmin">Review queue</button>
          <button class="ap-link" @click="signOut">Sign out</button>
        </div>
      </div>

      <button class="nile-btn nile-btn--primary ap-new" @click="openBuilder">+ New campaign</button>

      <!-- Activity over time (impressions vs clicks) -->
      <figure v-if="chart" class="ap-chart">
        <figcaption class="ap-chart-cap">
          <span class="ap-chart-legend"><i class="dot impr"></i>Impressions
            <b>{{ chart.totalImpr }}</b></span>
          <span class="ap-chart-legend"><i class="dot clk"></i>Clicks
            <b>{{ chart.totalClk }}</b></span>
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
            <tr v-for="r in rows" :key="r.campaign_id">
              <td class="name" data-label="Campaign">
                {{ r.headline || r.name }}
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

      <label class="ap-label">
        Creative image (shown 4:3 in feed, max 5MB{{ editingId ? ' — leave as-is to keep current' : '' }})
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

      <label class="ap-label">Headline ({{ headline.length }}/{{ HEADLINE_MAX }})</label>
      <input class="ap-input" v-model="headline" :maxlength="HEADLINE_MAX" placeholder="Fresh roast, delivered weekly" required />

      <label class="ap-label">Body ({{ body.length }}/{{ BODY_MAX }})</label>
      <textarea class="ap-input ap-textarea" v-model="body" :maxlength="BODY_MAX" placeholder="Small-batch coffee shipped to your door. First bag 20% off." required></textarea>

      <label class="ap-label">Click-through URL (https)</label>
      <input class="ap-input" v-model="clickUrl" type="url" placeholder="https://acme.com/offer" required />

      <label class="ap-label">Target topics (optional — none = show to everyone)</label>
      <div v-if="topics.length" class="ap-chips">
        <button
          v-for="t in topics" :key="t.id" type="button" class="ap-chip"
          :aria-selected="selectedTopics.has(t.id)" @click="toggleTopic(t.id)"
        >{{ t.name }}</button>
      </div>
      <p v-else class="ap-note" style="text-align:left">No topics available — your ad will show to everyone.</p>

      <template v-if="!editingId">
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
        {{ busy ? (editingId ? 'Saving…' : 'Setting up…') : (editingId ? 'Save changes' : 'Continue to payment') }}
      </button>
      <p class="ap-note" v-if="editingId">
        Your ad stays in review after saving — budget and duration can't change
        because your card is already authorized.
      </p>
      <p class="ap-note" v-else>
        You'll pay securely via Stripe. Your card is only authorized now — it's
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
        <div class="ap-actions">
          <button v-if="account" class="ap-link" @click="openDashboard">My dashboard</button>
          <button class="ap-link" @click="signOut">Sign out</button>
        </div>
      </div>

      <p v-if="pendingRows.length === 0" class="ap-center">Nothing awaiting review.</p>
      <div v-for="r in pendingRows" :key="r.id" class="ap-review">
        <img v-if="r.ad_creatives?.[0]" :src="r.ad_creatives[0].image_url" class="ap-preview ap-clickable" alt="" @click="openDetail(r)" />
        <h3 class="ap-rh ap-clickable" @click="openDetail(r)">{{ r.ad_creatives?.[0]?.headline ?? r.name }}</h3>
        <p class="ap-rb">{{ r.ad_creatives?.[0]?.body }}</p>
        <p class="ap-rmeta">
          <span>{{ r.advertiser_accounts?.name }} ({{ r.advertiser_accounts?.contact_email }})</span> ·
          <span>{{ money(r.budget_cents) }}</span> ·
          <span>Topics: {{ topicsFor(r) }}</span> ·
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

    <!-- ADMIN DETAIL MODAL (read-only; approve/reject/pause/resume in-place) -->
    <div v-if="detail" class="ap-overlay" @click.self="closeDetail">
      <div class="ap-modal" role="dialog" aria-modal="true">
        <div class="ap-top">
          <h3 class="ap-rh" style="margin:0">{{ detail.ad_creatives?.[0]?.headline ?? detail.name }}</h3>
          <button type="button" class="ap-x" aria-label="Close" @click="closeDetail">×</button>
        </div>
        <img v-if="detail.ad_creatives?.[0]" :src="detail.ad_creatives[0].image_url" class="ap-preview" alt="" />
        <p v-if="detail.ad_creatives?.[0]?.body" class="ap-rb">{{ detail.ad_creatives[0].body }}</p>
        <dl class="ap-dl">
          <div><dt>Advertiser</dt><dd>{{ detail.advertiser_accounts?.name ?? 'Host boost' }}<template v-if="detail.advertiser_accounts"> ({{ detail.advertiser_accounts.contact_email }})</template></dd></div>
          <div><dt>Status</dt><dd><span class="ap-badge" :class="statusClass(detail.status)">{{ statusLabel(detail.status) }}</span></dd></div>
          <div><dt>Budget</dt><dd>{{ money(detail.budget_cents) }}</dd></div>
          <div><dt>Flight</dt><dd>{{ fmtDate(detail.starts_at) }} – {{ fmtDate(detail.ends_at) }}</dd></div>
          <div><dt>Topics</dt><dd>{{ topicsFor(detail) }}</dd></div>
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
            <label class="ap-label">Reason (optional — shared with the advertiser)</label>
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

.ap-actions { display: flex; gap: var(--nile-s-4); }
.ap-review { border: 1px solid var(--nile-border); border-radius: var(--nile-r-md);
  padding: var(--nile-s-5); margin-bottom: var(--nile-s-5); }
.ap-rh { font-family: var(--nile-font-display); font-size: 18px; margin: 0 0 var(--nile-s-2); }
.ap-rb { color: var(--nile-txt-secondary); font-size: 14px; margin: 0 0 var(--nile-s-3); }
.ap-rmeta { color: var(--nile-txt-tertiary); font-size: 12px; margin: 0 0 var(--nile-s-4);
  line-height: 1.6; overflow-wrap: anywhere; }
.ap-rmeta a { color: var(--nile-txt-secondary); }
.ap-rbtns { display: flex; gap: var(--nile-s-3); }
.ap-reject { background: rgba(239, 68, 68, 0.12); color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--nile-r-md);
  padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }

.ap-clickable { cursor: pointer; }
.ap-danger { color: #fca5a5; }
.ap-rowactions { white-space: nowrap; }
.ap-rowactions .ap-link + .ap-link { margin-left: 12px; }
.ap-note-inline { color: var(--nile-txt-tertiary); font-size: 12px; font-weight: 400;
  margin-top: 4px; line-height: 1.4; max-width: 340px; }

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
.ap-chart-cap { display: flex; gap: var(--nile-s-5); margin: 0 0 var(--nile-s-2); font-size: 12px; color: var(--nile-txt-secondary); }
.ap-chart-legend { display: inline-flex; align-items: center; gap: 6px; }
.ap-chart-legend b { color: var(--nile-txt-primary); }
.ap-chart-legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
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
  .ap-actions { flex-wrap: wrap; }
  .ap-new { width: 100%; text-align: center; }
  .ap-grid { gap: 8px; }
  .ap-opt { padding: 13px 6px; font-size: 15px; }
  .ap-modal { padding: var(--nile-s-5); }
  .ap-dl div { flex-direction: column; gap: 2px; }
  .ap-dl dt { width: auto; }
  .ap-rbtns { flex-wrap: wrap; }
  .ap-rbtns .nile-btn, .ap-reject { flex: 1 1 auto; text-align: center; }
  .ap-note-inline { max-width: none; }
}
</style>
