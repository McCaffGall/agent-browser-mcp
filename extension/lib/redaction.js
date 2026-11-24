// Redaction helpers for the extension so console logs, network metadata,
// and page reads never leak authorization headers, cookies, or secrets.

const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)$/i;
const SENSITIVE_PARAM_RE = /^(token|access_token|refresh_token|id_token|api_key|apikey|key|secret|password|passwd|auth|code|session|sig|signature)$/i;

export function redactText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [redacted]')
    .replace(/\b(authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(
      /\b(access_token|refresh_token|api[_-]?key|token|password|passwd|secret|auth)(["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi,
      '$1$2[redacted]',
    )
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '[redacted]');
}

export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[redacted]' : redactText(String(v ?? ''));
  }
  return out;
}

export function redactUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    for (const [k] of u.searchParams.entries()) {
      if (SENSITIVE_PARAM_RE.test(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.toString();
  } catch {
    return redactText(rawUrl);
  }
}
