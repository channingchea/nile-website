<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { submitWaitlist, type WaitlistSegment } from "../lib/waitlist";

// Opened by any element with [data-waitlist] (wired in BaseLayout) which
// dispatches a 'nile:waitlist-open' event. Keeps a single capture form
// shared across every CTA on the page.
const open = ref(false);
const email = ref("");
const segment = ref<WaitlistSegment>("host");
const honeypot = ref("");
const status = ref<"idle" | "loading" | "done" | "error">("idle");

function show(e: Event) {
  const detail = (e as CustomEvent).detail as
    | { segment?: WaitlistSegment }
    | undefined;
  if (detail?.segment) segment.value = detail.segment;
  open.value = true;
}
function close() {
  open.value = false;
  if (status.value === "done") {
    status.value = "idle";
    email.value = "";
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

async function onSubmit() {
  if (honeypot.value) return;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value)) {
    status.value = "error";
    return;
  }
  status.value = "loading";
  try {
    await submitWaitlist({ email: email.value, segment: segment.value });
    status.value = "done";
  } catch {
    status.value = "error";
  }
}

onMounted(() => {
  window.addEventListener("nile:waitlist-open", show as EventListener);
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  window.removeEventListener("nile:waitlist-open", show as EventListener);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <!-- No <teleport>: the island already sits at the end of <body>, and the
       overlay is position:fixed, so it covers the viewport from here. Teleport
       made Vue mutate <body> on hydration, which wiped sibling content. -->
  <div v-if="open" class="overlay" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Join the waitlist">
        <button class="close" @click="close" aria-label="Close">✕</button>

        <template v-if="status !== 'done'">
          <h3 class="title">Get early access</h3>
          <p class="sub">Be first in line. We'll email you the moment Nile goes live.</p>

          <div class="segments" role="radiogroup" aria-label="I am a">
            <label
              v-for="s in (['host', 'viewer', 'advertiser'] as WaitlistSegment[])"
              :key="s"
              :class="['seg', { active: segment === s }]"
            >
              <input type="radio" :value="s" v-model="segment" name="seg" />
              {{ s === "host" ? "Host" : s === "viewer" ? "Viewer" : "Advertiser" }}
            </label>
          </div>

          <form @submit.prevent="onSubmit">
            <input
              v-model="email"
              type="email"
              inputmode="email"
              required
              placeholder="you@email.com"
              aria-label="Email address"
              class="input"
              autofocus
            />
            <input
              v-model="honeypot"
              type="text"
              tabindex="-1"
              autocomplete="off"
              class="hp"
              aria-hidden="true"
            />
            <button type="submit" class="submit" :disabled="status === 'loading'">
              {{ status === "loading" ? "Joining…" : "Join the waitlist →" }}
            </button>
            <p v-if="status === 'error'" class="err">
              Enter a valid email and try again.
            </p>
          </form>
        </template>

        <div v-else class="done">
          <h3 class="title">You're on the list.</h3>
          <p class="sub">We'll email you the moment Nile opens up.</p>
          <button class="submit" @click="close">Done</button>
        </div>
      </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, #000 70%, transparent);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--nile-s-4);
  z-index: 100;
}
.modal {
  position: relative;
  width: 100%;
  max-width: 440px;
  background: var(--nile-bg-surface);
  border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-xl);
  padding: var(--nile-s-8);
}
.close {
  position: absolute;
  top: var(--nile-s-4);
  right: var(--nile-s-4);
  background: none;
  border: none;
  color: var(--nile-txt-tertiary);
  font-size: 1rem;
  cursor: pointer;
}
.title {
  font-family: var(--nile-font-display);
  font-size: 1.6rem;
  margin: 0 0 var(--nile-s-2);
}
.sub {
  color: var(--nile-txt-secondary);
  margin: 0 0 var(--nile-s-6);
}
.segments {
  display: flex;
  gap: var(--nile-s-2);
  margin-bottom: var(--nile-s-4);
}
.seg {
  flex: 1;
  text-align: center;
  padding: var(--nile-s-2);
  border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-pill);
  color: var(--nile-txt-secondary);
  font-size: 0.85rem;
  cursor: pointer;
}
.seg.active {
  border-color: var(--nile-volt);
  color: var(--nile-txt-primary);
}
.seg input {
  display: none;
}
.input {
  width: 100%;
  background: var(--nile-bg-raised);
  border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-pill);
  padding: var(--nile-s-3) var(--nile-s-4);
  color: var(--nile-txt-primary);
  font-family: var(--nile-font-body);
  font-size: 1rem;
  margin-bottom: var(--nile-s-3);
}
.input:focus {
  outline: none;
  border-color: var(--nile-volt);
}
.hp {
  position: absolute;
  left: -9999px;
}
.submit {
  width: 100%;
  background: var(--nile-volt);
  color: var(--nile-on-volt);
  border: none;
  border-radius: var(--nile-r-pill);
  padding: var(--nile-s-3) var(--nile-s-6);
  font-family: var(--nile-font-body);
  font-weight: 600;
  font-size: 1rem;
  cursor: pointer;
}
.submit:disabled {
  opacity: 0.6;
}
.err {
  color: var(--nile-coral);
  font-size: 0.9rem;
  margin: var(--nile-s-3) 0 0;
}
.done {
  text-align: center;
}
</style>
