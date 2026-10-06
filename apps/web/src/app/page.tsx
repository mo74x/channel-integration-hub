'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw, Play, AlertTriangle, CheckCircle, ShieldAlert, Activity } from 'lucide-react';

interface Partner {
  id: string;
  slug: string;
  name: string;
  authType: string;
  status: string;
  circuitState: string;
  consecutiveFailures: number;
  unresolvedFailedJobs: number;
}

interface SyncJob {
  id: string;
  partner: { name: string; slug: string };
  jobType: string;
  entityType: string;
  status: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

interface ReconciliationLog {
  id: string;
  partner: { name: string; slug: string };
  entityType: string;
  entityId: string;
  resolution: string;
  driftDetail: Record<string, unknown>;
  createdAt: string;
}

export default function DashboardPage() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [failedJobs, setFailedJobs] = useState<SyncJob[]>([]);
  const [driftLogs, setDriftLogs] = useState<ReconciliationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

  const fetchData = async () => {
    try {
      setLoading(true);
      const [pRes, jRes, rRes] = await Promise.all([
        fetch(`${API_URL}/admin/partners`),
        fetch(`${API_URL}/admin/jobs?status=DEAD_LETTER`),
        fetch(`${API_URL}/admin/reconciliation-logs`),
      ]);

      if (pRes.ok) setPartners(await pRes.json());
      if (jRes.ok) setFailedJobs(await jRes.json());
      if (rRes.ok) setDriftLogs(await rRes.json());
    } catch (err) {
      console.error('Failed to fetch admin stats:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleReplay = async (jobId: string) => {
    setReplayingId(jobId);
    try {
      const res = await fetch(`${API_URL}/admin/jobs/${jobId}/replay`, { method: 'POST' });
      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error('Replay error:', err);
    } finally {
      setReplayingId(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Top Controls */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">System Health & Operations</h2>
          <p className="text-sm text-slate-400">Real-time status across heterogeneous external partner channels</p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 px-4 py-2 rounded-lg text-sm font-medium transition"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Partner Connectivity Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {partners.map((p) => {
          const isCircuitOpen = p.circuitState === 'OPEN';
          return (
            <div
              key={p.id}
              className={`rounded-xl border p-5 bg-[#131b2e] ${
                isCircuitOpen ? 'border-red-500/50' : 'border-slate-800'
              }`}
            >
              <div className="flex justify-between items-start mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {p.authType}
                </span>
                <span
                  className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                    isCircuitOpen
                      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  }`}
                >
                  {p.circuitState === 'CLOSED' ? 'HEALTHY' : `CIRCUIT ${p.circuitState}`}
                </span>
              </div>
              <h3 className="font-semibold text-white text-lg">{p.name}</h3>
              <p className="text-xs text-slate-500 font-mono mt-0.5">{p.slug}</p>

              <div className="mt-4 pt-4 border-t border-slate-800 flex justify-between text-xs text-slate-400">
                <div>
                  Failures: <span className="font-mono text-white">{p.consecutiveFailures}</span>
                </div>
                <div>
                  DLQ Jobs: <span className="font-mono text-amber-400">{p.unresolvedFailedJobs}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Dead-Letter Queue & Failed Syncs[cite: 1] */}
      <div className="rounded-xl border border-slate-800 bg-[#131b2e] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-amber-400" />
            <h3 className="font-semibold text-white">Dead-Letter Queue (DLQ)</h3>
          </div>
          <span className="text-xs bg-amber-400/10 text-amber-400 border border-amber-400/20 px-2 py-0.5 rounded-full font-mono">
            {failedJobs.length} Failed
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-[#0e1526] text-xs uppercase text-slate-400 border-b border-slate-800 font-semibold">
              <tr>
                <th className="px-6 py-3">Partner</th>
                <th className="px-6 py-3">Type</th>
                <th className="px-6 py-3">Retries</th>
                <th className="px-6 py-3">Last Error</th>
                <th className="px-6 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-sans">
              {failedJobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                    No failed sync jobs in dead-letter state. All queues healthy.
                  </td>
                </tr>
              ) : (
                failedJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-slate-800/30">
                    <td className="px-6 py-4 font-medium text-white">{job.partner.name}</td>
                    <td className="px-6 py-4 font-mono text-xs text-slate-400">{job.jobType}</td>
                    <td className="px-6 py-4 font-mono text-xs">{job.attempts} / 5</td>
                    <td className="px-6 py-4 text-xs text-red-400 max-w-xs truncate">{job.lastError}</td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => handleReplay(job.id)}
                        disabled={replayingId === job.id}
                        className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded text-xs font-medium transition"
                      >
                        <Play className="w-3 h-3" />
                        {replayingId === job.id ? 'Replaying...' : 'Replay'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Drift & Reconciliation History[cite: 1] */}
      <div className="rounded-xl border border-slate-800 bg-[#131b2e] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
          <Activity className="w-5 h-5 text-indigo-400" />
          <h3 className="font-semibold text-white">Reconciliation & State Drift Logs</h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-[#0e1526] text-xs uppercase text-slate-400 border-b border-slate-800 font-semibold">
              <tr>
                <th className="px-6 py-3">Time</th>
                <th className="px-6 py-3">Partner</th>
                <th className="px-6 py-3">Entity</th>
                <th className="px-6 py-3">Drift Detail</th>
                <th className="px-6 py-3">Resolution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-sans">
              {driftLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                    No state drift recorded. Systems in synchronization.
                  </td>
                </tr>
              ) : (
                driftLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/30">
                    <td className="px-6 py-4 text-xs text-slate-400">
                      {new Date(log.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="px-6 py-4 font-medium text-white">{log.partner.name}</td>
                    <td className="px-6 py-4 font-mono text-xs text-slate-400">{log.entityId}</td>
                    <td className="px-6 py-4 font-mono text-xs text-amber-300">
                      {JSON.stringify(log.driftDetail)}
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-xs px-2 py-0.5 rounded font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {log.resolution}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}