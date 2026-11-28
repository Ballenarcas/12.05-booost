import { animate, motion, useMotionValue, useSpring, useTransform, type AnimationPlaybackControls } from 'framer-motion'
import { Dumbbell, House, TrendingUp, UserRound, UsersRound, type LucideProps } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { useLocation } from 'react-router-dom'
import { useT, type MessageKey } from '../../i18n'
import { usePageNavigate } from '../../utils/usePageNavigate'
import { prefersStillness } from '../../utils/useSpring'
import '../../styles/glass-dock.css'

type DockIcon = ComponentType<LucideProps>
type DockItem = { path: string; label: MessageKey; Icon: DockIcon }

// Asymmetric spring pair: leading edge darts ahead while the trailing edge catches up,
// creating the iOS 26 Liquid Glass elastic stretch without warping pill corners.
const LEAD_SPRING = { type: 'spring' as const, stiffness: 460, damping: 29, mass: 0.72 }
const TRAIL_SPRING = { type: 'spring' as const, stiffness: 215, damping: 24, mass: 0.96 }
const SETTLE_SPRING = { type: 'spring' as const, stiffness: 360, damping: 28, mass: 0.8 }
const DRAG_THRESHOLD = 8

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

// Fluent "food-apple-20-regular", the icon the Figma NavBar uses; lucide has no match for it.
function FoodApple({ size = 24, 'aria-hidden': ariaHidden }: LucideProps) {
  return (
    // The glyph fills ~70% of its box, so it is drawn larger to match the other icons (22×26 in Figma).
    <svg width={Number(size) * 1.25} height={Number(size) * 1.25} viewBox="0 0 20 20" fill="currentColor" aria-hidden={ariaHidden}>
      <path d="M7.225 8.342C7.2668 8.46772 7.25701 8.60488 7.19776 8.72338C7.13851 8.84188 7.03465 8.93201 6.909 8.974C6.75548 9.02254 6.61308 9.10099 6.49002 9.20483C6.36696 9.30866 6.26568 9.43583 6.192 9.579C6.006 9.928 5.88 10.502 5.997 11.439C6.01331 11.5707 5.97664 11.7034 5.89507 11.8081C5.81349 11.9127 5.69368 11.9807 5.562 11.997C5.43032 12.0133 5.29755 11.9766 5.19291 11.8951C5.08826 11.8135 5.02031 11.6937 5.004 11.562C4.872 10.499 4.995 9.698 5.31 9.109C5.63 8.509 6.117 8.184 6.592 8.026C6.65431 8.00515 6.72012 7.99678 6.78567 8.00138C6.85121 8.00598 6.91521 8.02345 6.974 8.0528C7.03278 8.08215 7.08521 8.1228 7.12828 8.17242C7.17135 8.22204 7.20422 8.27967 7.225 8.342ZM12.159 2.974C12.223 2.95461 12.2824 2.92258 12.3338 2.87981C12.3852 2.83705 12.4275 2.78441 12.4582 2.72501C12.4889 2.66561 12.5073 2.60067 12.5125 2.53401C12.5176 2.46735 12.5094 2.40034 12.4882 2.33693C12.467 2.27353 12.4333 2.21502 12.389 2.16486C12.3448 2.11471 12.291 2.07393 12.2308 2.04494C12.1705 2.01596 12.1051 1.99934 12.0383 1.99609C11.9715 1.99283 11.9048 2.00301 11.842 2.026C10.905 2.338 10.32 3.108 9.976 3.933C9.92959 4.04443 9.88723 4.1575 9.849 4.272C9.66164 3.91715 9.42196 3.59252 9.138 3.309C8.75328 2.92429 8.29412 2.6221 7.78861 2.42093C7.2831 2.21975 6.74186 2.12382 6.198 2.139C5.618 2.155 5.155 2.619 5.139 3.198C5.12371 3.74909 5.2225 4.29739 5.42918 4.80849C5.63585 5.31958 5.94595 5.78244 6.34 6.168C5.49985 6.34966 4.74057 6.79713 4.17465 7.44411C3.60872 8.09108 3.26626 8.90315 3.198 9.76L3.192 9.834C3.05998 11.4812 3.41096 13.1312 4.202 14.582L4.562 15.24C4.57133 15.2573 4.582 15.274 4.594 15.29L5.594 16.692C5.82064 17.0094 6.11372 17.2736 6.45284 17.4663C6.79195 17.6589 7.16897 17.7754 7.55766 17.8076C7.94635 17.8397 8.33738 17.7868 8.70356 17.6526C9.06973 17.5183 9.40226 17.3058 9.678 17.03C9.72035 16.9876 9.77062 16.954 9.82596 16.9311C9.88129 16.9082 9.9406 16.8964 10.0005 16.8964C10.0604 16.8964 10.1197 16.9082 10.175 16.9311C10.2304 16.954 10.2807 16.9876 10.323 17.03C10.5987 17.3058 10.9313 17.5183 11.2974 17.6526C11.6636 17.7868 12.0546 17.8397 12.4433 17.8076C12.832 17.7754 13.209 17.6589 13.5482 17.4663C13.8873 17.2736 14.1804 17.0094 14.407 16.692L15.407 15.291L15.439 15.24L15.798 14.582C16.589 13.1312 16.94 11.4812 16.808 9.834L16.803 9.76C16.7587 9.20778 16.6003 8.67078 16.3376 8.18302C16.0749 7.69526 15.7138 7.26738 15.2771 6.92649C14.8404 6.5856 14.3377 6.33914 13.8008 6.20272C13.2639 6.0663 12.7044 6.0429 12.158 6.134L10.501 6.41C10.511 5.729 10.631 4.963 10.9 4.317C11.18 3.642 11.596 3.162 12.158 2.974M8.719 6.28L8.565 6.254C7.97809 6.13983 7.43868 5.85289 7.016 5.43C6.72755 5.14142 6.50101 4.79703 6.35021 4.4179C6.19942 4.03877 6.12755 3.63286 6.139 3.225C6.13975 3.20216 6.14916 3.18047 6.16531 3.16431C6.18147 3.14816 6.20316 3.13875 6.226 3.138C6.63393 3.12668 7.03988 3.19871 7.41902 3.34968C7.79815 3.50064 8.1425 3.72737 8.431 4.016C9.038 4.623 9.331 5.424 9.308 6.221C9.30725 6.24384 9.29784 6.26553 9.28169 6.28169C9.26553 6.29784 9.24384 6.30725 9.221 6.308C9.05318 6.31273 8.88525 6.30336 8.719 6.28ZM8.391 7.239L8.564 7.268L9.343 7.398C9.77833 7.47054 10.2227 7.47054 10.658 7.398L12.322 7.12C12.7319 7.05164 13.1515 7.06917 13.5543 7.1715C13.957 7.27383 14.3341 7.45871 14.6617 7.71443C14.9892 7.97016 15.2601 8.29114 15.4571 8.65704C15.6541 9.02294 15.7729 9.42577 15.806 9.84L15.812 9.914C15.9284 11.3677 15.6184 12.8238 14.92 14.104L14.576 14.734L13.593 16.11C13.4508 16.3093 13.267 16.4752 13.0542 16.5961C12.8414 16.7171 12.6048 16.7903 12.3609 16.8106C12.1169 16.8309 11.8715 16.7977 11.6417 16.7135C11.4118 16.6293 11.2031 16.4961 11.03 16.323C10.8948 16.1877 10.7342 16.0803 10.5575 16.007C10.3807 15.9338 10.1913 15.8961 10 15.8961C9.80869 15.8961 9.61925 15.9338 9.44252 16.007C9.26578 16.0803 9.10522 16.1877 8.97 16.323C8.7969 16.4959 8.58823 16.629 8.3585 16.7131C8.12876 16.7972 7.88346 16.8303 7.63966 16.81C7.39585 16.7897 7.15939 16.7166 6.94669 16.5957C6.73399 16.4748 6.55017 16.3091 6.408 16.11L5.425 14.734L5.081 14.104C4.38263 12.8238 4.07265 11.3677 4.189 9.914L4.195 9.84C4.22814 9.42587 4.34693 9.02313 4.54385 8.65731C4.74077 8.29149 5.01153 7.97056 5.33897 7.71485C5.66641 7.45915 6.04339 7.27424 6.44603 7.17184C6.84867 7.06944 7.26818 7.05179 7.678 7.12L8.391 7.239Z" />
    </svg>
  )
}

const items: DockItem[] = [
  { path: '/', label: 'nav.home', Icon: House },
  { path: '/workouts', label: 'nav.workouts', Icon: Dumbbell },
  { path: '/nutrition', label: 'nav.nutrition', Icon: FoodApple },
  { path: '/workouts/statistics', label: 'nav.statistics', Icon: TrendingUp },
  { path: '/community', label: 'nav.community', Icon: UsersRound },
  { path: '/profile', label: 'nav.profile', Icon: UserRound },
]

export default function GlassDock() {
  const t = useT()
  const navigate = usePageNavigate()
  const { pathname: currentPath } = useLocation()
  // Meal pages live outside /nutrition but belong to its tab; /statistics aliases /workouts/statistics.
  const pathname = /^\/(scan-meal|log-meals|hydration)(\/|$)/.test(currentPath)
    ? '/nutrition'
    : currentPath === '/statistics'
      ? '/workouts/statistics'
      : currentPath
  // The longest matching path wins, so /workouts/statistics marks Statistics, not Workouts.
  const active = items.reduce((best, { path }, index) => {
    const matches = path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`)
    return matches && path.length > items[best].path.length ? index : best
  }, 0)

  const navRef = useRef<HTMLElement | null>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const restWidthRef = useRef(56)
  const activeRef = useRef(active)
  const prevActiveRef = useRef(active)
  const hasMeasuredRef = useRef(false)
  const animsRef = useRef<AnimationPlaybackControls[]>([])
  const suppressClickRef = useRef(false)
  const dragRef = useRef<{ id: number; startX: number; lastX: number; dragged: boolean; target: number } | null>(null)

  const [measured, setMeasured] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [scrubIndex, setScrubIndex] = useState<number | null>(null)

  const leftMV = useMotionValue(0)
  const rightMV = useMotionValue(56)
  const widthMV = useTransform([leftMV, rightMV], ([l, r]: number[]) => Math.max(36, r - l))
  const swellMV = useSpring(dragging ? 1.07 : 1, { stiffness: 420, damping: 28, mass: 0.7 })
  // Subtle volume-preserving vertical squash while stretching across tabs, plus gentle lift when scrubbed.
  const scaleYMV = useTransform([widthMV, swellMV], ([w, s]: number[]) => {
    const rest = restWidthRef.current || 56
    const ratio = Math.min(1, rest / Math.max(rest, w))
    const squash = 1 - (1 - ratio) * 0.22
    return squash * s
  })

  const stopAnimations = useCallback(() => {
    for (const ctrl of animsRef.current) ctrl.stop()
    animsRef.current = []
  }, [])

  const measureSlot = useCallback((index: number) => {
    const btn = buttonRefs.current[index]
    if (!btn) return null
    return { left: btn.offsetLeft, right: btn.offsetLeft + btn.offsetWidth, width: btn.offsetWidth }
  }, [])

  const snapTo = useCallback((index: number, instant: boolean) => {
    const slot = measureSlot(index)
    if (!slot) return
    restWidthRef.current = slot.width
    stopAnimations()
    if (instant || prefersStillness()) {
      leftMV.jump(slot.left)
      rightMV.jump(slot.right)
      return
    }
    animsRef.current = [
      animate(leftMV, slot.left, SETTLE_SPRING),
      animate(rightMV, slot.right, SETTLE_SPRING),
    ]
  }, [leftMV, measureSlot, rightMV, stopAnimations])

  // Initial placement & resize synchronization without animating from 0.
  useLayoutEffect(() => {
    const sync = () => {
      const slot = measureSlot(activeRef.current)
      if (!slot) return
      restWidthRef.current = slot.width
      if (!hasMeasuredRef.current || dragRef.current?.dragged !== true) {
        stopAnimations()
        leftMV.jump(slot.left)
        rightMV.jump(slot.right)
      }
      if (!hasMeasuredRef.current) {
        hasMeasuredRef.current = true
        setMeasured(true)
      }
    }
    sync()
    const nav = navRef.current
    if (!nav || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(sync)
    ro.observe(nav)
    return () => ro.disconnect()
  }, [leftMV, measureSlot, rightMV, stopAnimations])

  // Elastic stretch transition whenever the active tab changes.
  useEffect(() => {
    activeRef.current = active
    if (!hasMeasuredRef.current) return
    const prev = prevActiveRef.current
    prevActiveRef.current = active
    if (prev === active) return
    const slot = measureSlot(active)
    if (!slot) return
    restWidthRef.current = slot.width

    stopAnimations()
    if (prefersStillness()) {
      leftMV.jump(slot.left)
      rightMV.jump(slot.right)
      return
    }

    const goingRight = active > prev
    animsRef.current = [
      animate(leftMV, slot.left, goingRight ? TRAIL_SPRING : LEAD_SPRING),
      animate(rightMV, slot.right, goingRight ? LEAD_SPRING : TRAIL_SPRING),
    ]
  }, [active, leftMV, measureSlot, rightMV, stopAnimations])

  useEffect(() => () => stopAnimations(), [stopAnimations])

  // Tapping the tab you are on goes back to its first screen, or to its top when already there.
  function reselect(path: string) {
    if (currentPath !== path) {
      navigate(path, { direction: 'back' })
      return
    }
    window.scrollTo({ top: 0, behavior: prefersStillness() ? 'auto' : 'smooth' })
  }

  function indexAtLocalX(localX: number) {
    let closest = active
    let minDist = Infinity
    for (let i = 0; i < items.length; i += 1) {
      const slot = measureSlot(i)
      if (!slot) continue
      const center = (slot.left + slot.right) / 2
      const dist = Math.abs(localX - center)
      if (dist < minDist) {
        minDist = dist
        closest = i
      }
    }
    return closest
  }

  function handlePointerDown(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || prefersStillness()) return
    dragRef.current = { id: e.pointerId, startX: e.clientX, lastX: e.clientX, dragged: false, target: active }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLElement>) {
    const g = dragRef.current
    const nav = navRef.current
    if (!g || g.id !== e.pointerId || !nav) return
    const moved = Math.abs(e.clientX - g.startX)
    if (!g.dragged) {
      if (moved < DRAG_THRESHOLD) return
      g.dragged = true
      setDragging(true)
      stopAnimations()
      try { nav.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    }
    const navBox = nav.getBoundingClientRect()
    const localX = e.clientX - navBox.left
    const first = measureSlot(0)
    const last = measureSlot(items.length - 1)
    if (!first || !last) return

    const dx = e.clientX - g.lastX
    g.lastX = e.clientX
    const restW = restWidthRef.current || first.width
    const stretch = clamp(Math.abs(dx) * 0.6, 0, restW * 0.42)
    const width = restW + stretch
    const half = width / 2
    const minCenter = first.left + half
    const maxCenter = last.right - half
    const center = clamp(localX, minCenter, maxCenter)
    leftMV.jump(center - half)
    rightMV.jump(center + half)

    const target = indexAtLocalX(localX)
    if (target !== g.target) {
      g.target = target
      setScrubIndex(target)
    }
  }

  function finishDrag(e: React.PointerEvent<HTMLElement>) {
    const g = dragRef.current
    if (!g || g.id !== e.pointerId) return
    dragRef.current = null
    if (!g.dragged) return

    suppressClickRef.current = true
    requestAnimationFrame(() => { suppressClickRef.current = false })
    try { navRef.current?.releasePointerCapture?.(e.pointerId) } catch { /* not captured */ }
    setDragging(false)
    setScrubIndex(null)

    const target = g.target
    if (target !== active) {
      prevActiveRef.current = target
      navigate(items[target].path, { direction: 'tab' })
      snapTo(target, false)
    } else {
      snapTo(active, false)
    }
  }

  const highlighted = scrubIndex ?? active

  return (
    <>
      <div className="gdock-edge" aria-hidden="true" />
      <nav
        ref={navRef}
        className={`gdock${dragging ? ' is-dragging' : ''}`}
        aria-label={t('nav.primary')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <motion.span
          className={`gdock-pill${dragging ? ' is-dragging' : ''}`}
          aria-hidden="true"
          style={{
            x: leftMV,
            width: widthMV,
            scaleY: scaleYMV,
            opacity: measured ? 1 : 0,
          }}
        />
        {items.map(({ path, label, Icon }, index) => {
          const isActive = active === index
          const isHighlighted = highlighted === index
          return (
            <button
              key={path}
              ref={(el) => { buttonRefs.current[index] = el }}
              type="button"
              className="gdock-item"
              aria-label={t(label)}
              aria-current={isActive ? 'page' : undefined}
              data-active={isActive}
              data-highlighted={isHighlighted}
              // Tabs slide in the dock's order: a tab to the right comes in from the right.
              onClick={() => {
                if (suppressClickRef.current) return
                if (isActive) reselect(path)
                else navigate(path, { direction: 'tab' })
              }}
            >
              <span className="gdock-glyph">
                <Icon size={23} strokeWidth={isHighlighted ? 2.1 : 1.7} aria-hidden="true" />
              </span>
            </button>
          )
        })}
      </nav>
    </>
  )
}
