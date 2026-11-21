import React, { useEffect, useMemo, useState } from 'react';
import { Bell, Play, RefreshCw, Check, Mail, MessageSquare } from 'lucide-react';
import {
  DeliveryStatus,
  Gym,
  GymNotification,
  GymSettings,
  Member,
  Membership,
  NotificationLog,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';
import {
  ActorContext,
  ServerCapabilities,
  fetchServerNotificationCapabilities,
  markNotificationRead,
  retryNotificationLog,
  runReminderBatchForGym,
  updateGymSettings,
} from '../../services/gymos-service';
import { isWhatsAppReady } from '../../lib/domain/reminders';
import { StatusLabel } from '../common/StatusBadge';
import { Pagination } from '../common/Pagination';

interface RemindersViewProps {
  actor: ActorContext;
  gym: Gym;
  settings: GymSettings;
  permissions: StaffPermissions;
  members: Member[];
  memberships: Membership[];
  logs: NotificationLog[];
  notifications: GymNotification[];
}

export const RemindersView: React.FC<RemindersViewProps> = ({
  actor,
  gym,
  settings,
  permissions,
  members,
  memberships,
  logs,
  notifications,
}) => {
  const isOwner =
    actor.role === UserRole.GYM_OWNER || actor.role === UserRole.SUPER_ADMIN;
  const canConfigure = isOwner || Boolean(permissions.canManageReminders);

  const [daysBeforeText, setDaysBeforeText] = useState(
    settings.reminderDaysBefore.join(', ')
  );
  const [sendOnExpiryDay, setSendOnExpiryDay] = useState(settings.sendOnExpiryDay);
  const [afterExpiryText, setAfterExpiryText] = useState(
    settings.sendAfterExpiryDays.join(', ')
  );
  const [paymentRemindersEnabled, setPaymentRemindersEnabled] = useState(
    settings.paymentRemindersEnabled ?? true
  );
  const [upcomingPaymentDays, setUpcomingPaymentDays] = useState(
    String(settings.upcomingPaymentReminderDays ?? 3)
  );
  const [overduePaymentText, setOverduePaymentText] = useState(
    (settings.overduePaymentReminderDays ?? [1, 3, 7, 14]).join(', ')
  );
  const [ownerSubText, setOwnerSubText] = useState(
    (settings.ownerSubReminderDays ?? [7, 3, 1, 0, -3]).join(', ')
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

  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  const [busy, setBusy] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchServerNotificationCapabilities().then((caps) => {
      if (!cancelled) setCapabilities(caps);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const whatsappReady = isWhatsAppReady({
    ...settings,
    whatsappEnabled,
    whatsappPhoneNumberId: whatsappPhoneId,
    whatsappApprovedTemplate: whatsappTemplate,
  });

  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedLogs = useMemo(
    () => logs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [logs, currentPage]
  );

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResultMsg(null);
    setErrorMsg(null);
    try {
      const parseDays = (txt: string, allowZeroAndNegative = false) =>
        txt
          .split(',')
          .map((n) => parseInt(n.trim(), 10))
          .filter((n) =>
            Number.isFinite(n) && (allowZeroAndNegative ? n >= -30 && n <= 90 : n > 0 && n <= 90)
          )
          .slice(0, 10);

      const beforeArr = parseDays(daysBeforeText);
      const afterArr = parseDays(afterExpiryText);
      const overdueArr = parseDays(overduePaymentText);
      const ownerSubArr = parseDays(ownerSubText, true);

      await updateGymSettings(actor, gym.id, {
        gracePeriodDays: settings.gracePeriodDays,
        renewalPolicy: settings.renewalPolicy,
        reminderDaysBefore: beforeArr,
        sendOnExpiryDay,
        sendAfterExpiryDays: afterArr,
        paymentRemindersEnabled,
        upcomingPaymentReminderDays: Math.max(0, Math.min(30, parseInt(upcomingPaymentDays, 10) || 0)),
        overduePaymentReminderDays: overdueArr,
        ownerSubReminderDays: ownerSubArr,
        emailEnabled,
        emailFromName: isOwner ? settings.emailFromName || gym.name : settings.emailFromName,
        inAppEnabled,
        whatsappEnabled: isOwner
          ? Boolean(whatsappEnabled && whatsappPhoneId.trim() && whatsappTemplate.trim())
          : settings.whatsappEnabled,
        ...(isOwner
          ? whatsappPhoneId.trim()
            ? { whatsappPhoneNumberId: whatsappPhoneId.trim() }
            : {}
          : settings.whatsappPhoneNumberId !== undefined
          ? { whatsappPhoneNumberId: settings.whatsappPhoneNumberId }
          : {}),
        ...(isOwner
          ? whatsappTemplate.trim()
            ? { whatsappApprovedTemplate: whatsappTemplate.trim() }
            : {}
          : settings.whatsappApprovedTemplate !== undefined
          ? { whatsappApprovedTemplate: settings.whatsappApprovedTemplate }
          : {}),
        currencySymbol: settings.currencySymbol,
      });
      setResultMsg('Reminder schedule and channels updated.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save reminder configuration.');
    } finally {
      setBusy(false);
    }
  };

  const handleRunEngine = async () => {
    setBusy(true);
    setResultMsg(null);
    setErrorMsg(null);
    try {
      const res = await runReminderBatchForGym(
        actor,
        gym,
        members,
        settings,
        logs,
        memberships
      );
      setResultMsg(
        `Reminder batch finished: ${res.sent} sent, ${res.skippedOptOut} skipped (opt-out), ${res.failed} queued for retry.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Reminder batch failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRetryLog = async (log: NotificationLog) => {
    setBusy(true);
    setResultMsg(null);
    setErrorMsg(null);
    try {
      const outcome = await retryNotificationLog(gym, settings, log);
      if (outcome.delivered) {
        setResultMsg(`Retry succeeded for ${log.memberName} (${log.channel}).`);
      } else {
        setErrorMsg(outcome.errorDetails || `Retry failed for ${log.memberName}.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to retry reminder.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Membership, Payment &amp; Subscription Reminders
          </h2>
          <p className="text-xs text-slate-500">
            Automated reminder dispatch respecting member opt-out preferences and real provider readiness
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={handleRunEngine}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer whitespace-nowrap disabled:opacity-50"
        >
          <Play className="w-3.5 h-3.5" />
          Run Due Reminders Now
        </button>
      </div>

      {/* Real Server Channel Capabilities */}
      {capabilities && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-start gap-3 text-xs">
            <Mail
              className={`w-4 h-4 shrink-0 mt-0.5 ${
                capabilities.emailConfigured ? 'text-emerald-700' : 'text-amber-600'
              }`}
            />
            <div>
              <p className="font-semibold text-slate-900">
                Email SMTP Delivery:{' '}
                <span className={capabilities.emailConfigured ? 'text-emerald-700' : 'text-amber-700'}>
                  {capabilities.emailConfigured ? 'Configured' : 'Not Configured on Server'}
                </span>
              </p>
              <p className="text-slate-500 mt-0.5">
                {capabilities.emailConfigured
                  ? `Sending from ${capabilities.smtpFrom || 'configured SMTP sender'}.`
                  : 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS on the server to enable outbound email reminders.'}
              </p>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-start gap-3 text-xs">
            <MessageSquare
              className={`w-4 h-4 shrink-0 mt-0.5 ${
                capabilities.whatsappConfigured ? 'text-emerald-700' : 'text-slate-500'
              }`}
            />
            <div>
              <p className="font-semibold text-slate-900">
                WhatsApp Cloud API:{' '}
                <span className={capabilities.whatsappConfigured ? 'text-emerald-700' : 'text-slate-600'}>
                  {capabilities.whatsappConfigured ? 'Server Token Ready' : 'Server Token Not Set'}
                </span>
              </p>
              <p className="text-slate-500 mt-0.5">
                {capabilities.whatsappConfigured
                  ? 'Meta Cloud API token is configured; add your Phone Number ID & approved template below.'
                  : 'Set WHATSAPP_CLOUD_ACCESS_TOKEN on the server and configure Phone Number ID & template below.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {resultMsg && (
        <div className="px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-800 flex items-center justify-between">
          <span>{resultMsg}</span>
          <button type="button" onClick={() => setResultMsg(null)} className="font-semibold cursor-pointer">
            Dismiss
          </button>
        </div>
      )}
      {errorMsg && (
        <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="font-semibold cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Configuration Panel */}
        <form
          onSubmit={handleSaveConfig}
          className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            Schedule &amp; Channel Configuration
          </h3>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Membership Expiry — Days Before (comma separated)
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
              Membership Expiry — Days After (comma separated)
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

          <div className="border-t border-slate-200 pt-3 space-y-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                disabled={!canConfigure}
                checked={paymentRemindersEnabled}
                onChange={(e) => setPaymentRemindersEnabled(e.target.checked)}
              />
              Enable Balance &amp; Overdue Payment Reminders
            </label>
            {paymentRemindersEnabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Upcoming Due Window (Days)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="30"
                    disabled={!canConfigure}
                    value={upcomingPaymentDays}
                    onChange={(e) => setUpcomingPaymentDays(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Overdue Days (comma sep.)
                  </label>
                  <input
                    type="text"
                    disabled={!canConfigure}
                    value={overduePaymentText}
                    onChange={(e) => setOverduePaymentText(e.target.value)}
                    placeholder="1, 3, 7, 14"
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                  />
                </div>
              </div>
            )}
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                Owner GymOS Subscription Alert Offsets (days before/after expiry)
              </label>
              <input
                type="text"
                disabled={!canConfigure}
                value={ownerSubText}
                onChange={(e) => setOwnerSubText(e.target.value)}
                placeholder="7, 3, 1, 0, -3"
                className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
          </div>

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
                  disabled={!isOwner}
                  checked={whatsappEnabled}
                  onChange={(e) => setWhatsappEnabled(e.target.checked)}
                />
                WhatsApp Business Notifications {isOwner ? '' : '(Owner managed)'}
              </label>
              {whatsappEnabled && (
                <div className="space-y-2 pl-5">
                  <input
                    type="text"
                    disabled={!isOwner}
                    placeholder="WhatsApp Phone Number ID"
                    value={whatsappPhoneId}
                    onChange={(e) => setWhatsappPhoneId(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                  />
                  <input
                    type="text"
                    disabled={!isOwner}
                    placeholder="Approved Template Name"
                    value={whatsappTemplate}
                    onChange={(e) => setWhatsappTemplate(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                  />
                  <p className="text-[11px] text-slate-500">
                    {whatsappReady
                      ? 'WhatsApp Phone ID and template configured.'
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
              className="w-full px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 cursor-pointer disabled:opacity-50"
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
            <div className="divide-y divide-slate-200 max-h-[28rem] overflow-y-auto">
              {notifications.slice(0, 20).map((n) => (
                <div key={n.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div>
                    <p
                      className={`text-xs ${
                        n.isRead ? 'text-slate-600' : 'font-semibold text-slate-900'
                      }`}
                    >
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
            Reminder Delivery &amp; Retry Logs
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
                  <th className="px-4 py-2.5 font-medium">Member / Target</th>
                  <th className="px-4 py-2.5 font-medium">Category &amp; Template</th>
                  <th className="px-4 py-2.5 font-medium">Channel &amp; Recipient</th>
                  <th className="px-4 py-2.5 font-medium">Status &amp; Provider Ref</th>
                  <th className="px-4 py-2.5 font-medium">Retries</th>
                  <th className="px-4 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {paginatedLogs.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono tabular-nums whitespace-nowrap">
                      <div>{l.scheduledDate}</div>
                      {(l.sentAt || l.lastAttemptAt) && (
                        <div className="text-[11px] text-slate-400">
                          {(l.sentAt || l.lastAttemptAt || '').slice(11, 19)} UTC
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{l.memberName}</td>
                    <td className="px-4 py-2.5">
                      {l.category && (
                        <span className="block text-[11px] text-slate-500">
                          {l.category.replace(/_/g, ' ')}
                        </span>
                      )}
                      <span className="font-mono text-[11px] text-slate-700">{l.template}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-slate-800">{l.channel}</span>
                      <span className="block font-mono text-[11px] text-slate-500">
                        {l.recipient}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusLabel status={l.deliveryStatus} />
                      {l.providerMessageId && (
                        <span className="block font-mono text-[10px] text-slate-500 mt-0.5">
                          Msg: {l.providerMessageId}
                        </span>
                      )}
                      {l.errorDetails && (
                        <span className="block text-[11px] text-red-600 mt-0.5">
                          {l.errorDetails}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">{l.retryCount}</td>
                    <td className="px-4 py-2.5 text-right">
                      {(l.deliveryStatus === DeliveryStatus.RETRY_SCHEDULED ||
                        l.deliveryStatus === DeliveryStatus.FAILED) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleRetryLog(l)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer disabled:opacity-50"
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
        <Pagination
          page={currentPage}
          pageSize={PAGE_SIZE}
          totalItems={logs.length}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
};
