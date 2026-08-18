import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function signIn(e) {
    e.preventDefault()
    setBusy(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <div className="pulse-wrap">
      <form className="pulse-card" onSubmit={signIn} style={{ textAlign: 'left' }}>
        <div className="wordmark" style={{ marginBottom: 24 }}>MCX <span>/ Pulse</span></div>
        <label>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
        <label>Password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        {error && <div className="error">{error}</div>}
        <button className="btn" style={{ marginTop: 18, width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
