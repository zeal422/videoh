import {
  DENOISE_CORNER_Q_DB,
  DENOISE_HISS_DB,
  DENOISE_HISS_HZ,
  DENOISE_HISS_Q,
  DENOISE_HIGHPASS_HZ,
  DENOISE_LOWPASS_HZ,
} from '../constants'

/**
 * The noise-reduction chain (0.6.0), built from the shared DENOISE_* constants
 * so the preview mixer and the offline export mix cannot drift apart.
 *
 * Broadband hiss is what a browser can actually reduce without an AudioWorklet
 * DSP stage: a high-pass drops rumble below the voice band, a low-pass drops
 * the top octave where hiss dominates, and a narrow peaking cut takes the hiss
 * band itself down a few dB. Fixed values, three nodes, no user tuning.
 *
 * The caller owns the nodes: connect `head -> filters[0] -> ... -> filters[n]`
 * and stop using them when the context closes.
 */
export function denoiseFilters(ctx: BaseAudioContext): BiquadFilterNode[] {
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = DENOISE_HIGHPASS_HZ
  // dB, not linear: Web Audio reads lowpass/highpass Q in decibels, and the
  // Butterworth corner is what keeps the voice band flat (see the constant).
  highpass.Q.value = DENOISE_CORNER_Q_DB

  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = DENOISE_LOWPASS_HZ
  lowpass.Q.value = DENOISE_CORNER_Q_DB

  const hiss = ctx.createBiquadFilter()
  hiss.type = 'peaking'
  hiss.frequency.value = DENOISE_HISS_HZ
  hiss.Q.value = DENOISE_HISS_Q
  hiss.gain.value = DENOISE_HISS_DB

  return [highpass, lowpass, hiss]
}
