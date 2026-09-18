export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const PR_EVENTS = new Set(['pull_request', 'pull_request_target'])

export function parseBottomN(raw) {
  const s = String(raw ?? '1').trim()
  if (s === '') return 1
  if (!/^\d+$/.test(s)) {
    throw new ConfigError(
      `bottom-n must be a non-negative integer, got ${JSON.stringify(raw)}`,
    )
  }
  return Number(s)
}

export function parseRunTop(raw) {
  const s = String(raw ?? 'true').trim().toLowerCase()
  if (s === '') return true
  if (s === 'true') return true
  if (s === 'false') return false
  throw new ConfigError(`run-top must be true or false, got ${JSON.stringify(raw)}`)
}

export function isLowestUnmerged(stack, prBaseRef) {
  const stackBase = stack?.base?.ref
  return Boolean(stackBase && prBaseRef && stackBase === prBaseRef)
}

export function isTopOfStack(stack) {
  if (stack == null || stack.position == null || stack.size == null) return false
  return Number(stack.position) === Number(stack.size)
}

export function stackLooksValid(stack) {
  if (stack == null || typeof stack !== 'object') return false
  const position = Number(stack.position)
  const size = Number(stack.size)
  if (!Number.isFinite(position) || !Number.isFinite(size)) return false
  if (position < 1 || size < 1) return false
  return true
}

export function needsUnmergedDepth({ stack, prBaseRef, bottomN, runTop }) {
  if (!stackLooksValid(stack)) return false
  if (bottomN <= 1) return false
  if (isLowestUnmerged(stack, prBaseRef)) return false
  if (runTop && isTopOfStack(stack)) return false
  return true
}

function diagnostics(stack, prBaseRef) {
  if (!stackLooksValid(stack)) {
    return {
      is_stacked: stack != null,
      is_bottom: false,
      is_top: false,
      position: '',
      size: '',
    }
  }
  return {
    is_stacked: true,
    is_bottom: isLowestUnmerged(stack, prBaseRef),
    is_top: isTopOfStack(stack),
    position: String(Number(stack.position)),
    size: String(Number(stack.size)),
  }
}

/**
 * Pure should_run decision. remainingDepth is the 1-based index of this PR
 * among unmerged PRs, counting from the current lowest. Pass null when unknown.
 */
export function decide({
  eventName,
  bottomN,
  runTop,
  stack,
  prBaseRef,
  remainingDepth = null,
}) {
  if (!PR_EVENTS.has(eventName)) {
    return {
      should_run: true,
      reason: `not a pull_request event (${eventName}); running CI`,
      ...diagnostics(null, prBaseRef),
    }
  }

  if (stack == null) {
    return {
      should_run: true,
      reason: 'not in a stack; running CI',
      ...diagnostics(null, prBaseRef),
    }
  }

  const diag = diagnostics(stack, prBaseRef)

  if (!stackLooksValid(stack)) {
    return {
      should_run: true,
      reason: 'invalid stack metadata; running CI',
      ...diag,
    }
  }

  const lowest = diag.is_bottom
  const top = diag.is_top
  const depth = lowest ? 1 : remainingDepth == null ? null : Number(remainingDepth)

  if (
    needsUnmergedDepth({ stack, prBaseRef, bottomN, runTop }) &&
    (depth == null || !Number.isFinite(depth))
  ) {
    return {
      should_run: true,
      reason: 'could not determine remaining stack depth; running CI',
      ...diag,
    }
  }

  if (depth != null && Number.isFinite(depth) && depth <= bottomN) {
    const reason = lowest
      ? 'lowest unmerged PR in the remaining stack'
      : `remaining depth ${depth} is within bottom-n=${bottomN}`
    return { should_run: true, reason, ...diag }
  }

  if (runTop && top) {
    const reason =
      lowest && top
        ? 'single-layer stack (lowest unmerged and top)'
        : 'top of stack (run-top=true)'
    return { should_run: true, reason, ...diag }
  }

  const depthLabel =
    depth != null && Number.isFinite(depth)
      ? `remaining depth ${depth}`
      : `position ${diag.position}`
  return {
    should_run: false,
    reason: `middle of stack (${depthLabel} of size ${diag.size}); skipping expensive CI`,
    ...diag,
  }
}
