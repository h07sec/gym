import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { auth, db, googleAuthProvider } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-error';
import {
  Gym,
  GymStaff,
  PlatformSettings,
  StaffInvitation,
  StaffPermissions,
  UserProfile,
  UserRole,
  UserStatus,
} from '../types/gymos';
import { ensurePlatformDefaults } from '../services/gymos-service';
import {
  evaluateGymSubscriptionAccess,
  type SubscriptionAccessState,
} from '../lib/domain/subscription';
import { toIsoDate } from '../lib/utils';

const ADMIN_ACTIVE_GYM_STORAGE_KEY = 'gymos_admin_active_gym_id';

const DEFAULT_PERMISSIONS: StaffPermissions = {
  canViewReports: false,
  canViewPayments: false,
  canRecordPayments: false,
  canManagePlans: false,
  canConfirmPayments: false,
  canDeleteMembers: false,
  canManageReminders: false,
  canManageAttendance: false,
};

const FULL_PERMISSIONS: StaffPermissions = {
  canViewReports: true,
  canViewPayments: true,
  canRecordPayments: true,
  canManagePlans: true,
  canConfirmPayments: true,
  canDeleteMembers: true,
  canManageReminders: true,
  canManageAttendance: true,
};

interface AuthContextValue {
  firebaseUser: User | null;
  profile: UserProfile | null;
  gym: Gym | null;
  subscriptionAccess: SubscriptionAccessState | null;
  availableGyms: Gym[];
  superAdminGymId: string | null;
  staffRecord: GymStaff | null;
  platformSettings: PlatformSettings | null;
  pendingInvitations: StaffInvitation[];
  loading: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  enterGymWorkspace: (gymId: string) => void;
  exitGymWorkspace: () => void;
  effectivePermissions: StaffPermissions;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [gym, setGym] = useState<Gym | null>(null);
  const [availableGyms, setAvailableGyms] = useState<Gym[]>([]);
  const [superAdminGymId, setSuperAdminGymId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ADMIN_ACTIVE_GYM_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [staffRecord, setStaffRecord] = useState<GymStaff | null>(null);
  const [platformSettings, setPlatformSettings] = useState<PlatformSettings | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<StaffInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const loadInvitationsForUser = async (user: User) => {
    if (!user.email) {
      setPendingInvitations([]);
      return;
    }
    try {
      const invQuery = query(
        collection(db, 'invitations'),
        where('email', '==', user.email.toLowerCase())
      );
      const invSnap = await getDocs(invQuery);
      setPendingInvitations(
        invSnap.docs
          .map((d) => d.data() as StaffInvitation)
          .filter((inv) => inv.status === 'PENDING')
      );
    } catch {
      setPendingInvitations([]);
    }
  };

  const syncUserAccount = async (user: User) => {
    try {
      setAuthError(null);
      const userRef = doc(db, 'users', user.uid);
      let userSnap = await getDoc(userRef);

      // Check authorized platform_admins registry (created via CLI, bootstrap endpoint, or existing Super Admin)
      if (!userSnap.exists() && user.email && user.emailVerified) {
        try {
          const adminSnap = await getDoc(doc(db, 'platform_admins', user.uid));
          if (adminSnap.exists()) {
            const adminEmail = user.email.toLowerCase();
            const adminName = user.displayName || adminEmail.split('@')[0] || 'Platform Admin';
            await setDoc(userRef, {
              uid: user.uid,
              email: adminEmail,
              displayName: adminName,
              role: UserRole.SUPER_ADMIN,
              status: UserStatus.ACTIVE,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            userSnap = await getDoc(userRef);
          }
        } catch {
          // Not a registered platform admin; proceed with standard tenant flow
        }
      }

      if (userSnap.exists()) {
        const userData = userSnap.data() as UserProfile;
        setProfile(userData);
        setPendingInvitations([]);

        if (userData.role === UserRole.SUPER_ADMIN && userData.status === UserStatus.ACTIVE) {
          await ensurePlatformDefaults({
            uid: userData.uid,
            email: userData.email,
            displayName: userData.displayName,
            role: UserRole.SUPER_ADMIN,
          });
        }
      } else {
        setProfile(null);
        await loadInvitationsForUser(user);
      }
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : 'Unable to load account workspace.'
      );
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setGym(null);
        setAvailableGyms([]);
        setStaffRecord(null);
        setPendingInvitations([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      await syncUserAccount(user);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Real-time listener on users/{uid} so role/status deactivation takes effect immediately
  useEffect(() => {
    if (!firebaseUser) return;
    const unsub = onSnapshot(
      doc(db, 'users', firebaseUser.uid),
      (snap) => {
        if (snap.exists()) {
          setProfile(snap.data() as UserProfile);
          setPendingInvitations([]);
        }
      },
      () => {}
    );
    return () => unsub();
  }, [firebaseUser]);

  // Subscribe to platform_settings/default when signed in
  useEffect(() => {
    if (!firebaseUser) {
      setPlatformSettings(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, 'platform_settings', 'default'),
      (snap) => {
        if (snap.exists()) {
          setPlatformSettings(snap.data() as PlatformSettings);
        }
      },
      () => {}
    );
    return () => unsub();
  }, [firebaseUser]);

  // Subscribe to all gyms for SUPER_ADMIN workspace switching
  useEffect(() => {
    if (!firebaseUser || profile?.role !== UserRole.SUPER_ADMIN || profile?.status !== UserStatus.ACTIVE) {
      setAvailableGyms([]);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, 'gyms'), orderBy('createdAt', 'desc')),
      (snap) => {
        const list = snap.docs.map((d) => d.data() as Gym);
        setAvailableGyms(list);
        if (superAdminGymId && !list.some((g) => g.id === superAdminGymId)) {
          setSuperAdminGymId(null);
          try {
            sessionStorage.removeItem(ADMIN_ACTIVE_GYM_STORAGE_KEY);
          } catch {
            // ignore storage errors
          }
        }
      },
      () => {}
    );
    return () => unsub();
  }, [firebaseUser, profile?.role, profile?.status, superAdminGymId]);

  const effectiveGymId =
    profile?.role === UserRole.SUPER_ADMIN ? superAdminGymId : profile?.gymId ?? null;

  // Subscribe to tenant gym document & staff permissions (live revocation on staff doc)
  useEffect(() => {
    if (!firebaseUser || !effectiveGymId || profile?.status === UserStatus.DEACTIVATED) {
      setGym(null);
      setStaffRecord(null);
      return;
    }

    const unsubGym = onSnapshot(
      doc(db, 'gyms', effectiveGymId),
      (snap) => {
        if (snap.exists()) {
          setGym(snap.data() as Gym);
        } else {
          setGym(null);
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, `gyms/${effectiveGymId}`);
      }
    );

    const unsubStaff =
      profile?.role === UserRole.SUPER_ADMIN
        ? () => {}
        : onSnapshot(
            doc(db, 'gyms', effectiveGymId, 'staff', firebaseUser.uid),
            (snap) => {
              if (snap.exists()) {
                setStaffRecord(snap.data() as GymStaff);
              } else {
                setStaffRecord(null);
              }
            },
            () => {
              setStaffRecord(null);
            }
          );

    return () => {
      unsubGym();
      unsubStaff();
    };
  }, [firebaseUser, effectiveGymId, profile?.role, profile?.status]);

  const enterGymWorkspace = (gymId: string) => {
    if (profile?.role !== UserRole.SUPER_ADMIN) return;
    setSuperAdminGymId(gymId);
    try {
      sessionStorage.setItem(ADMIN_ACTIVE_GYM_STORAGE_KEY, gymId);
    } catch {
      // ignore storage errors
    }
  };

  const exitGymWorkspace = () => {
    setSuperAdminGymId(null);
    setGym(null);
    try {
      sessionStorage.removeItem(ADMIN_ACTIVE_GYM_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  };

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : 'Sign-in cancelled or failed.'
      );
    }
  };

  const signOut = async () => {
    exitGymWorkspace();
    await firebaseSignOut(auth);
  };

  const refreshProfile = async () => {
    if (firebaseUser) {
      await syncUserAccount(firebaseUser);
    }
  };

  const subscriptionAccess: SubscriptionAccessState | null = gym
    ? evaluateGymSubscriptionAccess(gym, toIsoDate())
    : null;

  const isStaffActive =
    profile?.role === UserRole.GYM_OWNER ||
    profile?.role === UserRole.SUPER_ADMIN ||
    staffRecord?.status === UserStatus.ACTIVE;

  const effectivePermissions: StaffPermissions =
    profile?.role === UserRole.GYM_OWNER || profile?.role === UserRole.SUPER_ADMIN
      ? FULL_PERMISSIONS
      : !isStaffActive || !staffRecord
        ? DEFAULT_PERMISSIONS
        : {
            canViewReports: Boolean(staffRecord.permissions?.canViewReports),
            canViewPayments:
              staffRecord.permissions?.canViewPayments ??
              profile?.role !== UserRole.GYM_TRAINER,
            canRecordPayments:
              staffRecord.permissions?.canRecordPayments ??
              profile?.role !== UserRole.GYM_TRAINER,
            canManagePlans: Boolean(staffRecord.permissions?.canManagePlans),
            canConfirmPayments: Boolean(staffRecord.permissions?.canConfirmPayments),
            canDeleteMembers: Boolean(staffRecord.permissions?.canDeleteMembers),
            canManageReminders: Boolean(staffRecord.permissions?.canManageReminders),
            canManageAttendance: staffRecord.permissions?.canManageAttendance ?? true,
          };

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        profile,
        gym,
        subscriptionAccess,
        availableGyms,
        superAdminGymId,
        staffRecord,
        platformSettings,
        pendingInvitations,
        loading,
        authError,
        signInWithGoogle,
        signOut,
        refreshProfile,
        enterGymWorkspace,
        exitGymWorkspace,
        effectivePermissions,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
