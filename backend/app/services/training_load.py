"""Pure effort-weighting helpers shared by overtraining detection and Home AI tips."""


def set_effort_weight(rpe: float | None) -> float:
    """Convert a single working set's RPE into effort-adjusted load units.

    Low-volume high-RPE styles (e.g., Heavy Duty) accumulate fewer total units than
    high-volume high-RPE blocks, while still capturing intensity escalations at fixed sets.
    """
    if rpe is None:
        return 1.0
    if rpe <= 6.0:
        return 0.5
    if rpe <= 7.0:
        return 0.75
    if rpe <= 8.0:
        return 1.0
    if rpe <= 8.5:
        return 1.2
    if rpe <= 9.0:
        return 1.4
    if rpe <= 9.5:
        return 1.7
    return 2.0
