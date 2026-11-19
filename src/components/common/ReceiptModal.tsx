import React from 'react';
import { Printer, Download } from 'lucide-react';
import { Modal } from './Modal';
import { PaymentReceipt } from '../../types/gymos';
import { formatCurrency, timestampToIso, formatDisplayDate } from '../../lib/utils';

interface ReceiptModalProps {
  receipt: PaymentReceipt | null;
  currencySymbol?: string;
  onClose: () => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({
  receipt,
  currencySymbol = '₹',
  onClose,
}) => {
  if (!receipt) return null;

  const issuedDate = timestampToIso(receipt.issuedAt).slice(0, 10) || new Date().toISOString().slice(0, 10);

  const handleDownloadText = () => {
    const content = [
      `PAYMENT RECEIPT`,
      `========================================`,
      `Gym: ${receipt.gymName}`,
      `Receipt Number: ${receipt.receiptNumber}`,
      `Date: ${issuedDate}`,
      `Member: ${receipt.memberName} (${receipt.memberCode})`,
      `Amount Confirmed: ${formatCurrency(receipt.amount, currencySymbol)}`,
      `Payment Mode: ${receipt.paymentMode}`,
      receipt.transactionReference
        ? `Transaction Reference: ${receipt.transactionReference}`
        : '',
      `Payment ID: ${receipt.paymentId}`,
      `========================================`,
      `Verified manually by authorized gym staff.`,
    ]
      .filter(Boolean)
      .join('\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${receipt.receiptNumber}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      open={Boolean(receipt)}
      title="Payment Receipt"
      subtitle={`Official receipt ${receipt.receiptNumber}`}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-6">
        <div className="border border-slate-200 rounded-lg p-6 bg-white space-y-5">
          <div className="flex items-start justify-between border-b border-slate-200 pb-4">
            <div>
              <p className="text-xs font-medium text-slate-500">Issued by</p>
              <h4 className="text-lg font-semibold text-slate-900 mt-0.5">
                {receipt.gymName}
              </h4>
            </div>
            <div className="text-right">
              <p className="text-xs font-medium text-slate-500">Receipt No.</p>
              <p className="text-sm font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                {receipt.receiptNumber}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-slate-500">Member Name</p>
              <p className="font-medium text-slate-900 mt-0.5">{receipt.memberName}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Member ID</p>
              <p className="font-mono text-slate-900 tabular-nums mt-0.5">
                {receipt.memberCode}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Payment Mode</p>
              <p className="font-medium text-slate-900 mt-0.5">{receipt.paymentMode}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Date Issued</p>
              <p className="font-mono text-slate-900 tabular-nums mt-0.5">
                {formatDisplayDate(issuedDate)}
              </p>
            </div>
            {receipt.transactionReference && (
              <div className="col-span-2">
                <p className="text-xs text-slate-500">UPI / Transaction Reference</p>
                <p className="font-mono text-slate-900 mt-0.5">
                  {receipt.transactionReference}
                </p>
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 pt-4 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-600">Confirmed Amount</span>
            <span className="text-xl font-semibold font-mono text-emerald-700 tabular-nums">
              {formatCurrency(receipt.amount, currencySymbol)}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 no-print">
          <button
            type="button"
            onClick={handleDownloadText}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <Download className="w-4 h-4" />
            Download
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 transition-colors cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            Print Receipt
          </button>
        </div>
      </div>
    </Modal>
  );
};
