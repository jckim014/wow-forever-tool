import { useEffect, useRef, useState } from 'react'

/** A number box that commits each valid value as it is typed and tidies itself up on blur. */
export function NumberField({ value, min, max, integer, className, onCommit }: {
  value: number
  min?: number
  max?: number
  integer?: boolean
  className?: string
  onCommit: (n: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])
  const valid = (n: number) => Number.isFinite(n) && (!integer || Number.isInteger(n)) && (min === undefined || n >= min) && (max === undefined || n <= max)
  const bad = draft.trim() === '' || !valid(Number(draft))
  return (
    <input
      type="number" step="any" min={min} max={max} className={`${className ?? 'snum'}${bad ? ' bad' : ''}`} value={draft}
      title={bad ? `Enter a number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}` : undefined}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; setDraft(String(value)) }}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && valid(n)) onCommit(n)
      }}
    />
  )
}
