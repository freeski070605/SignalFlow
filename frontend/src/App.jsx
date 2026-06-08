import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createChart } from 'lightweight-charts';
import { Activity, AlertTriangle, Check, Gauge, LineChart, ListChecks, Power, RefreshCw, Settings, Shield, Wallet, X } from 'lucide-react';
import './index.css';
import { api } from './api';
import { WS_URL } from './config';

const money = (value) => `$${Number(value || 0).toFixed(2)}`;
const pct = (value) => `${Number(value || 0).toFixed(2)}%`;
const timeOnly = (value) => value
  ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(value)
  : 'Waiting';
const secondsUntil = (value) => value ? Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 1000)) : 0;
const countdown = (seconds) => seconds <= 0 ? 'expired' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
const duration = (seconds) => {
  if (seconds === null || seconds === undefined) return '-';
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
};

function Badge({ children, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-slate-700 text-slate-100',
    good: 'bg-emerald-500/15 text-emerald-300',
    bad: 'bg-rose-500/15 text-rose-300',
    warn: 'bg-amber-500/15 text-amber-300'
  };
  return <span className={`inline-flex items-center rounded px-2 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

function Card({ title, icon: Icon, children }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-4 shadow-xl shadow-black/10">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-300">
        {Icon && <Icon size={16} />}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Table({ columns, rows, render }) {
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-panel2 text-xs uppercase text-slate-400">
          <tr>{columns.map((col) => <th className="px-3 py-2" key={col}>{col}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.length === 0 ? (
            <tr><td className="px-3 py-4 text-slate-500" colSpan={columns.length}>No rows yet.</td></tr>
          ) : rows.map(render)}
        </tbody>
      </table>
    </div>
  );
}

function MissionHeader({ accountData, clock, monitor, connected, scanner, lastLiveUpdate }) {
  const regime = accountData?.marketRegime?.regime || 'NEUTRAL';
  const autoScanner = accountData?.autoCryptoScanner;
  const scannerBadge = autoScanner?.enabled
    ? autoScanner.inFlight
      ? 'Scanning Now'
      : 'Auto Scanner'
    : scanner?.runId || scanner?.run?.id
      ? 'Recent Run'
      : 'Idle';
  return (
    <section className="border-b border-line bg-ink">
      <div className="mx-auto grid max-w-7xl gap-2 px-4 py-3 md:grid-cols-4 lg:grid-cols-9">
        <Status label="Market" badge={accountData?.primaryMarket || 'crypto'} tone="good" />
        <Status label="Exchange" badge={accountData?.activeExchange || 'coinbase'} tone={accountData?.credentialStatus === 'CONNECTED' ? 'good' : 'warn'} />
        <Status label="Clock" badge="24/7" tone="good" />
        <Status label="Crypto Regime" badge={regime} tone={regime === 'BULLISH' ? 'good' : regime === 'BEARISH' ? 'bad' : 'neutral'} />
        <Status label="Trading" badge={accountData?.mode || 'SAFE_MANUAL_APPROVAL'} tone={accountData?.mode?.includes('AUTO') ? 'warn' : 'good'} />
        <Status label="Protection" badge="SignalFlow Monitor" tone="neutral" />
        <Status label="Scanner" badge={scannerBadge} tone={autoScanner?.enabled || scanner ? 'good' : 'neutral'} />
        <Status label="Socket" badge={connected ? 'Live' : 'Polling Fallback'} tone={connected ? 'good' : 'warn'} />
        <Status label="USD" badge={money(accountData?.account?.cash)} tone="neutral" />
        {monitor?.manualAttention > 0 && <div className="md:col-span-4 lg:col-span-9 rounded border border-loss bg-loss/10 p-2 text-sm text-rose-200">Manual attention required for monitored exits.</div>}
      </div>
    </section>
  );
}

function Status({ label, badge, tone }) {
  return <div className="rounded border border-line bg-panel p-2"><div className="text-[11px] uppercase text-slate-500">{label}</div><div className="mt-1"><Badge tone={tone}>{badge}</Badge></div></div>;
}

function Dashboard({ accountData, positions, performance, refresh, monitor, closeStatuses, onClosePosition }) {
  const account = accountData?.account || {};
  const todayPnl = accountData?.todayPnl || 0;
  const killActive = accountData?.settings?.kill_switch === 'true' || performance?.killSwitch;
  const sizing = accountData?.sizing || {};
  const regime = accountData?.marketRegime?.regime || 'NEUTRAL';
  const [closeCandidate, setCloseCandidate] = useState(null);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Account" icon={Wallet}>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Equity" value={money(account.equity)} />
          <Metric label="Buying Power" value={money(account.buying_power)} />
          <Metric label="Cash" value={money(account.cash)} />
          <Metric label="Today PnL" value={money(todayPnl)} tone={todayPnl >= 0 ? 'text-gain' : 'text-loss'} />
        </div>
      </Card>
      <Card title="Mode" icon={Shield}>
        <div className="space-y-3">
          <Badge tone={accountData?.mode?.includes('AUTO') ? 'warn' : 'good'}>{accountData?.mode || 'SAFE_MANUAL_APPROVAL'}</Badge>
          <Badge tone={regime === 'BULLISH' ? 'good' : regime === 'BEARISH' ? 'bad' : 'neutral'}>{regime}</Badge>
          <p className="text-sm text-slate-400">Trading mode: {accountData?.tradingMode || 'live'}</p>
          <p className="text-sm text-slate-400">Protection: {sizing.protectionMode || 'ALPACA_BRACKET_OR_EXIT_ONLY'}</p>
          <p className="text-sm text-slate-400">Kill switch: <span className={killActive ? 'text-loss' : 'text-gain'}>{killActive ? 'ACTIVE' : 'ready'}</span></p>
        </div>
      </Card>
      <Card title="Emergency" icon={AlertTriangle}>
        <button onClick={async () => { await api.killSwitch(true); refresh(); }} className="flex w-full items-center justify-center gap-2 rounded bg-loss px-4 py-4 text-sm font-bold text-white transition hover:bg-rose-400">
          <Power size={18} /> KILL SWITCH
        </button>
        <button onClick={async () => { await api.killSwitch(false); refresh(); }} className="mt-3 w-full rounded border border-line px-4 py-2 text-sm text-slate-300 hover:bg-panel2">Reset Kill Switch</button>
      </Card>
      <Card title="Open Positions" icon={Activity}>
        <Table columns={['Symbol', 'Qty', 'Value', 'Unrealized P/L', 'Action']} rows={positions} render={(row) => (
          <tr key={row.symbol}>
            <td className="px-3 py-2 font-semibold">{row.symbol}</td>
            <td className="px-3 py-2">{row.qty}</td>
            <td className="px-3 py-2">{money(row.market_value)}</td>
            <td className={`px-3 py-2 ${Number(row.unrealized_pl) >= 0 ? 'text-gain' : 'text-loss'}`}>{money(row.unrealized_pl)}</td>
            <td className="px-3 py-2">
              <div className="flex items-center gap-2">
                {closeStatuses[row.symbol] && <Badge tone={closeStatuses[row.symbol].includes('failed') ? 'bad' : closeStatuses[row.symbol].includes('filled') ? 'good' : 'warn'}>{closeStatuses[row.symbol]}</Badge>}
                <button
                  disabled={Boolean(closeStatuses[row.symbol] && !['close_order_filled', 'close_failed'].includes(closeStatuses[row.symbol]))}
                  onClick={() => setCloseCandidate(row)}
                  className="inline-flex items-center gap-2 rounded bg-loss px-3 py-2 text-xs font-bold text-white hover:bg-rose-400 disabled:opacity-60"
                >
                  {closeStatuses[row.symbol] && !['close_order_filled', 'close_failed'].includes(closeStatuses[row.symbol]) && <RefreshCw size={13} className="animate-spin" />}
                  Close
                </button>
              </div>
            </td>
          </tr>
        )} />
      </Card>
      <Card title="Position Sizing" icon={Gauge}>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Risk / Trade" value={money(sizing.riskPerTradeDollars)} />
          <Metric label="Max Position" value={money(sizing.maxPositionDollars)} />
          <Metric label="Max Daily Loss" value={money(sizing.maxDailyLossDollars)} />
          <Metric label="Open Risk" value={money(sizing.openRisk)} tone={Number(sizing.openRisk || 0) > 0 ? 'text-loss' : 'text-gain'} />
        </div>
      </Card>
      <Card title="Protection Status" icon={Shield}>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Monitor Open" value={monitor?.open || 0} />
          <Metric label="Stale" value={monitor?.stale || 0} tone={monitor?.stale ? 'text-loss' : 'text-gain'} />
          <Metric label="Manual Attention" value={monitor?.manualAttention || 0} tone={monitor?.manualAttention ? 'text-loss' : 'text-gain'} />
          <Metric label="Interval" value={`${monitor?.intervalMs || 0} ms`} />
        </div>
      </Card>
      {closeCandidate && (
        <ClosePositionModal
          row={closeCandidate}
          status={closeStatuses[closeCandidate.symbol]}
          onCancel={() => setCloseCandidate(null)}
          onSubmit={async () => {
            await onClosePosition(closeCandidate);
            setCloseCandidate(null);
          }}
        />
      )}
    </div>
  );
}

function CryptoDashboard({ data, monitor }) {
  const balances = data?.balances || [];
  const positions = data?.positions || [];
  const autoScanner = data?.autoCryptoScanner || {};
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Crypto Account" icon={Wallet}>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="USD Balance" value={money(data?.usdBalance)} />
          <Metric label="Exchange" value={data?.exchange || 'coinbase'} />
          <Metric label="Credentials" value={data?.account?.status || 'missing_credentials'} tone={data?.account?.status === 'CONNECTED' ? 'text-gain' : 'text-amber-300'} />
          <Metric label="Market" value="24/7 Spot" />
        </div>
      </Card>
      <Card title="Crypto Regime" icon={Shield}>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Regime" value={data?.regime?.regime || 'NEUTRAL'} />
          <Metric label="Quote" value={data?.quoteCurrency || 'USD'} />
          <Metric label="Preset" value={data?.scannerSettings?.settings?.activePreset || 'crypto_micro_account'} />
          <Metric label="Protection" value="SignalFlow Monitor" />
        </div>
      </Card>
      <Card title="Monitor" icon={Activity}>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Open" value={monitor?.open || 0} />
          <Metric label="Stale" value={monitor?.stale || 0} tone={monitor?.stale ? 'text-loss' : 'text-gain'} />
          <Metric label="Attention" value={monitor?.manualAttention || 0} tone={monitor?.manualAttention ? 'text-loss' : 'text-gain'} />
          <Metric label="Interval" value={`${monitor?.intervalMs || 0} ms`} />
        </div>
      </Card>
      <Card title="Auto Scanner" icon={RefreshCw}>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Status" value={autoScanner.enabled ? autoScanner.inFlight ? 'Scanning' : 'Enabled' : 'Off'} tone={autoScanner.enabled ? 'text-gain' : 'text-loss'} />
          <Metric label="Interval" value={autoScanner.intervalMs ? duration(Math.round(autoScanner.intervalMs / 1000)) : '-'} />
          <Metric label="Last Run" value={autoScanner.lastRun?.runId ? timeOnly(new Date(autoScanner.lastRun.completedAt)) : '-'} />
          <Metric label="Next Run" value={autoScanner.nextRunAt ? countdown(secondsUntil(autoScanner.nextRunAt)) : '-'} />
        </div>
      </Card>
      <Card title="Balances" icon={Gauge}>
        <Table columns={['Asset', 'Available', 'Hold']} rows={balances} render={(row) => (
          <tr key={row.asset}>
            <td className="px-3 py-2 font-bold">{row.asset}</td>
            <td className="px-3 py-2">{Number(row.available || 0).toFixed(8)}</td>
            <td className="px-3 py-2">{Number(row.hold || 0).toFixed(8)}</td>
          </tr>
        )} />
      </Card>
      <Card title="Open Crypto Positions" icon={LineChart}>
        <Table columns={['Symbol', 'Qty', 'Market', 'Exchange']} rows={positions} render={(row) => (
          <tr key={row.symbol}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2">{Number(row.qty || 0).toFixed(8)}</td>
            <td className="px-3 py-2">{row.market_type}</td>
            <td className="px-3 py-2">{row.exchange}</td>
          </tr>
        )} />
      </Card>
    </div>
  );
}

const signalGateTone = (status) => {
  if (status === 'created_signal') return 'good';
  if (status === 'discovery_risk' || status === 'duplicate_pending_signal') return 'warn';
  if (status === 'blocked_by_regime' || status === 'no_buy_confirmation' || status === 'rejected_filters' || status === 'missing_quote_data' || status === 'missing_candle_data' || status === 'unsafe_product' || status === 'already_in_position') return 'bad';
  return 'neutral';
};

const signalGateLabel = (status) => ({
  created_signal: 'CREATED',
  blocked_by_regime: 'BLOCKED BY REGIME',
  no_buy_confirmation: 'NO BUY CONFIRMATION',
  duplicate_pending_signal: 'DUPLICATE',
  discovery_risk: 'DISCOVERY RISK',
  rejected_filters: 'REJECTED FILTERS',
  missing_quote_data: 'MISSING QUOTE',
  missing_candle_data: 'MISSING CANDLES',
  unsafe_product: 'UNSAFE PRODUCT',
  already_in_position: 'ALREADY IN POSITION'
}[status] || 'NOT CHECKED');

function GateChecklist({ checklist }) {
  const rows = [
    ['vwap', 'VWAP'],
    ['ema', 'EMA'],
    ['rsi', 'RSI'],
    ['momentum', 'Momentum'],
    ['spread', 'Spread'],
    ['regime', 'Regime'],
    ['score', 'Score'],
    ['productTradable', 'Tradable'],
    ['freshPrice', 'Fresh Price']
  ];
  if (!checklist) return <span className="text-xs text-slate-500">-</span>;
  return (
    <div className="flex min-w-[240px] flex-wrap gap-1">
      {rows.map(([key, label]) => (
        <Badge key={key} tone={checklist[key] ? 'good' : 'bad'}>{label}</Badge>
      ))}
    </div>
  );
}

function SignalGateSummary({ summary, topBlockerMessage }) {
  if (!summary) return null;
  const rows = [
    ['scanned', 'Scanned'],
    ['passedScannerFilters', 'Passed Scanner'],
    ['createdPendingSignals', 'Created Signals'],
    ['blockedByRegime', 'Blocked Regime'],
    ['failedVwap', 'Failed VWAP'],
    ['failedEma', 'Failed EMA'],
    ['failedRsi', 'Failed RSI'],
    ['failedMomentum', 'Failed Momentum'],
    ['failedScore', 'Failed Score'],
    ['failedSpread', 'Failed Spread'],
    ['duplicatePending', 'Duplicate'],
    ['alreadyInPosition', 'In Position'],
    ['missingCandleData', 'Missing Candles'],
    ['missingQuoteData', 'Missing Quote']
  ];
  return (
    <div className="rounded border border-line bg-ink p-3">
      <div className="mb-2 text-sm font-semibold text-slate-300">Signal Gate Summary</div>
      {topBlockerMessage && <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">{topBlockerMessage}</div>}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([key, label]) => <Metric key={key} label={label} value={summary[key] || 0} />)}
      </div>
    </div>
  );
}

function SignalModeSimulation({ simulation }) {
  const rows = simulation?.rows || [];
  if (!simulation) return null;
  return (
    <div className="rounded border border-line bg-ink p-3">
      <div className="mb-2 text-sm font-semibold text-slate-300">Signal Mode Simulation</div>
      <Table columns={['Symbol', 'Price', 'Strict', 'Balanced', 'Discovery', 'Top Blocker']} rows={rows} render={(row) => (
        <tr key={`sim-${row.symbol}`}>
          <td className="px-3 py-2 font-bold">{row.symbol}</td>
          <td className="px-3 py-2">{money(row.price)}</td>
          <td className="px-3 py-2"><Badge tone={row.strict?.wouldCreate ? 'good' : 'bad'}>{row.strict?.wouldCreate ? 'YES' : 'NO'}</Badge></td>
          <td className="px-3 py-2"><Badge tone={row.balanced?.wouldCreate ? 'good' : 'bad'}>{row.balanced?.wouldCreate ? 'YES' : 'NO'}</Badge></td>
          <td className="px-3 py-2"><Badge tone={row.discovery?.wouldCreate ? 'warn' : 'bad'}>{row.discovery?.wouldCreate ? 'YES' : 'NO'}</Badge></td>
          <td className="px-3 py-2 text-slate-400">{row.topBlocker}</td>
        </tr>
      )} />
    </div>
  );
}

function SignalOpportunityMonitor({ monitor }) {
  const nearMisses = monitor?.nearMisses || [];
  const probabilityTone = (probability) => probability === 'HIGH' ? 'good' : probability === 'MEDIUM' ? 'warn' : 'neutral';
  return (
    <div className="rounded border border-line bg-ink p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-300">Signal Opportunity Monitor</div>
          <div className="text-xs uppercase text-slate-500">Near Misses</div>
        </div>
        <Badge tone={nearMisses.length ? 'good' : 'neutral'}>{nearMisses.length}</Badge>
      </div>
      {nearMisses.length === 0 ? (
        <div className="rounded border border-line bg-panel p-3 text-sm text-slate-500">No near misses on the latest scanner run.</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {nearMisses.map((row) => (
            <div key={`near-miss-${row.symbol}`} className="rounded border border-line bg-panel p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="font-bold text-white">{row.symbol}</div>
                  <div className="mt-1 text-sm text-slate-400">Score: <span className="font-semibold text-slate-100">{Number(row.score || 0).toFixed(1)}</span></div>
                </div>
                <Badge tone={probabilityTone(row.probability)}>{row.probability}</Badge>
              </div>
              <div className="text-xs uppercase text-slate-500">Need</div>
              <div className="mt-1 space-y-1 text-sm text-slate-300">
                {(row.needs || []).map((need) => <div key={`${row.symbol}-${need.key}`}>{need.label}</div>)}
              </div>
              <div className="mt-3 text-xs uppercase text-slate-500">Probability</div>
              <div className="mt-1 text-sm font-bold text-slate-100">{row.probability}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const outcomeTone = (outcome) => ({
  promoted_to_trade: 'good',
  promoted_to_signal: 'good',
  expired: 'warn',
  regressed: 'bad',
  observed: 'neutral'
}[outcome] || 'neutral');

function CandidateProgressTable({ title, rows }) {
  return (
    <div className="rounded border border-line bg-ink p-3">
      <div className="mb-2 text-sm font-semibold text-slate-300">{title}</div>
      <Table columns={['Symbol', 'Score', 'Volume', 'Momentum', 'Signal', 'Failure']} rows={rows} render={(row) => (
        <tr key={`${title}-${row.symbol}`}>
          <td className="px-3 py-2 font-bold">{row.symbol}</td>
          <td className={`px-3 py-2 ${row.score?.delta >= 0 ? 'text-gain' : 'text-loss'}`}>
            {Number(row.score?.latest || 0).toFixed(1)} ({row.score?.delta >= 0 ? '+' : ''}{Number(row.score?.delta || 0).toFixed(1)})
          </td>
          <td className={`px-3 py-2 ${row.volume?.delta >= 0 ? 'text-gain' : 'text-loss'}`}>
            {Number(row.volume?.latest || 0).toFixed(2)} ({row.volume?.delta >= 0 ? '+' : ''}{Number(row.volume?.delta || 0).toFixed(2)})
          </td>
          <td className={`px-3 py-2 ${row.momentum?.delta15m >= 0 ? 'text-gain' : 'text-loss'}`}>
            {pct(row.momentum?.latest15m)} ({row.momentum?.delta15m >= 0 ? '+' : ''}{Number(row.momentum?.delta15m || 0).toFixed(2)}%)
          </td>
          <td className="px-3 py-2">{duration(row.timeUntilSignalSeconds)}</td>
          <td className="px-3 py-2">{duration(row.timeUntilFailureSeconds)}</td>
        </tr>
      )} />
    </div>
  );
}

function NearMissAnalytics({ analytics }) {
  const rising = analytics?.risingCandidates || [];
  const falling = analytics?.fallingCandidates || [];
  const history = analytics?.history || [];
  const counts = analytics?.outcomeCounts || {};
  return (
    <div className="grid gap-4">
      <div className="rounded border border-line bg-ink p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-300">Near Miss Analytics</div>
          <div className="flex flex-wrap gap-2">
            {['promoted_to_signal', 'promoted_to_trade', 'expired', 'regressed'].map((key) => (
              <Badge key={key} tone={outcomeTone(key)}>{key.replaceAll('_', ' ')}: {counts[key] || 0}</Badge>
            ))}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Metric label="Rising Candidates" value={rising.length} tone={rising.length ? 'text-gain' : 'text-slate-300'} />
          <Metric label="Falling Candidates" value={falling.length} tone={falling.length ? 'text-loss' : 'text-slate-300'} />
          <Metric label="History Rows" value={history.length} />
        </div>
      </div>
      <CandidateProgressTable title="Rising Candidates" rows={rising} />
      <CandidateProgressTable title="Falling Candidates" rows={falling} />
      <div className="rounded border border-line bg-ink p-3">
        <div className="mb-2 text-sm font-semibold text-slate-300">Near Miss History</div>
        <Table columns={['Symbol', 'Outcome', 'Score Progression', 'Volume Progression', 'Momentum Progression', 'Signal', 'Failure']} rows={history} render={(row) => (
          <tr key={`history-${row.symbol}-${row.lastSeenAt}`}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2"><Badge tone={outcomeTone(row.outcome)}>{String(row.outcome || 'observed').replaceAll('_', ' ')}</Badge></td>
            <td className="px-3 py-2">{Number(row.score?.first || 0).toFixed(1)} {'->'} {Number(row.score?.latest || 0).toFixed(1)}</td>
            <td className="px-3 py-2">{Number(row.volume?.first || 0).toFixed(2)} {'->'} {Number(row.volume?.latest || 0).toFixed(2)}</td>
            <td className="px-3 py-2">{pct(row.momentum?.first15m)} {'->'} {pct(row.momentum?.latest15m)}</td>
            <td className="px-3 py-2">{duration(row.timeUntilSignalSeconds)}</td>
            <td className="px-3 py-2">{duration(row.timeUntilFailureSeconds)}</td>
          </tr>
        )} />
      </div>
    </div>
  );
}

function CryptoStrategySettingsPanel({ data, onSave }) {
  const settings = data?.settings || {};
  const presets = data?.presets || {};
  const [form, setForm] = useState(settings);
  useEffect(() => setForm(settings), [JSON.stringify(settings)]);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const applyMode = (mode) => setForm((current) => ({ ...current, ...(presets[mode] || {}), signalMode: mode }));

  return (
    <div className="rounded border border-line bg-ink p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-slate-300">Crypto Strategy Settings</div>
        <Badge tone={form.signalMode === 'discovery' ? 'warn' : form.signalMode === 'balanced' ? 'neutral' : 'good'}>{form.signalMode || 'strict'}</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="block rounded border border-line bg-panel p-3 text-sm text-slate-400">
          Signal Mode
          <select className="mt-2 w-full rounded border border-line bg-ink px-3 py-2 text-white" value={form.signalMode || 'strict'} onChange={(event) => applyMode(event.target.value)}>
            {['strict', 'balanced', 'discovery'].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
        <Field label="RSI Min" value={form.rsiMin} onChange={(value) => set('rsiMin', value)} />
        <Field label="RSI Max" value={form.rsiMax} onChange={(value) => set('rsiMax', value)} />
        <Field label="Max Signal Spread %" value={form.maxSignalSpreadPercent} onChange={(value) => set('maxSignalSpreadPercent', value)} />
        <Field label="Min Signal Score" value={form.minSignalScore} onChange={(value) => set('minSignalScore', value)} />
        <Toggle label="Require VWAP" value={form.requirePriceAboveVwap === true || form.requirePriceAboveVwap === 'true'} onChange={(value) => set('requirePriceAboveVwap', value)} />
        <Toggle label="Require EMA9 > EMA20" value={form.requireEma9AboveEma20 === true || form.requireEma9AboveEma20 === 'true'} onChange={(value) => set('requireEma9AboveEma20', value)} />
        <Toggle label="Require 15m Momentum" value={form.requirePositive15mMomentum === true || form.requirePositive15mMomentum === 'true'} onChange={(value) => set('requirePositive15mMomentum', value)} />
        <Toggle label="Allow Counter-Regime" value={form.allowCounterRegimeTrades === true || form.allowCounterRegimeTrades === 'true'} onChange={(value) => set('allowCounterRegimeTrades', value)} />
      </div>
      {(form.signalMode === 'discovery' || form.allowCounterRegimeTrades === true || form.allowCounterRegimeTrades === 'true') && (
        <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          Discovery or counter-regime signals are tagged DISCOVERY_RISK and still require manual review plus final risk approval.
        </div>
      )}
      <button onClick={() => onSave(form)} className="mt-3 rounded bg-gain px-4 py-2 text-sm font-bold text-ink">Save Strategy Settings</button>
    </div>
  );
}

function CryptoSignalInspectionModal({ debug, status, error, onClose }) {
  const failed = debug?.failedGates || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-line bg-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white">Crypto Signal Gate</h3>
            <p className="text-sm text-slate-400">{debug?.symbol || 'Candidate'} signal gate evaluation.</p>
          </div>
          <button onClick={onClose} className="rounded border border-line p-2 text-slate-300 hover:bg-panel2"><X size={16} /></button>
        </div>
        {status === 'loading' && <Badge tone="warn">Loading</Badge>}
        {error && <div className="rounded border border-loss bg-loss/10 p-3 text-sm text-rose-200">{error}</div>}
        {debug && (
          <div className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Mode" value={debug.signalMode} />
              <Metric label="Would Create" value={debug.would_create_signal ? 'YES' : 'NO'} tone={debug.would_create_signal ? 'text-gain' : 'text-loss'} />
              <Metric label="Gate" value={signalGateLabel(debug.status)} />
              <Metric label="Regime" value={debug.regime?.regime || 'NEUTRAL'} />
            </div>
            <div className="rounded border border-line bg-ink p-3">
              <div className="mb-2 text-sm font-semibold text-slate-300">Checklist</div>
              <GateChecklist checklist={debug.checklist} />
            </div>
            <div className="rounded border border-line bg-ink p-3">
              <div className="mb-2 text-sm font-semibold text-slate-300">Failed Gates</div>
              {failed.length === 0 ? <div className="text-sm text-slate-400">No failed gates.</div> : (
                <div className="space-y-2">
                  {failed.map((gate) => (
                    <div key={gate.key} className="rounded border border-line bg-panel p-2 text-sm">
                      <div className="font-semibold text-white">{gate.label}</div>
                      <div className="text-slate-400">{gate.recommendedAdjustment}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded border border-line bg-ink p-3 text-sm text-slate-300">
              <div className="font-semibold text-white">Recommendation</div>
              <div className="mt-1 text-slate-400">{debug.recommendedAdjustment}</div>
              <div className="mt-2 text-slate-500">{debug.reason}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CryptoScanner({ scanner, settingsData, strategyData, analytics, runScanner, saveStrategySettings, debugSignal, simulateModes }) {
  const passed = scanner?.passed || [];
  const rejected = scanner?.rejected || [];
  const closest = scanner?.closestToPassing || [];
  const reasons = scanner?.rejectionReasons || [];
  const signalGeneration = scanner?.signalGeneration || {};
  const presets = settingsData?.presets || {};
  const [debug, setDebug] = useState(null);
  const [debugStatus, setDebugStatus] = useState('');
  const [debugError, setDebugError] = useState('');
  const [simulation, setSimulation] = useState(null);
  const [simulationError, setSimulationError] = useState('');
  const openDebug = async (row) => {
    setDebug(null);
    setDebugError('');
    setDebugStatus('loading');
    try {
      setDebug(await debugSignal(scanner?.runId, row.symbol));
      setDebugStatus('ready');
    } catch (error) {
      setDebugError(error.message);
      setDebugStatus('error');
    }
  };
  const runSimulation = async () => {
    setSimulationError('');
    try {
      setSimulation(await simulateModes(scanner?.runId));
    } catch (error) {
      setSimulationError(error.message);
    }
  };
  return (
    <Card title="Crypto Scanner" icon={LineChart}>
      <div className="mb-4 flex flex-wrap gap-2">
        {Object.keys(presets).map((key) => (
          <button key={key} onClick={() => runScanner(key)} className="rounded bg-panel2 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-line">{key.replaceAll('_', ' ')}</button>
        ))}
        <button onClick={() => runScanner('')} className="rounded bg-gain px-3 py-2 text-sm font-bold text-ink">Run Active Scanner</button>
        <button onClick={runSimulation} disabled={!scanner?.runId} className="rounded border border-line px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-panel2 disabled:opacity-50">Simulate Signal Modes</button>
      </div>
      <CryptoStrategySettingsPanel data={strategyData} onSave={saveStrategySettings} />
      <div className="mt-4">
        <ActiveFilters filters={scanner?.activeFilters || settingsData?.settings} />
      </div>
      <div className="mt-4 grid gap-4">
        <SignalGateSummary summary={scanner?.signalGateSummary} topBlockerMessage={scanner?.topBlockerMessage} />
        <SignalOpportunityMonitor monitor={scanner?.opportunityMonitor} />
        <NearMissAnalytics analytics={scanner?.nearMissHistory || analytics} />
        {simulationError && <div className="rounded border border-loss bg-loss/10 p-3 text-sm text-rose-200">{simulationError}</div>}
        <SignalModeSimulation simulation={simulation} />
        {Object.keys(signalGeneration).length > 0 && (
          <div className="rounded border border-line bg-ink p-3">
            <div className="mb-2 text-sm font-semibold text-slate-300">Signal Generation</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(signalGeneration).map(([status, count]) => (
                <Badge key={status} tone={status === 'created_signal' ? 'good' : status === 'duplicate_pending_signal' ? 'warn' : 'neutral'}>{status.replaceAll('_', ' ')}: {count}</Badge>
              ))}
            </div>
          </div>
        )}
        <Table columns={['Passed', 'Price', '15m', '1h', 'Volume USD', 'Spread', 'Score', 'Signal Gate', 'Checklist', 'Inspect']} rows={passed} render={(row) => (
          <tr key={`crypto-pass-${row.symbol}`}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2">{money(row.price)}</td>
            <td className="px-3 py-2">{pct(row.percent_change_15m)}</td>
            <td className="px-3 py-2">{pct(row.percent_change_1h)}</td>
            <td className="px-3 py-2">{money(row.volume)}</td>
            <td className="px-3 py-2">{pct(row.spread_percent)}</td>
            <td className="px-3 py-2 font-bold">{Number(row.score || 0).toFixed(1)}</td>
            <td className="px-3 py-2">
              <div className="flex flex-col gap-1">
                <Badge tone={signalGateTone(row.signal_generation_status)}>{signalGateLabel(row.signal_generation_status)}</Badge>
                <span className="text-xs text-slate-500">{row.signal_generation_reason || '-'}</span>
              </div>
            </td>
            <td className="px-3 py-2"><GateChecklist checklist={row.signal_gate?.checklist} /></td>
            <td className="px-3 py-2"><button onClick={() => openDebug(row)} className="rounded border border-line px-3 py-2 text-xs font-bold text-slate-200 hover:bg-panel2">Inspect Gate</button></td>
          </tr>
        )} />
        <Table columns={['Closest', 'Passed Filters', 'Score', 'Blockers']} rows={closest} render={(row) => (
          <tr key={`crypto-close-${row.symbol}`}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2">{row.passed_filters || 0}/{row.total_filters || 0}</td>
            <td className="px-3 py-2">{Number(row.score || 0).toFixed(1)}</td>
            <td className="px-3 py-2 text-slate-400">{(row.blockers || []).join('; ') || row.reason}</td>
          </tr>
        )} />
        <Table columns={['Top Rejection Reason', 'Count']} rows={reasons} render={(row) => (
          <tr key={row.reason}>
            <td className="px-3 py-2 text-slate-300">{row.reason}</td>
            <td className="px-3 py-2 font-bold">{row.count}</td>
          </tr>
        )} />
        <Table columns={['Rejected', 'Reason']} rows={rejected} render={(row) => (
          <tr key={`crypto-rej-${row.symbol}`}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2 text-slate-400">{row.reason}</td>
          </tr>
        )} />
      </div>
      {(debug || debugStatus === 'loading' || debugError) && <CryptoSignalInspectionModal debug={debug} status={debugStatus} error={debugError} onClose={() => { setDebug(null); setDebugStatus(''); setDebugError(''); }} />}
    </Card>
  );
}

function CryptoPositions({ positions, monitorRows, refresh }) {
  const [busy, setBusy] = useState('');
  const close = async (symbol) => {
    if (!window.confirm(`Close ${symbol} spot position with a market sell?`)) return;
    setBusy(symbol);
    try {
      await api.closePosition(symbol);
      await refresh();
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="grid gap-4">
      <Card title="Crypto Positions" icon={Activity}>
        <Table columns={['Symbol', 'Qty', 'Market', 'Exchange', 'Action']} rows={positions} render={(row) => (
          <tr key={row.symbol}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2">{Number(row.qty || 0).toFixed(8)}</td>
            <td className="px-3 py-2">{row.market_type}</td>
            <td className="px-3 py-2">{row.exchange}</td>
            <td className="px-3 py-2"><button disabled={busy === row.symbol} onClick={() => close(row.symbol)} className="rounded bg-loss px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{busy === row.symbol ? 'Closing...' : 'Close'}</button></td>
          </tr>
        )} />
      </Card>
      <MonitoredPositions rows={monitorRows.filter((row) => row.market_type === 'crypto')} refresh={refresh} />
    </div>
  );
}

function ClosePositionModal({ row, status, onCancel, onSubmit }) {
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const busy = Boolean(status && !['close_order_filled', 'close_failed'].includes(status));
  const canSubmit = ack && typed.trim().toUpperCase() === 'CLOSE' && !busy;
  const price = row.current_price || row.asset_current_price || row.avg_entry_price || 0;

  const submit = async () => {
    setError('');
    try {
      await onSubmit();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-lg border border-line bg-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white">Close Live Position</h3>
            <p className="text-sm text-slate-400">This action reduces risk and bypasses the kill switch.</p>
          </div>
          <button onClick={onCancel} className="rounded border border-line p-2 text-slate-300 hover:bg-panel2"><X size={16} /></button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric label="Symbol" value={row.symbol} />
          <Metric label="Quantity" value={row.qty} />
          <Metric label="Current Price" value={money(price)} />
          <Metric label="Estimated Notional" value={money(row.market_value)} />
          <Metric label="Unrealized P/L" value={money(row.unrealized_pl)} tone={Number(row.unrealized_pl) >= 0 ? 'text-gain' : 'text-loss'} />
          <div className="rounded border border-line bg-ink p-3">
            <div className="text-xs text-slate-500">Status</div>
            <div className="mt-1"><Badge tone={status?.includes('failed') ? 'bad' : status?.includes('filled') ? 'good' : status ? 'warn' : 'neutral'}>{status || 'ready'}</Badge></div>
          </div>
        </div>
        <div className="mt-4 rounded border border-loss bg-loss/10 p-3 text-sm font-semibold text-rose-200">
          This will submit a real market close order through Alpaca.
        </div>
        {error && <div className="mt-3 rounded border border-loss bg-loss/10 p-3 text-sm text-rose-200">{error}</div>}
        <label className="mt-4 flex items-start gap-3 text-sm text-slate-300">
          <input className="mt-1" type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
          <span>I understand this will close the live position.</span>
        </label>
        <label className="mt-4 block text-sm text-slate-400">
          Type CLOSE to enable submit
          <input className="mt-2 w-full rounded border border-line bg-ink px-3 py-2 text-white" value={typed} onChange={(event) => setTyped(event.target.value)} />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-line px-4 py-2 text-sm text-slate-300 hover:bg-panel2">Cancel</button>
          <button disabled={!canSubmit} onClick={submit} className="inline-flex items-center gap-2 rounded bg-loss px-4 py-2 text-sm font-bold text-white hover:bg-rose-400 disabled:opacity-50">
            {busy && <RefreshCw size={15} className="animate-spin" />}
            Submit Close Order
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = 'text-white' }) {
  return <div className="rounded border border-line bg-ink p-3"><div className="text-xs text-slate-500">{label}</div><div className={`mt-1 text-lg font-bold ${tone}`}>{value}</div></div>;
}

function ScannerSettingsPanel({ data, onSave, onRelax, onRun }) {
  const settings = data?.settings || {};
  const presets = data?.presets || {};
  const [form, setForm] = useState(settings);
  useEffect(() => setForm(settings), [JSON.stringify(settings)]);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const presetLabels = {
    conservative: 'Conservative',
    micro_account: 'Micro Account',
    momentum_hunt: 'Momentum Hunt'
  };
  const filterRows = [
    ['minPrice', 'Min Price'],
    ['maxPrice', 'Max Price'],
    ['minDailyVolume', 'Min Daily Volume'],
    ['minRelativeVolume', 'Min Rel Volume'],
    ['maxSpreadPercent', 'Max Spread %'],
    ['minPercentChange', 'Min Change %'],
    ['maxResults', 'Max Results']
  ];

  return (
    <div className="grid gap-4">
      <div className="rounded border border-line bg-ink p-3">
        <div className="mb-3 text-sm font-semibold text-slate-300">Scanner Presets</div>
        <div className="flex flex-wrap gap-2">
          {Object.keys(presets).map((key) => (
            <button key={key} onClick={() => onRun(key)} className="rounded bg-panel2 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-line">
              {presetLabels[key] || key}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filterRows.map(([key, label]) => (
          <Field key={key} label={label} value={form[key]} onChange={(value) => set(key, value)} />
        ))}
      </div>
      <div className="rounded border border-line bg-ink p-3 text-sm text-slate-400">
        Safety locks: OTC excluded, inactive assets blocked, non-tradable assets blocked, manual approval unchanged, auto execution unchanged.
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => onRun('')} className="flex items-center gap-2 rounded bg-gain px-3 py-2 text-sm font-bold text-ink"><RefreshCw size={16} /> Run With Active Filters</button>
        <button onClick={() => onSave(form)} className="rounded border border-line px-3 py-2 text-sm hover:bg-panel2">Save as Default</button>
        <button onClick={onRelax} className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 hover:bg-amber-500/20">Relax filters one step</button>
      </div>
    </div>
  );
}

function ActiveFilters({ filters }) {
  const rows = filters ? Object.entries(filters).filter(([, value]) => typeof value !== 'boolean') : [];
  return (
    <div className="rounded border border-line bg-ink p-3">
      <div className="mb-2 text-sm font-semibold text-slate-300">Active Filters</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([key, value]) => <Metric key={key} label={key} value={String(value)} />)}
      </div>
    </div>
  );
}

function Watchlist({ rows, universe, scanner, scannerSettingsData, blocked, refresh, runScanner, saveScannerSettings, relaxScannerSettings, block, unblock }) {
  const [subtab, setSubtab] = useState('Market Context');
  const chartRow = rows.find((row) => row.chart?.length);
  const passed = scanner?.passed || [];
  const rejected = scanner?.rejected || [];
  const closest = scanner?.closestToPassing || [];
  const reasons = scanner?.rejectionReasons || [];
  const suggested = scanner?.suggestedTuning || [];
  const signalGeneration = scanner?.signalGeneration || {};
  const subtabs = ['Market Context', 'Trading Universe', 'Scanner Results', 'Scanner Settings', 'Blocked Symbols'];
  return (
    <Card title="Watchlist" icon={LineChart}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {subtabs.map((item) => (
            <button key={item} onClick={() => setSubtab(item)} className={`rounded px-3 py-2 text-sm font-semibold ${subtab === item ? 'bg-gain text-ink' : 'bg-panel2 text-slate-300 hover:bg-line'}`}>{item}</button>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="flex items-center gap-2 rounded border border-line px-3 py-2 text-sm hover:bg-panel2"><RefreshCw size={16} /> Refresh Context</button>
          <button onClick={() => runScanner('')} className="flex items-center gap-2 rounded bg-gain px-3 py-2 text-sm font-bold text-ink"><RefreshCw size={16} /> Run Scanner</button>
        </div>
      </div>
      {subtab === 'Market Context' && (
        <>
          <p className="mb-3 text-sm text-slate-400">Market Context symbols are used for confirmation. Account size affects position size, not scanner capability.</p>
          {chartRow && <PriceChart symbol={chartRow.symbol} data={chartRow.chart} />}
          <Table columns={['Ticker', 'Price', 'Change', 'EMA 9', 'EMA 20', 'VWAP', 'Trend', 'Status']} rows={rows} render={(row) => (
            <tr key={row.symbol}>
              <td className="px-3 py-2 font-bold">{row.symbol}</td>
              <td className="px-3 py-2">{money(row.price)}</td>
              <td className={`px-3 py-2 ${Number(row.change_percent) >= 0 ? 'text-gain' : 'text-loss'}`}>{pct(row.change_percent)}</td>
              <td className="px-3 py-2">{money(row.indicators?.ema9)}</td>
              <td className="px-3 py-2">{money(row.indicators?.ema20)}</td>
              <td className="px-3 py-2">{money(row.indicators?.vwap || row.vwap)}</td>
              <td className="px-3 py-2"><Badge tone={row.trend === 'BULLISH' ? 'good' : row.trend === 'BEARISH' ? 'bad' : 'neutral'}>{row.trend || 'NEUTRAL'}</Badge></td>
              <td className="px-3 py-2"><Badge>CONTEXT</Badge></td>
            </tr>
          )} />
        </>
      )}
      {subtab === 'Trading Universe' && (
        <>
          <p className="mb-3 text-sm text-slate-400">Trading Universe symbols are trade candidates ranked by scanner score.</p>
          <Table columns={['Symbol', 'Price', 'Change', 'Volume', 'Rel Vol', 'Spread', 'Tradable', 'Fractional', 'Score', 'Signal', 'Action']} rows={universe} render={(row) => (
            <tr key={`${row.run_id}-${row.symbol}`}>
              <td className="px-3 py-2 font-bold">{row.symbol}</td>
              <td className="px-3 py-2">{money(row.price)}</td>
              <td className={`px-3 py-2 ${Number(row.percent_change) >= 0 ? 'text-gain' : 'text-loss'}`}>{pct(row.percent_change)}</td>
              <td className="px-3 py-2">{Number(row.volume || 0).toLocaleString()}</td>
              <td className="px-3 py-2">{Number(row.relative_volume || 0).toFixed(2)}</td>
              <td className="px-3 py-2">{pct(row.spread_percent)}</td>
              <td className="px-3 py-2"><Badge tone={row.tradable ? 'good' : 'bad'}>{row.tradable ? 'TRADABLE' : 'NO'}</Badge></td>
              <td className="px-3 py-2"><Badge tone={row.fractionable ? 'warn' : 'neutral'}>{row.fractionable ? 'FRACTIONAL' : 'WHOLE SHARE READY'}</Badge></td>
              <td className="px-3 py-2 font-bold">{Number(row.score || 0).toFixed(1)}</td>
              <td className="px-3 py-2"><Badge tone={row.signal_status === 'BUY' ? 'good' : row.signal_status === 'SELL' ? 'bad' : 'neutral'}>{row.signal_status || 'NONE'}</Badge></td>
              <td className="px-3 py-2"><button onClick={() => block(row.symbol)} className="rounded border border-line px-3 py-2 text-sm hover:bg-panel2">Block</button></td>
            </tr>
          )} />
        </>
      )}
      {subtab === 'Scanner Results' && (
        <div className="grid gap-4">
          <div className="rounded border border-line bg-ink p-3 text-sm text-slate-400">
            Last run: <span className="text-white">{scanner?.run?.id || scanner?.runId || 'none'}</span>
          </div>
          <ActiveFilters filters={scanner?.activeFilters || scannerSettingsData?.settings} />
          {Object.keys(signalGeneration).length > 0 && (
            <div className="rounded border border-line bg-ink p-3">
              <div className="mb-2 text-sm font-semibold text-slate-300">Signal Generation</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(signalGeneration).map(([status, count]) => (
                  <Badge key={status} tone={status === 'created_signal' ? 'good' : status === 'duplicate_pending_signal' ? 'warn' : 'neutral'}>{status.replaceAll('_', ' ')}: {count}</Badge>
                ))}
              </div>
            </div>
          )}
          {passed.length === 0 && (
            <div className="rounded border border-line bg-panel2 p-3 text-sm text-slate-300">
              No candidates passed current filters. Review rejection reasons below, then tune filters such as minimum daily volume, relative volume, price range, or percent change.
            </div>
          )}
          <Table columns={['Passed', 'Score', 'Reason', 'Signal']} rows={passed} render={(row) => (
            <tr key={`passed-${row.symbol}`}>
              <td className="px-3 py-2 font-bold">{row.symbol}</td>
              <td className="px-3 py-2">{Number(row.score || 0).toFixed(1)}</td>
              <td className="px-3 py-2 text-slate-400">{row.reason || 'passed scanner filters'}</td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1">
                  <Badge tone={row.signal_generation_status === 'created_signal' ? 'good' : row.signal_generation_status === 'duplicate_pending_signal' ? 'warn' : 'neutral'}>
                    {(row.signal_generation_status || row.signal_status || 'NONE').replaceAll('_', ' ')}
                  </Badge>
                  <span className="text-xs text-slate-500">{row.signal_generation_reason || '-'}</span>
                </div>
              </td>
            </tr>
          )} />
          <Table columns={['Closest', 'Passed Filters', 'Score', 'Blocking Filters']} rows={closest} render={(row) => (
            <tr key={`closest-${row.symbol}`}>
              <td className="px-3 py-2 font-bold">{row.symbol}</td>
              <td className="px-3 py-2">{row.passed_filters || 0}/{row.total_filters || 0}</td>
              <td className="px-3 py-2">{Number(row.score || 0).toFixed(1)}</td>
              <td className="px-3 py-2 text-slate-400">{(row.blockers || []).join('; ') || row.reason}</td>
            </tr>
          )} />
          <Table columns={['Top Rejection Reason', 'Count']} rows={reasons} render={(row) => (
            <tr key={row.reason}>
              <td className="px-3 py-2 text-slate-300">{row.reason}</td>
              <td className="px-3 py-2 font-bold">{row.count}</td>
            </tr>
          )} />
          {suggested.length > 0 && (
            <div className="rounded border border-line bg-ink p-3">
              <div className="mb-2 text-sm font-semibold text-slate-300">Suggested Tuning</div>
              <div className="space-y-1 text-sm text-slate-400">{suggested.map((item) => <div key={item}>{item}</div>)}</div>
            </div>
          )}
          <Table columns={['Rejected', 'Reason']} rows={rejected} render={(row) => (
            <tr key={row.id || `rej-${row.symbol}`}>
              <td className="px-3 py-2 font-bold">{row.symbol}</td>
              <td className="px-3 py-2 text-slate-400">{row.reason}</td>
            </tr>
          )} />
        </div>
      )}
      {subtab === 'Scanner Settings' && (
        <ScannerSettingsPanel data={scannerSettingsData} onSave={saveScannerSettings} onRelax={relaxScannerSettings} onRun={runScanner} />
      )}
      {subtab === 'Blocked Symbols' && (
        <Table columns={['Symbol', 'Status', 'Action']} rows={blocked} render={(row) => (
          <tr key={row.symbol}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2"><Badge tone="bad">BLOCKED</Badge></td>
            <td className="px-3 py-2"><button onClick={() => unblock(row.symbol)} className="rounded border border-line px-3 py-2 text-sm hover:bg-panel2">Unblock</button></td>
          </tr>
        )} />
      )}
    </Card>
  );
}

function PriceChart({ symbol, data }) {
  const ref = React.useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return undefined;
    const chart = createChart(ref.current, {
      height: 220,
      layout: { background: { color: '#080d12' }, textColor: '#cbd5e1' },
      grid: { vertLines: { color: '#16212b' }, horzLines: { color: '#16212b' } },
      rightPriceScale: { borderColor: '#263340' },
      timeScale: { borderColor: '#263340', timeVisible: true },
      crosshair: { mode: 1 }
    });
    const series = chart.addLineSeries({ color: '#2dd4bf', lineWidth: 2 });
    series.setData(data);
    chart.timeScale().fitContent();
    const resize = () => chart.applyOptions({ width: ref.current.clientWidth });
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, [symbol, JSON.stringify(data)]);

  return (
    <div className="mb-4 rounded border border-line bg-ink p-3">
      <div className="mb-2 text-xs font-semibold uppercase text-slate-500">{symbol} Recent 5-Minute Price</div>
      <div ref={ref} className="h-[220px] w-full" />
    </div>
  );
}

function ReviewTradeModal({ review, status, error, onClose, onApprove }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const signal = review?.signal || {};
  const sizing = review?.sizing || {};
  const checklist = review?.checklist || {};
  const checklistLabels = {
    priceAboveVwap: 'Price above VWAP',
    ema9AboveEma20: 'EMA9 above EMA20',
    breakoutAboveRecentHigh: 'Breakout above recent high',
    volumeAboveAverage: 'Volume above average',
    spreadAcceptable: 'Spread acceptable',
    marketRegimeAllowsLong: 'Market regime allows long',
    symbolTradable: 'Symbol tradable',
    symbolNotBlocked: 'Symbol not blocked'
  };
  const remaining = review?.expiresAt ? Math.max(0, Math.ceil((new Date(review.expiresAt).getTime() - now) / 1000)) : Number(review?.secondsRemaining || 0);
  const blockedByChase = review?.noChase?.status?.startsWith('BLOCKED');
  const busy = Boolean(status && !['ready', 'error', 'approval_failed'].includes(status));
  const approvalDisabled = busy || remaining <= 0 || blockedByChase;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-lg border border-line bg-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white">Pre-Trade Review</h3>
            <p className="text-sm text-slate-400">Informational preview only. Approval runs live risk checks again.</p>
          </div>
          <button onClick={onClose} className="rounded border border-line p-2 text-slate-300 hover:bg-panel2"><X size={16} /></button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Symbol" value={signal.symbol} />
          <Metric label="Direction" value={signal.direction} />
          <Metric label="Current Price" value={money(review.latest?.currentPrice)} />
          <Metric label="Suggested Entry" value={money(signal.entry_price)} />
          <Metric label="Stop Loss" value={money(signal.stop_loss)} tone="text-loss" />
          <Metric label="Take Profit" value={money(signal.take_profit)} tone="text-gain" />
          <Metric label="Planned Risk" value={money(sizing.plannedRiskDollars)} />
          <Metric label="Planned Reward" value={money(sizing.plannedRewardDollars)} />
          <Metric label="Planned R/R" value={Number(sizing.plannedRr || 0).toFixed(2)} />
          <Metric label="Notional" value={money(sizing.positionNotional)} />
          <Metric label="Quantity" value={Number(sizing.quantity || 0).toFixed(sizing.fractionalQuantity ? 6 : 0)} />
          <Metric label="Protection" value={review.protectionMode} />
          <Metric label="Market Regime" value={review.marketRegime} />
          <Metric label="Scanner Preset" value={review.scannerPreset} />
          <Metric label="Confidence" value={Number(review.confidenceScore || 0).toFixed(2)} />
          <Metric label="Spread" value={pct(review.latest?.spreadPercent)} />
          <Metric label="Time Remaining" value={countdown(remaining)} tone={remaining <= 0 ? 'text-loss' : remaining < 60 ? 'text-amber-300' : 'text-gain'} />
          <Metric label="Signal Price" value={money(review.noChase?.signalPrice)} />
          <Metric label="Review Price" value={money(review.noChase?.reviewPrice)} />
          <Metric label="Slippage" value={pct(review.noChase?.slippagePercent)} tone={Number(review.noChase?.slippagePercent || 0) > Number(review.noChase?.maxEntrySlippagePercent || 0) ? 'text-loss' : 'text-gain'} />
        </div>
        <div className="mt-4 rounded border border-line bg-ink p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs text-slate-500">No-Chase Status</div>
              <div className="mt-1"><Badge tone={blockedByChase ? 'bad' : review.noChase?.status?.startsWith('WARNING') ? 'warn' : 'good'}>{review.noChase?.status || 'SAFE TO REVIEW'}</Badge></div>
            </div>
            <div className="text-sm text-slate-400">Distance from signal: <span className="text-white">{pct(review.noChase?.extensionPercent)}</span></div>
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded border border-line bg-ink p-3">
            <div className="mb-2 text-sm font-semibold text-slate-300">Setup Checklist</div>
            <div className="grid gap-2">
              {Object.entries(checklistLabels).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-300">{label}</span>
                  <Badge tone={checklist[key] ? 'good' : 'bad'}>{checklist[key] ? 'PASS' : 'WARN'}</Badge>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded border border-line bg-ink p-3">
            <div className="mb-2 text-sm font-semibold text-slate-300">Why This Could Fail</div>
            <div className="space-y-1 text-sm text-slate-400">
              {(review.warnings || []).map((item) => <div key={item}>{item}</div>)}
            </div>
          </div>
        </div>
        {review.rejectReasons?.length > 0 && (
          <div className="mt-4 rounded border border-loss bg-loss/10 p-3 text-sm text-rose-200">
            Risk preview blocks approval: {review.rejectReasons.join('; ')}
          </div>
        )}
        {remaining <= 0 && <div className="mt-4 rounded border border-loss bg-loss/10 p-3 text-sm text-rose-200">This signal expired while the review was open. Approval is disabled.</div>}
        {error && <div className="mt-4 rounded border border-loss bg-loss/10 p-3 text-sm text-rose-200">{error}</div>}
        {status && <div className="mt-4"><Badge tone={status.includes('failed') || status === 'error' ? 'bad' : status.includes('submitted') ? 'good' : 'warn'}>{status}</Badge></div>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-line px-4 py-2 text-sm text-slate-300 hover:bg-panel2">Close</button>
          <button disabled={approvalDisabled} onClick={onApprove} className="inline-flex items-center gap-2 rounded bg-gain px-4 py-2 text-sm font-bold text-ink disabled:opacity-50">
            {busy && <RefreshCw size={15} className="animate-spin" />}
            Approve From Review
          </button>
        </div>
      </div>
    </div>
  );
}

function Signals({ signals, refresh, scan, accountData }) {
  const [busyId, setBusyId] = useState('');
  const [rowError, setRowError] = useState({});
  const [review, setReview] = useState(null);
  const [reviewStatus, setReviewStatus] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const pendingSignals = useMemo(() => signals.filter((row) => row.status === 'pending'), [signals]);
  const historySignals = useMemo(() => signals.filter((row) => row.status !== 'pending'), [signals]);
  const recentHistory = useMemo(() => historySignals.slice(0, 25), [historySignals]);
  const historyCounts = useMemo(() => historySignals.reduce((counts, row) => ({
    ...counts,
    [row.status]: (counts[row.status] || 0) + 1
  }), {}), [historySignals]);

  const act = async (id, action) => {
    setBusyId(id);
    setRowError((current) => ({ ...current, [id]: '' }));
    try {
      if (action === 'approve') {
        if (!window.confirm('Approve this signal and submit it through the backend risk engine?')) return;
        await api.approveSignal(id);
      } else {
        await api.rejectSignal(id);
      }
      await refresh();
    } catch (error) {
      setRowError((current) => ({ ...current, [id]: error.message }));
    } finally {
      setBusyId('');
    }
  };

  const openReview = async (id) => {
    setBusyId(id);
    setReviewError('');
    setReviewStatus('loading_review');
    try {
      const data = await api.signalReview(id);
      setReview(data);
      setReviewStatus('ready');
    } catch (error) {
      setReviewError(error.message);
      setReviewStatus('error');
    } finally {
      setBusyId('');
    }
  };

  const approveFromReview = async () => {
    if (!review?.signal?.id) return;
    setReviewError('');
    setReviewStatus('running_live_risk_check');
    try {
      await api.approveSignal(review.signal.id);
      setReviewStatus('order_submitted');
      await refresh();
      setReview(null);
    } catch (error) {
      setReviewError(error.message);
      setReviewStatus('approval_failed');
    }
  };

  return (
    <Card title="Signals" icon={ListChecks}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
          <span>Pending: <span className="font-semibold text-white">{pendingSignals.length}</span></span>
          <span>Hidden history: <span className="font-semibold text-white">{historySignals.length}</span></span>
          {Object.entries(historyCounts).map(([status, count]) => (
            <Badge key={status} tone={status === 'approved' ? 'good' : status === 'expired' || status === 'risk_rejected' ? 'bad' : 'neutral'}>{status}: {count}</Badge>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowHistory((value) => !value)} className="rounded border border-line px-3 py-2 text-sm text-slate-300 hover:bg-panel2">
            {showHistory ? 'Hide History' : 'Show History'}
          </button>
          <button onClick={scan} className="flex items-center gap-2 rounded border border-line px-3 py-2 text-sm hover:bg-panel2">
            <RefreshCw size={16} /> Scan Watchlist
          </button>
        </div>
      </div>
      <Table columns={['Ticker', 'Side', 'Entry', 'Stop', 'Target', 'Risk', 'R/R', 'Confidence', 'Countdown', 'Stale', 'Regime', 'Protection', 'Status', 'Reason', 'Action']} rows={pendingSignals} render={(row) => {
        const remaining = row.status === 'pending' ? Math.max(0, Math.ceil((new Date(row.expires_at || 0).getTime() - now) / 1000)) : 0;
        const expired = row.status === 'expired' || Boolean(row.expired_at) || (row.status === 'pending' && remaining <= 0);
        const needsReview = row.status === 'pending' && !row.last_reviewed_at;
        return (
          <tr key={row.id}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2"><Badge tone={row.direction === 'BUY' ? 'good' : 'bad'}>{row.direction}</Badge></td>
            <td className="px-3 py-2">{money(row.entry_price)}</td>
            <td className="px-3 py-2 text-loss">{money(row.stop_loss)}</td>
            <td className="px-3 py-2 text-gain">{money(row.take_profit)}</td>
            <td className="px-3 py-2">{money(Math.abs(Number(row.entry_price) - Number(row.stop_loss)))}</td>
            <td className="px-3 py-2">{(Math.abs(Number(row.take_profit) - Number(row.entry_price)) / Math.max(0.01, Math.abs(Number(row.entry_price) - Number(row.stop_loss)))).toFixed(2)}</td>
            <td className="px-3 py-2">{Number(row.confidence_score || row.confidence || 0).toFixed(2)}</td>
            <td className="px-3 py-2"><Badge tone={expired ? 'bad' : remaining < 60 ? 'warn' : 'good'}>{row.status === 'pending' ? countdown(remaining) : '-'}</Badge></td>
            <td className="px-3 py-2"><Badge tone={expired ? 'bad' : row.stale_status === 'expiring_soon' || row.stale_status === 'moving' ? 'warn' : 'neutral'}>{row.expiration_reason || row.stale_status || 'fresh'}</Badge></td>
            <td className="px-3 py-2"><Badge tone={accountData?.marketRegime?.regime === 'BULLISH' ? 'good' : accountData?.marketRegime?.regime === 'BEARISH' ? 'bad' : 'neutral'}>{accountData?.marketRegime?.regime || 'NEUTRAL'}</Badge></td>
            <td className="px-3 py-2"><Badge tone="warn">AUTO</Badge></td>
            <td className="px-3 py-2"><Badge tone={row.status === 'pending' ? 'warn' : row.status === 'approved' ? 'good' : row.status === 'expired' ? 'bad' : 'neutral'}>{row.status}</Badge></td>
            <td className="max-w-[260px] px-3 py-2 text-xs text-slate-400">{row.reason || '-'}</td>
            <td className="min-w-[260px] px-3 py-2">
              {row.status === 'pending' && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    <button disabled={busyId === row.id} onClick={() => openReview(row.id)} className="inline-flex items-center gap-1 rounded border border-line px-3 py-2 text-xs font-bold text-slate-200 hover:bg-panel2 disabled:opacity-60">
                      <ListChecks size={14} /> Review Trade
                    </button>
                    <button disabled={busyId === row.id || expired || needsReview} onClick={() => act(row.id, 'approve')} className="inline-flex items-center gap-1 rounded bg-gain px-3 py-2 text-xs font-bold text-ink disabled:opacity-60">
                      <Check size={14} /> {needsReview ? 'Review Required' : 'Approve'}
                    </button>
                    <button disabled={busyId === row.id} onClick={() => act(row.id, 'reject')} className="inline-flex items-center gap-1 rounded bg-loss px-3 py-2 text-xs font-bold text-white disabled:opacity-60">
                      <X size={14} /> Reject
                    </button>
                  </div>
                  {expired && <div className="max-w-[240px] text-xs text-loss">{row.expiration_reason || 'Signal expired'}</div>}
                  {needsReview && !expired && <div className="max-w-[240px] text-xs text-amber-300">Fresh review required before approval.</div>}
                  {rowError[row.id] && <div className="max-w-[240px] text-xs text-loss">{rowError[row.id]}</div>}
                </div>
              )}
            </td>
          </tr>
        );
      }} />
      {showHistory && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-300">Recent Resolved Signals</div>
            <div className="text-xs text-slate-500">Showing {recentHistory.length} of {historySignals.length}; records are preserved in the database.</div>
          </div>
          <Table columns={['Ticker', 'Side', 'Entry', 'Target', 'Confidence', 'Status', 'Reason', 'Created']} rows={recentHistory} render={(row) => (
            <tr key={`history-${row.id}`}>
              <td className="px-3 py-2 font-bold">{row.symbol}</td>
              <td className="px-3 py-2"><Badge tone={row.direction === 'BUY' ? 'good' : 'bad'}>{row.direction}</Badge></td>
              <td className="px-3 py-2">{money(row.entry_price)}</td>
              <td className="px-3 py-2 text-gain">{money(row.take_profit)}</td>
              <td className="px-3 py-2">{Number(row.confidence_score || row.confidence || 0).toFixed(2)}</td>
              <td className="px-3 py-2"><Badge tone={row.status === 'approved' ? 'good' : row.status === 'expired' || row.status === 'risk_rejected' ? 'bad' : 'neutral'}>{row.status}</Badge></td>
              <td className="px-3 py-2 text-slate-400">{row.expiration_reason || row.stale_status || row.reason || '-'}</td>
              <td className="px-3 py-2 text-slate-400">{row.created_at || '-'}</td>
            </tr>
          )} />
        </div>
      )}
      {review && <ReviewTradeModal review={review} status={reviewStatus} error={reviewError} onClose={() => setReview(null)} onApprove={approveFromReview} />}
    </Card>
  );
}

function Trades({ orders, performance }) {
  const local = orders?.localOrders || [];
  return (
    <div className="grid gap-4">
      <Card title="Performance" icon={Gauge}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Closed P/L" value={money(performance?.pnl)} tone={Number(performance?.pnl) >= 0 ? 'text-gain' : 'text-loss'} />
          <Metric label="Trades" value={performance?.tradeCount || 0} />
          <Metric label="System Logs" value={performance?.logs?.length || 0} />
        </div>
      </Card>
      <Card title="Orders" icon={Activity}>
        <Table columns={['Symbol', 'Side', 'Notional', 'Status', 'Alpaca ID', 'Created']} rows={local} render={(row) => (
          <tr key={row.id}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2">{row.side}</td>
            <td className="px-3 py-2">{money(row.notional)}</td>
            <td className="px-3 py-2"><Badge>{row.status}</Badge></td>
            <td className="px-3 py-2 text-slate-400">{row.alpaca_order_id}</td>
            <td className="px-3 py-2 text-slate-400">{row.created_at}</td>
          </tr>
        )} />
      </Card>
    </div>
  );
}

function MiniBars({ rows, valueKey = 'totalPnl', labelKey = 'name' }) {
  const max = Math.max(1, ...rows.map((row) => Math.abs(Number(row[valueKey] || 0))));
  return (
    <div className="space-y-2">
      {rows.length === 0 ? <div className="text-sm text-slate-500">No data yet.</div> : rows.slice(0, 8).map((row) => {
        const value = Number(row[valueKey] || 0);
        return (
          <div key={row[labelKey] || row.day} className="grid grid-cols-[110px_1fr_80px] items-center gap-2 text-xs">
            <div className="truncate text-slate-400">{row[labelKey] || row.day}</div>
            <div className="h-2 rounded bg-panel2">
              <div className={`h-2 rounded ${value >= 0 ? 'bg-gain' : 'bg-loss'}`} style={{ width: `${Math.max(4, (Math.abs(value) / max) * 100)}%` }} />
            </div>
            <div className={value >= 0 ? 'text-gain' : 'text-loss'}>{money(value)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Journal({ journal, summary, daily, strategy, symbols, outcomes, refreshJournal }) {
  const rows = journal?.rows || [];
  const tags = journal?.mistakeTags || [];
  const outcomeRows = Array.isArray(outcomes) ? outcomes : outcomes?.rows || [];
  const fallbackOutcomeStats = useMemo(() => {
    const expired = outcomeRows.filter((row) => row.status === 'expired');
    const wouldHaveWon = expired.filter((row) => row.target_hit_first).length;
    const wouldHaveLost = expired.filter((row) => row.stop_hit_first).length;
    const resolved = wouldHaveWon + wouldHaveLost;
    return {
      expiredSignals: expired.length,
      wouldHaveWon,
      wouldHaveLost,
      winRateIfApproved: resolved ? (wouldHaveWon / resolved) * 100 : 0
    };
  }, [outcomeRows]);
  const outcomeStats = Array.isArray(outcomes) ? fallbackOutcomeStats : outcomes?.stats || fallbackOutcomeStats;
  const [drafts, setDrafts] = useState({});
  const setDraft = (id, patch) => setDrafts((current) => ({ ...current, [id]: { ...(current[id] || {}), ...patch } }));
  const save = async (row) => {
    const draft = drafts[row.id] || {};
    const mistakeTags = draft.mistake_tags !== undefined ? draft.mistake_tags : parseTags(row.mistake_tags);
    await api.updateJournalNotes(row.id, { notes: draft.notes ?? row.notes ?? '', mistake_tags: mistakeTags });
    await refreshJournal();
  };

  return (
    <div className="grid gap-4">
      <Card title="Performance Summary" icon={Gauge}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Total Trades" value={summary?.totalTrades || 0} />
          <Metric label="Win Rate" value={`${Number(summary?.winRate || 0).toFixed(1)}%`} />
          <Metric label="Profit Factor" value={Number(summary?.profitFactor || 0).toFixed(2)} />
          <Metric label="Expectancy" value={money(summary?.expectancy)} tone={Number(summary?.expectancy || 0) >= 0 ? 'text-gain' : 'text-loss'} />
          <Metric label="Average Win" value={money(summary?.averageWin)} tone="text-gain" />
          <Metric label="Average Loss" value={money(summary?.averageLoss)} tone="text-loss" />
          <Metric label="Max Drawdown" value={money(summary?.maxDrawdown)} tone="text-loss" />
          <Metric label="Best Symbol" value={summary?.bestSymbol?.name || '-'} />
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Daily P/L" icon={Activity}><MiniBars rows={daily || []} valueKey="totalPnl" labelKey="day" /></Card>
        <Card title="Performance By Symbol" icon={LineChart}><MiniBars rows={symbols || []} /></Card>
        <Card title="Strategy Stats" icon={ListChecks}><MiniBars rows={strategy || []} /></Card>
        <Card title="Equity Curve" icon={Gauge}><MiniBars rows={summary?.equityCurve || []} valueKey="equity" labelKey="date" /></Card>
      </div>
      <Card title="Trade Journal" icon={ListChecks}>
        <Table columns={['Symbol', 'Strategy', 'Entry/Exit', 'P/L', 'R/R', 'Duration', 'Regime', 'Exit', 'Notes']} rows={rows} render={(row) => {
          const draft = drafts[row.id] || {};
          const selectedTags = draft.mistake_tags !== undefined ? draft.mistake_tags : parseTags(row.mistake_tags);
          return (
            <tr key={row.id}>
              <td className="px-3 py-2 font-bold">{row.symbol}</td>
              <td className="px-3 py-2">{row.strategy_name}</td>
              <td className="px-3 py-2">{money(row.entry_price)} / {money(row.exit_price)}</td>
              <td className={`px-3 py-2 ${Number(row.realized_pnl) >= 0 ? 'text-gain' : 'text-loss'}`}>{money(row.realized_pnl)}<div className="text-xs text-slate-500">{pct(row.realized_pnl_percent)}</div></td>
              <td className="px-3 py-2">{Number(row.rr_planned || 0).toFixed(2)} / {Number(row.rr_actual || 0).toFixed(2)}</td>
              <td className="px-3 py-2">{formatDuration(row.duration_seconds)}</td>
              <td className="px-3 py-2"><Badge>{row.market_regime || 'NEUTRAL'}</Badge></td>
              <td className="px-3 py-2">{row.exit_reason}</td>
              <td className="min-w-[280px] px-3 py-2">
                <textarea className="h-16 w-full rounded border border-line bg-ink p-2 text-sm text-white" value={draft.notes ?? row.notes ?? ''} onChange={(event) => setDraft(row.id, { notes: event.target.value })} />
                <div className="mt-2 flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <button key={tag} onClick={() => {
                      const next = selectedTags.includes(tag) ? selectedTags.filter((item) => item !== tag) : [...selectedTags, tag];
                      setDraft(row.id, { mistake_tags: next });
                    }} className={`rounded px-2 py-1 text-xs ${selectedTags.includes(tag) ? 'bg-amber-500/20 text-amber-200' : 'bg-panel2 text-slate-400'}`}>{tag}</button>
                  ))}
                </div>
                <button onClick={() => save(row)} className="mt-2 rounded bg-gain px-3 py-2 text-xs font-bold text-ink">Save Notes</button>
              </td>
            </tr>
          );
        }} />
      </Card>
      <Card title="Signal Outcomes" icon={Activity}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Expired Signals" value={outcomeStats.expiredSignals || 0} />
          <Metric label="Would Have Won" value={outcomeStats.wouldHaveWon || 0} tone="text-gain" />
          <Metric label="Would Have Lost" value={outcomeStats.wouldHaveLost || 0} tone="text-loss" />
          <Metric label="Win Rate If Approved" value={`${Number(outcomeStats.winRateIfApproved || 0).toFixed(1)}%`} />
        </div>
        <Table columns={['Symbol', 'Direction', 'Confidence', 'Status', 'Entry', 'Stop', 'Target', 'Outcome', 'MFE', 'MAE', 'Target Hit', 'Stop Hit', 'Outcome Grade', 'Regime', 'Generated']} rows={outcomeRows} render={(row) => (
          <tr key={row.signal_id}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2"><Badge tone={row.direction === 'BUY' ? 'good' : 'bad'}>{row.direction}</Badge></td>
            <td className="px-3 py-2">{Number(row.confidence || 0).toFixed(2)}</td>
            <td className="px-3 py-2"><Badge>{row.status}</Badge></td>
            <td className="px-3 py-2">{money(row.entry)}</td>
            <td className="px-3 py-2 text-loss">{money(row.stop_loss)}</td>
            <td className="px-3 py-2 text-gain">{money(row.take_profit)}</td>
            <td className="px-3 py-2"><Badge tone={row.target_hit_first ? 'good' : row.stop_hit_first ? 'bad' : 'neutral'}>{String(row.outcome || 'pending_analysis').replaceAll('_', ' ')}</Badge></td>
            <td className="px-3 py-2 text-gain">{pct(row.max_favorable_excursion ?? row.max_favorable_move)}</td>
            <td className="px-3 py-2 text-loss">{pct(row.max_adverse_excursion ?? row.max_adverse_move)}</td>
            <td className="px-3 py-2"><Badge tone={row.target_hit_first ? 'good' : row.would_hit_target ? 'warn' : 'neutral'}>{row.target_hit_first ? 'First' : row.would_hit_target ? 'Yes' : 'No'}</Badge></td>
            <td className="px-3 py-2"><Badge tone={row.stop_hit_first ? 'bad' : row.would_hit_stop ? 'warn' : 'neutral'}>{row.stop_hit_first ? 'First' : row.would_hit_stop ? 'Yes' : 'No'}</Badge></td>
            <td className="px-3 py-2"><Badge tone={['A', 'B'].includes(row.outcome_grade) ? 'good' : ['D', 'F'].includes(row.outcome_grade) ? 'bad' : 'neutral'}>{row.outcome_grade || '-'}</Badge></td>
            <td className="px-3 py-2">{row.market_regime}</td>
            <td className="px-3 py-2 text-slate-400">{row.generated_at}</td>
          </tr>
        )} />
      </Card>
    </div>
  );
}

function parseTags(value) {
  if (Array.isArray(value)) return value;
  try {
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return '-';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}

function ActivityFeed({ events }) {
  return (
    <Card title="Live Activity" icon={Activity}>
      <div className="max-h-[360px] space-y-2 overflow-y-auto">
        {events.length === 0 ? <div className="text-sm text-slate-500">No system events yet.</div> : events.map((event) => (
          <div key={event.id} className="rounded border border-line bg-ink p-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <Badge tone={event.severity === 'critical' ? 'bad' : event.severity === 'warn' ? 'warn' : 'neutral'}>{event.category}</Badge>
              <span className="text-xs text-slate-500">{event.created_at}</span>
            </div>
            <div className="mt-1 text-slate-200">{event.message}</div>
            {event.event === 'opportunity_alert' && (
              <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-100">
                <div>Current score: {Number(event.payload?.score || 0).toFixed(1)}</div>
                {(event.payload?.needs || []).length > 0 && (
                  <div className="mt-1">
                    <div className="uppercase text-amber-200/70">Needs</div>
                    <div className="space-y-0.5">{event.payload.needs.map((need) => <div key={need}>{need}</div>)}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function MonitoredPositions({ rows, refresh }) {
  const exitNow = async (id) => {
    if (!window.confirm('Submit a manual market exit for this monitored position?')) return;
    await api.exitMonitoredPosition(id);
    refresh();
  };
  return (
    <Card title="Monitored Positions" icon={Shield}>
      <Table columns={['Symbol', 'Qty', 'Notional', 'Entry', 'Current', 'Stop', 'Target', 'P/L', 'Status', 'Last Check', 'Action']} rows={rows} render={(row) => {
        const pnl = (Number(row.current_price || row.entry_price) - Number(row.entry_price)) * Number(row.qty || 0);
        return (
          <tr key={row.id}>
            <td className="px-3 py-2 font-bold">{row.symbol}</td>
            <td className="px-3 py-2">{Number(row.qty || 0).toFixed(6)}</td>
            <td className="px-3 py-2">{money(row.notional)}</td>
            <td className="px-3 py-2">{money(row.entry_price)}</td>
            <td className="px-3 py-2">{money(row.current_price)}</td>
            <td className="px-3 py-2 text-loss">{money(row.stop_loss)}</td>
            <td className="px-3 py-2 text-gain">{money(row.take_profit)}</td>
            <td className={`px-3 py-2 ${pnl >= 0 ? 'text-gain' : 'text-loss'}`}>{money(pnl)}</td>
            <td className="px-3 py-2"><Badge tone={row.status === 'manual_attention_required' || row.status === 'stale' ? 'bad' : row.status === 'open' ? 'good' : 'neutral'}>{row.status}</Badge></td>
            <td className="px-3 py-2 text-slate-400">{row.last_checked_at || '-'}</td>
            <td className="px-3 py-2">{!['closed', 'exiting'].includes(row.status) && <button onClick={() => exitNow(row.id)} className="rounded bg-loss px-3 py-2 text-xs font-bold text-white">Manual Exit</button>}</td>
          </tr>
        );
      }} />
    </Card>
  );
}

function LiveReadinessChecklist({ accountData, monitor }) {
  const settings = accountData?.settings || {};
  const mode = accountData?.mode || '';
  const row = (label, ready) => ({ label, ready });
  const items = [
    row('Coinbase connected', accountData?.credentialStatus === 'CONNECTED' || accountData?.account?.status === 'CONNECTED'),
    row('USD balance > $0', Number(accountData?.account?.cash || 0) > 0),
    row('Kill switch off', settings.kill_switch !== 'true'),
    row('Auto execution off', settings.auto_execution !== 'true' && !mode.includes('AUTO')),
    row('Manual approval on', mode === 'SAFE_MANUAL_APPROVAL' || !mode.includes('AUTO')),
    row('Monitor online', Boolean(monitor && Number(monitor.intervalMs || 0) > 0)),
    row('Max daily loss set', Number(settings.crypto_max_daily_loss_percent || settings.max_daily_loss_percent || 0) > 0),
    row('Max position % set', Number(settings.crypto_max_account_position_percent || settings.max_account_position_percent || 0) > 0),
    row('Signals require review', accountData?.signalReviewRequired !== false)
  ];
  const readyCount = items.filter((item) => item.ready).length;

  return (
    <Card title="Live Readiness Checklist" icon={ListChecks}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Badge tone={readyCount === items.length ? 'good' : 'warn'}>{readyCount}/{items.length} ready</Badge>
        <span className="text-xs text-slate-500">Manual-first safety checks</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="flex min-h-10 items-center gap-2 rounded border border-line bg-ink px-3 py-2 text-sm text-slate-300">
            <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${item.ready ? 'bg-gain/15 text-gain' : 'bg-loss/15 text-loss'}`}>
              {item.ready ? <Check size={13} /> : <X size={13} />}
            </span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StrategySettings({ accountData, refresh }) {
  const settings = accountData?.settings || {};
  const [form, setForm] = useState(settings);
  useEffect(() => setForm(settings), [JSON.stringify(settings)]);
  const autoAllowed = accountData?.autoExecutionEnv === true;
  const scannerFrequencyOptions = [
    [15, '15 seconds'],
    [30, '30 seconds'],
    [60, '1 minute'],
    [120, '2 minutes'],
    [300, '5 minutes'],
    [600, '10 minutes'],
    [900, '15 minutes']
  ];
  const scannerFrequencyMs = String(Number(form.crypto_scanner_interval_ms || 60000));
  const normalizedScannerFrequencyMs = scannerFrequencyOptions.some(([seconds]) => String(seconds * 1000) === scannerFrequencyMs)
    ? scannerFrequencyMs
    : '60000';

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    await api.settings(form);
    refresh();
  };

  return (
    <Card title="Strategy Settings" icon={Settings}>
      <div className="grid gap-4 md:grid-cols-2">
        <Toggle label="Strategy Enabled" value={form.strategy_enabled === 'true'} onChange={(value) => set('strategy_enabled', String(value))} />
        <Field label="Risk Amount" value={form.risk_amount} onChange={(value) => set('risk_amount', value)} />
        <Field label="Position Size Cap" value={form.position_size_cap} onChange={(value) => set('position_size_cap', value)} />
        <Field label="Risk Per Trade %" value={form.risk_per_trade_percent} onChange={(value) => set('risk_per_trade_percent', value)} />
        <Field label="Max Account Position %" value={form.max_account_position_percent} onChange={(value) => set('max_account_position_percent', value)} />
        <Field label="Max Daily Loss %" value={form.max_daily_loss_percent} onChange={(value) => set('max_daily_loss_percent', value)} />
        <Field label="Min Notional Order" value={form.min_notional_order} onChange={(value) => set('min_notional_order', value)} />
        <Field label="Protection Mode" value={form.protection_mode} onChange={(value) => set('protection_mode', value)} />
        <Field label="Monitor Interval MS" value={form.monitored_exit_interval_ms} onChange={(value) => set('monitored_exit_interval_ms', value)} />
        <Field label="Max Stale Seconds" value={form.monitored_exit_max_stale_seconds} onChange={(value) => set('monitored_exit_max_stale_seconds', value)} />
        <div className="rounded border border-line bg-ink p-3 md:col-span-2">
          <Toggle label="Auto Crypto Scanner" value={form.auto_crypto_scanner !== 'false'} onChange={(value) => set('auto_crypto_scanner', String(value))} />
          <label className="mt-3 block rounded border border-line bg-panel p-3 text-sm text-slate-400">
            Scan Every
            <select
              className="mt-2 w-full rounded border border-line bg-ink px-3 py-2 text-white"
              value={normalizedScannerFrequencyMs}
              onChange={(event) => set('crypto_scanner_interval_ms', event.target.value)}
            >
              {scannerFrequencyOptions.map(([seconds, label]) => <option key={seconds} value={seconds * 1000}>{label}</option>)}
            </select>
          </label>
          <p className="mt-2 text-xs text-slate-500">This changes scanning only, not auto execution.</p>
        </div>
        <Field label="Stop Loss Percent" value={form.stop_loss_percent} onChange={(value) => set('stop_loss_percent', value)} />
        <Field label="Take Profit Percent" value={form.take_profit_percent} onChange={(value) => set('take_profit_percent', value)} />
        <Field label="Trading Window" value={form.trading_window} onChange={(value) => set('trading_window', value)} />
        <Toggle label="Allow Fractional Entries" value={form.allow_fractional_entries === 'true'} onChange={(value) => set('allow_fractional_entries', String(value))} />
        <Toggle label="Monitored Fractional Exits" value={form.allow_monitored_fractional_exits === 'true'} onChange={(value) => set('allow_monitored_fractional_exits', String(value))} />
        <Toggle label="Trade Context Symbols" value={form.enable_context_symbol_trading === 'true'} onChange={(value) => set('enable_context_symbol_trading', String(value))} />
        <Field label="Min Price" value={form.min_price} onChange={(value) => set('min_price', value)} />
        <Field label="Max Price" value={form.max_price} onChange={(value) => set('max_price', value)} />
        <Field label="Min Daily Volume" value={form.min_daily_volume} onChange={(value) => set('min_daily_volume', value)} />
        <Field label="Min Relative Volume" value={form.min_relative_volume} onChange={(value) => set('min_relative_volume', value)} />
        <Field label="Max Spread %" value={form.max_spread_percent} onChange={(value) => set('max_spread_percent', value)} />
        <Field label="Min Percent Change" value={form.min_percent_change} onChange={(value) => set('min_percent_change', value)} />
        <Field label="Max Scanner Results" value={form.max_results} onChange={(value) => set('max_results', value)} />
        <div className="rounded border border-line bg-ink p-3 md:col-span-2">
          <Toggle
            label="Auto Execution"
            value={form.auto_execution === 'true'}
            disabled={!autoAllowed}
            onChange={(value) => {
              if (value && !window.confirm('Enable autonomous live order submission? Risk checks remain active.')) return;
              set('auto_execution', String(value));
            }}
          />
          <p className="mt-2 text-xs text-slate-500">{autoAllowed ? 'Environment allows auto execution.' : 'Locked until AUTO_EXECUTION=true is set in .env and the backend is restarted.'}</p>
        </div>
      </div>
      <button onClick={save} className="mt-4 rounded bg-gain px-4 py-2 font-semibold text-ink">Save Settings</button>
    </Card>
  );
}

function Field({ label, value, onChange }) {
  return <label className="block rounded border border-line bg-ink p-3 text-sm text-slate-400">{label}<input className="mt-2 w-full rounded border border-line bg-panel px-3 py-2 text-white" value={value || ''} onChange={(event) => onChange(event.target.value)} /></label>;
}

function Toggle({ label, value, onChange, disabled = false }) {
  return (
    <label className={`flex items-center justify-between rounded border border-line bg-ink p-3 text-sm ${disabled ? 'opacity-50' : ''}`}>
      <span>{label}</span>
      <button type="button" disabled={disabled} onClick={() => onChange(!value)} className={`h-7 w-12 rounded-full p-1 transition ${value ? 'bg-gain' : 'bg-slate-700'}`}>
        <span className={`block h-5 w-5 rounded-full bg-white transition ${value ? 'translate-x-5' : ''}`} />
      </button>
    </label>
  );
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className={`fixed right-4 top-4 z-[60] max-w-sm rounded border p-3 text-sm shadow-2xl ${toast.tone === 'bad' ? 'border-loss bg-rose-950 text-rose-100' : 'border-gain bg-emerald-950 text-emerald-100'}`}>
      <div className="flex items-start justify-between gap-3">
        <span>{toast.message}</span>
        <button onClick={onClose} className="text-slate-300 hover:text-white"><X size={14} /></button>
      </div>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState('Dashboard');
  const [accountData, setAccountData] = useState(null);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState({ localOrders: [], liveOrders: [] });
  const [watchlist, setWatchlist] = useState([]);
  const [universe, setUniverse] = useState([]);
  const [scanner, setScanner] = useState(null);
  const [cryptoDashboard, setCryptoDashboard] = useState(null);
  const [cryptoScanner, setCryptoScanner] = useState(null);
  const [cryptoScannerSettings, setCryptoScannerSettings] = useState(null);
  const [cryptoStrategySettings, setCryptoStrategySettings] = useState(null);
  const [nearMissAnalyticsData, setNearMissAnalyticsData] = useState(null);
  const [scannerSettingsData, setScannerSettingsData] = useState(null);
  const [blocked, setBlocked] = useState([]);
  const [signals, setSignals] = useState([]);
  const [performance, setPerformance] = useState(null);
  const [journal, setJournal] = useState({ rows: [], mistakeTags: [] });
  const [performanceSummary, setPerformanceSummary] = useState(null);
  const [performanceDaily, setPerformanceDaily] = useState([]);
  const [performanceStrategy, setPerformanceStrategy] = useState([]);
  const [performanceSymbols, setPerformanceSymbols] = useState([]);
  const [signalOutcomes, setSignalOutcomes] = useState([]);
  const [events, setEvents] = useState([]);
  const [clock, setClock] = useState(null);
  const [monitor, setMonitor] = useState(null);
  const [monitoredPositions, setMonitoredPositions] = useState([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState('');
  const [lastLiveUpdate, setLastLiveUpdate] = useState(null);
  const [closeStatuses, setCloseStatuses] = useState({});
  const [toast, setToast] = useState(null);

  const tabs = useMemo(() => ['Dashboard', 'Crypto Scanner', 'Signals', 'Positions', 'Journal', 'Settings', 'Stocks Module'], []);
  const refreshJournal = async () => {
    const [journalRows, summary, dailyRows, strategyRows, symbolRows, outcomes] = await Promise.all([
      api.journal(),
      api.performanceSummary(),
      api.performanceDaily(),
      api.performanceStrategy(),
      api.performanceSymbols(),
      api.signalOutcomes()
    ]);
    setJournal(journalRows);
    setPerformanceSummary(summary);
    setPerformanceDaily(dailyRows);
    setPerformanceStrategy(strategyRows);
    setPerformanceSymbols(symbolRows);
    setSignalOutcomes(outcomes);
  };
  const refresh = async () => {
    try {
      setError('');
      const [account, positionRows, orderRows, signalRows, perf, eventRows, monitorRows, monitorState, marketClock] = await Promise.all([
        api.account(),
        api.positions(),
        api.orders(),
        api.signals(),
        api.performance(),
        api.events(),
        api.monitoredPositions(),
        api.monitorStatus(),
        api.marketClock()
      ]);
      setAccountData(account);
      setPositions(positionRows);
      setOrders(orderRows);
      setSignals(signalRows);
      setPerformance(perf);
      setEvents(eventRows);
      setMonitoredPositions(monitorRows);
      setMonitor(monitorState);
      setClock(marketClock);
      setLastLiveUpdate(new Date());
      const lists = await api.watchlists();
      setUniverse(lists.tradingUniverse || []);
      setBlocked(lists.blocked || []);
      setScannerSettingsData(await api.scannerSettings());
      setCryptoDashboard(await api.cryptoDashboard());
      setCryptoScannerSettings(await api.cryptoScannerSettings());
      setCryptoStrategySettings(await api.cryptoStrategySettings());
      setNearMissAnalyticsData(await api.nearMissAnalytics().catch(() => null));
      await refreshJournal();
    } catch (err) {
      setError(err.message);
    }
  };
  const refreshLive = async ({ silent = false } = {}) => {
    try {
      if (!silent) setError('');
      const [account, positionRows, orderRows, signalRows, monitorRows, monitorState, marketClock, cryptoDash, analytics] = await Promise.all([
        api.account(),
        api.positions(),
        api.orders(),
        api.signals(),
        api.monitoredPositions(),
        api.monitorStatus(),
        api.marketClock(),
        api.cryptoDashboard().catch(() => null),
        api.nearMissAnalytics().catch(() => null)
      ]);
      setAccountData(account);
      setPositions(positionRows);
      setOrders(orderRows);
      setSignals(signalRows);
      setMonitoredPositions(monitorRows);
      setMonitor(monitorState);
      setClock(marketClock);
      if (cryptoDash) setCryptoDashboard(cryptoDash);
      if (analytics) setNearMissAnalyticsData(analytics);
      setLastLiveUpdate(new Date());
      refreshJournal().catch(() => {});
    } catch (err) {
      if (!silent) setError(err.message);
    }
  };
  const refreshWatchlist = async () => {
    const rows = await api.contextWatchlist();
    setWatchlist(rows);
    await refresh();
  };
  const runScanner = async (preset = '') => {
    try {
      setError('');
      const result = await api.runScanner(preset);
      setScanner(result);
      setUniverse(result.passed || []);
      setScannerSettingsData(await api.scannerSettings());
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };
  const runCryptoScanner = async (preset = '') => {
    try {
      setError('');
      const result = await api.runCryptoScanner(preset);
      setCryptoScanner(result);
      setNearMissAnalyticsData(result.nearMissHistory || await api.nearMissAnalytics());
      setCryptoScannerSettings(await api.cryptoScannerSettings());
      setCryptoStrategySettings(await api.cryptoStrategySettings());
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };
  const saveScannerSettings = async (payload) => {
    try {
      setError('');
      const result = await api.saveScannerSettings(payload);
      setScannerSettingsData(result);
    } catch (err) {
      setError(err.message);
    }
  };
  const saveCryptoStrategySettings = async (payload) => {
    try {
      setError('');
      const result = await api.saveCryptoStrategySettings(payload);
      setCryptoStrategySettings(result);
    } catch (err) {
      setError(err.message);
    }
  };
  const debugCryptoSignal = (runId, symbol) => api.debugCryptoSignal({ runId, symbol });
  const simulateCryptoSignalModes = (runId) => api.simulateCryptoSignalModes({ runId });
  const relaxScannerSettings = async () => {
    try {
      setError('');
      const result = await api.relaxScannerSettings();
      setScannerSettingsData(result);
    } catch (err) {
      setError(err.message);
    }
  };
  const unblock = async (symbol) => {
    await api.unblockSymbol(symbol);
    await refresh();
  };
  const block = async (symbol) => {
    await api.blockSymbol(symbol);
    await refresh();
  };
  const closePosition = async (row) => {
    const symbol = row.symbol;
    setCloseStatuses((current) => ({ ...current, [symbol]: 'manual_close_requested' }));
    try {
      const result = await api.closePosition(symbol);
      setCloseStatuses((current) => ({ ...current, [symbol]: result.status || 'close_order_submitted' }));
      setToast({ tone: 'good', message: `${symbol} close order submitted.` });
      await refreshLive();
      return result;
    } catch (err) {
      setCloseStatuses((current) => ({ ...current, [symbol]: 'close_failed' }));
      setToast({ tone: 'bad', message: `${symbol} close failed: ${err.message}` });
      await refreshLive({ silent: true });
      throw err;
    }
  };

  useEffect(() => { refresh(); refreshWatchlist(); }, []);
  useEffect(() => {
    let inFlight = false;
    const intervalMs = Number(import.meta.env.VITE_LIVE_REFRESH_MS || 5000);
    const tick = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        await refreshLive({ silent: true });
      } finally {
        inFlight = false;
      }
    };
    const interval = window.setInterval(tick, Math.max(2000, intervalMs));
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === 'event') {
          setEvents((current) => [event.payload, ...current].slice(0, 100));
          const symbol = event.payload?.payload?.symbol;
          if (symbol && ['manual_close_requested', 'open_order_cancellation_started', 'open_orders_cancelled', 'submitting_close_order', 'close_order_submitted', 'close_order_filled', 'close_order_failed', 'position_closed'].includes(event.payload?.event)) {
            const mapped = event.payload.event === 'position_closed' || event.payload.event === 'close_order_filled'
              ? 'close_order_filled'
              : event.payload.event === 'close_order_failed'
                ? 'close_failed'
              : event.payload.event;
            setCloseStatuses((current) => ({ ...current, [symbol]: mapped }));
            if (mapped === 'close_order_submitted') setToast({ tone: 'good', message: `${symbol} close order submitted.` });
            if (mapped === 'close_order_filled') setToast({ tone: 'good', message: `${symbol} position closed.` });
            if (mapped === 'close_failed') setToast({ tone: 'bad', message: `${symbol} close order failed.` });
          }
        }
        if (event.type === 'position_close_status') {
          setCloseStatuses((current) => ({ ...current, [event.payload.symbol]: event.payload.status }));
        }
        if (event.type === 'scanner_run') {
          if (event.payload?.marketType === 'crypto') {
            setCryptoScanner(event.payload);
            if (event.payload.nearMissHistory) setNearMissAnalyticsData(event.payload.nearMissHistory);
          } else {
            setScanner(event.payload);
          }
        }
        if (['scanner_run', 'order_submitted', 'monitor_update', 'kill_switch', 'position_close_status', 'signal_expired', 'signal_status'].includes(event.type)) refreshLive({ silent: true });
      } catch {
        refresh();
      }
    };
    return () => {
      setWsConnected(false);
      ws.close();
    };
  }, []);

  return (
    <main className="min-h-screen bg-ink">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-normal text-white">SignalFlow</h1>
            <p className="text-sm text-slate-400">Crypto-first, market-agnostic trading with manual approval defaults.</p>
          </div>
          <nav className="flex flex-wrap gap-2">
            {tabs.map((item) => (
              <button key={item} onClick={() => setTab(item)} className={`rounded px-3 py-2 text-sm font-semibold ${tab === item ? 'bg-gain text-ink' : 'bg-panel2 text-slate-300 hover:bg-line'}`}>{item}</button>
            ))}
          </nav>
        </div>
      </header>
  <MissionHeader accountData={accountData} clock={clock} monitor={monitor} connected={wsConnected} scanner={scanner} lastLiveUpdate={lastLiveUpdate} />

      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-5 xl:grid-cols-[1fr_340px]">
        <div>
        {error && <div className="mb-4 rounded border border-loss bg-loss/10 p-3 text-sm text-rose-200">{error}</div>}
        {tab === 'Dashboard' && <CryptoDashboard data={cryptoDashboard} monitor={monitor} />}
        {tab === 'Crypto Scanner' && <CryptoScanner scanner={cryptoScanner} settingsData={cryptoScannerSettings} strategyData={cryptoStrategySettings} analytics={nearMissAnalyticsData} runScanner={runCryptoScanner} saveStrategySettings={saveCryptoStrategySettings} debugSignal={debugCryptoSignal} simulateModes={simulateCryptoSignalModes} />}
        {tab === 'Signals' && <Signals signals={signals} refresh={refresh} scan={refreshWatchlist} accountData={accountData} />}
        {tab === 'Positions' && <CryptoPositions positions={positions.filter((row) => row.market_type === 'crypto' || String(row.symbol || '').includes('-USD'))} monitorRows={monitoredPositions} refresh={refresh} />}
        {tab === 'Journal' && <Journal journal={journal} summary={performanceSummary} daily={performanceDaily} strategy={performanceStrategy} symbols={performanceSymbols} outcomes={signalOutcomes} refreshJournal={refreshJournal} />}
        {tab === 'Settings' && <div className="grid gap-4"><LiveReadinessChecklist accountData={accountData} monitor={monitor} /><StrategySettings accountData={accountData} refresh={refresh} /></div>}
        {tab === 'Stocks Module' && <div className="grid gap-4"><Dashboard accountData={accountData} positions={positions} performance={performance} refresh={refresh} monitor={monitor} closeStatuses={closeStatuses} onClosePosition={closePosition} /><Watchlist rows={watchlist} universe={universe} scanner={scanner} scannerSettingsData={scannerSettingsData} blocked={blocked} refresh={refreshWatchlist} runScanner={runScanner} saveScannerSettings={saveScannerSettings} relaxScannerSettings={relaxScannerSettings} block={block} unblock={unblock} /><Trades orders={orders} performance={performance} /></div>}
        </div>
        <ActivityFeed events={events} />
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
