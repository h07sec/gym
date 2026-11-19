import React, { useMemo, useState } from 'react';
import { CalendarCheck2, Download, LogIn, LogOut, Search } from 'lucide-react';
import {
  AttendanceRecord,
  Gym,
  Member,
  MembershipStatus,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';
import {
  ActorContext,
  recordAttendanceCheckIn,
  recordAttendanceCheckOut,
} from '../../services/gymos-service';
import { deriveMemberMembershipStatus } from '../../lib/domain/dates';
import { exportGenericCsv, triggerCsvDownload } from '../../lib/domain/csv';
import { toIsoDate } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { Pagination } from '../common/Pagination';

interface AttendanceViewProps {
  actor: ActorContext;
  gym: Gym;
  permissions: StaffPermissions;
  members: Member[];
  attendance: AttendanceRecord[];
}

const PAGE_SIZE = 20;

export const AttendanceView: React.FC<AttendanceViewProps> = ({
  actor,
  gym,
  permissions,
  members,
  attendance,
}) => {
  const today = toIsoDate();
  const canManage =
    actor.role === UserRole.GYM_OWNER ||
    actor.role === UserRole.GYM_MANAGER ||
    actor.role === UserRole.SUPER_ADMIN ||
    permissions.canManageAttendance;

  const [dateFilter, setDateFilter] = useState(today);
  const [search, setSearch] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [notes, setNotes] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeMembers = useMemo(
    () =>
      members.filter(
        (m) =>
          !m.isArchived &&
          m.membershipStatus !== MembershipStatus.CANCELLED
      ),
    [members]
  );

  const openCheckInByMember = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();
    for (const rec of attendance) {
      if (rec.checkInDate === today && !rec.checkOutTime && !map.has(rec.memberId)) {
        map.set(rec.memberId, rec);
      }
    }
    return map;
  }, [attendance, today]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return attendance.filter((rec) => {
      if (dateFilter && rec.checkInDate !== dateFilter) return false;
      if (!q) return true;
      return (
        rec.memberName.toLowerCase().includes(q) ||
        rec.memberCode.toLowerCase().includes(q) ||
        rec.recordedByName.toLowerCase().includes(q)
      );
    });
  }, [attendance, dateFilter, search]);

  const paginated = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const handleCheckIn = async (member: Member, customNotes?: string) => {
    if (!canManage) return;
    setBusy(true);
    setErrorMsg(null);
    setFeedback(null);
    try {
      await recordAttendanceCheckIn(actor, gym.id, member, customNotes);
      setFeedback(`Checked in ${member.fullName} (${member.memberCode}).`);
      setNotes('');
      setSelectedMemberId('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Check-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleCheckOut = async (rec: AttendanceRecord) => {
    if (!canManage) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await recordAttendanceCheckOut(gym.id, rec.id);
      setFeedback(`Checked out ${rec.memberName}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Check-out failed.');
    } finally {
      setBusy(false);
    }
  };

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleExport = () => {
    const csv = exportGenericCsv(
      ['Date', 'Member Code', 'Member Name', 'Check-In Time', 'Check-Out Time', 'Recorded By', 'Notes'],
      filtered.map((r) => [
        r.checkInDate,
        r.memberCode,
        r.memberName,
        r.checkInTime,
        r.checkOutTime || '',
        r.recordedByName,
        r.notes || '',
      ])
    );
    triggerCsvDownload(`attendance_${dateFilter || 'all'}.csv`, csv);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Member Attendance &amp; Check-Ins</h2>
          <p className="text-xs text-slate-500">
            Track daily gym floor check-ins, check-outs, and membership validity at entry
          </p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer w-fit"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </button>
      </div>

      {feedback && (
        <div className="px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-800 flex items-center justify-between">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback(null)} className="font-semibold cursor-pointer">
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

      {canManage && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <CalendarCheck2 className="w-4 h-4 text-teal-700" />
            Quick Member Check-In
          </div>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <select
              value={selectedMemberId}
              onChange={(e) => setSelectedMemberId(e.target.value)}
              className="md:col-span-5 px-3 py-2 text-xs border border-slate-200 rounded-md bg-white"
            >
              <option value="">Select member to check in...</option>
              {activeMembers.map((m) => {
                const st = deriveMemberMembershipStatus(m.membershipExpiryDate, today);
                return (
                  <option key={m.id} value={m.id}>
                    {m.fullName} ({m.memberCode}) — {st.replace(/_/g, ' ')}
                  </option>
                );
              })}
            </select>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional entry note (e.g. Morning session)"
              className="md:col-span-4 px-3 py-2 text-xs border border-slate-200 rounded-md"
            />
            <button
              type="button"
              disabled={busy || !selectedMemberId}
              onClick={() => {
                const target = activeMembers.find((m) => m.id === selectedMemberId);
                if (target) handleCheckIn(target, notes);
              }}
              className="md:col-span-3 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              Check In Now
            </button>
          </div>
          {selectedMemberId && (() => {
            const target = activeMembers.find((m) => m.id === selectedMemberId);
            if (!target) return null;
            const st = deriveMemberMembershipStatus(target.membershipExpiryDate, today);
            if (st === MembershipStatus.EXPIRED || st === MembershipStatus.NONE) {
              return (
                <p className="text-xs text-amber-700">
                  Warning: {target.fullName}&apos;s membership status is {st}. You can still log check-in, or collect renewal at the desk.
                </p>
              );
            }
            return null;
          })()}
        </div>
      )}

      {/* Quick Roster Today Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search member name, code, staff..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          />
        </div>
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => {
            setDateFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md font-mono"
        />
        {dateFilter && (
          <button
            type="button"
            onClick={() => {
              setDateFilter('');
              setPage(1);
            }}
            className="px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
          >
            Show All Dates
          </button>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {paginated.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No attendance check-ins recorded for {dateFilter || 'the selected filter'}.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Member ID</th>
                    <th className="px-4 py-3 font-medium">Member</th>
                    <th className="px-4 py-3 font-medium">Membership</th>
                    <th className="px-4 py-3 font-medium">Check-In</th>
                    <th className="px-4 py-3 font-medium">Check-Out</th>
                    <th className="px-4 py-3 font-medium">Logged By</th>
                    <th className="px-4 py-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {paginated.map((rec) => {
                    const member = members.find((m) => m.id === rec.memberId);
                    const memberStatus = member
                      ? member.membershipStatus === MembershipStatus.CANCELLED
                        ? MembershipStatus.CANCELLED
                        : deriveMemberMembershipStatus(member.membershipExpiryDate, today)
                      : MembershipStatus.NONE;
                    const openToday = openCheckInByMember.get(rec.memberId);
                    return (
                      <tr key={rec.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-mono tabular-nums text-slate-600">
                          {rec.checkInDate}
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums text-slate-700">
                          {rec.memberCode}
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900">
                          {rec.memberName}
                          {rec.notes && (
                            <span className="block text-[11px] font-normal text-slate-500">
                              {rec.notes}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <StatusLabel status={memberStatus} />
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums text-emerald-700">
                          {formatTime(rec.checkInTime)}
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums text-slate-600">
                          {formatTime(rec.checkOutTime)}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{rec.recordedByName}</td>
                        <td className="px-4 py-3 text-right">
                          {canManage && !rec.checkOutTime && openToday?.id === rec.id && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleCheckOut(rec)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                            >
                              <LogOut className="w-3 h-3" />
                              Check Out
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              totalItems={filtered.length}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
};
