import { BellRing, ChevronRight, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { getCurrentUser } from '../services/api'
import { MONTHLY_CHALLENGE, PROFILE_FRIENDS_PREVIEW } from '../data/profileMockups'
import { usePageNavigate } from '../utils/usePageNavigate'
import backIcon from '../assets/scan/back.svg'
import '../styles/profile.css'

export default function ProfileFriends() {
  const user = getCurrentUser()
  const navigate = usePageNavigate()
  const [infoOpen, setInfoOpen] = useState(false)
  const [buzzMessage, setBuzzMessage] = useState<string | null>(null)

  const firstName = user?.name?.trim().split(' ')[0] || 'You'
  const userInitials = [user?.name, user?.surname]
    .map((part) => part?.trim()[0] ?? '')
    .join('')
    .toUpperCase() || 'ME'

  const challengeTotal = MONTHLY_CHALLENGE.userWorkouts + MONTHLY_CHALLENGE.partnerWorkouts
  const challengePct = Math.min(100, Math.round((challengeTotal / MONTHLY_CHALLENGE.targetWorkouts) * 100))
  const currentMonthName = new Date().toLocaleDateString('en-US', { month: 'long' })

  function sendBuzz() {
    setBuzzMessage(`Preview: buzzed ${MONTHLY_CHALLENGE.partnerName}! Live friend nudges are coming soon.`)
  }

  return (
    <div className="screen hifi-screen hifi-theme friends-screen">
      <header className="friends-header">
        <button
          type="button"
          className="scan-back"
          aria-label="Go back to Profile"
          onClick={() => navigate('/profile', { direction: 'back' })}
        >
          <img src={backIcon} alt="" width={36} height={37} />
        </button>
        <h1>Friends</h1>
        <button
          type="button"
          className="friends-more-btn"
          aria-expanded={infoOpen}
          aria-label="Preview options"
          onClick={() => setInfoOpen((open) => !open)}
        >
          <MoreHorizontal size={20} aria-hidden="true" />
        </button>
      </header>

      <div className="preview-banner" role="note">
        <strong>Social preview</strong>
        <span>Mockup of upcoming friend challenges &amp; activity sharing.</span>
      </div>

      {infoOpen && (
        <div className="preview-banner" role="status">
          <span>Adding friends by username and sharing workout streaks will launch soon.</span>
        </div>
      )}

      <section className="challenge-section" aria-labelledby="challenge-heading">
        <div className="profile-section-head">
          <h2 className="hifi-section-title" id="challenge-heading">
            {currentMonthName} challenge
          </h2>
          <span className="profile-section-since">{MONTHLY_CHALLENGE.daysLeft}D</span>
        </div>

        <div className="challenge-pair" aria-hidden="true">
          <span
            className="challenge-pair-avatar"
            style={{ background: 'linear-gradient(145deg, #2d6eb5 0%, #72b6d9 100%)' }}
          >
            {userInitials}
          </span>
          <span
            className="challenge-pair-avatar"
            style={{ background: 'linear-gradient(145deg, #4b7999 0%, #8dcfe8 100%)' }}
          >
            {MONTHLY_CHALLENGE.partnerInitials}
          </span>
        </div>

        <div className="challenge-card">
          <h3 className="challenge-card-title">Complete {MONTHLY_CHALLENGE.targetWorkouts} workouts</h3>
          <div>
            <p className="challenge-progress-copy">
              <strong>{challengeTotal}</strong>/{MONTHLY_CHALLENGE.targetWorkouts}w
            </p>
            <span
              className="challenge-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={MONTHLY_CHALLENGE.targetWorkouts}
              aria-valuenow={challengeTotal}
              aria-label={`Monthly challenge progress: ${challengeTotal} of ${MONTHLY_CHALLENGE.targetWorkouts} workouts`}
            >
              <span className="challenge-fill" style={{ width: `${challengePct}%` }} />
            </span>
          </div>

          <ul className="challenge-rows" aria-label="Challenge participants">
            <li>
              <strong>{firstName}</strong>
              <span>{MONTHLY_CHALLENGE.userWorkouts} workouts</span>
            </li>
            <li>
              <strong>{MONTHLY_CHALLENGE.partnerName}</strong>
              <span>{MONTHLY_CHALLENGE.partnerWorkouts} workouts</span>
            </li>
          </ul>

          <button type="button" className="buzz-btn" onClick={sendBuzz}>
            <span>Give a buzz</span>
            <BellRing size={15} aria-hidden="true" />
          </button>

          {buzzMessage && (
            <p className="hifi-muted" role="status">
              {buzzMessage}
            </p>
          )}
        </div>
      </section>

      <section className="hifi-section" aria-labelledby="your-friends-title">
        <h2 className="hifi-section-title" id="your-friends-title">Your friends</h2>
        <div className="friends-list">
          {PROFILE_FRIENDS_PREVIEW.map((friend) => (
            <details className="friend-card" key={friend.id} open={friend.defaultOpen}>
              <summary className="friend-summary">
                <span className="friend-summary-left">
                  <span
                    className="friend-avatar"
                    style={{ background: friend.tone }}
                    aria-hidden="true"
                  >
                    {friend.initials}
                  </span>
                  <span className="friend-meta">
                    <span className="friend-name">{friend.name}</span>
                    <span className="friend-since">{friend.since}</span>
                  </span>
                </span>
                <ChevronRight className="friend-chevron" size={20} aria-hidden="true" />
              </summary>

              <div className="friend-stats">
                <div className="friend-stat-box">
                  <span className="friend-stat-label">WORKOUTS</span>
                  <p className="friend-stat-num">
                    {friend.workoutsDays}
                    <small>d</small>
                  </p>
                  <span className="friend-stat-delta">
                    <svg width="10" height="9" viewBox="0 0 10 9" fill="currentColor" aria-hidden="true">
                      <path d="M5 0L10 9H0L5 0Z" />
                    </svg>
                    {friend.workoutsDeltaPct}% from 2024
                  </span>
                </div>
                <div className="friend-stat-box">
                  <span className="friend-stat-label">TIME</span>
                  <p className="friend-stat-num">
                    {friend.timeHours}
                    <small>h</small>
                  </p>
                  <span className="friend-stat-delta">
                    <svg width="10" height="9" viewBox="0 0 10 9" fill="currentColor" aria-hidden="true">
                      <path d="M5 0L10 9H0L5 0Z" />
                    </svg>
                    {friend.timeDeltaPct}% from 2024
                  </span>
                </div>
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  )
}
