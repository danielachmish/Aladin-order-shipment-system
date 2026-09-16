// כתובת ה-backend: מוגדרת ב-build דרך VITE_API_BASE (ר' .env.production / Vercel
// project settings). ברירת המחדל (localhost) מתאימה רק לפיתוח מקומי.
const API_ROOT = import.meta.env.VITE_API_BASE || 'http://localhost:4310';
// PHP-proxy shim (ר' backend/src/server.js, frontend/public/.htaccess) — נדרש
// בפריסת Cloudways כי ה-nginx שם מעביר ל-Apache רק בקשות שמסתיימות ב-.php.
// לא רלוונטי בפריסות אחרות (Render/Vercel), אז דלוק רק כש-VITE_API_PHP_SHIM=true.
const USE_PHP_SHIM = import.meta.env.VITE_API_PHP_SHIM === 'true';

function apiUrl(path) {
  return USE_PHP_SHIM ? `${API_ROOT}/api.php?_p=${encodeURIComponent(path)}` : `${API_ROOT}/api${path}`;
}

export const WS_BASE = USE_PHP_SHIM
  ? `${(import.meta.env.VITE_WS_BASE || API_ROOT.replace(/^http/, 'ws'))}/api.php?_p=${encodeURIComponent('/live')}`
  : `${(import.meta.env.VITE_WS_BASE || API_ROOT.replace(/^http/, 'ws'))}/api/live`;

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
  const res = await fetch(apiUrl(path), { ...opts, headers });
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
  pickItem: (key, lineNo, data) => request(`/orders/${encodeURIComponent(key)}/items/${lineNo}/pick`, { method: 'POST', body: JSON.stringify(data) }),
  checkItem: (key, lineNo, data) => request(`/orders/${encodeURIComponent(key)}/items/${lineNo}/check`, { method: 'POST', body: JSON.stringify(data) }),
  correctPickItem: (key, lineNo, data) => request(`/orders/${encodeURIComponent(key)}/items/${lineNo}/correct-pick`, { method: 'POST', body: JSON.stringify(data) }),
  finishCheck: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/finish-check`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  packDone: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/pack-done`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  deliverUps: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/deliver-ups`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  selfPickup: (key, expectedVersion) => request(`/orders/${encodeURIComponent(key)}/self-pickup`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  closeOrder: (key) => request(`/orders/${encodeURIComponent(key)}/close`, { method: 'POST', body: JSON.stringify({}) }),
  reportIssue: (key, reason) => request(`/orders/${encodeURIComponent(key)}/issue`, { method: 'POST', body: JSON.stringify({ reason }) }),
  releaseHold: (key, note) => request(`/orders/${encodeURIComponent(key)}/release-hold`, { method: 'POST', body: JSON.stringify({ note }) }),
  cancelOrder: (key, note) => request(`/orders/${encodeURIComponent(key)}/cancel`, { method: 'POST', body: JSON.stringify({ note }) }),
  requestWait: (key) => request(`/orders/${encodeURIComponent(key)}/request-wait`, { method: 'POST', body: JSON.stringify({}) }),
  receivedAnswer: (key) => request(`/orders/${encodeURIComponent(key)}/received-answer`, { method: 'POST', body: JSON.stringify({}) }),
  setPriority: (key, priority) => request(`/orders/${encodeURIComponent(key)}/priority`, { method: 'POST', body: JSON.stringify({ priority }) }),
  requestAddition: (key, note) => request(`/orders/${encodeURIComponent(key)}/request-addition`, { method: 'POST', body: JSON.stringify({ note }) }),
  additionReceived: (key) => request(`/orders/${encodeURIComponent(key)}/addition-received`, { method: 'POST', body: JSON.stringify({}) }),
  linkOrder: (key, otherOrderNum) => request(`/orders/${encodeURIComponent(key)}/link`, { method: 'POST', body: JSON.stringify({ otherOrderNum }) }),
  unlinkOrder: (key) => request(`/orders/${encodeURIComponent(key)}/unlink`, { method: 'POST', body: JSON.stringify({}) }),

  requestUrgent: (key) => request(`/orders/${encodeURIComponent(key)}/urgent-request`, { method: 'POST', body: JSON.stringify({}) }),
  pendingUrgent: () => request('/urgent-requests/pending'),
  decideUrgent: (id, approve) => request(`/urgent-requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ approve }) }),

  exceptions: () => request('/exceptions'),
  resolveLinkException: (id) => request(`/link-exceptions/${id}/resolve`, { method: 'POST', body: JSON.stringify({}) }),

  history: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request('/history' + (qs ? `?${qs}` : ''));
  },
  markShortageInvoiced: (key) => request(`/orders/${encodeURIComponent(key)}/mark-shortage-invoiced`, { method: 'POST', body: JSON.stringify({}) }),
  unmarkShortageInvoiced: (key) => request(`/orders/${encodeURIComponent(key)}/unmark-shortage-invoiced`, { method: 'POST', body: JSON.stringify({}) }),
  inventoryShortages: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request('/inventory/shortages' + (qs ? `?${qs}` : ''));
  },

  dashboard: () => request('/dashboard'),
  pendingOrders: () => request('/pending-orders'),
  shipments: () => request('/shipments'),

  listUsers: () => request('/users'),
  createUser: (data) => request('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) => request(`/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteUser: (id) => request(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getAgentViewScope: () => request('/settings/agent-view-scope'),
  setAgentViewScope: (scope) => request('/settings/agent-view-scope', { method: 'POST', body: JSON.stringify({ scope }) }),

  integrationsStatus: () => request('/admin/integrations-status'),

  getWooCommerceSettings: () => request('/admin/woocommerce-settings'),
  saveWooCommerceSettings: (data) => request('/admin/woocommerce-settings', { method: 'POST', body: JSON.stringify(data) }),
  testWooCommerceConnection: () => request('/admin/woocommerce-settings/test', { method: 'POST', body: JSON.stringify({}) }),
  wooCommerceProductStatus: (sku) => request(`/woocommerce/product-status?sku=${encodeURIComponent(sku)}`),
};
