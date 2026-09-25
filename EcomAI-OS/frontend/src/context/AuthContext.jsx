import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as auth from '../services/authService';
import { onAuthExpired } from '../api/tokenStore';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const session = await auth.getSession();
        if (mounted) setUser(session?.user ?? null);
      } catch {
        if (mounted) setUser(null);
      } finally {
        if (mounted) setInitializing(false);
      }
    })();
    const removeExpiredListener = onAuthExpired(() => {
      if (mounted) setUser(null);
    });
    return () => {
      mounted = false;
      removeExpiredListener();
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const { user: u } = await auth.login({ email, password });
    setUser(u);
    return u;
  }, []);

  const signup = useCallback(async (payload) => {
    const { user: u } = await auth.signup(payload);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    const session = await auth.getSession();
    const next = session?.user ?? null;
    setUser(next);
    return next;
  }, []);

  const value = { user, initializing, login, signup, logout, refreshProfile };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}