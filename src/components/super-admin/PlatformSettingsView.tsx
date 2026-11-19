import React, { useState } from 'react';
import { ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { PlatformAdmin, PlatformSettings } from '../../types/gymos';
import {
  ActorContext,
  addPlatformAdmin,
  revokePlatformAdmin,
  updatePlatformSettings,
} from '../../services/gymos-service';
import { ConfirmModal } from '../common/ConfirmModal';

interface PlatformSettingsViewProps {
  actor: ActorContext;
  settings: PlatformSettings | null;
  platformAdmins: PlatformAdmin[];
}

export const PlatformSettingsView: React.FC<PlatformSettingsViewProps> = ({
  actor,
  settings,
  platformAdmins,
}) => {
  const [form, setForm] = useState({
    supportEmail: settings?.supportEmail || actor.email,
    supportPhone:
      settings?.supportPhone && settings.supportPhone !== '+91-98000-00000'
        ? settings.supportPhone
        : '',
    upiId:
      settings?.upiId && settings.upiId !== 'gymos.platform@upi'
        ? settings.upiId
        : '',
    upiPayeeName: settings?.upiPayeeName || 'GymOS',
    paymentInstructions:
      settings?.paymentInstructions ||
      'Contact GymOS support for subscription renewal and payment verification instructions.',
    defaultGracePeriodDays: settings?.defaultGracePeriodDays ?? 7,
    allowPublicRegistration: settings?.allowPublicRegistration ?? true,
  });

  const [newAdmin, setNewAdmin] = useState({
    uid: '',
    email: '',
    displayName: '',
  });
  const [revokingAdmin, setRevokingAdmin] = useState<PlatformAdmin | null>(null);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(null);
    setErrorMsg(null);
    try {
      await updatePlatformSettings(actor, {
        ...form,
        supportPhone: form.supportPhone.trim() || 'Support via email',
        defaultGracePeriodDays: Number(form.defaultGracePeriodDays) || 0,
      });
      setSaved('Platform settings updated and recorded in audit log.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update platform settings.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(null);
    setErrorMsg(null);
    try {
      await addPlatformAdmin(actor, newAdmin);
      setSaved(`Authorized Super Admin ${newAdmin.email.trim().toLowerCase()}.`);
      setNewAdmin({ uid: '', email: '', displayName: '' });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to authorize Super Admin.');
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeAdminConfirm = async () => {
    if (!revokingAdmin) return;
    setErrorMsg(null);
    setSaved(null);
    try {
      await revokePlatformAdmin(actor, revokingAdmin);
      setSaved(`Revoked Super Admin access for ${revokingAdmin.email}.`);
      setRevokingAdmin(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to revoke Super Admin.');
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {saved && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-800 flex items-center justify-between">
          <span>{saved}</span>
          <button type="button" onClick={() => setSaved(null)} className="font-semibold cursor-pointer">
            Dismiss
          </button>
        </div>
      )}
      {errorMsg && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="font-semibold cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Platform Settings Form */}
      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Platform Contact &amp; Manual Billing Instructions
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Displayed to gym owners on their billing panel and suspended-account lock screen.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Support Email *
              </label>
              <input
                type="email"
                required
                value={form.supportEmail}
                onChange={(e) => setForm({ ...form, supportEmail: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Support Phone *
              </label>
              <input
                type="text"
                required
                value={form.supportPhone}
                onChange={(e) => setForm({ ...form, supportPhone: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Official UPI ID
              </label>
              <input
                type="text"
                value={form.upiId}
                onChange={(e) => setForm({ ...form, upiId: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                UPI Payee Name
              </label>
              <input
                type="text"
                value={form.upiPayeeName}
                onChange={(e) => setForm({ ...form, upiPayeeName: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Payment Instructions for Gym Owners
            </label>
            <textarea
              rows={3}
              value={form.paymentInstructions}
              onChange={(e) => setForm({ ...form, paymentInstructions: e.target.value })}
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Default Grace Period (Days)
              </label>
              <input
                type="number"
                min="0"
                max="90"
                value={form.defaultGracePeriodDays}
                onChange={(e) =>
                  setForm({ ...form, defaultGracePeriodDays: Number(e.target.value) })
                }
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700 pt-4 cursor-pointer">
              <input
                type="checkbox"
                checked={form.allowPublicRegistration}
                onChange={(e) =>
                  setForm({ ...form, allowPublicRegistration: e.target.checked })
                }
              />
              Allow public gym self-registration
            </label>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Saving...' : 'Save Platform Settings'}
            </button>
          </div>
        </form>
      </div>

      {/* Platform Administrators Registry */}
      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Platform Super Administrators Registry
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Authorized UIDs in <span className="font-mono">platform_admins</span> receive full SaaS control.
              Initial bootstrap uses <span className="font-mono">POST /api/admin/bootstrap</span> or{' '}
              <span className="font-mono">node scripts/init-super-admin.mjs</span>.
            </p>
          </div>
        </div>

        <div className="border border-slate-200 rounded-md overflow-hidden">
          {platformAdmins.length === 0 ? (
            <p className="p-4 text-xs text-slate-500">No entries loaded in platform_admins.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Admin Name</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Firebase UID</th>
                  <th className="px-4 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {platformAdmins.map((admin) => (
                  <tr key={admin.uid}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      {admin.displayName}
                      {admin.uid === actor.uid && (
                        <span className="ml-1.5 text-[10px] font-mono text-teal-700">(You)</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{admin.email}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500">
                      {admin.uid}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {admin.uid !== actor.uid && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRevokingAdmin(admin)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 rounded cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <form onSubmit={handleAddAdmin} className="border-t border-slate-200 pt-4 space-y-3">
          <p className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
            <UserPlus className="w-3.5 h-3.5 text-teal-700" />
            Authorize Additional Super Admin
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              required
              placeholder="Firebase UID"
              value={newAdmin.uid}
              onChange={(e) => setNewAdmin({ ...newAdmin, uid: e.target.value })}
              className="px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
            />
            <input
              type="email"
              required
              placeholder="Verified Google Email"
              value={newAdmin.email}
              onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })}
              className="px-3 py-2 text-xs border border-slate-200 rounded-md"
            />
            <input
              type="text"
              placeholder="Display Name"
              value={newAdmin.displayName}
              onChange={(e) => setNewAdmin({ ...newAdmin, displayName: e.target.value })}
              className="px-3 py-2 text-xs border border-slate-200 rounded-md"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 cursor-pointer disabled:opacity-50"
            >
              Add Super Admin
            </button>
          </div>
        </form>
      </div>

      <ConfirmModal
        open={Boolean(revokingAdmin)}
        title={`Revoke Super Admin · ${revokingAdmin?.email || ''}`}
        description="Removes this account from platform_admins and deactivates its Super Admin profile immediately."
        confirmLabel="Revoke Access"
        variant="danger"
        onConfirm={handleRevokeAdminConfirm}
        onCancel={() => setRevokingAdmin(null)}
      />
    </div>
  );
};
