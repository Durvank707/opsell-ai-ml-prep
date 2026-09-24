import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DataProvider } from './context/DataContext';
import { ToastProvider } from './context/ToastContext';
import ToastView from './components/ui/ToastView';
import { FullPageLoader } from './components/ui/Skeleton';
import AppShell from './components/layout/AppShell';
import NotFoundPage from './pages/NotFoundPage';

const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const SignupPage = lazy(() => import('./pages/auth/SignupPage'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const ProductDetailPage = lazy(() => import('./pages/ProductDetailPage'));
const SalesDataPage = lazy(() => import('./pages/SalesDataPage'));
const ForecastPage = lazy(() => import('./pages/ForecastPage'));
const RecommendationsPage = lazy(() => import('./pages/RecommendationsPage'));
const SimulationPage = lazy(() => import('./pages/SimulationPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

/** Routes that require a signed-in user. */
function ProtectedRoute() {
  const { user, initializing } = useAuth();
  if (initializing) return <FullPageLoader label="Restoring your session…" />;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Routes that only make sense when signed out. */
function GuestRoute() {
  const { user, initializing } = useAuth();
  if (initializing) return <FullPageLoader label="Restoring your session…" />;
  if (user) return <Navigate to="/app" replace />;
  return <Outlet />;
}

/** Root guard — send signed-in users to the app, everyone else to login. */
function HomeRedirect() {
  const { user, initializing } = useAuth();
  if (initializing) return <FullPageLoader label="Restoring your session…" />;
  return <Navigate to={user ? '/app' : '/login'} replace />;
}

/** Scroll to top on navigation (respecting hash anchors). */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.querySelector(hash);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <DataProvider>
            <ScrollManager />
            <Suspense fallback={<FullPageLoader label="Loading…" />}>
              <Routes>
                <Route path="/" element={<HomeRedirect />} />

                <Route element={<GuestRoute />}>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/signup" element={<SignupPage />} />
                  <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                  <Route path="/reset-password" element={<ResetPasswordPage />} />
                </Route>

                <Route element={<ProtectedRoute />}>
                  <Route path="/app" element={<AppShell />}>
                    <Route index element={<DashboardPage />} />
                    <Route path="inventory" element={<InventoryPage />} />
                    <Route path="products" element={<ProductsPage />} />
                    <Route path="products/:productId" element={<ProductDetailPage />} />
                    <Route path="sales" element={<SalesDataPage />} />
                    <Route path="forecast" element={<ForecastPage />} />
                    <Route path="recommendations" element={<RecommendationsPage />} />
                    <Route path="simulation" element={<SimulationPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                  </Route>
                </Route>

                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
            <ToastView />
          </DataProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}