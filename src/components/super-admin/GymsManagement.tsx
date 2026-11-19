import React, { useMemo, useState } from 'react';
import { Plus, Search, Eye, PauseCircle, PlayCircle, CalendarPlus, CreditCard, ArrowUpRight } from 'lucide-react';
import {
  AccountStatus,
  AuditLog,
  Gym,
  PaymentMode,
  SubscriptionPayment,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../../types/gymos';
import { ActorContext, createGymBySuperAdmin, recordManualSubscriptionPayment, updateGymAccountState } from '../../services/gymos-service';
import { formatCurrency, formatDisplayDate, toIsoDate } from '../../lib/utils';
import { addMonthsSafe } from '../../lib/domain/dates';
import { StatusLabel } from '../common/StatusBadge';
import { Modal } from '../common/Modal';

interface GymsManagementProps {
  actor: ActorContext;
  gyms: Gym[];
  plans: SubscriptionPlan[];
  payments: SubscriptionPayment[];
  auditLogs: AuditLog[];
  onOpenGymWorkspace: (gymId: string) => void;
}

export const GymsManagement: React.FC<GymsManagementProps> = ({
  actor,
  gyms,
  plans,
  payments,
  auditLogs,
  onOpenGymWorkspace,
}) => {
  const [search, setSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState<string>('ALL');
  const [subFilter, setSubFilter] = useState<string>('ALL');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [detailGym, setDetailGym] = useState<Gym | null>(null);
  const [suspendGym, setSuspendGym] = useState<Gym | null>(null);
  const [suspensionReason, setSuspensionReason] = useState('');
  const [extendGym, setExtendGym] = useState<Gym | null>(null);
  const [newEndDate, setNewEndDate] = useState('');
  const [newPlanId, setNewPlanId] = useState('');
  const [newSubStatus, setNewSubStatus] = useState<SubscriptionStatus>(SubscriptionStatus.ACTIVE);

  const [paymentGym, setPaymentGym] = useState<Gym | null>(null);
  const [payAmount, setPayAmount] = useState('0');
  const [payMode, setPayMode] = useState<PaymentMode>(PaymentMode.UPI);
  const [payRef, setPayRef] = useState('');
  const [payPeriodStart, setPayPeriodStart] = useState(toIsoDate());
  const [payPeriodEnd, setPayPeriodEnd] = useState(addMonthsSafe(toIsoDate(), 1));
  const [payNotes, setPayNotes] = useState('');
  const [verifyNow, setVerifyNow] = useState(true);

  const [createForm, setCreateForm] = useState({
    gymName: '',
    ownerName: '',
    ownerEmail: '',
    phone: '',
    address: '',
    planId: plans[0]?.id || '',
    subscriptionStatus: SubscriptionStatus.TRIAL,
    accountStatus: AccountStatus.ACTIVE,
  });

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return gyms.filter((g) => {
      if (accountFilter !== 'ALL' && g.accountStatus !== accountFilter) return false;
      if (subFilter !== 'ALL' && g.subscriptionStatus !== subFilter) return false;
      if (!q) return true;
      return (
        g.name.toLowerCase().includes(q) ||
        g.ownerName.toLowerCase().includes(q) ||
        g.email.toLowerCase().includes(q) ||
        g.phone.toLowerCase().includes(q)
      );
    });
  }, [gyms, search, accountFilter, subFilter]);

  const handleCreateGym = async (e: React.FormEvent) => {
    e.preventDefault();
    const plan = plans.find((p) => p.id === (createForm.planId || plans[0]?.id));
    if (!plan) {
      setErrorMsg('Please create or select a subscription plan first.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      await createGymBySuperAdmin(actor, {
        gymName: createForm.gymName,
        ownerName: createForm.ownerName,
        ownerEmail: createForm.ownerEmail,
        phone: createForm.phone,
        address: createForm.address,
        plan,
        subscriptionStatus: createForm.subscriptionStatus,
        accountStatus: createForm.accountStatus,
      });
      setShowCreateModal(false);
      setCreateForm({
        gymName: '',
        ownerName: '',
        ownerEmail: '',
        phone: '',
        address: '',
        planId: plans[0]?.id || '',
        subscriptionStatus: SubscriptionStatus.TRIAL,
        accountStatus: AccountStatus.ACTIVE,
      });
      setFeedback('Gym created successfully.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create gym.');
    } finally {
      setBusy(false);
    }
  };

  const handleSuspendConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suspendGym) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await updateGymAccountState(
        actor,
        suspendGym,
        {
          accountStatus: AccountStatus.SUSPENDED,
          suspensionReason: suspensionReason.trim() || 'Subscription overdue / unpaid',
        },
        `Suspended gym ${suspendGym.name}: ${suspensionReason.trim() || 'Subscription overdue'}`
      );
      setSuspendGym(null);
      setSuspensionReason('');
      setFeedback(`Suspended ${suspendGym.name}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to suspend gym.');
    } finally {
      setBusy(false);
    }
  };

  const handleReactivate = async (gym: Gym) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await updateGymAccountState(
        actor,
        gym,
        {
          accountStatus: AccountStatus.ACTIVE,
          suspensionReason: '',
        },
        `Reactivated gym ${gym.name} preserving all historical data`
      );
      setFeedback(`Reactivated ${gym.name}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to reactivate gym.');
    } finally {
      setBusy(false);
    }
  };

  const handleExtendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!extendGym) return;
    const plan = plans.find((p) => p.id === newPlanId) || plans[0];
    setBusy(true);
    setErrorMsg(null);
    try {
      await updateGymAccountState(
        actor,
        extendGym,
        {
          subscriptionPlanId: plan ? plan.id : extendGym.subscriptionPlanId,
          subscriptionPlanName: plan ? plan.name : extendGym.subscriptionPlanName,
          subscriptionEndAt: newEndDate,
          subscriptionStatus: newSubStatus,
          accountStatus: AccountStatus.ACTIVE,
        },
        `Updated subscription for ${extendGym.name} (${plan?.name ?? extendGym.subscriptionPlanName}, expires ${newEndDate}, status ${newSubStatus})`
      );
      setExtendGym(null);
      setFeedback(`Updated subscription for ${extendGym.name}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to extend subscription.');
    } finally {
      setBusy(false);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentGym) return;
    const plan =
      plans.find((p) => p.id === paymentGym.subscriptionPlanId) || plans[0];
    if (!plan) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await recordManualSubscriptionPayment(actor, {
        gym: paymentGym,
        plan,
        amount: Number(payAmount),
        paymentMode: payMode,
        transactionReference: payRef,
        paymentDate: toIsoDate(),
        periodStart: payPeriodStart,
        periodEnd: payPeriodEnd,
        notes: payNotes,
        verifyImmediately: verifyNow,
      });
      setPaymentGym(null);
      setPayRef('');
      setPayNotes('');
      setFeedback(
        verifyNow
          ? `Payment verified and ${paymentGym.name} extended through ${payPeriodEnd}.`
          : `Payment recorded as pending verification for ${paymentGym.name}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to record subscription payment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search gym, owner, email, phone..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700"
            />
          </div>
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          >
            <option value="ALL">All Account Statuses</option>
            <option value={AccountStatus.ACTIVE}>Active</option>
            <option value={AccountStatus.SUSPENDED}>Suspended</option>
          </select>
          <select
            value={subFilter}
            onChange={(e) => setSubFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          >
            <option value="ALL">All Subscription Statuses</option>
            <option value={SubscriptionStatus.TRIAL}>Trial</option>
            <option value={SubscriptionStatus.ACTIVE}>Active</option>
            <option value={SubscriptionStatus.PENDING}>Pending</option>
            <option value={SubscriptionStatus.EXPIRED}>Expired</option>
            <option value={SubscriptionStatus.CANCELLED}>Cancelled</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => {
            setCreateForm((f) => ({ ...f, planId: plans[0]?.id || '' }));
            setShowCreateModal(true);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Gym
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

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No gyms match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Gym Name</th>
                  <th className="px-4 py-3 font-medium">Owner</th>
                  <th className="px-4 py-3 font-medium">Email / Phone</th>
                  <th className="px-4 py-3 font-medium">Registered</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Subscription</th>
                  <th className="px-4 py-3 font-medium">Expiry</th>
                  <th className="px-4 py-3 font-medium">Account</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filtered.map((g) => (
                  <tr key={g.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{g.name}</td>
                    <td className="px-4 py-3 text-slate-700">{g.ownerName}</td>
                    <td className="px-4 py-3 text-slate-600">
                      <div>{g.email}</div>
                      <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {g.phone}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                      {formatDisplayDate(g.subscriptionStartAt)}
                    </td>
                    <td className="px-4 py-3 text-slate-800">{g.subscriptionPlanName}</td>
                    <td className="px-4 py-3">
                      <StatusLabel status={g.subscriptionStatus} />
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-700 tabular-nums whitespace-nowrap">
                      {formatDisplayDate(g.subscriptionEndAt)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusLabel status={g.accountStatus} />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenGymWorkspace(g.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-teal-700 bg-teal-50 hover:bg-teal-100 rounded cursor-pointer"
                          title="Open Gym Owner Product"
                        >
                          <span>Open App</span>
                          <ArrowUpRight className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetailGym(g)}
                          className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                          title="View details & history"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const plan = plans.find((p) => p.id === g.subscriptionPlanId) || plans[0];
                            setPaymentGym(g);
                            setPayAmount(String(plan?.price ?? 0));
                            setPayPeriodStart(toIsoDate());
                            setPayPeriodEnd(
                              addMonthsSafe(
                                toIsoDate(),
                                plan?.billingDurationMonths || 1
                              )
                            );
                          }}
                          className="p-1.5 text-slate-500 hover:text-teal-700 hover:bg-slate-100 rounded cursor-pointer"
                          title="Record manual subscription payment"
                        >
                          <CreditCard className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setExtendGym(g);
                            setNewEndDate(g.subscriptionEndAt);
                            setNewPlanId(g.subscriptionPlanId);
                            setNewSubStatus(g.subscriptionStatus);
                          }}
                          className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                          title="Extend or change plan"
                        >
                          <CalendarPlus className="w-3.5 h-3.5" />
                        </button>
                        {g.accountStatus === AccountStatus.ACTIVE ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setSuspendGym(g)}
                            className="p-1.5 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                            title="Suspend gym account"
                          >
                            <PauseCircle className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleReactivate(g)}
                            className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded cursor-pointer"
                            title="Reactivate gym account"
                          >
                            <PlayCircle className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Gym Modal */}
      <Modal
        open={showCreateModal}
        title="Create Gym Account"
        subtitle="Set up a new independent gym account"
        onClose={() => setShowCreateModal(false)}
      >
        <form onSubmit={handleCreateGym} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Gym Name *</label>
              <input
                type="text"
                required
                value={createForm.gymName}
                onChange={(e) => setCreateForm({ ...createForm, gymName: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Owner Name *</label>
              <input
                type="text"
                required
                value={createForm.ownerName}
                onChange={(e) => setCreateForm({ ...createForm, ownerName: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Owner Email *</label>
              <input
                type="email"
                required
                value={createForm.ownerEmail}
                onChange={(e) => setCreateForm({ ...createForm, ownerEmail: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phone *</label>
              <input
                type="tel"
                required
                value={createForm.phone}
                onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Address</label>
              <input
                type="text"
                value={createForm.address}
                onChange={(e) => setCreateForm({ ...createForm, address: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Subscription Plan</label>
              <select
                value={createForm.planId}
                onChange={(e) => setCreateForm({ ...createForm, planId: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({formatCurrency(p.price, p.currency)})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Initial Subscription Status</label>
              <select
                value={createForm.subscriptionStatus}
                onChange={(e) =>
                  setCreateForm({
                    ...createForm,
                    subscriptionStatus: e.target.value as SubscriptionStatus,
                  })
                }
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={SubscriptionStatus.TRIAL}>Trial</option>
                <option value={SubscriptionStatus.ACTIVE}>Active</option>
                <option value={SubscriptionStatus.PENDING}>Pending</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowCreateModal(false)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
            >
              {busy ? 'Saving...' : 'Create Gym'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Suspend Gym Modal */}
      <Modal
        open={Boolean(suspendGym)}
        title={`Suspend ${suspendGym?.name}`}
        subtitle="Pauses gym access while preserving all historical data"
        onClose={() => setSuspendGym(null)}
      >
        <form onSubmit={handleSuspendConfirm} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Suspension Reason *
            </label>
            <textarea
              required
              rows={3}
              value={suspensionReason}
              onChange={(e) => setSuspensionReason(e.target.value)}
              placeholder="e.g. Monthly subscription expired and unpaid after grace period"
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setSuspendGym(null)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-red-600 rounded-md hover:bg-red-700 cursor-pointer"
            >
              Confirm Suspension
            </button>
          </div>
        </form>
      </Modal>

      {/* Extend / Change Plan Modal */}
      <Modal
        open={Boolean(extendGym)}
        title={`Manage Subscription · ${extendGym?.name}`}
        onClose={() => setExtendGym(null)}
      >
        <form onSubmit={handleExtendSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Plan</label>
            <select
              value={newPlanId}
              onChange={(e) => setNewPlanId(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({formatCurrency(p.price, p.currency)})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Subscription Status</label>
            <select
              value={newSubStatus}
              onChange={(e) => setNewSubStatus(e.target.value as SubscriptionStatus)}
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
            >
              <option value={SubscriptionStatus.ACTIVE}>Active</option>
              <option value={SubscriptionStatus.TRIAL}>Trial</option>
              <option value={SubscriptionStatus.EXPIRED}>Expired</option>
              <option value={SubscriptionStatus.PENDING}>Pending</option>
              <option value={SubscriptionStatus.CANCELLED}>Cancelled</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Expiry Date *</label>
            <input
              type="date"
              required
              value={newEndDate}
              onChange={(e) => setNewEndDate(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setExtendGym(null)}
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
      </Modal>

      {/* Record Manual Subscription Payment Modal */}
      <Modal
        open={Boolean(paymentGym)}
        title={`Record Subscription Payment · ${paymentGym?.name}`}
        subtitle="Record a Cash or UPI subscription payment"
        onClose={() => setPaymentGym(null)}
      >
        <form onSubmit={handleRecordPayment} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Amount *</label>
              <input
                type="number"
                required
                min="1"
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Payment Mode</label>
              <select
                value={payMode}
                onChange={(e) => setPayMode(e.target.value as PaymentMode)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={PaymentMode.UPI}>UPI</option>
                <option value={PaymentMode.CASH}>Cash</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Transaction Reference {payMode === PaymentMode.UPI ? '(Recommended for UPI)' : '(Optional)'}
              </label>
              <input
                type="text"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                placeholder="UTR / Reference ID"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Period Start *</label>
              <input
                type="date"
                required
                value={payPeriodStart}
                onChange={(e) => setPayPeriodStart(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Period End *</label>
              <input
                type="date"
                required
                value={payPeriodEnd}
                onChange={(e) => setPayPeriodEnd(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Internal Notes</label>
              <input
                type="text"
                value={payNotes}
                onChange={(e) => setPayNotes(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={verifyNow}
                onChange={(e) => setVerifyNow(e.target.checked)}
              />
              Verify payment immediately and extend subscription through Period End
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setPaymentGym(null)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
            >
              {verifyNow ? 'Confirm & Extend' : 'Record as Unverified'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Gym Details & History Modal */}
      <Modal
        open={Boolean(detailGym)}
        title={detailGym?.name || 'Gym Details'}
        subtitle={`Gym ID: ${detailGym?.id}`}
        onClose={() => setDetailGym(null)}
        maxWidthClass="max-w-2xl"
      >
        {detailGym && (
          <div className="space-y-6 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 border border-slate-200 rounded-md p-4">
              <div>
                <p className="text-slate-500">Owner</p>
                <p className="font-medium text-slate-900 mt-0.5">{detailGym.ownerName}</p>
              </div>
              <div>
                <p className="text-slate-500">Email</p>
                <p className="text-slate-900 mt-0.5">{detailGym.email}</p>
              </div>
              <div>
                <p className="text-slate-500">Phone</p>
                <p className="font-mono text-slate-900 mt-0.5">{detailGym.phone}</p>
              </div>
              <div>
                <p className="text-slate-500">Plan</p>
                <p className="font-medium text-slate-900 mt-0.5">{detailGym.subscriptionPlanName}</p>
              </div>
              <div>
                <p className="text-slate-500">Subscription</p>
                <div className="mt-1">
                  <StatusLabel status={detailGym.subscriptionStatus} />
                </div>
              </div>
              <div>
                <p className="text-slate-500">Account</p>
                <div className="mt-1">
                  <StatusLabel status={detailGym.accountStatus} />
                </div>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-slate-900 mb-2">Subscription Payment History</h4>
              <div className="border border-slate-200 rounded-md overflow-hidden">
                {payments.filter((p) => p.gymId === detailGym.id).length === 0 ? (
                  <p className="p-4 text-slate-500">No subscription payments recorded.</p>
                ) : (
                  <table className="w-full text-left">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Mode</th>
                        <th className="px-3 py-2">Period</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {payments
                        .filter((p) => p.gymId === detailGym.id)
                        .map((p) => (
                          <tr key={p.id}>
                            <td className="px-3 py-2 font-mono">{p.paymentDate}</td>
                            <td className="px-3 py-2">{p.paymentMode}</td>
                            <td className="px-3 py-2 font-mono">
                              {p.periodStart} → {p.periodEnd}
                            </td>
                            <td className="px-3 py-2 font-mono text-right">
                              {formatCurrency(p.amount)}
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

            <div>
              <h4 className="font-semibold text-slate-900 mb-2">Gym Audit History</h4>
              <div className="border border-slate-200 rounded-md divide-y divide-slate-200 max-h-48 overflow-y-auto">
                {auditLogs.filter((l) => l.gymId === detailGym.id).length === 0 ? (
                  <p className="p-4 text-slate-500">No audit records for this gym.</p>
                ) : (
                  auditLogs
                    .filter((l) => l.gymId === detailGym.id)
                    .map((l) => (
                      <div key={l.id} className="px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-slate-800">{l.summary}</span>
                        <span className="font-mono text-slate-500 shrink-0">{l.action}</span>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
