import { ArrowLeft, Ellipsis, Send } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import CoachActions from '../components/coach/CoachActions'
import CoachProgress from '../components/coach/CoachProgress'
import PremiumUpsellButton from '../components/premium/PremiumUpsellButton'
import {
  ChatLimitError,
  getChatConversation,
  getChatQuota,
  getCurrentUser,
  listChatConversations,
  sendChatMessage,
} from '../services/api'
import type { ChatMessage, ChatQuota, ConversationSummary } from '../types'
import { useT } from '../i18n'
import { describeError } from '../utils/errors'
import { useDialogBehavior } from '../utils/useDialogBehavior'
import { usePageNavigate } from '../utils/usePageNavigate'
import '../styles/ai-coach.css'

const SUGGESTIONS = ['coach.suggestWorkouts', 'coach.suggestFood', 'coach.suggestProgress'] as const

function localMessage(content: string): ChatMessage {
  return { id: `local-${Date.now()}`, role: 'user', content, exercises: [], created_at: new Date().toISOString() }
}

export default function AiCoach() {
  const t = useT()
  const { conversationId } = useParams()
  const navigate = useNavigate()
  const pageNavigate = usePageNavigate()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [quota, setQuota] = useState<ChatQuota | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [history, setHistory] = useState<ConversationSummary[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  // True while the user scrolls up through older messages: the header and input box slide out of the way.
  const [scrolledAway, setScrolledAway] = useState(false)
  const dialogRef = useDialogBehavior(showHistory, () => setShowHistory(false))
  // The conversation already on screen, so saving a new chat's URL does not reload it.
  const shownId = useRef<string | undefined>(undefined)
  // Goes up when the user opens another chat, so a late answer is not added to the wrong one.
  const view = useRef(0)
  const endRef = useRef<HTMLDivElement>(null)
  const limitReached = quota !== null && quota.used >= quota.limit
  const name = getCurrentUser()?.name?.split(' ')[0] ?? ''

  useEffect(() => {
    let mounted = true
    getChatQuota()
      .then((next) => mounted && setQuota(next))
      .catch(() => undefined) // The server still enforces the limit.
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (conversationId === shownId.current) return
    shownId.current = conversationId
    const current = ++view.current
    setMessages([])
    setError(null)
    setSending(false)
    setScrolledAway(false)
    setLoading(Boolean(conversationId))
    if (!conversationId) return
    getChatConversation(conversationId)
      .then((chat) => {
        if (view.current === current) setMessages(chat.messages)
      })
      .catch((failure) => {
        if (view.current !== current) return
        shownId.current = undefined // allows another try
        setError(describeError(failure, t('coach.errorLoad')))
      })
      .finally(() => {
        if (view.current === current) setLoading(false)
      })
  }, [conversationId, t])

  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, sending])

  useEffect(() => {
    let last = window.scrollY
    function onScroll() {
      const y = window.scrollY
      const atEnd = document.documentElement.scrollHeight - window.innerHeight - y < 48
      if (!atEnd && Math.abs(y - last) < 6) return // ignores finger jitter
      setScrolledAway(!atEnd && y > 48 && y < last)
      last = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const send = useCallback(async (text: string) => {
    const content = text.trim()
    if (!content || sending || loading || limitReached) return
    const current = view.current
    const pending = localMessage(content)
    setMessages((list) => [...list, pending])
    setDraft('')
    setError(null)
    setSending(true)
    try {
      const reply = await sendChatMessage(content, conversationId)
      setQuota(reply.quota)
      if (view.current !== current) return
      setMessages((list) => [...list, reply.message])
      if (!conversationId) {
        shownId.current = reply.conversation_id
        navigate(`/coach/${reply.conversation_id}`, { replace: true })
      }
    } catch (failure) {
      if (failure instanceof ChatLimitError) {
        setQuota((known) => (known ? { ...known, used: known.limit } : known))
      }
      if (view.current !== current) return
      setMessages((list) => list.filter((item) => item.id !== pending.id))
      setDraft(content)
      setError(describeError(failure, t('coach.errorSend')))
    } finally {
      if (view.current === current) setSending(false)
    }
  }, [conversationId, limitReached, loading, navigate, sending, t])

  function submit(event: FormEvent) {
    event.preventDefault()
    void send(draft)
  }

  function openHistory() {
    setMenuOpen(false)
    setHistory(null)
    setError(null)
    setShowHistory(true)
    listChatConversations()
      .then(setHistory)
      .catch((failure) => {
        setShowHistory(false)
        setError(describeError(failure, t('coach.errorLoad')))
      })
  }

  function openChat(id?: string) {
    setMenuOpen(false)
    setShowHistory(false)
    setDraft('')
    if (!id && !conversationId) {
      view.current += 1
      setMessages([])
      setError(null)
      setSending(false)
      return
    }
    navigate(id ? `/coach/${id}` : '/coach', { replace: true })
  }

  function goBack() {
    if ((window.history.state?.idx ?? 0) > 0) pageNavigate(-1)
    else pageNavigate('/', { direction: 'back' })
  }

  const empty = !messages.length && !loading && !conversationId

  return (
    <div className="screen hifi-screen coach-screen">
      <header className={`coach-header${scrolledAway && !empty && !menuOpen ? ' is-away' : ''}`}>
        <button type="button" className="coach-round" aria-label={t('common.back')} onClick={goBack}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h1>{t('coach.title')}</h1>
        <div className="coach-menu">
          <button type="button" className="coach-round" aria-label={t('coach.menu')} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <Ellipsis size={20} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="coach-menu-list">
              <button type="button" onClick={() => openChat()}>{t('coach.newChat')}</button>
              <button type="button" onClick={openHistory}>{t('coach.history')}</button>
            </div>
          )}
        </div>
      </header>

      {empty ? (
        <div className="coach-empty">
          <div className="coach-orb" aria-hidden="true" />
          <p className="coach-hello">{t('coach.hello', { name })}</p>
          <h2>{t('coach.heading')}</h2>
          <div className="coach-suggestions">
            {SUGGESTIONS.map((key) => (
              <button key={key} type="button" className="coach-suggestion" disabled={sending || limitReached} onClick={() => void send(t(key))}>
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="coach-thread" aria-live="polite" aria-busy={loading || sending}>
          {loading && <p className="coach-note" role="status">{t('common.loading')}</p>}
          {messages.map((message) => (
            <div key={message.id} className={`coach-message is-${message.role}`}>
              <p>{message.content}</p>
              {message.exercises.length > 0 && (
                <ul aria-label={t('coach.exercises')}>
                  {message.exercises.map((exercise) => (
                    <li key={exercise.id}>
                      <button type="button" onClick={() => pageNavigate(`/exercises/${encodeURIComponent(exercise.id)}/guide`)}>{exercise.name}</button>
                    </li>
                  ))}
                </ul>
              )}
              {message.role === 'assistant' && <CoachActions message={message} />}
            </div>
          ))}
          {sending && <CoachProgress />}
          <div ref={endRef} />
        </div>
      )}

      <div className={`coach-composer${scrolledAway && !empty && !error && !limitReached ? ' is-away' : ''}`}>
        {error && <p className="coach-error" role="alert">{error}</p>}
        {limitReached ? (
          <div className="coach-limit" role="status">
            <p>{t(quota.is_premium ? 'coach.limitPremium' : 'coach.limitFree')}</p>
            {!quota.is_premium && <PremiumUpsellButton />}
          </div>
        ) : null}
        <form className="coach-input" onSubmit={submit}>
          <input
            value={draft}
            maxLength={1000}
            placeholder={t('coach.placeholder')}
            aria-label={t('coach.placeholder')}
            disabled={limitReached}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" aria-label={t('coach.send')} disabled={!draft.trim() || sending || loading || limitReached}>
            <Send size={20} aria-hidden="true" />
          </button>
        </form>
        <p className="coach-note">
          {quota && !limitReached ? `${t('coach.left', { left: quota.limit - quota.used, limit: quota.limit })} · ` : ''}
          {t('coach.disclaimer')}
        </p>
      </div>

      {showHistory && (
        <div className="ai-tip-backdrop" onClick={() => setShowHistory(false)}>
          <div
            className="ai-tip-dialog coach-history"
            role="dialog"
            aria-modal="true"
            aria-labelledby="coach-history-title"
            tabIndex={-1}
            ref={dialogRef}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="coach-history-title">{t('coach.history')}</h3>
            {history === null ? (
              <p role="status">{t('common.loading')}</p>
            ) : history.length === 0 ? (
              <p>{t('coach.historyEmpty')}</p>
            ) : (
              <ul>
                {history.map((chat) => (
                  <li key={chat.id}>
                    <button type="button" aria-current={chat.id === conversationId} onClick={() => openChat(chat.id)}>{chat.title}</button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="primary-button" onClick={() => setShowHistory(false)}>{t('common.close')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
