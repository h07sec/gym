import React, { useMemo, useState } from 'react';
import { Plus, CheckCircle2, XCircle, Receipt, RotateCcw, Search, AlertTriangle } from 'lucide-react';
import {
  Gym,
  GymSettings,
  Member,
  MemberPayment,
  MemberPaymentPurpose,
  MemberPaymentStatus,
  Membership,
  MembershipRecordStatus,
  PaymentMode,
  PaymentReceipt,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';
import {
  ActorContext,
  confirmPendingMemberPayment,
  recordMemberPayment,
  rejectOrRefundMemberPayment,
} from '../../services/gymos-service';
import { canStaffConfirmPayment, canStaffRecordPayment } from '../../lib/domain/payments';
import { formatCurrency, formatDisplayDate, toIsoDate } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { Modal } from '../common/Modal';
import { ConfirmModal } from '../common/ConfirmModal';
import { Pagination } from '../common/Pagination';
import { ReceiptModal } from '../common/ReceiptModal';

interface PaymentsViewProps {
  actor: ActorContext;
  gym: Gym;
  settings: GymSettings;
  permissions: StaffPermissions;
  members: Member[];
  memberships: Membership[];
  payments: MemberPayment[];
  receipts: PaymentReceipt[];
}

export const PaymentsView: React.FC<PaymentsViewProps> = ({
  actor,
  gym,
  settings,
  permissions,
  members,
  memberships,
  payments,
  receipts,
}) => {
  const currency = settings.currencySymbol || '₹';
  const canConfirm = canStaffConfirmPayment(actor.role, permissions);
  const canRecord = canStaffRecordPayment(actor.role, permissions);
  const canRefund =
    actor.role === UserRole.GYM_OWNER ||
    actor.role === UserRole.SUPER_ADMIN ||
    permissions.canConfirmPayments;

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [modeFilter, setModeFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  const [showAddModal, setShowAddModal] = useState(false);
  const [activeReceipt, setActiveReceipt] = useState<PaymentReceipt | null>(null);
  const [confirmingPayment, setConfirmingPayment] = useState<MemberPayment | null>(null);
  const [actionModal, setActionModal] = useState<{
    payment: MemberPayment;
    targetStatus: MemberPaymentStatus.REJECTED | MemberPaymentStatus.REFUNDED;
  } | null>(null);

  const [form, setForm] = useState({
    memberId: members[0]?.id || '',
    membershipId: '',
    amount: '',
    discountAmount: '',
    discountReason: '',
    dueDate: '',
    paymentMode: PaymentMode.CASH,
    paymentPurpose: MemberPaymentPurpose.BALANCE_SETTLEMENT,
    transactionReference: '',
    attachmentName: '',
    paymentDate: toIsoDate(),
    notes: '',
    confirmImmediately: false,
    allowDuplicateCash: false,
  });

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const activeMembers = members.filter((m) => !m.isArchived);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return payments.filter((p) => {
      if (statusFilter !== 'ALL' && p.status !== statusFilter) return false;
      if (modeFilter !== 'ALL' && p.paymentMode !== modeFilter) return false;
      if (!q) return true;
      return (
        p.memberName.toLowerCase().includes(q) ||
        p.paymentCode.toLowerCase().includes(q) ||
        (p.transactionReference || '').toLowerCase().includes(q) ||
        (p.receiptNumber || '').toLowerCase().includes(q)
      );
    });
  }, [payments, search, statusFilter, modeFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage]
  );

  const selectedMemberMemberships = useMemo(
    () =>
      memberships.filter(
        (ms) =>
          ms.memberId === form.memberId && ms.status === MembershipRecordStatus.ACTIVE
      ),
    [memberships, form.memberId]
  );

  const handleRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    const member = members.find((m) => m.id === form.memberId);
    if (!member) {
      setModalError('Please select a member.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setModalError(null);
    try {
      await recordMemberPayment(actor, gym, member, payments, {
        amount: Number(form.amount),
        membershipId: form.membershipId || undefined,
        discountAmount: form.discountAmount ? Number(form.discountAmount) : 0,
        discountReason: form.discountReason,
        dueDate: form.dueDate || undefined,
        paymentMode: form.paymentMode,
        paymentPurpose: form.paymentPurpose,
        transactionReference: form.transactionReference,
        attachmentName: form.attachmentName,
        paymentDate: form.paymentDate,
        notes: form.notes,
        confirmImmediately: canConfirm && form.confirmImmediately,
        allowDuplicateCash: form.allowDuplicateCash,
      });
      setShowAddModal(false);
      setForm({
        memberId: activeMembers[0]?.id || '',
        membershipId: '',
        amount: '',
        discountAmount: '',
        discountReason: '',
        dueDate: '',
        paymentMode: PaymentMode.CASH,
        paymentPurpose: MemberPaymentPurpose.BALANCE_SETTLEMENT,
        transactionReference: '',
        attachmentName: '',
        paymentDate: toIsoDate(),
        notes: '',
        confirmImmediately: false,
        allowDuplicateCash: false,
      });
      setFeedback('Payment recorded successfully.');
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to record payment.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPending = async () => {
    if (!confirmingPayment) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const receiptNum = await confirmPendingMemberPayment(
        actor,
        gym,
        confirmingPayment.id
      );
      setConfirmingPayment(null);
      setFeedback(`Payment confirmed and receipt ${receiptNum} generated.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not confirm payment.');
    } finally {
      setBusy(false);
    }
  };

  const handleRejectOrRefundConfirm = async (reason?: string) => {
    if (!actionModal || !reason) return;
    setErrorMsg(null);
    try {
      await rejectOrRefundMemberPayment(
        actor,
        gym.id,
        actionModal.payment,
        actionModal.targetStatus,
        reason
      );
      setFeedback(
        actionModal.targetStatus === MemberPaymentStatus.REJECTED
          ? `Rejected payment ${actionModal.payment.paymentCode}.`
          : `Marked payment ${actionModal.payment.paymentCode} as refunded.`
      );
      setActionModal(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to update payment status.');
    }
  };

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
              placeholder="Search member, payment ID, UTR, receipt..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          >
            <option value="ALL">All Statuses</option>
            <option value={MemberPaymentStatus.PENDING}>Pending</option>
            <option value={MemberPaymentStatus.CONFIRMED}>Confirmed</option>
            <option value={MemberPaymentStatus.REJECTED}>Rejected</option>
            <option value={MemberPaymentStatus.REFUNDED}>Refunded</option>
          </select>
          <select
            value={modeFilter}
            onChange={(e) => {
              setModeFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          >
            <option value="ALL">All Modes</option>
            <option value={PaymentMode.CASH}>Cash</option>
            <option value={PaymentMode.UPI}>UPI</option>
          </select>
        </div>

        {canRecord && (
          <button
            type="button"
            disabled={activeMembers.length === 0}
            onClick={() => {
              setModalError(null);
              setForm((f) => ({
                ...f,
                memberId: activeMembers[0]?.id || '',
                membershipId: '',
                allowDuplicateCash: false,
              }));
              setShowAddModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Record Cash / UPI Payment
          </button>
        )}
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
          <div className="p-10 text-center text-xs text-slate-500">
            No member payments match your filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Payment ID</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Member</th>
                  <th className="px-4 py-3 font-medium">Purpose</th>
                  <th className="px-4 py-3 font-medium">Mode & Reference</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {paginated.map((p) => {
                  const receipt = receipts.find((r) => r.paymentId === p.id);
                  return (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-700">
                        {p.paymentCode}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        <div>{formatDisplayDate(p.paymentDate)}</div>
                        {p.dueDate && (
                          <span className="text-[11px] text-slate-500">
                            Due: {formatDisplayDate(p.dueDate)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">{p.memberName}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {p.paymentPurpose.replace(/_/g, ' ')}
                        {p.discountAmount && p.discountAmount > 0 && (
                          <span className="block text-[11px] text-teal-700 font-mono">
                            Disc: {formatCurrency(p.discountAmount, currency)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-800">{p.paymentMode}</span>
                        {p.transactionReference && (
                          <span className="block font-mono text-[11px] text-slate-500">
                            UTR: {p.transactionReference}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-right font-medium text-slate-900">
                        {formatCurrency(p.amount, currency)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusLabel status={p.status} />
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {p.status === MemberPaymentStatus.PENDING && canConfirm && (
                            <>
                              <button
                                type="button"
                                onClick={() => setConfirmingPayment(p)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded hover:bg-emerald-100 cursor-pointer"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Verify & Confirm
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  setActionModal({
                                    payment: p,
                                    targetStatus: MemberPaymentStatus.REJECTED,
                                  })
                                }
                                className="p-1.5 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                                title="Reject pending payment"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                          {receipt && (
                            <button
                              type="button"
                              onClick={() => setActiveReceipt(receipt)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                            >
                              <Receipt className="w-3.5 h-3.5" />
                              Receipt
                            </button>
                          )}
                          {p.status === MemberPaymentStatus.CONFIRMED && canRefund && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setActionModal({
                                  payment: p,
                                  targetStatus: MemberPaymentStatus.REFUNDED,
                                })
                              }
                              className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded cursor-pointer"
                              title="Mark refunded"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
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

      {/* Record Payment Modal */}
      <Modal
        open={showAddModal}
        title="Record Manual Member Payment"
        subtitle="Supports Cash, UPI, partial settlements, discounts, and advance payments"
        onClose={() => setShowAddModal(false)}
      >
        <form onSubmit={handleRecord} className="space-y-4">
          {modalError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
              {modalError}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Member *</label>
              <select
                value={form.memberId}
                onChange={(e) => setForm({ ...form, memberId: e.target.value, membershipId: '' })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                {activeMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.fullName} ({m.memberCode}) — Due:{' '}
                    {formatCurrency(m.outstandingBalance, currency)}
                  </option>
                ))}
              </select>
            </div>
            {selectedMemberMemberships.length > 0 && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Link to Active Membership (Optional)
                </label>
                <select
                  value={form.membershipId}
                  onChange={(e) => setForm({ ...form, membershipId: e.target.value })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                >
                  <option value="">Auto-link oldest due membership</option>
                  {selectedMemberMemberships.map((ms) => (
                    <option key={ms.id} value={ms.id}>
                      {ms.planName} ({ms.startDate} → {ms.expiryDate}) · Due{' '}
                      {formatCurrency(ms.balanceDue, currency)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Amount *</label>
              <input
                type="number"
                required
                min="1"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Payment Mode</label>
              <select
                value={form.paymentMode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    paymentMode: e.target.value as PaymentMode,
                    allowDuplicateCash: false,
                  })
                }
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={PaymentMode.CASH}>Cash</option>
                <option value={PaymentMode.UPI}>UPI</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Purpose</label>
              <select
                value={form.paymentPurpose}
                onChange={(e) =>
                  setForm({
                    ...form,
                    paymentPurpose: e.target.value as MemberPaymentPurpose,
                  })
                }
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={MemberPaymentPurpose.BALANCE_SETTLEMENT}>
                  Balance Settlement / Partial
                </option>
                <option value={MemberPaymentPurpose.MEMBERSHIP}>Membership Fee</option>
                <option value={MemberPaymentPurpose.RENEWAL}>Renewal Fee</option>
                <option value={MemberPaymentPurpose.ADVANCE}>Advance Payment</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Payment Date</label>
              <input
                type="date"
                required
                value={form.paymentDate}
                onChange={(e) => setForm({ ...form, paymentDate: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Discount Applied (Optional)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="0"
                value={form.discountAmount}
                onChange={(e) => setForm({ ...form, discountAmount: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Remaining Due Date (Optional)
              </label>
              <input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            {Number(form.discountAmount) > 0 && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Discount Reason
                </label>
                <input
                  type="text"
                  value={form.discountReason}
                  onChange={(e) => setForm({ ...form, discountReason: e.target.value })}
                  placeholder="Promo / manager waiver"
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
            )}

            {form.paymentMode === PaymentMode.UPI && (
              <>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    UPI Transaction Reference (UTR)
                  </label>
                  <input
                    type="text"
                    value={form.transactionReference}
                    onChange={(e) =>
                      setForm({ ...form, transactionReference: e.target.value })
                    }
                    placeholder="12-digit UTR or UPI transaction ID"
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Payment Screenshot / Reference (Optional)
                  </label>
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    onChange={(e) =>
                      setForm({
                        ...form,
                        attachmentName: e.target.files?.[0]?.name || '',
                      })
                    }
                    className="text-xs text-slate-600"
                  />
                  <p className="text-[11px] text-amber-700 mt-1">
                    Verify the UPI payment in your bank or UPI app before confirming.
                  </p>
                </div>
              </>
            )}

            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>

            {form.paymentMode === PaymentMode.CASH && (
              <label className="col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.allowDuplicateCash}
                  onChange={(e) =>
                    setForm({ ...form, allowDuplicateCash: e.target.checked })
                  }
                />
                Allow same-day duplicate cash entry for this member &amp; amount
              </label>
            )}

            {canConfirm && (
              <label className="col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.confirmImmediately}
                  onChange={(e) =>
                    setForm({ ...form, confirmImmediately: e.target.checked })
                  }
                />
                Confirm receipt now & issue official payment receipt
              </label>
            )}
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
              {busy ? 'Saving...' : 'Save Payment'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Manual Verification Confirmation Modal */}
      <Modal
        open={Boolean(confirmingPayment)}
        title={`Confirm ${confirmingPayment?.paymentMode} Payment`}
        subtitle={`Payment ${confirmingPayment?.paymentCode} · ${confirmingPayment?.memberName}`}
        onClose={() => setConfirmingPayment(null)}
      >
        {confirmingPayment && (
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start gap-2.5 text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                {confirmingPayment.paymentMode === PaymentMode.UPI
                  ? 'Confirm only after verifying the credited amount and UTR in your bank or UPI app.'
                  : 'Confirm only after counting and securing the cash payment.'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 border border-slate-200 rounded-md p-3">
              <div>
                <p className="text-slate-500">Amount</p>
                <p className="font-mono font-semibold text-slate-900 text-sm mt-0.5">
                  {formatCurrency(confirmingPayment.amount, currency)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">UTR / Reference</p>
                <p className="font-mono text-slate-900 mt-0.5">
                  {confirmingPayment.transactionReference || '—'}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmingPayment(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleConfirmPending}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-md hover:bg-emerald-800 cursor-pointer"
              >
                Confirm Payment & Issue Receipt
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ReceiptModal
        receipt={activeReceipt}
        currencySymbol={currency}
        onClose={() => setActiveReceipt(null)}
      />

      <ConfirmModal
        open={Boolean(actionModal)}
        title={
          actionModal?.targetStatus === MemberPaymentStatus.REJECTED
            ? `Reject Payment · ${actionModal.payment.paymentCode}`
            : `Mark Payment Refunded · ${actionModal?.payment.paymentCode || ''}`
        }
        description={
          actionModal?.targetStatus === MemberPaymentStatus.REJECTED
            ? `Reject pending ${actionModal.payment.paymentMode} payment of ${formatCurrency(actionModal.payment.amount, currency)} from ${actionModal.payment.memberName}.`
            : `Refund confirmed payment of ${formatCurrency(actionModal?.payment.amount ?? 0, currency)} and restore member balance due.`
        }
        confirmLabel={
          actionModal?.targetStatus === MemberPaymentStatus.REJECTED
            ? 'Reject Payment'
            : 'Confirm Refund'
        }
        variant="danger"
        requireReason
        reasonLabel={
          actionModal?.targetStatus === MemberPaymentStatus.REJECTED
            ? 'Rejection Reason'
            : 'Refund Reason'
        }
        reasonPlaceholder={
          actionModal?.targetStatus === MemberPaymentStatus.REJECTED
            ? 'e.g. UTR not found in bank statement'
            : 'e.g. Duplicate charge / member cancelled'
        }
        defaultReason={
          actionModal?.targetStatus === MemberPaymentStatus.REJECTED
            ? 'Transaction not verified in bank/UPI app'
            : 'Manual refund issued'
        }
        onConfirm={handleRejectOrRefundConfirm}
        onCancel={() => setActionModal(null)}
      />
    </div>
  );
};
