// Sitewide constants: nav, footer, defaults. Single place to edit.

export const SITE = {
  name: "Nile",
  domain: "https://joinnile.com",
  defaultTitle: "Livestream & Sell Tickets to Your Live Events | Nile",
  defaultDescription:
    "Nile is the live streaming platform built for ticketed events. Stream multiple camera angles from your phone, sell virtual tickets, and earn from live shows and on-demand replays.",
  // ⏳ placeholder — swap for real monitored inbox before email capture goes live
  supportEmail: "support@joinnile.com",
  ogImage: "/og/default.png", // ⏳ placeholder asset
} as const;

// Top nav. Items may have `children` → rendered as a dropdown in the header.
export const NAV = [
  {
    label: "Tailored For",
    children: [
      { label: "For Hosts", href: "/host" },
      { label: "For Musicians", href: "/musicians" },
      { label: "For Worship", href: "/worship" },
      { label: "For Creators", href: "/creators" },
    ],
  },
  { label: "Watch", href: "/watch" },
  { label: "Advertise", href: "/advertise" },
  { label: "FAQ", href: "/faq" },
] as const;

// Flattened nav for the footer (no dropdowns there).
export const FOOTER_NAV = NAV.flatMap((item) =>
  "children" in item ? item.children : [item],
) as readonly { label: string; href: string }[];

export const LEGAL_NAV = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Cookies", href: "/cookies" },
  { label: "Contact", href: "/contact" },
] as const;
