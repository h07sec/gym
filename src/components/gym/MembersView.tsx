import React, { useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Download,
  Upload,
  RefreshCw,
  Archive,
  Trash2,
  Eye,
  Edit2,
  Ban,
} from 'lucide-react';
import {
  Gym,
  GymSettings,
  Member,
  MemberPayment,
  Membership,
  MembershipActionType,
  MembershipPlan,
  MembershipRecordStatus,
  MembershipStatus,
  PaymentMode,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';
import {
  ActorContext,
  assignOrRenewMembership,
  bulkImportGymMembers,
  cancelMemberMembership,
  createGymMember,
  deleteGymMemberPermanently,
  updateGymMember,
} from '../../services/gymos-service';
import { deriveMemberMembershipStatus } from '../../lib/domain/dates';
import {
  calculateNetPlanAmount,
  canStaffConfirmPayment,
  canStaffRecordPayment,
  canStaffViewPayments,
  deriveMemberPaymentDisplayStatus,
} from '../../lib/domain/payments';
import {
  CsvImportRowResult,
  exportMembersToCsv,
  parseAndValidateMemberCsv,
  triggerCsvDownload,
} from '../../lib/domain/csv';
import { formatCurrency, formatDisplayDate, toIsoDate } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { Modal } from '../common/Modal';
import { ConfirmModal } from '../common/ConfirmModal';
import { Pagination } from '../common/Pagination';

interface MembersViewProps {
  actor: ActorContext;
  gym: Gym;
  settings: GymSettings;
  permissions: StaffPermissions;
  members: Member[];
  plans: MembershipPlan[];
  memberships: Membership[];
  payments: MemberPayment[];
}

export const MembersView: React.FC<MembersViewProps> = ({
  actor,
  gym,
  settings,
  permissions,
  members,
  plans,
  memberships,
  payments,
}) => {
  const today = toIsoDate();
  const currency = settings.currencySymbol || '₹';
  const activePlans = plans.filter((p) => p.status === 'ACTIVE');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'ACTIVE' | 'EXPIRED' | 'EXPIRING_SOON' | 'CANCELLED' | 'ARCHIVED'
  >('ALL');
  const [sortBy, setSortBy] = useState<'NAME' | 'EXPIRY' | 'JOINED'>('JOINED');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [profileMember, setProfileMember] = useState<Member | null>(null);
  const [renewMember, setRenewMember] = useState<Member | null>(null);
  const [cancellingMember, setCancellingMember] = useState<Member | null>(null);
  const [deletingMember, setDeletingMember] = useState<Member | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);

  const [csvText, setCsvText] = useState('');
  const [importPreview, setImportPreview] = useState<CsvImportRowResult[]>([]);

  const canManageMembers =
    actor.role === UserRole.GYM_OWNER ||
    actor.role === UserRole.SUPER_ADMIN ||
    Boolean(permissions.canManageMembers);
  const canRecordPayments = canStaffRecordPayment(actor.role, permissions);
  const canConfirmPayments = canStaffConfirmPayment(actor.role, permissions);
  const canViewPayments = canStaffViewPayments(actor.role, permissions);

  const [addForm, setAddForm] = useState({
    fullName: '',
    phone: '',
    email: '',
    gender: '',
    dateOfBirth: '',
    address: '',
    joiningDate: today,
    emergencyContact: '',
    notes: '',
    reminderOptOut: false,
    planId: '',
    discountAmount: '',
    discountReason: '',
    dueDate: '',
    paymentAmount: '',
    paymentMode: PaymentMode.CASH,
    transactionReference: '',
    confirmPaymentNow: canConfirmPayments,
  });

  const [renewForm, setRenewForm] = useState({
    planId: activePlans[0]?.id || '',
    actionType: MembershipActionType.RENEWAL,
    customExpiryDate: today,
    discountAmount: '',
    discountReason: '',
    dueDate: '',
    amountPaidNow: '',
    paymentMode: PaymentMode.CASH,
    transactionReference: '',
    confirmPaymentNow: canConfirmPayments,
    notes: '',
  });

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = members.filter((m) => {
      if (statusFilter === 'ARCHIVED') {
        if (!m.isArchived) return false;
      } else {
        if (m.isArchived) return false;
        const derived =
          m.membershipStatus === MembershipStatus.CANCELLED
            ? MembershipStatus.CANCELLED
            : deriveMemberMembershipStatus(m.membershipExpiryDate, today);
        if (statusFilter === 'CANCELLED' && derived !== MembershipStatus.CANCELLED) return false;
        if (statusFilter === 'ACTIVE' && derived !== MembershipStatus.ACTIVE && derived !== MembershipStatus.EXPIRING_SOON) return false;
        if (statusFilter === 'EXPIRING_SOON' && derived !== MembershipStatus.EXPIRING_SOON) return false;
        if (statusFilter === 'EXPIRED' && derived !== MembershipStatus.EXPIRED) return false;
      }

      if (!q) return true;
      return (
        m.fullName.toLowerCase().includes(q) ||
        m.phone.toLowerCase().includes(q) ||
        m.memberCode.toLowerCase().includes(q) ||
        (m.email || '').toLowerCase().includes(q)
      );
    });

    return [...list].sort((a, b) => {
      if (sortBy === 'NAME') return a.fullName.localeCompare(b.fullName);
      if (sortBy === 'EXPIRY') return (a.membershipExpiryDate || '9999').localeCompare(b.membershipExpiryDate || '9999');
      return (b.joiningDate || '').localeCompare(a.joiningDate || '');
    });
  }, [members, search, statusFilter, sortBy, today]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage]
  );

  const selectedAddPlan = activePlans.find((p) => p.id === addForm.planId);
  const addPlanAmounts = calculateNetPlanAmount(
    selectedAddPlan?.price ?? 0,
    addForm.discountAmount ? Number(addForm.discountAmount) : 0
  );

  const selectedRenewPlan = plans.find((p) => p.id === renewForm.planId) || plans[0];
  const renewPlanAmounts = calculateNetPlanAmount(
    renewForm.actionType === MembershipActionType.MANUAL_EXTENSION
      ? 0
      : selectedRenewPlan?.price ?? 0,
    renewForm.discountAmount ? Number(renewForm.discountAmount) : 0
  );

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageMembers) {
      setErrorMsg('You do not have permission to register members.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const plan = activePlans.find((p) => p.id === addForm.planId);
      const parsedPayAmount =
        canRecordPayments && addForm.paymentAmount ? Number(addForm.paymentAmount) : 0;
      await createGymMember(actor, gym, {
        fullName: addForm.fullName,
        phone: addForm.phone,
        email: addForm.email,
        gender: addForm.gender,
        dateOfBirth: addForm.dateOfBirth,
        address: addForm.address,
        joiningDate: addForm.joiningDate,
        emergencyContact: addForm.emergencyContact,
        notes: addForm.notes,
        reminderOptOut: addForm.reminderOptOut,
        initialPlan: plan,
        discountAmount: addForm.discountAmount ? Number(addForm.discountAmount) : 0,
        discountReason: addForm.discountReason,
        dueDate: addForm.dueDate || undefined,
        paymentAmount: parsedPayAmount,
        paymentMode: addForm.paymentMode,
        transactionReference: addForm.transactionReference,
        confirmPaymentNow: canRecordPayments && canConfirmPayments && addForm.confirmPaymentNow,
      });
      setShowAddModal(false);
      setAddForm({
        fullName: '',
        phone: '',
        email: '',
        gender: '',
        dateOfBirth: '',
        address: '',
        joiningDate: today,
        emergencyContact: '',
        notes: '',
        reminderOptOut: false,
        planId: '',
        discountAmount: '',
        discountReason: '',
        dueDate: '',
        paymentAmount: '',
        paymentMode: PaymentMode.CASH,
        transactionReference: '',
        confirmPaymentNow: canConfirmPayments,
      });
      setFeedback('Member registered successfully.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to register member.');
    } finally {
      setBusy(false);
    }
  };

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMember || !canManageMembers) return;
    setBusy(true);
    try {
      await updateGymMember(actor, gym.id, editingMember.id, {
        fullName: editingMember.fullName,
        phone: editingMember.phone,
        email: editingMember.email || '',
        gender: editingMember.gender || '',
        dateOfBirth: editingMember.dateOfBirth || '',
        address: editingMember.address || '',
        emergencyContact: editingMember.emergencyContact || '',
        reminderOptOut: editingMember.reminderOptOut,
        notes: editingMember.notes || '',
      });
      setEditingMember(null);
      setFeedback('Member details updated.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update member.');
    } finally {
      setBusy(false);
    }
  };

  const handleRenewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renewMember || !canManageMembers) return;
    const plan = plans.find((p) => p.id === renewForm.planId) || plans[0];
    if (!plan) {
      setErrorMsg('Create a membership plan first.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const parsedAmountPaidNow =
        canRecordPayments && renewForm.amountPaidNow ? Number(renewForm.amountPaidNow) : 0;
      await assignOrRenewMembership(actor, gym, renewMember, plan, renewForm.actionType, settings, {
        customExpiryDate: renewForm.customExpiryDate,
        discountAmount: renewForm.discountAmount ? Number(renewForm.discountAmount) : 0,
        discountReason: renewForm.discountReason,
        dueDate: renewForm.dueDate || undefined,
        amountPaidNow: parsedAmountPaidNow,
        paymentMode: renewForm.paymentMode,
        transactionReference: renewForm.transactionReference,
        confirmPaymentNow: canRecordPayments && canConfirmPayments && renewForm.confirmPaymentNow,
        notes: renewForm.notes,
      });
      setRenewMember(null);
      setFeedback(`Updated membership for ${renewMember.fullName}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to process membership update.');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelMembershipConfirm = async (reason?: string) => {
    if (!cancellingMember || !reason || !canManageMembers) return;
    setErrorMsg(null);
    try {
      const activeMs = memberships.find(
        (ms) =>
          ms.memberId === cancellingMember.id && ms.status === MembershipRecordStatus.ACTIVE
      );
      await cancelMemberMembership(actor, gym.id, cancellingMember, activeMs, reason);
      setFeedback(`Cancelled membership for ${cancellingMember.fullName}.`);
      setCancellingMember(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel membership.');
    }
  };

  const handleDeletePermanentConfirm = async () => {
    if (!deletingMember) return;
    setErrorMsg(null);
    try {
      await deleteGymMemberPermanently(actor, gym.id, deletingMember);
      setFeedback(`Permanently deleted ${deletingMember.fullName}.`);
      setDeletingMember(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete member.');
    }
  };

  const handleImportPreview = (text: string) => {
    setCsvText(text);
    setImportPreview(parseAndValidateMemberCsv(text, members, today));
  };

  const handleImportCommit = async () => {
    if (!canManageMembers) return;
    const validRows = importPreview.filter((r) => r.isValid && !r.isDuplicate);
    if (validRows.length === 0) return;
    setBusy(true);
    try {
      const count = await bulkImportGymMembers(actor, gym.id, validRows);
      setShowImportModal(false);
      setCsvText('');
      setImportPreview([]);
      setFeedback(`Imported ${count} validated members.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'CSV import failed.');
    } finally {
      setBusy(false);
    }
  };

  const canDelete =
    actor.role === UserRole.GYM_OWNER ||
    actor.role === UserRole.SUPER_ADMIN ||
    Boolean(permissions.canDeleteMembers);

  return (
    <div className="space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search name, phone, member ID..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as typeof statusFilter);
              setPage(1);
            }}
            className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          >
            <option value="ALL">All Active Records</option>
            <option value="ACTIVE">Active Memberships</option>
            <option value="EXPIRING_SOON">Expiring Within 7 Days</option>
            <option value="EXPIRED">Expired</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="ARCHIVED">Archived</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value as typeof sortBy);
              setPage(1);
            }}
            className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          >
            <option value="JOINED">Sort: Recently Joined</option>
            <option value="EXPIRY">Sort: Nearest Expiry</option>
            <option value="NAME">Sort: Name A–Z</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() =>
              triggerCsvDownload(
                `${gym.name.toLowerCase().replace(/\s+/g, '_')}_members_${today}.csv`,
                exportMembersToCsv(filtered)
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          {canManageMembers && (
            <>
              <button
                type="button"
                onClick={() => setShowImportModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                Import CSV
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add Member
              </button>
            </>
          )}
        </div>
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

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-medium text-slate-900">No members found</p>
            <p className="text-xs text-slate-500">
              Register your first gym member or import a member roster via CSV.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Member ID</th>
                  <th className="px-4 py-3 font-medium">Full Name</th>
                  <th className="px-4 py-3 font-medium">Contact</th>
                  <th className="px-4 py-3 font-medium">Current Plan</th>
                  <th className="px-4 py-3 font-medium">Expiry</th>
                  <th className="px-4 py-3 font-medium">Membership</th>
                  {canViewPayments && <th className="px-4 py-3 font-medium">Payment Status</th>}
                  {canViewPayments && <th className="px-4 py-3 font-medium text-right">Balance Due</th>}
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {paginated.map((m) => {
                  const derived =
                    m.membershipStatus === MembershipStatus.CANCELLED
                      ? MembershipStatus.CANCELLED
                      : deriveMemberMembershipStatus(m.membershipExpiryDate, today);
                  const paymentDisplayStatus = canViewPayments
                    ? deriveMemberPaymentDisplayStatus(m, payments, memberships, today)
                    : null;
                  return (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {m.memberCode}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">{m.fullName}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <div className="font-mono tabular-nums">{m.phone}</div>
                        {m.email && <div className="text-[11px] text-slate-500">{m.email}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{m.currentPlanName || '—'}</td>
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {formatDisplayDate(m.membershipExpiryDate)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusLabel status={derived} />
                      </td>
                      {canViewPayments && paymentDisplayStatus && (
                        <td className="px-4 py-3">
                          <StatusLabel status={paymentDisplayStatus} />
                        </td>
                      )}
                      {canViewPayments && (
                        <td className="px-4 py-3 font-mono tabular-nums text-right text-slate-900">
                          {formatCurrency(m.outstandingBalance, currency)}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setProfileMember(m)}
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                            title="View profile"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          {canManageMembers && (
                            <button
                              type="button"
                              onClick={() => {
                                setRenewMember(m);
                                const defaultPlan =
                                  plans.find((p) => p.id === m.currentPlanId) || activePlans[0];
                                setRenewForm({
                                  planId: defaultPlan?.id || '',
                                  actionType: MembershipActionType.RENEWAL,
                                  customExpiryDate: m.membershipExpiryDate || today,
                                  discountAmount: '',
                                  discountReason: '',
                                  dueDate: '',
                                  amountPaidNow:
                                    canRecordPayments && defaultPlan
                                      ? String(defaultPlan.price)
                                      : '',
                                  paymentMode: PaymentMode.CASH,
                                  transactionReference: '',
                                  confirmPaymentNow: canRecordPayments && canConfirmPayments,
                                  notes: '',
                                });
                              }}
                              className="p-1.5 text-teal-700 hover:bg-teal-50 rounded cursor-pointer"
                              title="Renew / Assign / Upgrade membership"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canManageMembers &&
                            !m.isArchived &&
                            m.currentPlanId &&
                            m.membershipStatus !== MembershipStatus.CANCELLED && (
                              <button
                                type="button"
                                onClick={() => setCancellingMember(m)}
                                className="p-1.5 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded cursor-pointer"
                                title="Cancel active membership"
                              >
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
                          {canManageMembers && (
                            <button
                              type="button"
                              onClick={() => setEditingMember({ ...m })}
                              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                              title="Edit member"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canManageMembers && (
                            <button
                              type="button"
                              onClick={async () => {
                                setErrorMsg(null);
                                try {
                                  await updateGymMember(actor, gym.id, m.id, {
                                    isArchived: !m.isArchived,
                                  });
                                } catch (err) {
                                  setErrorMsg(
                                    err instanceof Error ? err.message : 'Failed to update archive status.'
                                  );
                                }
                              }}
                              className="p-1.5 text-slate-500 hover:text-amber-700 hover:bg-amber-50 rounded cursor-pointer"
                              title={m.isArchived ? 'Restore member' : 'Archive member'}
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canDelete && m.isArchived && (
                            <button
                              type="button"
                              onClick={() => setDeletingMember(m)}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                              title="Delete permanently"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={currentPage}
          pageSize={PAGE_SIZE}
          totalItems={filtered.length}
          onPageChange={setPage}
        />
      </div>

      {/* Add Member Modal */}
      <Modal
        open={canManageMembers && showAddModal}
        title="Register New Member"
        subtitle="Creates a unique Member ID and optional initial membership & payment"
        onClose={() => setShowAddModal(false)}
        maxWidthClass="max-w-2xl"
      >
        <form onSubmit={handleRegister} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Full Name *</label>
              <input
                type="text"
                required
                minLength={2}
                value={addForm.fullName}
                onChange={(e) => setAddForm({ ...addForm, fullName: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phone Number *</label>
              <input
                type="tel"
                required
                minLength={5}
                value={addForm.phone}
                onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Email (for reminders)</label>
              <input
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Joining Date *</label>
              <input
                type="date"
                required
                value={addForm.joiningDate}
                onChange={(e) => setAddForm({ ...addForm, joiningDate: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Gender</label>
              <select
                value={addForm.gender}
                onChange={(e) => setAddForm({ ...addForm, gender: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value="">Unspecified</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Date of Birth</label>
              <input
                type="date"
                value={addForm.dateOfBirth}
                onChange={(e) => setAddForm({ ...addForm, dateOfBirth: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact</label>
              <input
                type="text"
                value={addForm.emergencyContact}
                onChange={(e) => setAddForm({ ...addForm, emergencyContact: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Address</label>
              <input
                type="text"
                value={addForm.address}
                onChange={(e) => setAddForm({ ...addForm, address: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div className="sm:col-span-2 border-t border-slate-200 pt-3">
              <p className="text-xs font-semibold text-slate-800 mb-2">
                Assign Initial Membership Plan (Optional)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select
                  value={addForm.planId}
                  onChange={(e) => {
                    const p = activePlans.find((x) => x.id === e.target.value);
                    const disc = addForm.discountAmount ? Number(addForm.discountAmount) : 0;
                    const net = p ? calculateNetPlanAmount(p.price, disc).netPrice : 0;
                    setAddForm({
                      ...addForm,
                      planId: e.target.value,
                      paymentAmount: canRecordPayments && p ? String(net) : '',
                    });
                  }}
                  className="px-3 py-2 text-xs border border-slate-200 rounded-md"
                >
                  <option value="">No plan assigned yet</option>
                  {activePlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {formatCurrency(p.price, currency)}
                    </option>
                  ))}
                </select>
                {addForm.planId && canRecordPayments && (
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Amount paid now"
                    value={addForm.paymentAmount}
                    onChange={(e) => setAddForm({ ...addForm, paymentAmount: e.target.value })}
                    className="px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                  />
                )}
              </div>
              {addForm.planId && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Discount</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0"
                      value={addForm.discountAmount}
                      onChange={(e) => {
                        const val = e.target.value;
                        const net = calculateNetPlanAmount(
                          selectedAddPlan?.price ?? 0,
                          val ? Number(val) : 0
                        ).netPrice;
                        setAddForm({
                          ...addForm,
                          discountAmount: val,
                          paymentAmount: canRecordPayments ? String(net) : '',
                        });
                      }}
                      className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Discount Reason</label>
                    <input
                      type="text"
                      placeholder="Promo / referral"
                      value={addForm.discountReason}
                      onChange={(e) => setAddForm({ ...addForm, discountReason: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Balance Due Date</label>
                    <input
                      type="date"
                      value={addForm.dueDate}
                      onChange={(e) => setAddForm({ ...addForm, dueDate: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
                    />
                  </div>
                  <p className="sm:col-span-3 text-[11px] text-slate-600 font-mono">
                    Plan: {formatCurrency(addPlanAmounts.grossPrice, currency)} · Discount:{' '}
                    {formatCurrency(addPlanAmounts.discount, currency)} · Net Payable:{' '}
                    <span className="font-semibold text-slate-900">
                      {formatCurrency(addPlanAmounts.netPrice, currency)}
                    </span>
                  </p>
                </div>
              )}
              {addForm.planId && canRecordPayments && Number(addForm.paymentAmount) > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <select
                    value={addForm.paymentMode}
                    onChange={(e) =>
                      setAddForm({ ...addForm, paymentMode: e.target.value as PaymentMode })
                    }
                    className="px-3 py-2 text-xs border border-slate-200 rounded-md"
                  >
                    <option value={PaymentMode.CASH}>Cash</option>
                    <option value={PaymentMode.UPI}>UPI</option>
                  </select>
                  {addForm.paymentMode === PaymentMode.UPI && (
                    <input
                      type="text"
                      placeholder="UPI Transaction Ref"
                      value={addForm.transactionReference}
                      onChange={(e) =>
                        setAddForm({ ...addForm, transactionReference: e.target.value })
                      }
                      className="px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                    />
                  )}
                  {canConfirmPayments && (
                    <label className="sm:col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={addForm.confirmPaymentNow}
                        onChange={(e) =>
                          setAddForm({ ...addForm, confirmPaymentNow: e.target.checked })
                        }
                      />
                      Confirm receipt immediately (for UPI, verify in bank/UPI app first)
                    </label>
                  )}
                </div>
              )}
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
              <textarea
                rows={2}
                value={addForm.notes}
                onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <label className="sm:col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={addForm.reminderOptOut}
                onChange={(e) => setAddForm({ ...addForm, reminderOptOut: e.target.checked })}
              />
              Member opted out of automated renewal reminders
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
            >
              {busy ? 'Registering...' : 'Register Member'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Member Modal */}
      <Modal
        open={canManageMembers && Boolean(editingMember)}
        title={`Edit Member · ${editingMember?.fullName}`}
        onClose={() => setEditingMember(null)}
      >
        {editingMember && (
          <form onSubmit={handleEditSave} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={editingMember.fullName}
                  onChange={(e) =>
                    setEditingMember({ ...editingMember, fullName: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
                <input
                  type="tel"
                  required
                  value={editingMember.phone}
                  onChange={(e) =>
                    setEditingMember({ ...editingMember, phone: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  value={editingMember.email || ''}
                  onChange={(e) =>
                    setEditingMember({ ...editingMember, email: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact</label>
                <input
                  type="text"
                  value={editingMember.emergencyContact || ''}
                  onChange={(e) =>
                    setEditingMember({ ...editingMember, emergencyContact: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                <textarea
                  rows={2}
                  value={editingMember.notes || ''}
                  onChange={(e) =>
                    setEditingMember({ ...editingMember, notes: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
              <label className="col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editingMember.reminderOptOut}
                  onChange={(e) =>
                    setEditingMember({ ...editingMember, reminderOptOut: e.target.checked })
                  }
                />
                Opt out of automated renewal reminders
              </label>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setEditingMember(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
              >
                Save Changes
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Renew / Upgrade / Extend Modal */}
      <Modal
        open={canManageMembers && Boolean(renewMember)}
        title={`Membership Action · ${renewMember?.fullName}`}
        subtitle={`Current expiry: ${formatDisplayDate(renewMember?.membershipExpiryDate)} · Policy: ${settings.renewalPolicy.replace(/_/g, ' ')}`}
        onClose={() => setRenewMember(null)}
      >
        <form onSubmit={handleRenewSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Action Type</label>
              <select
                value={renewForm.actionType}
                onChange={(e) =>
                  setRenewForm({
                    ...renewForm,
                    actionType: e.target.value as MembershipActionType,
                  })
                }
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={MembershipActionType.RENEWAL}>Renew Membership</option>
                <option value={MembershipActionType.UPGRADE}>Upgrade Plan</option>
                <option value={MembershipActionType.DOWNGRADE}>Downgrade Plan</option>
                <option value={MembershipActionType.MANUAL_EXTENSION}>Manual Date Extension</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Membership Plan</label>
              <select
                value={renewForm.planId}
                onChange={(e) => {
                  const p = plans.find((x) => x.id === e.target.value);
                  const disc = renewForm.discountAmount ? Number(renewForm.discountAmount) : 0;
                  const net = p ? calculateNetPlanAmount(p.price, disc).netPrice : 0;
                  setRenewForm({
                    ...renewForm,
                    planId: e.target.value,
                    amountPaidNow: canRecordPayments && p ? String(net) : '',
                  });
                }}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({formatCurrency(p.price, currency)})
                  </option>
                ))}
              </select>
            </div>

            {renewForm.actionType === MembershipActionType.MANUAL_EXTENSION && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">New Expiry Date *</label>
                <input
                  type="date"
                  required
                  value={renewForm.customExpiryDate}
                  onChange={(e) =>
                    setRenewForm({ ...renewForm, customExpiryDate: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
            )}

            {renewForm.actionType !== MembershipActionType.MANUAL_EXTENSION && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Discount</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={renewForm.discountAmount}
                    onChange={(e) => {
                      const val = e.target.value;
                      const net = calculateNetPlanAmount(
                        selectedRenewPlan?.price ?? 0,
                        val ? Number(val) : 0
                      ).netPrice;
                      setRenewForm({
                        ...renewForm,
                        discountAmount: val,
                        amountPaidNow: canRecordPayments ? String(net) : '',
                      });
                    }}
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Discount Reason
                  </label>
                  <input
                    type="text"
                    placeholder="Loyalty / offer"
                    value={renewForm.discountReason}
                    onChange={(e) =>
                      setRenewForm({ ...renewForm, discountReason: e.target.value })
                    }
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                  />
                </div>
                <div className="col-span-2 text-[11px] font-mono text-slate-600">
                  Plan: {formatCurrency(renewPlanAmounts.grossPrice, currency)} · Discount:{' '}
                  {formatCurrency(renewPlanAmounts.discount, currency)} · Net Payable:{' '}
                  <span className="font-semibold text-slate-900">
                    {formatCurrency(renewPlanAmounts.netPrice, currency)}
                  </span>
                </div>
              </>
            )}

            {canRecordPayments && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Amount Paid Now</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={renewForm.amountPaidNow}
                    onChange={(e) => setRenewForm({ ...renewForm, amountPaidNow: e.target.value })}
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Payment Mode</label>
                  <select
                    value={renewForm.paymentMode}
                    onChange={(e) =>
                      setRenewForm({ ...renewForm, paymentMode: e.target.value as PaymentMode })
                    }
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                  >
                    <option value={PaymentMode.CASH}>Cash</option>
                    <option value={PaymentMode.UPI}>UPI</option>
                  </select>
                </div>
              </>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Balance Due Date (if partial)
              </label>
              <input
                type="date"
                value={renewForm.dueDate}
                onChange={(e) => setRenewForm({ ...renewForm, dueDate: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
              <input
                type="text"
                value={renewForm.notes}
                onChange={(e) => setRenewForm({ ...renewForm, notes: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            {canRecordPayments &&
              renewForm.paymentMode === PaymentMode.UPI &&
              Number(renewForm.amountPaidNow) > 0 && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">UPI Reference</label>
                <input
                  type="text"
                  value={renewForm.transactionReference}
                  onChange={(e) =>
                    setRenewForm({ ...renewForm, transactionReference: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
            )}
            {canRecordPayments && canConfirmPayments && (
              <label className="col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={renewForm.confirmPaymentNow}
                  onChange={(e) =>
                    setRenewForm({ ...renewForm, confirmPaymentNow: e.target.checked })
                  }
                />
                Confirm payment receipt now & generate receipt
              </label>
            )}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setRenewMember(null)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
            >
              {busy ? 'Processing...' : 'Apply Membership Update'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Member Profile Drawer Modal */}
      <Modal
        open={Boolean(profileMember)}
        title={profileMember?.fullName || 'Member Profile'}
        subtitle={`Member ID: ${profileMember?.memberCode}`}
        onClose={() => setProfileMember(null)}
        maxWidthClass="max-w-2xl"
      >
        {profileMember && (
          <div className="space-y-5 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 border border-slate-200 rounded-md p-4">
              <div>
                <p className="text-slate-500">Phone</p>
                <p className="font-mono text-slate-900 mt-0.5">{profileMember.phone}</p>
              </div>
              <div>
                <p className="text-slate-500">Email</p>
                <p className="text-slate-900 mt-0.5">{profileMember.email || '—'}</p>
              </div>
              <div>
                <p className="text-slate-500">Joined</p>
                <p className="font-mono text-slate-900 mt-0.5">
                  {formatDisplayDate(profileMember.joiningDate)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Current Plan</p>
                <p className="font-medium text-slate-900 mt-0.5">
                  {profileMember.currentPlanName || '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Expiry Date</p>
                <p className="font-mono text-slate-900 mt-0.5">
                  {formatDisplayDate(profileMember.membershipExpiryDate)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Outstanding Balance</p>
                <p className="font-mono font-semibold text-slate-900 mt-0.5">
                  {formatCurrency(profileMember.outstandingBalance, currency)}
                </p>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-slate-900 mb-2">Membership History</h4>
              <div className="border border-slate-200 rounded-md overflow-hidden">
                {memberships.filter((ms) => ms.memberId === profileMember.id).length === 0 ? (
                  <p className="p-3 text-slate-500">No membership history yet.</p>
                ) : (
                  <table className="w-full text-left">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Action</th>
                        <th className="px-3 py-2">Plan</th>
                        <th className="px-3 py-2">Start</th>
                        <th className="px-3 py-2">Expiry</th>
                        <th className="px-3 py-2 text-right">Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {memberships
                        .filter((ms) => ms.memberId === profileMember.id)
                        .map((ms) => (
                          <tr key={ms.id}>
                            <td className="px-3 py-2 font-mono">{ms.actionType}</td>
                            <td className="px-3 py-2">{ms.planName}</td>
                            <td className="px-3 py-2 font-mono">{ms.startDate}</td>
                            <td className="px-3 py-2 font-mono">{ms.expiryDate}</td>
                            <td className="px-3 py-2 font-mono text-right">
                              {formatCurrency(ms.planPrice, currency)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {canViewPayments && (
              <div>
                <h4 className="font-semibold text-slate-900 mb-2">Payment History</h4>
                <div className="border border-slate-200 rounded-md overflow-hidden">
                  {payments.filter((p) => p.memberId === profileMember.id).length === 0 ? (
                    <p className="p-3 text-slate-500">No payments recorded for this member.</p>
                  ) : (
                    <table className="w-full text-left">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Date</th>
                          <th className="px-3 py-2">Code</th>
                          <th className="px-3 py-2">Mode</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                          <th className="px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {payments
                          .filter((p) => p.memberId === profileMember.id)
                          .map((p) => (
                            <tr key={p.id}>
                              <td className="px-3 py-2 font-mono">{p.paymentDate}</td>
                              <td className="px-3 py-2 font-mono">{p.paymentCode}</td>
                              <td className="px-3 py-2">{p.paymentMode}</td>
                              <td className="px-3 py-2 font-mono text-right">
                                {formatCurrency(p.amount, currency)}
                              </td>
                              <td className="px-3 py-2">
                                <StatusLabel status={p.status} />
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* CSV Import Modal */}
      <Modal
        open={canManageMembers && showImportModal}
        title="Import Members from CSV"
        subtitle="Columns: Full Name, Phone, Email, Gender, Joining Date (YYYY-MM-DD), Notes"
        onClose={() => setShowImportModal(false)}
        maxWidthClass="max-w-2xl"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                file.text().then(handleImportPreview);
              }}
              className="text-xs text-slate-600"
            />
          </div>
          <textarea
            rows={5}
            value={csvText}
            onChange={(e) => handleImportPreview(e.target.value)}
            placeholder={`Full Name,Phone,Email,Gender,Joining Date,Notes\nAarav Sharma,9876543210,aarav@example.com,Male,${today},Morning batch`}
            className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-md"
          />
          {importPreview.length > 0 && (
            <div className="border border-slate-200 rounded-md max-h-48 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Row</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Validation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {importPreview.map((r) => (
                    <tr key={r.rowNumber}>
                      <td className="px-3 py-2 font-mono">{r.rowNumber}</td>
                      <td className="px-3 py-2">{r.fullName}</td>
                      <td className="px-3 py-2 font-mono">{r.phone}</td>
                      <td className="px-3 py-2">
                        {r.isValid ? (
                          <span className="text-emerald-700 font-medium">Ready</span>
                        ) : (
                          <span className="text-red-700">{r.errors.join('; ')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowImportModal(false)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || importPreview.filter((r) => r.isValid).length === 0}
              onClick={handleImportCommit}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
            >
              Import {importPreview.filter((r) => r.isValid).length} Valid Members
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={canManageMembers && Boolean(cancellingMember)}
        title={`Cancel Membership · ${cancellingMember?.fullName || ''}`}
        description="Cancels the member's active plan and clears the current expiry date while preserving all payment and membership history."
        confirmLabel="Cancel Membership"
        variant="danger"
        requireReason
        reasonLabel="Cancellation Reason"
        reasonPlaceholder="e.g. Member relocated / requested cancellation"
        onConfirm={handleCancelMembershipConfirm}
        onCancel={() => setCancellingMember(null)}
      />

      <ConfirmModal
        open={Boolean(deletingMember)}
        title={`Permanently Delete Member · ${deletingMember?.fullName || ''}`}
        description="This permanently removes the archived member profile document. Historical receipts and payments remain in the ledger."
        confirmLabel="Delete Permanently"
        variant="danger"
        onConfirm={handleDeletePermanentConfirm}
        onCancel={() => setDeletingMember(null)}
      />
    </div>
  );
};
