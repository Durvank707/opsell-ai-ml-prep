import React from 'react';
import { Link } from 'react-router-dom';
import { Compass, ArrowLeft, LayoutDashboard } from 'lucide-react';
import Button from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';

export default function NotFoundPage() {
  const { user } = useAuth();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
        <Compass className="h-8 w-8" />
      </div>
      <h1 className="mt-6 text-5xl font-extrabold tracking-tight text-slate-900">404</h1>
      <p className="mt-2 text-lg font-bold text-slate-800">Page not found</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        The page you’re looking for doesn’t exist or has been moved.
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        <Link to={user ? '/app' : '/login'}>
          <Button icon={LayoutDashboard}>
            {user ? 'Back to Dashboard' : 'Back to Login'}
          </Button>
        </Link>
        <Link to="/">
          <Button variant="secondary" icon={ArrowLeft}>
            Home
          </Button>
        </Link>
      </div>
    </div>
  );
}