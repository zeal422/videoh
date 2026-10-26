import { ImageResponse } from 'next/og'

export const alt = 'videoh, open-source video editing in your browser'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#09090b',
        color: '#fafafa',
        padding: '72px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{ width: '10px', height: '42px', background: '#f43f5e' }} />
        <div style={{ width: '7px', height: '18px', background: '#fcd34d' }} />
        <div style={{ fontSize: '24px', letterSpacing: '0.18em', color: '#a1a1aa' }}>
          BROWSER NATIVE · LOCAL FIRST
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div style={{ fontSize: '112px', lineHeight: 1, letterSpacing: '-0.04em' }}>videoh</div>
        <div style={{ maxWidth: '900px', fontSize: '44px', lineHeight: 1.15, color: '#d4d4d8' }}>
          Open-source video editing in your browser.
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', color: '#a1a1aa' }}>
        <div style={{ width: '120px', height: '2px', background: '#f43f5e' }} />
        <div style={{ fontSize: '24px' }}>No uploads. No account. MP4 export.</div>
      </div>
    </div>,
    { ...size },
  )
}
