import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  LayoutDashboard,
  Users,
  Layers,
  CreditCard,
  BellRing,
  BarChart3,
  UserCog,
  Settings,
  LogOut,
  Menu,
  X,
  AlertTriangle,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { handleFirestoreError, OperationType } from '../../lib/firestore-error';
import { useAuth } from '../../contexts/AuthContext';
import {
  AuditLog,
  GymNotification,
  GymSettings,
  GymStaff,
  Member,
  MemberPayment,
  Membership,
  MembershipPlan,
  NotificationLog,
  PaymentReceipt,
  RenewalPolicy,
  StaffInvitation,
  SubscriptionStatus,
  UserRole,
} from '../../types/gymos';
import { ActorContext } from '../../services/gymos-service';
import { diffDays } from '../../lib/domain/dates';
import { timestampToIso, toIsoDate } from '../../lib/utils';
import { GymDashboard } from './GymDashboard';
import { MembersView } from './MembersView';
import { MembershipPlansView } from './MembershipPlansView';
import { PaymentsView } from './PaymentsView';
import { RemindersView } from './RemindersView';
import { ReportsView } from './ReportsView';
import { StaffView } from './StaffView';
import { GymSettingsView } from './GymSettingsView';

type GymTab =
  | 'dashboard'
  | 'members'
  | 'plans'
  | 'payments'
  | 'reminders'
  | 'reports'
  | 'staff'
  | 'settings';

export const GymShell: React.FC = () => {
  const { profile, gym, platformSettings, effectivePermissions, signOut } = useAuth();
  const [tab, setTab] = useState<GymTab>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [settings, setSettings] = useState<GymSettings | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [payments, setPayments] = useState<MemberPayment[]>([]);
  const [receipts, setReceipts] = useState<PaymentReceipt[]>([]);
  const [notifications, setNotifications] = useState<GymNotification[]>([]);
  const [notificationLogs, setNotificationLogs] = useState<NotificationLog[]>([]);
  const [staffList, setStaffList] = useState<GymStaff[]>([]);
  const [invitations, setInvitations] = useState<StaffInvitation[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  useEffect(() => {
    if (!gym?.id || !profile) return;
    const gymId = gym.id;

    const sortByCreatedDesc = <T extends { createdAt?: unknown }>(items: T[]) =>
      [...items].sort((a, b) =>
        (timestampToIso(b.createdAt) || '9999').localeCompare(
          timestampToIso(a.createdAt) || '9999'
        )
      );

    const unsubs = [
      onSnapshot(
        doc(db, 'gyms', gymId, 'settings', 'default'),
        (snap) => {
          if (snap.exists()) setSettings(snap.data() as GymSettings);
        },
        (err) => handleFirestoreError(err, OperationType.GET, `gyms/${gymId}/settings/default`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'members'), where('gymId', '==', gymId)),
        (snap) => setMembers(sortByCreatedDesc(snap.docs.map((d) => d.data() as Member))),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/members`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'membership_plans'), where('gymId', '==', gymId)),
        (snap) =>
          setPlans(
            snap.docs
              .map((d) => d.data() as MembershipPlan)
              .sort((a, b) => a.price - b.price)
          ),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/membership_plans`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'memberships'), where('gymId', '==', gymId)),
        (snap) =>
          setMemberships(sortByCreatedDesc(snap.docs.map((d) => d.data() as Membership))),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/memberships`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'member_payments'), where('gymId', '==', gymId)),
        (snap) =>
          setPayments(sortByCreatedDesc(snap.docs.map((d) => d.data() as MemberPayment))),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/member_payments`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'payment_receipts'), where('gymId', '==', gymId)),
        (snap) =>
          setReceipts(
            snap.docs
              .map((d) => d.data() as PaymentReceipt)
              .sort((a, b) =>
                (timestampToIso(b.issuedAt) || '9999').localeCompare(
                  timestampToIso(a.issuedAt) || '9999'
                )
              )
          ),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/payment_receipts`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'notifications'), where('gymId', '==', gymId)),
        (snap) =>
          setNotifications(
            sortByCreatedDesc(snap.docs.map((d) => d.data() as GymNotification))
          ),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/notifications`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'notification_logs'), where('gymId', '==', gymId)),
        (snap) =>
          setNotificationLogs(
            sortByCreatedDesc(snap.docs.map((d) => d.data() as NotificationLog))
          ),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/notification_logs`)
      ),
      onSnapshot(
        query(collection(db, 'gyms', gymId, 'staff'), where('gymId', '==', gymId)),
        (snap) => setStaffList(sortByCreatedDesc(snap.docs.map((d) => d.data() as GymStaff))),
        (err) => handleFirestoreError(err, OperationType.LIST, `gyms/${gymId}/staff`)
      ),
    ];

    if (profile.role === UserRole.GYM_OWNER || profile.role === UserRole.SUPER_ADMIN) {
      const invQuery =
        profile.role === UserRole.SUPER_ADMIN
          ? query(collection(db, 'invitations'), where('gymId', '==', gymId))
          : query(collection(db, 'invitations'), where('invitedByUid', '==', profile.uid));

      unsubs.push(
        onSnapshot(
          invQuery,
          (snap) =>
            setInvitations(
              sortByCreatedDesc(snap.docs.map((d) => d.data() as StaffInvitation))
            ),
          () => {}
        ),
        onSnapshot(
          query(collection(db, 'audit_logs'), where('gymId', '==', gymId)),
          (snap) =>
            setAuditLogs(sortByCreatedDesc(snap.docs.map((d) => d.data() as AuditLog))),
          () => {}
        )
      );
    }

    return () => unsubs.forEach((u) => u());
  }, [gym?.id, profile]);

  if (!profile || !gym) return null;

  const actor: ActorContext = {
    uid: profile.uid,
    email: profile.email,
    displayName: profile.displayName,
    role: profile.role,
  };

  const resolvedSettings: GymSettings = settings ?? {
    gymId: gym.id,
    gracePeriodDays: gym.gracePeriodDays,
    renewalPolicy: gym.renewalPolicy || RenewalPolicy.EXTEND_FROM_EXPIRY,
    reminderDaysBefore: [7, 3, 1],
    sendOnExpiryDay: true,
    sendAfterExpiryDays: [3, 7],
    emailEnabled: true,
    emailFromName: gym.name,
    inAppEnabled: true,
    whatsappEnabled: false,
    currencySymbol: '₹',
    updatedAt: null,
  };

  const isOwner =
    profile.role === UserRole.GYM_OWNER || profile.role === UserRole.SUPER_ADMIN;
  const canViewReports =
    isOwner || profile.role === UserRole.GYM_MANAGER || effectivePermissions.canViewReports;

  const navItems: { id: GymTab; label: string; icon: React.ReactNode; visible: boolean }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" />, visible: true },
    { id: 'members', label: 'Members', icon: <Users className="w-4 h-4" />, visible: true },
    { id: 'plans', label: 'Membership Plans', icon: <Layers className="w-4 h-4" />, visible: true },
    { id: 'payments', label: 'Cash & UPI Payments', icon: <CreditCard className="w-4 h-4" />, visible: true },
    { id: 'reminders', label: 'Reminders & Alerts', icon: <BellRing className="w-4 h-4" />, visible: true },
    { id: 'reports', label: 'Reports', icon: <BarChart3 className="w-4 h-4" />, visible: canViewReports },
    { id: 'staff', label: 'Staff & Access', icon: <UserCog className="w-4 h-4" />, visible: isOwner },
    { id: 'settings', label: 'Billing & Settings', icon: <Settings className="w-4 h-4" />, visible: isOwner },
  ];

  const visibleNav = navItems.filter((n) => n.visible);
  const activeLabel = visibleNav.find((n) => n.id === tab)?.label || 'Dashboard';

  const daysToSubExpiry = gym.subscriptionEndAt
    ? diffDays(toIsoDate(), gym.subscriptionEndAt.slice(0, 10))
    : 30;
  const showExpiryWarning =
    daysToSubExpiry <= 7 || gym.subscriptionStatus === SubscriptionStatus.EXPIRED;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex">
      <aside
        className={`no-print fixed inset-y-0 left-0 z-40 w-64 bg-white border-r border-slate-200 flex flex-col transition-transform lg:static lg:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between">
          <div className="min-w-0">
            <span className="text-base font-bold text-slate-900 font-display truncate block">
              {gym.name}
            </span>
            <span className="block text-[11px] text-slate-500">
              Powered by GymOS
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="lg:hidden text-slate-500 hover:text-slate-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {visibleNav.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id);
                  setMobileNavOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-teal-700 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="text-xs">
            <p className="font-medium text-slate-900 truncate">{profile.displayName}</p>
            <p className="text-slate-500 truncate">{profile.role.replace('GYM_', '')}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="no-print h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:bg-slate-100 rounded-md cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <span className="truncate max-w-[160px]">{gym.name}</span>
              <span>/</span>
              <span className="font-medium text-slate-900">{activeLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span className="hidden sm:inline">
              {notifications.filter((n) => !n.isRead).length} unread alerts
            </span>
            <span className="font-mono text-[11px]">
              Plan: {gym.subscriptionPlanName}
            </span>
          </div>
        </header>

        {showExpiryWarning && (
          <div className="no-print bg-amber-50 border-b border-amber-200 px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                {daysToSubExpiry < 0
                  ? `Your GymOS subscription expired on ${gym.subscriptionEndAt}. Contact the GymOS administrator to renew and avoid account suspension.`
                  : `Your GymOS subscription (${gym.subscriptionPlanName}) expires in ${daysToSubExpiry} days (${gym.subscriptionEndAt}).`}
              </span>
            </div>
            {isOwner && (
              <button
                type="button"
                onClick={() => setTab('settings')}
                className="font-semibold underline cursor-pointer"
              >
                View payment instructions
              </button>
            )}
          </div>
        )}

        <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
          {tab === 'dashboard' && (
            <GymDashboard
              role={profile.role}
              permissions={effectivePermissions}
              members={members}
              payments={payments}
              memberships={memberships}
              settings={resolvedSettings}
              onNavigate={(next) => setTab(next as GymTab)}
            />
          )}
          {tab === 'members' && (
            <MembersView
              actor={actor}
              gym={gym}
              settings={resolvedSettings}
              permissions={effectivePermissions}
              members={members}
              plans={plans}
              memberships={memberships}
              payments={payments}
            />
          )}
          {tab === 'plans' && (
            <MembershipPlansView
              actor={actor}
              gymId={gym.id}
              settings={resolvedSettings}
              permissions={effectivePermissions}
              plans={plans}
            />
          )}
          {tab === 'payments' && (
            <PaymentsView
              actor={actor}
              gym={gym}
              settings={resolvedSettings}
              permissions={effectivePermissions}
              members={members}
              payments={payments}
              receipts={receipts}
            />
          )}
          {tab === 'reminders' && (
            <RemindersView
              actor={actor}
              gym={gym}
              settings={resolvedSettings}
              permissions={effectivePermissions}
              members={members}
              logs={notificationLogs}
              notifications={notifications}
            />
          )}
          {tab === 'reports' && canViewReports && (
            <ReportsView
              gym={gym}
              settings={resolvedSettings}
              members={members}
              payments={payments}
              memberships={memberships}
            />
          )}
          {tab === 'staff' && isOwner && (
            <StaffView
              actor={actor}
              gym={gym}
              staffList={staffList}
              invitations={invitations}
              auditLogs={auditLogs}
            />
          )}
          {tab === 'settings' && isOwner && (
            <GymSettingsView
              actor={actor}
              gym={gym}
              settings={resolvedSettings}
              platformSettings={platformSettings}
            />
          )}
        </main>
      </div>
    </div>
  );
};
