import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import AuthLayout from './AuthLayout';
import Button from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/form';
import { useToast } from '../../context/ToastContext';
import { resetPassword } from '../../services/authService';

const EXPIRED_MESSAGE = 'This reset link has expired. Please request a new one.';

/**
 * Resolve the credential from a password-recovery link.
 *
 * Supabase Auth emails a link to its own `/verify` endpoint, which redirects to
 * this page carrying a short-lived recovery session. Because the backend calls
 * `POST /auth/v1/recover` without registering a PKCE challenge, GoTrue returns
 * that session in the URL *fragment* as `#access_token=...&type=recovery`.
 * Fragments never reach the server in a request line, so the token is read here
 * in the browser and handed straight to the backend, which forwards it to
 * `PUT /auth/v1/user` with the publishable key. The service-role key is never
 * involved and never leaves the server.
 *
 * The fragment is scrubbed with `replaceState` by `scrubRecoveryFragment`, so
 * the token does not linger in the address bar, in browser history, or in a
 * copied URL. `?token=` is still honoured because the mock demo hands out a
 * token directly and has no mail server to send a real link from.
 *
 * This function must stay pure. `StrictMode` double-invokes a `useState`
 * initializer in development, so a reader that also scrubbed the URL would
 * consume the credential on its first call and find nothing on its second --
 * and React keeps the second result, silently rejecting every real reset link.
 */
function readRecoveryCredential() {
  const empty = { token: '', problem: '' };
  if (typeof window === 'undefined') return empty;

  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));

  const fragmentError = fragment.get('error_description') || fragment.get('error') || '';
  const errorCode = fragment.get('error_code') || '';
  const code = query.get('code') || fragment.get('code') || '';
  const accessToken = fragment.get('access_token') || '';
  const queryToken = query.get('token') || '';

  if (errorCode === 'otp_expired' || /expired/i.test(fragmentError)) {
    return { token: '', problem: EXPIRED_MESSAGE };
  }
  if (fragmentError && !accessToken) {
    return { token: '', problem: 'This reset link is invalid or has already been used.' };
  }
  if (accessToken) {
    // Only a recovery session may set a password here. A sign-in or magic-link
    // session arriving at this URL is not a reset authorisation.
    const kind = fragment.get('type') || '';
    if (kind && kind !== 'recovery') {
      return {
        token: '',
        problem: 'This link is not a password-reset link. Please request a new one.',
      };
    }
    return { token: accessToken, problem: '' };
  }
  if (code) {
    // Only reachable if the auth server was configured for PKCE, which this
    // flow does not register. Say so plainly instead of failing as a bad token.
    return {
      token: '',
      problem:
        'This reset link could not be completed. Please request a new reset link.',
    };
  }
  if (queryToken) return { token: queryToken, problem: '' };
  return empty;
}

/**
 * Remove the credential from the address bar once it has been read.
 *
 * Runs in an effect rather than in the reader because rewriting history is a
 * side effect, and it is idempotent: a second call finds nothing to remove and
 * does nothing. React Router keeps its own snapshot of the location, so the
 * page still sees the query token after the URL has been rewritten.
 */
function scrubRecoveryFragment() {
  if (typeof window === 'undefined') return;
  const query = new URLSearchParams(window.location.search);
  const hasCredential =
    window.location.hash !== '' ||
    query.get('token') !== null ||
    query.get('code') !== null;
  if (hasCredential) {
    window.history.replaceState(null, '', window.location.pathname);
  }
}

export default function ResetPasswordPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Read once on mount, then strip the credential from the URL. Reading and
  // scrubbing are separate because only reading is safe to repeat.
  const [credential] = useState(readRecoveryCredential);
  useEffect(scrubRecoveryFragment, []);
  const token = credential.token || params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(
    credential.problem || (!token ? 'This reset link is invalid or missing its token.' : ''),
  );
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