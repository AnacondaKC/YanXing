export function logUnexpectedError(scope: string, error: unknown) {
  console.error(`[${scope}]`, error)
}
