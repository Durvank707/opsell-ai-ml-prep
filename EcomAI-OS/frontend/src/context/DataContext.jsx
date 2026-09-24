import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { getDB, subscribe } from '../services';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      setUnread(0);
      return undefined;
    }
    const load = () => {
      try {
        const db = getDB(user);
        setNotifications([...db.notifications]);
        setUnread(db.unreadCount());
      } catch {
        /* ignore */
      }
    };
    load();
    const unsub = subscribe((db) => {
      if (!user || db.user.id !== user.id) return;
      setNotifications([...db.notifications]);
      setUnread(db.unreadCount());
    });
    return unsub;
  }, [user, version]);

  const markRead = useCallback(
    (id) => {
      if (!user) return;
      const db = getDB(user);
      db.markNotificationRead(id);
      setNotifications([...db.notifications]);
      setUnread(db.unreadCount());
    },
    [user],
  );

  const markAllRead = useCallback(() => {
    if (!user) return;
    const db = getDB(user);
    db.markAllNotificationsRead();
    setNotifications([...db.notifications]);
    setUnread(db.unreadCount());
  }, [user]);

  const value = useMemo(
    () => ({
      notifications,
      unread,
      markRead,
      markAllRead,
      refresh,
      version,
    }),
    [notifications, unread, markRead, markAllRead, refresh, version],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}