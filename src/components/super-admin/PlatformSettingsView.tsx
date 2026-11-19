import React, { useState } from 'react';
import { PlatformSettings } from '../../types/gymos';
import { ActorContext, updatePlatformSettings } from '../../services/gymos-service';

interface PlatformSettingsViewProps {
  actor: ActorContext;
  settings: PlatformSettings | null;
}

export const PlatformSettingsView: React.FC<PlatformSettingsViewProps> = ({
  actor,
  settings,
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
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      await updatePlatformSettings(actor, {
        ...form,
        supportPhone: form.supportPhone.trim() || 'Support via email',
        defaultGracePeriodDays: Number(form.defaultGracePeriodDays) || 0,
      });
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl bg-white border border-slate-200 rounded-lg p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900">
          Platform Contact & Manual Billing Instructions
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Displayed to gym owners on their billing panel and suspended-account lock screen.
        </p>
      </div>

      {saved && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-800">
          Platform settings updated and recorded in audit log.
        </div>
      )}

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
            className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
          >
            {busy ? 'Saving...' : 'Save Platform Settings'}
          </button>
        </div>
      </form>
    </div>
  );
};
