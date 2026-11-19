import React, { useState } from 'react';
import { Plus, UserX, UserCheck, Shield } from 'lucide-react';
import {
  AssignableStaffRole,
  AuditLog,
  Gym,
  GymStaff,
  StaffInvitation,
  StaffPermissions,
  UserRole,
  UserStatus,
} from '../../types/gymos';
import {
  ActorContext,
  createStaffInvitation,
  revokeStaffInvitation,
  updateGymStaffMember,
} from '../../services/gymos-service';
import { timestampToIso } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';
import { Modal } from '../common/Modal';
import { ConfirmModal } from '../common/ConfirmModal';

interface StaffViewProps {
  actor: ActorContext;
  gym: Gym;
  staffList: GymStaff[];
  invitations: StaffInvitation[];
  auditLogs: AuditLog[];
}

const DEFAULT_PERMISSIONS_BY_ROLE: Record<AssignableStaffRole, StaffPermissions> = {
  [UserRole.GYM_MANAGER]: {
    canViewReports: true,
    canViewPayments: true,
    canRecordPayments: true,
    canManagePlans: true,
    canConfirmPayments: true,
    canDeleteMembers: false,
    canManageReminders: true,
    canManageAttendance: true,
  },
  [UserRole.GYM_RECEPTIONIST]: {
    canViewReports: false,
    canViewPayments: true,
    canRecordPayments: true,
    canManagePlans: false,
    canConfirmPayments: false,
    canDeleteMembers: false,
    canManageReminders: false,
    canManageAttendance: true,
  },
  [UserRole.GYM_TRAINER]: {
    canViewReports: false,
    canViewPayments: false,
    canRecordPayments: false,
    canManagePlans: false,
    canConfirmPayments: false,
    canDeleteMembers: false,
    canManageReminders: false,
    canManageAttendance: true,
  },
};

const PERMISSION_LABELS: { key: keyof StaffPermissions; label: string }[] = [
  { key: 'canManageAttendance', label: 'Record member check-in & check-out attendance' },
  { key: 'canViewPayments', label: 'View member payment ledger, balances & receipts' },
  { key: 'canRecordPayments', label: 'Record manual Cash & UPI payments' },
  { key: 'canConfirmPayments', label: 'Verify & confirm pending Cash/UPI receipts' },
  { key: 'canViewReports', label: 'View financial dashboards & reports' },
  { key: 'canManagePlans', label: 'Create & edit membership plans' },
  { key: 'canManageReminders', label: 'Configure & run automated reminders' },
  { key: 'canDeleteMembers', label: 'Permanently delete archived members' },
];

export const StaffView: React.FC<StaffViewProps> = ({
  actor,
  gym,
  staffList,
  invitations,
  auditLogs,
}) => {
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [editingStaff, setEditingStaff] = useState<GymStaff | null>(null);
  const [confirmToggleStaff, setConfirmToggleStaff] = useState<GymStaff | null>(null);
  const [confirmRevokeInvite, setConfirmRevokeInvite] = useState<StaffInvitation | null>(null);

  const [inviteForm, setInviteForm] = useState<{
    fullName: string;
    email: string;
    role: AssignableStaffRole;
    roleTitle: string;
    permissions: StaffPermissions;
  }>({
    fullName: '',
    email: '',
    role: UserRole.GYM_RECEPTIONIST,
    roleTitle: '',
    permissions: { ...DEFAULT_PERMISSIONS_BY_ROLE[UserRole.GYM_RECEPTIONIST] },
  });

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      await createStaffInvitation(actor, gym, {
        fullName: inviteForm.fullName,
        email: inviteForm.email,
        role: inviteForm.role,
        roleTitle: inviteForm.roleTitle,
        permissions: inviteForm.permissions,
      });
      setShowInviteModal(false);
      setInviteForm({
        fullName: '',
        email: '',
        role: UserRole.GYM_RECEPTIONIST,
        roleTitle: '',
        permissions: { ...DEFAULT_PERMISSIONS_BY_ROLE[UserRole.GYM_RECEPTIONIST] },
      });
      setFeedback(
        'Staff invitation created. The invited user can sign in with Google using their invited email to activate access.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create staff invitation.');
    } finally {
      setBusy(false);
    }
  };

  const handleSavePermissions = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStaff || editingStaff.role === UserRole.GYM_OWNER) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await updateGymStaffMember(actor, gym.id, editingStaff, {
        role: editingStaff.role,
        roleTitle: editingStaff.roleTitle || '',
        permissions: editingStaff.permissions,
      });
      setEditingStaff(null);
      setFeedback('Staff role & permissions updated.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update staff permissions.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmToggleStaff = async () => {
    if (!confirmToggleStaff || confirmToggleStaff.role === UserRole.GYM_OWNER) return;
    setErrorMsg(null);
    const nextStatus =
      confirmToggleStaff.status === UserStatus.ACTIVE
        ? UserStatus.DEACTIVATED
        : UserStatus.ACTIVE;
    try {
      await updateGymStaffMember(actor, gym.id, confirmToggleStaff, {
        status: nextStatus,
      });
      setFeedback(
        `${confirmToggleStaff.fullName} has been ${
          nextStatus === UserStatus.ACTIVE ? 'reactivated' : 'deactivated'
        }.`
      );
      setConfirmToggleStaff(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update staff status.');
    }
  };

  const handleConfirmRevokeInvite = async () => {
    if (!confirmRevokeInvite) return;
    setErrorMsg(null);
    try {
      await revokeStaffInvitation(actor, confirmRevokeInvite);
      setFeedback(`Revoked invitation for ${confirmRevokeInvite.email}.`);
      setConfirmRevokeInvite(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to revoke invitation.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Staff Accounts &amp; Access Control
          </h2>
          <p className="text-xs text-slate-500">
            Invite managers, receptionists, or trainers by email and configure granular RBAC permissions
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowInviteModal(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Invite Staff
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
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Active &amp; Deactivated Staff</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Role &amp; Title</th>
                <th className="px-4 py-2.5 font-medium">Permissions</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {staffList.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{s.fullName}</td>
                  <td className="px-4 py-3 text-slate-600">{s.email}</td>
                  <td className="px-4 py-3 text-slate-800">
                    <span className="font-medium">
                      {s.role.replace('GYM_', '').replace('_', ' ')}
                    </span>
                    {s.roleTitle && (
                      <span className="block text-[11px] text-slate-500">{s.roleTitle}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {s.role === UserRole.GYM_OWNER
                      ? 'Full Owner Access'
                      : [
                          s.permissions.canManageAttendance && 'Attendance',
                          s.permissions.canViewPayments && 'View Payments',
                          s.permissions.canRecordPayments && 'Record Payments',
                          s.permissions.canConfirmPayments && 'Confirm Payments',
                          s.permissions.canViewReports && 'Reports',
                          s.permissions.canManagePlans && 'Plans',
                          s.permissions.canManageReminders && 'Reminders',
                          s.permissions.canDeleteMembers && 'Delete Members',
                        ]
                          .filter(Boolean)
                          .join(', ') || 'Member Roster Only'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusLabel status={s.status} />
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {s.role !== UserRole.GYM_OWNER && (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setEditingStaff({
                              ...s,
                              permissions: {
                                ...DEFAULT_PERMISSIONS_BY_ROLE[
                                  s.role as AssignableStaffRole
                                ],
                                ...s.permissions,
                              },
                            })
                          }
                          className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                          title="Configure permissions"
                        >
                          <Shield className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmToggleStaff(s)}
                          className={`p-1.5 rounded cursor-pointer ${
                            s.status === UserStatus.ACTIVE
                              ? 'text-red-600 hover:bg-red-50'
                              : 'text-emerald-700 hover:bg-emerald-50'
                          }`}
                          title={
                            s.status === UserStatus.ACTIVE
                              ? 'Deactivate staff'
                              : 'Reactivate staff'
                          }
                        >
                          {s.status === UserStatus.ACTIVE ? (
                            <UserX className="w-3.5 h-3.5" />
                          ) : (
                            <UserCheck className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pending Invitations */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Staff Invitations</h3>
        </div>
        {invitations.length === 0 ? (
          <div className="p-6 text-xs text-slate-500">No invitations sent yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{inv.fullName}</td>
                    <td className="px-4 py-2.5 text-slate-600">{inv.email}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-700">
                      {inv.role.replace('GYM_', '').replace('_', ' ')}
                      {inv.roleTitle ? ` (${inv.roleTitle})` : ''}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusLabel status={inv.status} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {inv.status === 'PENDING' && (
                        <button
                          type="button"
                          onClick={() => setConfirmRevokeInvite(inv)}
                          className="text-xs font-medium text-red-600 hover:underline cursor-pointer"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Staff Activity */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Recent Staff Activity</h3>
        </div>
        <div className="divide-y divide-slate-200 max-h-64 overflow-y-auto text-xs">
          {auditLogs.slice(0, 15).map((l) => (
            <div key={l.id} className="px-4 py-2.5 flex items-center justify-between gap-4">
              <div>
                <span className="font-medium text-slate-900">{l.actorEmail}</span>{' '}
                <span className="text-slate-600">— {l.summary}</span>
              </div>
              <span className="font-mono text-slate-400 shrink-0">
                {timestampToIso(l.createdAt).slice(0, 16).replace('T', ' ')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Invite Modal */}
      <Modal
        open={showInviteModal}
        title="Invite Staff Member"
        subtitle="Staff must sign in with the exact invited Google email to activate access"
        onClose={() => setShowInviteModal(false)}
      >
        <form onSubmit={handleInvite} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Full Name *</label>
              <input
                type="text"
                required
                value={inviteForm.fullName}
                onChange={(e) => setInviteForm({ ...inviteForm, fullName: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Email Address *</label>
              <input
                type="email"
                required
                value={inviteForm.email}
                onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Role</label>
              <select
                value={inviteForm.role}
                onChange={(e) => {
                  const role = e.target.value as AssignableStaffRole;
                  setInviteForm({
                    ...inviteForm,
                    role,
                    permissions: { ...DEFAULT_PERMISSIONS_BY_ROLE[role] },
                  });
                }}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              >
                <option value={UserRole.GYM_RECEPTIONIST}>Receptionist</option>
                <option value={UserRole.GYM_MANAGER}>Gym Manager</option>
                <option value={UserRole.GYM_TRAINER}>Trainer / Coach</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Custom Title (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Floor Coach / Morning Desk"
                value={inviteForm.roleTitle}
                onChange={(e) => setInviteForm({ ...inviteForm, roleTitle: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
              />
            </div>
          </div>

          <div className="space-y-2 border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold text-slate-800">Granular Permissions</p>
            {PERMISSION_LABELS.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={inviteForm.permissions[key]}
                  onChange={(e) =>
                    setInviteForm({
                      ...inviteForm,
                      permissions: {
                        ...inviteForm.permissions,
                        [key]: e.target.checked,
                      },
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowInviteModal(false)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
            >
              Send Invitation
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Staff Permissions Modal */}
      <Modal
        open={Boolean(editingStaff)}
        title={`Permissions · ${editingStaff?.fullName}`}
        onClose={() => setEditingStaff(null)}
      >
        {editingStaff && (
          <form onSubmit={handleSavePermissions} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Role</label>
                <select
                  value={editingStaff.role}
                  onChange={(e) => {
                    const role = e.target.value as AssignableStaffRole;
                    setEditingStaff({
                      ...editingStaff,
                      role,
                    });
                  }}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                >
                  <option value={UserRole.GYM_RECEPTIONIST}>Receptionist</option>
                  <option value={UserRole.GYM_MANAGER}>Gym Manager</option>
                  <option value={UserRole.GYM_TRAINER}>Trainer / Coach</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Custom Title (Optional)
                </label>
                <input
                  type="text"
                  value={editingStaff.roleTitle || ''}
                  onChange={(e) =>
                    setEditingStaff({ ...editingStaff, roleTitle: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
                />
              </div>
            </div>
            <div className="space-y-2 border-t border-slate-200 pt-3">
              {PERMISSION_LABELS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(editingStaff.permissions[key])}
                    onChange={(e) =>
                      setEditingStaff({
                        ...editingStaff,
                        permissions: {
                          ...editingStaff.permissions,
                          [key]: e.target.checked,
                        },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setEditingStaff(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
              >
                Save Permissions
              </button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmModal
        open={Boolean(confirmToggleStaff)}
        title={
          confirmToggleStaff?.status === UserStatus.ACTIVE
            ? `Deactivate Staff · ${confirmToggleStaff.fullName}`
            : `Reactivate Staff · ${confirmToggleStaff?.fullName || ''}`
        }
        description={
          confirmToggleStaff?.status === UserStatus.ACTIVE
            ? 'Deactivated staff lose immediate access to this gym workspace and Firestore reads/writes.'
            : 'Restores workspace access for this staff member with their configured permissions.'
        }
        confirmLabel={
          confirmToggleStaff?.status === UserStatus.ACTIVE ? 'Deactivate Staff' : 'Reactivate Staff'
        }
        variant={confirmToggleStaff?.status === UserStatus.ACTIVE ? 'danger' : 'primary'}
        onConfirm={handleConfirmToggleStaff}
        onCancel={() => setConfirmToggleStaff(null)}
      />

      <ConfirmModal
        open={Boolean(confirmRevokeInvite)}
        title={`Revoke Invitation · ${confirmRevokeInvite?.email || ''}`}
        description="Revoking prevents the recipient from claiming this invitation when signing in."
        confirmLabel="Revoke Invitation"
        variant="danger"
        onConfirm={handleConfirmRevokeInvite}
        onCancel={() => setConfirmRevokeInvite(null)}
      />
    </div>
  );
};
