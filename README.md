# SignalFlow

SignalFlow is a crypto-first, market-agnostic trading dashboard. Coinbase Advanced Trade is the primary V1 exchange for spot crypto, while the original Alpaca stock implementation remains available under the Stocks Module. It defaults to `SAFE_MANUAL_APPROVAL` and will not place autonomous trades unless the relevant auto-execution environment flags are explicitly configured.

## Stack

- Frontend: React, Vite, Tailwind, Lightweight Charts
- Backend: Node.js, Express, MongoDB, WebSockets, Coinbase Advanced Trade API, Alpaca Trading API
- Quant service: Python FastAPI

## Safety Defaults

- `AUTO_EXECUTION=false` and `CRYPTO_AUTO_EXECUTION=false` by default.
- Every order must pass backend risk checks.
- Crypto orders are spot-only and use risk/notional caps.
- Per-trade risk is capped by `MAX_TRADE_RISK`.
- Trading stops when daily realized plus unrealized loss reaches `MAX_DAILY_LOSS`.
- Only one open position is allowed by default.
- Duplicate pending/open orders on a ticker are rejected.
- Approved trades require stop loss and take profit.
- No futures, leverage, margin, shorting, martingale, or averaging down are implemented.
- The emergency kill switch disables trading immediately.
- All signals, approvals, rejections, orders, fills, risk blocks, and errors are logged.

## Setup

1. Copy `.env.example` to `.env`. For crypto-first mode, Coinbase credentials are optional for scanner testing but required for live balances/orders.

```env
PRIMARY_MARKET=crypto
ACTIVE_EXCHANGE=coinbase
COINBASE_API_KEY_NAME=
COINBASE_API_PRIVATE_KEY=
CRYPTO_TRADING_ENABLED=true
CRYPTO_AUTO_EXECUTION=false
AUTO_EXECUTION=false
```

Coinbase secrets are never displayed in the UI or logs. Missing credentials show as `missing_credentials`; public Coinbase market data can still power scanner testing.

Coinbase private keys must be readable by Node as PEM. In `.env`, the safest format is one quoted line with literal `\n` separators:

```env
COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\nYOUR_KEY_BODY\n-----END EC PRIVATE KEY-----"
```

If the app shows `credential_error`, the key was found but could not be decoded. Re-copy the full Coinbase private key, keep the begin/end lines, and avoid pasting raw multiline PEM unless your dotenv file preserves quoted multiline values correctly.
2. Install Node dependencies:

```bash
npm install
npm run install:all
```

On Windows PowerShell, if `npm.ps1` is blocked by execution policy, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run install:all
```

3. Install Python dependencies:

```bash
cd quant-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

On Windows PowerShell, if `Activate.ps1` is blocked, run the venv Python directly instead:

```powershell
cd quant-service
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

Or activate from Command Prompt:

```cmd
cd quant-service
.venv\Scripts\activate.bat
pip install -r requirements.txt
cd ..
```

4. Start all services:

```bash
npm run dev
```

PowerShell-safe equivalent:

```powershell
npm.cmd run dev
```

Frontend: `http://localhost:5173`
Backend: `http://localhost:4000`
Quant service: `http://localhost:8000`

To run the quant service by itself:

```bash
python -m uvicorn main:app --app-dir quant-service --reload --host 0.0.0.0 --port 8000
```

## Render Deployment With MongoDB Atlas

SignalFlow uses MongoDB as its backend datastore. You do not need a Render persistent disk or Render Postgres.

Create a MongoDB Atlas cluster, copy its connection string, and set these backend environment variables on Render:

```env
MONGODB_URI=mongodb+srv://USER:PASSWORD@HOST/?retryWrites=true&w=majority
MONGODB_DATABASE=signalflow
```

Backend Render service:

```text
Root Directory: backend
Build Command: npm ci
Start Command: npm start
```

Also set `NODE_VERSION=22.13.0` or newer.

Quant service Render service:

```text
Root Directory: quant-service
Build Command: pip install -r requirements.txt
Start Command: python -m uvicorn main:app --host 0.0.0.0 --port $PORT
```

After the quant service deploys, set the backend's `QUANT_SERVICE_URL` to the quant service URL. Set the frontend's `VITE_API_URL` and `VITE_WS_URL` to the backend URL.

## Manual Approval Flow

1. The backend loads the active market adapter. Default is `crypto/coinbase`.
2. Coinbase public market data powers the crypto scanner when credentials are missing.
3. Coinbase authenticated endpoints are used for balances, orders, cancellations, and closes when credentials are configured.
4. The original Alpaca stock flow remains available under Stocks Module.
5. Eligible crypto BUY signals are stored as `pending`.
5. The Signals page lets you approve or reject each signal.
6. Approval calls `/api/signals/:id/approve`.
7. The backend rechecks risk controls immediately before submission.
8. If approved, SignalFlow uses the crypto risk cap to calculate fractional spot size and submits a simple Coinbase spot order.
9. The order and event are logged.

Crypto BUY entries use SignalFlow Monitor protection by default: SignalFlow stores stop/target locally and submits a market sell if stop or target is reached. This means the backend must stay online for monitored exits.

`BUY` signals create protected entry orders. `SELL` signals are exit-only in V1 and require an existing long position; SignalFlow will not open shorts.

Alpaca currently rejects fractional bracket orders. SignalFlow therefore blocks BUY approvals when the position-size cap would buy less than one whole share, because submitting an unprotected fractional simple order would violate the V1 safety rules. For a tiny account, use lower-priced tickers or raise `MAX_POSITION_NOTIONAL`/`position_size_cap` enough for at least one whole share of the selected ticker.

## Watchlists And Scanner

SignalFlow separates context from trade candidates. Crypto is primary; stocks are secondary.

Crypto default universe:

```text
BTC-USD, ETH-USD, SOL-USD, LINK-USD, AVAX-USD, ADA-USD, DOGE-USD, XRP-USD, LTC-USD, BCH-USD
```

Crypto focus symbols: `BTC-USD`, `ETH-USD`, `SOL-USD`.

Run the crypto scanner from the Crypto Scanner page or call:

```bash
POST /api/crypto/scanner/run?preset=crypto_micro_account
```

Crypto regimes:

- `BULLISH`: BTC and ETH are above VWAP and EMA 9 is above EMA 20.
- `BEARISH`: BTC and ETH are below VWAP and EMA 9 is below EMA 20.
- `NEUTRAL`: anything else.

Long crypto signals are allowed only in `BULLISH` or `NEUTRAL` unless `ALLOW_COUNTER_REGIME_TRADES=true`.

Stocks module:

- Market Context: `SPY`, `QQQ`, `IWM`, `DIA`, `NVDA`, `AMD`, `AAPL`, `MSFT`
- Trading Universe seed: `SOFI`, `PLTR`, `RIVN`, `LCID`, `F`, `PFE`, `NIO`, `HOOD`, `SNAP`, `INTC`, `AMD`, `TSLA`, `AAPL`, `MSFT`, `NVDA`, `MARA`, `RIOT`, `BAC`, `T`, `WBD`

Run the scanner from the Watchlist page with `Run Scanner`, or call:

```bash
POST /api/scanner/run
```

Market Context symbols are displayed and used for confirmation. They do not produce trade signals unless `ENABLE_CONTEXT_SYMBOL_TRADING=true`.

Market regime:

- `BULLISH`: SPY or QQQ is above VWAP and EMA 9 is above EMA 20.
- `BEARISH`: SPY or QQQ is below VWAP and EMA 9 is below EMA 20.
- `NEUTRAL`: anything else.

Strategy V1 scans Trading Universe symbols only. Long signals require `BULLISH` or `NEUTRAL` regime, active/tradable symbols, scanner filters, price above VWAP, EMA 9 above EMA 20, recent 5-minute high break, volume expansion, and acceptable spread.

## Position Sizing

SignalFlow now sizes by account equity:

```text
risk_amount = account_equity * (RISK_PER_TRADE_PERCENT / 100)
stop_distance = abs(entry_price - stop_loss)
ideal_quantity = risk_amount / stop_distance
max_notional = account_equity * (MAX_ACCOUNT_POSITION_PERCENT / 100)
final_notional = min(ideal_quantity * entry_price, max_notional)
```

If `final_notional < MIN_NOTIONAL_ORDER`, the trade is blocked. If the calculated quantity is fractional, SignalFlow blocks native bracket entry and reports that monitored fractional-exit mode is required.

## Phase 2: Mission Control And Monitored Exits

SignalFlow now includes a live mission-control layer:

- Global status header with Alpaca connection, market data feed, market clock, regime, trading mode, protection mode, scanner state, and WebSocket state.
- Persistent Live Activity feed backed by `system_events`.
- Live account, position, order, and monitored-exit updates in the frontend without a page refresh.
- Scanner progress/candidate pass/reject events.
- Monitor status and monitored position views.
- Market clock endpoint.

Protection modes:

- `native_bracket`: whole-share Alpaca bracket order only.
- `monitored_fractional`: simple fractional Alpaca entry plus SignalFlow-managed stop/target monitor.
- `auto`: native bracket for whole-share entries, monitored fractional exits for fractional entries when enabled.

Monitored fractional exits are controlled by:

```env
PROTECTION_MODE=auto
MONITORED_EXIT_INTERVAL_MS=5000
MONITORED_EXIT_MAX_STALE_SECONDS=20
ALLOW_MONITORED_FRACTIONAL_EXITS=true
VITE_LIVE_REFRESH_MS=5000
```

When monitored mode is used, SignalFlow stores the position, stop loss, and take profit in MongoDB and checks prices on an interval. If price reaches stop or target, it submits a market sell exit. If market data becomes stale beyond the configured threshold, the position is marked `stale`, new entries are blocked, and manual attention is required.

`VITE_LIVE_REFRESH_MS` controls how often the frontend refreshes account/position/order snapshots. The default is 5 seconds.

New endpoints:

```text
GET /api/events
GET /api/market-clock
GET /api/monitor/status
GET /api/monitored-positions
GET /api/monitored-positions/:id
POST /api/monitored-positions/:id/exit
POST /api/monitored-positions/:id/mark-reviewed
```

WebSocket broadcasts now include:

- `event`
- `scanner_run`
- `order_submitted`
- `monitor_update`
- `kill_switch`

## Switching To Auto Execution

Autonomous order placement is intentionally locked down.

1. Set `AUTO_EXECUTION=true` in `.env`.
2. Restart the backend.
3. In Strategy Settings, enable Auto Execution and confirm the warning.
4. Keep small caps such as `MAX_POSITION_NOTIONAL=5` and `MAX_OPEN_POSITIONS=1`.

Auto execution still uses the same risk engine and kill switch. A failed stop loss or take profit attachment rejects the trade.

## Alpaca Notes

Use paper trading first by setting:

```env
ALPACA_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_FEED=iex
TRADING_MODE=paper
```

For live trading:

```env
ALPACA_BASE_URL=https://api.alpaca.markets
ALPACA_DATA_FEED=iex
TRADING_MODE=live
```

Do not include `/v2` in `ALPACA_BASE_URL`. SignalFlow normalizes it if present, but the intended values are the host roots above.
Use `ALPACA_DATA_FEED=iex` unless your Alpaca account has SIP market-data access.

This software does not promise profits, does not use leverage, does not trade options or crypto in V1, does not average down, and does not use martingale sizing.
