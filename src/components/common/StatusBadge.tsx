import React from 'react';
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  XCircle,
  PauseCircle,
} from 'lucide-react';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_MAP: Record<Tone, { text: string; icon: React.ReactNode }> = {
  success: {
    text: 'text-emerald-700',
    icon: <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />,
  },
  warning: {
    text: 'text-amber-700',
    icon: <Clock className="w-3.5 h-3.5 shrink-0" />,
  },
  danger: {
    text: 'text-red-700',
    icon: <XCircle className="w-3.5 h-3.5 shrink-0" />,
  },
  neutral: {
    text: 'text-slate-600',
    icon: <AlertCircle className="w-3.5 h-3.5 shrink-0" />,
  },
};

export function resolveStatusTone(status: string): Tone {
  const s = status.toUpperCase();
  if (['ACTIVE', 'CONFIRMED', 'VERIFIED', 'SENT', 'ACCEPTED', 'PAID'].includes(s)) {
    return 'success';
  }
  if (
    [
      'TRIAL',
      'PENDING',
      'EXPIRING_SOON',
      'RECORDED',
      'RETRY_SCHEDULED',
      'PARTIALLY_PAID',
      'PENDING_VERIFICATION',
    ].includes(s)
  ) {
    return 'warning';
  }
  if (
    [
      'SUSPENDED',
      'EXPIRED',
      'REJECTED',
      'FAILED',
      'CANCELLED',
      'DEACTIVATED',
      'REVOKED',
      'OVERDUE',
      'UNPAID',
    ].includes(s)
  ) {
    return 'danger';
  }
  return 'neutral';
}

export const StatusLabel: React.FC<{ status: string; label?: string }> = ({
  status,
  label,
}) => {
  const tone = resolveStatusTone(status);
  const style = TONE_MAP[tone];
  const formatted = label ?? status.replace(/_/g, ' ');
  const Icon =
    status.toUpperCase() === 'SUSPENDED' ? (
      <PauseCircle className="w-3.5 h-3.5 shrink-0" />
    ) : (
      style.icon
    );

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${style.text}`}
    >
      {Icon}
      <span className="capitalize">{formatted.toLowerCase()}</span>
    </span>
  );
};
