import { Laptop, Lock } from 'lucide-react'

function NoServersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mx-auto mb-3 size-8 text-white/80"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
      <path d="M4 4l16 16" />
    </svg>
  )
}

function PrivacyShield() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="h-[10rem] w-[9.4rem] shrink-0 drop-shadow-[0_0_28px_rgba(236,72,153,0.28)] sm:h-[11.25rem] sm:w-[10.6rem]"
    >
      <defs>
        <linearGradient
          id="site-shield-outer"
          x1="5"
          y1="3"
          x2="19"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fbbf24" />
          <stop offset="0.45" stopColor="#f43f5e" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient
          id="site-shield-inner"
          x1="8"
          y1="8"
          x2="16"
          y2="18"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#f472b6" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <radialGradient
          id="site-shield-fill"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(12 12) rotate(90) scale(10)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ec4899" stopOpacity="0.18" />
          <stop offset="1" stopColor="#7c3aed" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
        fill="url(#site-shield-fill)"
        stroke="url(#site-shield-outer)"
        strokeWidth="0.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g transform="translate(12 12) scale(0.55) translate(-12 -12)">
        <path
          d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
          fill="rgba(8, 5, 18, 0.55)"
          stroke="url(#site-shield-inner)"
          strokeWidth="0.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

function CheckConnector() {
  return (
    <div className="relative hidden flex-1 items-center sm:flex">
      <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.16)_0_4px,transparent_4px_10px)]" />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mx-2 size-4 shrink-0 text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.45)]"
      >
        <path d="M5 12l5 5L20 7" />
      </svg>
      <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.16)_0_4px,transparent_4px_10px)]" />
    </div>
  )
}

/**
 * The privacy panel. The copy stays honest about the optional page analytics,
 * while the card still tells the local-media story: the editor never uploads a
 * file and there is no media server in the path.
 */
export function PrivacyPanel() {
  return (
    <section aria-labelledby="privacy-title" className="relative py-20 sm:py-24">
      <div className="mx-auto grid w-full max-w-[1288px] gap-12 px-6 lg:grid-cols-[0.27fr_0.67fr] lg:items-center lg:gap-20 xl:grid-cols-[0.32fr_0.62fr]">
        <div className="min-w-0">
          <h2
            id="privacy-title"
            className="text-[1.75rem] font-medium tracking-[-0.03em] text-[var(--site-text)] xl:whitespace-nowrap"
          >
            Built for privacy. Built for you.
          </h2>
          <p className="mt-4 max-w-sm text-base leading-relaxed text-[var(--site-muted)] sm:text-[1.0625rem]">
            Your media never leaves your device. No uploads, no account, and no media server. The
            public site uses optional, privacy-friendly analytics for page views.
          </p>
          <span className="mt-6 inline-flex items-center gap-2 rounded-full border border-violet-400/25 bg-violet-400/[0.055] px-4 py-2 text-sm text-violet-300">
            <Lock aria-hidden="true" className="size-4" />
            Local first. <span className="text-violet-400">Always.</span>
          </span>
        </div>

        <div className="site-privacy-panel flex flex-col items-center gap-6 rounded-2xl p-6 sm:flex-row sm:justify-between sm:p-8 lg:p-10">
          <div className="flex min-h-[9.5rem] w-full max-w-[10.5rem] flex-col items-center justify-center rounded-xl border border-white/10 bg-[#09070d]/70 p-4 text-center shadow-[0_10px_25px_rgba(0,0,0,0.25)]">
            <Laptop aria-hidden="true" className="mb-3 size-8 text-white/80" />
            <h3 className="text-[0.8125rem] font-medium text-[var(--site-text)]">Your Device</h3>
            <p className="mt-1 text-[0.6875rem] text-[var(--site-muted-2)]">Edit locally</p>
          </div>
          <CheckConnector />
          <PrivacyShield />
          <CheckConnector />
          <div className="flex min-h-[9.5rem] w-full max-w-[10.5rem] flex-col items-center justify-center rounded-xl border border-white/10 bg-[#09070d]/70 p-4 text-center shadow-[0_10px_25px_rgba(0,0,0,0.25)]">
            <NoServersIcon />
            <h3 className="text-[0.8125rem] font-medium text-[var(--site-text)]">
              No media servers
            </h3>
            <p className="mt-1 text-[0.6875rem] text-[var(--site-muted-2)]">
              Your media stays local
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
