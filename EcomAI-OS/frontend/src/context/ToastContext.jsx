import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * Two contexts on purpose:
 *  - useToast()   -> stable action functions. Safe to put in effect dep arrays.
 *  - useToastState() -> live toast list. Only the ToastView renderer should use it.
 *
 * Keeping the actions stable means components can depend on `toast` in
 * useEffect deps without re-firing on every push.
 */
const ToastActionsContext = createContext(null);
const ToastStateContext = createContext(null);

let seq = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const remove = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message, { type = 'success', title = null, duration = 4500 } = {}) => {
      const id = `toast_${seq++}`;
      setToasts((prev) => [...prev, { id, message, type, title }].slice(-4));
      const timer = setTimeout(() => remove(id), duration);
      timers.current.set(id, timer);
      return id;
    },
    [remove],
  );

  const actions = useMemo(
    () => ({
      push,
      success: (message, opts = {}) => push(message, { ...opts, type: 'success' }),
      error: (message, opts = {}) => push(message, { ...opts, type: 'error', duration: 6000 }),
      info: (message, opts = {}) => push(message, { ...opts, type: 'info' }),
      warning: (message, opts = {}) => push(message, { ...opts, type: 'warning' }),
      remove,
    }),
    [push, remove],
  );

  const state = useMemo(() => ({ toasts, remove }), [toasts, remove]);

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastStateContext.Provider value={state}>{children}</ToastStateContext.Provider>
    </ToastActionsContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastActionsContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function useToastState() {
  const ctx = useContext(ToastStateContext);
  if (!ctx) throw new Error('useToastState must be used within ToastProvider');
  return ctx;
}