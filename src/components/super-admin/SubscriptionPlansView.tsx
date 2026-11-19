import React, { useState } from 'react';
import { Plus, Edit2 } from 'lucide-react';
import { SubscriptionPlan } from '../../types/gymos';
import { ActorContext, saveSubscriptionPlan } from '../../services/gymos-service';
import { formatCurrency } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { Modal } from '../common/Modal';

interface SubscriptionPlansViewProps {
  actor: ActorContext;
  plans: SubscriptionPlan[];
}

export const SubscriptionPlansView: React.FC<SubscriptionPlansViewProps> = ({
  actor,
  plans,
}) => {
  const [editing, setEditing] = useState<Partial<SubscriptionPlan> | null>(null);
  const [featuresText, setFeaturesText] = useState('');
  const [busy, setBusy] = useState(false);

  const openEditor = (plan?: SubscriptionPlan) => {
    if (plan) {
      setEditing(plan);
      setFeaturesText(plan.features.join('\n'));
    } else {
      setEditing({
        name: '',
        billingDurationMonths: 1,
        price: 1499,
        currency: '₹',
        maxStaff: 5,
        maxMembers: 500,
        trialDays: 14,
        isActive: true,
      });
      setFeaturesText('Member management\nCash & UPI ledger\nAutomated reminders');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      await saveSubscriptionPlan(actor, {
        id: editing.id,
        name: editing.name || 'Standard Plan',
        billingDurationMonths: Number(editing.billingDurationMonths) || 1,
        price: Number(editing.price) || 0,
        currency: editing.currency || '₹',
        maxStaff: Number(editing.maxStaff) || 5,
        maxMembers: Number(editing.maxMembers) || 500,
        trialDays: Number(editing.trialDays) || 0,
        features: featuresText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        isActive: editing.isActive ?? true,
      });
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Subscription Plans
          </h2>
          <p className="text-xs text-slate-500">
            Pricing, duration, staff/member quotas, trial length, and availability
          </p>
        </div>
        <button
          type="button"
          onClick={() => openEditor()}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New Plan
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {plans.map((p) => (
          <div
            key={p.id}
            className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between space-y-4"
          >
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{p.name}</h3>
                  <p className="text-xs text-slate-500">
                    {p.billingDurationMonths}{' '}
                    {p.billingDurationMonths === 1 ? 'month' : 'months'} · {p.trialDays}d trial
                  </p>
                </div>
                <StatusLabel status={p.isActive ? 'ACTIVE' : 'CANCELLED'} label={p.isActive ? 'Available' : 'Hidden'} />
              </div>

              <p className="text-2xl font-bold font-mono text-slate-900 tabular-nums">
                {formatCurrency(p.price, p.currency)}
              </p>

              <div className="text-xs text-slate-600 space-y-1 border-t border-slate-200 pt-3">
                <p>Max staff seats: <span className="font-mono font-medium text-slate-900">{p.maxStaff}</span></p>
                <p>Max members: <span className="font-mono font-medium text-slate-900">{p.maxMembers}</span></p>
              </div>

              <ul className="space-y-1 text-xs text-slate-600 border-t border-slate-200 pt-3">
                {p.features.map((f, idx) => (
                  <li key={idx}>• {f}</li>
                ))}
              </ul>
            </div>

            <button
              type="button"
              onClick={() => openEditor(p)}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
            >
              <Edit2 className="w-3.5 h-3.5" />
              Edit Plan
            </button>
          </div>
        ))}
      </div>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'Edit Subscription Plan' : 'Create Subscription Plan'}
        onClose={() => setEditing(null)}
      >
        {editing && (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Plan Name *</label>
                <input
                  type="text"
                  required
                  value={editing.name || ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Price *</label>
                <input
                  type="number"
                  required
                  min="0"
                  value={editing.price ?? 0}
                  onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Billing Months *</label>
                <input
                  type="number"
                  required
                  min="1"
                  max="60"
                  value={editing.billingDurationMonths ?? 1}
                  onChange={(e) =>
                    setEditing({ ...editing, billingDurationMonths: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Max Staff</label>
                <input
                  type="number"
                  required
                  min="1"
                  value={editing.maxStaff ?? 5}
                  onChange={(e) => setEditing({ ...editing, maxStaff: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Max Members</label>
                <input
                  type="number"
                  required
                  min="1"
                  value={editing.maxMembers ?? 500}
                  onChange={(e) => setEditing({ ...editing, maxMembers: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Trial Days</label>
                <input
                  type="number"
                  required
                  min="0"
                  value={editing.trialDays ?? 14}
                  onChange={(e) => setEditing({ ...editing, trialDays: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editing.isActive ?? true}
                    onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
                  />
                  Available for onboarding
                </label>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Features (one per line)
                </label>
                <textarea
                  rows={4}
                  value={featuresText}
                  onChange={(e) => setFeaturesText(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
              >
                {busy ? 'Saving...' : 'Save Plan'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
};
