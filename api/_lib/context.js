function parseCookieHeader(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}
function serializeCookie({ name, value = '', path = '/', maxAge, httpOnly = false, secure = true, sameSite = 'Lax', expires }) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}`;
  if (Number.isFinite(maxAge)) cookie += `; Max-Age=${Math.floor(maxAge)}`;
  if (expires) cookie += `; Expires=${new Date(expires).toUTCString()}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (secure) cookie += '; Secure';
  if (sameSite) cookie += `; SameSite=${sameSite}`;
  return cookie;
}
export async function withVercelContext(request, handler) {
  const current = parseCookieHeader(request.headers.get('cookie') || '');
  const changes = [];
  const context = {
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown',
    cookies: {
      get(name) { return current[name] || null; },
      set(options) { changes.push(serializeCookie(options)); current[options.name] = options.value; },
      delete(options) { changes.push(serializeCookie({ name: options.name, value: '', path: options.path || '/', maxAge: 0, expires: new Date(0), httpOnly: true, secure: true, sameSite: 'Strict' })); delete current[options.name]; }
    }
  };
  const response = await handler(request, context);
  if (!changes.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of changes) headers.append('set-cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
