<script setup lang="ts">
import { ref } from "vue";
import { submitWaitlist, type WaitlistSegment } from "../lib/waitlist";

// CTA flips to App Store / Play links at app launch — see site.config TODO.
const email = ref("");
const segment = ref<WaitlistSegment>("host");
const honeypot = ref(""); // spam trap; real users never fill this
const status = ref<"idle" | "loading" | "done" | "error">("idle");

async function onSubmit() {
  if (honeypot.value) return; // bot
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
</script>

<template>
  <div class="waitlist" id="waitlist">
    <form v-if="status !== 'done'" class="form" @submit.prevent="onSubmit">
      <div class="segments" role="radiogroup" aria-label="I am a">
        <label
          v-for="s in (['host', 'viewer', 'advertiser'] as WaitlistSegment[])"
          :key="s"
          :class="['seg', { active: segment === s }]"
        >
          <input type="radio" :value="s" v-model="segment" name="segment" />
          {{ s === "host" ? "Host" : s === "viewer" ? "Viewer" : "Advertiser" }}
        </label>
      </div>

      <div class="row">
        <input
          v-model="email"
          type="email"
          inputmode="email"
          required
          placeholder="you@email.com"
          aria-label="Email address"
          class="input"
        />
        <!-- honeypot: visually hidden, not tabbable -->
        <input
          v-model="honeypot"
          type="text"
          tabindex="-1"
          autocomplete="off"
          class="hp"
          aria-hidden="true"
        />
        <button type="submit" class="submit" :disabled="status === 'loading'">
          {{ status === "loading" ? "…" : "Get Early Access" }}
        </button>
      </div>

      <p v-if="status === 'error'" class="msg error">
        Enter a valid email and try again.
      </p>
    </form>

    <p v-else class="msg done">
      You're on the list. We'll email you when Nile opens up.
    </p>
  </div>
</template>

<style scoped>
.waitlist {
  width: 100%;
  max-width: 520px;
}
.segments {
  display: flex;
  gap: var(--nile-s-2);
  margin-bottom: var(--nile-s-3);
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
  transition: all 0.15s ease;
}
.seg.active {
  border-color: var(--nile-volt);
  color: var(--nile-txt-primary);
}
.seg input {
  display: none;
}
.row {
  display: flex;
  gap: var(--nile-s-2);
}
.input {
  flex: 1;
  background: var(--nile-bg-raised);
  border: 1px solid var(--nile-border);
  border-radius: var(--nile-r-pill);
  padding: var(--nile-s-3) var(--nile-s-4);
  color: var(--nile-txt-primary);
  font-family: var(--nile-font-body);
  font-size: 1rem;
}
.input:focus {
  outline: none;
  border-color: var(--nile-volt);
}
.hp {
  position: absolute;
  left: -9999px;
  width: 1px;
  height: 1px;
}
.submit {
  background: var(--nile-volt);
  color: var(--nile-on-volt);
  border: none;
  border-radius: var(--nile-r-pill);
  padding: var(--nile-s-3) var(--nile-s-6);
  font-family: var(--nile-font-body);
  font-weight: 600;
  font-size: 1rem;
  cursor: pointer;
  white-space: nowrap;
}
.submit:disabled {
  opacity: 0.6;
  cursor: default;
}
.msg {
  margin-top: var(--nile-s-3);
  font-size: 0.9rem;
}
.msg.error {
  color: var(--nile-coral);
}
.msg.done {
  color: var(--nile-volt);
}
</style>
