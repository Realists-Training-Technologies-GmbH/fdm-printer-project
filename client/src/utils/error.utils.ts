export function errorSummary(e: any) {
  return e.message ? `${e.message}\n ${e.stack}` : `'${e}'`
}

/**
 * Pull a user-readable message out of a thrown error. Axios surfaces the
 * server's JSON body at `error.response.data`, but its top-level
 * `error.message` is the generic "Request failed with status code 400" —
 * useless in a snackbar. Prefer the server's `message`/`error` field, then
 * fall back to the axios message, then the stringified error.
 */
export function apiErrorMessage(e: any): string {
  const body = e?.response?.data
  if (body) {
    if (typeof body === 'string' && body.trim()) return body
    if (typeof body === 'object') {
      const msg = body.message ?? body.error
      if (typeof msg === 'string' && msg.trim()) return msg
    }
  }
  if (typeof e?.message === 'string' && e.message.trim()) return e.message
  return String(e)
}
