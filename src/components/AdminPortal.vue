<script setup lang="ts">
/*
  Nile staff admin portal — joinnile.com/admin.

  Seven queues that used to live inside AdvertiserPortal.vue as isAdmin-gated
  view states, sharing the advertiser's tab strip and 520px card chrome. They
  are the same queues doing the same things; what changed is the shell around
  them and the URL they live at.

  Every /admin page mounts THIS component with a different `section` prop, so a
  deep link boots straight into its queue with no overview flash, and the
  sidebar entries are real <a href> — back/forward and open-in-new-tab work.

    overview  → queue tiles + platform stats (one get_admin_overview call, 0130)
    review    → pending_review campaigns: approve / reject / pause / resume
    spotcheck → trusted lobby offers already in front of a host; pull-back only
    reports   → get_report_queue, per-type actions via the moderate-report fn
    appeals   → contested removals and suspensions; decide_appeal (0119b)
    feedback  → bug reports and ideas from the app (0077)
    featured  → the "Picked by the Nile team" rails (manage-featured)
    admins    → who is an admin, four-eyes propose/approve (manage-admins, 0126)

  Access is checked twice and neither check here is the real one: the `admins`
  own-row RLS lookup only decides what to render, and every action goes through
  an edge function or a security-definer RPC that re-checks server side.
  Deleting someone's admins row kills their access on the next request, not on
  the next reload.
*/
import { ref, computed, onMounted, onUnmounted } from "vue";
import {
  supabase,
  REVIEW_AD_CAMPAIGN_URL,
  MODERATE_REPORT_URL,
  MANAGE_ADMINS_URL,
  MANAGE_FEATURED_URL,
} from "../lib/supabase";

type Section =
  | "overview" | "review" | "spotcheck" | "reports"
  | "appeals" | "feedback" | "featured" | "admins";

const props = defineProps<{ section: Section }>();

const PAGE = 15; // keyset page size (mirrors the app's Paged<T> convention)
const sb = supabase();

// ── shell ───────────────────────────────────────────────────────────────────
const state = ref<"loading" | "signedout" | "denied" | "ready">("loading");
const msg = ref("");
const sectionLoading = ref(false);
const loadingMore = ref(false);
const myEmail = ref("");
const myUserId = ref("");

onMounted(() => {
  boot();
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => window.removeEventListener("keydown", onKey));

async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session) { state.value = "signedout"; return; }
  myEmail.value = data.session.user.email ?? "";
  myUserId.value = data.session.user.id;
  // Own-row RLS on `admins` means this returns a row only for admins.
  const { data: adminRow } = await sb.from("admins").select("user_id").maybeSingle();
  if (!adminRow) { state.value = "denied"; return; }
  state.value = "ready";
  // Badges and the section body are independent: a slow stats call must not
  // hold up the queue the admin actually came here for.
  loadOverview();
  await loadSection();
}

async function loadSection() {
  msg.value = "";
  if (props.section === "overview") { await loadOverview(); return; }
  sectionLoading.value = true;
  try {
    if (props.section === "review") await loadReview();
    else if (props.section === "spotcheck") await loadSpotcheck();
    else if (props.section === "reports") await loadReports();
    else if (props.section === "appeals") await refreshAppeals();
    else if (props.section === "feedback") await refreshFeedback();
    else if (props.section === "featured") await reloadFeatured();
    else if (props.section === "admins") await reloadAdmins();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    sectionLoading.value = false;
  }
}

async function signOut() {
  await sb.auth.signOut();
  window.location.href = "/advertise/portal";
}

const nav = computed(() => {
  const q = overview.value?.queues;
  return [
    { title: "", items: [
      { key: "overview", label: "Overview", href: "/admin", count: 0 },
    ] },
    { title: "Ads", items: [
      { key: "review", label: "Review queue", href: "/admin/review", count: q?.pending_review ?? 0 },
      { key: "spotcheck", label: "Spot-check", href: "/admin/spot-check", count: q?.spotcheck ?? 0 },
    ] },
    { title: "Moderation", items: [
      { key: "reports", label: "Reported content", href: "/admin/reports", count: q?.reports ?? 0 },
      { key: "appeals", label: "Appeals", href: "/admin/appeals", count: q?.appeals ?? 0 },
      { key: "feedback", label: "Bug reports", href: "/admin/bug-reports", count: q?.feedback ?? 0 },
    ] },
    { title: "Settings", items: [
      { key: "featured", label: "Featured", href: "/admin/featured", count: 0 },
      { key: "admins", label: "Admins", href: "/admin/admins", count: 0 },
    ] },
  ];
});

// ── shared formatting ───────────────────────────────────────────────────────
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const num = (n: number) => n.toLocaleString();
const fmtDate = (s: string) => new Date(s).toLocaleDateString();
const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
function statusClass(s: string) {
  if (s === "active") return "ok";
  if (s === "rejected" || s === "declined") return "err";
  if (s === "pending_review" || s === "pending_payment" || s === "pending_host" || s === "payment_pending") return "warn";
  return "muted";
}

// ── overview (get_admin_overview, migration 0130) ───────────────────────────
// One RPC feeds both the tiles on this page and the badges in the sidebar of
// every other page, so a badge can never disagree with the list it points at.
type Overview = {
  generated_at: string;
  queues: { pending_review: number; spotcheck: number; reports: number; appeals: number; feedback: number };
  users: { total: number; new_7d: number; new_30d: number; suspended: number };
  events: { live_now: number; scheduled_7d: number; streamed_7d: number; hosts_30d: number };
  money: {
    ads_booked_7d: number; ads_booked_30d: number; ads_delivered_total: number;
    tips_7d: number; tips_30d: number; tickets_30d: number; ad_refunds_30d: number;
    sponsor_refunds_due: number; disputes_open: number;
  };
  moderation: {
    reports_opened_7d: number; actions_taken_7d: number;
    median_hours_to_action: number | null;
    appeals_decided_30d: number; appeals_overturned_30d: number;
  };
};
const overview = ref<Overview | null>(null);
const overviewError = ref("");
const overviewLoading = ref(false);

async function loadOverview() {
  overviewLoading.value = true;
  const { data, error } = await sb.rpc("get_admin_overview");
  if (error) overviewError.value = error.message;
  else { overview.value = data as Overview; overviewError.value = ""; }
  overviewLoading.value = false;
}
// Fire-and-forget badge refresh after an action changes a queue's size.
const refreshBadges = () => { loadOverview(); };

const asOf = computed(() =>
  overview.value
    ? new Date(overview.value.generated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "");

const tiles = computed(() => {
  const q = overview.value?.queues;
  return [
    { label: "Ads awaiting review", href: "/admin/review", count: q?.pending_review ?? 0 },
    { label: "Offers to spot-check", href: "/admin/spot-check", count: q?.spotcheck ?? 0 },
    { label: "Open reports", href: "/admin/reports", count: q?.reports ?? 0 },
    { label: "Open appeals", href: "/admin/appeals", count: q?.appeals ?? 0 },
    { label: "New bug reports", href: "/admin/bug-reports", count: q?.feedback ?? 0 },
  ];
});

const statGroups = computed(() => {
  const o = overview.value;
  if (!o) return [];
  return [
    { title: "Users & growth", rows: [
      { label: "Total profiles", value: num(o.users.total) },
      { label: "New in 7 days", value: num(o.users.new_7d) },
      { label: "New in 30 days", value: num(o.users.new_30d) },
      { label: "Suspended accounts", value: num(o.users.suspended) },
    ] },
    { title: "Events & streaming", rows: [
      { label: "Live right now", value: num(o.events.live_now) },
      { label: "Scheduled next 7 days", value: num(o.events.scheduled_7d) },
      { label: "Streamed in 7 days", value: num(o.events.streamed_7d) },
      { label: "Hosts who streamed (30d)", value: num(o.events.hosts_30d) },
    ] },
    // "Booked" is what advertisers committed in the window; spent_cents has no
    // per-day history, so delivery can only be stated as a running total.
    { title: "Money", rows: [
      { label: "Ads booked, 7 days", value: money(o.money.ads_booked_7d) },
      { label: "Ads booked, 30 days", value: money(o.money.ads_booked_30d) },
      { label: "Ad budget delivered, all time", value: money(o.money.ads_delivered_total) },
      { label: "Tips, 7 days", value: money(o.money.tips_7d) },
      { label: "Tips, 30 days", value: money(o.money.tips_30d) },
      { label: "Tickets, 30 days", value: money(o.money.tickets_30d) },
      { label: "Ad refunds, 30 days", value: money(o.money.ad_refunds_30d) },
      { label: "Sponsor refunds owed", value: num(o.money.sponsor_refunds_due) },
      { label: "Disputes still open", value: num(o.money.disputes_open) },
    ] },
    { title: "Moderation health", rows: [
      { label: "Reports opened, 7 days", value: num(o.moderation.reports_opened_7d) },
      { label: "Actions taken, 7 days", value: num(o.moderation.actions_taken_7d) },
      // An em dash, not "0h": nothing actioned in 30 days and instant response
      // must not render the same.
      { label: "Median time to action", value:
        o.moderation.median_hours_to_action == null ? "—" : `${o.moderation.median_hours_to_action}h` },
      { label: "Appeals decided, 30 days", value: num(o.moderation.appeals_decided_30d) },
      { label: "Appeals overturned, 30 days", value: num(o.moderation.appeals_overturned_30d) },
    ] },
  ];
});

// ── review queue + spot-check ───────────────────────────────────────────────
type AdminRow = {
  id: string; name: string; status: string; budget_cents: number;
  starts_at: string; ends_at: string; created_at: string;
  placement: string | null;
  ad_creatives: {
    image_url: string | null; headline: string; body: string | null;
    click_url: string; kind: "image" | "video" | null;
    video_path: string | null; duration_ms: number | null;
    logo_path: string | null; // optional in-show sponsor logo (0137, lobby only)
    // Sent back on approve as a change fingerprint — see act().
    updated_at: string | null;
  }[];
  ad_targeting: { topic_ids: string[] | null }[];
  advertiser_accounts: { name: string; contact_email: string } | null;
  events: { title: string; scheduled_at: string | null } | null;
};
type Topic = { id: string; name: string };

// Public playback URL for a video creative (ad-videos bucket, 0068).
const adVideoUrl = (cr: AdminRow["ad_creatives"][0] | undefined) =>
  cr?.video_path
    ? sb.storage.from("ad-videos").getPublicUrl(cr.video_path).data.publicUrl
    : "";
// Public URL for a sponsor's in-show logo (ad-creatives bucket, 0137).
const adLogoUrl = (cr: AdminRow["ad_creatives"][0] | undefined) =>
  cr?.logo_path
    ? sb.storage.from("ad-creatives").getPublicUrl(cr.logo_path).data.publicUrl
    : "";

const queue = ref<AdminRow[]>([]);
const reviewCursor = ref<string | null>(null);
const reviewHasMore = ref(false);
const topicNames = ref<Record<string, string>>({});
const actingOn = ref("");

const ADMIN_SELECT =
  "id, name, status, budget_cents, starts_at, ends_at, created_at, placement, ad_creatives(image_url, headline, body, click_url, kind, video_path, duration_ms, logo_path, updated_at), ad_targeting(topic_ids), advertiser_accounts(name, contact_email), events(title, scheduled_at)";

function fetchReview(cursor: string | null, limit: number) {
  let q = sb.from("ad_campaigns").select(ADMIN_SELECT)
    .in("status", ["pending_review", "active", "paused"])
    .order("created_at", { ascending: true }).limit(limit);
  if (cursor) q = q.gt("created_at", cursor);
  return q;
}

async function loadReview() {
  const [{ data, error }, { data: tps }] = await Promise.all([
    fetchReview(null, PAGE),
    sb.from("topics").select("id, name"),
  ]);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  queue.value = page;
  reviewCursor.value = page.length ? page[page.length - 1].created_at : null;
  reviewHasMore.value = page.length === PAGE;
  topicNames.value = Object.fromEntries(((tps as Topic[]) ?? []).map((t) => [t.id, t.name]));
}
async function loadMoreReview() {
  if (loadingMore.value || !reviewHasMore.value) return;
  loadingMore.value = true;
  const { data, error } = await fetchReview(reviewCursor.value, PAGE);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  queue.value = [...queue.value, ...page];
  reviewCursor.value = page.length ? page[page.length - 1].created_at : reviewCursor.value;
  reviewHasMore.value = page.length === PAGE;
  loadingMore.value = false;
}
// Re-pull the currently loaded window in place after an action, so a row
// approved on "page 2" doesn't collapse the list back to page 1.
async function reloadReview() {
  const limit = Math.max(PAGE, queue.value.length);
  const { data, error } = await fetchReview(null, limit);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  queue.value = page;
  reviewCursor.value = page.length ? page[page.length - 1].created_at : null;
  reviewHasMore.value = page.length === limit;
}

// Sponsorships (lobby placement) sort first, soonest event first — their review
// window closes when the event starts, so they're the time-sensitive ones.
// Everything else keeps the created_at order from the fetch.
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

// Spot-check: trusted advertisers' lobby creatives skip the blocking queue and
// go straight in front of the host. They're not unreviewable — an admin can
// still pull one back to rejected any time before the event, which is the only
// thing that keeps the trusted tier from being an unread queue.
const spotcheck = ref<AdminRow[]>([]);
const spotcheckCursor = ref<string | null>(null);
const spotcheckHasMore = ref(false);

function fetchSpotcheck(cursor: string | null, limit: number) {
  let q = sb.from("ad_campaigns").select(ADMIN_SELECT)
    .eq("placement", "lobby").eq("status", "pending_host")
    .order("created_at", { ascending: true }).limit(limit);
  if (cursor) q = q.gt("created_at", cursor);
  return q;
}
// Sorted client-side because the ordering key lives on the joined event row.
const spotcheckRows = computed(() =>
  [...spotcheck.value].sort((a, b) =>
    new Date(a.events?.scheduled_at ?? 0).getTime() -
    new Date(b.events?.scheduled_at ?? 0).getTime()));

const loadSpotcheck = () => reloadSpotcheck(PAGE);
async function reloadSpotcheck(limit = Math.max(PAGE, spotcheck.value.length)) {
  const { data, error } = await fetchSpotcheck(null, limit);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  spotcheck.value = page;
  spotcheckCursor.value = page.length ? page[page.length - 1].created_at : null;
  spotcheckHasMore.value = page.length === limit;
}
async function loadMoreSpotcheck() {
  if (loadingMore.value || !spotcheckHasMore.value) return;
  loadingMore.value = true;
  const { data, error } = await fetchSpotcheck(spotcheckCursor.value, PAGE);
  if (error) msg.value = error.message;
  const page = (data as unknown as AdminRow[]) ?? [];
  spotcheck.value = [...spotcheck.value, ...page];
  spotcheckCursor.value = page.length ? page[page.length - 1].created_at : spotcheckCursor.value;
  spotcheckHasMore.value = page.length === PAGE;
  loadingMore.value = false;
}

// Read-only detail modal (any campaign row); reject happens here with an
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
        // The creative as it was when this row was rendered. The advertiser can
        // still edit a pending_review ad, so without this an admin could
        // approve copy that changed while the modal was open; the fn refuses
        // the approve rather than granting it to different words.
        ...(action === "approve" && r.ad_creatives?.[0]?.updated_at
          ? { creative_updated_at: r.ad_creatives[0].updated_at }
          : {}),
      }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Action failed");
    closeDetail();
    await (props.section === "spotcheck" ? reloadSpotcheck() : reloadReview());
    refreshBadges();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOn.value = "";
  }
}

// ── reported content ────────────────────────────────────────────────────────
type ReportRow = {
  // Keep in step with the report_target_type Postgres enum.
  target_type:
    | "user" | "post" | "event" | "comment" | "ad"
    | "current" | "current_comment" | "live_chat_message";
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
const TYPE_LABELS: Record<ReportRow["target_type"], string> = {
  user: "User", post: "Post", event: "Event", comment: "Comment", ad: "Ad",
  current: "Current", current_comment: "Current comment",
  live_chat_message: "Live chat",
};
// Target types moderate-report can soft-remove and restore — its CONTENT_TABLES
// map, mirrored. Anything not listed gets resolve/dismiss only.
const REMOVABLE_TYPES: ReportRow["target_type"][] = [
  "post", "comment", "event", "current", "current_comment", "live_chat_message",
];

const reportsQueue = ref<ReportRow[]>([]);
const reportsCursor = ref<string | null>(null);
const reportsHasMore = ref(false);
const actingOnReport = ref("");
const reportCount = computed(() => overview.value?.queues.reports ?? reportsQueue.value.length);

async function loadReports() {
  const { data, error } = await sb.rpc("get_report_queue", { p_limit: PAGE });
  if (error) msg.value = error.message;
  const page = (data as ReportRow[]) ?? [];
  reportsQueue.value = page;
  reportsCursor.value = page.length ? page[page.length - 1].newest_report_at : null;
  reportsHasMore.value = page.length === PAGE;
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
// An actioned target usually drops out of the queue entirely (its reports are
// no longer open/reviewing), so this also shrinks the list.
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
// template can render without a 5-way branch. `exists: false` means the owner
// already deleted the target themselves, or the campaign was withdrawn.
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
    case "current":
      return { exists: true, image: "", title: p.caption || "(no caption)", subtitle: `@${p.author_username ?? "unknown"}` };
    case "current_comment":
      return { exists: true, image: "", title: p.body ?? "", subtitle: `@${p.author_username ?? "unknown"}` };
    case "live_chat_message":
      // The show is half the context — a chat line on its own is close to
      // unreviewable, so get_report_queue sends the event title along with it.
      return { exists: true, image: "", title: p.body ?? "", subtitle: `@${p.author_username ?? "unknown"} · in “${p.event_title ?? "a show"}”` };
    case "user":
      return { exists: true, image: p.avatar_url || "", title: p.display_name || `@${p.username}`, subtitle: p.bio || "" };
    default:
      // Named arms only. A new enum value should be visibly wrong here, not
      // silently rendered as an empty user card.
      return { exists: true, image: "", title: "(unrecognised content type)", subtitle: r.target_type };
  }
}

// Common path for resolve/dismiss/remove/restore/suspend/unsuspend — all just
// { target_type, target_id, action }. confirmMsg gates a native confirm() for
// the destructive ones.
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
    refreshBadges();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOnReport.value = "";
  }
}
// Ad reports carry no content action in moderate-report — pause/reject go
// through the existing review-ad-campaign fn, then the report itself is closed
// out with a best-effort resolve so it doesn't linger in the queue.
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
    refreshBadges();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOnReport.value = "";
  }
}

// ── appeals (P3 #35, migrations 0119 / 0119b) ───────────────────────────────
// Someone contesting a removal or a suspension. They arrive through
// joinnile.com/appeal — unauthenticated, because a suspended account can't hold
// a session — and land in a table only admins can read. The embedded notice is
// the statement of reasons they were given, so both halves are on one card.
type AppealRow = {
  id: string;
  email: string;
  body: string;
  status: "open" | "upheld" | "overturned";
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  user_id: string | null;
  moderation_notices: {
    action: string; target_type: string; reason: string | null; created_at: string;
  } | null;
};
const appealsQueue = ref<AppealRow[]>([]);
const appealsCursor = ref<string | null>(null);
const appealsHasMore = ref(false);
const appealsStatus = ref<"open" | "all">("open");
const appealNotes = ref<Record<string, string>>({});
const actingOnAppeal = ref("");
const appealCount = computed(() => overview.value?.queues.appeals ?? 0);

function appealsQuery(before: string | null, limit: number) {
  let q = sb
    .from("appeals")
    .select(
      "id, email, body, status, created_at, decided_at, decision_note, user_id, " +
      "moderation_notices!appeals_notice_id_fkey(action, target_type, reason, created_at)"
    );
  if (appealsStatus.value === "open") q = q.eq("status", "open");
  if (before) q = q.lt("created_at", before);
  return q.order("created_at", { ascending: false }).limit(limit);
}
async function refreshAppeals() {
  const { data, error } = await appealsQuery(null, PAGE);
  if (error) msg.value = error.message;
  const page = (data as unknown as AppealRow[]) ?? [];
  appealsQueue.value = page;
  appealsCursor.value = page.length ? page[page.length - 1].created_at : null;
  appealsHasMore.value = page.length === PAGE;
}
async function loadMoreAppeals() {
  if (loadingMore.value || !appealsHasMore.value) return;
  loadingMore.value = true;
  const { data, error } = await appealsQuery(appealsCursor.value, PAGE);
  if (error) msg.value = error.message;
  const page = (data as unknown as AppealRow[]) ?? [];
  appealsQueue.value = [...appealsQueue.value, ...page];
  appealsCursor.value = page.length ? page[page.length - 1].created_at : appealsCursor.value;
  appealsHasMore.value = page.length === PAGE;
  loadingMore.value = false;
}
// `appeals` is client-unwritable (0119); decide_appeal is the one narrow,
// admin-gated write, and it refuses an appeal that someone else already decided
// rather than overwriting them.
async function decideAppeal(r: AppealRow, status: "upheld" | "overturned") {
  msg.value = "";
  actingOnAppeal.value = r.id;
  try {
    const { error } = await sb.rpc("decide_appeal", {
      p_id: r.id,
      p_status: status,
      p_note: (appealNotes.value[r.id] ?? "").trim() || null,
    });
    if (error) throw new Error(error.message);
    await refreshAppeals();
    refreshBadges();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOnAppeal.value = "";
  }
}
const appealNoticeLabel = (n: AppealRow["moderation_notices"]) => {
  if (!n) return "No notice on file for this address";
  const what = n.target_type === "user" ? "account" : n.target_type.replace(/_/g, " ");
  return n.action === "suspend_user"
    ? "Account suspended"
    : `${n.action === "remove_content" ? "Removed" : "Restored"} ${what}`;
};

// ── bug & feature reports (migration 0077) ──────────────────────────────────
// Straight table reads/writes rather than an edge fn: `feedback_reports` RLS
// already gates select/update on is_admin(), and nothing here needs the service
// role the way moderate-report does.
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
const feedbackKind = ref<"all" | "bug" | "feature">("all");
const feedbackStatus = ref<"open" | "all" | typeof FEEDBACK_STATUSES[number]>("open");
const actingOnFeedback = ref("");
const expandedFeedback = ref<string | null>(null);
// Per-row unsaved edits, keyed by report id, so switching rows doesn't lose them.
const feedbackDrafts = ref<Record<string, { status: string; note: string }>>({});
// Signed URLs are short-lived (private bucket), so they're fetched per expand.
const feedbackImages = ref<Record<string, string[]>>({});
const feedbackCount = computed(() => overview.value?.queues.feedback ?? 0);

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
    const { data } = await sb.storage.from("feedback").createSignedUrls(r.image_paths, 600);
    feedbackImages.value[r.id] = (data ?? []).map((d: any) => d.signedUrl).filter(Boolean);
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
    refreshBadges();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    actingOnFeedback.value = "";
  }
}

// ── featured curation (migration 0063 + manage-featured fn) ─────────────────
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
const featuredNotice = ref("");
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

// ── admin management (manage-admins fn, migrations 0055 + 0126) ─────────────
// 0126 split admins into two tiers and put admin changes behind four eyes: a
// super admin PROPOSES, a DIFFERENT super admin approves. Ordinary admins keep
// every operational power and lose only the ability to change this list —
// that's the one power that can be used to keep all the others.
//
// The single-super-admin case applies immediately and says so; there is nobody
// who could approve, and pretending otherwise would just deadlock the screen.
type AdminRole = "admin" | "super_admin";
type AdminEntry = { user_id: string; email: string; created_at: string; role: AdminRole };
type AdminAuditEntry = {
  actor_email: string | null;
  action: "added" | "removed" | "promoted" | "demoted" | "proposed" | "rejected";
  target_email: string | null; created_at: string;
};
type AdminRequest = {
  id: string; action: "add" | "remove" | "promote" | "demote";
  target_user_id: string | null; target_email: string; reason: string | null;
  requested_by: string | null; requested_by_email: string | null;
  status: "pending" | "applied" | "rejected" | "cancelled" | "expired";
  decided_by_email: string | null; decided_at: string | null;
  unilateral: boolean; created_at: string; expires_at: string;
  can_decide: boolean;
};
const adminsList = ref<AdminEntry[]>([]);
const adminsAudit = ref<AdminAuditEntry[]>([]);
const adminRequests = ref<AdminRequest[]>([]);
const myAdminRole = ref<AdminRole>("admin");
const isSuperAdmin = computed(() => myAdminRole.value === "super_admin");
const pendingRequests = computed(() => adminRequests.value.filter((r) => r.status === "pending"));
const newAdminEmail = ref("");
const newAdminReason = ref("");
const adminsBusy = ref(""); // "add", or the user_id / request id being acted on
const adminsNotice = ref("");

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
  adminRequests.value = out.requests ?? [];
  myAdminRole.value = out.me?.role ?? "admin";
}
// One entry point for all four changes. The server decides whether this becomes
// a pending proposal or applies at once (single super admin), and says which —
// the UI shouldn't try to predict it and then disagree.
async function proposeAdminChange(
  change: "add" | "remove" | "promote" | "demote",
  opts: { email?: string; user_id?: string; label: string; busyKey: string },
) {
  msg.value = "";
  adminsNotice.value = "";
  adminsBusy.value = opts.busyKey;
  try {
    const out = await callManageAdmins({
      action: "propose",
      change,
      email: opts.email,
      user_id: opts.user_id,
      reason: newAdminReason.value.trim() || undefined,
    });
    adminsNotice.value = out.applied
      ? `${opts.label} — done. ${out.note ?? ""}`.trim()
      : `${opts.label} — proposed. It takes effect once another super admin approves it.`;
    if (change === "add") newAdminEmail.value = "";
    newAdminReason.value = "";
    await reloadAdmins();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    adminsBusy.value = "";
  }
}
const addAdmin = () =>
  proposeAdminChange("add", {
    email: newAdminEmail.value,
    label: `Add ${newAdminEmail.value.trim()} as an admin`,
    busyKey: "add",
  });
function removeAdmin(a: AdminEntry) {
  if (!confirm(`Propose removing ${a.email} as an admin?`)) return;
  return proposeAdminChange("remove", {
    user_id: a.user_id,
    label: `Remove ${a.email}`,
    busyKey: a.user_id,
  });
}
function setAdminRole(a: AdminEntry, to: AdminRole) {
  const verb = to === "super_admin" ? "promote" : "demote";
  if (!confirm(
    to === "super_admin"
      ? `Make ${a.email} a super admin? They'll be able to propose and approve admin changes.`
      : `Demote ${a.email} to an ordinary admin? They keep moderation and ad review, but can no longer change who is an admin.`,
  )) return;
  return proposeAdminChange(verb, {
    user_id: a.user_id,
    label: `${to === "super_admin" ? "Promote" : "Demote"} ${a.email}`,
    busyKey: a.user_id,
  });
}
async function decideAdminRequest(r: AdminRequest, verdict: "approve" | "reject" | "cancel") {
  if (verdict !== "cancel" && !confirm(
    `${verdict === "approve" ? "Approve" : "Reject"}: ${adminRequestLabel(r)}?`,
  )) return;
  msg.value = "";
  adminsNotice.value = "";
  adminsBusy.value = r.id;
  try {
    await callManageAdmins({ action: verdict, request_id: r.id });
    adminsNotice.value = {
      approve: "Approved and applied.",
      reject: "Rejected.",
      cancel: "Request withdrawn.",
    }[verdict];
    await reloadAdmins();
  } catch (e: any) {
    msg.value = String(e?.message || e);
  } finally {
    adminsBusy.value = "";
  }
}
const adminRequestLabel = (r: AdminRequest) => ({
  add: `add ${r.target_email} as an admin`,
  remove: `remove ${r.target_email}`,
  promote: `make ${r.target_email} a super admin`,
  demote: `demote ${r.target_email} to ordinary admin`,
}[r.action]);
const ADMIN_AUDIT_VERBS: Record<AdminAuditEntry["action"], string> = {
  added: "added", removed: "removed", promoted: "promoted",
  demoted: "demoted", proposed: "proposed a change to", rejected: "rejected a change to",
};
</script>

<template>
  <!-- Booting / signed out / not staff. One column: there is no sidebar to sit
       beside until we know the person is allowed to see one. -->
  <div v-if="state === 'loading'" class="ad-shell ad-shell--bare">
    <p class="ap-center">Loading…</p>
  </div>

  <div v-else-if="state === 'signedout'" class="ad-shell ad-shell--bare">
    <div class="ap-card">
      <h2 class="ap-h">Sign in required</h2>
      <p class="ap-sub">
        Nile staff sign in through the advertiser portal — same email and
        password. Come back to /admin once you're in.
      </p>
      <a class="nile-btn nile-btn--primary ap-full ad-cta" href="/advertise/portal">Go to sign in</a>
    </div>
  </div>

  <div v-else-if="state === 'denied'" class="ad-shell ad-shell--bare">
    <div class="ap-card">
      <h2 class="ap-h">Not available</h2>
      <p class="ap-sub">This area is for Nile staff.</p>
      <a class="nile-btn nile-btn--primary ap-full ad-cta" href="/advertise/portal">Go to your account</a>
    </div>
  </div>

  <div v-else class="ad-shell">
    <!-- SIDEBAR — real links, so back/forward and open-in-new-tab work -->
    <aside class="ad-side">
      <div class="ad-mark"><b>Nile</b><span>Admin</span></div>
      <div class="ad-groups">
        <div v-for="(g, gi) in nav" :key="gi" class="ad-group">
          <p v-if="g.title" class="ad-group-h">{{ g.title }}</p>
          <nav class="ad-nav">
            <a
              v-for="it in g.items" :key="it.key" :href="it.href"
              :class="{ 'is-active': section === it.key }"
              :aria-current="section === it.key ? 'page' : undefined"
            >
              <span>{{ it.label }}</span>
              <span v-if="it.count" class="ad-count">{{ it.count }}</span>
            </a>
          </nav>
        </div>
      </div>
      <div class="ad-side-foot">
        <span class="ad-who">{{ myEmail }}</span>
        <a class="ap-link" href="/advertise/portal">Advertiser portal →</a>
        <button type="button" class="ap-link" @click="signOut">Sign out</button>
      </div>
    </aside>

    <main class="ad-main">
      <div class="ap">
        <div v-if="msg" class="ap-msg ap-err">
          <span>{{ msg }}</span>
          <button type="button" class="ap-retry" @click="loadSection">Retry</button>
        </div>

        <div v-if="sectionLoading" class="ap-card ap-wide">
          <p class="ap-center">Loading…</p>
        </div>

        <!-- OVERVIEW -->
        <div v-else-if="section === 'overview'" class="ap-card ap-wide">
          <div class="ap-top">
            <div>
              <h2 class="ap-h" style="margin:0">Overview</h2>
              <p class="ap-sub">What's waiting on Nile staff, and how the platform is doing.</p>
            </div>
          </div>

          <p class="ad-asof">
            <span v-if="overview">As of {{ asOf }}</span>
            <span v-else-if="overviewLoading">Loading the numbers…</span>
            <button type="button" class="ap-link" :disabled="overviewLoading" @click="loadOverview">
              {{ overviewLoading ? 'Refreshing…' : 'Refresh' }}
            </button>
          </p>

          <!-- A failed stats call must not take the queues with it: the tiles
               below still link, and the sidebar is untouched. -->
          <div v-if="overviewError" class="ap-msg ap-err">
            <span>Couldn't load the numbers: {{ overviewError }}</span>
            <button type="button" class="ap-retry" @click="loadOverview">Retry</button>
          </div>

          <div v-if="overviewLoading && !overview" class="ad-tiles">
            <div v-for="i in 5" :key="i" class="ad-skel"></div>
          </div>
          <div v-else class="ad-tiles">
            <a
              v-for="t in tiles" :key="t.href" class="ad-tile"
              :class="{ 'has-work': t.count > 0 }" :href="t.href"
            >
              <b>{{ overview ? t.count : '—' }}</b>
              <span>{{ t.label }}</span>
            </a>
          </div>

          <div v-if="overview" class="ad-statgrid">
            <section v-for="g in statGroups" :key="g.title" class="ad-statcard">
              <h3>{{ g.title }}</h3>
              <p v-for="r in g.rows" :key="r.label" class="ad-stat">
                <span>{{ r.label }}</span><b>{{ r.value }}</b>
              </p>
            </section>
          </div>
        </div>

        <!-- REVIEW QUEUE -->
        <div v-else-if="section === 'review'" class="ap-card ap-wide">
          <div class="ap-top">
            <div>
              <h2 class="ap-h" style="margin:0">Review queue</h2>
              <p class="ap-sub">{{ pendingRows.length }} awaiting review</p>
            </div>
          </div>

          <p v-if="pendingRows.length === 0" class="ap-center">Nothing awaiting review.</p>
          <div v-for="r in pendingRows" :key="r.id" class="ap-review">
            <!-- Video creatives (Currents ads) get an inline player so admins
                 watch the full spot before approving; images keep the preview. -->
            <video
              v-if="r.ad_creatives?.[0]?.kind === 'video'"
              :src="adVideoUrl(r.ad_creatives[0])"
              class="ap-preview" controls muted playsinline preload="metadata"
            ></video>
            <img v-else-if="r.ad_creatives?.[0]" :src="r.ad_creatives[0].image_url ?? ''" class="ap-preview ap-clickable" alt="" @click="openDetail(r)" />
            <div v-if="r.ad_creatives?.[0]?.logo_path" class="ap-logo">
              <img :src="adLogoUrl(r.ad_creatives[0])" class="ap-logo-preview" alt="Sponsor logo" />
              <span class="ap-note-inline">In-show sponsor logo</span>
            </div>
            <h3 class="ap-rh ap-clickable" @click="openDetail(r)">{{ r.ad_creatives?.[0]?.headline ?? r.name }}</h3>
            <p class="ap-rb">{{ r.ad_creatives?.[0]?.body }}</p>
            <p class="ap-rmeta">
              <!-- Sponsorships are time-sensitive: the review window closes at showtime. -->
              <span v-if="r.placement === 'lobby'" class="ap-badge warn">
                {{ money(r.budget_cents) }} offer · {{ r.events?.title }}{{ r.events?.scheduled_at ? ' · ' + fmtDateTime(r.events.scheduled_at) : '' }}
              </span>
              <span v-if="r.placement === 'lobby'"> · </span>
              <span v-if="r.placement !== 'lobby' && r.ad_creatives?.[0]?.kind === 'video'">Currents video ad{{ r.ad_creatives[0].duration_ms ? ` · ${Math.round(r.ad_creatives[0].duration_ms! / 1000)}s` : '' }}</span>
              <span v-if="r.placement !== 'lobby' && r.ad_creatives?.[0]?.kind === 'video'"> · </span>
              <span>{{ r.advertiser_accounts?.name }} ({{ r.advertiser_accounts?.contact_email }})</span> ·
              <!-- The lobby badge above already carries the amount. -->
              <template v-if="r.placement !== 'lobby'">
                <span>{{ money(r.budget_cents) }}</span> · <span>Topics: {{ topicsFor(r) }}</span> ·
              </template>
              <a v-if="r.ad_creatives?.[0]" :href="r.ad_creatives[0].click_url" target="_blank" rel="noopener noreferrer">{{ r.ad_creatives[0].click_url }}</a>
            </p>
            <div class="ap-rbtns">
              <!-- Clearing a lobby offer takes no money — it hands the decision
                   to the host — so it must not say "approve & charge". -->
              <button class="nile-btn nile-btn--primary" :disabled="actingOn === r.id + 'approve'" @click="act(r, 'approve')">
                {{ actingOn === r.id + 'approve'
                   ? (r.placement === 'lobby' ? 'Clearing…' : 'Approving…')
                   : (r.placement === 'lobby' ? 'Clear for host' : 'Approve & charge') }}
              </button>
              <button class="ap-reject" @click="openDetail(r, true)">Reject…</button>
              <button type="button" class="ap-link" @click="openDetail(r)">View details</button>
            </div>
          </div>

          <template v-if="liveRows.length">
            <h3 class="ap-rh" style="margin-top: var(--nile-s-8)">Active &amp; paused</h3>
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
                    <!-- Killing a live ad, with the undelivered budget returned.
                         Pausing alone left a policy-violating campaign parked
                         non-terminally for ever and nothing went back. -->
                    <button class="ap-reject" @click="openDetail(r, true)">Kill…</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>

          <button v-if="reviewHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreReview">
            {{ loadingMore ? 'Loading…' : 'Load more' }}
          </button>
        </div>

        <!-- SPOT-CHECK -->
        <div v-else-if="section === 'spotcheck'" class="ap-card ap-wide">
          <div class="ap-top">
            <div>
              <h2 class="ap-h" style="margin:0">Spot-check</h2>
              <p class="ap-sub">
                {{ spotcheckRows.length }} offer{{ spotcheckRows.length === 1 ? '' : 's' }} from trusted
                advertisers that skipped the queue and are with a host now. Soonest event first — pull
                anything back before the event and the host stops seeing it.
              </p>
            </div>
          </div>

          <p v-if="spotcheckRows.length === 0" class="ap-center">Nothing to spot-check.</p>
          <div v-for="r in spotcheckRows" :key="r.id" class="ap-review">
            <video
              v-if="r.ad_creatives?.[0]?.kind === 'video'"
              :src="adVideoUrl(r.ad_creatives[0])"
              class="ap-preview" controls muted playsinline preload="metadata"
            ></video>
            <img v-else-if="r.ad_creatives?.[0]" :src="r.ad_creatives[0].image_url ?? ''" class="ap-preview ap-clickable" alt="" @click="openDetail(r)" />
            <div v-if="r.ad_creatives?.[0]?.logo_path" class="ap-logo">
              <img :src="adLogoUrl(r.ad_creatives[0])" class="ap-logo-preview" alt="Sponsor logo" />
              <span class="ap-note-inline">In-show sponsor logo</span>
            </div>
            <h3 class="ap-rh ap-clickable" @click="openDetail(r)">{{ r.ad_creatives?.[0]?.headline ?? r.name }}</h3>
            <p class="ap-rb">{{ r.ad_creatives?.[0]?.body }}</p>
            <p class="ap-rmeta">
              <span class="ap-badge warn">
                {{ money(r.budget_cents) }} offer · {{ r.events?.title }}{{ r.events?.scheduled_at ? ' · ' + fmtDateTime(r.events.scheduled_at) : '' }}
              </span> ·
              <span>{{ r.advertiser_accounts?.name }} ({{ r.advertiser_accounts?.contact_email }})</span> ·
              <a v-if="r.ad_creatives?.[0]" :href="r.ad_creatives[0].click_url" target="_blank" rel="noopener noreferrer">{{ r.ad_creatives[0].click_url }}</a>
            </p>
            <div class="ap-rbtns">
              <button class="ap-reject" @click="openDetail(r, true)">Pull back…</button>
              <button type="button" class="ap-link" @click="openDetail(r)">View details</button>
            </div>
          </div>

          <button v-if="spotcheckHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreSpotcheck">
            {{ loadingMore ? 'Loading…' : 'Load more' }}
          </button>
        </div>

        <!-- REPORTED CONTENT -->
        <div v-else-if="section === 'reports'" class="ap-card ap-wide">
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
              <template v-if="reportPreview(r).exists && REMOVABLE_TYPES.includes(r.target_type)">
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

        <!-- APPEALS -->
        <div v-else-if="section === 'appeals'" class="ap-card ap-wide">
          <div class="ap-top">
            <div>
              <h2 class="ap-h" style="margin:0">Appeals</h2>
              <p class="ap-sub">
                {{ appealCount }} open · filed at joinnile.com/appeal by people contesting a
                removal or a suspension
              </p>
            </div>
          </div>

          <div class="ap-fb-filters">
            <select v-model="appealsStatus" @change="refreshAppeals">
              <option value="open">Open</option>
              <option value="all">All</option>
            </select>
          </div>

          <p v-if="appealsQueue.length === 0" class="ap-center">Nothing here right now.</p>

          <div v-for="r in appealsQueue" :key="r.id" class="ap-review">
            <div class="ap-report-head">
              <span class="ap-badge" :class="r.status === 'open' ? 'err' : 'muted'">
                {{ r.status === 'open' ? 'Open' : r.status === 'upheld' ? 'Upheld' : 'Overturned' }}
              </span>
              <span v-if="!r.user_id" class="ap-badge muted">Unknown address</span>
              <span class="ap-rmeta">{{ fmtDate(r.created_at) }}</span>
            </div>

            <h3 class="ap-rh">{{ r.email }}</h3>

            <!-- What we told them, and what they say back. Deciding without both
                 in front of you is how an appeal becomes a rubber stamp. -->
            <p class="ap-rmeta">
              {{ appealNoticeLabel(r.moderation_notices) }}
              <template v-if="r.moderation_notices"> · {{ fmtDate(r.moderation_notices.created_at) }}</template>
            </p>
            <p v-if="r.moderation_notices" class="ap-rb" style="white-space: pre-wrap">
              Reason given: {{ r.moderation_notices.reason || '— none recorded —' }}
            </p>

            <p class="ap-rb" style="white-space: pre-wrap">{{ r.body }}</p>

            <template v-if="r.status === 'open'">
              <div class="ap-fb-triage">
                <textarea
                  v-model="appealNotes[r.id]"
                  rows="3"
                  placeholder="What you decided and why. Kept on the appeal; reply to them by email."
                ></textarea>
                <div class="ap-rbtns">
                  <button class="nile-btn" :disabled="!!actingOnAppeal" @click="decideAppeal(r, 'upheld')">
                    {{ actingOnAppeal === r.id ? 'Saving…' : 'Uphold decision' }}
                  </button>
                  <button class="nile-btn nile-btn--primary" :disabled="!!actingOnAppeal" @click="decideAppeal(r, 'overturned')">
                    {{ actingOnAppeal === r.id ? 'Saving…' : 'Overturn' }}
                  </button>
                </div>
              </div>
              <p class="ap-rmeta">
                Overturning records the decision only — restoring the content or lifting the
                suspension is still done from Reported content.
              </p>
            </template>
            <p v-else class="ap-rmeta">
              Decided {{ r.decided_at ? fmtDate(r.decided_at) : '' }}<template v-if="r.decision_note"> · {{ r.decision_note }}</template>
            </p>
          </div>

          <button v-if="appealsHasMore" class="ap-loadmore" :disabled="loadingMore" @click="loadMoreAppeals">
            {{ loadingMore ? 'Loading…' : 'Load more' }}
          </button>
        </div>

        <!-- BUG & FEATURE REPORTS -->
        <div v-else-if="section === 'feedback'" class="ap-card ap-wide">
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
                <button class="nile-btn nile-btn--primary" :disabled="!!actingOnFeedback" @click="saveFeedback(r)">
                  {{ actingOnFeedback === r.id ? 'Saving…' : 'Save' }}
                </button>
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

        <!-- FEATURED CURATION -->
        <div v-else-if="section === 'featured'" class="ap-card ap-wide">
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
                  <button class="ap-link ap-danger" :disabled="!!featuredBusy" @click="removeFeatured('event', e.target_id, e.title)">
                    {{ featuredBusy === e.target_id ? 'Removing…' : 'Remove' }}
                  </button>
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
                  <button v-else class="ap-link" :disabled="!!featuredBusy" @click="addFeatured('event', h.target_id, h.title)">
                    {{ featuredBusy === h.target_id ? 'Adding…' : 'Add to featured' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

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
                  <button class="ap-link ap-danger" :disabled="!!featuredBusy" @click="removeFeatured('creator', c.target_id, c.username)">
                    {{ featuredBusy === c.target_id ? 'Removing…' : 'Remove' }}
                  </button>
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
                  <button v-else class="ap-link" :disabled="!!featuredBusy" @click="addFeatured('creator', h.target_id, h.username)">
                    {{ featuredBusy === h.target_id ? 'Adding…' : 'Add to featured' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ADMIN MANAGEMENT -->
        <div v-else-if="section === 'admins'" class="ap-card ap-wide">
          <div class="ap-top">
            <div>
              <h2 class="ap-h" style="margin:0">Admins</h2>
              <p class="ap-sub">
                {{ adminsList.length }} admin{{ adminsList.length === 1 ? '' : 's' }}.
                Every admin can review ads, moderate reports and curate featured.
                Only a <b>super admin</b> can change who is on this list — and a
                second super admin has to approve it.
              </p>
            </div>
          </div>

          <div v-if="adminsNotice" class="ap-msg ap-ok">{{ adminsNotice }}</div>

          <!-- Waiting on someone else. Shown above everything: an admin change
               sitting unapproved is the most time-sensitive thing here. -->
          <section v-if="pendingRequests.length" class="ap-pending">
            <h3 class="ap-rh" style="margin-top:0">Awaiting approval</h3>
            <div v-for="r in pendingRequests" :key="r.id" class="ap-pending-row">
              <div>
                <b>{{ adminRequestLabel(r) }}</b>
                <div class="ap-note-inline">
                  Proposed by {{ r.requested_by_email ?? 'a former admin' }} ·
                  {{ fmtDateTime(r.created_at) }} · expires {{ fmtDate(r.expires_at) }}
                  <template v-if="r.reason"><br />“{{ r.reason }}”</template>
                </div>
              </div>
              <div class="ap-rowactions">
                <template v-if="r.can_decide && isSuperAdmin">
                  <button class="ap-link" :disabled="!!adminsBusy" @click="decideAdminRequest(r, 'approve')">
                    {{ adminsBusy === r.id ? 'Working…' : 'Approve' }}
                  </button>
                  <button class="ap-link ap-danger" :disabled="!!adminsBusy" @click="decideAdminRequest(r, 'reject')">Reject</button>
                </template>
                <template v-else-if="r.requested_by === myUserId">
                  <span class="ap-rmeta" style="margin:0">Yours — another super admin has to approve</span>
                  <button class="ap-link ap-danger" :disabled="!!adminsBusy" @click="decideAdminRequest(r, 'cancel')">Withdraw</button>
                </template>
                <span v-else class="ap-rmeta" style="margin:0">Super admins only</span>
              </div>
            </div>
          </section>

          <form v-if="isSuperAdmin" class="ap-addrow" @submit.prevent="addAdmin">
            <input
              class="ap-input" v-model="newAdminEmail" type="email" required
              placeholder="name@example.com (must already have a Nile account)"
            />
            <input
              class="ap-input" v-model="newAdminReason" type="text" maxlength="200"
              placeholder="Why? (optional — the approver sees this)"
            />
            <button class="nile-btn nile-btn--primary" type="submit" :disabled="!!adminsBusy">
              {{ adminsBusy === 'add' ? 'Working…' : 'Propose admin' }}
            </button>
          </form>
          <p v-else class="ap-sub">
            You're an ordinary admin, so you can't change this list. Ask a super
            admin (marked below) to propose it.
          </p>

          <table class="ap-tbl ap-tbl--cards">
            <thead><tr><th>Email</th><th>Role</th><th>Added</th><th></th></tr></thead>
            <tbody>
              <tr v-for="a in adminsList" :key="a.user_id">
                <td class="name" data-label="Email">
                  {{ a.email }} <span v-if="a.user_id === myUserId" class="ap-badge ok">You</span>
                </td>
                <td data-label="Role">
                  <span class="ap-badge" :class="a.role === 'super_admin' ? 'ok' : ''">
                    {{ a.role === 'super_admin' ? 'Super admin' : 'Admin' }}
                  </span>
                </td>
                <td data-label="Added">{{ fmtDate(a.created_at) }}</td>
                <td class="ap-rowactions">
                  <template v-if="isSuperAdmin">
                    <button v-if="a.role === 'admin'" class="ap-link" :disabled="!!adminsBusy" @click="setAdminRole(a, 'super_admin')">Make super admin</button>
                    <button v-else-if="a.user_id !== myUserId" class="ap-link" :disabled="!!adminsBusy" @click="setAdminRole(a, 'admin')">Demote</button>
                    <button
                      v-if="a.user_id !== myUserId"
                      class="ap-link ap-danger" :disabled="!!adminsBusy || adminsList.length <= 1"
                      @click="removeAdmin(a)"
                    >{{ adminsBusy === a.user_id ? 'Working…' : 'Remove' }}</button>
                    <span v-else class="ap-rmeta" style="margin:0">Ask another super admin to remove you</span>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>

          <template v-if="adminsAudit.length">
            <h3 class="ap-rh" style="margin-top: var(--nile-s-8)">Recent activity</h3>
            <p v-for="(e, i) in adminsAudit" :key="i" class="ap-audit">
              <b>{{ e.actor_email ?? 'a deleted account' }}</b>
              {{ ADMIN_AUDIT_VERBS[e.action] ?? e.action }}
              <b>{{ e.target_email ?? 'unknown' }}</b>
              <span class="ap-audit-when">{{ fmtDateTime(e.created_at) }}</span>
            </p>
          </template>
        </div>
      </div>
    </main>

    <!-- CAMPAIGN DETAIL MODAL (review + spot-check; read-only except the
         approve/reject/pause/resume buttons at the bottom) -->
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
        <div v-if="detail.ad_creatives?.[0]?.logo_path" class="ap-logo">
          <img :src="adLogoUrl(detail.ad_creatives[0])" class="ap-logo-preview" alt="Sponsor logo" />
          <span class="ap-note-inline">In-show sponsor logo</span>
        </div>
        <p v-if="detail.ad_creatives?.[0]?.body" class="ap-rb">{{ detail.ad_creatives[0].body }}</p>
        <dl class="ap-dl">
          <div><dt>Advertiser</dt><dd>{{ detail.advertiser_accounts?.name ?? 'Host boost' }}<template v-if="detail.advertiser_accounts"> ({{ detail.advertiser_accounts.contact_email }})</template></dd></div>
          <div><dt>Status</dt><dd><span class="ap-badge" :class="statusClass(detail.status)">{{ statusLabel(detail.status, detail.placement) }}</span></dd></div>
          <div><dt>{{ detail.placement === 'lobby' ? 'Offer' : 'Budget' }}</dt><dd>{{ money(detail.budget_cents) }}</dd></div>
          <div v-if="detail.placement === 'lobby'"><dt>Event</dt><dd>{{ detail.events?.title }}{{ detail.events?.scheduled_at ? ' · ' + fmtDateTime(detail.events.scheduled_at) : '' }}</dd></div>
          <div v-else><dt>Flight</dt><dd>{{ fmtDate(detail.starts_at) }} – {{ fmtDate(detail.ends_at) }}</dd></div>
          <div v-if="detail.placement !== 'lobby'"><dt>Topics</dt><dd>{{ topicsFor(detail) }}</dd></div>
          <div v-if="detail.ad_creatives?.[0]"><dt>Click URL</dt><dd><a :href="detail.ad_creatives[0].click_url" target="_blank" rel="noopener noreferrer">{{ detail.ad_creatives[0].click_url }}</a></dd></div>
          <div><dt>Submitted</dt><dd>{{ fmtDate(detail.created_at) }}</dd></div>
        </dl>

        <template v-if="detail.status === 'pending_review' || detail.status === 'pending_host'">
          <!-- pending_host means the offer is already with the host: there's
               nothing left to clear, only a pull-back to reject. -->
          <div v-if="!rejectMode" class="ap-rbtns">
            <button
              v-if="detail.status === 'pending_review'"
              class="nile-btn nile-btn--primary" :disabled="actingOn === detail.id + 'approve'"
              @click="act(detail, 'approve')"
            >
              {{ actingOn === detail.id + 'approve'
                 ? (detail.placement === 'lobby' ? 'Clearing…' : 'Approving…')
                 : (detail.placement === 'lobby' ? 'Clear for host' : 'Approve & charge') }}
            </button>
            <button class="ap-reject" @click="rejectMode = true">
              {{ detail.status === 'pending_host' ? 'Pull back…' : 'Reject…' }}
            </button>
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
        <template v-else>
          <div v-if="!rejectMode" class="ap-rbtns">
            <button class="nile-btn nile-btn--primary" :disabled="!!actingOn" @click="act(detail, detail.status === 'active' ? 'pause' : 'resume')">
              {{ detail.status === 'active' ? 'Pause' : 'Resume' }}
            </button>
            <button class="ap-reject" @click="rejectMode = true">Kill &amp; refund…</button>
          </div>
          <template v-else>
            <p class="ap-hint">
              This ends the campaign for good and refunds the part of the budget
              that was never delivered. Pausing is reversible; this isn't.
            </p>
            <label class="ap-label">Reason (optional, shared with the advertiser)</label>
            <textarea
              class="ap-input ap-textarea" v-model="rejectNote" maxlength="300"
              placeholder="e.g. The landing page violates our advertising policy."
            ></textarea>
            <div class="ap-rbtns">
              <button class="ap-reject" :disabled="actingOn === detail.id + 'reject'" @click="act(detail, 'reject', rejectNote)">
                {{ actingOn === detail.id + 'reject' ? 'Killing…' : 'Kill & refund' }}
              </button>
              <button type="button" class="ap-link" @click="rejectMode = false">Back</button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
