import React, { useState } from 'react';
import { api, setSession } from '../api.js';

export default function Login({ onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token, user } = await api.login(username.trim(), password);
      setSession(token, user);
      onLoggedIn(user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <h1>אלדין</h1>
      <p style={{ textAlign: 'center', color: '#6b7280', marginTop: -8 }}>ניהול הזמנות ומשלוחים</p>
      {error && <div className="error-box">{error}</div>}
      <form onSubmit={submit}>
        <input placeholder="שם משתמש" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input placeholder="סיסמה" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="action-btn" disabled={busy || !username || !password} type="submit">
          {busy ? 'מתחבר...' : 'כניסה'}
        </button>
      </form>
      <div className="role-hint">
        משתמשי דמו: agent1/1234 (סוכנת) · agent2/1234 (סוכן)<br />
        warehouse/1234 (מחסן) · manager/1234 (מנהלת מחסן) · admin/1234
      </div>
    </div>
  );
}
