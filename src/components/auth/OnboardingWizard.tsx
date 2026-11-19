import React, { useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { Building2, CheckCircle2, LogOut, UserCheck } from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { SubscriptionPlan, StaffInvitation, UserRole } from '../../types/gymos';
import {
  acceptStaffInvitation,
  registerGymAsOwner,
} from '../../services/gymos-service';
import { formatCurrency } from '../../lib/utils';

export const OnboardingWizard: React.FC = () => {
  const {
    firebaseUser,
    pendingInvitations,
    platformSettings,
    signOut,
    refreshProfile,
  } = useAuth();

  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [gymName, setGymName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [ownerName, setOwnerName] = useState(firebaseUser?.displayName || '');
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [startMode, setStartMode] = useState<'TRIAL' | 'PENDING'>('TRIAL');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPlans = async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'subscription_plans'), where('isActive', '==', true))
        );
        const list = snap.docs
          .map((d) => d.data() as SubscriptionPlan)
          .sort((a, b) => a.price - b.price);
        setPlans(list);
        if (list.length > 0) setSelectedPlanId(list[0].id);
      } catch (err) {
        console.error('Failed to load subscription plans:', err);
      } finally {
        setLoadingPlans(false);
      }
    };
    loadPlans();
  }, []);

  const handleAcceptInvite = async (invitation: StaffInvitation) => {
    if (!firebaseUser?.email) return;
    setSubmitting(true);
    setError(null);
    try {
      await acceptStaffInvitation(invitation, {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName || invitation.fullName,
      });
      await refreshProfile();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to accept invitation.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegisterGym = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser?.email) return;
    const plan = plans.find((p) => p.id === selectedPlanId);
    if (!plan) {
      setError('Please select a subscription plan.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await registerGymAsOwner({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        ownerName: ownerName.trim(),
        gymName: gymName.trim(),
        phone: phone.trim(),
        address: address.trim(),
        plan,
        startMode,
      });
      await refreshProfile();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gym registration failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const allowPublic = platformSettings?.allowPublicRegistration ?? true;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 h-16 flex items-center justify-between">
        <span className="text-lg font-bold text-slate-900 font-display">GymOS Setup</span>
        <div className="flex items-center gap-4">
          <span className="text-xs text-slate-600">{firebaseUser?.email}</span>
          <button
            type="button"
            onClick={signOut}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-6 py-10 space-y-8">
        {pendingInvitations.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex items-center gap-2.5">
              <UserCheck className="w-5 h-5 text-teal-700" />
              <h2 className="text-base font-semibold text-slate-900">
                Pending Workspace Invitations
              </h2>
            </div>
            <p className="text-sm text-slate-600">
              You have been invited to join an existing gym workspace. Accept the invitation below to activate your account.
            </p>
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
                {error}
              </div>
            )}
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
              {pendingInvitations.map((inv) => (
                <div
                  key={inv.id}
                  className="p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">{inv.gymName}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Role:{' '}
                      {inv.role === UserRole.GYM_OWNER
                        ? 'Gym Owner'
                        : inv.roleTitle || inv.role.replace('GYM_', '')}{' '}
                      · Invited as {inv.fullName}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => handleAcceptInvite(inv)}
                    className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    {inv.role === UserRole.GYM_OWNER ? 'Claim Gym Workspace' : 'Accept Invitation'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {!allowPublic ? (
          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-2">
            <h2 className="text-base font-semibold text-slate-900">
              Self-registration is currently closed
            </h2>
            <p className="text-sm text-slate-600">
              Please contact GymOS support{platformSettings?.supportEmail ? ` (${platformSettings.supportEmail})` : ''} to provision your gym account or request an invitation.
            </p>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 pb-4">
              <div className="flex items-center gap-2.5">
                <Building2 className="w-5 h-5 text-teal-700" />
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">
                    Register Your Gym
                  </h2>
                  <p className="text-xs text-slate-500">
                    Step {step} of 3 ·{' '}
                    {step === 1
                      ? 'Gym Details'
                      : step === 2
                        ? 'Owner Details'
                        : 'Plan Selection'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                <span className={step >= 1 ? 'text-teal-700 font-semibold' : ''}>01</span>
                <span>/</span>
                <span className={step >= 2 ? 'text-teal-700 font-semibold' : ''}>02</span>
                <span>/</span>
                <span className={step >= 3 ? 'text-teal-700 font-semibold' : ''}>03</span>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
                {error}
              </div>
            )}

            <form onSubmit={handleRegisterGym} className="space-y-5">
              {step === 1 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Gym Name *
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      maxLength={120}
                      value={gymName}
                      onChange={(e) => setGymName(e.target.value)}
                      placeholder="e.g. Apex Fitness Studio"
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Gym Phone Number *
                    </label>
                    <input
                      type="tel"
                      required
                      minLength={5}
                      maxLength={40}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="Phone number"
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Facility Address
                    </label>
                    <input
                      type="text"
                      maxLength={300}
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="Street, city, postal code"
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700"
                    />
                  </div>
                  <div className="flex justify-end pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (gymName.trim().length < 2 || phone.trim().length < 5) {
                          setError('Enter a valid gym name and phone number.');
                          return;
                        }
                        setError(null);
                        setStep(2);
                      }}
                      className="px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
                    >
                      Continue to Owner Details
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Owner Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      maxLength={120}
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Account Email
                    </label>
                    <input
                      type="email"
                      disabled
                      value={firebaseUser?.email || ''}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50 text-slate-500"
                    />
                  </div>
                  <div className="flex items-center justify-between pt-2">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (ownerName.trim().length < 2) {
                          setError('Enter the owner full name.');
                          return;
                        }
                        setError(null);
                        setStep(3);
                      }}
                      className="px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 cursor-pointer"
                    >
                      Continue to Plan Selection
                    </button>
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-5">
                  {loadingPlans ? (
                    <p className="text-sm text-slate-500">Loading available plans...</p>
                  ) : plans.length === 0 ? (
                    <div className="p-4 border border-amber-200 bg-amber-50 rounded-md text-xs text-amber-800">
                      Subscription plans are currently unavailable. Please contact support to activate your gym account.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {plans.map((plan) => {
                        const selected = plan.id === selectedPlanId;
                        return (
                          <button
                            type="button"
                            key={plan.id}
                            onClick={() => setSelectedPlanId(plan.id)}
                            className={`text-left p-4 rounded-lg border transition-colors cursor-pointer ${
                              selected
                                ? 'border-teal-700 bg-teal-50/40'
                                : 'border-slate-200 bg-white hover:border-slate-300'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-semibold text-slate-900">
                                {plan.name}
                              </span>
                              {selected && (
                                <CheckCircle2 className="w-4 h-4 text-teal-700 shrink-0" />
                              )}
                            </div>
                            <p className="text-lg font-mono font-bold text-slate-900 tabular-nums mt-1">
                              {formatCurrency(plan.price, plan.currency)}
                              <span className="text-xs font-sans font-normal text-slate-500">
                                {' '}
                                / {plan.billingDurationMonths}{' '}
                                {plan.billingDurationMonths === 1 ? 'month' : 'months'}
                              </span>
                            </p>
                            <p className="text-xs text-slate-500 mt-1">
                              Up to {plan.maxStaff} staff · {plan.maxMembers} members · {plan.trialDays}-day trial
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-slate-700">
                      Activation Option
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setStartMode('TRIAL')}
                        className={`p-3 text-left rounded-md border text-xs cursor-pointer ${
                          startMode === 'TRIAL'
                            ? 'border-teal-700 bg-teal-50/40 text-slate-900'
                            : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        <p className="font-semibold">Start Free Trial</p>
                        <p className="text-slate-500 mt-0.5">
                          Start with full workspace access during your trial period.
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setStartMode('PENDING')}
                        className={`p-3 text-left rounded-md border text-xs cursor-pointer ${
                          startMode === 'PENDING'
                            ? 'border-teal-700 bg-teal-50/40 text-slate-900'
                            : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        <p className="font-semibold">Request Plan Activation</p>
                        <p className="text-slate-500 mt-0.5">
                          Complete payment via UPI or Cash and await account verification.
                        </p>
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      type="button"
                      onClick={() => setStep(2)}
                      className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={submitting || plans.length === 0}
                      className="px-5 py-2 text-sm font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
                    >
                      {submitting ? 'Setting Up Your Gym...' : 'Complete Gym Setup'}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        )}
      </main>
    </div>
  );
};
