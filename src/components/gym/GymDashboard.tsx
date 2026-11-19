import React, { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  GymSettings,
  Member,
  MemberPayment,
  Membership,
  MembershipStatus,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';
import {
  computeGymDashboardMetrics,
  computeMonthlyTrends,
} from '../../lib/domain/metrics';
import { deriveMemberMembershipStatus } from '../../lib/domain/dates';
import { formatCurrency, toIsoDate } from '../../lib/utils';

interface GymDashboardProps {
  role: UserRole;
  permissions: StaffPermissions;
  members: Member[];
  payments: MemberPayment[];
  memberships: Membership[];
  settings: GymSettings | null;
  onNavigate: (tab: string) => void;
}

const CHART_COLORS = ['#0F766E', '#334155', '#D97706', '#DC2626', '#64748B'];

export const GymDashboard: React.FC<GymDashboardProps> = ({
  role,
  permissions,
  members,
  payments,
  memberships,
  settings,
  onNavigate,
}) => {
  const [referenceDate, setReferenceDate] = useState(toIsoDate());
  const currency = settings?.currencySymbol || '₹';
  const showFinancials =
    role === UserRole.GYM_OWNER ||
    role === UserRole.GYM_MANAGER ||
    permissions.canViewReports;

  const metrics = useMemo(
    () => computeGymDashboardMetrics(members, payments, memberships, referenceDate),
    [members, payments, memberships, referenceDate]
  );

  const trends = useMemo(
    () => computeMonthlyTrends(members, payments, memberships, referenceDate, 6),
    [members, payments, memberships, referenceDate]
  );

  const planDistribution = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) {
      if (m.isArchived) continue;
      const key = m.currentPlanName || 'Unassigned';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
  }, [members]);

  const statusBreakdown = useMemo(() => {
    let active = 0;
    let expiring = 0;
    let expired = 0;
    let none = 0;
    for (const m of members) {
      if (m.isArchived) continue;
      const st = deriveMemberMembershipStatus(m.membershipExpiryDate, referenceDate);
      if (st === MembershipStatus.ACTIVE) active += 1;
      else if (st === MembershipStatus.EXPIRING_SOON) expiring += 1;
      else if (st === MembershipStatus.EXPIRED) expired += 1;
      else none += 1;
    }
    return [
      { name: 'Active', count: active },
      { name: 'Expiring Soon', count: expiring },
      { name: 'Expired', count: expired },
      { name: 'No Plan', count: none },
    ];
  }, [members, referenceDate]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Operations Overview</h1>
          <p className="text-xs text-slate-500">
            Overview of your members, memberships, and confirmed collections
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-600">As of date</label>
          <input
            type="date"
            value={referenceDate}
            onChange={(e) => setReferenceDate(e.target.value || toIsoDate())}
            className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
          />
        </div>
      </div>

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Total Members</p>
          <p className="text-2xl font-semibold font-mono text-slate-900 tabular-nums mt-1">
            {metrics.totalMembers}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            +{metrics.newMembersThisMonth} new this month
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Active Members</p>
          <p className="text-2xl font-semibold font-mono text-emerald-700 tabular-nums mt-1">
            {metrics.activeMembers}
          </p>
          <p className="text-xs text-amber-700 mt-1">
            {metrics.expiringSoonMemberships} expiring within 7d
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Expired Memberships</p>
          <p className="text-2xl font-semibold font-mono text-red-700 tabular-nums mt-1">
            {metrics.expiredMemberships}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {metrics.renewalsThisMonth} renewals this month
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Pending Payments</p>
          <p className="text-2xl font-semibold font-mono text-amber-700 tabular-nums mt-1">
            {metrics.pendingPaymentsCount}
          </p>
          <button
            type="button"
            onClick={() => onNavigate('payments')}
            className="text-xs font-medium text-teal-700 hover:text-teal-800 mt-1 cursor-pointer"
          >
            {showFinancials
              ? `${formatCurrency(metrics.pendingPaymentsAmount, currency)} to verify →`
              : 'Review queue →'}
          </button>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">
            {showFinancials ? "Today's Collections" : 'Renewals This Month'}
          </p>
          <p className="text-2xl font-semibold font-mono text-slate-900 tabular-nums mt-1">
            {showFinancials
              ? formatCurrency(metrics.todaysCollections, currency)
              : metrics.renewalsThisMonth}
          </p>
          {showFinancials ? (
            <p className="text-xs text-slate-500 mt-1">
              Month: {formatCurrency(metrics.monthlyCollections, currency)} · Due:{' '}
              {formatCurrency(metrics.totalOutstandingFees, currency)}
            </p>
          ) : (
            <p className="text-xs text-slate-500 mt-1">Confirmed renewals</p>
          )}
        </div>
      </div>

      {showFinancials && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Monthly Confirmed Revenue Trend
            </h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#475569' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#475569' }} />
                  <Tooltip
                    formatter={(val) => formatCurrency(Number(val ?? 0), currency)}
                    contentStyle={{ fontSize: '12px', borderRadius: '6px' }}
                  />
                  <Bar dataKey="revenue" name="Confirmed Revenue" fill="#0F766E" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Registrations vs Renewals (6 Months)
            </h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#475569' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#475569' }} />
                  <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '6px' }} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Line type="monotone" dataKey="newMembers" name="New Members" stroke="#0F766E" strokeWidth={2} />
                  <Line type="monotone" dataKey="renewals" name="Renewals" stroke="#D97706" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Membership Distribution by Plan
          </h3>
          <div className="h-60">
            {planDistribution.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                Register members to see plan distribution.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={planDistribution}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label
                  >
                    {planDistribution.map((_, index) => (
                      <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '6px' }} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Active vs Expired Memberships
          </h3>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusBreakdown}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#475569' }} />
                <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '6px' }} />
                <Bar dataKey="count" name="Members" fill="#334155" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
