import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { AuditLog } from '../../types/gymos';
import { timestampToIso } from '../../lib/utils';

export const AuditLogsView: React.FC<{ logs: AuditLog[]; title?: string }> = ({
  logs,
  title = 'Immutable Audit Logs',
}) => {
  const [search, setSearch] = useState('');

  const filtered = logs.filter((l) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      l.action.toLowerCase().includes(q) ||
      l.actorEmail.toLowerCase().includes(q) ||
      l.summary.toLowerCase().includes(q) ||
      (l.gymId || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by actor, action, or summary..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
          />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No audit log entries match your filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Timestamp</th>
                  <th className="px-4 py-2.5 font-medium">Actor</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Entity</th>
                  <th className="px-4 py-2.5 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filtered.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {timestampToIso(l.createdAt).slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-4 py-2.5 text-slate-800">{l.actorEmail}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-600">{l.actorRole}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-900">{l.action}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500">
                      {l.entityType}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{l.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
