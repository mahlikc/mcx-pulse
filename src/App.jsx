import { useEffect, useState } from 'react'
import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Scan from './pages/Scan'
import ClientDetail from './pages/ClientDetail'
import Clients from './pages/Clients'
import Report from './pages/Report'
import Monthly from './pages/Monthly'
import Scoreboard from './pages/Scoreboard'
import Pulse from './pages/Pulse'
import Login from './pages/Login'

export default function App() {
  const [session, setSession] = useState(undefined)
  const location = useLocation()
  const isPublic = location.pathname.startsWith('/p/')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (isPublic) {
    return (
      <Routes>
        <Route path="/p/:code" element={<Pulse />} />
      </Routes>
    )
  }

  if (session === undefined) return null
  if (!session) return <Login />

  return (
    <div className="shell">
      <div className="topbar">
        <div className="wordmark">MCX <span>/ Pulse</span></div>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>Scan</NavLink>
          <NavLink to="/scoreboard" className={({ isActive }) => (isActive ? 'active' : '')}>Scoreboard</NavLink>
          <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>Weekly</NavLink>
          <NavLink to="/monthly" className={({ isActive }) => (isActive ? 'active' : '')}>Monthly</NavLink>
          <NavLink to="/clients" className={({ isActive }) => (isActive ? 'active' : '')}>Clients</NavLink>
          <a href="#" onClick={e => { e.preventDefault(); supabase.auth.signOut() }}>Sign out</a>
        </nav>
      </div>
      <Routes>
        <Route path="/" element={<Scan />} />
        <Route path="/scoreboard" element={<Scoreboard />} />
        <Route path="/client/:id" element={<ClientDetail />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/reports" element={<Report />} />
        <Route path="/monthly" element={<Monthly />} />
      </Routes>
    </div>
  )
}
