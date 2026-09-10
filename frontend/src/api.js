// כתובת ה-backend: מוגדרת ב-build דרך VITE_API_BASE (ר' .env.production / Vercel
// project settings). ברירת המחדל (localhost) מתאימה רק לפיתוח מקומי.
const API_ROOT = import.meta.env.VITE_API_BASE || 'http://localhost:4310';
const BASE = API_ROOT + '/api';
export const WS_BASE = (import.meta.env.VITE_WS_BASE || API_ROOT.replace(/^http/, 'ws')) + '/api/live';

let token = localStorage.getItem('aladin_token') || null;
let currentUser = JSON.parse(localStorage.getItem('aladin_user') || 'null');

export function getToken() { return token; }
export function getUser() { return currentUser; }

export function setSession(tok, user) {
  token = tok;
  currentUser = user;
  localStorage.setItem('aladin_token', tok);
  localStorage.setItem('aladin_user', JSON.stringify(user));
}

export function clearSession() {
  token = null;
  currentUser = null;
  localStorage.removeItem('aladin_token');
  localStorage.removeItem('aladin_user');
}

async function request(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...opts, headers });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `שגיאת שרת (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  health: () => request('/health'),

  listOrders: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request('/orders' + (qs ? `?${qs}` : ''));
  },
  getOrder: (key) => request(`/orders/${encodeURIComponent(key)}`),

  claim: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/claim`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  finishPicking: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/finish-picking`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  packDone: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/pack-done`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  deliverUps: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/deliver-ups`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  closeOrder: (key) => request(`/orders/${encodeURIComponent(key)}/close`, { method: 'POST', body: JSON.stringify({}) }),
  reportIssue: (key, reason) => request(`/orders/${encodeURIComponent(key)}/issue`, { method: 'POST', body: JSON.stringify({ reason }) }),
  releaseHold: (key, note) => request(`/orders/${encodeURIComponent(key)}/release-hold`, { method: 'POST', body: JSON.stringify({ note }) }),
  cancelOrder: (key, note) => request(`/orders/${encodeURIComponent(key)}/cancel`, { method: 'POST', body: JSON.stringify({ note }) }),
  requestWait: (key) => request(`/orders/${encodeURIComponent(key)}/request-wait`, { method: 'POST', body: JSON.stringify({}) }),
  receivedAnswer: (key) => request(`/orders/${encodeURIComponent(key)}/received-answer`, { method: 'POST', body: JSON.stringify({}) }),
  setPriority: (key, priority) => request(`/orders/${encodeURIComponent(key)}/priority`, { method: 'POST', body: JSON.stringify({ priority }) }),

  requestUrgent: (key) => request(`/orders/${encodeURIComponent(key)}/urgent-request`, { method: 'POST', body: JSON.stringify({}) }),
  pendingUrgent: () => request('/urgent-requests/pending'),
  decideUrgent: (id, approve) => request(`/urgent-requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ approve }) }),

  exceptions: () => request('/exceptions'),
  resolveLinkException: (id) => request(`/link-exceptions/${id}/resolve`, { method: 'POST', body: JSON.stringify({}) }),

  history: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request('/history' + (qs ? `?${qs}` : ''));
  },

  dashboard: () => request('/dashboard'),

  getAgentViewScope: () => request('/settings/agent-view-scope'),
  setAgentViewScope: (scope) => request('/settings/agent-view-scope', { method: 'POST', body: JSON.stringify({ scope }) }),

  integrationsStatus: () => request('/admin/integrations-status'),
};
