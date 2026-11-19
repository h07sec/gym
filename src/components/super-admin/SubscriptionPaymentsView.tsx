import React, { useState } from 'react';
import { CheckCircle2, Plus } from 'lucide-react';
import {
  Gym,
  PaymentMode,
  SubscriptionPayment,
  SubscriptionPaymentStatus,
  SubscriptionPlan,
} from '../../types/gymos';
import {
  ActorContext,
  recordManualSubscriptionPayment,
  verifyExistingSubscriptionPayment,
} from '../../services/gymos-service';
import { formatCurrency, formatDisplayDate, toIsoDate } from '../../lib/utils';
import { addMonthsSafe } from '../../lib/domain/dates';
import { StatusLabel } from '../common/StatusBadge';
import { Modal } from '../common/Modal';

interface SubscriptionPaymentsViewProps {
  actor: ActorContext;
  gyms: Gym[];
  plans: SubscriptionPlan[];
  payments: SubscriptionPayment[];
}

export const SubscriptionPaymentsView: React.FC<SubscriptionPaymentsViewProps> = ({
  actor,
  gyms,
  plans,
  payments,
}) => {
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedGymId, setSelectedGymId] = useState(gyms[0]?.id || '');
  const [selectedPlanId, setSelectedPlanId] = useState(plans[0]?.id || '');
  const [amount, setAmount] = useState(String(plans[0]?.price || 1499));
  const [mode, setMode] = useState<PaymentMode>(PaymentMode.UPI);
  const [txRef, setTxRef] = useState('');
  const [paymentDate, setPaymentDate] = useState(toIsoDate());
  const [periodStart, setPeriodStart] = useState(toIsoDate());
  const [periodEnd, setPeriodEnd] = useState(addMonthsSafe(toIsoDate(), 1));
  const [notes, setNotes] = useState('');
  const [verifyImmediately, setVerifyImmediately] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filtered = payments.filter((p) =>
    statusFilter === 'ALL' ? true : p.status === statusFilter
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const gym = gyms.find((g) => g.id === selectedGymId);
    const plan = plans.find((p) => p.id === selectedPlanId);
    if (!gym || !plan) {
      setErrorMsg('Select both a gym and subscription plan.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      await recordManualSubscriptionPayment(actor, {
        gym,
        plan,
        amount: Number(amount),
        paymentMode: mode,
        transactionReference: txRef,
        paymentDate,
        periodStart,
        periodEnd,
        notes,
        verifyImmediately,
      });
      setShowAddModal(false);
      setTxRef('');
      setNotes('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to record payment.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (paymentId: string) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await verifyExistingSubscriptionPayment(actor, paymentId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          >
            <option value="ALL">All Payment Statuses</option>
            <option value={SubscriptionPaymentStatus.RECORDED}>Recorded (Pending Verification)</option>
            <option value={SubscriptionPaymentStatus.VERIFIED}>Verified</option>
            <option value={SubscriptionPaymentStatus.REJECTED}>Rejected</option>
          </select>
        </div>

        <button
          type="button"
          disabled={gyms.length === 0}
          onClick={() => {
            setSelectedGymId(gyms[0]?.id || '');
            setSelectedPlanId(plans[0]?.id || '');
            setAmount(String(plans[0]?.price || 0));
            setShowAddModal(true);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Record Subscription Payment
        </button>
      </div>

      {errorMsg && (
        <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
          {errorMsg}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No manual subscription payments recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Payment Date</th>
                  <th className="px-4 py-3 font-medium">Gym</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Mode & Reference</th>
                  <th className="px-4 py-3 font-medium">Subscription Period</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono tabular-nums text-slate-700">
                      {formatDisplayDate(p.paymentDate)}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">{p.gymName}</td>
                    <td className="px-4 py-3 text-slate-700">{p.planName}</td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-slate-800">{p.paymentMode}</span>
                      {p.transactionReference && (
                        <span className="block font-mono text-[11px] text-slate-500">
                          Ref: {p.transactionReference}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-slate-600">
                      {p.periodStart} → {p.periodEnd}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-right font-medium text-slate-900">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusLabel
                        status={p.status}
                        label={
                          p.status === SubscriptionPaymentStatus.RECORDED
                            ? 'Recorded (Unverified)'
                            : p.status
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {p.status === SubscriptionPaymentStatus.RECORDED && !p.extensionApplied ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleVerify(p.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded hover:bg-emerald-100 cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Verify & Extend
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-400">
                          {p.extensionApplied ? 'Extension applied' : '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={showAddModal}
        title="Record Subscription Payment"
        subtitle="Record a Cash or UPI payment; verify after confirming bank or UPI credit"
        onClose={() => setShowAddModal(false)}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Gym *</label>
              <select
                value={selectedGymId}
                onChange={(e) => setSelectedGymId(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                {gyms.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.ownerName})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Plan *</label>
              <select
                value={selectedPlanId}
                onChange={(e) => {
                  const p = plans.find((x) => x.id === e.target.value);
                  setSelectedPlanId(e.target.value);
                  if (p) {
                    setAmount(String(p.price));
                    setPeriodEnd(addMonthsSafe(periodStart, p.billingDurationMonths));
                  }
                }}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Amount *</label>
              <input
                type="number"
                required
                min="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Payment Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as PaymentMode)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={PaymentMode.UPI}>UPI</option>
                <option value={PaymentMode.CASH}>Cash</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Payment Date</label>
              <input
                type="date"
                required
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Transaction Reference</label>
              <input
                type="text"
                value={txRef}
                onChange={(e) => setTxRef(e.target.value)}
                placeholder="UPI UTR or cash receipt reference"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Period Start</label>
              <input
                type="date"
                required
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Period End</label>
              <input
                type="date"
                required
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Internal Notes</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={verifyImmediately}
                onChange={(e) => setVerifyImmediately(e.target.checked)}
              />
              Mark as Verified immediately and extend gym subscription
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
              {busy ? 'Saving...' : 'Save Payment'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
