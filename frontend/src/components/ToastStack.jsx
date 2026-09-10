import React, { useEffect, useState } from 'react';
import { onToast } from '../toast.js';

export default function ToastStack() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    return onToast((t) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 4000);
    });
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => <div className="toast" key={t.id}>{t.text}</div>)}
    </div>
  );
}
