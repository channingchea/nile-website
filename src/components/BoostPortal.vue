<script setup lang="ts">
/*
  Host-boost checkout (A-2) — Vue island ported from the old nile-web boost.vue
  into the Astro site. Reads ?event=<id>, signs the host in, lets them pick
  budget + duration, and redirects to Stripe Checkout via create-ad-payment
  (which re-checks event ownership). External-browser only, so no iOS IAP.

  Opened by the in-app CTA ShareUrls.boost() → links.joinnile.com/boost?event=…
  (see deploy notes for pointing that host at this build).
*/
import { ref, onMounted } from "vue";
import { supabase, CREATE_AD_PAYMENT_URL } from "../lib/supabase";

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

type EventRow = { id: string; title: string; cover_image_url: string | null; username?: string };

const sb = supabase();

const state = ref<"loading" | "auth" | "flow" | "error">("loading");
const msg = ref("");
const email = ref("");
const password = ref("");
const signingIn = ref(false);
const paying = ref(false);
const event = ref<EventRow | null>(null);
const budgetCents = ref(2500);
const durationDays = ref(7);
let eventId = "";

onMounted(boot);

async function boot() {
  eventId = new URLSearchParams(window.location.search).get("event") || "";
  if (!eventId) {
    msg.value = "Missing event. Open Boost from your event in the app.";
    state.value = "error";
    return;
  }
  const { data } = await sb.auth.getSession();
  if (!data.session) { state.value = "auth"; return; }
  await loadEvent();
}

async function signIn() {
  msg.value = "";
  signingIn.value = true;
  const { error } = await sb.auth.signInWithPassword({ email: email.value, password: password.value });
  signingIn.value = false;
  if (error) { msg.value = error.message; return; }
  state.value = "loading";
  await loadEvent();
}

async function loadEvent() {
  msg.value = "";
  const { data, error } = await sb
    .from("events")
    .select("id, title, cover_image_url, profiles!events_host_id_fkey(username)")
    .eq("id", eventId)
    .maybeSingle();
  if (error || !data) {
    state.value = "flow";
    msg.value = "Couldn't load that event.";
    return;
  }
  const prof = (data as any).profiles;
  event.value = {
    id: data.id,
    title: data.title,
    cover_image_url: data.cover_image_url,
    username: Array.isArray(prof) ? prof[0]?.username : prof?.username,
  };
  state.value = "flow";
}

async function checkout() {
  msg.value = "";
  paying.value = true;
  try {
    const { data } = await sb.auth.getSession();
    const res = await fetch(CREATE_AD_PAYMENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.session?.access_token}`,
      },
      body: JSON.stringify({
        event_id: eventId,
        budget_cents: budgetCents.value,
        duration_days: durationDays.value,
      }),
    });
    const out = await res.json();
    if (!res.ok || !out.checkout_url) throw new Error(out.error || "Payment setup failed");
    window.location.href = out.checkout_url;
  } catch (err: any) {
    msg.value = String(err?.message || err);
    paying.value = false;
  }
}
</script>

<template>
  <div class="bp">
    <h2 class="bp-h">Boost your event</h2>
    <p class="bp-sub">Promote your event in the Nile feed.</p>

    <div v-if="msg" class="bp-msg bp-err">{{ msg }}</div>

    <div v-if="state === 'loading'" class="bp-center">Loading…</div>

    <!-- Sign in -->
    <form v-else-if="state === 'auth'" autocomplete="on" @submit.prevent="signIn">
      <p class="bp-label">Sign in to your Nile account</p>
      <input class="bp-input" v-model="email" type="email" placeholder="Email" required />
      <input class="bp-input" v-model="password" type="password" placeholder="Password" required />
      <button class="nile-btn nile-btn--primary bp-full" type="submit" :disabled="signingIn">
        {{ signingIn ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>

    <!-- Boost flow -->
    <div v-else-if="state === 'flow'">
      <div class="bp-event">
        <img v-if="event?.cover_image_url" :src="event.cover_image_url" alt="" />
        <div v-else class="bp-cover"></div>
        <div>
          <div class="bp-title">{{ event?.title }}</div>
          <div class="bp-host">@{{ event?.username ?? 'you' }}</div>
        </div>
      </div>

      <p class="bp-label">Budget</p>
      <div class="bp-grid">
        <button v-for="b in BUDGETS" :key="b.cents" type="button" class="bp-opt"
                :aria-selected="budgetCents === b.cents" @click="budgetCents = b.cents">{{ b.label }}</button>
      </div>

      <p class="bp-label">Duration</p>
      <div class="bp-grid">
        <button v-for="d in DURATIONS" :key="d.days" type="button" class="bp-opt"
                :aria-selected="durationDays === d.days" @click="durationDays = d.days">{{ d.label }}</button>
      </div>

      <button class="nile-btn nile-btn--primary bp-full" :disabled="paying" @click="checkout">
        {{ paying ? 'Redirecting…' : 'Continue to payment' }}
      </button>
      <p class="bp-note">
        You'll be redirected to Stripe to pay securely. Payments are processed on the web;
        you keep full control of your event.
      </p>
    </div>
  </div>
</template>

<style scoped>
.bp { max-width: 440px; margin: 0 auto; font-family: var(--nile-font-body); color: var(--nile-txt-primary); }
.bp-h { font-family: var(--nile-font-display); font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
.bp-sub { color: var(--nile-txt-secondary); margin: 0 0 var(--nile-s-6); font-size: 15px; }
.bp-label { font-size: 12px; color: var(--nile-txt-secondary); margin: 0 0 var(--nile-s-2);
  text-transform: uppercase; letter-spacing: 0.04em; }
.bp-input { width: 100%; background: var(--nile-bg-raised); border: 1px solid var(--nile-border);
  color: var(--nile-txt-primary); border-radius: var(--nile-r-md); padding: 13px; font-size: 15px;
  margin-bottom: var(--nile-s-3); font-family: inherit; }
.bp-full { width: 100%; margin-top: var(--nile-s-2); }
.bp-note { color: var(--nile-txt-tertiary); font-size: 12px; text-align: center;
  margin-top: var(--nile-s-4); line-height: 1.5; }
.bp-msg { padding: 13px 15px; border-radius: var(--nile-r-md); font-size: 14px; margin-bottom: var(--nile-s-4); }
.bp-err { background: rgba(239, 68, 68, 0.12); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
.bp-center { text-align: center; color: var(--nile-txt-secondary); padding: 48px 0; }

.bp-event { background: var(--nile-bg-surface); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-lg); padding: var(--nile-s-4); margin-bottom: var(--nile-s-6);
  display: flex; gap: 12px; align-items: center; }
.bp-event img, .bp-cover { width: 64px; height: 36px; object-fit: cover;
  border-radius: var(--nile-r-sm); background: var(--nile-bg-raised); flex: 0 0 auto; }
.bp-title { font-weight: 600; font-size: 15px; line-height: 1.3; }
.bp-host { color: var(--nile-txt-tertiary); font-size: 13px; margin-top: 2px; }

.bp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: var(--nile-s-6); }
.bp-opt { background: var(--nile-bg-surface); border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-md); padding: 15px 8px; text-align: center; cursor: pointer;
  font-size: 18px; font-weight: 600; color: var(--nile-txt-primary); font-family: inherit;
  transition: border-color .15s, background .15s; }
.bp-opt[aria-selected='true'] { border-color: var(--nile-volt); background: rgba(200, 255, 0, 0.08); }
</style>
