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

const BOOTSTRAP_SUPER_ADMIN_EMAIL = 'iybmickey@gmail.com';
const ADMIN_ACTIVE_GYM_STORAGE_KEY = 'gymos_admin_active_gym_id';

const DEFAULT_PERMISSIONS: StaffPermissions = {
  canViewReports: false,
  canManagePlans: false,
  canConfirmPayments: false,
  canDeleteMembers: false,
  canManageReminders: false,
};

interface AuthContextValue {
  firebaseUser: User | null;
  profile: UserProfile | null;
  gym: Gym | null;
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

  const loadUserWorkspace = async (user: User) => {
    try {
      setAuthError(null);
      const userRef = doc(db, 'users', user.uid);
      let userSnap = await getDoc(userRef);

      // Bootstrap Super Admin automatically on verified owner email login
      if (
        !userSnap.exists() &&
        user.email?.toLowerCase() === BOOTSTRAP_SUPER_ADMIN_EMAIL &&
        user.emailVerified
      ) {
        const adminRef = doc(db, 'platform_admins', user.uid);
        await setDoc(adminRef, {
          uid: user.uid,
          email: user.email.toLowerCase(),
          displayName: user.displayName || 'Platform Owner',
          createdAt: serverTimestamp(),
        });
        await setDoc(userRef, {
          uid: user.uid,
          email: user.email.toLowerCase(),
          displayName: user.displayName || 'Platform Owner',
          role: UserRole.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await ensurePlatformDefaults({
          uid: user.uid,
          email: user.email.toLowerCase(),
          displayName: user.displayName || 'Platform Owner',
          role: UserRole.SUPER_ADMIN,
        });
        userSnap = await getDoc(userRef);
      }

      if (userSnap.exists()) {
        const userData = userSnap.data() as UserProfile;
        setProfile(userData);
        setPendingInvitations([]);

        if (userData.role === UserRole.SUPER_ADMIN) {
          await ensurePlatformDefaults({
            uid: userData.uid,
            email: userData.email,
            displayName: userData.displayName,
            role: UserRole.SUPER_ADMIN,
          });
        }
      } else {
        setProfile(null);
        // Check if this email has pending staff invitations
        if (user.email) {
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
        }
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
      await loadUserWorkspace(user);
      setLoading(false);
    });
    return () => unsub();
  }, []);

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
      (error) => {
        console.warn('Platform settings listener:', error.message);
      }
    );
    return () => unsub();
  }, [firebaseUser]);

  // Subscribe to all gyms for SUPER_ADMIN workspace switching
  useEffect(() => {
    if (!firebaseUser || profile?.role !== UserRole.SUPER_ADMIN) {
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
  }, [firebaseUser, profile?.role, superAdminGymId]);

  const effectiveGymId =
    profile?.role === UserRole.SUPER_ADMIN ? superAdminGymId : profile?.gymId ?? null;

  // Subscribe to tenant gym document & staff permissions
  useEffect(() => {
    if (!firebaseUser || !effectiveGymId) {
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
              // Staff doc is inaccessible when gym is SUSPENDED; handled by suspended lock screen
              setStaffRecord(null);
            }
          );

    return () => {
      unsubGym();
      unsubStaff();
    };
  }, [firebaseUser, effectiveGymId, profile?.role]);

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
      await loadUserWorkspace(firebaseUser);
    }
  };

  const effectivePermissions: StaffPermissions =
    profile?.role === UserRole.GYM_OWNER || profile?.role === UserRole.SUPER_ADMIN
      ? {
          canViewReports: true,
          canManagePlans: true,
          canConfirmPayments: true,
          canDeleteMembers: true,
          canManageReminders: true,
        }
      : staffRecord?.permissions ?? DEFAULT_PERMISSIONS;

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        profile,
        gym,
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
