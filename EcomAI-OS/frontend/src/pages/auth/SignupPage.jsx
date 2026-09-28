import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, MailCheck, UserPlus } from 'lucide-react';
import AuthLayout from './AuthLayout';
import Button from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/form';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

export default function SignupPage() {
  const { signup } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    fullName: '',
    businessName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Set when the identity provider created the account but issued no session,
  // which is what "Confirm email" does. The address is kept so the message can
  // name it, and so the field cannot be edited into a different one.
  const [awaitingConfirmation, setAwaitingConfirmation] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const validate = () => {
    if (!form.fullName.trim()) return 'Please enter your full name.';
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      return 'Please enter a valid email address.';
    if (form.password.length < 8) return 'Password must be at least 8 characters.';
    if (form.password !== form.confirmPassword) return 'Passwords do not match.';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { user, confirmationRequired } = await signup({
        fullName: form.fullName.trim(),
        businessName: form.businessName.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      if (confirmationRequired) {
        setAwaitingConfirmation(form.email.trim());
        return;
      }
      toast.success(`Welcome to EcomAI-OS, ${user.name.split(' ')[0]}!`);
      navigate('/app');
    } catch (err) {
      setError(err.message || 'Unable to create your account. Please try again.');
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

        <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">Create your account</h2>
        <p className="mt-1 text-sm text-slate-500">
          Set up your inventory intelligence workspace in minutes.
        </p>

        {awaitingConfirmation ? (
          <div className="mt-7">
            <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3.5">
              <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  Check your email
                </p>
                <p className="mt-1 text-sm text-emerald-800">
                  If <span className="font-medium">{awaitingConfirmation}</span> is new to
                  EcomAI-OS, we have sent it a confirmation link. Open that link to finish
                  setting up your workspace — you will be able to sign in once you have.
                </p>
              </div>
            </div>
            <p className="mt-5 text-sm text-slate-500">
              Already have an account, or already confirmed?{' '}
              <Link to="/login" className="font-semibold text-brand-600 hover:text-brand-700">
                Sign in
              </Link>
            </p>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
              {error}
            </div>
          )}

          <Field label="Full Name" required>
            <Input value={form.fullName} onChange={set('fullName')} placeholder="e.g. Priya Sharma" autoComplete="name" />
          </Field>

          <Field label="Business / Store Name" required>
            <Input value={form.businessName} onChange={set('businessName')} placeholder="e.g. TerraMart Retail" />
          </Field>

          <Field label="Email" required>
            <Input type="email" value={form.email} onChange={set('email')} placeholder="you@company.com" autoComplete="email" />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Password" required hint="At least 8 characters.">
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={set('password')}
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
            <Field label="Confirm Password" required>
              <Input
                type={showPassword ? 'text' : 'password'}
                value={form.confirmPassword}
                onChange={set('confirmPassword')}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </Field>
          </div>

          <Button type="submit" loading={loading} icon={!loading ? UserPlus : undefined} className="w-full" size="lg">
            Create Account
          </Button>
        </form>
        )}

        <p className="mt-7 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-brand-600 hover:text-brand-700">
            Login
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}