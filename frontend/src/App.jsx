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

  return (
    <div className="app-shell">
      <ToastStack />
      <div className="top-bar">
        <div className="title-group">
          <div className="title">אלדין</div>
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
          <History onOpenOrder={openOrder} />
        ) : tab === 'pending' ? (
          <PendingOrders />
        ) : tab === 'shipments' ? (
          <Shipments onOpenOrder={openOrder} />
        ) : (
          <ManagementTools onOpenOrder={openOrder} />
        )}
      </div>

      {!openOrderKey && (
        <div className="tabbar">
          {isManager && (
            <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>
              <span className="icon">🏠</span>דשבורד
            </button>
          )}
          <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
            <span className="icon">📦</span>הזמנות
          </button>
          <button className={tab === 'exceptions' ? 'active' : ''} onClick={() => setTab('exceptions')}>
            <span className="icon">⚠️</span>חריגות
          </button>
          {canSeeHistory && (
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
              <span className="icon">🕒</span>היסטוריה
            </button>
          )}
          {canSeePending && (
            <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
              <span className="icon">⏳</span>ממתינות
            </button>
          )}
          <button className={tab === 'shipments' ? 'active' : ''} onClick={() => setTab('shipments')}>
            <span className="icon">🚚</span>משלוחים
          </button>
          {isManager && (
            <button className={tab === 'management' ? 'active' : ''} onClick={() => setTab('management')}>
              <span className="icon">🛠️</span>כלי ניהול
            </button>
          )}
        </div>
      )}
    </div>
  );
}
