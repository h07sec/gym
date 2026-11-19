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
  computeDateRangeReport,
  computeExpiringMembershipsReport,
  computeMonthlyReport,
  computeOutstandingBalancesReport,
  computeWeeklyReport,
} from '../../lib/domain/metrics';
import { addDaysSafe } from '../../lib/domain/dates';
import { exportGenericCsv, triggerCsvDownload } from '../../lib/domain/csv';
import { formatCurrency, formatDisplayDate, toIsoDate } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { Pagination } from '../common/Pagination';

interface ReportsViewProps {
  gym: Gym;
  settings: GymSettings;
  members: Member[];
  payments: MemberPayment[];
  memberships: Membership[];
}

type ReportMode = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'RANGE' | 'OUTSTANDING' | 'EXPIRING';

export const ReportsView: React.FC<ReportsViewProps> = ({
  gym,
  settings,
  members,
  payments,
  memberships,
}) => {
  const currency = settings.currencySymbol || '₹';
  const today = toIsoDate();
  const [mode, setMode] = useState<ReportMode>('DAILY');
  const [targetDate, setTargetDate] = useState(today);
  const [targetMonth, setTargetMonth] = useState(today.slice(0, 7));
  const [rangeStart, setRangeStart] = useState(addDaysSafe(today, -29));
  const [rangeEnd, setRangeEnd] = useState(today);
  const [expiringWindowDays, setExpiringWindowDays] = useState(14);
  const [tablePage, setTablePage] = useState(1);
  const PAGE_SIZE = 20;

  const daily = useMemo(
    () => computeDailyReport(members, payments, targetDate),
    [members, payments, targetDate]
  );

  const weekly = useMemo(
    () => computeWeeklyReport(members, payments, memberships, targetDate),
    [members, payments, memberships, targetDate]
  );

  const monthly = useMemo(
    () => computeMonthlyReport(members, payments, memberships, targetMonth),
    [members, payments, memberships, targetMonth]
  );

  const customRange = useMemo(() => {
    const start = rangeStart <= rangeEnd ? rangeStart : rangeEnd;
    const end = rangeStart <= rangeEnd ? rangeEnd : rangeStart;
    return computeDateRangeReport(members, payments, memberships, start, end);
  }, [members, payments, memberships, rangeStart, rangeEnd]);

  const outstandingRows = useMemo(
    () => computeOutstandingBalancesReport(members, memberships, today),
    [members, memberships, today]
  );

  const expiringRows = useMemo(
    () => computeExpiringMembershipsReport(members, today, expiringWindowDays),
    [members, today, expiringWindowDays]
  );

  const paginatedOutstanding = useMemo(() => {
    const start = (tablePage - 1) * PAGE_SIZE;
    return outstandingRows.slice(start, start + PAGE_SIZE);
  }, [outstandingRows, tablePage]);

  const paginatedExpiring = useMemo(() => {
    const start = (tablePage - 1) * PAGE_SIZE;
    return expiringRows.slice(start, start + PAGE_SIZE);
  }, [expiringRows, tablePage]);

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
    } else if (mode === 'WEEKLY' || mode === 'RANGE') {
      const summary = mode === 'WEEKLY' ? weekly : customRange;
      const csv = exportGenericCsv(
        ['Metric', 'Value'],
        [
          ['Gym', gym.name],
          ['Start Date', summary.startDate],
          ['End Date', summary.endDate],
          ['Total Confirmed Revenue', summary.totalRevenue],
          ['Cash Revenue', summary.cashRevenue],
          ['UPI Revenue', summary.upiRevenue],
          ['Confirmed Payments Count', summary.confirmedPaymentsCount],
          ['Pending Payments Count', summary.pendingPaymentsCount],
          ['Pending Payments Amount (Excluded)', summary.pendingPaymentsAmount],
          ['New Members', summary.newMembers],
          ['Renewals', summary.renewals],
          ['Cancellations', summary.cancellations],
        ]
      );
      triggerCsvDownload(
        `${mode.toLowerCase()}_report_${summary.startDate}_to_${summary.endDate}.csv`,
        csv
      );
    } else if (mode === 'MONTHLY') {
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
    } else if (mode === 'OUTSTANDING') {
      const csv = exportGenericCsv(
        ['Member ID', 'Name', 'Phone', 'Plan', 'Expiry Date', 'Due Date', 'Days Overdue', 'Balance Due'],
        outstandingRows.map((r) => [
          r.memberCode,
          r.fullName,
          r.phone,
          r.currentPlanName,
          r.membershipExpiryDate,
          r.dueDate,
          r.daysOverdue,
          r.outstandingBalance,
        ])
      );
      triggerCsvDownload(`outstanding_balances_${today}.csv`, csv);
    } else {
      const csv = exportGenericCsv(
        ['Member ID', 'Name', 'Phone', 'Email', 'Plan', 'Expiry Date', 'Days Remaining', 'Balance Due'],
        expiringRows.map((r) => [
          r.memberCode,
          r.fullName,
          r.phone,
          r.email,
          r.currentPlanName,
          r.membershipExpiryDate,
          r.daysRemaining,
          r.outstandingBalance,
        ])
      );
      triggerCsvDownload(`expiring_memberships_${today}.csv`, csv);
    }
  };

  const activeRangeSummary = mode === 'WEEKLY' ? weekly : customRange;

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 no-print">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
          {(
            [
              ['DAILY', 'Daily'],
              ['WEEKLY', 'Weekly (7d)'],
              ['MONTHLY', 'Monthly'],
              ['RANGE', 'Custom Range'],
              ['OUTSTANDING', `Outstanding (${outstandingRows.length})`],
              ['EXPIRING', `Expiring (${expiringRows.length})`],
            ] as [ReportMode, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMode(id);
                setTablePage(1);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                mode === id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(mode === 'DAILY' || mode === 'WEEKLY') && (
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value || today)}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
            />
          )}
          {mode === 'MONTHLY' && (
            <input
              type="month"
              value={targetMonth}
              onChange={(e) => setTargetMonth(e.target.value || today.slice(0, 7))}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
            />
          )}
          {mode === 'RANGE' && (
            <>
              <input
                type="date"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value || today)}
                className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
              />
              <span className="text-xs text-slate-400">to</span>
              <input
                type="date"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value || today)}
                className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
              />
            </>
          )}
          {mode === 'EXPIRING' && (
            <select
              value={expiringWindowDays}
              onChange={(e) => {
                setExpiringWindowDays(Number(e.target.value));
                setTablePage(1);
              }}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
            >
              <option value={7}>Next 7 days (+ recent 30d expired)</option>
              <option value={14}>Next 14 days (+ recent 30d expired)</option>
              <option value={30}>Next 30 days (+ recent 30d expired)</option>
            </select>
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

      {mode === 'DAILY' && (
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="border-b border-slate-200 pb-4">
            <h2 className="text-base font-semibold text-slate-900">
              {gym.name} — Daily Collection &amp; Operations Report
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Date: <span className="font-mono">{daily.date}</span> · Confirmed payments only
            </p>
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
      )}

      {(mode === 'WEEKLY' || mode === 'RANGE') && (
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="border-b border-slate-200 pb-4">
            <h2 className="text-base font-semibold text-slate-900">
              {gym.name} — {mode === 'WEEKLY' ? '7-Day Weekly' : 'Custom Date Range'} Financial Report
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Window: <span className="font-mono">{activeRangeSummary.startDate}</span> to{' '}
              <span className="font-mono">{activeRangeSummary.endDate}</span> · Confirmed payments only
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Confirmed Revenue</p>
              <p className="text-xl font-bold font-mono text-emerald-700 tabular-nums mt-1">
                {formatCurrency(activeRangeSummary.totalRevenue, currency)}
              </p>
              <p className="text-[11px] text-slate-500">
                {activeRangeSummary.confirmedPaymentsCount} confirmed transactions
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Cash vs UPI</p>
              <p className="text-xs font-mono text-slate-900 mt-1.5">
                Cash: {formatCurrency(activeRangeSummary.cashRevenue, currency)}
              </p>
              <p className="text-xs font-mono text-slate-900">
                UPI: {formatCurrency(activeRangeSummary.upiRevenue, currency)}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Membership Activity</p>
              <p className="text-xs font-mono text-slate-900 mt-1.5">
                New: {activeRangeSummary.newMembers} · Renewals: {activeRangeSummary.renewals}
              </p>
              <p className="text-xs font-mono text-red-700">
                Cancellations: {activeRangeSummary.cancellations}
              </p>
            </div>
            <div className="border border-slate-200 rounded-md p-4">
              <p className="text-xs text-slate-500">Pending (Excluded)</p>
              <p className="text-xl font-semibold font-mono text-amber-700 tabular-nums mt-1">
                {formatCurrency(activeRangeSummary.pendingPaymentsAmount, currency)}
              </p>
              <p className="text-[11px] text-slate-500">
                {activeRangeSummary.pendingPaymentsCount} awaiting verification
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-slate-800 mb-2">
              Plan Revenue Breakdown ({activeRangeSummary.startDate} → {activeRangeSummary.endDate})
            </h3>
            <div className="border border-slate-200 rounded-md overflow-hidden">
              {activeRangeSummary.planPerformance.length === 0 ? (
                <p className="p-4 text-xs text-slate-500">
                  No plan activity recorded in this window.
                </p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Plan Name</th>
                      <th className="px-4 py-2.5 font-medium text-right">Assignments / Renewals</th>
                      <th className="px-4 py-2.5 font-medium text-right">Confirmed Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {activeRangeSummary.planPerformance.map((p) => (
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

      {mode === 'MONTHLY' && (
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="border-b border-slate-200 pb-4">
            <h2 className="text-base font-semibold text-slate-900">
              {gym.name} — Monthly Financial &amp; Membership Report
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
              <p className="text-xs text-slate-500">Member Movement</p>
              <p className="text-xs font-mono text-slate-900 mt-1.5">
                New: {monthly.newMembers} · Renewals: {monthly.renewals}
              </p>
              <p className="text-xs font-mono text-red-700">
                Cancellations: {monthly.cancellations}
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

      {mode === 'OUTSTANDING' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {gym.name} — Outstanding Member Balances
              </h2>
              <p className="text-xs text-slate-500">
                Members with unpaid or partially settled balances as of {today}
              </p>
            </div>
            <p className="text-sm font-mono font-bold text-red-700 tabular-nums">
              Total Due:{' '}
              {formatCurrency(
                outstandingRows.reduce((s, r) => s + r.outstandingBalance, 0),
                currency
              )}
            </p>
          </div>
          {outstandingRows.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              All active member accounts have zero outstanding balance.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Member ID</th>
                    <th className="px-4 py-2.5 font-medium">Member</th>
                    <th className="px-4 py-2.5 font-medium">Plan</th>
                    <th className="px-4 py-2.5 font-medium">Due Date</th>
                    <th className="px-4 py-2.5 font-medium">Overdue</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium text-right">Balance Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {paginatedOutstanding.map((r) => (
                    <tr key={r.memberId} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-mono text-slate-700">{r.memberCode}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">{r.fullName}</div>
                        <div className="font-mono text-[11px] text-slate-500">{r.phone}</div>
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{r.currentPlanName}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-700">
                        {formatDisplayDate(r.dueDate)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-red-700">
                        {r.daysOverdue > 0 ? `${r.daysOverdue}d overdue` : 'Upcoming'}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusLabel status={r.membershipStatus} />
                      </td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-right text-red-700 tabular-nums">
                        {formatCurrency(r.outstandingBalance, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            page={tablePage}
            pageSize={PAGE_SIZE}
            totalItems={outstandingRows.length}
            onPageChange={setTablePage}
          />
        </div>
      )}

      {mode === 'EXPIRING' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {gym.name} — Expiring &amp; Recently Expired Memberships
              </h2>
              <p className="text-xs text-slate-500">
                Members expiring within {expiringWindowDays} days or expired within the last 30 days
              </p>
            </div>
          </div>
          {expiringRows.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No memberships expiring or recently expired within this window.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Member ID</th>
                    <th className="px-4 py-2.5 font-medium">Member</th>
                    <th className="px-4 py-2.5 font-medium">Plan</th>
                    <th className="px-4 py-2.5 font-medium">Expiry Date</th>
                    <th className="px-4 py-2.5 font-medium">Window</th>
                    <th className="px-4 py-2.5 font-medium text-right">Balance Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {paginatedExpiring.map((r) => (
                    <tr key={r.memberId} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-mono text-slate-700">{r.memberCode}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">{r.fullName}</div>
                        <div className="font-mono text-[11px] text-slate-500">{r.phone}</div>
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{r.currentPlanName}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-700">
                        {formatDisplayDate(r.membershipExpiryDate)}
                      </td>
                      <td className="px-4 py-2.5 font-mono">
                        {r.daysRemaining < 0 ? (
                          <span className="text-red-700">
                            Expired {Math.abs(r.daysRemaining)}d ago
                          </span>
                        ) : r.daysRemaining === 0 ? (
                          <span className="text-amber-700 font-semibold">Expires today</span>
                        ) : (
                          <span className="text-amber-700">In {r.daysRemaining}d</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-right tabular-nums">
                        {formatCurrency(r.outstandingBalance, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            page={tablePage}
            pageSize={PAGE_SIZE}
            totalItems={expiringRows.length}
            onPageChange={setTablePage}
          />
        </div>
      )}
    </div>
  );
};
