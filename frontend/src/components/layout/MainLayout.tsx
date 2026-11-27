import { MessageCircle } from 'lucide-react'
import { useLayoutEffect } from 'react'
import { Outlet, useLocation, useNavigationType } from 'react-router-dom'
import { useT } from '../../i18n'
import { usePageNavigate } from '../../utils/usePageNavigate'
import GlassDock from './GlassDock'
import WorkoutInProgressBar from './WorkoutInProgressBar'
import '../../styles/global.css'

function MainLayout() {
  const t = useT()
  const navigate = usePageNavigate()
  const { pathname } = useLocation()
  const navigationType = useNavigationType()
  // A new page starts at its top; Back keeps wherever the browser puts it.
  useLayoutEffect(() => {
    if (navigationType !== 'POP') window.scrollTo(0, 0)
  }, [pathname, navigationType])
  const hideDock = pathname.startsWith('/workouts/active') || pathname === '/premium' || pathname.startsWith('/coach')
  return (
    <div className={`app-shell${hideDock ? ' session-shell' : ''}`}>
      <main className={`app-main${hideDock ? ' session-main' : ''}`}><Outlet /></main>
      {hideDock ? null : <>
        <WorkoutInProgressBar />
        <button type="button" className="coach-fab" aria-label={t('coach.ask')} title={t('coach.ask')} onClick={() => navigate('/coach')}>
          <MessageCircle size={26} aria-hidden="true" />
        </button>
        <GlassDock />
      </>}
    </div>
  )
}

export default MainLayout
