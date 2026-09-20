/**
 * /gate — the password screen. Server component, zero client JS.
 *
 * Shown to every request without a valid session cookie (the proxy redirects
 * there). A plain form POSTs to /api/gate-login; `?e=1` after a failed
 * attempt renders the inline error. Styled with the app's design tokens so
 * it reads as the same product, just closed.
 */

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export const metadata = { title: 'Locked — Web Video Editor' }

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; next?: string }>
}) {
  const { e } = await searchParams

  return (
    <main className="flex h-dvh w-full items-center justify-center bg-background px-4">
      <form
        method="POST"
        action="/api/gate-login"
        className="flex w-full max-w-xs flex-col gap-4 rounded-lg border border-border bg-card p-6"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-sm font-medium text-foreground">This editor is private</h1>
          <p className="text-xs text-muted-foreground">Enter the access password to continue.</p>
        </div>

        {e ? (
          <p role="alert" className="text-xs text-destructive">
            Wrong password. Try again.
          </p>
        ) : null}

        <Input
          type="password"
          name="password"
          required
          autoFocus
          aria-label="Access password"
          autoComplete="current-password"
        />
        <Button type="submit" className="w-full">
          Unlock
        </Button>
      </form>
    </main>
  )
}
