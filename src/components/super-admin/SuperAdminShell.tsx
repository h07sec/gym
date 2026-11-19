import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import {
  LayoutDashboard,
  Building2,
  Layers,
  CreditCard,
  Settings,
  ShieldAlert,
  LogOut,
  Menu,
  X,
  ArrowUpRight,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { handleFirestoreError, OperationType } from '../../lib/firestore-error';
import { useAuth } from '../../contexts/AuthContext';
import {
  AccountStatus,
  AuditLog,
  Gym,
  PlatformAdmin,
  PlatformNotification,
  SubscriptionPayment,
  SubscriptionPlan,
  SubscriptionStatus,
  UserRole,
} from '../../types/gymos';
import { ActorContext, createGymBySuperAdmin } from '../../services/gymos-service';
import { PlatformOverview } from './PlatformOverview';
import { GymsManagement } from './GymsManagement';
import { SubscriptionPlansView } from './SubscriptionPlansView';
import { SubscriptionPaymentsView } from './SubscriptionPaymentsView';
import { PlatformSettingsView } from './PlatformSettingsView';
import { AuditLogsView } from './AuditLogsView';
import { Modal } from '../common/Modal';

type AdminTab = 'overview' | 'gyms' | 'plans' | 'payments' | 'settings' | 'audit';

export const SuperAdminShell: React.FC = () => {
  const { profile, platformSettings, enterGymWorkspace, signOut } = useAuth();
  const [tab, setTab] = useState<AdminTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [gyms, setGyms] = useState<Gym[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [payments, setPayments] = useState<SubscriptionPayment[]>([]);
  const [notifications, setNotifications] = useState<PlatformNotification[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [platformAdmins, setPlatformAdmins] = useState<PlatformAdmin[]>([]);

  const [showQuickLaunch, setShowQuickLaunch] = useState(false);
  const [launchName, setLaunchName] = useState('');
  const [launchPhone, setLaunchPhone] = useState('');
  const [launchAddress, setLaunchAddress] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    const unsubs = [
      onSnapshot(
        query(collection(db, 'gyms'), orderBy('createdAt', 'desc')),
        (snap) => setGyms(snap.docs.map((d) => d.data() as Gym)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'gyms')
      ),
      onSnapshot(
        collection(db, 'subscription_plans'),
        (snap) =>
          setPlans(
            snap.docs
              .map((d) => d.data() as SubscriptionPlan)
              .sort((a, b) => a.price - b.price)
          ),
        (err) => handleFirestoreError(err, OperationType.LIST, 'subscription_plans')
      ),
      onSnapshot(
        query(collection(db, 'subscription_payments'), orderBy('createdAt', 'desc')),
        (snap) => setPayments(snap.docs.map((d) => d.data() as SubscriptionPayment)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'subscription_payments')
      ),
      onSnapshot(
        query(collection(db, 'platform_notifications'), orderBy('createdAt', 'desc')),
        (snap) => setNotifications(snap.docs.map((d) => d.data() as PlatformNotification)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'platform_notifications')
      ),
      onSnapshot(
        query(collection(db, 'audit_logs'), orderBy('createdAt', 'desc')),
        (snap) => setAuditLogs(snap.docs.map((d) => d.data() as AuditLog)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'audit_logs')
      ),
      onSnapshot(
        collection(db, 'platform_admins'),
        (snap) => setPlatformAdmins(snap.docs.map((d) => d.data() as PlatformAdmin)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'platform_admins')
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  if (!profile) return null;

  const actor: ActorContext = {
    uid: profile.uid,
    email: profile.email,
    displayName: profile.displayName,
    role: UserRole.SUPER_ADMIN,
  };

  const handleOpenProductClick = () => {
    const firstActive = gyms.find((g) => g.accountStatus === AccountStatus.ACTIVE) || gyms[0];
    if (firstActive) {
      enterGymWorkspace(firstActive.id);
    } else {
      setShowQuickLaunch(true);
    }
  };

  const handleQuickCreateAndOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    const defaultPlan = plans.find((p) => p.isActive) || plans[0];
    if (!defaultPlan) {
      setLaunchError('Subscription plans are still loading. Please try again in a moment.');
      return;
    }
    setLaunching(true);
    setLaunchError(null);
    try {
      const newGymId = await createGymBySuperAdmin(actor, {
        gymName: launchName.trim(),
        ownerName: profile.displayName,
        ownerEmail: profile.email,
        phone: launchPhone.trim(),
        address: launchAddress.trim(),
        plan: defaultPlan,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        accountStatus: AccountStatus.ACTIVE,
      });
      setShowQuickLaunch(false);
      setLaunchName('');
      setLaunchPhone('');
      setLaunchAddress('');
      enterGymWorkspace(newGymId);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Unable to launch gym workspace.');
    } finally {
      setLaunching(false);
    }
  };

  const navItems: { id: AdminTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Platform Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
    { id: 'gyms', label: 'Gyms', icon: <Building2 className="w-4 h-4" /> },
    { id: 'plans', label: 'Subscription Plans', icon: <Layers className="w-4 h-4" /> },
    { id: 'payments', label: 'SaaS Payments', icon: <CreditCard className="w-4 h-4" /> },
    { id: 'settings', label: 'Platform Settings', icon: <Settings className="w-4 h-4" /> },
    { id: 'audit', label: 'Audit Logs', icon: <ShieldAlert className="w-4 h-4" /> },
  ];

  const activeLabel = navItems.find((n) => n.id === tab)?.label || 'Platform Overview';

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 text-slate-200 flex flex-col transition-transform lg:static lg:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-5 border-b border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-base font-bold text-white font-display tracking-tight">
              GymOS
            </span>
            <span className="block text-[11px] text-slate-400">SaaS Platform Admin</span>
          </div>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="lg:hidden text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 border-b border-slate-800">
          <button
            type="button"
            onClick={handleOpenProductClick}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-600 rounded-md cursor-pointer transition-colors"
          >
            <span>Open Gym Owner App</span>
            <ArrowUpRight className="w-4 h-4 shrink-0" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
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
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="text-xs">
            <p className="font-medium text-white truncate">{profile.displayName}</p>
            <p className="text-slate-400 truncate">{profile.email}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 rounded-md hover:bg-slate-700 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:bg-slate-100 rounded-md cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <span>GymOS SaaS Admin</span>
              <span>/</span>
              <span className="font-medium text-slate-900">{activeLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleOpenProductClick}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer whitespace-nowrap"
            >
              <span>{gyms.length > 0 ? 'Launch Gym Product' : 'Create & Open Gym Product'}</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
            <span className="hidden sm:inline text-xs font-medium text-slate-500">
              Platform Admin
            </span>
          </div>
        </header>

        <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
          {tab === 'overview' && (
            <PlatformOverview
              gyms={gyms}
              plans={plans}
              payments={payments}
              notifications={notifications}
              auditLogs={auditLogs}
              onNavigateTab={(next) => setTab(next as AdminTab)}
              onLaunchGymProduct={handleOpenProductClick}
              onOpenSpecificGym={(gymId) => enterGymWorkspace(gymId)}
            />
          )}
          {tab === 'gyms' && (
            <GymsManagement
              actor={actor}
              gyms={gyms}
              plans={plans}
              payments={payments}
              auditLogs={auditLogs}
              onOpenGymWorkspace={(gymId) => enterGymWorkspace(gymId)}
            />
          )}
          {tab === 'plans' && <SubscriptionPlansView actor={actor} plans={plans} />}
          {tab === 'payments' && (
            <SubscriptionPaymentsView
              actor={actor}
              gyms={gyms}
              plans={plans}
              payments={payments}
            />
          )}
          {tab === 'settings' && (
            <PlatformSettingsView
              actor={actor}
              settings={platformSettings}
              platformAdmins={platformAdmins}
            />
          )}
          {tab === 'audit' && <AuditLogsView logs={auditLogs} />}
        </main>
      </div>

      {/* Quick Create & Open First Gym Product Modal */}
      <Modal
        open={showQuickLaunch}
        title="Create & Open Gym Workspace"
        subtitle="Set up a gym workspace and open its operations dashboard"
        onClose={() => setShowQuickLaunch(false)}
      >
        <form onSubmit={handleQuickCreateAndOpen} className="space-y-4">
          {launchError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
              {launchError}
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Gym Name *
            </label>
            <input
              type="text"
              required
              minLength={2}
              value={launchName}
              onChange={(e) => setLaunchName(e.target.value)}
              placeholder="e.g. Apex Strength Studio"
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Contact Phone *
            </label>
            <input
              type="tel"
              required
              minLength={5}
              value={launchPhone}
              onChange={(e) => setLaunchPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Facility Address (Optional)
            </label>
            <input
              type="text"
              value={launchAddress}
              onChange={(e) => setLaunchAddress(e.target.value)}
              placeholder="Street, city"
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowQuickLaunch(false)}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={launching}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
            >
              {launching ? 'Creating Workspace...' : 'Create & Open Gym App'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
