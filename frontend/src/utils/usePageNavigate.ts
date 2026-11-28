import { useCallback, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate, useNavigationType, type NavigateOptions, type To } from 'react-router-dom'

/**
 * How the new page arrives: deeper pages slide in from the right, going back from the left,
 * and a tab from the dock fades in place, as iOS switches tabs.
 */
export type PageDirection = 'forward' | 'back' | 'tab'

type PageNavigateOptions = NavigateOptions & { direction?: PageDirection }

// A direction asked for by usePageNavigate wins over the one guessed from the route.
let asked: PageDirection | null = null

/**
 * Drop-in for useNavigate. The page changes at once and the new page animates in by itself
 * (motion.css). A View Transition used to do this, but it froze the screen for about half a
 * second while it captured the old page, which made every tap feel late.
 */
export function usePageNavigate() {
  const navigate = useNavigate()
  // Stable like useNavigate's function, so effects that list it as a dependency don't rerun.
  return useCallback((to: To | number, options: PageNavigateOptions = {}) => {
    const { direction = typeof to === 'number' && to < 0 ? 'back' : 'forward', ...navigateOptions } = options
    asked = direction
    void (typeof to === 'number' ? navigate(to) : navigate(to, navigateOptions))
  }, [navigate])
}

const depth = (path: string) => path.split('/').filter(Boolean).length

/**
 * Sets the direction for every page change, including plain links and the browser's Back button,
 * so each new page animates the right way. Runs before paint, so the animation picks it up.
 */
export function usePageDirection() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()
  const previous = useRef(pathname)

  useLayoutEffect(() => {
    const from = previous.current
    previous.current = pathname
    if (from === pathname) return
    const guessed: PageDirection = navigationType === 'POP' || depth(pathname) < depth(from) ? 'back' : 'forward'
    document.documentElement.dataset.pageDirection = asked ?? guessed
    asked = null
  }, [pathname, navigationType])
}
