import React from 'react';
import { Shield, ArrowRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

export const AdminAuthScreen: React.FC = () => {
  const { signInWithGoogle, authError } = useAuth();

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-lg font-bold tracking-tight text-white font-display">
              GymOS
            </span>
            <span className="text-xs font-medium text-slate-400 border-l border-slate-700 pl-2.5">
              Platform Administration
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-lg p-8 space-y-6">
          <div className="space-y-2">
            <div className="w-10 h-10 rounded-md bg-teal-950 border border-teal-800 flex items-center justify-center text-teal-400">
              <Shield className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-semibold text-white">
              Admin Sign In
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              Sign in with an authorized administrator account to manage gyms, subscription plans, billing, and platform settings.
            </p>
          </div>

          {authError && (
            <div className="p-3 border border-red-900 bg-red-950/60 rounded-md text-xs text-red-300">
              {authError}
            </div>
          )}

          <button
            type="button"
            onClick={signInWithGoogle}
            className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-2.5 text-sm font-medium text-white bg-teal-700 rounded-md hover:bg-teal-600 transition-colors cursor-pointer"
          >
            <span>Continue with Google</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <p className="text-[11px] text-slate-500 border-t border-slate-800 pt-4">
            Restricted to authorized GymOS platform administrators.
          </p>
        </div>
      </main>
    </div>
  );
};
