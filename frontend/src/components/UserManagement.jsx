import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ROLE_LABELS } from '../labels.js';

const ROLES = Object.keys(ROLE_LABELS);
const ROLE_ICONS = { agent: '🧑‍💼', warehouse: '📦', warehouse_manager: '🗂️', system_admin: '🛡️' };

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState({}); // user_id -> { display_name, password, role }
  const [showNew, setShowNew] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', display_name: '', password: '', role: 'agent' });

  async function load() {
    const d = await api.listUsers();
    setUsers(d.users);
  }

  useEffect(() => { load(); }, []);

  function fieldFor(u, key) {
    return editing[u.user_id]?.[key] ?? u[key];
  }
  function setField(u, key, value) {
    setEditing((prev) => ({ ...prev, [u.user_id]: { ...prev[u.user_id], [key]: value } }));
  }

  async function saveUser(u) {
    setBusy(true);
    setError('');
    try {
      const changes = editing[u.user_id] || {};
      const payload = {};
      if (changes.display_name !== undefined && changes.display_name !== u.display_name) payload.display_name = changes.display_name;
      if (changes.role !== undefined && changes.role !== u.role) payload.role = changes.role;
      if (changes.password) payload.password = changes.password;
      if (changes.sigma_agent_id !== undefined && changes.sigma_agent_id !== (u.sigma_agent_id ?? '')) {
        payload.sigma_agent_id = changes.sigma_agent_id === '' ? '' : Number(changes.sigma_agent_id);
      }
      if (Object.keys(payload).length === 0) return;
      await api.updateUser(u.user_id, payload);
      setEditing((prev) => { const next = { ...prev }; delete next[u.user_id]; return next; });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(u) {
    if (!window.confirm(`למחוק לצמיתות את המשתמש "${u.display_name}" (${u.username})? לא ניתן לשחזר.`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteUser(u.user_id);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u) {
    setBusy(true);
    setError('');
    try {
      await api.updateUser(u.user_id, { is_active: u.is_active ? 0 : 1 });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function createUser() {
    setBusy(true);
    setError('');
    try {
      if (!newUser.username.trim() || !newUser.display_name.trim() || !newUser.password.trim()) {
        setError('חובה למלא שם משתמש, שם וסיסמה');
        return;
      }
      await api.createUser(newUser);
      setNewUser({ username: '', display_name: '', password: '', role: 'agent' });
      setShowNew(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <div className="error-box">{error}</div>}

      {users.map((u) => (
        <div className="admin-list-item" key={u.user_id}>
          <div className="user-card-header">
            <div className="user-card-icon">{ROLE_ICONS[fieldFor(u, 'role')] || '👤'}</div>
            <div style={{ flex: 1 }}>
              <input
                className="text-input"
                style={{ fontWeight: 'bold', marginBottom: 4 }}
                value={fieldFor(u, 'display_name')}
                onChange={(e) => setField(u, 'display_name', e.target.value)}
              />
              <div className="meta">משתמש: {u.username}</div>
            </div>
            {!u.is_active && <span className="badge inactive">מושבת</span>}
          </div>

          <div className="user-card-fields">
            <select className="select-input" value={fieldFor(u, 'role')} onChange={(e) => setField(u, 'role', e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <input
              className="text-input"
              type="text"
              placeholder="סיסמה חדשה (השאירו ריק ללא שינוי)"
              value={editing[u.user_id]?.password || ''}
              onChange={(e) => setField(u, 'password', e.target.value)}
            />
            {fieldFor(u, 'role') === 'agent' && (
              <input
                className="text-input"
                type="number"
                placeholder="מזהה סוכן בסיגמא (t_agents.agent_ID)"
                value={fieldFor(u, 'sigma_agent_id') ?? ''}
                onChange={(e) => setField(u, 'sigma_agent_id', e.target.value)}
              />
            )}
          </div>

          <div className="btn-row">
            <button className="action-btn" disabled={busy} onClick={() => saveUser(u)}>שמירה</button>
            <button className="action-btn secondary" disabled={busy} onClick={() => toggleActive(u)}>
              {u.is_active ? 'השבתה' : 'הפעלה מחדש'}
            </button>
            <button className="action-btn danger" disabled={busy} onClick={() => deleteUser(u)}>מחיקה לצמיתות</button>
          </div>
        </div>
      ))}

      {showNew ? (
        <div className="admin-list-item">
          <div className="user-card-header">
            <div className="user-card-icon">➕</div>
            <b>משתמש חדש</b>
          </div>
          <div className="user-card-fields">
            <input className="text-input" placeholder="שם מלא" value={newUser.display_name} onChange={(e) => setNewUser({ ...newUser, display_name: e.target.value })} />
            <input className="text-input" placeholder="שם משתמש (להתחברות)" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
            <input className="text-input" placeholder="סיסמה" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
            <select className="select-input" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
          <div className="btn-row">
            <button className="action-btn" disabled={busy} onClick={createUser}>יצירת משתמש</button>
            <button className="action-btn secondary" onClick={() => setShowNew(false)}>ביטול</button>
          </div>
        </div>
      ) : (
        <button className="action-btn secondary" style={{ marginTop: 8 }} onClick={() => setShowNew(true)}>+ משתמש חדש</button>
      )}
    </div>
  );
}
