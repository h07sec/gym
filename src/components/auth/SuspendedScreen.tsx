import React, { useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { Lock, LogOut, Mail, Phone, CreditCard } from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { SubscriptionPayment, UserRole } from '../../types/gymos';
import { formatCurrency, formatDisplayDate } from '../../lib/utils';
import { StatusLabel } from '../common/StatusBadge';

export const SuspendedScreen: React.FC = () => {
  const { gym, profile, subscriptionAccess, platformSettings, signOut } = useAuth();
  const [payments, setPayments] = useState<SubscriptionPayment[]>([]);
  const [showBilling, setShowBilling] = useState(false);

  const isOwner = profile?.role === UserRole.GYM_OWNER;

  useEffect(() => {
    if (!isOwner || !gym) return;
    const loadPayments = async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, 'subscription_payments'),
            where('ownerUid', '==', gym.ownerUid)
          )
        );
        setPayments(snap.docs.map((d) => d.data() as SubscriptionPayment));
      } catch (err) {
        console.error('Could not load subscription payment history:', err);
      }
    };
    loadPayments();
  }, [isOwner, gym]);

  const reason = subscriptionAccess?.reason || 'SUSPENDED';
  const heading =
    reason === 'PENDING_VERIFICATION'
      ? 'Your GymOS subscription is awaiting activation.'
      : reason === 'EXPIRED'
        ? 'Your GymOS subscription has expired.'
        : reason === 'CANCELLED'
          ? 'Your GymOS subscription has been cancelled.'
          : 'Your GymOS account has been paused.';

  const description =
    reason === 'PENDING_VERIFICATION'
      ? 'Complete your manual UPI or Cash subscription payment using the instructions below. Your workspace unlocks immediately after payment verification.'
      : reason === 'EXPIRED'
        ? `Your subscription period ended on ${formatDisplayDate(gym?.subscriptionEndAt)} (including grace period through ${formatDisplayDate(subscriptionAccess?.effectiveAccessUntil)}). Renew your plan to restore full workspace access.`
        : reason === 'CANCELLED'
          ? 'Your gym subscription is currently cancelled. All your member and payment data remains preserved—contact support to reactivate.'
          : 'Your gym account has been temporarily suspended. Please contact GymOS support to restore access.';

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 h-16 flex items-center justify-between">
        <span className="text-lg font-bold text-slate-900 font-display">GymOS</span>
        <button
          type="button"
          onClick={signOut}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-2xl w-full space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg p-8 space-y-6">
            <div className="flex items-start gap-4">
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-md text-red-700 shrink-0">
                <Lock className="w-5 h-5" />
              </div>
              <div className="space-y-2">
                <h1 className="text-xl font-semibold text-slate-900">{heading}</h1>
                <p className="text-sm text-slate-600 leading-relaxed">{description}</p>
                {gym?.suspensionReason && (
                  <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    Note: {gym.suspensionReason}
                  </p>
                )}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-slate-500">Gym Account</p>
                <p className="font-medium text-slate-900 mt-0.5">{gym?.name}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Account &amp; Subscription</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <StatusLabel status={gym?.accountStatus || 'SUSPENDED'} />
                  <StatusLabel status={gym?.subscriptionStatus || 'EXPIRED'} />
                </div>
              </div>
              <div>
                <p className="text-xs text-slate-500">Plan &amp; Expiry</p>
                <p className="font-mono text-slate-900 tabular-nums mt-0.5">
                  {gym?.subscriptionPlanName} · {formatDisplayDate(gym?.subscriptionEndAt)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Data Retention</p>
                <p className="text-xs text-slate-600 mt-0.5">
                  All member, payment, and historical records are preserved safely and will be available immediately upon reactivation.
                </p>
              </div>
            </div>

            {platformSettings && (
              <div className="border-t border-slate-200 pt-5 space-y-3">
                <p className="text-xs font-semibold text-slate-700">
                  Billing Support &amp; Renewal Instructions
                </p>
                <div className="flex flex-wrap gap-4 text-xs text-slate-600">
                  {platformSettings.supportEmail && (
                    <span className="inline-flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-slate-500" />
                      {platformSettings.supportEmail}
                    </span>
                  )}
                  {platformSettings.supportPhone && (
                    <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                      <Phone className="w-3.5 h-3.5 text-slate-500" />
                      {platformSettings.supportPhone}
                    </span>
                  )}
                  {platformSettings.upiId && (
                    <span className="inline-flex items-center gap-1.5 font-mono">
                      <CreditCard className="w-3.5 h-3.5 text-slate-500" />
                      UPI: {platformSettings.upiId}
                      {platformSettings.upiPayeeName ? ` (${platformSettings.upiPayeeName})` : ''}
                    </span>
                  )}
                </div>
                {platformSettings.paymentInstructions && (
                  <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3">
                    {platformSettings.paymentInstructions}
                  </p>
                )}
              </div>
            )}

            {isOwner && (
              <div className="border-t border-slate-200 pt-4 flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  Operational modules remain paused while subscription access is inactive.
                </span>
                <button
                  type="button"
                  onClick={() => setShowBilling((v) => !v)}
                  className="text-xs font-medium text-teal-700 hover:text-teal-800 cursor-pointer"
                >
                  {showBilling ? 'Hide billing history' : 'View subscription payment history'}
                </button>
              </div>
            )}
          </div>

          {isOwner && showBilling && (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200">
                <h2 className="text-sm font-semibold text-slate-900">
                  Subscription Payment History
                </h2>
              </div>
              {payments.length === 0 ? (
                <div className="p-6 text-xs text-slate-500">
                  No subscription payments have been recorded yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Payment Date</th>
                        <th className="px-4 py-2.5 font-medium">Plan</th>
                        <th className="px-4 py-2.5 font-medium">Mode</th>
                        <th className="px-4 py-2.5 font-medium">Period</th>
                        <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                        <th className="px-4 py-2.5 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {payments.map((p) => (
                        <tr key={p.id}>
                          <td className="px-4 py-3 font-mono tabular-nums">
                            {formatDisplayDate(p.paymentDate)}
                          </td>
                          <td className="px-4 py-3 text-slate-900">{p.planName}</td>
                          <td className="px-4 py-3 text-slate-600">{p.paymentMode}</td>
                          <td className="px-4 py-3 font-mono tabular-nums text-slate-600">
                            {p.periodStart} to {p.periodEnd}
                          </td>
                          <td className="px-4 py-3 font-mono tabular-nums text-right text-slate-900">
                            {formatCurrency(p.amount)}
                          </td>
                          <td className="px-4 py-3">
                            <StatusLabel status={p.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
