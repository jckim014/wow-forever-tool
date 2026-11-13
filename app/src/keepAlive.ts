// Big views (List, Prices) stay mounted once opened and are only hidden when another view is shown, because
// rebuilding their thousands of rows took 0.5-1.2 s on every switch. To behave as before (when switching rebuilt them),
// each resets its own view state when it is shown again.
import { useLayoutEffect, useRef } from 'react'

/** Calls `reset` whenever `active` turns true again (not on the first mount), before the browser paints. */
export function useResetOnShow(active: boolean, reset: () => void) {
  const was = useRef(active)
  const fn = useRef(reset)
  fn.current = reset
  useLayoutEffect(() => {
    if (active && !was.current) fn.current()
    was.current = active
  }, [active])
}
