import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

export default function Pulse() {
  const { code } = useParams()
  const [data, setData] = useState(undefined)

  useEffect(() => {
    fetch(`/api/pulse?code=${encodeURIComponent(code)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
  }, [code])

  if (data === undefined) return null
  if (data === null) {
    return (
      <div className="pulse-wrap">
        <div className="pulse-card">
          <div className="pulse-brand">Link not active</div>
          <div className="pulse-note">Ask your account manager for a fresh pulse link.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="pulse-wrap">
      <div className="pulse-card">
        <div className={`light xl ${data.light}`} />
        <div className="pulse-brand">{data.name}</div>
        <div className="pulse-window">{data.window} · updated {data.updated || '—'}</div>

        <div className="pulse-mer">{data.mer ?? '—'}</div>
        <div className="pulse-be">
          MER · break-even {data.breakeven} · spend ${data.spend.toLocaleString()} · revenue ${data.revenue.toLocaleString()}
        </div>

        <div className="pulse-note">{data.note}</div>
        <div className="pulse-window" style={{ marginTop: 22, marginBottom: 0 }}>MCX / Pulse</div>
      </div>
    </div>
  )
}
