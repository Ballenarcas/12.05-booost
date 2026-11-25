import { Dumbbell, House, TrendingUp, UserRound, type LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import { useLocation } from 'react-router-dom'
import { usePageNavigate } from '../../utils/usePageNavigate'
import { useT, type MessageKey } from '../../i18n'
import '../../styles/glass-dock.css'

type DockIcon = ComponentType<LucideProps>
type DockItem = { path: string; label: MessageKey; Icon: DockIcon }

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

  return (
    <nav
      className="gdock"
      aria-label={t('nav.primary')}
    >
      {items.map(({ path, label, Icon }, index) => {
        const isActive = active === index
        return (
          <button
            key={path}
            type="button"
            className="gdock-item"
            aria-label={t(label)}
            aria-current={isActive ? 'page' : undefined}
            data-active={isActive}
            // Tabs slide in the dock's order: a tab to the right comes in from the right.
            onClick={() => { if (!isActive) navigate(path, { direction: index > active ? 'forward' : 'back' }) }}
          >
            <span className="gdock-glyph">
              <Icon size={24} strokeWidth={1.6} aria-hidden="true" />
            </span>
          </button>
        )
      })}
    </nav>
  )
}
