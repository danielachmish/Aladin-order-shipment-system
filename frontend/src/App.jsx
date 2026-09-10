import React, { useEffect, useState } from 'react';
import Login from './pages/Login.jsx';
import OrdersList from './pages/OrdersList.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Exceptions from './pages/Exceptions.jsx';
import History from './pages/History.jsx';
import Admin from './pages/Admin.jsx';
import { getToken, getUser, clearSession } from './api.js';
import { roleLabel } from './labels.js';
import { connectLive, onLive, isConnected } from './ws.js';
import { showToast } from './toast.js';
import ToastStack from './components/ToastStack.jsx';

export default function App() {
  const [user, setUser] = useState(getUser());
  const [tab, setTab] = useState('orders'); // orders | exceptions | admin
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
    return <Login onLoggedIn={(u) => { setUser(u); connectLive(); }} />;
  }

  function logout() {
    clearSession();
    setUser(null);
    setTab('orders');
    setOpenOrderKey(null);
  }

  const isManager = user.role === 'warehouse_manager' || user.role === 'system_admin';
  const canSeeHistory = user.role === 'warehouse' || isManager;

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
        ) : tab === 'orders' ? (
          <OrdersList user={user} onOpenOrder={openOrder} />
        ) : tab === 'exceptions' ? (
          <Exceptions user={user} onOpenOrder={openOrder} />
        ) : tab === 'history' ? (
          <History onOpenOrder={openOrder} />
        ) : (
          <Admin user={user} onOpenOrder={openOrder} />
        )}
      </div>

      {!openOrderKey && (
        <div className="tabbar">
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
          {isManager && (
            <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>
              <span className="icon">🛠️</span>ניהול
            </button>
          )}
        </div>
      )}
    </div>
  );
}
