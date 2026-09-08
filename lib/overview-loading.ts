export type OverviewLoadState = 'loading' | 'ready' | 'error'

export function combineOverviewLoadStates(left: OverviewLoadState, right: OverviewLoadState): OverviewLoadState {
  if (left === 'error' || right === 'error') return 'error'
  if (left === 'loading' || right === 'loading') return 'loading'
  return 'ready'
}

export function settleOverviewLoadState(current: OverviewLoadState, outcome: 'success' | 'failure'): OverviewLoadState {
  if (outcome === 'success' || current === 'ready') return 'ready'
  return 'error'
}
