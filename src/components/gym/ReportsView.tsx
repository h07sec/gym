import React, { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import {
  Gym,
  GymSettings,
  Member,
  MemberPayment,
  Membership,
} from '../../types/gymos';
import {
  computeDailyReport,
  computeMonthlyReport,
} from '../../lib/domain/metrics';
import { exportGenericCsv, triggerCsvDownload } from '../../lib/domain/csv';
import { formatCurrency, toIsoDate } from '../../lib/utils';

interface ReportsViewProps {
  gym: Gym;
  settings: GymSettings;
  members: Member[];
  payments: MemberPayment[];
  memberships: Membership[];
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  gym,
  settings,
  members,
  payments,
  memberships,
}) => {
  const currency = settings.currencySymbol || '₹';
  const today = toIsoDate();
  const [mode, setMode] = useState<'DAILY' | 'MONTHLY'>('DAILY');
  const [targetDate, setTargetDate] = useState(today);
  const [targetMonth, setTargetMonth] = useState(today.slice(0, 7));

  const daily = useMemo(
    () => computeDailyReport(members, payments, targetDate),
    [members, payments, targetDate]
  );

  const monthly = useMemo(
    () => computeMonthlyReport(members, payments, memberships, targetMonth),
    [members, payments, memberships, targetMonth]
  );

  const handleExportCsv = () => {
    if (mode === 'DAILY') {
      const csv = exportGenericCsv(
        ['Metric', 'Value'],
        [
          ['Gym', gym.name],
          ['Report Date', daily.date],
          ['New Registrations', daily.newRegistrations],
          ['Active Members', daily.activeMembers],
          ['Expiring Soon (7d)', daily.expiringSoonMembers],
          ['Expired Members', daily.expiredMembers],
          ['Confirmed Cash Collections', daily.cashCollections],
          ['Confirmed UPI Collections', daily.upiCollections],
          ['Total Confirmed Collections', daily.totalConfirmedCollections],
          ['Pending Payments Count', daily.pendingPaymentsCount],
          ['Pending Payments Amount (Excluded)', daily.pendingPaymentsAmount],
        ]
      );
      triggerCsvDownload(`daily_report_${daily.date}.csv`, csv);
    } else {
      const csv = exportGenericCsv(
        ['Metric', 'Value'],
        [
          ['Gym', gym.name],
          ['Report Month', monthly.monthKey],
          ['Total Confirmed Revenue', monthly.totalRevenue],
          ['Cash Revenue', monthly.cashRevenue],
          ['UPI Revenue', monthly.upiRevenue],
          ['New Members', monthly.newMembers],
          ['Renewals', monthly.renewals],
          ['Cancellations', monthly.cancellations],
          ['Total Outstanding Balances', monthly.outstandingBalances],
        ]
      );
      triggerCsvDownload(`monthly_report_${monthly.monthKey}.csv`, csv);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
          <button
            type="button"
            onClick={() => setMode('DAILY')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              mode === 'DAILY'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Daily Operational Report
          </button>
          <button
            type="button"
            onClick={() => setMode('MONTHLY')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              mode === 'MONTHLY'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Monthly Financial Report
          </button>
        </div>

        <div className="flex items-center gap-2">
          {mode === 'DAILY' ? (
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value || today)}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
            />
          ) : (
            <input
              type="month"
              value={targetMonth}
              onChange={(e) => setTargetMonth(e.target.value || today.slice(0, 7))}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
            />
          )}
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            Print Report
          </button>
        </div>
      </div>

      {mode === 'DAILY' ? (
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="border-b border-slate-200 pb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {gym.name} — Daily Collection & Operations Report
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Date: <span className="font-mono">{daily.date}</span> · Confirmed payments only
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Confirmed Collections</p>
              <p className="text-xl font-bold font-mono text-emerald-700 tabular-nums mt-1">
                {formatCurrency(daily.totalConfirmedCollections, currency)}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Cash Collections</p>
              <p className="text-xl font-semibold font-mono text-slate-900 tabular-nums mt-1">
                {formatCurrency(daily.cashCollections, currency)}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">UPI Collections</p>
              <p className="text-xl font-semibold font-mono text-slate-900 tabular-nums mt-1">
                {formatCurrency(daily.upiCollections, currency)}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Pending (Excluded)</p>
              <p className="text-xl font-semibold font-mono text-amber-700 tabular-nums mt-1">
                {formatCurrency(daily.pendingPaymentsAmount, currency)}
              </p>
              <p className="text-[11px] text-slate-500">
                {daily.pendingPaymentsCount} unverified
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-slate-200 pt-4 text-xs">
            <div>
              <p className="text-slate-500">New Registrations</p>
              <p className="text-base font-mono font-semibold text-slate-900 mt-0.5">
                {daily.newRegistrations}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Active Members</p>
              <p className="text-base font-mono font-semibold text-slate-900 mt-0.5">
                {daily.activeMembers}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Expiring Within 7d</p>
              <p className="text-base font-mono font-semibold text-amber-700 mt-0.5">
                {daily.expiringSoonMembers}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Expired Members</p>
              <p className="text-base font-mono font-semibold text-red-700 mt-0.5">
                {daily.expiredMembers}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="border-b border-slate-200 pb-4">
            <h2 className="text-base font-semibold text-slate-900">
              {gym.name} — Monthly Financial & Membership Report
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Period: <span className="font-mono">{monthly.monthKey}</span> · Pending payments excluded from revenue
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Total Confirmed Revenue</p>
              <p className="text-xl font-bold font-mono text-emerald-700 tabular-nums mt-1">
                {formatCurrency(monthly.totalRevenue, currency)}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Cash vs UPI Breakdown</p>
              <p className="text-xs font-mono text-slate-900 mt-1.5">
                Cash: {formatCurrency(monthly.cashRevenue, currency)}
              </p>
              <p className="text-xs font-mono text-slate-900">
                UPI: {formatCurrency(monthly.upiRevenue, currency)}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Member Growth</p>
              <p className="text-xs font-mono text-slate-900 mt-1.5">
                New: {monthly.newMembers}
              </p>
              <p className="text-xs font-mono text-slate-900">
                Renewals: {monthly.renewals}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Total Outstanding Dues</p>
              <p className="text-xl font-semibold font-mono text-red-700 tabular-nums mt-1">
                {formatCurrency(monthly.outstandingBalances, currency)}
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-slate-800 mb-2">
              Membership Plan Performance ({monthly.monthKey})
            </h3>
            <div className="border border-slate-200 rounded-md overflow-hidden">
              {monthly.planPerformance.length === 0 ? (
                <p className="p-4 text-xs text-slate-500">
                  No membership assignments or renewals recorded in {monthly.monthKey}.
                </p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Plan Name</th>
                      <th className="px-4 py-2.5 font-medium text-right">Enrollments / Renewals</th>
                      <th className="px-4 py-2.5 font-medium text-right">Paid Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {monthly.planPerformance.map((p) => (
                      <tr key={p.planName}>
                        <td className="px-4 py-2.5 font-medium text-slate-900">{p.planName}</td>
                        <td className="px-4 py-2.5 font-mono text-right tabular-nums">{p.count}</td>
                        <td className="px-4 py-2.5 font-mono text-right tabular-nums">
                          {formatCurrency(p.revenue, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
