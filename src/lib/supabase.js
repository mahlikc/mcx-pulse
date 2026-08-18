import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export const fmt$ = n =>
  n === null || n === undefined ? '—' : '$' + Math.round(Number(n)).toLocaleString()

export const fmt2 = n => (n === null || n === undefined ? '—' : Number(n).toFixed(2))

export function mondayOf(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1) - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().slice(0, 10)
}
