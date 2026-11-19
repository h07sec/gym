import React, { useEffect, useState } from 'react';
import { collection, getDocs, query, where, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { Download, Upload, Database } from 'lucide-react';
import { db } from '../../lib/firebase';
import {
  Gym,
  GymSettings,
  PlatformSettings,
  RenewalPolicy,
  SubscriptionPayment,
  UserRole,
} from '../../types/gymos';
import {
  ActorContext,
  exportGymBackupPayload,
  restoreGymBackupPayload,
  updateGymSettings,
} from '../../services/gymos-service';
import { formatCurrency, formatDisplayDate, toIsoDate } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { ConfirmModal } from '../common/ConfirmModal';

interface GymSettingsViewProps {
  actor: ActorContext;
  gym: Gym;
  settings: GymSettings;
  platformSettings: PlatformSettings | null;
}

export const GymSettingsView: React.FC<GymSettingsViewProps> = ({
  actor,
  gym,
  settings,
  platformSettings,
}) => {
  const [gymName, setGymName] = useState(gym.name);
  const [phone, setPhone] = useState(gym.phone);
  const [address, setAddress] = useState(gym.address || '');
  const [gracePeriodDays, setGracePeriodDays] = useState(settings.gracePeriodDays);
  const [renewalPolicy, setRenewalPolicy] = useState<RenewalPolicy>(settings.renewalPolicy);
  const [currencySymbol, setCurrencySymbol] = useState(settings.currencySymbol || '₹');
  const [subPayments, setSubPayments] = useState<SubscriptionPayment[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [pendingRestoreJson, setPendingRestoreJson] = useState<string | null>(null);
  const [pendingRestoreFile, setPendingRestoreFile] = useState<string>('');

  useEffect(() => {
    const loadHistory = async () => {
      try {
        const q =
          actor.role === UserRole.SUPER_ADMIN
            ? query(collection(db, 'subscription_payments'), where('gymId', '==', gym.id))
            : query(
                collection(db, 'subscription_payments'),
                where('ownerUid', '==', gym.ownerUid)
              );
        const snap = await getDocs(q);
        setSubPayments(snap.docs.map((d) => d.data() as SubscriptionPayment));
      } catch (err) {
        console.error('Could not load subscription payments:', err);
      }
    };
    loadHistory();
  }, [actor.role, gym.id, gym.ownerUid]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    setErrorMsg(null);
    try {
      await updateDoc(doc(db, 'gyms', gym.id), {
        name: gymName.trim(),
        phone: phone.trim(),
        address: address.trim(),
        renewalPolicy,
        updatedAt: serverTimestamp(),
      });
      await updateGymSettings(actor, gym.id, {
        gracePeriodDays: Number(gracePeriodDays) || 0,
        renewalPolicy,
        reminderDaysBefore: settings.reminderDaysBefore,
        sendOnExpiryDay: settings.sendOnExpiryDay,
        sendAfterExpiryDays: settings.sendAfterExpiryDays,
        paymentRemindersEnabled: settings.paymentRemindersEnabled,
        upcomingPaymentReminderDays: settings.upcomingPaymentReminderDays,
        overduePaymentReminderDays: settings.overduePaymentReminderDays,
        ownerSubReminderDays: settings.ownerSubReminderDays,
        emailEnabled: settings.emailEnabled,
        emailFromName: settings.emailFromName,
        inAppEnabled: settings.inAppEnabled,
        whatsappEnabled: settings.whatsappEnabled,
        whatsappPhoneNumberId: settings.whatsappPhoneNumberId,
        whatsappApprovedTemplate: settings.whatsappApprovedTemplate,
        currencySymbol: currencySymbol.trim() || '₹',
      });
      setSaved(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save gym settings.');
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadBackup = async () => {
    setBusy(true);
    setErrorMsg(null);
    setBackupMsg(null);
    try {
      const payload = await exportGymBackupPayload(gym);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${gym.name.toLowerCase().replace(/\s+/g, '_')}_backup_${toIsoDate()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setBackupMsg(
        `Exported backup (${payload.members.length} members, ${payload.memberPayments.length} payments, ${payload.attendance.length} attendance records).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to export backup.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingRestoreJson) return;
    setBusy(true);
    setErrorMsg(null);
    setBackupMsg(null);
    try {
      const res = await restoreGymBackupPayload(actor, gym, pendingRestoreJson);
      setBackupMsg(`Successfully restored ${res.restoredCount} records from ${pendingRestoreFile}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Backup restore failed.');
    } finally {
      setPendingRestoreJson(null);
      setPendingRestoreFile('');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {errorMsg && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="font-semibold cursor-pointer">
            Dismiss
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Gym Settings Form */}
        <form
          onSubmit={handleSave}
          className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-4"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Gym Profile &amp; Renewal Policies
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Configure your facility profile, member renewal grace period, and expiry calculation policy
            </p>
          </div>

          {saved && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-800">
              Gym settings saved.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Gym Name</label>
              <input
                type="text"
                required
                value={gymName}
                onChange={(e) => setGymName(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Address</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Expired Renewal Policy
              </label>
              <select
                value={renewalPolicy}
                onChange={(e) => setRenewalPolicy(e.target.value as RenewalPolicy)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={RenewalPolicy.EXTEND_FROM_EXPIRY}>
                  Extend from previous expiry within grace period
                </option>
                <option value={RenewalPolicy.START_TODAY_IF_EXPIRED}>
                  Start from today if membership already expired
                </option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Grace Period (Days)
              </label>
              <input
                type="number"
                min="0"
                max="90"
                value={gracePeriodDays}
                onChange={(e) => setGracePeriodDays(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Currency Symbol
              </label>
              <input
                type="text"
                maxLength={4}
                value={currencySymbol}
                onChange={(e) => setCurrencySymbol(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
            >
              {busy ? 'Saving...' : 'Save Gym Settings'}
            </button>
          </div>
        </form>

        {/* GymOS Subscription */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                GymOS Subscription
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Plan status and renewal billing
              </p>
            </div>
            <StatusLabel status={gym.subscriptionStatus} />
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs border-t border-slate-200 pt-4">
            <div>
              <p className="text-slate-500">Current Plan</p>
              <p className="font-semibold text-slate-900 mt-0.5">{gym.subscriptionPlanName}</p>
            </div>
            <div>
              <p className="text-slate-500">Account Status</p>
              <div className="mt-1">
                <StatusLabel status={gym.accountStatus} />
              </div>
            </div>
            <div>
              <p className="text-slate-500">Subscription Start</p>
              <p className="font-mono text-slate-900 mt-0.5">
                {formatDisplayDate(gym.subscriptionStartAt)}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Subscription Expiry</p>
              <p className="font-mono text-slate-900 mt-0.5">
                {formatDisplayDate(gym.subscriptionEndAt)}
              </p>
            </div>
          </div>

          {platformSettings && (
            <div className="border-t border-slate-200 pt-4 space-y-2 text-xs">
              <p className="font-semibold text-slate-800">Renewal Payment Instructions</p>
              {platformSettings.paymentInstructions && (
                <p className="text-slate-600 leading-relaxed">
                  {platformSettings.paymentInstructions}
                </p>
              )}
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 font-mono text-[11px] text-slate-700 space-y-1">
                {platformSettings.upiId && platformSettings.upiId !== 'gymos.platform@upi' && (
                  <p>UPI ID: {platformSettings.upiId}</p>
                )}
                {platformSettings.upiPayeeName && (
                  <p>Payee: {platformSettings.upiPayeeName}</p>
                )}
                <p>
                  Support: {platformSettings.supportEmail}
                  {platformSettings.supportPhone &&
                  platformSettings.supportPhone !== '+91-98000-00000'
                    ? ` · ${platformSettings.supportPhone}`
                    : ''}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Subscription Payment History */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">
            GymOS Subscription Payment History
          </h3>
        </div>
        {subPayments.length === 0 ? (
          <div className="p-6 text-xs text-slate-500">
            No subscription payments verified yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Payment Date</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 font-medium">Mode</th>
                  <th className="px-4 py-2.5 font-medium">Reference</th>
                  <th className="px-4 py-2.5 font-medium">Period</th>
                  <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {subPayments.map((sp) => (
                  <tr key={sp.id}>
                    <td className="px-4 py-2.5 font-mono">{sp.paymentDate}</td>
                    <td className="px-4 py-2.5">{sp.planName}</td>
                    <td className="px-4 py-2.5">{sp.paymentMode}</td>
                    <td className="px-4 py-2.5 font-mono">{sp.transactionReference || '—'}</td>
                    <td className="px-4 py-2.5 font-mono">
                      {sp.periodStart} → {sp.periodEnd}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-right">
                      {formatCurrency(sp.amount, currencySymbol)}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusLabel status={sp.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Data Backup & Restore */}
      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-slate-100 rounded-md text-slate-700">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Tenant Data Backup &amp; Restore
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Download a complete JSON snapshot of your members, plans, memberships, payments, receipts, attendance, and notification logs, or restore records from a verified backup belonging to {gym.name}.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={busy}
              onClick={handleDownloadBackup}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download Full Backup (JSON)
            </button>
            <label className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              Restore from JSON
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  file.text().then((txt) => {
                    setPendingRestoreFile(file.name);
                    setPendingRestoreJson(txt);
                  });
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>

        {backupMsg && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-800">
            {backupMsg}
          </div>
        )}
      </div>

      <ConfirmModal
        open={Boolean(pendingRestoreJson)}
        title="Restore Gym Records from JSON Backup"
        description={`Restore records from "${pendingRestoreFile}" into ${gym.name}? Tenant ID ownership is strictly verified and matching document IDs will be merged safely.`}
        confirmLabel="Restore Backup"
        variant="warning"
        onConfirm={handleConfirmRestore}
        onCancel={() => {
          setPendingRestoreJson(null);
          setPendingRestoreFile('');
        }}
      />
    </div>
  );
};
