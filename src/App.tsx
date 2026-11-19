import React, { useEffect, useState } from 'react';
import { ArrowLeft, Building2, KeyRound, ShieldAlert } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { GymAuthScreen } from './components/auth/GymAuthScreen';
import { AdminAuthScreen } from './components/auth/AdminAuthScreen';
import { OnboardingWizard } from './components/auth/OnboardingWizard';
import { SuspendedScreen } from './components/auth/SuspendedScreen';
import { SuperAdminShell } from './components/super-admin/SuperAdminShell';
import { GymShell } from './components/gym/GymShell';
import { UserRole, UserStatus } from './types/gymos';
import {
  fetchServerNotificationCapabilities,
  type ServerCapabilities,
} from './services/gymos-service';

function checkIsAdminRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname;
  return (
    path === '/admin' ||
    path.startsWith('/admin/') ||
    window.location.hash === '#/admin'
  );
}

const AdminWorkspaceBanner: React.FC<{ onReturnToAdmin: () => void }> = ({
  onReturnToAdmin,
}) => {
  const { gym, availableGyms, enterGymWorkspace, exitGymWorkspace } = useAuth();
  if (!gym) return null;

  return (
    <div className="no-print bg-slate-900 text-slate-200 px-4 sm:px-6 py-2 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2.5">
        <Building2 className="w-4 h-4 text-teal-400 shrink-0" />
        <span>
          <strong className="text-white">Active Gym:</strong>{' '}
          <span className="font-semibold text-teal-300">{gym.name}</span>
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        {availableGyms.length > 1 && (
          <select
            value={gym.id}
            onChange={(e) => enterGymWorkspace(e.target.value)}
            aria-label="Switch gym"
            className="px-2.5 py-1 text-xs bg-slate-800 border border-slate-700 text-white rounded cursor-pointer"
          >
            {availableGyms.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.accountStatus} / {g.subscriptionStatus})
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => {
            exitGymWorkspace();
            onReturnToAdmin();
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-teal-700 text-white rounded hover:bg-teal-600 cursor-pointer whitespace-nowrap"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Admin
        </button>
      </div>
    </div>
  );
};

const AdminAccessGate: React.FC<{
  onGoToGymPortal: () => void;
}> = ({ onGoToGymPortal }) => {
  const { firebaseUser, signOut, refreshProfile } = useAuth();
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    fetchServerNotificationCapabilities().then(setCapabilities);
  }, []);

  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !bootstrapToken.trim()) return;
    setBootstrapping(true);
    setBootstrapError(null);
    try {
      const idToken = await firebaseUser.getIdToken();
      const resp = await fetch('/api/admin/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          bootstrapToken: bootstrapToken.trim(),
          displayName: firebaseUser.displayName || undefined,
        }),
      });
      const json = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!resp.ok || !json.ok) {
        setBootstrapError(json.error || `Bootstrap failed (HTTP ${resp.status}).`);
        return;
      }
      await refreshProfile();
    } catch (err) {
      setBootstrapError(err instanceof Error ? err.message : 'Bootstrap request failed.');
    } finally {
      setBootstrapping(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-lg p-7 space-y-5">
        <div className="flex items-center gap-3 text-red-400">
          <ShieldAlert className="w-5 h-5 shrink-0" />
          <h1 className="text-base font-semibold text-white">
            Administrator Access Required
          </h1>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          Signed in as <span className="text-slate-200">{firebaseUser?.email}</span>. This console is restricted to authorized GymOS platform administrators.
        </p>

        {capabilities?.adminBootstrapConfigured && (
          <form
            onSubmit={handleBootstrap}
            className="border-t border-slate-800 pt-4 space-y-3"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-teal-400">
              <KeyRound className="w-4 h-4" />
              <span>Initial Platform Admin Activation</span>
            </div>
            {bootstrapError && (
              <div className="p-2.5 bg-red-950/60 border border-red-900 rounded text-xs text-red-300">
                {bootstrapError}
              </div>
            )}
            <input
              type="password"
              required
              value={bootstrapToken}
              onChange={(e) => setBootstrapToken(e.target.value)}
              placeholder="Enter server bootstrap token"
              className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-700 text-white rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
            <button
              type="submit"
              disabled={bootstrapping}
              className="w-full px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-600 disabled:opacity-50 cursor-pointer"
            >
              {bootstrapping ? 'Activating Super Admin...' : 'Initialize Platform Admin'}
            </button>
          </form>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-800">
          <button
            type="button"
            onClick={onGoToGymPortal}
            className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-600 cursor-pointer"
          >
            Go to Gym Portal
          </button>
          <button
            type="button"
            onClick={signOut}
            className="px-4 py-2 text-xs font-medium text-slate-300 border border-slate-700 rounded-md hover:bg-slate-800 cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
};

const GymOSRouter: React.FC = () => {
  const {
    firebaseUser,
    profile,
    gym,
    subscriptionAccess,
    availableGyms,
    superAdminGymId,
    staffRecord,
    loading,
    enterGymWorkspace,
    signOut,
  } = useAuth();

  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(checkIsAdminRoute);

  useEffect(() => {
    const syncRoute = () => setIsAdminRoute(checkIsAdminRoute());
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('hashchange', syncRoute);
    };
  }, []);

  const navigateTo = (path: string) => {
    if (window.location.pathname !== path || window.location.hash) {
      window.history.pushState(null, '', path);
      setIsAdminRoute(checkIsAdminRoute());
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-6 h-6 border-2 border-teal-700 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-slate-500">Loading GymOS...</p>
        </div>
      </div>
    );
  }

  if (!firebaseUser) {
    return isAdminRoute ? <AdminAuthScreen /> : <GymAuthScreen />;
  }

  if (isAdminRoute) {
    if (profile?.role !== UserRole.SUPER_ADMIN || profile?.status !== UserStatus.ACTIVE) {
      return <AdminAccessGate onGoToGymPortal={() => navigateTo('/')} />;
    }

    if (superAdminGymId && gym) {
      return (
        <div className="min-h-screen flex flex-col">
          <AdminWorkspaceBanner onReturnToAdmin={() => navigateTo('/admin')} />
          <div className="flex-1 flex flex-col">
            {subscriptionAccess?.isLocked ? <SuspendedScreen /> : <GymShell />}
          </div>
        </div>
      );
    }

    return <SuperAdminShell />;
  }

  if (!profile) {
    return <OnboardingWizard />;
  }

  const isStaffDeactivated =
    profile.status === UserStatus.DEACTIVATED ||
    (profile.role !== UserRole.SUPER_ADMIN &&
      profile.role !== UserRole.GYM_OWNER &&
      staffRecord !== null &&
      staffRecord.status === UserStatus.DEACTIVATED);

  if (isStaffDeactivated) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <h1 className="text-base font-semibold text-slate-900">
            Staff Account Deactivated
          </h1>
          <p className="text-xs text-slate-600 leading-relaxed">
            Your staff access has been deactivated by your gym owner. Contact your gym administrator to restore your access.
          </p>
          <button
            type="button"
            onClick={signOut}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (profile.role === UserRole.SUPER_ADMIN) {
    if (superAdminGymId && gym) {
      return (
        <div className="min-h-screen flex flex-col">
          <AdminWorkspaceBanner onReturnToAdmin={() => navigateTo('/admin')} />
          <div className="flex-1 flex flex-col">
            {subscriptionAccess?.isLocked ? <SuspendedScreen /> : <GymShell />}
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-7 space-y-5">
          <div className="space-y-1">
            <h1 className="text-base font-semibold text-slate-900">
              Select Workspace
            </h1>
            <p className="text-xs text-slate-600">
              Choose a gym workspace to open or switch to the Platform Admin console.
            </p>
          </div>
          {availableGyms.length > 0 && (
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {availableGyms.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => enterGymWorkspace(g.id)}
                  className="w-full text-left px-3.5 py-2.5 border border-slate-200 rounded-md hover:border-teal-700 hover:bg-teal-50/30 flex items-center justify-between text-xs cursor-pointer"
                >
                  <span className="font-medium text-slate-900">{g.name}</span>
                  <span className="text-slate-500">
                    {g.accountStatus} · {g.subscriptionStatus}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={() => navigateTo('/admin')}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 cursor-pointer"
            >
              Open Admin Console
            </button>
            <button
              type="button"
              onClick={signOut}
              className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!gym) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
        <p className="text-xs text-slate-500">Loading gym workspace...</p>
      </div>
    );
  }

  if (subscriptionAccess?.isLocked) {
    return <SuspendedScreen />;
  }

  return <GymShell />;
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <GymOSRouter />
      </AuthProvider>
    </ErrorBoundary>
  );
}
