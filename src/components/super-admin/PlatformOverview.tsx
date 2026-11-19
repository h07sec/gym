import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  AuditLog,
  Gym,
  PlatformNotification,
  SubscriptionPayment,
  SubscriptionPaymentStatus,
  SubscriptionPlan,
} from '../../types/gymos';
import { computePlatformOverview } from '../../lib/domain/metrics';
import { formatCurrency, timestampToIso, toIsoDate } from '../../lib/utils';
import { markNotificationRead } from '../../services/gymos-service';
import { Check, ArrowUpRight, Building2 } from 'lucide-react';

interface PlatformOverviewProps {
  gyms: Gym[];
  plans: SubscriptionPlan[];
  payments: SubscriptionPayment[];
  notifications: PlatformNotification[];
  auditLogs: AuditLog[];
  onNavigateTab: (tab: string) => void;
  onLaunchGymProduct: () => void;
  onOpenSpecificGym: (gymId: string) => void;
}

export const PlatformOverview: React.FC<PlatformOverviewProps> = ({
  gyms,
  plans,
  payments,
  notifications,
  auditLogs,
  onNavigateTab,
  onLaunchGymProduct,
  onOpenSpecificGym,
}) => {
  const today = toIsoDate();
  const stats = computePlatformOverview(gyms, plans, payments, today);

  const revenueByPlan = plans.map((plan) => {
    const total = payments
      .filter(
        (p) =>
          p.planId === plan.id && p.status === SubscriptionPaymentStatus.VERIFIED
      )
      .reduce((s, p) => s + p.amount, 0);
    const count = gyms.filter((g) => g.subscriptionPlanId === plan.id).length;
    return {
      name: plan.name,
      revenue: total,
      gyms: count,
    };
  });

  const unreadNotifs = notifications.filter((n) => !n.isRead).slice(0, 6);

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-slate-900 font-semibold text-sm">
            <Building2 className="w-4 h-4 text-teal-700 shrink-0" />
            <span>Gym Workspaces</span>
          </div>
          <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
            Open any registered gym workspace to view or manage its operations, or create a new gym.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {gyms.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) onOpenSpecificGym(e.target.value);
              }}
              aria-label="Open gym workspace"
              className="px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-md cursor-pointer"
            >
              <option value="" disabled>
                Jump to a gym...
              </option>
              {gyms.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={onLaunchGymProduct}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer whitespace-nowrap"
          >
            <span>
              {gyms.length > 0 ? 'Open Gym Owner Product' : 'Create & Open First Gym'}
            </span>
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Total Registered Gyms</p>
          <p className="text-2xl font-semibold font-mono text-slate-900 tabular-nums mt-1.5">
            {stats.totalGyms}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {stats.activeGyms} active · {stats.suspendedGyms} suspended
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Monthly Recurring Revenue</p>
          <p className="text-2xl font-semibold font-mono text-teal-700 tabular-nums mt-1.5">
            {formatCurrency(stats.monthlyRecurringRevenue)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {stats.trialGyms} on trial · {stats.expiredSubscriptions} expired
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Verified Collections</p>
          <p className="text-2xl font-semibold font-mono text-slate-900 tabular-nums mt-1.5">
            {formatCurrency(stats.verifiedSubscriptionCollections)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {payments.filter((p) => p.status === SubscriptionPaymentStatus.RECORDED).length} pending review
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">New Registrations (Month)</p>
          <p className="text-2xl font-semibold font-mono text-slate-900 tabular-nums mt-1.5">
            {stats.newRegistrationsThisMonth}
          </p>
          <button
            type="button"
            onClick={() => onNavigateTab('gyms')}
            className="text-xs font-medium text-teal-700 hover:text-teal-800 mt-1 cursor-pointer"
          >
            Manage gyms →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Verified Subscription Revenue by Plan
              </h3>
              <p className="text-xs text-slate-500">
                Aggregated from verified manual Cash and UPI payments
              </p>
            </div>
          </div>
          <div className="h-64">
            {revenueByPlan.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No subscription plans configured yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={revenueByPlan}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#475569' }} />
                  <Tooltip
                    formatter={(val) => formatCurrency(Number(val ?? 0))}
                    contentStyle={{
                      fontSize: '12px',
                      borderRadius: '6px',
                      borderColor: '#E2E8F0',
                    }}
                  />
                  <Bar dataKey="revenue" fill="#0F766E" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              Platform Notifications
            </h3>
            <span className="text-xs font-mono text-slate-500 tabular-nums">
              {unreadNotifs.length} unread
            </span>
          </div>
          {unreadNotifs.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">
              All platform notifications have been reviewed.
            </p>
          ) : (
            <div className="divide-y divide-slate-200">
              {unreadNotifs.map((n) => (
                <div key={n.id} className="py-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-slate-900">{n.title}</p>
                    <p className="text-xs text-slate-600 mt-0.5">{n.message}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => markNotificationRead('platform_notifications', n.id)}
                    className="p-1 text-slate-400 hover:text-teal-700 cursor-pointer shrink-0"
                    title="Mark as read"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">
            Recent Platform Activity
          </h3>
          <button
            type="button"
            onClick={() => onNavigateTab('audit')}
            className="text-xs font-medium text-teal-700 hover:text-teal-800 cursor-pointer"
          >
            View full audit log
          </button>
        </div>
        {auditLogs.length === 0 ? (
          <div className="p-6 text-xs text-slate-500">No audit events recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Timestamp</th>
                  <th className="px-4 py-2.5 font-medium">Actor</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {auditLogs.slice(0, 8).map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono text-slate-500 tabular-nums whitespace-nowrap">
                      {timestampToIso(log.createdAt).slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{log.actorEmail}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-900">{log.action}</td>
                    <td className="px-4 py-2.5 text-slate-600">{log.summary}</td>
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
