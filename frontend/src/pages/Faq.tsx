import { ChevronLeft, HelpCircle, Mail } from 'lucide-react'
import { useState } from 'react'
import { usePageNavigate } from '../utils/usePageNavigate'
import { useT, type MessageKey } from '../i18n'

const FAQ_ITEMS: { question: MessageKey; answer: MessageKey }[] = [
  { question: 'faq.q1', answer: 'faq.a1' },
  { question: 'faq.q2', answer: 'faq.a2' },
  { question: 'faq.q3', answer: 'faq.a3' },
  { question: 'faq.q4', answer: 'faq.a4' },
]
export default function Faq() {
  const t = useT()
  const navigate = usePageNavigate()
  const [showSupportMessage, setShowSupportMessage] = useState(false)
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <div className="screen hifi-theme faq-screen">
      <header className="active-workout-header">
        <button className="icon-button" type="button" onClick={() => navigate('/profile?settings=1')} aria-label={t('faq.back')}>
          <ChevronLeft size={22} />
        </button>
        <div className="workout-title">
          <h1>{t('faq.title')}</h1>
        </div>
      </header>

      <div className="faq-content" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* Section FAQ */}
        <section className="faq-list" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {FAQ_ITEMS.map((item, index) => (
            <article 
              key={index} 
              className="card faq-card" 
              style={{ padding: '16px', cursor: 'pointer', backgroundColor: 'var(--well)', borderRadius: '12px' }}
              onClick={() => setOpenIndex(openIndex === index ? null : index)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: '16px', margin: 0, fontWeight: 600 }}>{t(item.question)}</h3>
                <HelpCircle size={18} style={{ color: 'var(--text-muted)' }} />
              </div>
              {openIndex === index && (
                <p style={{ marginTop: '12px', fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {t(item.answer)}
                </p>
              )}
            </article>
          ))}
        </section>

        {/* Section Support (Conforme à la PA) */}
        <section className="support-section" style={{ marginTop: '16px', paddingTop: '24px', borderTop: '1px solid var(--line)' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>{t('faq.moreHelp')}</h2>
          
          <button 
            className="secondary-action" 
            type="button" 
            onClick={() => setShowSupportMessage(true)}
            style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
          >
            <Mail size={18} /> {t('faq.contact')}
          </button>

          {showSupportMessage && (
            <div style={{ marginTop: '16px', padding: '16px', backgroundColor: 'var(--green-tint)', border: '1px solid var(--green-tint)', borderRadius: '8px', color: 'var(--green)', fontSize: '14px', textAlign: 'center', lineHeight: 1.5 }}>
              {t('faq.supportMessage', { email: 'support@setandplate.com' })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
};