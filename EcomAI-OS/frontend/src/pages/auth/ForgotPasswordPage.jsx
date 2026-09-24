import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { MailCheck, ArrowLeft } from 'lucide-react';
import AuthLayout from './AuthLayout';
import Button from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/form';
import { useToast } from '../../context/ToastContext';
import { requestPasswordReset } from '../../services/authService';

export default function ForgotPasswordPage() {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null); // {email, resetToken}

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await requestPasswordReset(email.trim());
      // Security-conscious: always show the same message.
      setSent({ email: email.trim(), debugToken: res.sent ? res.resetToken : null });
      toast.success('If an account exists, a reset link has been sent.');
    } catch {
      toast.error('Unable to process your request. Please try again.');
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

        {!sent ? (
          <>
            <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">Forgot your password?</h2>
            <p className="mt-1 text-sm text-slate-500">
              Enter your email address and we’ll send you a link to reset it.
            </p>

            <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                  {error}
                </div>
              )}
              <Field label="Email address" required>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                />
              </Field>
              <Button type="submit" loading={loading} icon={!loading ? MailCheck : undefined} className="w-full" size="lg">
                Send Reset Link
              </Button>
            </form>
          </>
        ) : (
          <div className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <MailCheck className="h-7 w-7" />
            </div>
            <h2 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">Check your inbox</h2>
            <p className="mt-1.5 text-sm text-slate-500">
              If an account exists for <span className="font-semibold text-slate-700">{sent.email}</span>, a password
              reset link has been sent to it.
            </p>
            {sent.debugToken && (
              <div className="mt-4 rounded-xl border border-dashed border-brand-300 bg-brand-50/60 p-4 text-left">
                <p className="text-xs font-semibold text-brand-700">
                  Demo note: since email delivery is mocked, use this reset link:
                </p>
                <Link
                  to={`/reset-password?token=${sent.debugToken}`}
                  className="mt-1.5 block break-all text-xs font-semibold text-brand-600 underline hover:text-brand-700"
                >
                  Continue to reset password →
                </Link>
              </div>
            )}
            <Link
              to="/login"
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700"
            >
              <ArrowLeft className="h-4 w-4" /> Back to login
            </Link>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}