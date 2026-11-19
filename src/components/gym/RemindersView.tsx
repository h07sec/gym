import React, { useState } from 'react';
import { Bell, Play, RefreshCw, Check } from 'lucide-react';
import {
  DeliveryStatus,
  Gym,
  GymNotification,
  GymSettings,
  Member,
  NotificationLog,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';
import {
  ActorContext,
  markNotificationRead,
  retryNotificationLog,
  runReminderBatchForGym,
  updateGymSettings,
} from '../../services/gymos-service';
import { isWhatsAppReady } from '../../lib/domain/reminders';
import { StatusLabel } from '../common/StatusBadge';

interface RemindersViewProps {
  actor: ActorContext;
  gym: Gym;
  settings: GymSettings;
  permissions: StaffPermissions;
  members: Member[];
  logs: NotificationLog[];
  notifications: GymNotification[];
}

export const RemindersView: React.FC<RemindersViewProps> = ({
  actor,
  gym,
  settings,
  permissions,
  members,
  logs,
  notifications,
}) => {
  const canConfigure =
    actor.role === UserRole.GYM_OWNER ||
    actor.role === UserRole.GYM_MANAGER ||
    permissions.canManageReminders;

  const [daysBeforeText, setDaysBeforeText] = useState(
    settings.reminderDaysBefore.join(', ')
  );
  const [sendOnExpiryDay, setSendOnExpiryDay] = useState(settings.sendOnExpiryDay);
  const [afterExpiryText, setAfterExpiryText] = useState(
    settings.sendAfterExpiryDays.join(', ')
  );
  const [emailEnabled, setEmailEnabled] = useState(settings.emailEnabled);
  const [inAppEnabled, setInAppEnabled] = useState(settings.inAppEnabled);
  const [whatsappEnabled, setWhatsappEnabled] = useState(settings.whatsappEnabled);
  const [whatsappPhoneId, setWhatsappPhoneId] = useState(
    settings.whatsappPhoneNumberId || ''
  );
  const [whatsappTemplate, setWhatsappTemplate] = useState(
    settings.whatsappApprovedTemplate || ''
  );

  const [busy, setBusy] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const whatsappReady = isWhatsAppReady({
    ...settings,
    whatsappEnabled,
    whatsappPhoneNumberId: whatsappPhoneId,
    whatsappApprovedTemplate: whatsappTemplate,
  });

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResultMsg(null);
    try {
      const beforeArr = daysBeforeText
        .split(',')
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 10);
      const afterArr = afterExpiryText
        .split(',')
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 10);

      await updateGymSettings(actor, gym.id, {
        gracePeriodDays: settings.gracePeriodDays,
        renewalPolicy: settings.renewalPolicy,
        reminderDaysBefore: beforeArr,
        sendOnExpiryDay,
        sendAfterExpiryDays: afterArr,
        emailEnabled,
        emailFromName: settings.emailFromName || gym.name,
        inAppEnabled,
        whatsappEnabled: Boolean(
          whatsappEnabled && whatsappPhoneId.trim() && whatsappTemplate.trim()
        ),
        ...(whatsappPhoneId.trim()
          ? { whatsappPhoneNumberId: whatsappPhoneId.trim() }
          : {}),
        ...(whatsappTemplate.trim()
          ? { whatsappApprovedTemplate: whatsappTemplate.trim() }
          : {}),
        currencySymbol: settings.currencySymbol,
      });
      setResultMsg('Reminder schedule and channels updated.');
    } finally {
      setBusy(false);
    }
  };

  const handleRunEngine = async () => {
    setBusy(true);
    setResultMsg(null);
    try {
      const res = await runReminderBatchForGym(actor, gym, members, settings, logs);
      setResultMsg(
        `Reminder batch finished: ${res.sent} sent, ${res.skippedOptOut} skipped (opt-out), ${res.failed} queued for retry.`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Membership Reminders &amp; Notifications
          </h2>
          <p className="text-xs text-slate-500">
            Automated renewal reminders respecting member opt-out preferences
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={handleRunEngine}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer whitespace-nowrap"
        >
          <Play className="w-3.5 h-3.5" />
          Run Due Reminders Now
        </button>
      </div>

      {resultMsg && (
        <div className="px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-800">
          {resultMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Configuration Panel */}
        <form
          onSubmit={handleSaveConfig}
          className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            Schedule & Channel Configuration
          </h3>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Days Before Expiry (comma separated)
            </label>
            <input
              type="text"
              disabled={!canConfigure}
              value={daysBeforeText}
              onChange={(e) => setDaysBeforeText(e.target.value)}
              placeholder="7, 3, 1"
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Days After Expiry (comma separated)
            </label>
            <input
              type="text"
              disabled={!canConfigure}
              value={afterExpiryText}
              onChange={(e) => setAfterExpiryText(e.target.value)}
              placeholder="3, 7"
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              disabled={!canConfigure}
              checked={sendOnExpiryDay}
              onChange={(e) => setSendOnExpiryDay(e.target.checked)}
            />
            Send reminder on exact expiry date
          </label>

          <div className="border-t border-slate-200 pt-3 space-y-2.5">
            <p className="text-xs font-semibold text-slate-800">Delivery Channels</p>
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                disabled={!canConfigure}
                checked={inAppEnabled}
                onChange={(e) => setInAppEnabled(e.target.checked)}
              />
              In-App Notifications
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                disabled={!canConfigure}
                checked={emailEnabled}
                onChange={(e) => setEmailEnabled(e.target.checked)}
              />
              Email Notifications
            </label>

            <div className="pt-2 border-t border-slate-200 space-y-2">
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canConfigure}
                  checked={whatsappEnabled}
                  onChange={(e) => setWhatsappEnabled(e.target.checked)}
                />
                WhatsApp Business Notifications
              </label>
              {whatsappEnabled && (
                <div className="space-y-2 pl-5">
                  <input
                    type="text"
                    disabled={!canConfigure}
                    placeholder="WhatsApp Phone Number ID"
                    value={whatsappPhoneId}
                    onChange={(e) => setWhatsappPhoneId(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                  />
                  <input
                    type="text"
                    disabled={!canConfigure}
                    placeholder="Approved Template Name"
                    value={whatsappTemplate}
                    onChange={(e) => setWhatsappTemplate(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                  />
                  <p className="text-[11px] text-slate-500">
                    {whatsappReady
                      ? 'WhatsApp notifications configured.'
                      : 'Enter both Phone Number ID and Approved Template Name to enable.'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {canConfigure && (
            <button
              type="submit"
              disabled={busy}
              className="w-full px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 cursor-pointer"
            >
              Save Reminder Configuration
            </button>
          )}
        </form>

        {/* Gym In-App Notifications */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-teal-700" />
              <h3 className="text-sm font-semibold text-slate-900">
                Gym Notification Feed
              </h3>
            </div>
            <span className="text-xs font-mono text-slate-500 tabular-nums">
              {notifications.filter((n) => !n.isRead).length} unread
            </span>
          </div>

          {notifications.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">
              No notifications yet. Events like member registration, payment confirmation, and due reminders appear here.
            </p>
          ) : (
            <div className="divide-y divide-slate-200 max-h-80 overflow-y-auto">
              {notifications.slice(0, 15).map((n) => (
                <div key={n.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div>
                    <p className={`text-xs ${n.isRead ? 'text-slate-600' : 'font-semibold text-slate-900'}`}>
                      {n.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{n.message}</p>
                  </div>
                  {!n.isRead && (
                    <button
                      type="button"
                      onClick={() =>
                        markNotificationRead(`gyms/${gym.id}/notifications`, n.id)
                      }
                      className="p-1 text-slate-400 hover:text-teal-700 cursor-pointer"
                      title="Mark read"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delivery & Retry Logs */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">
            Reminder Delivery & Retry Logs
          </h3>
        </div>
        {logs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No reminder logs recorded yet. Click &ldquo;Run Due Reminders Now&rdquo; to evaluate members against your schedule.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Scheduled Date</th>
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 font-medium">Recipient</th>
                  <th className="px-4 py-2.5 font-medium">Channel</th>
                  <th className="px-4 py-2.5 font-medium">Template</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Retries</th>
                  <th className="px-4 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {logs.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono tabular-nums">{l.scheduledDate}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{l.memberName}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-600">{l.recipient}</td>
                    <td className="px-4 py-2.5">{l.channel}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-600">{l.template}</td>
                    <td className="px-4 py-2.5">
                      <StatusLabel status={l.deliveryStatus} />
                      {l.errorDetails && (
                        <span className="block text-[11px] text-red-600">{l.errorDetails}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">{l.retryCount}</td>
                    <td className="px-4 py-2.5 text-right">
                      {(l.deliveryStatus === DeliveryStatus.RETRY_SCHEDULED ||
                        l.deliveryStatus === DeliveryStatus.FAILED) && (
                        <button
                          type="button"
                          onClick={() => retryNotificationLog(gym.id, l)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
