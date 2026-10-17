// Narrows an unknown caught value to a Node filesystem error with a given code, without a type assertion.

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
