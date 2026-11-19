import React from 'react';
import { ShieldCheck, Building2, CreditCard, BellRing, ArrowRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

export const GymAuthScreen: React.FC = () => {
  const { signInWithGoogle, authError } = useAuth();

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <span className="text-lg font-bold tracking-tight text-slate-900 font-display whitespace-nowrap shrink-0">
            GymOS
          </span>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a href="#features" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Features
            </a>
            <a href="#payments" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Cash &amp; UPI Receipts
            </a>
            <a href="#team" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Team Access
            </a>
          </nav>
          <button
            type="button"
            onClick={signInWithGoogle}
            className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Gym Sign In
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-7 flex flex-col justify-center space-y-6">
            <div className="space-y-3">
              <p className="text-xs font-medium text-teal-700 tracking-wide">
                Gym Management Software for Fitness Centers &amp; Studios
              </p>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 leading-tight [text-wrap:balance]">
                Run your gym members, renewals, Cash &amp; UPI receipts, and staff in one workspace
              </h1>
              <p className="text-base text-slate-600 leading-relaxed max-w-xl">
                Register members, manage membership plans, confirm Cash and UPI payments with instant printable receipts, automate expiry reminders, and track daily &amp; monthly revenue.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2" id="features">
              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center gap-2 text-slate-900 font-medium text-sm">
                  <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>Members &amp; Plans</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Track active, expiring, and expired members, CSV bulk imports, renewals, upgrades, and grace periods.
                </p>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1.5" id="payments">
                <div className="flex items-center gap-2 text-slate-900 font-medium text-sm">
                  <CreditCard className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>Cash &amp; UPI Receipts</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Record and confirm Cash or UPI payments with balance tracking, UTR reference checks, and printable receipts.
                </p>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1.5" id="team">
                <div className="flex items-center gap-2 text-slate-900 font-medium text-sm">
                  <Building2 className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>Staff Roles &amp; Reports</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Invite managers and front-desk receptionists with granular permissions plus daily and monthly revenue exports.
                </p>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center gap-2 text-slate-900 font-medium text-sm">
                  <BellRing className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>Expiry Reminders</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Configure renewal reminder schedules with member opt-out respect and delivery status logs.
                </p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 flex items-center">
            <div className="w-full bg-white border border-slate-200 rounded-lg p-8 space-y-6">
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold text-slate-900">
                  Gym Owner &amp; Staff Sign In
                </h2>
                <p className="text-sm text-slate-600">
                  Sign in with your Google account to open your gym dashboard, register a new gym, or accept a staff invitation.
                </p>
              </div>

              {authError && (
                <div className="p-3 border border-red-200 bg-red-50 rounded-md text-xs text-red-700">
                  {authError}
                </div>
              )}

              <button
                type="button"
                onClick={signInWithGoogle}
                className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <span>Continue with Google</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <div className="border-t border-slate-200 pt-5 space-y-1 text-xs text-slate-500">
                <p className="font-medium text-slate-700">Gym Workspace Access</p>
                <p>Gym Owners · Managers · Front-Desk Staff</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
