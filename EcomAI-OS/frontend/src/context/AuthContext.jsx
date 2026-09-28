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

  // No credentials involved: the server hands back a session for the shared
  // demo tenant, so a visitor can look at a populated workspace immediately.
  // `isDemo` rides along on the user so the shell can say what they are seeing.
  const enterDemo = useCallback(async () => {
    const { user: u } = await auth.enterDemo();
    setUser(u);
    return u;
  }, []);

  const signup = useCallback(async (payload) => {
    const { user: u, confirmationRequired } = await auth.signup(payload);
    // With "Confirm email" enabled the account exists but there is no session
    // to represent. Setting the user would render an authenticated shell whose
    // every request then 401s, so the page is told to wait for the email
    // instead.
    if (!confirmationRequired) setUser(u);
    return { user: u, confirmationRequired: !!confirmationRequired };
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

  const value = { user, initializing, login, enterDemo, signup, logout, refreshProfile };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}