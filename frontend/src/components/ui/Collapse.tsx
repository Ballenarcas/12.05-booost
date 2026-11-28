import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

/**
 * Opens and closes its content by animating the height, so what sits below glides instead of
 * jumping, the way iOS lists expand. Clipping only lasts while it moves, so focus rings show.
 */
export default function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const still = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
          animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
          exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
          transition={still ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.42 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
