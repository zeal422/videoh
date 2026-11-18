/**
 * Implicit UI contracts shared across layers (0.28.4).
 *
 * Window event names and the timeline scroll attribute are not part of any
 * component's props: the keyboard hook, the executor adapter, menus, dialogs,
 * and timeline views agree on them by string. Keeping the strings here gives
 * producers and consumers one import, so a rename cannot leave one side
 * listening for an event nobody sends. CSS and DOM-contract tests keep the
 * literal attribute because CSS cannot import a TS module.
 */
export const UI_EVENTS = {
  /** G opens the Audio Gain dialog; the dialog lives in MenuBar. */
  AUDIO_GAIN: 'editor:audio-gain',
  /** Marker edit gestures open the shared MarkerDialog. */
  MARKER_EDIT: 'editor:marker-edit',
} as const

/** Attribute on the timeline's scroll container. */
export const TIMELINE_SCROLL_ATTRIBUTE = 'data-timeline-scroll'

/** Selector that finds the timeline's scroll container. */
export const TIMELINE_SCROLL_SELECTOR = `[${TIMELINE_SCROLL_ATTRIBUTE}]`
