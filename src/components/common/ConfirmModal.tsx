import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'primary';
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  defaultReason?: string;
  onConfirm: (reason?: string) => void | Promise<void>;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonPlaceholder = 'Enter reason...',
  defaultReason = '',
  onConfirm,
  onCancel,
}) => {
  const [reason, setReason] = useState(defaultReason);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const btnColors =
    variant === 'danger'
      ? 'bg-red-700 hover:bg-red-800 text-white'
      : variant === 'warning'
        ? 'bg-amber-600 hover:bg-amber-700 text-white'
        : 'bg-teal-700 hover:bg-teal-800 text-white';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (requireReason && !reason.trim()) return;
    setSubmitting(true);
    try {
      await onConfirm(requireReason ? reason.trim() : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`p-2 rounded-md shrink-0 ${
                variant === 'danger'
                  ? 'bg-red-50 text-red-700'
                  : variant === 'warning'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-teal-50 text-teal-700'
              }`}
            >
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">{description}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {requireReason && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {reasonLabel} *
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={250}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reasonPlaceholder}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={submitting}
              onClick={onCancel}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              disabled={submitting || (requireReason && !reason.trim())}
              className={`px-3.5 py-2 text-xs font-medium rounded-md disabled:opacity-50 cursor-pointer ${btnColors}`}
            >
              {submitting ? 'Processing...' : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
