import { useCallback, useEffect, useState } from "react"

/** Seconds a resend button stays disabled to keep users off the rate limit. */
export const RESEND_COOLDOWN_SECONDS = 60

/** The stored end of a cooldown, or null when none was saved under `key`. */
function storedEndsAt(key: string | undefined): number | null {
  if (!key || typeof sessionStorage === "undefined") return null
  const endsAt = Number(sessionStorage.getItem(key))
  return endsAt > 0 ? endsAt : null
}

/**
 * Countdown state for "resend code" buttons.
 *
 * The cooldown is kept as the moment it ends rather than as seconds left, so
 * with a `storageKey` a page refresh resumes it instead of starting over.
 *
 * @param initialSeconds - Seconds to start at. Pass `0` when nothing has been
 *   sent yet, or the cooldown length when the flow arrives right after a send.
 *   Ignored when `storageKey` already holds a cooldown.
 * @param storageKey - `sessionStorage` key that keeps the cooldown across
 *   reloads of the tab.
 */
export function useResendCooldown(initialSeconds = 0, storageKey?: string) {
  const [endsAt, setEndsAt] = useState(
    () => storedEndsAt(storageKey) ?? Date.now() + initialSeconds * 1000
  )
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (storageKey) sessionStorage.setItem(storageKey, String(endsAt))
  }, [storageKey, endsAt])

  useEffect(() => {
    const interval = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= endsAt) clearInterval(interval)
    }, 1000)

    return () => clearInterval(interval)
  }, [endsAt])

  // Stable so callers can start the cooldown from an effect without
  // re-running it on every render.
  const startCooldown = useCallback((seconds = RESEND_COOLDOWN_SECONDS) => {
    const current = Date.now()
    setNow(current)
    setEndsAt(current + seconds * 1000)
  }, [])

  const cooldown = Math.max(0, Math.ceil((endsAt - now) / 1000))

  return {
    cooldown,
    isCoolingDown: cooldown > 0,
    startCooldown
  }
}
