/** Share of a target reached, clamped to 0..1; 0 when there is no target. */
export const percent = (current: number, target: number) => (target > 0 ? Math.max(0, Math.min(1, current / target)) : 0)
