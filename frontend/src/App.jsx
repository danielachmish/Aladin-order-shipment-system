import React, { useEffect, useState } from 'react';
import Login from './pages/Login.jsx';
import OrdersList from './pages/OrdersList.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Exceptions from './pages/Exceptions.jsx';
import History from './pages/History.jsx';
import PendingOrders from './pages/PendingOrders.jsx';
import Shipments from './pages/Shipments.jsx';
import Dashboard from './components/Dashboard.jsx';
import ManagementTools from './pages/ManagementTools.jsx';
import InventoryShortages from './pages/InventoryShortages.jsx';
import BackInStock from './pages/BackInStock.jsx';
import MyShortages from './pages/MyShortages.jsx';
import { getToken, getUser, clearSession } from './api.js';
import { roleLabel } from './labels.js';
import { connectLive, onLive, isConnected } from './ws.js';
import { showToast } from './toast.js';
import ToastStack from './components/ToastStack.jsx';

function isManagerRole(role) {
  return role === 'warehouse_manager' || role === 'system_admin';
}
function defaultTabFor(user) {
  // הדשבורד הוא מסך הבית של מנהל (לא כלי ניהול/הגדרות) — בקשת דניאל 14.9.2026
  return user && isManagerRole(user.role) ? 'dashboard' : 'orders';
}

export default function App() {
  const [user, setUser] = useState(getUser());
  const [tab, setTab] = useState(() => defaultTabFor(getUser()));
  const [openOrderKey, setOpenOrderKey] = useState(null);
  const [live, setLive] = useState(isConnected());
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (getToken()) {
      connectLive();
      const off = onLive((evt) => {
        if (evt.type === '__connected') setLive(true);
        if (evt.type === '__disconnected') setLive(false);
        if (evt.type === 'urgent_request' && evt.payload?.status === 'approved') {
          showToast('בקשת דחיפות אושרה — ההזמנה עלתה בתור');
        }
        if (evt.type === 'shipment' && evt.payload?.status === 'ship_exception') {
          showToast(`חריגת משלוח חדשה: ${evt.payload.track_no}`);
        }
        if (evt.type === 'shipment' && evt.payload?.status === 'ship_delivered') {
          showToast(`משלוח נמסר: ${evt.payload.track_no}`);
        }
      });
      return off;
    }
  }, [user]);

  if (!user) {
    return <Login onLoggedIn={(u) => { setUser(u); setTab(defaultTabFor(u)); connectLive(); }} />;
  }

  function logout() {
    clearSession();
    setUser(null);
    setOpenOrderKey(null);
  }

  const isManager = isManagerRole(user.role);
  const canSeeHistory = user.role === 'warehouse' || isManager;
  // ממתינות לאישור: מנהל, מנהל מחסן, וסוכנים — לא צוות המחסן השוטף (סעיף בקשת דניאל, 14.9.2026)
  const canSeePending = user.role === 'agent' || isManager;

  function openOrder(key) {
    setOpenOrderKey(key);
  }

  // מקור אמת אחד לרשימת הניווט — אותו מידע מוצג כ-Sidebar מלא במחשב, כ-Rail
  // עם אייקונים בלבד בטאבלט, וכניווט תחתון (עד 5 יעדים, השאר תחת "עוד") במובייל.
  // ר' "Responsive UX Refactor" (15.9.2026).
  const NAV_ITEMS = [
    isManager && { key: 'dashboard', icon: '🏠', label: 'דשבורד' },
    { key: 'orders', icon: '📦', label: 'הזמנות' },
    { key: 'exceptions', icon: '⚠️', label: 'חריגות' },
    canSeeHistory && { key: 'history', icon: '🕒', label: 'היסטוריה' },
    canSeePending && { key: 'pending', icon: '⏳', label: 'ממתינות' },
    { key: 'shipments', icon: '🚚', label: 'משלוחים' },
    isManager && { key: 'inventory', icon: '📉', label: 'חוסרי מלאי' },
    isManager && { key: 'backinstock', icon: '🔄', label: 'חזר למלאי' },
    user.role === 'agent' && { key: 'myshortages', icon: '📉', label: 'החוסרים שלי' },
    isManager && { key: 'management', icon: '🛠️', label: 'כלי ניהול' },
  ].filter(Boolean);

  const MOBILE_MAIN_COUNT = 4;
  const mobileMain = NAV_ITEMS.slice(0, MOBILE_MAIN_COUNT);
  const mobileOverflow = NAV_ITEMS.slice(MOBILE_MAIN_COUNT);

  function selectTab(key) {
    setTab(key);
    setMoreOpen(false);
  }

  function NavButton({ item }) {
    return (
      <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => selectTab(item.key)} title={item.label}>
        <span className="icon">{item.icon}</span>
        <span className="nav-label">{item.label}</span>
      </button>
    );
  }

  const pageTitle = openOrderKey ? 'פרטי הזמנה' : (NAV_ITEMS.find((i) => i.key === tab)?.label || 'אלדין');

  return (
    <div className="app-shell">
      <ToastStack />

      {/* ניווט — מוצג כ-Sidebar (מחשב) / Rail (טאבלט) דרך CSS; במובייל מוסתר ומוחלף ב-.mobile-bottom-nav */}
      {!openOrderKey && (
        <nav className="app-nav" aria-label="ניווט ראשי">
          <div className="app-nav-logo">אלדין</div>
          {NAV_ITEMS.map((item) => <NavButton key={item.key} item={item} />)}
        </nav>
      )}

      <div className="app-main">
        <div className="top-bar">
          <div className="title-group">
            <div className="title app-page-title">{pageTitle}</div>
            <div className={'live-pill live-pill-inline ' + (live ? 'on' : 'off')}>
              <span className="live-dot" /> {live ? 'מחובר בזמן אמת' : 'אין חיבור'}
            </div>
          </div>
          <div className="user">{user.name} · {roleLabel(user.role)}
            <button className="logout" style={{ marginRight: 8 }} onClick={logout}>יציאה</button>
          </div>
        </div>
        <div className={'live-pill live-pill-mobile-only ' + (live ? 'on' : 'off')}>
          <span className="live-dot" /> {live ? 'מחובר בזמן אמת' : 'אין חיבור — הנתונים עשויים להיות לא עדכניים'}
        </div>

        <div className="content">
          {openOrderKey ? (
            <OrderDetail user={user} orderKey={openOrderKey} onBack={() => setOpenOrderKey(null)} />
          ) : tab === 'dashboard' ? (
            <Dashboard user={user} onOpenOrder={openOrder} />
          ) : tab === 'orders' ? (
            <OrdersList user={user} onOpenOrder={openOrder} />
          ) : tab === 'exceptions' ? (
            <Exceptions user={user} onOpenOrder={openOrder} />
          ) : tab === 'history' ? (
            <History user={user} onOpenOrder={openOrder} />
          ) : tab === 'pending' ? (
            <PendingOrders />
          ) : tab === 'shipments' ? (
            <Shipments onOpenOrder={openOrder} />
          ) : tab === 'inventory' ? (
            <InventoryShortages />
          ) : tab === 'backinstock' ? (
            <BackInStock />
          ) : tab === 'myshortages' ? (
            <MyShortages />
          ) : (
            <ManagementTools user={user} />
          )}
        </div>
      </div>

      {!openOrderKey && (
        <div className="mobile-bottom-nav">
          {mobileMain.map((item) => (
            <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => selectTab(item.key)}>
              <span className="icon">{item.icon}</span>{item.label}
            </button>
          ))}
          {mobileOverflow.length > 0 && (
            <button className={mobileOverflow.some((i) => i.key === tab) ? 'active' : ''} onClick={() => setMoreOpen(true)}>
              <span className="icon">⋯</span>עוד
            </button>
          )}
        </div>
      )}

      {moreOpen && (
        <div className="modal-backdrop" onClick={() => setMoreOpen(false)}>
          <div className="modal-sheet more-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>עוד</h3>
            {mobileOverflow.map((item) => (
              <button key={item.key} className={'more-sheet-item' + (tab === item.key ? ' active' : '')} onClick={() => selectTab(item.key)}>
                <span className="icon">{item.icon}</span>{item.label}
              </button>
            ))}
            <button className="action-btn secondary" onClick={() => setMoreOpen(false)}>סגירה</button>
          </div>
        </div>
      )}
    </div>
  );
}
