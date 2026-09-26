import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { notificationsService } from '../services';
import { subscribe, usingApi } from '../services';

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

    // The service layer picks the source: the in-browser store in `mock` mode,
    // the tenant's audit trail in `api` mode. The in-browser store also pushes
    // updates as it mutates, so a live subscription is only wired up for that
    // one; in `api` mode a change is visible on the next load or refresh.
    let cancelled = false;

    const apply = (list) => {
      if (cancelled) return;
      setNotifications(list);
      setUnread(list.filter((n) => !n.read).length);
    };

    const load = async () => {
      try {
        apply(await notificationsService.getNotifications(user));
      } catch (error) {
        // The shell has to keep rendering when the bell cannot load, but the
        // failure is not swallowed: it is reported rather than silently leaving
        // an empty bell that looks like "nothing new".
        console.error('Could not load notifications', error);
      }
    };

    load();

    const unsub = usingApi()
      ? undefined
      : subscribe((db) => {
          if (!user || db.user.id !== user.id) return;
          apply([...db.notifications]);
        });

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [user, version]);

  const markRead = useCallback(
    async (id) => {
      if (!user) return;
      const list = await notificationsService.markNotificationRead(user, id);
      setNotifications(list);
      setUnread(list.filter((n) => !n.read).length);
    },
    [user],
  );

  const markAllRead = useCallback(async () => {
    if (!user) return;
    const list = await notificationsService.markAllNotificationsRead(user);
    setNotifications(list);
    setUnread(list.filter((n) => !n.read).length);
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
