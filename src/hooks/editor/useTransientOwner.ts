'use client'

import { useCallback, useEffect, useRef } from 'react'

import { isTransientActive, ownsTransient, useEditorStore } from '@/lib/editor/store'

/**
 * One section's lease on the store's single transient gesture (0.28.4).
 *
 * A focus field or a shared preview helper begins the session, every frame runs
 * through `preview`, and blur or unmount commits only a session this hook still
 * owns. A foreign gesture is never overwritten, ended, or committed: a refused
 * `begin()` returns false, and `preview` retries it on a later change once the
 * slot is free. The token is the store's own ownership test, so a foreign apply
 * that ends the gesture also ends this session.
 */
export function useTransientOwner() {
  const tokenRef = useRef<number | null>(null)

  const begin = useCallback((): boolean => {
    if (ownsTransient(tokenRef.current)) return true
    if (isTransientActive()) return false
    const token = useEditorStore.getState().beginTransient()
    tokenRef.current = token
    return token !== null
  }, [])

  const preview = useCallback((run: () => void) => {
    if (!ownsTransient(tokenRef.current)) {
      // Never join another control's gesture; drop the frame until it ends.
      if (isTransientActive()) return
      const token = useEditorStore.getState().beginTransient()
      if (token === null) return
      tokenRef.current = token
    }
    run()
  }, [])

  const commit = useCallback(() => {
    const token = tokenRef.current
    tokenRef.current = null
    if (!ownsTransient(token)) return
    useEditorStore.getState().commitTransient()
  }, [])

  const cancel = useCallback(() => {
    const token = tokenRef.current
    tokenRef.current = null
    if (!ownsTransient(token)) return
    useEditorStore.getState().cancelTransient()
  }, [])

  // An unmount commits the session this hook owns, so a selection change
  // cannot leave the gesture open and pause autosave. A foreign gesture is
  // left alone.
  useEffect(() => () => commit(), [commit])

  return { begin, preview, commit, cancel }
}
