from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="SignalFlow Quant Service")


class Bar(BaseModel):
    timestamp: Optional[str] = None
    open: float
    high: float
    low: float
    close: float
    volume: float


class AnalyzeRequest(BaseModel):
    symbol: str
    bars: List[Bar] = Field(min_length=5)
    stop_loss_percent: float = 1.0
    take_profit_percent: float = 2.0


def ema(previous: Optional[float], price: float, span: int) -> float:
    if previous is None:
        return price
    multiplier = 2 / (span + 1)
    return (price - previous) * multiplier + previous


def enrich(bars: List[Bar]) -> List[dict]:
    rows = []
    ema9 = None
    ema20 = None
    cumulative_volume_price = 0.0
    cumulative_volume = 0.0

    for index, bar in enumerate(bars):
        typical = (bar.high + bar.low + bar.close) / 3
        cumulative_volume_price += typical * bar.volume
        cumulative_volume += bar.volume
        ema9 = ema(ema9, bar.close, 9)
        ema20 = ema(ema20, bar.close, 20)
        prior = bars[max(0, index - 5):index]
        volume_window = bars[max(0, index - 19):index + 1]
        rows.append({
            **bar.model_dump(),
            "ema9": ema9,
            "ema20": ema20,
            "vwap": cumulative_volume_price / cumulative_volume if cumulative_volume else bar.close,
            "volume_avg": sum(item.volume for item in volume_window) / len(volume_window),
            "recent_high": max((item.high for item in prior), default=None),
        })

    return rows


def build_signal(symbol: str, rows: List[dict], stop_loss_percent: float, take_profit_percent: float):
    latest = rows[-1]
    previous = rows[-2] if len(rows) > 1 else latest
    price = float(latest["close"])
    stop_loss = round(price * (1 - stop_loss_percent / 100), 2)
    take_profit = round(price * (1 + take_profit_percent / 100), 2)

    buy_checks = [
        price > float(latest["vwap"]),
        float(latest["ema9"]) > float(latest["ema20"]),
        price > float(latest["recent_high"]) if latest["recent_high"] is not None else False,
        float(latest["volume"]) > float(latest["volume_avg"]) if latest["volume_avg"] else False,
    ]
    sell_checks = [
        price < float(latest["vwap"]),
        float(previous["ema9"]) >= float(previous["ema20"]) and float(latest["ema9"]) < float(latest["ema20"]),
    ]

    if all(buy_checks):
        return {
            "symbol": symbol,
            "direction": "BUY",
            "entry_price": round(price, 2),
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "confidence": round(0.55 + 0.1 * sum(buy_checks), 2),
            "reason": "Price above VWAP, EMA9 above EMA20, five-minute high break, and volume expansion.",
        }

    if any(sell_checks):
        return {
            "symbol": symbol,
            "direction": "SELL",
            "entry_price": round(price, 2),
            "stop_loss": round(price * (1 + stop_loss_percent / 100), 2),
            "take_profit": round(price * (1 - take_profit_percent / 100), 2),
            "confidence": round(0.5 + 0.15 * sum(sell_checks), 2),
            "reason": "Exit signal from VWAP loss or bearish EMA cross.",
        }

    return {
        "symbol": symbol,
        "direction": "NONE",
        "entry_price": round(price, 2),
        "stop_loss": stop_loss,
        "take_profit": take_profit,
        "confidence": 0,
        "reason": "No complete EMA + VWAP momentum setup.",
    }


@app.post("/analyze")
def analyze(request: AnalyzeRequest):
    rows = enrich(request.bars)
    latest = rows[-1]
    first = rows[0]
    signal = build_signal(request.symbol, rows, request.stop_loss_percent, request.take_profit_percent)
    return {
        "symbol": request.symbol,
        "market": {
            "price": round(float(latest["close"]), 2),
            "change_percent": round(((float(latest["close"]) - float(first["open"])) / float(first["open"])) * 100, 2),
            "volume": float(latest["volume"]),
            "vwap": round(float(latest["vwap"]), 2),
        },
        "indicators": {
            "ema9": round(float(latest["ema9"]), 2),
            "ema20": round(float(latest["ema20"]), 2),
            "vwap": round(float(latest["vwap"]), 2),
            "volume_avg": round(float(latest["volume_avg"]), 2) if latest["volume_avg"] else 0,
        },
        "signal": signal,
    }


@app.post("/signal")
def signal(request: AnalyzeRequest):
    rows = enrich(request.bars)
    return build_signal(request.symbol, rows, request.stop_loss_percent, request.take_profit_percent)


@app.post("/backtest-basic")
def backtest_basic(request: AnalyzeRequest):
    rows = enrich(request.bars)
    trades = []
    for index in range(21, len(rows)):
        sub = rows[: index + 1]
        sig = build_signal(request.symbol, sub, request.stop_loss_percent, request.take_profit_percent)
        if sig["direction"] == "BUY":
            trades.append(sig)
    return {
        "symbol": request.symbol,
        "signals": len(trades),
        "note": "Basic signal count only; not a profit forecast.",
        "sample": trades[-5:],
    }


@app.get("/health")
def health():
    return {"ok": True}
