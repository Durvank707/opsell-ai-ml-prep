import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import AuthLayout from './AuthLayout';
import Button from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/form';
import { useToast } from '../../context/ToastContext';
import { resetPassword } from '../../services/authService';

export default function ResetPasswordPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(!token ? 'This reset link is invalid or missing its token.' : '');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!token) {
      setError('This reset link is invalid or missing its token.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await resetPassword({ token, password });
      toast.success('Your password has been reset. Please sign in.');
      navigate('/login');
    } catch (err) {
      setError(err.message || 'Unable to reset your password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div>
        <div className="lg:hidden mb-8">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">EcomAI-OS</h1>
          <p className="mt-1 text-sm text-slate-500">AI-powered inventory intelligence for smarter stock decisions.</p>
        </div>

        <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">Set a new password</h2>
        <p className="mt-1 text-sm text-slate-500">Choose a strong password you haven’t used before.</p>

        <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
              {error}
            </div>
          )}

          <Field label="New Password" required>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="pr-10"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          <Field label="Confirm New Password" required>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>

          <Button type="submit" loading={loading} icon={!loading ? KeyRound : undefined} className="w-full" size="lg">
            Reset Password
          </Button>
        </form>

        <p className="mt-7 text-center text-sm text-slate-500">
          Remembered it?{' '}
          <Link to="/login" className="font-semibold text-brand-600 hover:text-brand-700">
            Back to login
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}