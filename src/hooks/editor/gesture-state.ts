import { isTransientActive } from '@/lib/editor/store'

/**
 * True while a pointer gesture owns the editor: a live transient (drag frame)
 * or a pending automation press marked on the envelope root. The keyboard tool
 * keys and the toolbar tool buttons share this one rule, so a tool change can
 * never land under a gesture whose closures still run the old tool.
 *
 * UI-layer code only: it reads the store and the DOM, never the pure core.
 */
export function isAutomationGestureLive(): boolean {
  return isTransientActive() || !!document.querySelector('[data-automation-gesture="true"]')
}
