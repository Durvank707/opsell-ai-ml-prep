import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  Save,
  LogOut,
  Trash2,
  Camera,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { Field, Input, Select, Toggle } from '../components/ui/form';
import { ConfirmDialog } from '../components/ui/Modal';
import { Avatar } from '../components/layout/Logo';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { getSettings, updateSettings, updateNotificationPrefs } from '../services/settingsService';
import { updateProfile, changePassword, logoutAllSessions, deleteAccount } from '../services/authService';
import { LoadingSkeleton } from '../components/ui/Skeleton';
import { cn } from '../lib/utils';

export default function SettingsPage() {
  const { user, refreshProfile, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useData();

  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');

  // Profile form
  const [profile, setProfile] = useState({ name: '', businessName: '', email: '' });

  // Store form
  const [store, setStore] = useState({ currency: 'INR', defaultLeadTime: 7, safetyStockMethod: 'statistical', fixedSafetyDays: 7 });

  // Notifications
  const [prefs, setPrefs] = useState({ lowStock: true, stockout: true, forecast: true, simulation: true });

  // Security
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [logoutAllOpen, setLogoutAllOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getSettings(user);
      setSettings(data);
      setProfile({
        name: data.user?.name || '',
        businessName: data.user?.businessName || '',
        email: data.user?.email || '',
      });
      setStore({
        currency: data.currency || 'INR',
        defaultLeadTime: data.defaultLeadTime || 7,
        safetyStockMethod: data.safetyStockMethod || 'statistical',
        fixedSafetyDays: data.fixedSafetyDays || 7,
      });
      setPrefs({ ...data.notifications });
    } catch {
      toast.error('Unable to load settings. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const saveProfile = async () => {
    setSaving('profile');
    try {
      await updateProfile(user, profile);
      await refreshProfile();
      refresh();
      toast.success('Profile updated.');
    } catch (e) {
      toast.error(e.message || 'Unable to update your profile.');
    } finally {
      setSaving('');
    }
  };

  const saveStore = async () => {
    setSaving('store');
    try {
      await updateSettings(user, store);
      refresh();
      toast.success('Store settings saved.');
    } catch (e) {
      toast.error(e.message || 'Unable to save settings.');
    } finally {
      setSaving('');
    }
  };

  const savePrefs = async () => {
    setSaving('prefs');
    try {
      await updateNotificationPrefs(user, prefs);
      refresh();
      toast.success('Notification preferences saved.');
    } catch {
      toast.error('Unable to save preferences.');
    } finally {
      setSaving('');
    }
  };

  const savePassword = async () => {
    if (pw.newPassword.length < 8) return toast.error('New password must be at least 8 characters.');
    if (pw.newPassword !== pw.confirmPassword) return toast.error('New passwords do not match.');
    setSaving('password');
    try {
      await changePassword(user, { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      setPw({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Password changed successfully.');
    } catch (e) {
      toast.error(e.message || 'Unable to change your password.');
    } finally {
      setSaving('');
    }
  };

  const handleLogoutAll = async () => {
    setSaving('logoutall');
    try {
      await logoutAllSessions();
      await logout();
      toast.info('You have been signed out of all sessions.');
    } catch {
      toast.error('Unable to sign out all sessions.');
    } finally {
      setSaving('');
    }
  };

  const handleDeleteAccount = async () => {
    setSaving('delete');
    try {
      await deleteAccount(user, deletePassword);
      toast.info('Your account has been deleted.');
      navigate('/login');
    } catch (e) {
      toast.error(e.message || 'Unable to delete your account.');
    } finally {
      setSaving('');
      setDeleteOpen(false);
    }
  };

  if (loading && !settings) {
    return (
      <div className="space-y-5">
        <PageHeader title="Settings" subtitle="Manage your account and workspace." />
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Manage your account, store and workspace preferences." />

      <div className="space-y-5">
        {/* Profile */}
        <Card
          title="Profile"
          subtitle="Your personal details and business information."
          actions={<Button size="sm" icon={Save} loading={saving === 'profile'} onClick={saveProfile}>Save</Button>}
        >
          <div className="flex items-center gap-5">
            <div className="relative">
              <Avatar name={user?.name} size="lg" />
              <button
                onClick={() => toast.info('Avatar upload is not available in this demo.')}
                className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white ring-2 ring-white"
                aria-label="Change avatar"
              >
                <Camera className="h-3 w-3" />
              </button>
            </div>
            <p className="text-sm text-slate-500">
              <span className="block font-bold text-slate-800">{profile.name || user?.name}</span>
              {user?.email}
            </p>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Field label="Full Name">
              <Input value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} />
            </Field>
            <Field label="Business / Store Name">
              <Input value={profile.businessName} onChange={(e) => setProfile((p) => ({ ...p, businessName: e.target.value }))} />
            </Field>
            <Field label="Email">
              <Input type="email" value={profile.email} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} />
            </Field>
          </div>
        </Card>

        <div className="grid gap-5 xl:grid-cols-2">
          {/* Store settings */}
          <Card
            title="Store Settings"
            subtitle="Saved in this browser for this account."
            actions={<Button size="sm" icon={Save} loading={saving === 'store'} onClick={saveStore}>Save</Button>}
          >
            <div className="space-y-4">
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-800">
                These defaults are stored on this device, not on the server, so they do
                not currently change any number the app computes. Every product carries
                its own lead time, and safety stock, reorder points and forecasts are
                derived from each product's own recorded demand by the forecasting
                service. They are kept here so the preferences are ready to become
                workspace-level settings.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Currency">
                  <Select value={store.currency} onChange={(e) => setStore((s) => ({ ...s, currency: e.target.value }))}>
                    <option value="INR">INR (₹)</option>
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (€)</option>
                  </Select>
                </Field>
                <Field label="Default Lead Time (days)">
                  <Input
                    type="number"
                    min="1"
                    value={store.defaultLeadTime}
                    onChange={(e) => setStore((s) => ({ ...s, defaultLeadTime: Number(e.target.value) }))}
                  />
                </Field>
              </div>
              <div>
                <p className="label">Safety Stock Method</p>
                <div className="space-y-2">
                  {[
                    { value: 'statistical', label: 'Statistical (recommended)', desc: 'Calculated from demand variability and lead time.' },
                    { value: 'fixed_days', label: 'Fixed Days', desc: 'A fixed number of days of average demand.' },
                  ].map((m) => (
                    <label
                      key={m.value}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                        store.safetyStockMethod === m.value ? 'border-brand-400 bg-brand-50/60' : 'border-slate-200',
                      )}
                    >
                      <input
                        type="radio"
                        name="safety"
                        className="mt-0.5 accent-brand-600"
                        checked={store.safetyStockMethod === m.value}
                        onChange={() => setStore((s) => ({ ...s, safetyStockMethod: m.value }))}
                      />
                      <span>
                        <span className="block text-sm font-semibold text-slate-800">{m.label}</span>
                        <span className="block text-xs text-slate-500">{m.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {store.safetyStockMethod === 'fixed_days' && (
                  <div className="mt-3">
                    <Field label="Safety Stock Days">
                      <Input
                        type="number"
                        min="1"
                        value={store.fixedSafetyDays}
                        onChange={(e) => setStore((s) => ({ ...s, fixedSafetyDays: Number(e.target.value) }))}
                      />
                    </Field>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Notifications */}
          <Card
            title="Notification Preferences"
            subtitle="Choose what gets pushed to your notification center."
            actions={<Button size="sm" icon={Save} loading={saving === 'prefs'} onClick={savePrefs}>Save</Button>}
          >
            <div className="space-y-3">
              <Toggle
                checked={prefs.lowStock}
                onChange={(v) => setPrefs((p) => ({ ...p, lowStock: v }))}
                label="Low Stock Alerts"
                description="When a product drops below its reorder point."
              />
              <Toggle
                checked={prefs.stockout}
                onChange={(v) => setPrefs((p) => ({ ...p, stockout: v }))}
                label="Critical / Stockout Alerts"
                description="When a product is at immediate risk of running out."
              />
              <Toggle
                checked={prefs.forecast}
                onChange={(v) => setPrefs((p) => ({ ...p, forecast: v }))}
                label="Forecast Notifications"
                description="When demand forecasts are generated or refreshed."
              />
              <Toggle
                checked={prefs.simulation}
                onChange={(v) => setPrefs((p) => ({ ...p, simulation: v }))}
                label="Simulation Notifications"
                description="When inventory policy simulations complete."
              />
            </div>
          </Card>
        </div>

        {/* Security */}
        <Card title="Security" subtitle="Password, sessions and account management.">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                <ShieldCheck className="h-4 w-4" /> Change Password
              </p>
              <div className="space-y-3">
                <Field label="Current Password">
                  <Input type="password" value={pw.currentPassword} onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="New Password">
                    <Input type="password" value={pw.newPassword} onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))} />
                  </Field>
                  <Field label="Confirm">
                    <Input type="password" value={pw.confirmPassword} onChange={(e) => setPw((p) => ({ ...p, confirmPassword: e.target.value }))} />
                  </Field>
                </div>
                <Button size="sm" variant="secondary" loading={saving === 'password'} onClick={savePassword}>
                  Update Password
                </Button>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="text-sm font-bold text-slate-800">Active Sessions</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  1 active session on this device. Sign out everywhere to revoke access from other devices.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={LogOut}
                  loading={saving === 'logoutall'}
                  className="mt-3"
                  onClick={() => setLogoutAllOpen(true)}
                >
                  Sign Out All Sessions
                </Button>
              </div>

              <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
                <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
                  <Trash2 className="h-4 w-4 text-rose-500" /> Danger Zone
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Permanently delete your account and all workspace data. This cannot be undone.
                </p>
                <Button size="sm" variant="danger-soft" className="mt-3" onClick={() => setDeleteOpen(true)}>
                  Delete Account
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={logoutAllOpen}
        onClose={() => setLogoutAllOpen(false)}
        onConfirm={handleLogoutAll}
        title="Sign out of all sessions?"
        message="You will be signed out on every device, including this one."
        confirmLabel="Sign out everywhere"
        danger={false}
        loading={saving === 'logoutall'}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteAccount}
        title="Delete your account?"
        message="This permanently removes your account, products, sales history and forecasts."
        confirmLabel="Delete Account"
        loading={saving === 'delete'}
      >
        <div className="mb-4">
          <Field label="Confirm your password" required>
            <Input
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Enter your password to confirm"
            />
          </Field>
        </div>
      </ConfirmDialog>
    </div>
  );
}