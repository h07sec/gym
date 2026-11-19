import React, { useState } from 'react';
import { Plus, Edit2, Trash2 } from 'lucide-react';
import {
  GymSettings,
  MembershipDurationType,
  MembershipPlan,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';
import {
  ActorContext,
  deleteMembershipPlan,
  saveMembershipPlan,
} from '../../services/gymos-service';
import { formatCurrency } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { Modal } from '../common/Modal';
import { ConfirmModal } from '../common/ConfirmModal';

interface MembershipPlansViewProps {
  actor: ActorContext;
  gymId: string;
  settings: GymSettings;
  permissions: StaffPermissions;
  plans: MembershipPlan[];
}

export const MembershipPlansView: React.FC<MembershipPlansViewProps> = ({
  actor,
  gymId,
  settings,
  permissions,
  plans,
}) => {
  const currency = settings.currencySymbol || '₹';
  const canManage =
    actor.role === UserRole.GYM_OWNER ||
    actor.role === UserRole.GYM_MANAGER ||
    actor.role === UserRole.SUPER_ADMIN ||
    permissions.canManagePlans;

  const [editing, setEditing] = useState<Partial<MembershipPlan> | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<MembershipPlan | null>(null);
  const [benefitsText, setBenefitsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const openNew = () => {
    setErrorMsg(null);
    setEditing({
      name: '',
      durationType: MembershipDurationType.MONTHLY,
      durationValue: 1,
      price: 1500,
      description: '',
      status: 'ACTIVE',
    });
    setBenefitsText('Gym floor access\nLocker access');
  };

  const openEdit = (p: MembershipPlan) => {
    setErrorMsg(null);
    setEditing(p);
    setBenefitsText(p.benefits.join('\n'));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await saveMembershipPlan(actor, gymId, {
        id: editing.id,
        name: editing.name || 'Monthly Plan',
        durationType: editing.durationType || MembershipDurationType.MONTHLY,
        durationValue: Number(editing.durationValue) || 1,
        price: Number(editing.price) || 0,
        description: editing.description || '',
        benefits: benefitsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        status: (editing.status as 'ACTIVE' | 'INACTIVE') || 'ACTIVE',
      });
      setEditing(null);
      setFeedback('Membership plan saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save membership plan.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingPlan) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await deleteMembershipPlan(actor, gymId, deletingPlan);
      setFeedback(`Deleted plan "${deletingPlan.name}".`);
      setDeletingPlan(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Cannot delete this plan.');
      setDeletingPlan(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Membership Plans</h2>
          <p className="text-xs text-slate-500">
            Configure monthly, quarterly, half-yearly, yearly, or custom-day gym plans
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Create Plan
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

      {plans.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center space-y-2">
          <p className="text-sm font-medium text-slate-900">No membership plans created yet</p>
          <p className="text-xs text-slate-500">
            Create your gym&apos;s membership tiers to start assigning plans to members.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {plans.map((p) => (
            <div
              key={p.id}
              className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between space-y-4"
            >
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">{p.name}</h3>
                    <p className="text-xs text-slate-500 font-mono">
                      {p.durationType.replace(/_/g, ' ')} ·{' '}
                      {p.durationType === MembershipDurationType.CUSTOM_DAYS
                        ? `${p.durationValue} days`
                        : `${p.durationValue}x cycle`}
                    </p>
                  </div>
                  <StatusLabel status={p.status} />
                </div>

                <p className="text-2xl font-bold font-mono text-slate-900 tabular-nums">
                  {formatCurrency(p.price, currency)}
                </p>

                {p.description && (
                  <p className="text-xs text-slate-600">{p.description}</p>
                )}

                {p.benefits.length > 0 && (
                  <ul className="space-y-1 text-xs text-slate-600 border-t border-slate-200 pt-2.5">
                    {p.benefits.map((b, i) => (
                      <li key={i}>• {b}</li>
                    ))}
                  </ul>
                )}
              </div>

              {canManage && (
                <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => openEdit(p)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  {(actor.role === UserRole.GYM_OWNER ||
                    actor.role === UserRole.SUPER_ADMIN) && (
                    <button
                      type="button"
                      onClick={() => setDeletingPlan(p)}
                      className="p-1.5 text-red-600 border border-slate-200 rounded-md hover:bg-red-50 cursor-pointer"
                      title="Delete plan"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={Boolean(deletingPlan)}
        title={`Delete Plan "${deletingPlan?.name}"`}
        description="Plans assigned to active members or referenced in historical memberships cannot be deleted; mark them INACTIVE instead. Proceed to delete this unused plan?"
        confirmLabel="Delete Plan"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletingPlan(null)}
      />

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'Edit Membership Plan' : 'New Membership Plan'}
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
                  placeholder="e.g. Quarterly Strength Pass"
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Duration Type</label>
                <select
                  value={editing.durationType}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      durationType: e.target.value as MembershipDurationType,
                    })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                >
                  <option value={MembershipDurationType.MONTHLY}>Monthly</option>
                  <option value={MembershipDurationType.QUARTERLY}>Quarterly (3 Months)</option>
                  <option value={MembershipDurationType.HALF_YEARLY}>Half-Yearly (6 Months)</option>
                  <option value={MembershipDurationType.YEARLY}>Yearly (12 Months)</option>
                  <option value={MembershipDurationType.CUSTOM_DAYS}>Custom Days</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {editing.durationType === MembershipDurationType.CUSTOM_DAYS
                    ? 'Number of Days *'
                    : 'Cycle Count (usually 1) *'}
                </label>
                <input
                  type="number"
                  required
                  min="1"
                  max="3650"
                  value={editing.durationValue ?? 1}
                  onChange={(e) =>
                    setEditing({ ...editing, durationValue: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Price *</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={editing.price ?? 0}
                  onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Status</label>
                <select
                  value={editing.status || 'ACTIVE'}
                  onChange={(e) =>
                    setEditing({ ...editing, status: e.target.value as 'ACTIVE' | 'INACTIVE' })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
                <input
                  type="text"
                  value={editing.description || ''}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Benefits / Facilities (one per line)
                </label>
                <textarea
                  rows={3}
                  value={benefitsText}
                  onChange={(e) => setBenefitsText(e.target.value)}
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
